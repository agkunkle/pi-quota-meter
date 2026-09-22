import { randomUUID } from "node:crypto";
import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { config_id } from "./config.ts";
import {
  debit, effective_balance, type BucketConfig, type BucketState,
} from "./quota.ts";

interface StateFile {
  version: 1;
  buckets: Record<string, BucketState>;
}

export interface Snapshot {
  state: StateFile;
  recovered: boolean;
}

function empty_state(): StateFile {
  return { version: 1, buckets: {} };
}

function valid_bucket(value: unknown): value is BucketState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as BucketState;
  return Number.isFinite(state.balance) && state.balance >= 0
    && Number.isFinite(state.updatedAt) && state.updatedAt >= 0
    && typeof state.configId === "string";
}

export async function read_state(directory: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(join(directory, "state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: empty_state(), recovered: false };
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid state");
    const file = parsed as StateFile;
    if (file.version !== 1 || typeof file.buckets !== "object"
      || file.buckets === null || Array.isArray(file.buckets)) throw new Error("Invalid state");
    const buckets: Record<string, BucketState> = {};
    let recovered = false;
    for (const [name, value] of Object.entries(file.buckets)) {
      if (valid_bucket(value)) buckets[name] = value;
      else recovered = true;
    }
    return { state: { version: 1, buckets }, recovered };
  } catch {
    return { state: empty_state(), recovered: true };
  }
}

export function bucket_state(
  state: StateFile, name: string, bucket: BucketConfig, now: number,
): BucketState {
  const existing = state.buckets[name];
  if (existing?.configId === config_id(bucket)) return existing;
  return { balance: bucket.capacity, updatedAt: now, configId: config_id(bucket) };
}

export function balance_from_snapshot(
  snapshot: Snapshot, name: string, bucket: BucketConfig, now: number,
): number | undefined {
  if (snapshot.recovered) return undefined;
  return effective_balance(bucket_state(snapshot.state, name, bucket, now), bucket, now);
}

async function persist(
  directory: string, state: StateFile, assert_locked: () => void,
): Promise<void> {
  const target = join(directory, "state.json");
  const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    assert_locked();
    await rename(temporary, target);
    // Best effort: fsync the directory so the rename survives power loss on POSIX.
    try {
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* Directory fsync is unsupported on some platforms. */ }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function debit_shared(
  directory: string, name: string, bucket: BucketConfig, tokens: number,
  provider: string, model: string, now: () => number = Date.now,
): Promise<{ state: BucketState; recovered: boolean }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // proper-lockfile uses atomic mkdir and an mtime heartbeat. Unlike an ad-hoc
  // lock file it recovers from crashed writers and retries across OS processes.
  let compromised = false;
  const release = await lockfile.lock(directory, {
    onCompromised: () => { compromised = true; },
    realpath: false,
    lockfilePath: join(directory, "state.lock"),
    stale: 30_000,
    update: 10_000,
    retries: { retries: 12, factor: 1.3, minTimeout: 25, maxTimeout: 250 },
  });
  try {
    const snapshot = await read_state(directory);
    if (compromised) throw new Error("Quota state lock was compromised");
    const at = now();
    const previous = bucket_state(snapshot.state, name, bucket, at);
    const next = debit(previous, bucket, tokens, at, provider, model);
    snapshot.state.buckets[name] = next;
    await persist(directory, snapshot.state, () => {
      if (compromised) throw new Error("Quota state lock was compromised");
    });
    return { state: next, recovered: snapshot.recovered };
  } finally {
    await release();
  }
}
