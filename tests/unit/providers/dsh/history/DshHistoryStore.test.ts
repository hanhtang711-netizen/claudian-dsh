import { parseDshSessionLog } from '@/providers/dsh/history/DshHistoryStore';

describe('DshHistoryStore', () => {
  it('keeps reasoning content out of visible text and folds it into thinking blocks', () => {
    const log = [
      JSON.stringify({
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'hidden thought...' },
              { type: 'text', text: 'visible reply' },
            ],
          },
        },
      }),
    ].join('\n');

    const messages = parseDshSessionLog(log, 's1');

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      content: 'visible reply',
      role: 'assistant',
    });
    // The renderer draws from contentBlocks exclusively when non-empty, so the
    // reply text must be projected there or hydrated body text disappears.
    expect(messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'hidden thought...' },
      { type: 'text', content: 'visible reply' },
    ]);
    expect(messages[1].content).not.toContain('hidden thought');
  });

  it('projects reply text into contentBlocks even without reasoning blocks', () => {
    const log = [
      JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'plain reply' }],
          },
        },
      }),
    ].join('\n');

    const messages = parseDshSessionLog(log, 's1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: 'plain reply',
      contentBlocks: [{ type: 'text', content: 'plain reply' }],
    });
  });

  it('skips thought blocks and keeps tool-call blocks out of assistant text', () => {
    const log = [
      JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'thought', text: 'more hidden thinking' },
              { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"a.md"}' },
            ],
          },
        },
      }),
      JSON.stringify({
        type: 'tool/call',
        data: { callId: 'call_1', name: 'read', arguments: '{"file_path":"a.md"}' },
      }),
      JSON.stringify({
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'call_1' },
            content: [{ type: 'tool-result', toolCallId: 'call_1', content: 'contents' }],
          },
        },
      }),
    ].join('\n');

    const messages = parseDshSessionLog(log, 's1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
    expect(messages[0].contentBlocks).toEqual([
      { type: 'thinking', content: 'more hidden thinking' },
    ]);
    expect(messages[0].toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'read' }),
    ]);
  });
});
