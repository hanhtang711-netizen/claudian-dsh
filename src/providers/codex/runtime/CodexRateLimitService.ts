import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderRateLimitService, ProviderRateLimitState } from '../../../core/providers/types';
import type { CodexRateLimitsState } from './CodexRateLimits';
import { CodexRateLimitReader } from './CodexRateLimitReader';
import { codexRateLimitStore } from './CodexRateLimitStore';

/**
 * Consecutive failed polls after which the last known-good numbers are
 * dropped and the dashboard falls back to "暂不可读取". Polls run every 60s,
 * so a single transient hiccup (app-server spawn contention, cold start,
 * backend timeout) must not wipe the dashboard — only a sustained outage
 * should. A success resets the counter.
 */
const UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES = 2;

/** Provider-neutral facade over the Codex reader and shared live-update store. */
export class CodexRateLimitService implements ProviderRateLimitService {
  private readonly reader: CodexRateLimitReader;
  private consecutiveFailures = 0;

  constructor(plugin: ProviderHost) {
    this.reader = new CodexRateLimitReader(plugin);
  }

  read(signal?: AbortSignal): Promise<ProviderRateLimitState> {
    return this.reader.read(signal);
  }

  subscribe(listener: (state: ProviderRateLimitState) => void): () => void {
    return codexRateLimitStore.subscribe(listener);
  }

  async refresh(signal?: AbortSignal): Promise<ProviderRateLimitState> {
    let state: CodexRateLimitsState;
    try {
      state = await this.reader.read(signal);
    } catch (error) {
      if (!signal?.aborted) this.trackFailure();
      throw error;
    }
    // An aborted read is not a failure: a newer refresh or a view shutdown
    // superseded this one, and the store must keep whatever it last knew.
    if (signal?.aborted) return state;
    if (state.status === 'ready' && state.snapshot) {
      this.consecutiveFailures = 0;
      codexRateLimitStore.setFromPayload({ rateLimits: state.snapshot });
    } else {
      this.trackFailure();
    }
    return state;
  }

  private trackFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES) {
      codexRateLimitStore.setUnavailable();
    }
  }
}
