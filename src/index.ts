import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COLOR, style_status } from "./color.ts";
import { load_config } from "./config.ts";
import { counted_tokens, matching_buckets, meter_text, type QuotaConfig } from "./quota.ts";
import { balance_from_snapshot, debit_shared, read_state } from "./state.ts";

const STATUS_KEY = "account-quota";
const DIRECTORY = join(getAgentDir(), "account-quota");

function error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function quota_meter(pi: ExtensionAPI): void {
  let config: QuotaConfig = { buckets: {} };
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let refreshing = false;
  let warned = false;

  function warn(ctx: ExtensionContext, error: unknown): void {
    if (warned || !ctx.hasUI) return;
    warned = true;
    ctx.ui.notify(`Quota telemetry unavailable: ${error_text(error)}`, "warning");
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!active || refreshing || !ctx.hasUI) return;
    refreshing = true;
    try {
      const snapshot = await read_state(DIRECTORY);
      if (!active) return;
      const now = Date.now();
      const buckets = Object.entries(config.buckets);
      const labels = buckets.map(([name, bucket]) => {
        const balance = balance_from_snapshot(snapshot, name, bucket, now);
        const label = balance === undefined ? "unavailable" : meter_text(bucket, balance);
        return buckets.length > 1 ? `${name} ${label}` : label;
      });
      const text = labels.length ? `Q: ${labels.join(" | ")}` : undefined;
      ctx.ui.setStatus(STATUS_KEY, text
        ? style_status(text, config.color ?? DEFAULT_COLOR, ctx.ui.theme) : undefined);
      if (snapshot.recovered) warn(ctx, "corrupt state; next debit resets affected state");
    } catch (error) {
      if (active) {
        ctx.ui.setStatus(STATUS_KEY, "Quota unavailable");
        warn(ctx, error);
      }
    } finally {
      refreshing = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    active = false;
    warned = false;
    try {
      config = await load_config(DIRECTORY);
      active = true;
      if (ctx.hasUI) {
        await refresh(ctx);
        // A rejected UI refresh must not become an unhandled timer rejection in Pi.
        timer = setInterval(() => { void refresh(ctx).catch(() => {}); },
          (config.refreshIntervalSeconds ?? 5) * 1000);
        timer.unref?.();
      }
    } catch (error) {
      config = { buckets: {} };
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, "Quota config error");
        warn(ctx, error);
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    try {
      const { provider, model, usage } = event.message;
      const buckets = matching_buckets(config, provider, model);
      if (buckets.length === 0) return;
      // Ambiguous mappings are configuration errors: never debit twice for one response.
      if (buckets.length > 1) {
        warn(ctx, `ambiguous provider/model mapping: ${provider}/${model}`);
        return;
      }
      const name = buckets[0]!;
      const bucket = config.buckets[name]!;
      const tokens = counted_tokens(usage, bucket.count, bucket.inputCacheSemantics);
      if (tokens === 0) return;
      const result = await debit_shared(DIRECTORY, name, bucket, tokens, provider, model);
      if (result.recovered) warn(ctx, "corrupt state recovered at full capacity");
      await refresh(ctx);
    } catch (error) {
      warn(ctx, error);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "Quota unavailable");
    }
  });

  pi.registerCommand("quota", {
    description: "Show account token bucket telemetry and model mappings",
    handler: async (_args, ctx) => {
      try {
        const snapshot = await read_state(DIRECTORY);
        const now = Date.now();
        const lines = Object.entries(config.buckets).map(([name, bucket]) => {
          const balance = balance_from_snapshot(snapshot, name, bucket, now);
          const last = snapshot.state.buckets[name]?.lastDebit;
          return [
            `${name}: ${balance === undefined ? "unavailable" : balance.toFixed(2)}`
              + ` / ${bucket.capacity} tokens; +${bucket.refillPerMinute}/min`,
            `  models: ${bucket.models.join(", ")}`,
            `  counts: ${Object.entries(bucket.count).filter(([, on]) => on)
              .map(([key]) => key).join(", ")}`,
            `  input/cache relationship: ${bucket.inputCacheSemantics}`,
            `  persisted: ${snapshot.state.buckets[name]
              ? new Date(snapshot.state.buckets[name]!.updatedAt).toISOString() : "not yet"}`,
            `  last debit: ${last ? `${last.tokens} tokens at ${new Date(last.at).toISOString()}`
              + ` (${last.provider}/${last.model})` : "none"}`,
          ].join("\n");
        });
        ctx.ui.notify(lines.length ? lines.join("\n") :
          `No quota buckets configured; add ${join(DIRECTORY, "config.json")}`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Quota diagnostics unavailable: ${error_text(error)}`, "warning");
      }
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
