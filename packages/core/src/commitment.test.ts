import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import {
  closedRedeliveryNotice,
  commitmentFor,
  createClone,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  isDaemonSelfNotice,
} from './clone.js';
import { verifyCommitmentEditBeforeContract } from './commitment-edit-before-contract.js';
import { verifyCommitmentEditIfMatchContract } from './commitment-edit-if-match-contract.js';
import { verifyCommitmentRemoveForConversationContract } from './commitment-remove-for-conversation-contract.js';
import { verifyCommitmentAutoCloseMarkContract } from './commitment-auto-close-mark-contract.js';
import { verifyCommitmentFoldContract } from './commitment-fold-contract.js';
import { verifyCommitmentReopenContract } from './commitment-reopen-contract.js';
import { verifyCommitmentTieOrderContract } from './commitment-tie-order-contract.js';
import { verifyStoreIsolationContract } from './store-isolation-contract.js';
import { buildActivityDigest } from './digest.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { buildCloneSystemPrompt } from './prompt.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, Commitment, InboxEvent, Task } from './schema.js';
import { findOpenManagerDuplicate, type Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

function fakeSdk(
  reply: (input: string) => string = () => 'わかった',
  options: { failWith?: string } = {},
) {
  const calls: { options: Options; inputs: string[] }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call = { options: params.options ?? {}, inputs: [] as string[] };
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.failWith !== undefined) throw new Error(options.failWith);

      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = String(message.message.content);
        call.inputs.push(text);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: reply(text) }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: reply(text),
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

interface Setup {
  clone: CloneHost;
  stores: Stores;
  calls: { options: Options; inputs: string[] }[];
  events: ChatStreamEvent[];
}

function setup(
  stores: Stores = createMemoryStores(),
  sdkOptions: { failWith?: string } = {},
  reply?: (input: string) => string,
): Setup {
  const { fn, calls } = fakeSdk(reply, sdkOptions);
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const events: ChatStreamEvent[] = [];
  clone.subscribe('conv-1', (event) => events.push(event));
  return { clone, stores, calls, events };
}

function waitForSettled(events: ChatStreamEvent[]): Promise<void> {
  return waitFor(
    () => events.some((event) => event.type === 'done' || event.type === 'error'),
    '終端（done か error）が来る',
  );
}

function managerMessage(text: string, id = 'evt-mgr'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

// #5469 P5: 台帳へ自動で開くのは人間の合図だけになった。台帳の記帳の観測（載っていない断り・trim・読めない行・記録の欠落）は、
// 開く経路が同じ `#commit` を通る人間の合図で測り続ける（以前は manager_message で測っていた。保証は開く型に依らない）。id と at を指せる
function humanIntake(text: string, id: string, at: string = new Date().toISOString()): InboxEvent {
  return { type: 'human_message', id, at, text, conversationId: 'conv-1' };
}

describe('引き受けたまま終わっていない仕事', () => {
  it('ターンが例外で落ちても Task は残る（失敗した依頼こそ失われてはいけない。台帳へは書かない）', async () => {
    const s = setup(createMemoryStores(), { failWith: 'セッションが起きない' });

    s.clone.post(humanMessage('CI の失敗を直しておいて'));
    await waitForSettled(s.events);

    expect(s.events.some((event) => event.type === 'error')).toBe(true);

    const open = (await s.stores.tasks.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe('CI の失敗を直しておいて');
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toEqual([]);

    await s.clone.stop();
  });

  it('片付けた仕事は、同じ合図が配り直されても開き直らない', async () => {
    const stores = createMemoryStores();
    const event = humanMessage('一度だけやる仕事');

    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toEqual({
      opened: true,
      folded: false,
    });
    await stores.commitments.close(event.id, new Date().toISOString(), '済んだ', 'clone');

    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toEqual({
      opened: false,
      folded: false,
    });

    expect((await stores.commitments.list()).entries).toHaveLength(0);
  });

  it('close は closedBy を記録し、既存の（closedBy の無い）行は undefined のままで既定へ倒れない', async () => {
    const stores = createMemoryStores();

    await stores.commitments.open({
      id: 'c-1',
      at: new Date().toISOString(),
      origin: 'human',
      body: '片付ける',
    });
    await stores.commitments.close('c-1', new Date().toISOString(), '片付けた', 'human');
    expect((await stores.commitments.get('c-1'))?.closedBy).toBe('human');

    await stores.commitments.open({
      id: 'c-legacy',
      at: new Date().toISOString(),
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: new Date().toISOString(),
      closedReason: '当時は書き手を記録していなかった',
    });
    expect((await stores.commitments.get('c-legacy'))?.closedBy).toBeUndefined();
  });

  it("器が自動で閉じた行（closedBy: 'daemon'）が往復する（#5015）", async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c-daemon',
      at: new Date().toISOString(),
      origin: 'manager',
      body: '枠の知らせ',
    });
    expect(
      await stores.commitments.close(
        'c-daemon',
        new Date().toISOString(),
        '器が自動で閉じた',
        'daemon',
      ),
    ).toBe(true);
    const closed = await stores.commitments.get('c-daemon');
    expect(closed?.closedBy).toBe('daemon');
    expect(closed?.closedReason).toBe('器が自動で閉じた');
  });

  it('editBody は未了の行だけ書き換え、片付いた行・無い id は not-edited（他の欄は無傷）', async () => {
    const stores = createMemoryStores();

    await stores.commitments.open({
      id: 'c-1',
      at: '2026-08-12T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: 'もとの依頼',
    });
    expect(
      await stores.commitments.editBody('c-1', '直した依頼', '2026-08-13T00:00:00.000Z', 'human'),
    ).toMatchObject({ kind: 'edited', before: { body: 'もとの依頼' } });
    const edited = await stores.commitments.get('c-1');
    expect(edited?.body).toBe('直した依頼');
    expect(edited?.editedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(edited?.editedBy).toBe('human');
    expect(edited?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(edited?.origin).toBe('human');
    expect(edited?.source).toBe('conv-1');

    await stores.commitments.open({
      id: 'c-closed',
      at: '2026-08-12T00:00:00.000Z',
      origin: 'human',
      body: 'もう片付いた依頼',
    });
    await stores.commitments.close('c-closed', '2026-08-13T00:00:00.000Z', '片付けた', 'human');
    expect(
      await stores.commitments.editBody(
        'c-closed',
        '後から直したい',
        '2026-08-14T00:00:00.000Z',
        'human',
      ),
    ).toEqual({ kind: 'not-edited' });
    const closed = await stores.commitments.get('c-closed');
    expect(closed?.body).toBe('もう片付いた依頼');
    expect(closed?.closedReason).toBe('片付けた');

    expect(
      await stores.commitments.editBody(
        'しらない',
        '直したい',
        '2026-08-14T00:00:00.000Z',
        'human',
      ),
    ).toEqual({ kind: 'not-edited' });
  });

  // 応答や日誌の文面を完全一致で固定しない: 守りたいものと無関係な変更まで赤くするため。台帳の欄と日誌の中身の有無で見る
  describe('findOpenManagerDuplicate（Issue #954 提案3）', () => {
    const hasOpenManagerDuplicate = (entries: readonly Commitment[], entry: Commitment) =>
      findOpenManagerDuplicate(entries, entry) !== undefined;
    const at = '2026-09-14T16:30:00.000Z';
    const candidate: Commitment = {
      id: 'evt-new',
      at,
      origin: 'manager',
      source: 'mgr-1',
      body: '[report] 同じ報告',
    };

    it('同一マネージャー×同一本文×未了の行が在れば true（これが畳む場を作る）', () => {
      const entries: Commitment[] = [
        { id: 'evt-old', at, origin: 'manager', source: 'mgr-1', body: '[report] 同じ報告' },
      ];
      expect(hasOpenManagerDuplicate(entries, candidate)).toBe(true);
    });

    it('⭐ 陰性対照(1) 本文が1文字でも違えば false（畳みすぎない）', () => {
      const entries: Commitment[] = [
        { id: 'evt-old', at, origin: 'manager', source: 'mgr-1', body: '[report] 違う報告' },
      ];
      expect(hasOpenManagerDuplicate(entries, candidate)).toBe(false);
    });

    it('⭐ 陰性対照(2) 同じ本文でも別のマネージャー（source）なら false（畳みすぎない）', () => {
      const entries: Commitment[] = [
        { id: 'evt-old', at, origin: 'manager', source: 'mgr-2', body: '[report] 同じ報告' },
      ];
      expect(hasOpenManagerDuplicate(entries, candidate)).toBe(false);
    });

    it('⭐ 陰性対照(3) 同一マネージャー×同一本文でも既に閉じていれば false（もう一度報告できる）', () => {
      const entries: Commitment[] = [
        {
          id: 'evt-old',
          at,
          origin: 'manager',
          source: 'mgr-1',
          body: '[report] 同じ報告',
          closedAt: '2026-09-14T17:00:00.000Z',
          closedReason: '片付けた',
        },
      ];
      expect(hasOpenManagerDuplicate(entries, candidate)).toBe(false);
    });

    it('⭐ 陰性対照(4) origin が manager でない候補は常に false（人間・外部の同文は畳まない）', () => {
      const humanCandidate: Commitment = {
        id: 'evt-h',
        at,
        origin: 'human',
        source: 'conv-1',
        body: '同じ発言',
      };
      const entries: Commitment[] = [
        { id: 'evt-old', at, origin: 'human', source: 'conv-1', body: '同じ発言' },
      ];
      expect(hasOpenManagerDuplicate(entries, humanCandidate)).toBe(false);
    });

    it('未了が0件なら false', () => {
      expect(hasOpenManagerDuplicate([], candidate)).toBe(false);
    });
  });

  it('isDaemonSelfNotice は external かつ source が2つの定数のどちらかのときだけ真', () => {
    const at = new Date().toISOString();

    expect(DAEMON_TOKEN_POOL_REOPENED_SOURCE).toBe('token-pool');
    expect(DAEMON_RUNNER_REGISTRY_SOURCE).toBe('runner-registry');

    expect(
      isDaemonSelfNotice({
        type: 'external',
        id: 'e1',
        at,
        source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
        payload: {},
      }),
    ).toBe(true);
    expect(
      isDaemonSelfNotice({
        type: 'external',
        id: 'e2',
        at,
        source: DAEMON_RUNNER_REGISTRY_SOURCE,
        payload: {},
      }),
    ).toBe(true);
    expect(
      isDaemonSelfNotice({ type: 'external', id: 'e3', at, source: 'github', payload: {} }),
    ).toBe(false);
    expect(isDaemonSelfNotice(humanMessage('やって'))).toBe(false);
  });

  // #5469 P5: 以前は「デーモン自身の合図（token-pool / runner-registry）だけ台帳を開かず、他の source の external は開く」だった。
  // external は source によらず開かなくなったので、「他の source は開く」側を「どの source も開かない」へ反転した（デーモン自身の合図の2つが開かないことも同じ表に残る）
  it('external は source によらず台帳を開かない（デーモン自身の合図も、他の source も）', () => {
    const at = new Date().toISOString();

    expect(
      commitmentFor({ type: 'external', id: 'e-tp', at, source: 'token-pool', payload: {} }),
    ).toBeNull();
    expect(
      commitmentFor({
        type: 'external',
        id: 'e-rr',
        at,
        source: 'runner-registry',
        payload: { text: '' },
      }),
    ).toBeNull();

    const others: { source: string; payload?: unknown }[] = [
      { source: 'github', payload: { action: 'review_requested' } },
      { source: 'ci', payload: { ok: false } },
      { source: 'mail', payload: 'ただの文章' },
      { source: 'token-pool ' },
      { source: 'Token-Pool' },
      { source: 'token-pool-2' },
      { source: 'runner-registry-old' },
      { source: '' },
    ];
    for (const { source, payload } of others) {
      const event: InboxEvent = { type: 'external', id: `e-${source}`, at, source, payload };
      expect(commitmentFor(event), `source: ${JSON.stringify(source)} は台帳を開かない`).toBeNull();
    }
  });

  // #5469 P5: 以前ここに居た次の6本は、manager_message が台帳に開く（開いたうえで同一マネージャー×同一本文を畳む）ことを Clone 越しに測っていた。
  //   - manager.markup が Commitment.bodyMarkup へ持ち越る
  //   - マネージャーの報告も台帳に載る
  //   - 429 連投の3連投は台帳で1行に畳まれる
  //   - #1041: 同一ストアを共有する2つの Clone の同時 post でも台帳は1行
  //   - 陰性対照: 本文が違えば畳まれない／別のマネージャーなら畳まれない
  // manager_message は台帳に開かなくなり、開く経路も、開いてから畳む経路も Clone に無くなったので、Clone 越しには再現できない。外した理由と、保証が弱まらない理由:
  //   (a) 開かないこと自体は、上の commitmentFor の表と下の「マネージャーの報告は受信箱には届くが台帳は開かない」が測る。
  //   (b) 畳み込みの規則（同一マネージャー×同一本文×未了だけ畳む・本文が違えば畳まない・別マネージャーなら畳まない・閉じた後は畳まない・同時でも1行）は、
  //       台帳ストアの `open` の契約で、この下の describe が回す verifyCommitmentFoldContract（memory）と fs / pg の契約試験が測り続ける。Clone は規則の置き場ではなく呼ぶだけだった。
  //   (c) 受信箱の側の畳み込み（未読1件）は inbox-persistence.test.ts の 429 の再現が測り続ける。
  it('マネージャーからの報告は受信箱（ターン）には届くが、台帳の行にはならない（#5469 P5）', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('PR を出した。レビュー待ち'));
    await waitFor(() => inputs().some((text) => text.includes('レビュー待ち')), 'ターンへ渡る');

    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toEqual([]);

    await s.clone.stop();
  });

  it('external は受信箱には届くが、source によらず台帳は開かない（#5469 P5。以前は予約語ではない source の external は開いた）', async () => {
    const s = setup();
    const at = new Date().toISOString();

    s.clone.post({
      type: 'external',
      id: 'e-tp',
      at,
      source: 'token-pool',
      payload: { text: '枠が開いた' },
    });
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('枠が開いた')),
      'token-pool の合図がターンへ渡る（受信箱には届く）',
    );
    expect((await s.stores.commitments.list()).entries).toHaveLength(0);

    s.clone.post({
      type: 'external',
      id: 'e-webhook',
      at,
      source: 'github',
      payload: { action: 'review_requested' },
    });
    await waitFor(
      () =>
        s.calls.flatMap((call) => call.inputs).some((input) => input.includes('review_requested')),
      'github の合図もターンへ渡る（受信箱には届く）',
    );
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toHaveLength(0);

    await s.clone.stop();
  });

  it('未読のまま残っていた token-pool の合図は、器の再起動で消し込まれる（台帳は開かない。#852 の分岐は通る）', async () => {
    const stores = createMemoryStores();
    const unread: InboxEvent = {
      type: 'external',
      id: 'e-tp-unread',
      at: new Date(0).toISOString(),
      source: 'token-pool',
      payload: { text: '前の器が終えられなかった合図' },
    };
    await stores.inbox.put(unread, new Date(0).toISOString());

    const s = setup(stores);

    await waitFor(
      async () =>
        (await stores.inbox.peekPending()).entries.every((row) => row.event.id !== 'e-tp-unread'),
      '拾い直された token-pool の合図が受信箱から消える',
    );
    expect(
      (s.calls[0]?.inputs ?? []).some((input) => input.includes('前の器が終えられなかった合図')),
    ).toBe(false);
    expect(await stores.commitments.get('e-tp-unread')).toBeNull();
    expect((await stores.commitments.list()).entries).toHaveLength(0);

    await s.clone.stop();
  });

  it('発意 tick では台帳が増えない（起こされたこと自体は引き受けた仕事ではない）', async () => {
    const s = setup();

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-tick',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(() => s.calls.some((call) => call.inputs.length > 0), '発意ターン');

    expect((await s.stores.commitments.list()).entries).toHaveLength(0);

    await s.clone.stop();
  });

  it('ターンの本文に件数と齢が載る（優先度を毎回決め直すための材料）', async () => {
    const s = setup();

    s.clone.post(humanMessage('ひとつめ'));
    await waitForSettled(s.events);

    // #5469 P6c: 台帳の件数・最古・commitment_close・「毎回決め直す」は、待ち行列の件数と先頭・task の積み方・task_list / task_move の案内に替わった。
    // 「いつ数えた材料か」を名乗ること・件数と先頭が毎ターンの入力に載ることは同じ保証として保つ
    const input = s.calls.flatMap((call) => call.inputs).join('\n');
    expect(input).toMatch(/\[system\] 待ち行列（\d{2}:\d{2}:\d{2}Z に数えた材料）/);
    expect(input).toContain(
      '- 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）',
    );
    expect(input).toContain('ひとつめ');
    expect(input).toContain('として積んだ');
    expect(input).toContain('全文は `task_list`。並べ替えは `task_move`。');

    await s.clone.stop();
  });

  it('蒸留のターンには台帳を載せない（畳んでいる最中に新しい仕事を始めさせない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForSettled(s.events);
    const beforeDistill = s.calls.flatMap((call) => call.inputs).length;

    await s.clone.endConversation('conv-1');

    const distillInputs = s.calls.flatMap((call) => call.inputs).slice(beforeDistill);
    expect(distillInputs.length).toBeGreaterThan(0);
    expect(distillInputs.join('\n')).not.toContain('[system] 待ち行列（');
    expect(distillInputs.join('\n')).not.toContain('として積んだ');

    await s.clone.stop();
  });
});

describe('断り書きは、台帳へ書かなくなっても待ち行列の件数から始まる（回帰。#5469 P6c・#5923）', () => {
  it('台帳が読めない回でも、待ち行列の断り書きは出て、台帳に載ったかどうかは言わない', async () => {
    const stores = createMemoryStores();
    const unreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: () => Promise.reject(new Error('台帳が読めない（テスト用）')),
      },
    };
    const s = setup(unreadable);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(humanIntake('台帳が読めない回の依頼', 'evt-1145-1'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('いま届いたこの一件は task `evt-1145-1` として積んだ');
    expect(turn).not.toContain('台帳の行として開いた');
    expect(turn).not.toContain('commitment_open');

    await s.clone.stop();
  });

  it('台帳が読める回の断り書きは、件数から始まる', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(humanIntake('普通の依頼', 'evt-1145-3'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('[system] 待ち行列（');
    expect(turn).toContain('- 待ち行列: 開いている 1 件（');
    expect(turn).toContain('いま届いたこの一件は task `evt-1145-3` として積んだ');
    expect(turn).not.toContain('台帳を読めなかった');

    await s.clone.stop();
  });
});

describe('断り書きは待ち行列の1行になる（#5469 P6c）', () => {
  let tick = 0;
  function makeTask(id: string, over: Partial<Task> = {}): Task {
    tick += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
    return {
      id,
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'self',
      title: `title-${id}`,
      body: `body-${id}`,
      ...over,
    };
  }
  const firstInput = (s: Setup): string => s.calls.flatMap((call) => call.inputs)[0] ?? '';

  it('人間の発言のターン: task として積んだ・返事で自動 done になる・続けるなら task_keep・委譲なら taskId。台帳の閉じ方は出さない', async () => {
    const s = setup();
    s.clone.post(humanIntake('調べておいて', 'evt-p6c-h'));
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    expect(turn).toContain(
      'いま届いたこの一件は task `evt-p6c-h` として積んだ。返事をしたターンの終わりに自動で done になる。' +
        '続けるなら `task_keep`、委譲するなら `manager_start` に `taskId`。',
    );
    expect(turn).not.toContain('commitment_close');
    expect(turn).not.toContain('台帳に載せた');
    expect(turn).not.toContain('台帳の行として開いた');
    expect(turn).not.toContain('旧台帳');
    await s.clone.stop();
  });

  it('回答（human_answer）のターン: 何も開かず、台帳の行が開いたとも閉じ方（commitment_close）も言わない', async () => {
    const s = setup();
    s.clone.post({
      type: 'human_answer',
      id: 'evt-p6c-a',
      at: new Date().toISOString(),
      approvalId: 'apv-p6c',
      answer: 'いいよ',
    });
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    expect(turn).not.toContain('台帳の行として開いた');
    expect(turn).not.toContain('commitment_close');
    expect(turn).not.toContain('として積んだ');
    expect(await s.stores.tasks.get('evt-p6c-a')).toBeNull();
    expect(await s.stores.commitments.get('evt-p6c-a')).toBeNull();
    await s.clone.stop();
  });

  it('待ち行列の件数（状態別）と先頭3件が出る。先頭は list の並びのまま、残りは件数で言う', async () => {
    const stores = createMemoryStores();
    for (const task of [
      makeTask('t1'),
      makeTask('t2', { status: 'waiting' }),
      makeTask('t3'),
      makeTask('t4'),
      makeTask('t5', { status: 'done', closedAt: new Date().toISOString() }),
    ]) {
      await stores.tasks.add(task);
    }
    const s = setup(stores);
    s.clone.post(humanIntake('もう1件', 'evt-p6c-q'));
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    // 開いている 4 件 + いま積んだ 1 件。閉じた t5 は数えない
    expect(turn).toContain(
      '- 待ち行列: 開いている 5 件（queued 4 / waiting 1 / needs_decision 0）',
    );
    // 並びはストアの list のまま（器は並べ直さない）。人間の依頼は先頭に積まれる
    const at = (id: string): number => turn.indexOf(`- ${id}（`);
    expect(at('evt-p6c-q')).toBeGreaterThan(-1);
    expect(at('evt-p6c-q')).toBeLessThan(at('t1'));
    expect(at('t1')).toBeLessThan(at('t2'));
    expect(at('t3')).toBe(-1);
    expect(at('t4')).toBe(-1);
    expect(at('t5')).toBe(-1);
    expect(turn).toContain('…ほか 2 件（task_list で全部見える）');
    await s.clone.stop();
  });

  it('待ち行列を読めなかった回は、0 件と書かず「読めなかった」と名乗る', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        list: () => Promise.reject(new Error('task が読めない（テスト用）')),
      },
    };
    const s = setup(broken);
    s.clone.post(humanIntake('読めない回の依頼', 'evt-p6c-u'));
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    expect(turn).toContain('待ち行列を読めなかった');
    expect(turn).toContain('task が読めない（テスト用）');
    expect(turn).toContain('0 件だったのでも、異常が無かったのでもない');
    expect(turn).not.toContain('- 待ち行列: 開いている');
    // 読めなくても、積んだ事実（add は成功している）は言える
    expect(turn).toContain('として積んだ');
    await s.clone.stop();
  });

  it('旧台帳にだけ開いている行（同じ id の task が無い）の件数が1行出る。人間の依頼は同じ id の task があるので数えない', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'only-ledger',
      at: new Date().toISOString(),
      origin: 'human',
      body: '台帳だけの行',
    });
    const s = setup(stores);
    s.clone.post(humanIntake('普通の依頼', 'evt-p6c-l'));
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    expect(turn).toContain('- 旧台帳に開いている 1 件は未了で、Task に同じ id が無い。');
    await s.clone.stop();
  });

  it('人間の発言を Task に積めなかったときは、1行で断り（task_add で載せ直す）、台帳の行として開いたとは言わない', async () => {
    const stores = createMemoryStores();
    const failing: Stores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        add: () => Promise.reject(new Error('task が積めない（テスト用）')),
      },
    };
    const s = setup(failing);
    s.clone.post(humanIntake('積めない依頼', 'evt-p6c-f'));
    await waitFor(() => firstInput(s) !== '', '合図がターンへ渡る');

    const turn = firstInput(s);
    expect(turn).toContain('Task として積めなかった（id: `evt-p6c-f`）');
    expect(turn).toContain('`task_add` で載せ直すこと');
    expect(turn).not.toContain('台帳の行として開いた');
    expect(turn).not.toContain('`commitment_close`');
    expect(turn).not.toContain('として積んだ');
    await s.clone.stop();
  });
});

describe('未了の見え方', () => {
  it('digest には期間によらず載る（24時間の窓で切ると、放置された依頼だけが落ちる）', async () => {
    const stores = createMemoryStores();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await stores.commitments.open({
      id: 'c-old',
      at: old,
      origin: 'human',
      body: '10 日前に頼まれてまだやっていないこと',
    });

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60 * 60 * 1000),
    });

    // #5469 P6b: 行ごとの本文は出さず、旧台帳の件数の1行だけが残る（窓で切らない保証は件数で保つ）
    expect(digest).toContain('旧台帳に開いている 1 件は未了で、Task に同じ id が無い。');
    expect(digest).not.toContain('10 日前に頼まれてまだやっていないこと');
  });

  it('片付けたものは digest から外れる', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c-1',
      at: new Date().toISOString(),
      origin: 'human',
      body: 'もう済んだ依頼',
    });
    await stores.commitments.close('c-1', new Date().toISOString(), '済んだ', 'clone');

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60 * 60 * 1000),
    });

    // 開いている行が無ければ旧台帳の1行は出ない。片付けた仕事の節（理由の一覧）は #5469 P6b で無くなった
    expect(digest).not.toContain('旧台帳');
    expect(digest).not.toContain('もう済んだ依頼');
    expect(digest).not.toContain('片付いたとした理由');
  });

  it('片付けた仕事は期間によらず digest に並べない（日報が過去に終えた分を毎日並べ直さない）', async () => {
    const stores = createMemoryStores();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await stores.commitments.open({
      id: 'c-old',
      at: old,
      origin: 'human',
      body: '10 日前に片付けた依頼',
    });
    await stores.commitments.close('c-old', old, '10 日前に済んだ', 'clone');

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect(digest).not.toContain('旧台帳');
    expect(digest).not.toContain('10 日前に片付けた依頼');
  });

  it('システムプロンプトが、待ち行列の並びは目安で最後は自分が決める・台帳の書き込みの道具は無いと言っている（器に優先度を持たせない歯止め）', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });

    expect(prompt).not.toContain('commitment_close');
    expect(prompt).not.toContain('commitment_open');
    expect(prompt).toContain('委譲しただけでは閉じない');
    expect(prompt).toContain('最後は毎回あなたが決める');
  });
});

describe('closedRedeliveryNotice（片付け済みの配り直しの断り書き）', () => {
  const BODY_HUMAN = 'これは長い依頼の本文で、二度も全文で焼いてはいけないもの';
  const BODY_MGR = 'これはマネージャーからの長い報告の本文';
  const BODY_ANSWER = '承認待ちへの、他人に見せてよいわけではない回答の本文';

  it('human_message: 全部の条件（配り直し・どの合図か・受け取り時刻・閉じた時刻と理由・取り方）を満たし、本文そのものは載せない', () => {
    const event: InboxEvent = {
      type: 'human_message',
      id: 'e-human',
      at: '2026-08-01T00:00:00.000Z',
      text: BODY_HUMAN,
      conversationId: 'conv-9',
    };
    const commitment: Commitment = {
      id: 'e-human',
      at: event.at,
      origin: 'human',
      source: 'conv-9',
      body: BODY_HUMAN,
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: 'もう対応済みだった',
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('再起動後の配り直しである');
    expect(notice).toContain('human_message');
    expect(notice).toContain(event.at);
    expect(notice).toContain('片付けた時刻');
    expect(notice).toContain(commitment.closedAt);
    expect(notice).toContain('もう対応済みだった');
    expect(notice).toContain('journal_read');
    expect(notice).toContain('conv-9');
    expect(notice).not.toContain(BODY_HUMAN);
  });

  it('manager_message: どの合図かに managerId / kind が入り、全文の取り方は journal_read（本文の先頭パターン付き）', () => {
    const event: InboxEvent = {
      type: 'manager_message',
      id: 'e-mgr',
      at: '2026-08-01T00:00:00.000Z',
      managerId: 'mgr-7',
      kind: 'report',
      text: BODY_MGR,
    };
    const commitment: Commitment = {
      id: 'e-mgr',
      at: event.at,
      origin: 'manager',
      source: 'mgr-7',
      body: `[report] ${BODY_MGR}`,
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: '対応不要と判断した',
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('mgr-7');
    expect(notice).toContain('journal_read');
    expect(notice).toContain('[mgr-7/report]');
    expect(notice).not.toContain(BODY_MGR);
  });

  it('external: どの合図かに source が入り、全文の取り方は journal_read（external_event 型）', () => {
    const event: InboxEvent = {
      type: 'external',
      id: 'e-ext',
      at: '2026-08-01T00:00:00.000Z',
      source: 'github',
      payload: { action: 'closed' },
    };
    const commitment: Commitment = {
      id: 'e-ext',
      at: event.at,
      origin: 'external',
      source: 'github',
      body: 'CI failed',
      closedAt: '2026-08-02T00:00:00.000Z',
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('github');
    expect(notice).toContain('journal_read');
    expect(notice).toContain('external_event');
  });

  it('human_answer: 全文は journal_read ではなく approvals_list（id 付き）— この型は日誌に本文を書かないため', () => {
    const event: InboxEvent = {
      type: 'human_answer',
      id: 'e-answer',
      at: '2026-08-01T00:00:00.000Z',
      approvalId: 'apv-42',
      answer: BODY_ANSWER,
    };
    const commitment: Commitment = {
      id: 'e-answer',
      at: event.at,
      origin: 'human',
      source: 'apv-42',
      body: `承認待ち apv-42 への回答: ${BODY_ANSWER}`,
      closedAt: '2026-08-02T00:00:00.000Z',
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('approvals_list');
    expect(notice).toContain('apv-42');
    expect(notice).not.toContain('journal_read');
    expect(notice).not.toContain(BODY_ANSWER);
  });

  it('closedReason が無くても、「取り方が分からない」形にはならない（他の4条件は満たしたまま）', () => {
    const event: InboxEvent = {
      type: 'manager_message',
      id: 'e-mgr-2',
      at: '2026-08-01T00:00:00.000Z',
      managerId: 'mgr-1',
      kind: 'question',
      text: BODY_MGR,
    };
    const commitment: Commitment = {
      id: 'e-mgr-2',
      at: event.at,
      origin: 'manager',
      source: 'mgr-1',
      body: `[question] ${BODY_MGR}`,
      closedAt: '2026-08-02T00:00:00.000Z',
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('再起動後の配り直しである');
    expect(notice).toContain(commitment.closedAt);
    expect(notice).toContain('journal_read');
    expect(notice).not.toMatch(/全文は省略した。?$/m);
  });
});

describe('closedRedeliveryNotice の closedBy 4状態（人間が閉じた commitment でも「クローンが閉じた」と書かない）', () => {
  const baseEvent: InboxEvent = {
    type: 'manager_message',
    id: 'e-closedby',
    at: '2026-08-01T00:00:00.000Z',
    managerId: 'mgr-9',
    kind: 'report',
    text: 'closedBy の4状態を確かめるための本文',
  };
  const baseCommitment: Commitment = {
    id: 'e-closedby',
    at: baseEvent.at,
    origin: 'manager',
    source: 'mgr-9',
    body: '[report] closedBy の4状態を確かめるための本文',
    closedAt: '2026-08-02T00:00:00.000Z',
  };

  const HUMAN_CLOSING =
    '片付け済みなので、あらためて手を動かす必要は無い。**この判断はあなたが下したものではない**' +
    '（人間が閉じた）ので、心当たりが無くても異常ではない。何が起きたか確かめたいときだけ、' +
    '上の手順で全文を読み直すこと。';
  const NOT_CLONE_CLOSING_TAIL =
    '心当たりが無くても異常ではない。何が起きたか確かめたいときだけ、上の手順で全文を読み直すこと。';

  const cases: readonly {
    name: string;
    closedBy: string | undefined;
    headline: string;
    label: string;
    closing: string;
  }[] = [
    {
      name: 'clone',
      closedBy: 'clone',
      headline: '**これは再起動後の配り直しである。クローンは既にこの合図を片付けている。**',
      label: '片付けた時刻（commitment_close）',
      closing:
        '片付け済みなので、あらためて手を動かす必要は無い。閉じた判断を思い出せず、' +
        '正しかったか確かめたいときだけ、上の手順で全文を読み直すこと。',
    },
    {
      name: 'human',
      closedBy: 'human',
      headline: '**これは再起動後の配り直しである。人間が既にこの合図を片付けている。**',
      label: '片付けた時刻（POST /commitments/:id/close）',
      closing: HUMAN_CLOSING,
    },
    {
      name: 'daemon（器が自動で閉じた。#5015）',
      closedBy: 'daemon',
      headline:
        '**これは再起動後の配り直しである。器（デーモン）が自動で、既にこの合図を片付けている。**',
      label: '片付けた時刻',
      closing:
        '片付け済みなので、あらためて手を動かす必要は無い。**この判断はあなたが下したものではない**' +
        `（器が自動で閉じた。理由は台帳と日誌に在る）ので、${NOT_CLONE_CLOSING_TAIL}`,
    },
    {
      name: '未知（manager）',
      closedBy: 'manager',
      headline:
        '**これは再起動後の配り直しである。この合図は既に片付いている' +
        '（閉じた主体として台帳に未知の値が入っている: 「manager」）。**',
      label: '片付けた時刻',
      closing: `片付け済みなので、あらためて手を動かす必要は無い。**この判断をあなたが下したとは限らない**（閉じた主体が台帳の既知の値ではない）ので、${NOT_CLONE_CLOSING_TAIL}`,
    },
    {
      name: 'undefined（absent）',
      closedBy: undefined,
      headline:
        '**これは再起動後の配り直しである。この合図は既に片付いている' +
        '（誰が閉じたかは台帳に無い ＝ この欄が入る前に閉じられた行である）。**',
      label: '片付けた時刻',
      closing: `片付け済みなので、あらためて手を動かす必要は無い。**この判断をあなたが下したとは限らない**（誰が閉じたかは台帳に残っていない）ので、${NOT_CLONE_CLOSING_TAIL}`,
    },
  ];

  function commitmentWith(closedBy: string | undefined): Commitment {
    return { ...baseCommitment, ...(closedBy === undefined ? {} : { closedBy }) };
  }

  it.each(cases)(
    '$name: 冒頭の断定行・時刻ラベル・末尾の一文が仕様どおり',
    ({ closedBy, headline, label, closing }) => {
      const commitment = commitmentWith(closedBy);
      const notice = closedRedeliveryNotice(baseEvent, commitment);
      expect(notice.split('\n')[0]).toBe(headline);
      expect(notice).toContain(`${label}: ${commitment.closedAt}`);
      expect(notice.trimEnd().endsWith(closing)).toBe(true);
    },
  );

  it('4状態の断り書きは互いに全部違う（畳みの再発を止める）', () => {
    const notices = cases.map(({ closedBy }) =>
      closedRedeliveryNotice(baseEvent, commitmentWith(closedBy)),
    );
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    notices.forEach((notice, index) => {
      const prior = seen.get(notice);
      if (prior !== undefined) collisions.push(`${prior} と ${cases[index]!.name} が同じ文面`);
      else seen.set(notice, cases[index]!.name);
    });
    expect(collisions, collisions.join(' / ') || '衝突なし').toEqual([]);
    expect(new Set(notices).size).toBe(cases.length);
  });

  it('clone 以外の3状態には「クローンが閉じた」という断定が現れない', () => {
    for (const { name, closedBy } of cases.filter((c) => c.name !== 'clone')) {
      const notice = closedRedeliveryNotice(baseEvent, commitmentWith(closedBy));
      expect(notice, `${name}: 「クローンは既に」を含んではいけない`).not.toContain(
        'クローンは既に',
      );
      expect(notice, `${name}: 「commitment_close」を含んではいけない`).not.toContain(
        'commitment_close',
      );
    }
  });

  it('未知の生値（64文字超）は本文に全部載らず、省略の合図が出る', () => {
    const longRaw = 'x'.repeat(100);
    const notice = closedRedeliveryNotice(baseEvent, commitmentWith(longRaw));
    expect(notice).not.toContain(longRaw);
    expect(notice).toMatch(/…（\d[\d,]* 文字省略/);
  });
});

describe('台帳の契約（インメモリ）', () => {
  it('畳み込みの契約（#1041。3実装で同じことを測る。⚠ 名乗れるのはプロセス内で原子であることまで）', async () => {
    const stores = createMemoryStores();
    await verifyCommitmentFoldContract(stores.commitments);
  });

  it('同じ at の未了の並びの契約（#3285。3実装で同じことを測る。入れた順のまま、editBody・close・closeMany の後も）', async () => {
    await verifyCommitmentTieOrderContract(createMemoryStores().commitments);
  });

  it('自動クローズの印の契約（#5164。3実装で同じことを測る）', async () => {
    await verifyCommitmentAutoCloseMarkContract(createMemoryStores().commitments);
  });

  it('開き直しの契約（#5176。3実装で同じことを測る）', async () => {
    await verifyCommitmentReopenContract(createMemoryStores().commitments);
  });

  it('editBody の ifMatch の契約（#3786。3実装で同じことを測る）', async () => {
    await verifyCommitmentEditIfMatchContract(createMemoryStores().commitments);
  });

  it('editBody が返す before の契約（#5251。3実装で同じことを測る。書き換えと同じ排他の中で読んだ行）', async () => {
    await verifyCommitmentEditBeforeContract(createMemoryStores().commitments);
  });

  it('removeForConversation の契約（#4218・#4355。3実装で同じことを測る。human / self かつ source 一致の行だけを未了・片付いたとも物理的に消す）', async () => {
    await verifyCommitmentRemoveForConversationContract(createMemoryStores().commitments);
  });

  it('ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）', async () => {
    await verifyStoreIsolationContract(createMemoryStores());
  });
});
