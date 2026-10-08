import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  createEventSink,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
} from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('usageBlocked（クローンがいま枠で止まっているかを読む窓。Issue #783）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  it('枠に当たっていない間は false', () => {
    const s = setup();
    expect(s.clone.usageBlocked).toBe(false);
  });

  it('枠に当たって保持している間は true になり、解除されたら false へ戻る', async () => {
    let releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
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

    expect(clone.usageBlocked).toBe(false);

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlocked).toBe(true);

    releaseGateOpen = true;
    clone.post(humanMessage('トリガー', 'conv-2'));
    await waitFor(() => !clone.usageBlocked, '枠が解除される');
    expect(clone.usageBlocked).toBe(false);

    await clone.stop();
  });
});

describe('usageBlockedResetsAt / usageBlockedTokenId（止まりの resetsAt といまの鍵。Issue #1223 再発）', () => {
  it('枠に当たっていなければ両方 undefined', () => {
    const s = setup();
    expect(s.clone.usageBlockedResetsAt).toBeUndefined();
    expect(s.clone.usageBlockedTokenId).toBeUndefined();
  });

  it('resetsAt 付きの枠に当たると usageBlockedResetsAt にその値が出る', async () => {
    const resetsAt = Date.now() + 60 * 60 * 1000;
    const { fn } = fakeSdk(undefined, {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlockedResetsAt).toBe(resetsAt);

    await clone.stop();
  });

  it('resetsAt を持たない枠の通知なら usageBlockedResetsAt は undefined（取れないことを0で埋めない）', async () => {
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const { fn } = fakeSdk(undefined, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlockedResetsAt).toBeUndefined();

    await clone.stop();
  });

  it('tokenIdentity を渡した器では、枠に当たっていなくても usageBlockedTokenId が読める（セッションが起きた瞬間の身元）', async () => {
    const { fn } = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 1 }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(clone.usageBlockedTokenId).toBe('tok-a');
    expect(clone.usageBlocked).toBe(false);

    await clone.stop();
  });

  it('tokenIdentity を渡していない器（プールを使わない既定の構成）では usageBlockedTokenId は undefined', () => {
    const s = setup();
    expect(s.clone.usageBlockedTokenId).toBeUndefined();
  });
});

function tokenPoolReopened(text: string): InboxEvent {
  return {
    type: 'external',
    id: `evt-${text}`,
    at: '2026-09-16T01:39:52.172Z',
    source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    payload: { text },
  };
}

describe('usageReleasePending（再開の印がまだ使われずに立っているか。Issue #1051）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  it('枠に当たっていない間は false（印を立てる条件そのものが無い）', () => {
    const s = setup();
    expect(s.clone.usageReleasePending).toBe(false);
  });

  it('🔴 枠で止まっている間、1件目の合図で印が立ち、2件目は何も動かさない', async () => {
    const releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
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

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');

    expect(clone.usageReleasePending).toBe(false);

    clone.post(tokenPoolReopened('1件目'));
    expect(clone.usageReleasePending).toBe(true);

    const before = { blocked: clone.usageBlocked, pending: clone.usageReleasePending };
    clone.post(tokenPoolReopened('2件目'));
    clone.post(tokenPoolReopened('3件目'));
    expect({ blocked: clone.usageBlocked, pending: clone.usageReleasePending }).toEqual(before);

    await clone.stop();
  });

  it('🔴 印は再試行で消費される ⟹ 次の回復はまた配られる（起こし損ねを作らない）', async () => {
    const releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
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

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');

    clone.post(tokenPoolReopened('1件目'));
    expect(clone.usageReleasePending).toBe(true);

    await waitFor(() => !clone.usageReleasePending, '再開の印が消費される');

    expect(clone.usageReleasePending).toBe(false);

    await clone.stop();
  });
});

describe('クローン — 枠が回復した後の返信は、人間の側から観測できるか（症状B）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function setupBareClone(sdkOptions: Parameters<typeof fakeSdk>[1] = {}): {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
  } {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls };
  }

  function subscribeLikeChatEndpoint(clone: CloneHost, conversationId: string): ChatStreamEvent[] {
    const { events, push } = createEventSink();
    const unsubscribe = clone.subscribe(conversationId, (event) => {
      push(event);
      if (event.type === 'done' || event.type === 'error') unsubscribe();
    });
    return events;
  }

  it('(a) 元の接続（done/error で外れる、実物の SSE と同じ聞き手）には、保持していた合図の再試行が成功しても届かない', async () => {
    const { clone, stores, calls } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);
    expect(firstConnection.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    await waitFor(async () => (calls[0]?.inputs.length ?? 0) >= 2, '1本目の再試行が実行される');
    await waitFor(async () => {
      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const outbound = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          entry.conversationId === 'conv-1',
      );
      const retried = outbound.filter(
        (entry) => entry.type === 'exchange' && entry.text === 'わかった',
      );
      const marked = outbound.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.text.startsWith('（このターンは失敗して終わった') &&
          entry.text.includes('わかった'),
      );
      return retried.length === 1 && marked.length === 1;
    }, '再試行が成功した記録が日誌に残る（1本目の本文には失敗の印が付く）');

    expect(firstConnection.some((event) => event.type === 'done')).toBe(false);
    expect(firstConnection.filter(isTerminal)).toHaveLength(1);
    expect(firstConnection.filter((event) => event.type === 'usage_limited')).toHaveLength(1);

    await clone.stop();
  });

  it('(b) 保持していた合図の再試行が成功すると、日誌には with:human / role:outbound / 同じ conversationId の記録が残る', async () => {
    const { clone, stores } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    const isMatchingOutboundExchange = (
      entry: Awaited<ReturnType<Stores['journal']['list']>>[number],
    ): entry is Extract<
      Awaited<ReturnType<Stores['journal']['list']>>[number],
      { type: 'exchange' }
    > =>
      entry.type === 'exchange' &&
      entry.with === 'human' &&
      entry.role === 'outbound' &&
      entry.conversationId === 'conv-1';

    const matchingOutbound = async () =>
      (await stores.journal.list({ types: ['exchange'] })).filter(isMatchingOutboundExchange);

    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);

    const before = await matchingOutbound();

    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    await waitFor(
      async () =>
        (await matchingOutbound()).some(
          (entry) =>
            entry.text === 'わかった' && !before.some((existing) => existing.id === entry.id),
        ),
      '保持していた1本目の再試行の返信（わかった）が日誌に残る',
    );

    const after = await matchingOutbound();
    const newest = after.find(
      (entry) => entry.text === 'わかった' && !before.some((existing) => existing.id === entry.id),
    );
    expect(newest).toBeDefined();
    expect(newest?.text).toBe('わかった');
    expect(newest?.text.startsWith('人間との対話ターンが失敗した')).toBe(false);

    await clone.stop();
  });

  it('人間へ返す1行は、枠で保持しているときだけ「あとで試し直す」と言う', async () => {
    const noticesFor = async (stores: Stores) =>
      (await stores.journal.list({ types: ['exchange'] }))
        .filter(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.conversationId === 'conv-1' &&
            !entry.text.includes('わかった'),
        )
        .map((entry) => (entry.type === 'exchange' ? entry.text : ''));

    const limited = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    });
    limited.clone.post(humanMessage('一件目'));
    await waitFor(async () => (await noticesFor(limited.stores)).length === 1, '枠の1行が残る');
    const limitedNotice = (await noticesFor(limited.stores))[0] ?? '';
    expect(limitedNotice).toContain('利用上限');
    expect(limitedNotice).toContain('試し直');
    expect(limitedNotice).not.toContain(spendLimitMessage);
    await limited.clone.stop();

    const broken = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    broken.clone.post(humanMessage('一件目'));
    await waitFor(
      async () => (await noticesFor(broken.stores)).length === 1,
      '枠でない失敗の1行が残る',
    );
    const brokenNotice = (await noticesFor(broken.stores))[0] ?? '';
    expect(brokenNotice).toContain('返せなかった');
    expect(brokenNotice).not.toContain('試し直');
    expect(brokenNotice).not.toContain('内部で何かが壊れた');
    await broken.clone.stop();
  });
});
