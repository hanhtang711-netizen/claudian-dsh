import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getCodexProviderSettings } from '../settings';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from './codexAppServerSupport';
import { type CodexRateLimitsState,normalizeCodexRateLimits } from './CodexRateLimits';
import { CodexRpcTransport } from './CodexRpcTransport';

export interface CodexRateLimitReaderLike {
  read(signal?: AbortSignal): Promise<CodexRateLimitsState>;
}

/** Performs a read-only, short-lived app-server request. */
export class CodexRateLimitReader implements CodexRateLimitReaderLike {
  constructor(private readonly plugin: ProviderHost) {}

  async read(signal?: AbortSignal): Promise<CodexRateLimitsState> {
    if (!getCodexProviderSettings(this.plugin.settings).enabled || signal?.aborted) {
      return { status: 'unavailable', windows: [] };
    }

    let process: CodexAppServerProcess | null = null;
    let transport: CodexRpcTransport | null = null;
    let abortListener: (() => void) | null = null;
    try {
      const launchSpec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
      if (signal?.aborted) return { status: 'unavailable', windows: [] };
      process = new CodexAppServerProcess(launchSpec);
      process.start();
      transport = new CodexRpcTransport(process);
      transport.start();
      abortListener = () => {
        transport?.dispose();
        void process?.shutdown().catch(() => {});
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      await initializeCodexAppServerTransport(transport);
      if (signal?.aborted) return { status: 'unavailable', windows: [] };
      const payload = await transport.request('account/rateLimits/read', {});
      return normalizeCodexRateLimits(payload);
    } finally {
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      transport?.dispose();
      if (process) await process.shutdown().catch(() => {});
    }
  }
}
