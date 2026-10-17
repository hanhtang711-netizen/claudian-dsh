import { CodexRateLimitService } from '@/providers/codex/runtime/CodexRateLimitService';
import { CodexRateLimitStore } from '@/providers/codex/runtime/CodexRateLimitStore';

function setup() {
  const rateLimits = new CodexRateLimitStore();
  const request = jest.fn().mockResolvedValue({ rateLimits: {
    primary: { usedPercent: 17, windowDurationMins: 300 },
    secondary: { usedPercent: 31, windowDurationMins: 10080 },
  } });
  const release = jest.fn().mockResolvedValue(undefined);
  const runtime = { acquire: jest.fn().mockResolvedValue({ connection: { rateLimits, transport: { request } }, release }) };
  const service = new CodexRateLimitService(runtime as never, () => true);
  return { service, runtime, request, release, rateLimits };
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('Codex account quota through the shared runtime', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shares polling between views, preserves sparse live updates and stops at the final unsubscribe', async () => {
    const { service, runtime, request, release, rateLimits } = setup();
    const first = jest.fn(); const second = jest.fn();
    const offFirst = service.subscribe(first);
    const offSecond = service.subscribe(second);
    await settle();
    expect(runtime.acquire).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('account/rateLimits/read', {}, 15_000, expect.any(AbortSignal));
    expect(release).toHaveBeenCalledTimes(1);
    expect(first.mock.lastCall![0].windows.map((w: { remainingPercent: number }) => w.remainingPercent)).toEqual([83, 69]);
    rateLimits.mergeFromPayload({ rateLimits: { primary: null, credits: {} } });
    expect(second.mock.lastCall![0].windows[0].remainingPercent).toBe(83);
    rateLimits.mergeFromPayload({ rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300 } } });
    expect(first.mock.lastCall![0].windows[0].remainingPercent).toBe(5);
    offFirst();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runtime.acquire).toHaveBeenCalledTimes(2);
    offSecond();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runtime.acquire).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('keeps good values across one transient error, but clears after sustained failure', async () => {
    const { service, request, rateLimits } = setup();
    const listener = jest.fn(); const off = service.subscribe(listener);
    await settle();
    request.mockRejectedValue(new Error('offline'));
    await service.refresh();
    expect(listener.mock.lastCall![0].status).toBe('ready');
    rateLimits.mergeFromPayload({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } });
    await service.refresh();
    expect(listener.mock.lastCall![0].status).toBe('ready');
    await service.refresh();
    expect(listener.mock.lastCall![0].status).toBe('unavailable');
    off(); service.dispose();
  });

  it('fences an old-account response and notifications during environment transitions', async () => {
    const { service, request, rateLimits, release } = setup();
    const listener = jest.fn(); const off = service.subscribe(listener);
    await settle();
    let complete!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = service.refresh();
    await settle();
    service.beginEnvironmentTransition();
    complete({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } } });
    await pending;
    rateLimits.mergeFromPayload({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } } });
    expect(listener.mock.lastCall![0].status).toBe('unavailable');
    expect(release).toHaveBeenCalledTimes(2);
    off(); service.dispose();
  });

  it('does not publish a late response after its last view closes', async () => {
    const { service, request } = setup();
    let complete!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const listener = jest.fn(); const off = service.subscribe(listener);
    await settle(); off(); const calls = listener.mock.calls.length;
    complete({ rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } } });
    await settle();
    expect(listener).toHaveBeenCalledTimes(calls);
    service.dispose();
  });
});
