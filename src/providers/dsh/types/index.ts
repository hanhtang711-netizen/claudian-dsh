export interface DshProviderState extends Record<string, unknown> {
  nativeConversationContextEstablished?: boolean;
}

export function getDshState(
  providerState?: unknown,
): DshProviderState {
  if (
    providerState === null
    || typeof providerState !== 'object'
    || Array.isArray(providerState)
  ) {
    return {};
  }

  const record = providerState as Record<string, unknown>;
  const parsed = Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => (
        key !== 'nativeConversationContextEstablished'
        && value !== undefined
      ),
    ),
  ) as DshProviderState;
  if (typeof record.nativeConversationContextEstablished === 'boolean') {
    parsed.nativeConversationContextEstablished =
      record.nativeConversationContextEstablished;
  }
  return parsed;
}
