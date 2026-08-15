import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  decodeDshModelId,
  DSH_MODEL_PREFIX,
  encodeDshModelId,
} from './models';
import { normalizeManagedDshSelectedMode } from './modes';

export interface PersistedDshProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  selectedMode: string;
  visibleModels: string[];
}

export type DshProviderSettings = PersistedDshProviderSettings;

export const DEFAULT_DSH_PROVIDER_SETTINGS: Readonly<PersistedDshProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  selectedMode: '',
  visibleModels: [
    'dsh:deepseek-v4-pro',
    'dsh:deepseek-v4-flash',
  ],
});

/**
 * DSH visible models are stored as encoded `dsh:<rawId>` selections. Raw ids
 * are tolerated on read and normalized to the encoded form.
 */
export function normalizeDshVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const rawModelId = trimmed.startsWith(DSH_MODEL_PREFIX)
      ? decodeDshModelId(trimmed)
      : trimmed;
    const encoded = rawModelId ? encodeDshModelId(rawModelId) : '';
    if (!encoded || seen.has(encoded)) {
      continue;
    }

    seen.add(encoded);
    normalized.push(encoded);
  }

  return normalized;
}

export function getDshProviderSettings(
  settings: Record<string, unknown>,
): DshProviderSettings {
  const config = getProviderConfig(settings, 'dsh');
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);

  return {
    cliPath: readStoredString(config.cliPath, DEFAULT_DSH_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost,
    enabled: readStoredBoolean(config.enabled, DEFAULT_DSH_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_DSH_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'dsh')
        ?? DEFAULT_DSH_PROVIDER_SETTINGS.environmentVariables,
    ),
    selectedMode: normalizeManagedDshSelectedMode(config.selectedMode),
    visibleModels: normalizeDshVisibleModels(config.visibleModels),
  };
}

export function updateDshProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<DshProviderSettings>,
): DshProviderSettings {
  const current = getDshProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextSelectedMode = normalizeManagedDshSelectedMode(
    updates.selectedMode ?? current.selectedMode,
  );
  const nextVisibleModels = normalizeDshVisibleModels(
    updates.visibleModels ?? current.visibleModels,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_DSH_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_DSH_PROVIDER_SETTINGS.cliPath;
  }

  const next: DshProviderSettings = {
    ...current,
    ...updates,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    selectedMode: nextSelectedMode,
    visibleModels: nextVisibleModels,
  };

  if (updates.visibleModels !== undefined) {
    retargetRemovedDshSelections(settings, next);
  }

  setProviderConfig(settings, 'dsh', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    selectedMode: next.selectedMode,
    visibleModels: next.visibleModels,
  });

  return next;
}

function retargetRemovedDshSelections(
  settings: Record<string, unknown>,
  next: DshProviderSettings,
): void {
  if (next.visibleModels.length === 0) {
    if (
      typeof settings.titleGenerationModel === 'string'
      && decodeDshModelId(settings.titleGenerationModel) !== null
    ) {
      settings.titleGenerationModel = '';
    }
    return;
  }

  const visibleSet = new Set(next.visibleModels);
  const fallbackModelId = next.visibleModels[0];

  const maybeRetargetModel = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }

    const rawModelId = decodeDshModelId(value);
    if (!rawModelId) {
      return null;
    }

    const encoded = encodeDshModelId(rawModelId);
    return visibleSet.has(encoded) ? null : fallbackModelId;
  };

  const savedProviderModelRaw = settings.savedProviderModel;
  if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
    const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
    const nextSavedModel = maybeRetargetModel(savedProviderModel.dsh);
    if (nextSavedModel) {
      savedProviderModel.dsh = nextSavedModel;
      const savedProviderEffortRaw = settings.savedProviderEffort;
      if (savedProviderEffortRaw && typeof savedProviderEffortRaw === 'object' && !Array.isArray(savedProviderEffortRaw)) {
        (savedProviderEffortRaw as Record<string, unknown>).dsh = 'medium';
      }
    }
  }

  const nextTopLevelModel = maybeRetargetModel(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = 'medium';
  }

  const nextTitleGenerationModel = maybeRetargetModel(settings.titleGenerationModel);
  if (nextTitleGenerationModel) {
    settings.titleGenerationModel = nextTitleGenerationModel;
  }
}
