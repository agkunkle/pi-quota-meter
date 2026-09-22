import type { StatusColor } from "./color.ts";

export interface CountOptions {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  reasoning: boolean;
}

export interface BucketConfig {
  capacity: number;
  refillPerMinute: number;
  models: string[];
  count: CountOptions;
  inputCacheSemantics: "separate" | "inclusive";
  barWidth: number;
}

export interface QuotaConfig {
  buckets: Record<string, BucketConfig>;
  color?: StatusColor;
  refreshIntervalSeconds?: number;
}

export interface ReportedUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
}

export interface BucketState {
  balance: number;
  updatedAt: number;
  configId: string;
  lastDebit?: { tokens: number; at: number; provider: string; model: string };
}

export const DEFAULT_COUNT: CountOptions = {
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
  reasoning: false,
};

function positive_usage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Pi's output already includes reasoning, and cacheWrite includes cacheWrite1h.
// Pi's totalTokens is derived from these categories; summing it again double-counts.
export function counted_tokens(
  usage: ReportedUsage, count: CountOptions,
  input_cache_semantics: "separate" | "inclusive" = "separate",
): number {
  const output = positive_usage(usage.output);
  const reasoning = positive_usage(usage.reasoning);
  const input = input_cache_semantics === "inclusive"
    ? Math.max(0, positive_usage(usage.input) - positive_usage(usage.cacheRead)
      - positive_usage(usage.cacheWrite)) : positive_usage(usage.input);
  return (count.input ? input : 0)
    + (count.output ? output : count.reasoning ? Math.min(reasoning, output) : 0)
    + (count.cacheRead ? positive_usage(usage.cacheRead) : 0)
    + (count.cacheWrite ? positive_usage(usage.cacheWrite) : 0);
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(value);
}

export function matching_buckets(
  config: QuotaConfig, provider: string, model: string,
): string[] {
  const slug = `${provider}/${model}`;
  return Object.entries(config.buckets)
    .filter(([, bucket]) => bucket.models.some((pattern) => matches(pattern, slug)))
    .map(([name]) => name);
}

export function effective_balance(state: BucketState, bucket: BucketConfig, now: number): number {
  const elapsed = Math.max(0, now - state.updatedAt);
  return Math.min(bucket.capacity, Math.max(0, state.balance)
    + elapsed * bucket.refillPerMinute / 60_000);
}

export function debit(
  state: BucketState, bucket: BucketConfig, tokens: number, now: number,
  provider: string, model: string,
): BucketState {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid token count");
  return {
    ...state,
    balance: Math.max(0, effective_balance(state, bucket, now) - tokens),
    updatedAt: now,
    lastDebit: { tokens, at: now, provider, model },
  };
}

function compact_number(value: number): string {
  return value >= 1000 ? `${Math.floor(value / 1000)}k` : `${Math.floor(value)}`;
}

export function meter_text(bucket: BucketConfig, balance: number): string {
  const filled = Math.max(0, Math.min(bucket.barWidth,
    Math.round(bucket.barWidth * balance / bucket.capacity)));
  return `${"█".repeat(filled)}${"░".repeat(bucket.barWidth - filled)}`
    + ` ${compact_number(balance)}/${compact_number(bucket.capacity)}`;
}
