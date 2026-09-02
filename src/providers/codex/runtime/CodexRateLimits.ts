/** Wire-compatible, deliberately small subset of Codex account rate-limit payloads. */
export interface CodexRateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  [key: string]: unknown;
}

export interface CodexRateLimitsPayload {
  rateLimits?: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | null> | null;
}

export interface CodexRateLimitDisplayWindow {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: number | null;
}

export interface CodexRateLimitsState {
  status: 'ready' | 'unavailable';
  windows: CodexRateLimitDisplayWindow[];
  /** Retained so sparse `account/rateLimits/updated` notifications can be merged. */
  snapshot?: CodexRateLimitSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asWindow(value: unknown): CodexRateLimitWindow | null {
  return isRecord(value) ? value : null;
}

function asSnapshot(value: unknown): CodexRateLimitSnapshot | null {
  return isRecord(value) ? value : null;
}

function pickSnapshot(payload: unknown): CodexRateLimitSnapshot | null {
  if (!isRecord(payload)) return null;
  const byLimitId = isRecord(payload.rateLimitsByLimitId)
    ? asSnapshot(payload.rateLimitsByLimitId.codex)
    : null;
  return byLimitId ?? asSnapshot(payload.rateLimits) ?? asSnapshot(payload);
}

function normalizePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatWindowLabel(duration: unknown): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
  if (duration === 300) return '5小时';
  if (duration === 10080) return '本周';
  if (duration >= 43200 && duration <= 44640) return '本月';
  return `${Math.round(duration)}分钟`;
}

function normalizeWindow(window: CodexRateLimitWindow | null): CodexRateLimitDisplayWindow | null {
  if (!window) return null;
  const usedPercent = normalizePercent(window.usedPercent);
  const label = formatWindowLabel(window.windowDurationMins);
  if (usedPercent === null || !label) return null;
  const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
    ? window.resetsAt
    : null;
  return {
    label,
    remainingPercent: 100 - usedPercent,
    usedPercent,
    resetsAt,
  };
}

export function normalizeCodexRateLimits(payload: unknown): CodexRateLimitsState {
  const snapshot = pickSnapshot(payload);
  if (!snapshot) return { status: 'unavailable', windows: [] };

  const windows = [normalizeWindow(asWindow(snapshot.primary)), normalizeWindow(asWindow(snapshot.secondary))]
    .filter((window): window is CodexRateLimitDisplayWindow => window !== null);
  if (windows.length === 0) return { status: 'unavailable', windows: [] };
  return { status: 'ready', windows, snapshot };
}

function snapshotHasWindowData(snapshot: CodexRateLimitSnapshot): boolean {
  return asWindow(snapshot.primary) !== null || asWindow(snapshot.secondary) !== null;
}

/**
 * Merge an `account/rateLimits/updated` notification into the current state.
 *
 * Notifications carry the latest full snapshot as seen by the live execution
 * session. When they include window data they are authoritative and replace
 * the previous state outright. Credits/plan-only events (e.g. SSE events
 * without rate-limit detail) carry `primary: null` and must NOT wipe the last
 * known windows — that only produced "unavailable" flicker mid-turn.
 */
export function mergeCodexRateLimitPayload(
  previous: CodexRateLimitsState | null,
  payload: unknown,
): CodexRateLimitsState {
  const update = pickSnapshot(payload);
  if (!update) return previous ?? { status: 'unavailable', windows: [] };
  if (!snapshotHasWindowData(update)) {
    return previous ?? { status: 'unavailable', windows: [] };
  }
  return normalizeCodexRateLimits({ rateLimits: update });
}

export function getCodexRateLimitSeverity(remainingPercent: number): 'normal' | 'warning' | 'critical' {
  if (remainingPercent <= 5) return 'critical';
  if (remainingPercent <= 20) return 'warning';
  return 'normal';
}
