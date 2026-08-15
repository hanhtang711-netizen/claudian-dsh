import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import {
  type DshAcpSessionKernelFactory,
  DshExecutionSession,
} from './DshExecutionSession';

export interface DshExecutionBackendOptions {
  readonly createKernel?: DshAcpSessionKernelFactory;
}

export class DshExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'dsh' as const;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: DshExecutionBackendOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new DshExecutionSession(this.plugin, config, this.options);
  }
}
