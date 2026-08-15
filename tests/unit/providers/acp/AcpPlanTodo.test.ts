import {
  AcpExecutionEventNormalizer,
  type AcpExecutionNormalizationResult,
} from '@/providers/acp';

function createNormalizer(): AcpExecutionEventNormalizer {
  return new AcpExecutionEventNormalizer({
    scope: {
      executionId: 'execution-1',
      kind: 'requested',
      sessionInstanceId: 'session-instance-1',
      turnId: 'turn-1',
    },
  });
}

describe('AcpExecutionEventNormalizer plan updates', () => {
  it('projects ACP plan entries onto a synthetic TodoWrite tool call', () => {
    const normalizer = createNormalizer();
    const result: AcpExecutionNormalizationResult = normalizer.normalize({
      sessionUpdate: 'plan',
      entries: [
        { content: 'first task', priority: 'high', status: 'in_progress' },
        { content: 'second task', priority: 'low', status: 'pending' },
      ],
    });

    expect(result.events.map(({ type }) => type)).toEqual([
      'tool_started',
      'tool_completed',
    ]);

    const started = result.events[0] as Extract<
      AcpExecutionNormalizationResult['events'][number],
      { type: 'tool_started' }
    >;
    expect(started.name).toBe('TodoWrite');
    expect(started.input).toEqual({
      todos: [
        { activeForm: 'first task', content: 'first task', status: 'in_progress' },
        { activeForm: 'second task', content: 'second task', status: 'pending' },
      ],
    });

    const completed = result.events[1] as { toolCallId: string; type: string };
    expect(completed.type).toBe('tool_completed');
    expect(completed.toolCallId).toBe(started.toolCallId);
  });

  it('keeps the synthetic toolCallId stable across plan snapshots', () => {
    const normalizer = createNormalizer();
    const first = normalizer.normalize({
      sessionUpdate: 'plan',
      entries: [{ content: 'first task', priority: 'medium', status: 'pending' }],
    });
    const second = normalizer.normalize({
      sessionUpdate: 'plan',
      entries: [{ content: 'first task', priority: 'medium', status: 'completed' }],
    });

    const firstId = (first.events[0] as { toolCallId: string }).toolCallId;
    const secondId = (second.events[0] as { toolCallId: string }).toolCallId;
    expect(secondId).toBe(firstId);
  });
});
