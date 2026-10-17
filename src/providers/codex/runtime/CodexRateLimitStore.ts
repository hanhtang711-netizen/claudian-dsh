import {
  type CodexRateLimitsState,
  mergeCodexRateLimitPayload,
  normalizeCodexRateLimits,
} from './CodexRateLimits';

export type CodexRateLimitListener = (state: CodexRateLimitsState) => void;

export class CodexRateLimitStore {
  private state: CodexRateLimitsState = { status: 'unavailable', windows: [] };
  private readonly listeners = new Set<CodexRateLimitListener>();

  subscribe(listener: CodexRateLimitListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setFromPayload(payload: unknown): CodexRateLimitsState {
    this.state = normalizeCodexRateLimits(payload);
    this.emit();
    return this.state;
  }

  mergeFromPayload(payload: unknown): CodexRateLimitsState {
    this.state = mergeCodexRateLimitPayload(this.state, payload);
    this.emit();
    return this.state;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A UI listener must not prevent other listeners from receiving updates.
      }
    }
  }
}
