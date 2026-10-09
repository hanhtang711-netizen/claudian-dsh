export interface DshModelInfo {
  description?: string;
  displayName: string;
  id: string;
}

export const DSH_MODEL_PREFIX = 'dsh:';

/**
 * Built-in DSH model catalog. No discovery and no variants: the bridge
 * accepts raw model ids (`deepseek-flash` / `deepseek-v4-pro`) and
 * reports its own options per session.
 */
export const DSH_BUILT_IN_MODELS: ReadonlyArray<DshModelInfo> = Object.freeze([
  {
    displayName: 'DeepSeek V41 Flash',
    id: 'deepseek-flash',
  },
  {
    displayName: 'DeepSeek V4 Pro',
    id: 'deepseek-v4-pro',
  },
]);

export const DSH_BUILT_IN_MODEL_IDS: ReadonlySet<string> = Object.freeze(
  new Set(DSH_BUILT_IN_MODELS.map((model) => model.id)),
);

export function isDshModelSelectionId(model: string): boolean {
  return decodeDshModelId(model) !== null;
}

export function encodeDshModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${DSH_MODEL_PREFIX}${normalized}` : '';
}

export function decodeDshModelId(model: string): string | null {
  if (!model.startsWith(DSH_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(DSH_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}
