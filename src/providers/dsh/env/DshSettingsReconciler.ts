import {
  type CliPathFingerprintInputs,
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import {
  decodeDshModelId,
  encodeDshModelId,
  isDshModelSelectionId,
} from '../models';
import {
  getDshProviderSettings,
  updateDshProviderSettings,
} from '../settings';

const DSH_ENV_HASH_KEYS = [
  'PATH',
] as const;

function computeDshRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CliPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: DSH_ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidateDshConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'dsh') {
      continue;
    }

    if (!conversation.sessionId) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidatedConversations.push(conversation);
  }
  return invalidatedConversations;
}

export const dshSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateDshConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'dsh');
    const dshSettings = getDshProviderSettings(settings);
    const cliPathInputs = createCliPathFingerprintInputs(
      dshSettings.cliPathsByHost[getHostnameKey()],
      dshSettings.cliPath,
    );
    const currentHash = computeDshRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = dshSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCliPathFingerprintInputs(cliPathInputs)
      || DSH_ENV_HASH_KEYS.some(
        key => Object.prototype.hasOwnProperty.call(environment, key),
      )
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateDshConversationSessions(conversations);

    updateDshProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    let changed = false;

    const normalizeSelection = (value: unknown): string | null => {
      if (typeof value !== 'string' || !isDshModelSelectionId(value)) {
        return null;
      }

      const rawModelId = decodeDshModelId(value);
      return rawModelId ? encodeDshModelId(rawModelId) : null;
    };

    const modelSelection = normalizeSelection(settings.model);
    if (
      typeof settings.model === 'string'
      && modelSelection
      && settings.model !== modelSelection
    ) {
      settings.model = modelSelection;
      changed = true;
    }

    const titleModelSelection = normalizeSelection(settings.titleGenerationModel);
    if (
      typeof settings.titleGenerationModel === 'string'
      && titleModelSelection
      && settings.titleGenerationModel !== titleModelSelection
    ) {
      settings.titleGenerationModel = titleModelSelection;
      changed = true;
    }

    const savedProviderModelRaw = settings.savedProviderModel;
    if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
      const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
      const savedSelection = normalizeSelection(savedProviderModel.dsh);
      if (
        typeof savedProviderModel.dsh === 'string'
        && savedSelection
        && savedProviderModel.dsh !== savedSelection
      ) {
        savedProviderModel.dsh = savedSelection;
        changed = true;
      }
    }

    return changed;
  },
};
