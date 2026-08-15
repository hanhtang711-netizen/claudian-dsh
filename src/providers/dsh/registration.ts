import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type {
  ProviderModule,
  ProviderWorkspaceRegistration,
} from '../../core/providers/types';
import { DSH_PROVIDER_CAPABILITIES } from './capabilities';
import { dshSettingsReconciler } from './env/DshSettingsReconciler';
import { DshExecutionBackend } from './execution/DshExecutionBackend';
import { DshConversationHistoryService } from './history/DshConversationHistoryService';
import { decodeDshModelId } from './models';
import { DshCliResolver } from './runtime/DshCliResolver';
import { getDshProviderSettings, updateDshProviderSettings } from './settings';
import { dshChatUIConfig } from './ui/DshChatUIConfig';
import { dshSettingsTabRenderer } from './ui/DshSettingsTab';

export const dshWorkspaceRegistration: ProviderWorkspaceRegistration = {
  initialize: async () => ({
    cliResolver: new DshCliResolver(),
    settingsTabRenderer: dshSettingsTabRenderer,
  }),
};

export const dshProviderRegistration: ProviderModule = {
  id: 'dsh',
  blankTabOrder: 20,
  capabilities: DSH_PROVIDER_CAPABILITIES,
  chatUIConfig: dshChatUIConfig,
  createExecutionBackend: (plugin) => new DshExecutionBackend(plugin),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return dshChatUIConfig.ownsModel(titleModel, settings)
      ? decodeDshModelId(titleModel) ?? undefined
      : undefined;
  },
  displayName: 'DeepSeek Harness',
  environmentKeyPatterns: [/^DSH_/i],
  historyService: new DshConversationHistoryService(),
  isEnabled: (settings) => getDshProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateDshProviderSettings(settings, { enabled }),
  settingsReconciler: dshSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'dsh');
      const normalized = getDshProviderSettings(stored);
      updateDshProviderSettings(target, {
        ...normalized,
      });
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'dsh'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: dshWorkspaceRegistration,
};
