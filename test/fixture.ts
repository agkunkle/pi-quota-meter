import type { BucketConfig } from "../src/quota.ts";

export const BUCKET: BucketConfig = {
  capacity: 600_000,
  refillPerMinute: 300_000,
  models: ["hosted-provider/hosted-*"],
  count: { input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: false },
  inputCacheSemantics: "separate",
  barWidth: 8,
};
