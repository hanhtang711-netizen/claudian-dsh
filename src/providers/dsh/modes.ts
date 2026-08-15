export interface DshMode {
  description?: string;
  id: string;
  name: string;
}

/**
 * DSH agent presets surfaced as the provider's mode selector. The ids match
 * the shipped preset directory names under the dsh package's
 * config/agent-presets/ (standard / minimal / code / cordis). A preset is
 * fixed per native session (the DSH agent composition is chosen at agent
 * creation); the permission dimension (yolo/safe/plan) is carried by the
 * separate `permission` ACP config option instead of a mode.
 */
export const DSH_PRESET_MODES: ReadonlyArray<DshMode> = Object.freeze([
  {
    description: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    id: 'standard',
    name: '标准模式',
  },
  {
    description: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。',
    id: 'minimal',
    name: '极简模式',
  },
  {
    description: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具。',
    id: 'code',
    name: 'PTC 模式',
  },
  {
    description: '用于创建自定义 Agent preset：标准能力 + 运行时检查与 preset 创作指导。',
    id: 'cordis',
    name: '创造模式',
  },
]);

export const DSH_DEFAULT_MODE_ID = 'standard';

export const DSH_FALLBACK_MODES: ReadonlyArray<DshMode> = DSH_PRESET_MODES;

export function normalizeDshAvailableModes(value: unknown): DshMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: DshMode[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : id;
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : '';

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      ...(description ? { description } : {}),
      id,
      name: name || id,
    });
  }

  return normalized;
}

export function getEffectiveDshModes(modes: DshMode[]): DshMode[] {
  return modes.length > 0 ? modes : [...DSH_FALLBACK_MODES];
}

export function getManagedDshModes(modes: DshMode[]): DshMode[] {
  const effectiveModes = getEffectiveDshModes(modes);
  return DSH_FALLBACK_MODES.map((fallbackMode) => (
    effectiveModes.find((mode) => mode.id === fallbackMode.id) ?? fallbackMode
  ));
}

export function normalizeDshSelectedMode(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : '';
}

/** Preset ids are a fixed managed vocabulary; anything unknown falls back to standard. */
export function normalizeManagedDshSelectedMode(value: unknown): string {
  const normalized = normalizeDshSelectedMode(value);
  const managedModes = getManagedDshModes([]);
  return managedModes.some((mode) => mode.id === normalized)
    ? normalized
    : DSH_DEFAULT_MODE_ID;
}

/**
 * DSH presets do not map onto Claudian permission modes; the permission
 * dimension is carried separately. Always null so a preset never flips the
 * shared permission mode state.
 */
export function resolvePermissionModeForManagedDshMode(
  _modeId: unknown,
): 'normal' | 'plan' | 'yolo' | null {
  return null;
}
