import { ensureProviderProjectionMap } from '../../../core/providers/settings/ProviderProjectionMap';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  decodeDshModelId,
  DSH_BUILT_IN_MODELS,
  encodeDshModelId,
  isDshModelSelectionId,
} from '../models';
import {
  DSH_DEFAULT_MODE_ID,
  DSH_PRESET_MODES,
} from '../modes';
import {
  getDshProviderSettings,
  normalizeDshVisibleModels,
  updateDshProviderSettings,
} from '../settings';

const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_REASONING_VALUE = 'default';

// DeepSeek adapter reasoning efforts: 'off' | 'high' | 'max' plus 'default'
// (no explicit effort — the adapter's natural thinking behavior). Anything
// else (e.g. 'low'/'medium') is rejected at request time.
const DSH_REASONING_OPTIONS: ReadonlyArray<ProviderReasoningOption> = Object.freeze([
  { label: 'Default', value: 'default' },
  { label: 'Off', value: 'off' },
  { label: 'High', value: 'high' },
  { label: 'Max', value: 'max' },
]);

const DSH_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

export const dshChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const dshSettings = getDshProviderSettings(settings);
    const seenValues = new Set<string>();
    const options: ProviderUIOption[] = [];

    for (const model of DSH_BUILT_IN_MODELS) {
      const value = encodeDshModelId(model.id);
      pushOption(
        options,
        seenValues,
        value,
        {
          description: model.description ?? 'DeepSeek Harness runtime',
          label: model.displayName,
          value,
        },
      );
    }

    for (const visibleModel of normalizeDshVisibleModels(dshSettings.visibleModels)) {
      pushOption(
        options,
        seenValues,
        visibleModel,
        {
          description: 'Configured model',
          label: decodeDshModelId(visibleModel) ?? visibleModel,
          value: visibleModel,
        },
      );
    }

    return options;
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    const visibleModels = normalizeDshVisibleModels(
      getDshProviderSettings(settings).visibleModels,
    );
    return visibleModels[0] ?? null;
  },

  ownsModel(model: string): boolean {
    return isDshModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string): boolean {
    const rawModelId = decodeDshModelId(model);
    return rawModelId !== null && DSH_BUILT_IN_MODELS.some((entry) => entry.id === rawModelId);
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return DSH_REASONING_OPTIONS.map((option) => ({ ...option }));
  },

  getDefaultReasoningValue(): string {
    return DEFAULT_REASONING_VALUE;
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isDshModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeDshModelId(model);
    if (!rawModelId) {
      settingsBag.effortLevel = DEFAULT_REASONING_VALUE;
      return;
    }

    const normalizedModel = encodeDshModelId(rawModelId);
    settingsBag.model = normalizedModel;
    settingsBag.effortLevel = DEFAULT_REASONING_VALUE;
    ensureProviderProjectionMap(settingsBag, 'savedProviderModel').dsh = normalizedModel;
    ensureProviderProjectionMap(settingsBag, 'savedProviderEffort').dsh = DEFAULT_REASONING_VALUE;
  },

  normalizeModelVariant(model: string): string {
    const rawModelId = decodeDshModelId(model);
    if (!rawModelId) {
      return model;
    }

    return encodeDshModelId(rawModelId);
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getModeSelector(settings: Record<string, unknown>) {
    const selectedMode = getDshProviderSettings(settings).selectedMode;
    return {
      label: 'Agent 预设',
      value: selectedMode || DSH_DEFAULT_MODE_ID,
      options: DSH_PRESET_MODES.map((mode) => ({
        description: mode.description,
        label: mode.name,
        value: mode.id,
      })),
    };
  },

  applyModeSelection(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    updateDshProviderSettings(settings as Record<string, unknown>, {
      selectedMode: value,
    });
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return DSH_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return typeof settings.permissionMode === 'string'
      ? settings.permissionMode
      : null;
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    // The permission mode is a shared Claudian-level setting, orthogonal to
    // the DSH preset selection (selectedMode).
    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
  },
};

function pushOption(
  target: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }

  seenValues.add(value);
  target.push(option);
}
