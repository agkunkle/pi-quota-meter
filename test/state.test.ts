import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { config_id } from "../src/config.ts";
import { BUCKET } from "./fixture.ts";
import { balance_from_snapshot, debit_shared, read_state } from "../src/state.ts";

async function with_directory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-quota-meter-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("missing state starts full; read-only refresh does not create state", async () => {
  await with_directory(async (directory) => {
    const snapshot = await read_state(directory);
    assert.equal(balance_from_snapshot(snapshot, "main", BUCKET, 100), BUCKET.capacity);
    assert.rejects(readFile(join(directory, "state.json")), { code: "ENOENT" });
  });
});

test("persisted debit refills lazily and preserves the last debit", async () => {
  await with_directory(async (directory) => {
    await debit_shared(directory, "main", BUCKET, 500, "hosted-provider", "hosted-1", () => 100_000);
    const next = await debit_shared(directory, "main", BUCKET, 100, "hosted-provider", "hosted-1",
      () => 100_500);
    assert.equal(next.state.balance, 599_900);
    assert.equal(next.state.configId, config_id(BUCKET));
    assert.equal((await read_state(directory)).state.buckets.main?.lastDebit?.tokens, 100);
  });
});

test("separate buckets share state without overwriting each other", async () => {
  await with_directory(async (directory) => {
    await debit_shared(directory, "main", BUCKET, 100, "hosted-provider", "hosted-1", () => 1000);
    await debit_shared(directory, "future", { ...BUCKET, capacity: 1000 }, 20,
      "hosted-provider", "gpt-5.6", () => 1000);
    const snapshot = await read_state(directory);
    assert.equal(snapshot.state.buckets.main?.balance, 599_900);
    assert.equal(snapshot.state.buckets.future?.balance, 980);
  });
});

test("invalid state recovers under lock without crashing; config changes reset", async () => {
  await with_directory(async (directory) => {
    await writeFile(join(directory, "state.json"), "{broken", "utf8");
    assert.equal((await read_state(directory)).recovered, true);
    assert.equal(balance_from_snapshot(await read_state(directory), "main", BUCKET, 1), undefined);
    const result = await debit_shared(directory, "main", BUCKET, 10, "hosted-provider", "hosted-1",
      () => 100);
    assert.equal(result.recovered, true);
    assert.equal(result.state.balance, BUCKET.capacity - 10);
    assert.equal((await read_state(directory)).recovered, false);
    assert.equal(balance_from_snapshot(await read_state(directory), "main",
      { ...BUCKET, capacity: 700_000 }, 200), 700_000);
  });
});

test("simultaneous independent processes cannot lose a debit", async () => {
  await with_directory(async (directory) => {
    const fixed = { ...BUCKET, refillPerMinute: 0 };
    const module_path = resolve("src/state.ts");
    const code = `import { debit_shared } from ${JSON.stringify(`file://${module_path}`)};
      await debit_shared(${JSON.stringify(directory)}, "main", ${JSON.stringify(fixed)}, 100,
        "hosted-provider", "hosted-1");`;
    const processes = Array.from({ length: 8 }, () => new Promise<void>((ok, fail) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module",
        "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
      child.on("error", fail);
      child.on("close", (exit_code) => exit_code === 0 ? ok() : fail(new Error(error)));
    }));
    await Promise.all(processes);
    assert.equal((await read_state(directory)).state.buckets.main?.balance, 599_200);
  });
});
