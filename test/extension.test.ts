import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Harness {
  handlers: Map<string, (event: any, ctx: any) => Promise<void> | void>;
  statuses: Array<string | undefined>;
  ctx: {
    hasUI: boolean;
    ui: {
      setStatus: (key: string, text: string | undefined) => void;
      notify: (text: string, level: string) => void;
    };
  };
  pi: ExtensionAPI;
}

function harness(): Harness {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const statuses: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, "account-quota");
        statuses.push(text);
      },
      notify: (_text: string, _level: string) => {},
    },
  };
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { handlers, statuses, ctx, pi };
}

test("status updates across sessions without owning the footer; shutdown clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-quota-ext-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  const data = join(directory, "account-quota");
  await mkdir(data);
  await writeFile(join(data, "config.json"), JSON.stringify({
    refreshIntervalSeconds: 1,
    buckets: { main: {
      capacity: 600_000, refillPerMinute: 0,
      models: ["hosted-provider/hosted-*"], barWidth: 4,
    } },
  }));
  process.env.PI_CODING_AGENT_DIR = directory;
  const { default: extension } = await import("../src/index.ts");
  const first = harness();
  const second = harness();
  extension(first.pi);
  extension(second.pi);
  try {
    await first.handlers.get("session_start")!({}, first.ctx);
    await second.handlers.get("session_start")!({}, second.ctx);
    assert.equal(first.statuses.at(-1), "\x1b[38;2;183;202;189mQ: ████ 600k/600k\x1b[39m");
    await first.handlers.get("message_end")!({ message: {
      role: "assistant", provider: "hosted-provider", model: "hosted-1",
      usage: { input: 100, output: 10, cacheRead: 500, cacheWrite: 0 },
    } }, first.ctx);
    const updated_status = "\x1b[38;2;183;202;189mQ: ████ 599k/600k\x1b[39m";
    const deadline = Date.now() + 3000;
    while (second.statuses.at(-1) !== updated_status && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(second.statuses.at(-1), updated_status);
    const persisted = JSON.parse(await readFile(join(data, "state.json"), "utf8"));
    assert.equal(persisted.buckets.main.balance, 599_390);
  } finally {
    await first.handlers.get("session_shutdown")!({}, first.ctx);
    await second.handlers.get("session_shutdown")!({}, second.ctx);
    assert.equal(first.statuses.at(-1), undefined);
    assert.equal(second.statuses.at(-1), undefined);
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
