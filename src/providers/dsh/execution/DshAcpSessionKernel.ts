import * as path from 'node:path';

import type {
  ProviderSessionConfig,
  ProviderSystemInstructions,
} from '@/core/execution';
import type { SystemPromptSettings } from '@/core/prompt/mainAgent';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  AcpClientConnection,
  AcpInteractionController,
  AcpJsonRpcTransport,
  type AcpPermissionPresentation,
  type AcpPromptRequest,
  type AcpPromptResponse,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  type AcpSessionNotification,
  type AcpSetSessionModelRequest,
  type AcpSetSessionModelResponse,
  AcpSubprocess,
  JsonRpcErrorResponse,
  resolveAcpLoadSessionId,
} from '@/providers/acp';
import { getEnhancedPath } from '@/utils/env';

import { prepareDshLaunchArtifacts } from '../runtime/DshLaunchArtifacts';
import { buildDshRuntimeEnv } from '../runtime/DshRuntimeEnvironment';

export type DshExecutionProfile = 'managed' | 'passive' | 'readonly';

export interface DshKernelConnectOptions {
  readonly profile: DshExecutionProfile;
  readonly systemInstructions: ProviderSystemInstructions;
}

export interface DshNativeSessionInfo {
  readonly sessionId: string;
  readonly configOptions?: AcpSessionConfigOption[] | null;
  readonly models?: AcpSessionModelState | null;
  readonly modes?: AcpSessionModeState | null;
}

export interface DshAcpSessionKernelOptions {
  readonly artifactsSubdir?: string;
  readonly config: ProviderSessionConfig;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly onNotification: (notification: AcpSessionNotification) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface DshAcpSessionKernel {
  connect(options: DshKernelConnectOptions): Promise<void>;
  openSession(resumeSessionId?: string): Promise<DshNativeSessionInfo>;
  setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse>;
  setConfigOption(request: Record<string, unknown>): Promise<{
    configOptions?: AcpSessionConfigOption[] | null;
  }>;
  prompt(request: AcpPromptRequest): Promise<Pick<
    AcpPromptResponse,
    'usage' | 'userMessageId'
  > & Partial<Pick<AcpPromptResponse, 'stopReason'>>>;
  cancel(sessionId: string): void;
  dispose(): Promise<void>;
}

export class DshSessionMissingError extends Error {
  readonly name = 'DshSessionMissingError';

  constructor(
    readonly sessionId: string,
    readonly providerError: unknown,
  ) {
    super(providerError instanceof Error
      ? providerError.message
      : 'DSH session is missing');
  }
}

export function classifyDshSessionLoadError(
  error: unknown,
  attemptedSessionId: string,
): unknown {
  if (
    !(error instanceof JsonRpcErrorResponse)
    || (error.method !== 'session/load' && error.method !== 'loadSession')
  ) {
    return error;
  }

  let data: string;
  try {
    data = JSON.stringify(error.data ?? '');
  } catch {
    data = '';
  }
  const evidence = `${error.message} ${data}`.toLowerCase();
  const explicitlyMissing = (
    /session(?:[_\s-]+)(?:not(?:[_\s-]+)found|missing|unknown)/u.test(evidence)
    || /(?:missing|unknown|not\s+found)[^\n]*session/u.test(evidence)
    || /session[^\n]*does\s+not\s+exist/u.test(evidence)
  );
  return explicitlyMissing
    ? new DshSessionMissingError(attemptedSessionId, error)
    : error;
}

export class DefaultDshAcpSessionKernel
  implements DshAcpSessionKernel {
  private connection: AcpClientConnection | null = null;
  private process: AcpSubprocess | null = null;
  private transport: AcpJsonRpcTransport | null = null;
  private interactionController: AcpInteractionController | null = null;
  private profile: DshExecutionProfile = 'managed';
  private disposed = false;
  private connectPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: DshAcpSessionKernelOptions) {}

  connect(options: DshKernelConnectOptions): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('DSH ACP kernel is disposed'));
    }
    if (this.connectPromise) return this.connectPromise;
    if (this.connection) return Promise.resolve();

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    this.connectPromise = pending;
    pending.then(
      () => this.clearConnectPromise(pending),
      () => this.clearConnectPromise(pending),
    );
    void this.connectInternal(options).then(resolve, reject);
    return pending;
  }

  private async connectInternal(
    options: DshKernelConnectOptions,
  ): Promise<void> {
    this.profile = options.profile;
    try {
      const cliPath = await this.options.plugin
        .getResolvedProviderCliPath('dsh') ?? 'dsh';
      this.assertNotDisposed();
      const runtimeEnv = buildDshRuntimeEnv(
        this.options.plugin.settings,
        cliPath,
      );
      const artifacts = await prepareDshLaunchArtifacts({
        artifactsSubdir: this.options.artifactsSubdir
          ?? `dsh/execution/${this.options.sessionInstanceId}`,
        ...(options.systemInstructions.kind === 'explicit'
          ? {
            systemPromptKey: options.systemInstructions.instructions,
            systemPromptText: options.systemInstructions.instructions,
          }
          : {
            settings: getSystemPromptSettings(
              this.options.plugin,
              this.options.config.vaultWorkingDirectory,
            ),
          }),
        workspaceRoot: this.options.config.vaultWorkingDirectory,
      });
      this.assertNotDisposed();

      const processEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...runtimeEnv,
        PATH: getEnhancedPath(
          runtimeEnv.PATH,
          path.isAbsolute(cliPath) ? cliPath : undefined,
        ),
      };
      const subprocess = new AcpSubprocess({
        args: ['--profile', 'bridge', '--config', artifacts.configPath],
        command: cliPath,
        cwd: this.options.config.vaultWorkingDirectory,
        env: processEnv,
      });
      this.process = subprocess;
      this.assertNotDisposed();
      subprocess.start();
      this.assertNotDisposed();

      const transport = new AcpJsonRpcTransport({
        input: subprocess.stdout,
        onClose: (listener) => subprocess.onClose(listener),
        output: subprocess.stdin,
      });
      this.transport = transport;
      this.assertNotDisposed();
      transport.onClose((error) => {
        if (!this.disposed && this.transport === transport) {
          this.options.onClosed(
            error ?? new Error('DSH ACP transport closed'),
          );
        }
      });

      this.interactionController = new AcpInteractionController({
        getTurnId: this.options.getActiveTurnId,
        interactionPort: this.options.config.interactionPort,
        presentPermission: presentDshPermission,
        sessionInstanceId: this.options.sessionInstanceId,
      });
      this.assertNotDisposed();
      const connection = new AcpClientConnection({
        clientInfo: {
          name: 'claudian',
          version: this.options.plugin.manifest?.version ?? '0.0.0',
        },
        delegate: {
          onSessionNotification: (notification) => {
            if (!this.disposed) this.options.onNotification(notification);
          },
          requestPermission: (request) => this.handlePermissionRequest(request),
        },
        transport,
      });
      this.connection = connection;
      this.assertNotDisposed();
      transport.start();
      this.assertNotDisposed();
      await connection.initialize();
      this.assertNotDisposed();
    } catch (error) {
      await this.disposeNativeResources();
      throw error;
    }
  }

  async openSession(resumeSessionId?: string): Promise<DshNativeSessionInfo> {
    const connection = this.requireConnection();
    const cwd = this.options.config.vaultWorkingDirectory;
    if (resumeSessionId) {
      let response;
      try {
        response = await connection.loadSession({
          cwd,
          mcpServers: [],
          sessionId: resumeSessionId,
        });
      } catch (error) {
        throw classifyDshSessionLoadError(error, resumeSessionId);
      }
      return {
        configOptions: response.configOptions,
        models: response.models,
        modes: response.modes,
        sessionId: resolveAcpLoadSessionId(response, resumeSessionId),
      };
    }

    const response = await connection.newSession({ cwd, mcpServers: [] });
    return {
      configOptions: response.configOptions,
      models: response.models,
      modes: response.modes,
      sessionId: response.sessionId,
    };
  }

  setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse> {
    return this.requireConnection().setModel(request);
  }

  setConfigOption(request: Record<string, unknown>): Promise<{
    configOptions?: AcpSessionConfigOption[] | null;
  }> {
    return this.requireConnection().setConfigOption(
      request as Parameters<AcpClientConnection['setConfigOption']>[0],
    );
  }

  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse> {
    return this.requireConnection().prompt(request);
  }

  cancel(sessionId: string): void {
    this.connection?.cancel({ sessionId });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    this.disposePromise = pending;
    void this.disposeInternal().then(resolve, reject);
    return pending;
  }

  private async disposeInternal(): Promise<void> {
    await this.disposeNativeResources();
    await this.connectPromise?.catch(() => undefined);
    await this.disposeNativeResources();
  }

  private async disposeNativeResources(): Promise<void> {
    const interactionController = this.interactionController;
    this.interactionController = null;
    const connection = this.connection;
    this.connection = null;
    const transport = this.transport;
    this.transport = null;
    const subprocess = this.process;
    this.process = null;

    try {
      interactionController?.dispose();
    } catch {
      // Continue closing native resources.
    }
    try {
      connection?.dispose();
    } catch {
      // Continue closing native resources.
    }
    try {
      transport?.dispose();
    } catch {
      // Continue closing native resources.
    }
    try {
      await subprocess?.shutdown();
    } catch {
      // Resource cleanup is best effort after ownership has been detached.
    }
  }

  private clearConnectPromise(pending: Promise<void>): void {
    if (this.connectPromise === pending) this.connectPromise = null;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('DSH ACP kernel is disposed');
  }

  private handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    if (this.profile !== 'managed') {
      return Promise.resolve(selectDeniedPermission(request));
    }
    return this.interactionController?.requestPermission(request)
      ?? Promise.resolve({ outcome: { outcome: 'cancelled' } });
  }

  private requireConnection(): AcpClientConnection {
    if (!this.connection) throw new Error('DSH ACP kernel is not connected');
    return this.connection;
  }
}

export function presentDshPermission(
  request: AcpRequestPermissionRequest,
  input: Readonly<Record<string, unknown>>,
): AcpPermissionPresentation {
  const toolName = normalizePermissionToolName(request.toolCall.title);
  const blockedPath = extractPermissionPath(input, request.toolCall.locations);

  return {
    ...(blockedPath ? { blockedPath } : {}),
    description: blockedPath
      ? `DeepSeek Harness wants permission to use ${toolName} on this path.`
      : `DeepSeek Harness wants permission to use ${toolName}.`,
    toolName,
  };
}

function normalizePermissionToolName(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized || 'tool';
}

function extractPermissionPath(
  input: Readonly<Record<string, unknown>>,
  locations: ReadonlyArray<{ path: string }> | null | undefined,
): string | undefined {
  const candidateKeys = ['filepath', 'filePath', 'path', 'parentDir'];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const locationPath = locations?.find((location) => location.path.trim())?.path;
  return locationPath?.trim() || undefined;
}

function selectDeniedPermission(
  request: AcpRequestPermissionRequest,
): AcpRequestPermissionResponse {
  const rejected = request.options.find(({ kind }) => kind === 'reject_once')
    ?? request.options.find(({ kind }) => kind === 'reject_always');
  return rejected
    ? {
      outcome: {
        optionId: rejected.optionId,
        outcome: 'selected',
      },
    }
    : { outcome: { outcome: 'cancelled' } };
}

function getSystemPromptSettings(
  plugin: ProviderHost,
  vaultPath: string,
): SystemPromptSettings {
  return {
    customPrompt: plugin.settings.systemPrompt,
    mediaFolder: plugin.settings.mediaFolder,
    userName: plugin.settings.userName,
    vaultPath,
  };
}
