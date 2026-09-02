import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderRateLimitService, ProviderRateLimitState } from '../../../core/providers/types';
import { CodexRateLimitReader } from './CodexRateLimitReader';
import { codexRateLimitStore } from './CodexRateLimitStore';

/** Provider-neutral facade over the Codex reader and shared live-update store. */
export class CodexRateLimitService implements ProviderRateLimitService {
  private readonly reader: CodexRateLimitReader;

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
    try {
      const state = await this.reader.read(signal);
      if (state.status === 'ready' && state.snapshot) {
        codexRateLimitStore.setFromPayload({ rateLimits: state.snapshot });
      } else {
        codexRateLimitStore.setUnavailable();
      }
      return state;
    } catch (error) {
      if (!signal?.aborted) codexRateLimitStore.setUnavailable();
      throw error;
    }
  }
}
