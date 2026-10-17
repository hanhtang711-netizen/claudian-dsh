import type { ProviderRateLimitService, ProviderRateLimitState } from '@/core/providers/types';

import type { CodexAppServerConnection, CodexAppServerRuntime } from './CodexAppServerRuntime';
import { waitForCodexOperation } from './CodexAppServerRuntime';
import { normalizeCodexRateLimits } from './CodexRateLimits';

/** One account dashboard poller for all views; leases never own the shared process. */
export class CodexRateLimitService implements ProviderRateLimitService {
  private state: ProviderRateLimitState = { status: 'unavailable', windows: [] };
  private readonly listeners = new Set<(state: ProviderRateLimitState) => void>();
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private connection: CodexAppServerConnection | null = null;
  private unsubscribe: (() => void) | null = null;
  private failures = 0;
  private revision = 0;
  private transitioning = false;
  private disposed = false;

  constructor(
    private readonly runtime: Pick<CodexAppServerRuntime, 'acquire'>,
    private readonly isEnabled: () => boolean,
  ) {}

  subscribe(listener: (state: ProviderRateLimitState) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.state);
    if (this.timer === null) {
      this.timer = window.setInterval(() => { void this.refresh(); }, 60_000);
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopObserving();
    };
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.transitioning) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const revision = ++this.revision;
    const current = () => !this.disposed && !controller.signal.aborted && revision === this.revision;
    if (!this.isEnabled()) {
      this.detachConnection();
      this.publish({ status: 'unavailable', windows: [] });
      return;
    }
    try {
      const lease = await this.runtime.acquire({ readiness: 'initialized', signal: controller.signal });
      try {
        if (!current()) return;
        if (this.connection !== lease.connection) {
          this.detachConnection();
          this.connection = lease.connection;
          // A replacement server may represent a different account; never carry old numbers into it.
          this.publish({ status: 'unavailable', windows: [] });
          this.unsubscribe = lease.connection.rateLimits.subscribe(state => {
            if (state.status === 'ready') this.failures = 0;
            this.publish(state);
          });
        }
        const payload = await waitForCodexOperation(
          lease.connection.transport.request('account/rateLimits/read', {}, 15_000, controller.signal),
          controller.signal,
        );
        if (!current()) return;
        const state = normalizeCodexRateLimits(payload);
        if (state.status === 'ready') {
          this.failures = 0;
          lease.connection.rateLimits.setFromPayload(payload);
        } else {
          this.trackFailure();
        }
      } finally {
        await lease.release();
      }
    } catch {
      if (current()) this.trackFailure();
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  beginEnvironmentTransition(): void {
    this.transitioning = true;
    this.revision++;
    this.controller?.abort();
    this.detachConnection();
    this.failures = 0;
    this.publish({ status: 'unavailable', windows: [] });
  }

  endEnvironmentTransition(): void {
    this.transitioning = false;
    if (this.listeners.size) void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.stopObserving();
    this.listeners.clear();
  }

  private trackFailure(): void {
    if (++this.failures >= 2) this.publish({ status: 'unavailable', windows: [] });
  }

  private publish(state: ProviderRateLimitState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private detachConnection(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connection = null;
  }

  private stopObserving(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.detachConnection();
  }
}
