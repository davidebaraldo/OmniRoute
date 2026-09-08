/**
 * claudeLowPriority.ts — Claude OAuth "lower-priority lane" after the 5-hour usage wall.
 *
 * OmniRoute counterpart of Claude Code's `/low-priority` command (wire contract captured
 * from Claude Code 2.1.263). A Claude subscription account that hits its 5-hour usage
 * limit gets a 429 carrying `anthropic-ratelimit-unified-slow-offer: treatment`. Accepting
 * the offer means re-sending the request — and every following request until the window
 * resets — with `anthropic-usage-limit: slow`. Anthropic then serves the account at lower
 * priority instead of rejecting it, so the connection keeps working past the wall (the
 * weekly limit still applies).
 *
 * Wire contract (headers are lowercase on the wire; values verbatim):
 *   Request   `anthropic-usage-limit: slow`
 *   Wall 429  `anthropic-ratelimit-unified-slow-offer: treatment|control`
 *             `anthropic-ratelimit-unified-reset: <epoch seconds>` (5h window reset)
 *             `anthropic-ratelimit-unified-slow-retry-after` / `…-slow-max-wait` (seconds)
 *   Any resp  `anthropic-ratelimit-unified-slow-status: active|not_needed|slot_busy|
 *              weekly_limit|budget_exhausted|ineligible|off`
 *             `anthropic-ratelimit-unified-slow-budget-utilization` (0..1)
 *             `anthropic-ratelimit-unified-slow-budget-reset` / `…-7d-reset` (epoch seconds)
 *             `anthropic-ratelimit-unified-5h-reset` (epoch seconds — window rollover)
 *             `anthropic-ratelimit-unified-overage-in-use: true|false`
 *
 * Lifecycle (per connection, in-memory):
 *   idle ──429 + offer=treatment + lowPriorityMode──▶ active(until unified-reset + 60s)
 *   active: 2xx keeps it active (`not_needed` = served at standard priority, still active);
 *           429 `slot_busy` / 529 → wait `retry-after` (jittered ±30%) and retry the same
 *           account, up to `max-wait`, then end + 10-minute cool-off;
 *           `weekly_limit` / `budget_exhausted` / `off` / `ineligible` → end, the 429 flows
 *           to the normal cooldown path; 5h window rollover → end.
 *
 * State is deliberately not persisted: after a restart the next wall 429 re-activates the
 * lane at the cost of one extra round trip. The executor never surfaces the intercepted 429
 * to chatCore, so an account riding the slow lane is NOT put in connection cooldown.
 *
 * Pure module (no fetch, no timers) — the executor owns the sleep; the session-limit reset
 * claim (`claudeLimitReset.ts`) is injected as a callback so this file stays unit-testable.
 */

type JsonRecord = Record<string, unknown>;

export const CLAUDE_USAGE_LIMIT_HEADER = "anthropic-usage-limit";
export const CLAUDE_USAGE_LIMIT_SLOW = "slow";

export const CLAUDE_UNIFIED_HEADERS = Object.freeze({
  status: "anthropic-ratelimit-unified-status",
  reset: "anthropic-ratelimit-unified-reset",
  reset5h: "anthropic-ratelimit-unified-5h-reset",
  reset7d: "anthropic-ratelimit-unified-7d-reset",
  representativeClaim: "anthropic-ratelimit-unified-representative-claim",
  overageStatus: "anthropic-ratelimit-unified-overage-status",
  overageInUse: "anthropic-ratelimit-unified-overage-in-use",
  slowOffer: "anthropic-ratelimit-unified-slow-offer",
  slowStatus: "anthropic-ratelimit-unified-slow-status",
  slowRetryAfter: "anthropic-ratelimit-unified-slow-retry-after",
  slowMaxWait: "anthropic-ratelimit-unified-slow-max-wait",
  slowBudgetUtilization: "anthropic-ratelimit-unified-slow-budget-utilization",
  slowBudgetReset: "anthropic-ratelimit-unified-slow-budget-reset",
});

/** Defaults + clamps mirror Claude Code 2.1.263 exactly. */
export const CLAUDE_LOW_PRIORITY_DEFAULTS = Object.freeze({
  retryAfterMs: 20_000,
  retryAfterMinMs: 5_000,
  retryAfterMaxMs: 600_000,
  maxWaitMs: 1_200_000,
  maxWaitMinMs: 60_000,
  maxWaitMaxMs: 21_600_000,
  /** ±30% jitter on every wait so parallel requests do not stampede the slot. */
  jitter: 0.3,
  /** Active lane survives the announced reset by this much before lazy expiry. */
  resetGraceMs: 60_000,
  /** A 5h-reset header this far past the accepted reset means the window rolled over. */
  rolloverToleranceSeconds: 60,
  /** After giving up on `max-wait`, do not auto-accept a new offer for this long. */
  cooloffMs: 10 * 60_000,
  /** `budget_exhausted` remembers "spent" until the announced reset, capped at 8 days. */
  budgetSpentCapSeconds: 8 * 86_400,
});

export type ClaudeSlowOffer = "treatment" | "control";
export type ClaudeSlowStatus =
  | "active"
  | "not_needed"
  | "slot_busy"
  | "weekly_limit"
  | "budget_exhausted"
  | "ineligible"
  | "off"
  | "unrecognized";

export type ClaudeLowPriorityEndReason =
  | "reset"
  | "weekly"
  | "budget"
  | "off"
  | "ineligible"
  | "wall"
  | "max_wait"
  | "extra_usage"
  | "operator";

export type ClaudeUsageLimitConfig = {
  /** Opt-in: accept the slow-lane offer on the 5h wall (`anthropic-usage-limit: slow`). */
  lowPriorityMode: boolean;
  /** Opt-in: claim the once-a-week session-limit reset on the 5h wall (`/limit-reset`). */
  autoLimitReset: boolean;
};

export type ClaudeLowPriorityWait = {
  current: { sinceMs: number; attempts: number; nextTryAtMs: number } | null;
};

export type ClaudeUsageLimitDecision =
  | { kind: "none" }
  | {
      kind: "retry";
      delayMs: number;
      via: "limit-reset" | "low-priority-accepted" | "slot-busy" | "capacity-busy";
    }
  | { kind: "ended"; reason: ClaudeLowPriorityEndReason };

export type ClaudeLowPrioritySnapshot = {
  active: boolean;
  resetsAtSeconds: number | null;
  acceptedAtMs: number | null;
  retryAfterMs: number;
  maxWaitMs: number;
  requestsServed: number;
  requestsServedStandard: number;
  budgetUtilization: number | null;
  budgetSpentUntilSeconds: number | null;
  coolingOffUntilMs: number | null;
};

type Phase = { phase: "idle" } | { phase: "active"; resetsAtSeconds: number; acceptedAtMs: number };

type Entry = {
  state: Phase;
  retryAfterMs: number;
  maxWaitMs: number;
  requestsServed: number;
  requestsServedStandard: number;
  budgetUtilization?: number;
  budgetSpentUntilSeconds?: number;
  coolingOffUntilMs?: number;
};

type HeaderSource = Headers | Record<string, string | undefined> | null | undefined;

const entries = new Map<string, Entry>();
const D = CLAUDE_LOW_PRIORITY_DEFAULTS;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Read the two per-connection opt-ins from `providerSpecificData` (both default off). */
export function readClaudeUsageLimitConfig(providerSpecificData: unknown): ClaudeUsageLimitConfig {
  const psd = asRecord(providerSpecificData);
  return {
    lowPriorityMode: psd.lowPriorityMode === true,
    autoLimitReset: psd.autoLimitReset === true,
  };
}

/** Stable per-connection state key: connection id, else the token itself (same seed rule as identity). */
export function resolveClaudeUsageLimitKey(credentials: {
  connectionId?: string | null;
  accessToken?: string | null;
}): string {
  return credentials.connectionId || credentials.accessToken || "anon";
}

export function getClaudeHeader(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v === null ? undefined : v;
  }
  const record = headers as Record<string, string | undefined>;
  const direct = record[name];
  if (typeof direct === "string") return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower && typeof record[key] === "string") return record[key];
  }
  return undefined;
}

export function parseClaudeSlowOffer(headers: HeaderSource): ClaudeSlowOffer | undefined {
  const v = getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.slowOffer);
  return v === "treatment" || v === "control" ? v : undefined;
}

export function parseClaudeSlowStatus(headers: HeaderSource): ClaudeSlowStatus | undefined {
  const v = getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.slowStatus);
  if (v === undefined) return undefined;
  switch (v) {
    case "active":
    case "not_needed":
    case "slot_busy":
    case "weekly_limit":
    case "budget_exhausted":
    case "ineligible":
    case "off":
      return v;
    default:
      return "unrecognized";
  }
}

/** Non-negative finite number header (seconds / ratios); undefined when absent or malformed. */
export function parseClaudeHeaderNumber(headers: HeaderSource, name: string): number | undefined {
  const raw = getClaudeHeader(headers, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * True when a 429 is the account's unified usage wall (5h/7d subscription window), as
 * opposed to a per-minute burst limit: `anthropic-ratelimit-unified-status: rejected`.
 */
export function isClaudeUsageWall(headers: HeaderSource): boolean {
  return getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.status) === "rejected";
}

/** The window the wall 429 blames (`five_hour`, `seven_day`, …), when announced. */
export function parseClaudeRepresentativeClaim(headers: HeaderSource): string | undefined {
  return getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.representativeClaim) || undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function freshEntry(): Entry {
  return {
    state: { phase: "idle" },
    retryAfterMs: D.retryAfterMs,
    maxWaitMs: D.maxWaitMs,
    requestsServed: 0,
    requestsServedStandard: 0,
  };
}

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = freshEntry();
    entries.set(key, e);
  }
  return e;
}

function expireIfPastReset(key: string, e: Entry, now: number): void {
  if (e.state.phase !== "active") return;
  if (now >= e.state.resetsAtSeconds * 1000 + D.resetGraceMs) endEntry(key, e, "reset", now);
}

function endEntry(key: string, e: Entry, reason: ClaudeLowPriorityEndReason, now: number): void {
  if (e.state.phase !== "active") return;
  if (reason === "max_wait") e.coolingOffUntilMs = now + D.cooloffMs;
  e.state = { phase: "idle" };
  e.requestsServed = 0;
  e.requestsServedStandard = 0;
  entries.set(key, e);
}

function applyWaitHints(e: Entry, headers: HeaderSource): void {
  const retry = parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.slowRetryAfter);
  if (retry !== undefined)
    e.retryAfterMs = clamp(retry * 1000, D.retryAfterMinMs, D.retryAfterMaxMs);
  const maxWait = parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.slowMaxWait);
  if (maxWait !== undefined) e.maxWaitMs = clamp(maxWait * 1000, D.maxWaitMinMs, D.maxWaitMaxMs);
  const util = parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.slowBudgetUtilization);
  if (util !== undefined) e.budgetUtilization = Math.min(1, util);
}

function recordBudgetSpent(e: Entry, headers: HeaderSource, now: number): void {
  const reset =
    parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.slowBudgetReset) ??
    parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.reset7d);
  if (reset !== undefined && reset > 0) {
    e.budgetSpentUntilSeconds = Math.round(Math.min(reset, now / 1000 + D.budgetSpentCapSeconds));
  }
}

function isBudgetSpent(e: Entry, now: number): boolean {
  return e.budgetSpentUntilSeconds !== undefined && now < e.budgetSpentUntilSeconds * 1000;
}

function isCoolingOff(e: Entry, now: number): boolean {
  return e.coolingOffUntilMs !== undefined && now < e.coolingOffUntilMs;
}

export function isClaudeLowPriorityActive(key: string, now: number = Date.now()): boolean {
  const e = entries.get(key);
  if (!e) return false;
  expireIfPastReset(key, e, now);
  return e.state.phase === "active";
}

export function getClaudeLowPrioritySnapshot(
  key: string,
  now: number = Date.now()
): ClaudeLowPrioritySnapshot {
  const e = entries.get(key) ?? freshEntry();
  expireIfPastReset(key, e, now);
  return {
    active: e.state.phase === "active",
    resetsAtSeconds: e.state.phase === "active" ? e.state.resetsAtSeconds : null,
    acceptedAtMs: e.state.phase === "active" ? e.state.acceptedAtMs : null,
    retryAfterMs: e.retryAfterMs,
    maxWaitMs: e.maxWaitMs,
    requestsServed: e.requestsServed,
    requestsServedStandard: e.requestsServedStandard,
    budgetUtilization: e.budgetUtilization ?? null,
    budgetSpentUntilSeconds: e.budgetSpentUntilSeconds ?? null,
    coolingOffUntilMs: e.coolingOffUntilMs ?? null,
  };
}

export function endClaudeLowPriority(
  key: string,
  reason: ClaudeLowPriorityEndReason = "operator",
  now: number = Date.now()
): boolean {
  const e = entries.get(key);
  if (!e || e.state.phase !== "active") return false;
  endEntry(key, e, reason, now);
  return true;
}

/**
 * Accept the slow-lane offer carried by a wall 429. Returns true when the lane became
 * active (the caller must immediately retry the same account — the retry carries
 * `anthropic-usage-limit: slow`). Mirrors Claude Code's acceptance gate: offer must be
 * `treatment`, the announced reset must be in the future, and neither the weekly
 * slow-lane budget nor the post-`max_wait` cool-off may be in effect.
 */
export function tryActivateClaudeLowPriority(
  key: string,
  headers: HeaderSource,
  now: number = Date.now()
): boolean {
  const e = entryFor(key);
  expireIfPastReset(key, e, now);
  if (e.state.phase === "active") return false;
  if (parseClaudeSlowOffer(headers) !== "treatment") return false;
  if (isBudgetSpent(e, now) || isCoolingOff(e, now)) return false;
  const resetsAt =
    parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.reset) ??
    parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.reset5h);
  if (resetsAt === undefined || resetsAt * 1000 <= now) return false;
  e.retryAfterMs = D.retryAfterMs;
  e.maxWaitMs = D.maxWaitMs;
  applyWaitHints(e, headers);
  e.budgetUtilization = undefined;
  e.requestsServed = 0;
  e.requestsServedStandard = 0;
  e.state = { phase: "active", resetsAtSeconds: resetsAt, acceptedAtMs: now };
  return true;
}

function mapEndReason(
  status: ClaudeSlowStatus | undefined,
  headers: HeaderSource
): ClaudeLowPriorityEndReason | null {
  switch (status) {
    case "weekly_limit":
      return "weekly";
    case "budget_exhausted":
      return "budget";
    case "off":
      return "off";
    case "ineligible":
      return "ineligible";
    case "slot_busy":
      return null;
    default: {
      // A 429 with unified rate-limit headers but no slow verdict is a real wall
      // (e.g. the weekly window closed) — the lane cannot help any more.
      const unified =
        getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.representativeClaim) ||
        getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.overageStatus);
      return unified ? "wall" : null;
    }
  }
}

function waitOrGiveUp(
  key: string,
  e: Entry,
  wait: ClaudeLowPriorityWait,
  via: "slot-busy" | "capacity-busy",
  now: number,
  random: () => number
): ClaudeUsageLimitDecision {
  if (e.state.phase !== "active") return { kind: "none" };
  const acceptedAtMs = e.state.acceptedAtMs;
  const current =
    wait.current && wait.current.sinceMs >= acceptedAtMs
      ? wait.current
      : { sinceMs: now, attempts: 0, nextTryAtMs: now };
  if (now - current.sinceMs >= e.maxWaitMs) {
    wait.current = null;
    endEntry(key, e, "max_wait", now);
    return { kind: "ended", reason: "max_wait" };
  }
  const jitter = 1 + (random() * 2 - 1) * D.jitter;
  const delayMs = Math.max(0, Math.round(e.retryAfterMs * jitter));
  wait.current = {
    sinceMs: current.sinceMs,
    attempts: current.attempts + 1,
    nextTryAtMs: now + delayMs,
  };
  return { kind: "retry", delayMs, via };
}

/**
 * Observe an upstream response for an ACTIVE lane: keeps counters/hints fresh, ends the
 * lane on terminal verdicts, and asks for a same-account retry on `slot_busy` (429) or
 * capacity (529) while inside `max-wait`.
 */
export function observeClaudeLowPriorityResponse(
  key: string,
  response: { status: number; headers: HeaderSource },
  wait: ClaudeLowPriorityWait,
  now: number = Date.now(),
  random: () => number = Math.random
): ClaudeUsageLimitDecision {
  const e = entries.get(key);
  if (!e) return { kind: "none" };
  expireIfPastReset(key, e, now);
  if (e.state.phase !== "active") return { kind: "none" };

  const headers = response.headers;
  const slowStatus = parseClaudeSlowStatus(headers);
  applyWaitHints(e, headers);

  if (response.status === 429) {
    const reason = mapEndReason(slowStatus, headers);
    if (reason) {
      if (reason === "budget") recordBudgetSpent(e, headers, now);
      endEntry(key, e, reason, now);
      return { kind: "ended", reason };
    }
    if (slowStatus === "slot_busy") return waitOrGiveUp(key, e, wait, "slot-busy", now, random);
    return { kind: "none" };
  }

  if (response.status === 529 && (slowStatus === "active" || slowStatus === undefined)) {
    return waitOrGiveUp(key, e, wait, "capacity-busy", now, random);
  }

  // Window rollover announced by the server → the wall is gone, drop the header.
  const reset5h = parseClaudeHeaderNumber(headers, CLAUDE_UNIFIED_HEADERS.reset5h);
  if (reset5h !== undefined && reset5h >= e.state.resetsAtSeconds + D.rolloverToleranceSeconds) {
    endEntry(key, e, "reset", now);
    return { kind: "ended", reason: "reset" };
  }

  if (slowStatus === "active") {
    e.requestsServed += 1;
    wait.current = null;
  } else if (slowStatus === "not_needed") {
    e.requestsServedStandard += 1;
    wait.current = null;
  } else if (
    slowStatus === "ineligible" &&
    getClaudeHeader(headers, CLAUDE_UNIFIED_HEADERS.overageInUse) === "true"
  ) {
    endEntry(key, e, "extra_usage", now);
    return { kind: "ended", reason: "extra_usage" };
  }
  return { kind: "none" };
}

/**
 * One call per upstream response, from the Claude OAuth executor. Decides whether the
 * executor should retry the same account (`retry`) instead of surfacing the response.
 *
 * Idle + wall 429: try the once-a-week session-limit reset first (restores full speed),
 * then accept the slow-lane offer. Active: delegate to observeClaudeLowPriorityResponse.
 */
export async function handleClaudeUsageLimitResponse(opts: {
  key: string;
  config: ClaudeUsageLimitConfig;
  response: { status: number; headers: HeaderSource };
  wait: ClaudeLowPriorityWait;
  /** Attempts the `/limit-reset` claim; resolves true when the 5h window was reset. */
  claimLimitReset?: () => Promise<boolean>;
  now?: number;
  random?: () => number;
}): Promise<ClaudeUsageLimitDecision> {
  const now = opts.now ?? Date.now();
  const { key, config, response, wait } = opts;

  if (isClaudeLowPriorityActive(key, now)) {
    return observeClaudeLowPriorityResponse(key, response, wait, now, opts.random);
  }

  if (response.status !== 429) return { kind: "none" };
  if (!config.lowPriorityMode && !config.autoLimitReset) return { kind: "none" };

  const headers = response.headers;
  const offer = parseClaudeSlowOffer(headers);
  const atWall = isClaudeUsageWall(headers) || offer !== undefined;
  if (!atWall) return { kind: "none" };

  if (config.autoLimitReset && opts.claimLimitReset) {
    const claim = parseClaudeRepresentativeClaim(headers);
    if (claim === undefined || claim === "five_hour") {
      let reset = false;
      try {
        reset = await opts.claimLimitReset();
      } catch {
        reset = false;
      }
      if (reset) return { kind: "retry", delayMs: 0, via: "limit-reset" };
    }
  }

  if (config.lowPriorityMode && tryActivateClaudeLowPriority(key, headers, now)) {
    wait.current = null;
    return { kind: "retry", delayMs: 0, via: "low-priority-accepted" };
  }

  return { kind: "none" };
}

export function createClaudeLowPriorityWait(): ClaudeLowPriorityWait {
  return { current: null };
}

/** Test-only: drop every connection's lane state. */
export function _resetClaudeLowPriorityState(): void {
  entries.clear();
}
