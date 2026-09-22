import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COLOR, parse_color, style_status } from "../src/color.ts";
import { parse_config } from "../src/config.ts";
import {
  counted_tokens, debit, effective_balance, matching_buckets, meter_text,
} from "../src/quota.ts";
import { BUCKET } from "./fixture.ts";

test("continuous refill and capacity clamp, including backwards clock", () => {
  const state = { balance: 100, updatedAt: 10_000, configId: "test" };
  assert.equal(effective_balance(state, BUCKET, 10_500), 2600);
  assert.equal(effective_balance(state, BUCKET, 200_000), 600_000);
  assert.equal(effective_balance(state, BUCKET, 9_000), 100);
});

test("debits refill first and clamp at zero; meter stays compact", () => {
  const start = { balance: 20, updatedAt: 0, configId: "test" };
  const next = debit(start, BUCKET, 100, 100, "hosted-provider", "hosted-1");
  assert.equal(next.balance, 420);
  const empty = debit(next, BUCKET, 999_999, 100, "hosted-provider", "hosted-1");
  assert.equal(empty.balance, 0);
  assert.equal(meter_text(BUCKET, 420_000), "██████░░ 420k/600k");
  assert.equal(meter_text({ ...BUCKET, capacity: 6_000_000 }, 4_600_000),
    "██████░░ 4600k/6000k");
});

test("full slugs match exact providers and model globs, not local models", () => {
  const config = { buckets: { main: BUCKET } };
  assert.deepEqual(matching_buckets(config, "hosted-provider", "hosted-4"), ["main"]);
  assert.deepEqual(matching_buckets(config, "hosted-provider", "gemma"), []);
  assert.deepEqual(matching_buckets(config, "openrouter", "hosted-4"), []);
  assert.deepEqual(matching_buckets(config, "local", "gpt-oss-120b"), []);
  const nested = parse_config({ buckets: { main: {
    capacity: 100, refillPerMinute: 1, models: ["openrouter/openai/gpt-*"],
  } } });
  assert.deepEqual(matching_buckets(nested, "openrouter", "openai/gpt-5"), ["main"]);
  assert.deepEqual(matching_buckets(nested, "openrouter", "other/gpt-5"), []);
});

test("reported cache categories are distinct; reasoning and total are not added twice", () => {
  const usage = {
    input: 100, output: 80, cacheRead: 300, cacheWrite: 50, cacheWrite1h: 20,
    reasoning: 30, totalTokens: 530,
  };
  assert.equal(counted_tokens(usage, BUCKET.count), 530);
  assert.equal(counted_tokens(usage, { ...BUCKET.count, reasoning: true }), 530);
  assert.equal(counted_tokens(usage, { ...BUCKET.count, output: false, reasoning: true }), 480);
  assert.equal(counted_tokens(usage, { ...BUCKET.count, cacheRead: false }), 230);
  // Some adapters report the same cached input in both input and cache counters.
  assert.equal(counted_tokens({ ...usage, input: 450 }, BUCKET.count, "inclusive"), 530);
  assert.equal(counted_tokens({ ...usage, input: 450 },
    { ...BUCKET.count, cacheRead: false }, "inclusive"), 230);
});

test("configuration is explicit and rejects invalid values", () => {
  const parsed = parse_config({ buckets: { main: {
    capacity: 600_000, refillPerMinute: 300_000,
    models: ["hosted-provider/hosted-*"],
  } } });
  assert.equal(parsed.buckets.main?.count.cacheRead, true);
  assert.equal(parsed.buckets.main?.inputCacheSemantics, "separate");
  assert.equal(parsed.buckets.main?.barWidth, 12);
  assert.equal(parsed.color, DEFAULT_COLOR);
  assert.equal(parsed.refreshIntervalSeconds, 5);
  assert.equal(meter_text(parsed.buckets.main!, 420_000), "████████░░░░ 420k/600k");
  assert.equal(parse_config({ buckets: { main: {
    capacity: 600_000, refillPerMinute: 1,
    models: ["hosted-provider/*"], inputCacheSemantics: "inclusive",
  } } }).buckets.main?.inputCacheSemantics, "inclusive");
  assert.throws(() => parse_config({ buckets: { main: {
    capacity: 0, refillPerMinute: 1, models: ["hosted-provider/*"],
  } } }), /capacity/);
  for (const slug of ["hosted-*", "/hosted-1", "hosted-provider/", "*/hosted-1"]) {
    assert.throws(() => parse_config({ buckets: { main: {
      capacity: 100, refillPerMinute: 1, models: [slug],
    } } }), /provider\/model slug/);
  }
  assert.throws(() => parse_config({ buckets: { main: {
    capacity: 100, refillPerMinute: 1,
    providers: ["hosted-provider"], models: ["hosted-provider/hosted-1"],
  } } }), /providers is no longer supported/);
  const settings = { buckets: { main: {
    capacity: 100, refillPerMinute: 1, models: ["hosted-provider/model"],
  } } };
  assert.equal(parse_config({ ...settings, refreshIntervalSeconds: 1 }).refreshIntervalSeconds, 1);
  assert.throws(() => parse_config({ ...settings, refreshIntervalSeconds: 0 }),
    /refreshIntervalSeconds/);
  assert.throws(() => parse_config({ ...settings, refreshIntervalSeconds: 1.5 }),
    /refreshIntervalSeconds/);
  assert.throws(() => parse_config({ ...settings, color: "greenish" }), /color/);
});

test("status color supports a pale green-gray default, Pi theme roles, and plain text", () => {
  const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
  assert.equal(style_status("Q: test", DEFAULT_COLOR, theme),
    "\x1b[38;2;183;202;189mQ: test\x1b[39m");
  assert.equal(style_status("Q: test", parse_color("success"), theme),
    "<success>Q: test</success>");
  assert.equal(style_status("Q: test", parse_color("none"), theme), "Q: test");
  assert.equal(style_status("Q: test", parse_color("#123aBc"), theme),
    "\x1b[38;2;18;58;188mQ: test\x1b[39m");
  assert.throws(() => parse_color("#bad"), /color/);
});
