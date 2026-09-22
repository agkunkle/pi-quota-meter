import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensure_config, load_config } from "../src/config.ts";
import { matching_buckets } from "../src/quota.ts";

async function with_directory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-quota-bootstrap-"));
  try { await run(join(directory, "account-quota")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("first start creates a valid placeholder config and never overwrites an existing file", async () => {
  await with_directory(async (directory) => {
    await ensure_config(directory);
    const filename = join(directory, "config.json");
    const original = await readFile(filename, "utf8");
    const config = await load_config(directory);
    assert.equal(config.color, "#b7cabd");
    assert.equal(config.refreshIntervalSeconds, 5);
    assert.equal(config.buckets.example?.capacity, 600_000);
    assert.equal(config.buckets.example?.refillPerMinute, 300_000);
    assert.deepEqual(config.buckets.example?.models, ["REPLACE_PROVIDER/REPLACE_MODEL"]);
    assert.deepEqual(matching_buckets(config, "openai-codex", "gpt-6-sol"), []);
    assert.equal(config.buckets.example?.barWidth, 12);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
    }
    await ensure_config(directory);
    assert.equal(await readFile(filename, "utf8"), original);
    await writeFile(filename, "{invalid json", "utf8");
    await ensure_config(directory);
    assert.equal(await readFile(filename, "utf8"), "{invalid json");
  });
});

test("simultaneous Pi processes publish one complete starter config", async () => {
  await with_directory(async (directory) => {
    const module_path = resolve("src/config.ts");
    const code = `import { ensure_config } from ${JSON.stringify(`file://${module_path}`)};
      await ensure_config(${JSON.stringify(directory)});`;
    const processes = Array.from({ length: 6 }, () => new Promise<void>((ok, fail) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module",
        "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
      child.on("error", fail);
      child.on("close", (exit_code) => exit_code === 0 ? ok() : fail(new Error(error)));
    }));
    await Promise.all(processes);
    assert.deepEqual(await readdir(directory), ["config.json"]);
    assert.equal((await load_config(directory)).buckets.example?.capacity, 600_000);
  });
});

test("session_start initializes the config without requiring a UI or provider call", async () => {
  await with_directory(async (directory) => {
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = resolve(directory, "..");
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    try {
      const { default: extension } = await import("../src/index.ts");
      extension({
        on: (name: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
          handlers.set(name, handler);
        },
        registerCommand: () => {},
      } as unknown as ExtensionAPI);
      const ctx = { hasUI: false };
      await handlers.get("session_start")!({}, ctx);
      assert.equal((await load_config(directory)).buckets.example?.models[0],
        "REPLACE_PROVIDER/REPLACE_MODEL");
      await handlers.get("session_shutdown")!({}, ctx);
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });
});
