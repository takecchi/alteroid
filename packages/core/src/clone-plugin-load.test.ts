import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, wireEvents, waitFor, waitForDone } from './clone-test-harness.js';

describe('クローン — plugin の読み込み結果（init の plugins / plugin_errors。Issue #3816）', () => {
  function setupWith(fakeSdkOptions: Parameters<typeof fakeSdk>[1]) {
    const { fn } = fakeSdk(undefined, fakeSdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    return { clone, events };
  }

  it('init を観測する前は undefined（0件とも失敗とも読ませない）', async () => {
    let releaseInit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const s = setupWith({
      beforeInit: () => gate,
      initExtras: () => ({ plugins: [{ name: 'a', path: '/p/a' }] }),
    });
    s.clone.post(humanMessage('やあ'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(s.clone.pluginLoad?.()).toBeUndefined();

    releaseInit();
    await waitForDone(s.events);
    expect(s.clone.pluginLoad?.()?.pluginLoad.plugins).toEqual([{ name: 'a' }]);

    await s.clone.stop();
  });

  it('init が plugins と plugin_errors を知らせると、時刻つきで控える', async () => {
    const s = setupWith({
      initExtras: () => ({
        plugins: [{ name: 'a', path: '/p/a', version: '1.0.0' }],
        plugin_errors: [{ plugin: 'b', type: 'manifest', message: 'bad' }],
      }),
    });
    const before = Date.now();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const observed = s.clone.pluginLoad?.();
    expect(observed?.pluginLoad).toEqual({
      plugins: [{ name: 'a', version: '1.0.0' }],
      errors: [{ plugin: 'b', type: 'manifest', message: 'bad' }],
    });
    expect(new Date(observed!.at).toISOString()).toBe(observed!.at);
    expect(Date.parse(observed!.at)).toBeGreaterThanOrEqual(before);

    await s.clone.stop();
  });

  it('plugin_errors を省いた init は errors: null で控える（無事の断定にしない）', async () => {
    const s = setupWith({ initExtras: () => ({ plugins: [] }) });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(s.clone.pluginLoad?.()?.pluginLoad).toEqual({ plugins: [], errors: null });

    await s.clone.stop();
  });

  it('init に plugins が無ければ控えない（undefined のまま）', async () => {
    const s = setupWith({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(s.clone.pluginLoad?.()).toBeUndefined();

    await s.clone.stop();
  });

  it('セッションを開き直すと消え、次の init が届くまで前の結果を見せない', async () => {
    let releaseSecondInit: () => void = () => undefined;
    const secondInit = new Promise<void>((resolve) => {
      releaseSecondInit = resolve;
    });
    const s = setupWith({
      endSessionAfterTurn: 0,
      initExtras: (callIndex) => ({
        plugins: [{ name: callIndex === 0 ? 'first' : 'second', path: '/p' }],
      }),
      beforeInit: (callIndex) => (callIndex === 0 ? undefined : secondInit),
    });

    s.clone.post(humanMessage('1つ目'));
    await waitFor(() => s.clone.pluginLoad?.() !== undefined, '1本目の結果が控えられること');
    expect(s.clone.pluginLoad?.()?.pluginLoad.plugins).toEqual([{ name: 'first' }]);
    await waitForDone(s.events);

    s.clone.post(humanMessage('2つ目'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.clone.pluginLoad?.()).toBeUndefined();

    releaseSecondInit();
    await waitFor(
      () => s.clone.pluginLoad?.()?.pluginLoad.plugins[0]?.name === 'second',
      '2本目の結果が控えられること',
    );

    await s.clone.stop();
  });
});
