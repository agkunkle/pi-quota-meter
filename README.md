# pi-quota-meter

A standalone Pi extension for **telemetry only**: shared account-level token buckets and a live
`account-quota` extension status. It never modifies model requests, throttles, reserves tokens,
compacts, or switches models. All Pi processes using the same Pi agent directory and config share
one state file; usage from other programs is not observed.

## Install and configure

Requirements: Node 24+ (Pi's current runtime). Install from GitHub:

```bash
pi install git:github.com/agkunkle/pi-quota-meter
```

Or for a local checkout, run `npm install` then `pi install /path/to/pi-quota-meter`.
Installing globally (not project-locally) makes it available to every Pi session. On the **first
Pi session start after install** (or `/reload`), the extension creates
`~/.pi/agent/account-quota/config.json` if missing, along with its directory. This is a Pi
session-start action, not an npm postinstall script, so installing the package alone may not
create the file until Pi starts. It never overwrites an existing config, even if that config is
invalid. The file location follows `PI_CODING_AGENT_DIR` if set.

The generated config is valid but intentionally **unconfigured**: its model slug is a placeholder,
so no normal provider response will debit the example bucket. Replace the placeholder with the
precise `provider/model` ID shown by Pi's `/model` or model registry, and set your own capacity,
refill rate, and input/cache semantics. The example meter is illustrative, not a live account
balance or a provider quota claim. Run
`/reload` in open Pi sessions after editing. The starter config is equivalent to:

```json
{
  "color": "#b7cabd",
  "refreshIntervalSeconds": 5,
  "buckets": {
    "example": {
      "capacity": 600000,
      "refillPerMinute": 300000,
      "models": ["REPLACE_PROVIDER/REPLACE_MODEL"],
      "inputCacheSemantics": "separate",
      "barWidth": 12,
      "count": {
        "input": true,
        "output": true,
        "cacheRead": true,
        "cacheWrite": true,
        "reasoning": false
      }
    }
  }
}
```

Each `models` entry is a `provider/model` slug. The provider matches exactly; the model may
contain `/` and supports `*` globs (for example `hosted-provider/model-*`). Old `providers`
arrays are rejected so an outdated config cannot silently debit the wrong model. Leave local
models out of these allowlists; an absent config is generated at session start. Multiple named buckets can
be configured, but overlapping mappings for the same provider/model are rejected at debit time
(warning, no debit) rather than double-debited.
All sessions sharing a bucket should use identical config; reload them together after changes.

`/quota` displays precise calculated balances, capacity, refill, counted categories, mappings,
last persisted timestamp and most recent debit. A single bucket publishes:
`Q: ████████░░░░ 421k/600k`. With multiple buckets, each segment includes its bucket name.
Large values stay in `k` (for example, `4600k/6000k`), never `m`. The refill rate remains
available via `/quota`, not in the footer. If the active footer does not render extension
statuses, `/quota` still works; see the integration note below.

`color` is a top-level setting for the entire status. The default is pale green-gray
`#b7cabd` (24-bit RGB); alternatively use `"success"`, `"accent"`, `"muted"`, `"dim"`,
`"text"`, `"warning"`, `"error"` to follow the active Pi theme, or `"none"` for plain text.
The status carries its own ANSI foreground color, which `pi-footer` preserves unless you set
a widget color override. `barWidth` sets the number of filled/empty square characters and
defaults to 12. `refreshIntervalSeconds` defaults to 5 (allowed: 1–3600); another session's
debit appears by the next scheduled refresh, while the debiting session refreshes immediately.
If you add a dedicated `Pi Extension Status` widget targeting `account-quota`, hide that key in
`pi-footer`'s generic row to avoid displaying it twice.

## Accounting and failure semantics

`message_end` processes final assistant messages using their reported `provider`, `model`, and
`usage`. Pi's `input`, `output`, `cacheRead`, and `cacheWrite` are included only when selected.
`totalTokens` is **not** added to the sum. Pi reports reasoning as a component of output, so
`reasoning: true` only matters when `output: false`; in that case only the reasoning subset of
output is included. `cacheWrite1h` is already part of `cacheWrite` and is not added again.
Cache reads are enabled by default; zero or missing usage is ignored. Set
`inputCacheSemantics` to `"separate"` (default; Pi's Anthropic/OpenAI adapters normalize input
apart from cache tokens) or `"inclusive"` (subtract cache-read and cache-write from input before
applying `count`, for adapters whose input already includes those tokens). Check your adapter's
usage mapping before choosing: some adapters expose overlapping input/cache counters, and
blindly summing all four fields would double-count. This option changes only future debits.
Nested model calls made by extensions and non-assistant usage entries (e.g. cache warming or
compaction) are **not** covered by this V1 hook and can make the meter optimistic. Aborted/error
messages are debited only when they carry nonzero reported usage.

The state lives at `~/.pi/agent/account-quota/state.json`. A `proper-lockfile` atomic-directory
lock at `state.lock` with a heartbeat serializes writers across Node processes on Linux,
macOS, and Windows. A writer locks, reads, applies elapsed-time refill, subtracts usage, clamps
at zero, writes a temporary file, syncs it, atomically renames it over state.json, and unlocks.
Readers never lock: the atomic rename exposes a complete snapshot. They calculate refill in
memory on each refresh and never write for the display. Lock acquisition is bounded; errors produce
warnings/unavailable status, never block a provider request intentionally.

`state.json` and `state.lock` are created lazily on the first debit, not at installation.
Missing state initializes at full capacity. Corrupt state is shown as unavailable until the next
successful debit; under lock that debit resets the invalid state at full capacity and records
its usage. This recovery loses prior unknown usage; inspect `/quota` after warnings. Changing
capacity or refill changes the bucket's config ID and resets it at full capacity on next debit;
changing model slug mappings does not reset the balance. A debit larger than the current
balance is clamped to zero: V1 does not track token debt or in-flight reservations. Backward
clock jumps cause no negative refill.

**Important:** The requested continuous token bucket is a visualization/estimate, not an
assertion about any provider's actual limits. A provider can enforce a strict sliding-window TPM,
per-model limits, concurrency limits, or additional account usage; even a perfect Pi counter may
therefore disagree with a server-side rate-limit response. You supply the bucket capacity and
refill rate; this extension never throttles.

## Footer coexistence (no patch applied)

`pi-quota-meter` never calls `setFooter`: it only calls `ctx.ui.setStatus("account-quota", text)`.
Pi's built-in footer renders statuses; custom footers must read
`footerData.getExtensionStatuses()`. In the inspected installation, `cc-my-pi`'s statusline is
disabled and the installed `pi-footer` footer already renders generic extension statuses in its
extension-status row, so **no footer patch is needed**. If you later enable `cc-my-pi`'s footer,
it currently whitelists specific status keys; a generic fallback for unhandled keys would be the
minimal upstream enhancement. Do not enable both custom footers simultaneously: they compete
for Pi's single `setFooter` slot. No footer package was modified.

## Development

```bash
npm run typecheck
npm test
```

The test suite covers refill/clamping, accounting without double counting, slug filtering,
first-start config creation, missing/corrupt state recovery, cross-process simultaneous debits,
and status lifecycle.
