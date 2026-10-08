import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 安全分類器（safeguards）にセッションごと弾かれ続けていることの検知・知らせ・自動の開き直し（#4173 PR-3）の、外から見える結果。
describe('クローン — 安全分類器に弾かれ続けたセッション', () => {
  const REFUSAL_TEXT =
    "Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]";

  type Signal = 'none' | 'refusal' | 'refusal-fell-back';

  async function lines(stores: Stores, who: 'self' | 'human'): Promise<string[]> {
    const rows = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
    return rows.filter((row) => row.with === who && row.role === 'outbound').map((row) => row.text);
  }

  function build(options: { env?: NodeJS.ProcessEnv } = {}) {
    const stores = createMemoryStores();
    // 回数ではなく可変フラグで駆動する: 側道（蒸留）も同じ関数を通り、通し番号だとずれるため
    const state: {
      mode: 'ok' | 'refuse';
      failText: string;
      signal: Signal;
      reply: string;
      sideQueries: number;
    } = {
      mode: 'refuse',
      failText: REFUSAL_TEXT,
      signal: 'none',
      reply: 'わかった',
      sideQueries: 0,
    };
    const sdk = fakeSdk(() => state.reply, {
      resultFor: () =>
        state.mode === 'refuse'
          ? { subtype: 'error_during_execution', text: state.failText, isError: true }
          : { subtype: 'success', text: state.reply },
      beforeAssistant: () =>
        state.signal === 'none'
          ? []
          : [
              {
                type: 'system',
                subtype:
                  state.signal === 'refusal'
                    ? 'model_refusal_no_fallback'
                    : 'model_refusal_fallback',
                original_model: 'claude-opus-5-5',
                api_refusal_category: 'cyber',
                content: 'refused',
                uuid: 'uuid-refusal',
                session_id: 'sess-fake',
              } as never,
            ],
    });
    const queryFn: typeof sdk.fn = (args) => {
      if (typeof args.prompt === 'string') state.sideQueries += 1;
      return sdk.fn(args);
    };
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn,
      env: options.env ?? {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    const refusal = () => {
      if (clone.sessionRefusal === undefined) throw new Error('sessionRefusal が無い');
      return clone.sessionRefusal();
    };
    /** 1件ぶん投げて、そのターンが終わる（error か done が1つ増える）まで待つ。 */
    async function turn(event: InboxEvent): Promise<void> {
      const before = events.filter((e) => e.type === 'error' || e.type === 'done').length;
      clone.post(event);
      await waitFor(
        () => events.filter((e) => e.type === 'error' || e.type === 'done').length > before,
        'ターンが終わること',
      );
    }
    let n = 0;
    const human = (): Promise<void> => turn(humanMessage(`発言${(n += 1)}`));
    return { clone, stores, calls: sdk.calls, events, state, refusal, turn, human };
  }

  const external = (id: string): InboxEvent => ({
    type: 'external',
    id,
    at: '2026-10-08T00:00:00.000Z',
    source: 'ci.main',
    payload: { status: 'failure' },
  });

  it('構造の合図（refusal）が付いたターンの失敗は、失敗文に safeguards が無くても数え、[障害] 行の末尾に印を足す', async () => {
    const s = build();
    s.state.failText = 'something broke';
    s.state.signal = 'refusal';

    await s.human();

    const failure = (await lines(s.stores, 'self')).find((text) =>
      text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX),
    );
    expect(failure).toBeDefined();
    expect(failure).toContain('人間との対話ターンが失敗した:');
    expect(failure).toContain('something broke');
    expect(failure?.endsWith('（safeguards: cyber）')).toBe(true);
    expect(s.refusal()).toMatchObject({
      streak: 1,
      category: 'cyber',
      autoReopen: 'enabled',
    });
    await s.clone.stop();
  });

  it('構造の合図が無くても、失敗文の safeguards flagged（大小無視）で数える。category は Details から拾う', async () => {
    const s = build();
    s.state.failText = 'SAFEGUARDS FLAGGED this session. Details: [bio]';

    await s.human();

    const failure = (await lines(s.stores, 'self')).find((text) =>
      text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX),
    );
    expect(failure?.endsWith('（safeguards: bio）')).toBe(true);
    expect(s.refusal()).toMatchObject({ streak: 1, category: 'bio' });
    await s.clone.stop();
  });

  it('category が読めなければ「不明」と言う', async () => {
    const s = build();
    s.state.failText = 'safeguards flagged this session';

    await s.human();

    const failure = (await lines(s.stores, 'self')).find((text) =>
      text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX),
    );
    expect(failure?.endsWith('（safeguards: 不明）')).toBe(true);
    await s.clone.stop();
  });

  it('答えが返ったターンの本文に safeguards flagged があっても数えない', async () => {
    const s = build();
    s.state.mode = 'ok';
    s.state.reply = 'さっき「safeguards flagged this session」と出ていたが、いまは通っている';

    await s.human();

    expect(s.refusal()).toBeNull();
    expect(
      (await lines(s.stores, 'self')).some((text) => text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX)),
    ).toBe(false);
    await s.clone.stop();
  });

  it('降格して再試行し、答えが返ったターンは、降格の跡を日誌に1行残すが、拒否としては数えない', async () => {
    const s = build();
    s.state.mode = 'ok';
    s.state.signal = 'refusal-fell-back';

    await s.human();

    const decisions = (await lines(s.stores, 'self')).filter((text) =>
      text.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}拒否されて降格した`),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('cyber');
    expect(decisions[0]).toContain('claude-opus-5-5');
    expect(s.refusal()).toBeNull();
    await s.clone.stop();
  });

  it('自動の開き直しを外すと、1回目では知らせず、2回目で人間へ1回だけ知らせ、開き直さない', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'off' } });

    await s.human();
    expect(await lines(s.stores, 'human')).not.toContainEqual(
      expect.stringContaining('安全分類器'),
    );

    await s.human();
    const told = (await lines(s.stores, 'human')).filter((text) => text.includes('安全分類器'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('2 回続けて弾かれている');
    expect(told[0]).toContain('cyber');
    expect(told[0]).toContain('自動の開き直しは外してある');
    expect(told[0]).toContain('alteroid reopen');
    expect(told[0]).toContain('POST /clone/session/reopen');
    const decisions = (await lines(s.stores, 'self')).filter((text) =>
      text.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}別の入力で 2 回続けて安全分類器に弾かれた`),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('cyber');
    expect(decisions[0]).toContain('sess-fake');

    // 3回目以降は数えるだけで、もう知らせない。セッションは開き直していない
    await s.human();
    expect(
      (await lines(s.stores, 'human')).filter((text) => text.includes('安全分類器')),
    ).toHaveLength(1);
    expect(s.calls.filter((call) => call.kind === 'session')).toHaveLength(1);
    expect(s.refusal()).toMatchObject({ streak: 3, autoReopen: 'disabled' });
    await s.clone.stop();
  });

  it('自動が有効なら、2回目で開き直す。次のセッションは resume せず、断りが載り、蒸留しない。人間へ1行', async () => {
    const s = build();
    await s.human();
    expect(s.refusal()?.streak).toBe(1);
    expect((await lines(s.stores, 'human')).some((text) => text.includes('新しく開き直した'))).toBe(
      false,
    );

    await s.human();

    const told = (await lines(s.stores, 'human')).filter((text) =>
      text.includes('新しく開き直した'),
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('2 回続けて弾かれた');
    expect(told[0]).toContain('記録は消えていない');
    expect(told[0]).toContain('生ログは退避した');
    expect(told[0]).toContain('覚えていない');
    expect(await s.stores.sessions.getCloneSessionId()).toBeNull();
    // 連続数は開き直しで 0 に戻る
    expect(s.refusal()).toBeNull();
    const selfLines = await lines(s.stores, 'self');
    expect(
      selfLines.some((text) => text.includes('クローンの自動判定でセッションを開き直すと決めた')),
    ).toBe(true);

    s.state.mode = 'ok';
    await s.human();
    await s.clone.stop();

    const sessions = s.calls.filter((call) => call.kind === 'session');
    expect(sessions).toHaveLength(2);
    expect((sessions[1] as FakeCall).options.resume).toBeUndefined();
    expect((sessions[1] as FakeCall).inputs[0]).toContain('クローンの自動判定（safeguards）');
    expect(s.state.sideQueries).toBe(0);
  });

  it('内部のターンが弾かれたときは、直近の人間の会話へ知らせる', async () => {
    const s = build();
    s.state.mode = 'ok';
    await s.human();
    s.state.mode = 'refuse';

    // 内部のターンの失敗は会話の購読に流れないので、日誌の `[障害]` 行（内部ターン）が増えるのを待つ
    const internalFailures = async (): Promise<number> =>
      (await lines(s.stores, 'self')).filter((text) => text.includes('内部ターンが失敗した'))
        .length;
    s.clone.post(external('e1'));
    await waitFor(async () => (await internalFailures()) >= 1, '1件目の内部ターンが失敗すること');
    s.clone.post(external('e2'));
    await waitFor(async () => (await internalFailures()) >= 2, '2件目の内部ターンが失敗すること');
    await waitFor(
      async () =>
        (await lines(s.stores, 'human')).some((text) => text.includes('新しく開き直した')),
      '人間へ知らせること',
    );

    const told = (await lines(s.stores, 'human')).filter((text) =>
      text.includes('新しく開き直した'),
    );
    expect(told).toHaveLength(1);
    await s.clone.stop();
  });

  it('自動で開き直したセッションが、答えないまま弾かれたら止まる。人間へ1行、もう開き直さず、答えれば解ける', async () => {
    const s = build();
    await s.human();
    await s.human();
    expect(s.refusal()).toBeNull();

    // 開き直した後のセッションが、1度も答えないまま弾かれる（1回目でも止める）
    await s.human();

    const halted = (await lines(s.stores, 'human')).filter((text) =>
      text.includes('自動の開き直しは止めた'),
    );
    expect(halted).toHaveLength(1);
    expect(halted[0]).toContain('alteroid reopen');
    expect(halted[0]).toContain('焼き込み');
    expect(
      (await lines(s.stores, 'self')).some((text) =>
        text.startsWith(
          `${EXCHANGE_KIND_DECISION_PREFIX}自動で開き直したセッションが、1度も答えを返さないまま`,
        ),
      ),
    ).toBe(true);
    expect(s.refusal()).toMatchObject({ streak: 1, autoReopen: 'halted' });

    // 続けて弾かれても開き直さない・知らせ直さない
    await s.human();
    await s.human();
    expect(s.calls.filter((call) => call.kind === 'session')).toHaveLength(2);
    expect(
      (await lines(s.stores, 'human')).filter((text) => text.includes('新しく開き直した')),
    ).toHaveLength(1);
    expect((await lines(s.stores, 'human')).filter((text) => text.includes('止めた'))).toHaveLength(
      1,
    );
    expect(s.refusal()).toMatchObject({ autoReopen: 'halted' });

    // そのセッションが1度答えたら解ける
    s.state.mode = 'ok';
    await s.human();
    expect(s.refusal()).toBeNull();
    await s.clone.stop();
  });

  it('人間が手動で開き直したら、止めは解ける', async () => {
    const s = build();
    await s.human();
    await s.human();
    await s.human();
    expect(s.refusal()?.autoReopen).toBe('halted');

    await s.clone.reopenSession?.({ reason: '手動', distill: false, actor: 'アカウント alice' });

    expect(s.refusal()).toBeNull();
    await s.clone.stop();
  });

  it('答えが返ると連続は 0 に戻り、別々の弾かれは「続けて」ではない', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'off' } });
    await s.human();
    s.state.mode = 'ok';
    await s.human();
    expect(s.refusal()).toBeNull();
    s.state.mode = 'refuse';

    await s.human();

    expect(s.refusal()?.streak).toBe(1);
    expect((await lines(s.stores, 'human')).some((text) => text.includes('安全分類器'))).toBe(
      false,
    );
    await s.clone.stop();
  });

  it('設定の綴りが読めないときは有効として扱い、日誌に「読めない」と残す', async () => {
    const s = build({ env: { ALTEROID_REFUSAL_AUTO_REOPEN: 'maybe' } });
    await s.human();
    await s.human();

    const decision = (await lines(s.stores, 'self')).find((text) =>
      text.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}別の入力で 2 回続けて`),
    );
    expect(decision).toContain('maybe');
    expect(decision).toContain('有効として扱った');
    await s.clone.stop();
  });
});
