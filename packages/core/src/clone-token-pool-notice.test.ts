import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone, DAEMON_TOKEN_POOL_REOPENED_SOURCE } from './clone.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { fakeSdk, setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('🔴 実運用食い違い調査（2026-09-23）: token-pool の「戻った」通知の tokenId', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function tokenPoolNotice(id: string, text: string): InboxEvent {
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
    };
  }

  it('陽性対照（反転済み。Issue #1051 続きの直しで反転——直す前は「古い方が渡る」が真だった）: 古いトークンの「戻った」通知が未処理のまま残っている間に別トークンの通知が届くと、実際にモデルへ渡る本文は新しい方である', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(
      tokenPoolNotice(
        'notice-A',
        '認証トークンが通る状態に戻った（また通るようになった）: 「alteroid-A」（id tok-A）。枠で止まっていた仕事は、ここから再開できる。',
      ),
    );
    await waitFor(() => s.clone.usageBlocked, 'notice-A の初回処理が枠で失敗して保持される');
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-A')) ?? false,
      'notice-A の本文が turn 0 でモデルへ渡る',
    );

    s.clone.post(
      tokenPoolNotice(
        'notice-B',
        '認証トークンが通る状態に戻った（また通るようになった）: 「alteroid-B」（id tok-B）。枠で止まっていた仕事は、ここから再開できる。',
      ),
    );

    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 2,
      'notice-A か notice-B、どちらかの再試行（turn 1）が投げられる',
    );

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]).toContain('alteroid-A');

    // findIndex で「どこかに出てくるか」を見ない: turn 0 の A が常に先頭に居て自明に真になるため、どのターンに何が載ったかを turn 番号で見る
    expect(inputs[1]).toContain('alteroid-B');
    expect(inputs[1]).not.toContain('alteroid-A');

    await s.clone.stop();
  });
});

describe('クローン — token-pool の「戻った」通知は同時に未処理で1件まで（Issue #1051 続き）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function tokenPoolNotice(id: string, text: string): InboxEvent {
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
    };
  }

  it('不変条件: 未処理のまま token-pool 通知が3件連投されても、実際にモデルへ渡るのは常にいちばん新しい1件で、外した古い方は日誌に残ったまま器の未読は増えない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    });

    s.clone.post(tokenPoolNotice('n1', '認証トークンが通る状態に戻った: 「alteroid-tok-1」'));
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-tok-1')) ?? false,
      'turn 0（n1）がモデルへ渡る',
    );

    s.clone.post(tokenPoolNotice('n2', '認証トークンが通る状態に戻った: 「alteroid-tok-2」'));
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 2,
      'turn 1（n2 との合流で誘発された再試行）が走る',
    );
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-tok-2');
    expect((s.calls[0] as FakeCall).inputs[1]).not.toContain('alteroid-tok-1');

    s.clone.post(tokenPoolNotice('n3', '認証トークンが通る状態に戻った: 「alteroid-tok-3」'));
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      'turn 2（n3 との合流で誘発された再試行）が走る',
    );
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[2]).toContain('alteroid-tok-3');
    expect(inputs[2]).not.toContain('alteroid-tok-1');
    expect(inputs[2]).not.toContain('alteroid-tok-2');

    await waitFor(async () => (await s.stores.inbox.pending()).count === 1, '器の未読は1件のまま');
    const pending = await s.stores.inbox.pending();
    expect(pending.count).toBe(1);

    const bodies = await s.stores.journal.list({ types: ['external_event'] });
    const summaries = bodies
      .filter((row): row is Extract<JournalEntry, { type: 'external_event' }> => {
        return row.type === 'external_event';
      })
      .map((row) => row.summary);
    expect(summaries.some((summary) => summary.includes('alteroid-tok-1'))).toBe(true);
    expect(summaries.some((summary) => summary.includes('alteroid-tok-2'))).toBe(true);

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const foldNotes = exchanges.filter(
      (row): row is Extract<JournalEntry, { type: 'exchange' }> =>
        row.type === 'exchange' && row.text.includes('時間の窓ではなく'),
    );
    expect(foldNotes.length).toBe(2);

    await s.clone.stop();
  });

  it('陰性対照1: 未処理の token-pool 通知が無い状態への単発の遷移では、必ずターンが1回起きて保持が解ける（合流する相手が無いので何も変わらない経路）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(tokenPoolNotice('solo', '認証トークンが通る状態に戻った: 「alteroid-solo」'));
    await waitFor(() => s.clone.usageBlocked, 'turn 0 が枠で失敗して保持される');
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(1);

    s.clone.post(humanMessage('起きてる？'));
    await waitFor(() => !s.clone.usageBlocked, '保持が解けて turn 1 が成功し、枠が晴れる');
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      '人間の発言自身のターン（turn 2）も走り切る',
    );
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(3);
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-solo');

    await s.clone.stop();
  });

  it('陰性対照2: 1件目を処理し終えた後に届いた token-pool 通知は、合流せず自分自身のターンを持つ（合流は「未処理の間」に限る）', async () => {
    const s = setup(undefined, createMemoryStores());

    s.clone.post(tokenPoolNotice('done-A', '認証トークンが通る状態に戻った: 「alteroid-done-A」'));
    // waitForDone(s.events) は使わない: external のターンには紐づく会話が無く s.events に何も届かず、永久に解決しないため。s.calls[0].inputs の件数で待つ
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-done-A')) ?? false,
      'done-A が turn 0 でモデルへ渡り、成功する',
    );
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(1);

    s.clone.post(tokenPoolNotice('done-B', '認証トークンが通る状態に戻った: 「alteroid-done-B」'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, 'done-B が自分自身のターンを持つ');
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-done-B');

    await s.clone.stop();
  });

  function clonePausedFirstTurnThatFailsOnQuota() {
    const base = fakeSdk(undefined, {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const fn = ((params: Parameters<typeof sdkQuery>[0]) => {
      const inner = base.fn(params);
      if (!first) return inner;
      first = false;
      async function* held(): AsyncGenerator<SDKMessage, void> {
        let gated = false;
        for await (const message of inner) {
          if (!gated && message.type === 'assistant') {
            gated = true;
            await gate;
          }
          yield message;
        }
      }
      return Object.assign(held(), { close: () => undefined, interrupt: async () => undefined });
    }) as unknown as typeof sdkQuery;
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls: base.calls, release: () => release() };
  }

  it('Issue #2495: 代表 A の処理中に B が届き（A は外せず B が代表になる）、A が枠で失敗しても A は延期の列に積まれず畳まれ、延期が解けて配られるのは B だけである', async () => {
    const s = clonePausedFirstTurnThatFailsOnQuota();

    s.clone.post(tokenPoolNotice('A', '認証トークンが通る状態に戻った: 「tok-A」'));
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('tok-A')) ?? false,
      'A がターンへ渡る（処理中）',
    );
    s.clone.post(tokenPoolNotice('B', '認証トークンが通る状態に戻った: 「tok-B」'));
    s.release();
    await waitFor(() => s.clone.usageBlocked, 'A のターンが枠で失敗して保持される');
    s.clone.post(humanMessage('起きてる？'));
    await waitFor(
      () => s.calls.flatMap((c) => c.inputs).some((text) => text.includes('tok-B')),
      'B がモデルへ渡る',
    );
    await waitFor(() => !s.clone.usageBlocked, '枠が晴れる');

    const inputs = s.calls.flatMap((c) => c.inputs);
    expect(inputs.filter((text) => text.includes('tok-A'))).toHaveLength(1);
    expect(inputs.filter((text) => text.includes('tok-B'))).toHaveLength(1);

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const foldNotes = exchanges.filter(
      (row): row is Extract<JournalEntry, { type: 'exchange' }> =>
        row.type === 'exchange' && row.text.includes('時間の窓ではなく'),
    );
    expect(foldNotes.length).toBe(1);
    expect(foldNotes[0]?.text).toContain('累計 1 件');
    const bodies = await s.stores.journal.list({ types: ['external_event'] });
    expect(
      bodies.some((row) => row.type === 'external_event' && row.summary.includes('tok-A')),
    ).toBe(true);

    await s.clone.stop();
  });

  it('Issue #2495 の陰性対照: 代表 A 自身が枠で失敗した場合（B は来ていない）は、これまでどおり延期の列に積まれ、解除で配り直される', async () => {
    const s = clonePausedFirstTurnThatFailsOnQuota();

    s.clone.post(tokenPoolNotice('A', '認証トークンが通る状態に戻った: 「tok-A」'));
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('tok-A')) ?? false,
      'A がターンへ渡る（処理中）',
    );
    s.release();
    await waitFor(() => s.clone.usageBlocked, 'A のターンが枠で失敗して保持される');
    s.clone.post(humanMessage('起きてる？'));
    await waitFor(() => !s.clone.usageBlocked, '保持が解けて A の再試行が通る');

    const inputs = s.calls.flatMap((c) => c.inputs);
    expect(inputs.filter((text) => text.includes('tok-A'))).toHaveLength(2);
    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    expect(
      exchanges.some((row) => row.type === 'exchange' && row.text.includes('時間の窓ではなく')),
    ).toBe(false);

    await s.clone.stop();
  });

  it('器の入れ替えを跨いでも合図は失われない。拾い直された token-pool 通知は（既存の設計どおり）stale としてターンを起こさずに消えるが、全文は日誌に残り、拾い直し後にいちばん最初に届く新しい通知は自分自身のターンを持つ', async () => {
    const stores = createMemoryStores();
    const alwaysFail = {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    };

    const first = setup(undefined, stores, alwaysFail);
    first.clone.post(tokenPoolNotice('r-A', '認証トークンが通る状態に戻った: 「alteroid-r-A」'));
    await waitFor(
      () => first.calls[0]?.inputs.some((text) => text.includes('alteroid-r-A')) ?? false,
      '1つ目の器: turn 0（r-A）がモデルへ渡る',
    );

    first.clone.post(tokenPoolNotice('r-B', '認証トークンが通る状態に戻った: 「alteroid-r-B」'));
    await waitFor(
      () => (first.calls[0]?.inputs.length ?? 0) >= 2,
      '1つ目の器: turn 1（r-B）がモデルへ渡り、また枠で失敗して保持される',
    );
    expect((first.calls[0] as FakeCall).inputs[1]).toContain('alteroid-r-B');
    await waitFor(
      async () => (await stores.inbox.pending()).count === 1,
      '1つ目の器を閉じる前に、未読が r-B の1件だけになる',
    );

    await first.clone.stop();

    const second = setup(undefined, stores, alwaysFail);

    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['external_event'] });
      return rows.some(
        (row) => row.type === 'external_event' && row.summary.includes('alteroid-r-B'),
      );
    }, 'r-B の全文が日誌（external_event）に残る');

    await waitFor(async () => (await stores.inbox.pending()).count === 0, '器の未読が0件になる');
    expect(second.calls).toHaveLength(0);

    second.clone.post(tokenPoolNotice('r-C', '認証トークンが通る状態に戻った: 「alteroid-r-C」'));
    await waitFor(
      () => second.calls[0]?.inputs.some((text) => text.includes('alteroid-r-C')) ?? false,
      '2つ目の器: r-C が turn 0 でモデルへ渡る',
    );
    await waitFor(() => second.clone.usageBlocked, '2つ目の器: turn 0 も枠で失敗して保持される');

    second.clone.post(tokenPoolNotice('r-D', '認証トークンが通る状態に戻った: 「alteroid-r-D」'));
    await waitFor(
      () => (second.calls[0]?.inputs.length ?? 0) >= 2,
      '2つ目の器: turn 1（r-D との合流で誘発された再試行）が走る',
    );
    const secondInputs = (second.calls[0] as FakeCall).inputs;
    expect(secondInputs[1]).toContain('alteroid-r-D');
    expect(secondInputs[1]).not.toContain('alteroid-r-C');

    await second.clone.stop();
  });
});
