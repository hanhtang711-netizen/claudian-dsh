import { mergePersistedProviderState } from '../../../core/providers/providerState';
import { loadDshSessionMessages } from './DshHistoryStore';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getDshState } from '../types';

const DSH_PROVIDER_STATE_KEYS = [
  'nativeConversationContextEstablished',
] as const;

/**
 * The DSH bridge process owns the whole conversation (in-memory history plus
 * its own persistence); Claudian never hydrates messages from disk. The
 * service only manages the resume session id and the native-context flag.
 */
export class DshConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = conversation.sessionId;
    if (!sessionId) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = sessionId;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      this.markNativeConversationContextEstablished(conversation);
      return;
    }

    const messages = await loadDshSessionMessages(sessionId, {
      vaultPath: vaultPath ?? null,
    });
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
    this.markNativeConversationContextEstablished(conversation);
  }

  private markNativeConversationContextEstablished(
    conversation: Conversation,
  ): void {
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: true,
    };
  }

  async resolveMissingConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<'delete' | 'reset' | 'preserve'> {
    if (
      !conversation.sessionId
      || !missingProviderSessionId
      || conversation.sessionId !== missingProviderSessionId
    ) {
      return 'preserve';
    }

    conversation.sessionId = null;
    conversation.providerState = {
      ...conversation.providerState,
      nativeConversationContextEstablished: false,
    };
    this.hydratedKeys.delete(conversation.id);
    return 'reset';
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const state = getDshState(conversation.providerState);
    return mergePersistedProviderState(
      conversation.providerState,
      DSH_PROVIDER_STATE_KEYS,
      {
        nativeConversationContextEstablished:
          typeof state.nativeConversationContextEstablished === 'boolean'
            ? state.nativeConversationContextEstablished
            : true,
      },
    );
  }
}
