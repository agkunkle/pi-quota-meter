import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COLOR, parse_color } from "./color.ts";
import {
  DEFAULT_COUNT, type BucketConfig, type CountOptions, type QuotaConfig,
} from "./quota.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.length || !value.every(
    (item) => typeof item === "string" && item.length > 0,
  )) throw new Error(`${key} must be a nonempty string array`);
  return value;
}

function parse_bucket(value: unknown, name: string): BucketConfig {
  if (!record(value)) throw new Error(`${name} must be an object`);
  const {
    capacity, refillPerMinute, models, barWidth, count, inputCacheSemantics,
  } = value;
  if ("providers" in value) {
    throw new Error(`${name}.providers is no longer supported; use provider/model slugs in models`);
  }
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error(`${name}.capacity must be a positive safe integer`);
  }
  if (typeof refillPerMinute !== "number" || !Number.isFinite(refillPerMinute)
    || refillPerMinute < 0) throw new Error(`${name}.refillPerMinute must be nonnegative`);
  if (barWidth !== undefined && (!Number.isInteger(barWidth)
    || (barWidth as number) < 1 || (barWidth as number) > 20)) {
    throw new Error(`${name}.barWidth must be between 1 and 20`);
  }
  if (count !== undefined && !record(count)) throw new Error(`${name}.count must be an object`);
  if (inputCacheSemantics !== undefined && inputCacheSemantics !== "separate"
    && inputCacheSemantics !== "inclusive") {
    throw new Error(`${name}.inputCacheSemantics must be separate or inclusive`);
  }
  const parsed_count = { ...DEFAULT_COUNT };
  for (const key of Object.keys(DEFAULT_COUNT) as (keyof CountOptions)[]) {
    const setting = (count as Record<string, unknown> | undefined)?.[key];
    if (setting !== undefined && typeof setting !== "boolean") {
      throw new Error(`${name}.count.${key} must be boolean`);
    }
    if (setting !== undefined) parsed_count[key] = setting as boolean;
  }
  const model_slugs = strings(models, `${name}.models`);
  for (const slug of model_slugs) {
    const separator = slug.indexOf("/");
    if (separator <= 0 || separator === slug.length - 1
      || slug.slice(0, separator).includes("*")) {
      throw new Error(`${name}.models: expected provider/model slug (model may contain *)`);
    }
  }
  return {
    capacity,
    refillPerMinute,
    models: model_slugs,
    count: parsed_count,
    inputCacheSemantics: (inputCacheSemantics as "separate" | "inclusive" | undefined)
      ?? "separate",
    barWidth: (barWidth as number | undefined) ?? 12,
  };
}

export function parse_config(value: unknown): QuotaConfig {
  if (!record(value) || !record(value.buckets)) throw new Error("Expected buckets object");
  const refresh_interval = value.refreshIntervalSeconds ?? 5;
  if (!Number.isInteger(refresh_interval) || (refresh_interval as number) < 1
    || (refresh_interval as number) > 3600) {
    throw new Error("refreshIntervalSeconds must be an integer from 1 to 3600");
  }
  const buckets: Record<string, BucketConfig> = {};
  for (const [name, bucket] of Object.entries(value.buckets)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid bucket name: ${name}`);
    buckets[name] = parse_bucket(bucket, name);
  }
  return {
    buckets,
    color: value.color === undefined ? DEFAULT_COLOR : parse_color(value.color),
    refreshIntervalSeconds: refresh_interval as number,
  };
}

const STARTER_CONFIG = {
  color: DEFAULT_COLOR,
  refreshIntervalSeconds: 5,
  buckets: {
    example: {
      capacity: 600_000,
      refillPerMinute: 300_000,
      models: ["REPLACE_PROVIDER/REPLACE_MODEL"],
      inputCacheSemantics: "separate",
      barWidth: 12,
      count: DEFAULT_COUNT,
    },
  },
};

/** Create the starter config once, without replacing an existing config across Pi processes. */
export async function ensure_config(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "config.json");
  try {
    await access(target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    // A hard link publishes the fully written file atomically and fails if another
    // session (or the user) created config.json first. Rename would overwrite it.
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function load_config(directory: string): Promise<QuotaConfig> {
  try {
    return parse_config(JSON.parse(await readFile(join(directory, "config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { buckets: {}, color: DEFAULT_COLOR, refreshIntervalSeconds: 5 };
    }
    throw error;
  }
}

// Changing bucket size/refill invalidates the old balance, but changing model mappings does not.
export function config_id(bucket: BucketConfig): string {
  return createHash("sha256").update(JSON.stringify([
    bucket.capacity, bucket.refillPerMinute,
  ])).digest("hex").slice(0, 16);
}
