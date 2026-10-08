import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import {
  ALWAYS_REDELIVER,
  closedRedeliveryNotice,
  commitmentFor,
  createClone,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  hasOpenManagerDuplicate,
  isDaemonSelfNotice,
} from './clone.js';
import { verifyCommitmentEditIfMatchContract } from './commitment-edit-if-match-contract.js';
import { verifyCommitmentRemoveForConversationContract } from './commitment-remove-for-conversation-contract.js';
import { verifyCommitmentFoldContract } from './commitment-fold-contract.js';
import { verifyCommitmentTieOrderContract } from './commitment-tie-order-contract.js';
import { verifyStoreIsolationContract } from './store-isolation-contract.js';
import { buildActivityDigest } from './digest.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { buildCloneSystemPrompt } from './prompt.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, Commitment, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { createCloneTools } from './tools.js';

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
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
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

describe('引き受けたまま終わっていない仕事', () => {
  it('人間の依頼は、返事をしただけでは台帳から消えない（着手しなかった依頼が失われない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('リリースノートを書いておいて'));
    await waitForSettled(s.events);

    const open = (await s.stores.commitments.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe('リリースノートを書いておいて');
    expect(open[0]?.origin).toBe('human');

    await s.clone.stop();
  });

  it('ターンが例外で落ちても未了は残る（失敗した依頼こそ失われてはいけない）', async () => {
    const s = setup(createMemoryStores(), { failWith: 'セッションが起きない' });

    s.clone.post(humanMessage('CI の失敗を直しておいて'));
    await waitForSettled(s.events);

    expect(s.events.some((event) => event.type === 'error')).toBe(true);

    const open = (await s.stores.commitments.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe('CI の失敗を直しておいて');

    await s.clone.stop();
  });

  it('閉じるのはクローンの明示的な commitment_close だけである（ターンの終了では閉じない）', async () => {
    const stores = createMemoryStores();
    const s = setup(stores);

    s.clone.post(humanMessage('あとで直しておいて'));
    await waitForSettled(s.events);

    const beforeClose = (await stores.commitments.list()).entries;
    expect(beforeClose).toHaveLength(1);
    const id = beforeClose[0]?.id ?? '';

    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    await close?.handler({ id, reason: '直してマージした' } as never, {} as never);

    expect((await stores.commitments.list()).entries).toHaveLength(0);
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    expect(all).toHaveLength(1);
    expect(all[0]?.closedReason).toBe('直してマージした');
    expect(all[0]?.closedBy).toBe('clone');

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

  it('editBody は未了の行だけ書き換え、片付いた行・無い id は false（他の欄は無傷）', async () => {
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
    ).toBe(true);
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
    ).toBe(false);
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
    ).toBe(false);
  });

  // 応答や日誌の文面を完全一致で固定しない: 守りたいものと無関係な変更まで赤くするため。台帳の欄と日誌の中身の有無で見る
  describe('commitment_edit（クローンが自分の行の本文を直す。issue #580 の (B)）', () => {
    function editor(stores: Stores) {
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const found = tools.find((entry) => entry.name === 'commitment_edit');
      // 道具の有無を先に確かめる: 無いと下の検査が全部「直せなかった」に倒れて緑に見えるため
      expect(found, 'commitment_edit という道具が無い').toBeDefined();
      return async (args: { id: string; body: string }) => {
        const result = await found?.handler(args as never, {} as never);
        return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      };
    }

    async function decisions(stores: Stores) {
      const entries = await stores.journal.list({ types: ['decision'] });
      return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
    }

    it('origin が self の未了の行は直せる（body/editedAt/editedBy が入り、他の欄は無傷）', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-self',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        source: 'conv-1',
        body: 'もとの本文',
      });

      await editor(stores)({ id: 'c-self', body: '直した本文' });

      const edited = await stores.commitments.get('c-self');
      expect(edited?.body).toBe('直した本文');
      expect(edited?.editedAt).not.toBeUndefined();
      expect(edited?.editedBy).toBe('clone');
      expect(edited?.at).toBe('2026-08-12T00:00:00.000Z');
      expect(edited?.origin).toBe('self');
      expect(edited?.source).toBe('conv-1');
      expect(edited?.closedAt).toBeUndefined();
    });

    it('直したとき、編集前と編集後の本文が両方まとめて日誌に載る', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-self',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: 'もとの本文',
      });

      await editor(stores)({ id: 'c-self', body: '直した本文' });

      const texts = await decisions(stores);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('もとの本文');
      expect(texts[0]).toContain('直した本文');
      expect(texts[0]).toContain('c-self');
    });

    it('origin が human / manager の行は直せない（台帳も日誌も動かない）', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-human',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'human',
        body: '人間が頼んだこと',
      });
      await stores.commitments.open({
        id: 'c-manager',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'manager',
        source: 'mgr-1',
        body: '[report] マネージャーの報告',
      });

      const edit = editor(stores);
      await edit({ id: 'c-human', body: '書き換えたい' });
      await edit({ id: 'c-manager', body: '書き換えたい' });

      expect((await stores.commitments.get('c-human'))?.body).toBe('人間が頼んだこと');
      expect((await stores.commitments.get('c-manager'))?.body).toBe('[report] マネージャーの報告');
      expect((await stores.commitments.get('c-human'))?.editedAt).toBeUndefined();
      expect((await stores.commitments.get('c-manager'))?.editedAt).toBeUndefined();
      expect(await decisions(stores)).toEqual([]);
    });

    it('片付いた行・無い id は直せない（台帳も日誌も動かない）', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-closed',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: 'もう片付いた仕事',
      });
      await stores.commitments.close('c-closed', '2026-08-13T00:00:00.000Z', '片付けた', 'clone');

      const edit = editor(stores);
      await edit({ id: 'c-closed', body: '後から直したい' });
      await edit({ id: 'しらない', body: '直したい' });

      const closed = await stores.commitments.get('c-closed');
      expect(closed?.body).toBe('もう片付いた仕事');
      expect(closed?.closedReason).toBe('片付けた');
      expect(closed?.editedAt).toBeUndefined();
      expect(await stores.commitments.get('しらない')).toBeNull();
      expect(await decisions(stores)).toEqual([]);
    });
  });

  describe('commitment_close（クローンが自分で片付けたことを日誌に残す。issue #585）', () => {
    function closer(stores: Stores) {
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const found = tools.find((entry) => entry.name === 'commitment_close');
      expect(found, 'commitment_close という道具が無い').toBeDefined();
      return async (args: { id: string; reason: string }) => {
        const result = await found?.handler(args as never, {} as never);
        return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      };
    }

    function journalReader(stores: Stores) {
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const found = tools.find((entry) => entry.name === 'journal_read');
      expect(found, 'journal_read という道具が無い').toBeDefined();
      return async (args: Record<string, unknown>) => {
        const result = await found?.handler(args as never, {} as never);
        return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      };
    }

    async function decisions(stores: Stores) {
      const entries = await stores.journal.list({ types: ['decision'] });
      return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
    }

    it('片付けたとき、id と reason を含む decision が日誌に1本残る', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-close-1',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: '片付ける仕事',
      });

      await closer(stores)({ id: 'c-close-1', reason: 'やり終えたので閉じた' });

      const texts = await decisions(stores);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('c-close-1');
      expect(texts[0]).toContain('やり終えたので閉じた');
    });

    it('その記録は journal_read から読める（issue #585 の終了条件そのもの）', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-close-2',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: '片付ける仕事その2',
      });

      await closer(stores)({ id: 'c-close-2', reason: '対応済みにした' });

      const reply = await journalReader(stores)({ types: ['decision'] });
      expect(reply).toContain('c-close-2');
      expect(reply).toContain('対応済みにした');
    });

    it('「自分で片付けた」と読める――人間側の記録（人間が…）とは取り違えない', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-close-3',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: '片付ける仕事その3',
      });

      await closer(stores)({ id: 'c-close-3', reason: '確認して閉じた' });

      const texts = await decisions(stores);
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toContain('人間が');
    });

    it('既に片付いている行を閉じようとしても、日誌は増えない', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-close-4',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: 'もう片付いた仕事',
      });
      await stores.commitments.close(
        'c-close-4',
        '2026-08-13T00:00:00.000Z',
        '先に閉じた',
        'human',
      );

      await closer(stores)({ id: 'c-close-4', reason: '後からもう一度閉じようとした' });

      expect(await decisions(stores)).toEqual([]);
    });

    it('close の戻り値が false のとき（get の後に別経路が先に閉じた形）、閉じていないのに「閉じた」と日誌へ書かない', async () => {
      const stores = createMemoryStores();
      await stores.commitments.open({
        id: 'c-race',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'self',
        body: '競合するかもしれない仕事',
      });
      const raced: Stores = {
        ...stores,
        commitments: {
          ...stores.commitments,
          close: () => Promise.resolve(false),
        },
      };

      await closer(raced)({ id: 'c-race', reason: '閉じたつもりだった' });

      expect(await decisions(raced)).toEqual([]);
    });
  });

  it('渡されたものは起点を問わず載り、起こされただけの合図は載らない', async () => {
    const at = new Date().toISOString();

    expect(commitmentFor(humanMessage('やって'))?.origin).toBe('human');
    expect(commitmentFor(managerMessage('終わった'))?.origin).toBe('manager');
    expect(
      commitmentFor({ type: 'external', id: 'e1', at, source: 'github', payload: 'CI failed' })
        ?.origin,
    ).toBe('external');
    expect(
      commitmentFor({ type: 'human_answer', id: 'e2', at, approvalId: 'ap-1', answer: 'いいよ' })
        ?.origin,
    ).toBe('human');

    expect(commitmentFor({ type: 'timer', id: 'e3', at, kind: 'daily_report' })).toBeNull();
    expect(commitmentFor({ type: 'self_initiative', id: 'e4', at, reason: 'tick' })).toBeNull();
    expect(commitmentFor({ type: 'distill', id: 'e5', at, reason: 'conversation_end' })).toBeNull();
  });

  describe('hasOpenManagerDuplicate（Issue #954 提案3）', () => {
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

  it('external は source がデーモン自身の合図（token-pool / runner-registry）のときだけ台帳を開かない', () => {
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
      const entry = commitmentFor(event);
      expect(entry, `source: ${JSON.stringify(source)} は台帳を開くはず`).not.toBeNull();
      expect(entry?.origin).toBe('external');
      expect(entry?.source).toBe(source);
    }
  });

  it('manager_message.markup は Commitment.bodyMarkup へそのまま持ち越る', () => {
    const at = new Date().toISOString();

    const withMarkup = commitmentFor({
      type: 'manager_message',
      id: 'evt-mgr-marked',
      at,
      managerId: 'mgr-1',
      kind: 'report',
      text: '*思いつきで* 止めた',
      markup: 'none',
    });
    expect(withMarkup?.bodyMarkup).toBe('none');

    const withoutMarkup = commitmentFor(managerMessage('終わった'));
    expect(withoutMarkup?.bodyMarkup).toBeUndefined();
  });

  it('マネージャーからの報告も台帳に載る（受け取っただけでは始末がついていない）', async () => {
    const s = setup();

    s.clone.post(managerMessage('PR を出した。レビュー待ち'));
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length > 0,
      'マネージャーの記帳',
    );

    const open = (await s.stores.commitments.list()).entries;
    expect(open[0]?.origin).toBe('manager');
    expect(open[0]?.source).toBe('mgr-1');

    await s.clone.stop();
  });

  it('429 連投の再現: 同一マネージャー×同一本文の3連投は台帳で1行に畳まれる', async () => {
    const s = setup();
    const body = "You've hit your session limit · resets 5:10pm (UTC)";
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage(body, 'evt-429-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    s.clone.post(managerMessage(body, 'evt-429-2'));
    await waitFor(() => inputs().length >= 2, '2件目がターンへ渡る');

    s.clone.post(managerMessage(body, 'evt-429-3'));
    await waitFor(() => inputs().length >= 3, '3件目がターンへ渡る');

    expect((await s.stores.inbox.peekPending()).entries).toHaveLength(0);

    const open = (await s.stores.commitments.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.origin).toBe('manager');
    expect(open[0]?.source).toBe('mgr-1');
    expect(open[0]?.body).toContain(body);
    expect(open[0]?.id).toBe('evt-429-1');

    await s.clone.stop();
  });

  it('⭐ Issue #1041: 同一ストアを共有する2つの Clone インスタンスが同時に post しても、台帳は1行のままである', async () => {
    const stores = createMemoryStores();
    const body = "You've hit your session limit · resets 5:10pm (UTC)";

    const a = setup(stores);
    const b = setup(stores);

    // await を挟まない: 同じ同期区間から2つの #commit を起こさないと、重複確認が互いの書き込みより先に走る窓ができないため
    a.clone.post(managerMessage(body, 'evt-1041-a'));
    b.clone.post(managerMessage(body, 'evt-1041-b'));

    // 固定の待ち（setTimeout）を使わない: 時間で揺れると、赤くなったときに本物か揺れかが分からなくなるため。台帳の件数を条件にしない: 競合が直ると成立しない、または1件目で抜けて2件目の決着を見ないため
    await waitFor(
      () => a.calls.length > 0 && b.calls.length > 0,
      '2つのインスタンスのターンが両方とも入力を読むこと',
    );

    const open = (await stores.commitments.list()).entries;

    expect(open).toHaveLength(1);

    await a.clone.stop();
    await b.clone.stop();
  });

  it('⭐ 陰性対照: 同じマネージャーでも本文が違えば畳まれない（2行とも残る）', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('1件目の報告', 'evt-diff-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    s.clone.post(managerMessage('2件目の別の報告', 'evt-diff-2'));
    await waitFor(() => inputs().length >= 2, '2件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 2,
      '2件目の記帳（畳まれず別行として載る）',
    );

    const bodies = (await s.stores.commitments.list()).entries.map((entry) => entry.body).sort();
    expect(bodies).toEqual(['[report] 1件目の報告', '[report] 2件目の別の報告']);

    await s.clone.stop();
  });

  it('⭐ 陰性対照: 同じ本文でも別のマネージャーなら畳まれない（2行とも残る）', async () => {
    const s = setup();
    const at = new Date().toISOString();
    const sameText = (managerId: string, id: string): InboxEvent => ({
      type: 'manager_message',
      id,
      at,
      managerId,
      kind: 'report',
      text: '同じ文言の報告',
    });
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(sameText('mgr-a', 'evt-mgr-a'));
    await waitFor(() => inputs().length >= 1, 'mgr-a の報告がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      'mgr-a の記帳',
    );

    s.clone.post(sameText('mgr-b', 'evt-mgr-b'));
    await waitFor(() => inputs().length >= 2, 'mgr-b の報告がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 2,
      'mgr-b の記帳（畳まれず別行として載る）',
    );

    const sources = (await s.stores.commitments.list()).entries.map((entry) => entry.source).sort();
    expect(sources).toEqual(['mgr-a', 'mgr-b']);

    await s.clone.stop();
  });

  it('⭐ 陰性対照: 同文でも origin が human なら畳まれない（人間の連投は別扱い）', async () => {
    const s = setup();

    s.clone.post(humanMessage('同じ一言'));
    await waitForSettled(s.events);
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目（人間）の記帳',
    );

    s.clone.post({
      type: 'human_message',
      id: 'evt-同じ一言-2',
      at: new Date().toISOString(),
      text: '同じ一言',
      conversationId: 'conv-1',
    });
    await waitForSettled(s.events);

    const open = (await s.stores.commitments.list()).entries;
    expect(open).toHaveLength(2);
    expect(open.every((entry) => entry.origin === 'human')).toBe(true);

    await s.clone.stop();
  });

  it('閉じたあとの同文は畳まれない——もう一度報告できる', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('繰り返す報告', 'evt-repeat-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    s.clone.post(managerMessage('繰り返す報告', 'evt-repeat-2'));
    await waitFor(() => inputs().length >= 2, '2件目がターンへ渡る');
    expect((await s.stores.commitments.list()).entries).toHaveLength(1);

    await s.stores.commitments.close('evt-repeat-1', new Date().toISOString(), '対応した', 'clone');
    expect((await s.stores.commitments.list()).entries).toHaveLength(0);

    s.clone.post(managerMessage('繰り返す報告', 'evt-repeat-3'));
    await waitFor(() => inputs().length >= 3, '3件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '3件目の記帳（閉じた後なので新しい未了として載る）',
    );

    const open = (await s.stores.commitments.list()).entries;
    expect(open[0]?.id).toBe('evt-repeat-3');

    await s.clone.stop();
  });

  it('台帳の読み（list()）が壊れていても、記帳は通り、畳み込みも効く（#1041 で意味が変わった歯）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: () => Promise.reject(new Error('台帳が読めない（実測を模す）')),
      },
    };
    const s = setup(broken);

    s.clone.post(managerMessage('list が壊れていても届く報告', 'evt-list-broken'));
    await waitFor(
      async () => (await broken.commitments.get('evt-list-broken')) !== null,
      '`list()` が壊れていても未了として開かれる',
    );

    const entry = await broken.commitments.get('evt-list-broken');
    expect(entry?.origin).toBe('manager');
    expect(entry?.body).toContain('list が壊れていても届く報告');

    // 別のインスタンスから同文を打つ: 同一インスタンスでは受信箱側の壁が先に畳むため
    const other = setup(broken);
    other.clone.post(managerMessage('list が壊れていても届く報告', 'evt-list-broken-2'));
    await waitFor(() => other.calls.length > 0, '2つ目のインスタンスのターンが入力を読むこと');
    expect(await broken.commitments.get('evt-list-broken-2')).toBeNull();

    await s.clone.stop();
    await other.clone.stop();
  });

  it('token-pool の external は受信箱には届くが台帳は開かない。他の source の external は開く', async () => {
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
      async () => (await s.stores.commitments.list()).entries.length > 0,
      '予約語ではない external の記帳',
    );

    const open = (await s.stores.commitments.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.origin).toBe('external');
    expect(open[0]?.source).toBe('github');
    expect(open[0]?.body).toContain('review_requested');

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

    const input = s.calls.flatMap((call) => call.inputs).join('\n');
    expect(input).toContain('引き受けたまま終わっていない仕事は（');
    expect(input).toContain('**1 件** ある');
    expect(input).toMatch(/引き受けたまま終わっていない仕事は（\d{2}:\d{2}:\d{2}Z に数えた材料）/);
    expect(input).toContain('commitment_close');
    expect(input).toContain('毎回決め直すこと');

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
    expect(distillInputs.join('\n')).not.toContain('引き受けたまま終わっていない仕事は');

    await s.clone.stop();
  });

  it('台帳が読めなくてもターンは進む（記録できないことで応答を止めない）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: () => Promise.reject(new Error('台帳が読めない')),
      },
    };
    const s = setup(broken);

    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      await waitForSettled(s.events);
    });

    expect(s.events.some((event) => event.type === 'done')).toBe(true);
    expect(lines.join('')).toContain('未了の読み出し');

    await s.clone.stop();
  });

  it('記帳が落ちても post は落ちない（跡は stderr に残る。本文は出さない）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        open: () => Promise.reject(new Error('台帳へ書けない')),
      },
    };
    const s = setup(broken);

    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage('秘密を含むかもしれない依頼'));
      await waitForSettled(s.events);
    });

    expect(s.events.some((event) => event.type === 'done')).toBe(true);
    const stderr = lines.join('');
    expect(stderr).toContain('未了の記帳');
    expect(stderr).not.toContain('秘密を含むかもしれない依頼');

    await s.clone.stop();
  });
});

describe('Issue #856: 台帳に載らなかった合図の観測', () => {
  it('記帳（open）自体が失敗すると、断り書きが名指しで断り、日誌にも跡が残る', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        open: (entry) =>
          entry.id === 'evt-open-fail'
            ? Promise.reject(new Error('書き込みが落ちた（実測を模す）'))
            : stores.commitments.open(entry),
      },
    };
    const s = setup(broken);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    const lines = await captureStderr(async () => {
      s.clone.post(managerMessage('落ちる報告', 'evt-open-fail'));
      await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');
    });

    expect(await broken.commitments.get('evt-open-fail')).toBeNull();
    expect(lines.join('')).toContain('未了の記帳');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('台帳に載っていない');
    expect(turn).toContain('evt-open-fail');
    expect(turn).toContain('載せ直しが要る');

    await waitFor(async () => {
      const rows = await stores.journal.list();
      return rows.some(
        (row) => row.type === 'exchange' && row.text.includes('未了の記帳に失敗した'),
      );
    }, '日誌に失敗の跡が残る');
    const rows = await stores.journal.list();
    const failureRow = rows.find(
      (row) => row.type === 'exchange' && row.text.includes('未了の記帳に失敗した'),
    );
    expect(failureRow?.type).toBe('exchange');
    const failureText = failureRow?.type === 'exchange' ? failureRow.text : '';
    expect(failureText).toContain('evt-open-fail');

    await s.clone.stop();
  });

  it('open() は成功したのに、直後の読み直しでは見当たらない場合も断る（#856 本体の症状の形）', async () => {
    const stores = createMemoryStores();
    const ghosted = new Set(['evt-ghost']);
    const broken: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: async (options) => {
          const result = await stores.commitments.list(options);
          return { ...result, entries: result.entries.filter((entry) => !ghosted.has(entry.id)) };
        },
      },
    };
    const s = setup(broken);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('幽霊になる報告', 'evt-ghost'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    expect(await stores.commitments.get('evt-ghost')).not.toBeNull();

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('台帳に載っていない');
    expect(turn).toContain('evt-ghost');
    expect(turn).toContain('載せ直しが要る');

    await s.clone.stop();
  });

  it('⭐ 陰性対照: 畳んだ（#954/#1035 の重複）は「台帳に載っていない」と断らない', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);
    const body = '同じ報告（畳む対象）';

    s.clone.post(managerMessage(body, 'evt-fold-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    s.clone.post(managerMessage(body, 'evt-fold-2'));
    await waitFor(() => inputs().length >= 2, '2件目がターンへ渡る');

    expect((await s.stores.commitments.list()).entries).toHaveLength(1);

    const secondTurn = inputs()[1] ?? '';
    expect(secondTurn).not.toContain('台帳に載っていない');
    expect(secondTurn).not.toContain('載せ直しが要る');

    await s.clone.stop();
  });

  it('⭐ 陰性対照2: 片付けた後に同じ id が配り直されても「台帳に載っていない」と断らない（open() の冪等性）', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('片付ける報告', 'evt-redeliver-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    await s.stores.commitments.close(
      'evt-redeliver-1',
      new Date().toISOString(),
      '対応した',
      'clone',
    );
    expect((await s.stores.commitments.list()).entries).toHaveLength(0);

    s.clone.post(managerMessage('片付ける報告', 'evt-redeliver-1'));
    await waitFor(() => inputs().length >= 2, '配り直された2件目がターンへ渡る');

    expect((await s.stores.commitments.list()).entries).toHaveLength(0);

    const secondTurn = inputs()[1] ?? '';
    expect(secondTurn).not.toContain('台帳に載っていない');
    expect(secondTurn).not.toContain('載せ直しが要る');

    await s.clone.stop();
  });

  it('⭐ 陰性対照3: 配達より先に（commitment_close_many 相当で）閉じられていても「台帳に載っていない」と断らない（Issue #1088 / #1110）', async () => {
    const stores = createMemoryStores();
    const targetId = 'evt-closed-before-notice';
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        open: async (entry) => {
          const result = await stores.commitments.open(entry);
          if (entry.id === targetId) {
            await stores.commitments.close(
              entry.id,
              new Date().toISOString(),
              'commitment_close_many 相当で配達より先に片付けた',
              'clone',
            );
          }
          return result;
        },
      },
    };
    const s = setup(wrapped);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('配達より先に閉じられる報告', targetId));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const closedRow = await stores.commitments.get(targetId);
    expect(closedRow?.closedAt).toBeDefined();

    const turn = inputs()[0] ?? '';
    expect(turn).not.toContain('台帳に載っていない');
    expect(turn).not.toContain('載せ直しが要る');

    await s.clone.stop();
  });

  it('⭐ 陰性対照4: entries から消えても list.unreadable に同じ id が在れば「台帳に載っていない」と断らない（Issue #1186）', async () => {
    const stores = createMemoryStores();
    const targetId = 'evt-unreadable';
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: async (options) => {
          const result = await stores.commitments.list(options);
          const target = result.entries.find((entry) => entry.id === targetId);
          if (target === undefined) return result;
          return {
            ...result,
            entries: result.entries.filter((entry) => entry.id !== targetId),
            unreadable: [
              ...result.unreadable,
              { id: target.id, at: target.at, reason: '読めなくなった（実測を模す）' },
            ],
          };
        },
      },
    };
    const s = setup(wrapped);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('読めなくなる報告', targetId));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).not.toContain('台帳に載っていない');
    expect(turn).not.toContain('載せ直しが要る');
    expect(turn).toContain('読めない行が');

    await s.clone.stop();
  });
});

function managerMessageAt(text: string, id: string, at: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at,
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

function withTrimmedView(
  stores: Stores,
  targetId: string,
  options: { trimmedClosed: number; remainingClosedAt?: string },
): Stores {
  return {
    ...stores,
    commitments: {
      ...stores.commitments,
      list: async (listOptions) => {
        const result = await stores.commitments.list(listOptions);
        const entries = result.entries.filter((entry) => entry.id !== targetId);
        if (options.remainingClosedAt !== undefined) {
          entries.push({
            id: 'evt-remaining-closed',
            at: options.remainingClosedAt,
            origin: 'human',
            body: '残っている片付いた行（trim で消されなかった側）',
            closedAt: options.remainingClosedAt,
            closedReason: '片付けた',
          });
        }
        return { entries, unreadable: result.unreadable, trimmedClosed: options.trimmedClosed };
      },
    },
  };
}

describe('Issue #1148: trim による物理削除と本当の欠落を区別する', () => {
  it(
    '⭐ trimmedClosed > 0 でも、event.at が残存最古 closedAt より新しければ、' +
      'これまでどおり断定する（#856 受け入れ基準2を守る）',
    async () => {
      const stores = createMemoryStores();
      const targetId = 'evt-1148-newer-than-trim';
      const wrapped = withTrimmedView(stores, targetId, {
        trimmedClosed: 3,
        remainingClosedAt: '2020-01-02T00:00:00.000Z',
      });
      const s = setup(wrapped);
      const inputs = () => s.calls.flatMap((call) => call.inputs);

      s.clone.post(managerMessageAt('trim より新しい報告', targetId, new Date().toISOString()));
      await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

      const turn = inputs()[0] ?? '';
      expect(turn).toContain('台帳に載っていない');
      expect(turn).toContain(targetId);
      expect(turn).toContain('載せ直しが要る');
      expect(turn).toContain('commitment_open');

      await s.clone.stop();
    },
  );

  it(
    '⭐ trimmedClosed > 0 で event.at が残存最古 closedAt より古ければ、' +
      '断定せず第3の状態を名乗る（`載せ直しが要る` と `commitment_open` は出ない）',
    async () => {
      const stores = createMemoryStores();
      const targetId = 'evt-1148-older-than-trim';
      const wrapped = withTrimmedView(stores, targetId, {
        trimmedClosed: 3,
        remainingClosedAt: '2020-01-02T00:00:00.000Z',
      });
      const s = setup(wrapped);
      const inputs = () => s.calls.flatMap((call) => call.inputs);

      s.clone.post(managerMessageAt('trim より古い報告', targetId, '2019-01-01T00:00:00.000Z'));
      await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

      const turn = inputs()[0] ?? '';
      expect(turn).not.toContain('載せ直しが要る');
      expect(turn).not.toContain('commitment_open');
      expect(turn).toContain(targetId);
      expect(turn).toContain('区別できない');

      await s.clone.stop();
    },
  );

  it('⭐ trimmedClosed === 0 なら、これまでどおり断定する（既存の挙動は変わっていない）', async () => {
    const stores = createMemoryStores();
    const targetId = 'evt-1148-no-trim';
    const wrapped = withTrimmedView(stores, targetId, { trimmedClosed: 0 });
    const s = setup(wrapped);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessageAt('trim していない台帳の報告', targetId, new Date().toISOString()));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('台帳に載っていない');
    expect(turn).toContain(targetId);
    expect(turn).toContain('載せ直しが要る');

    await s.clone.stop();
  });
});

describe('Issue #1060 段1: 受信箱から自動で台帳を開いた id を、機械が日誌へ残す', () => {
  it('`journal.list({ q: id })` でその id を含む行が引ける（`append` が呼ばれた、だけでは測らない）', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('段1で記録される報告', 'evt-1060-recorded'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '台帳に開く',
    );

    await waitFor(async () => {
      const rows = await s.stores.journal.list({ q: 'evt-1060-recorded' });
      return rows.length > 0;
    }, '機械が名乗った記録が q で引ける');

    const rows = await s.stores.journal.list({ q: 'evt-1060-recorded' });
    const recorded = rows.find(
      (row) => row.type === 'exchange' && row.with === 'self' && row.role === 'outbound',
    );
    expect(recorded).toBeDefined();
    expect(recorded?.type === 'exchange' ? recorded.text : '').toContain(
      '台帳に開いた（id: evt-1060-recorded）',
    );

    await s.clone.stop();
  });

  it('量の上限は「台帳に開いた行1本につき日誌1行」——畳んだ（folded）id は記録が増えない', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);
    const body = '同じ報告（畳む対象、#1060用）';

    s.clone.post(managerMessage(body, 'evt-1060-fold-1'));
    await waitFor(() => inputs().length >= 1, '1件目がターンへ渡る');
    await waitFor(
      async () => (await s.stores.commitments.list()).entries.length === 1,
      '1件目の記帳',
    );

    s.clone.post(managerMessage(body, 'evt-1060-fold-2'));
    await waitFor(() => inputs().length >= 2, '2件目がターンへ渡る（畳まれる）');

    expect((await s.stores.commitments.list()).entries).toHaveLength(1);

    const openedRows = await s.stores.journal.list({ q: 'evt-1060-fold-1' });
    expect(
      openedRows.some((row) => row.type === 'exchange' && row.text.includes('台帳に開いた')),
    ).toBe(true);

    const foldedRows = await s.stores.journal.list({ q: 'evt-1060-fold-2' });
    expect(
      foldedRows.some((row) => row.type === 'exchange' && row.text.includes('台帳に開いた')),
    ).toBe(false);

    await s.clone.stop();
  });
});

describe('Issue #1060 段2: 記録そのものが落ちたことを黙らせない', () => {
  it('journal.append が失敗しても、ターンは落ちない（`unrecorded` が post を落とさない）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('日誌が書けない（テスト用）')),
      },
    };
    // managerMessage を使わない: 内部ターンは events 購読へ終端を出さず、waitForSettled で測れないため
    const s = setup(broken);

    s.clone.post(humanMessage('記録が落ちる報告'));
    await waitForSettled(s.events);

    expect(s.events.some((event) => event.type === 'done')).toBe(true);
    expect(s.events.some((event) => event.type === 'error')).toBe(false);

    await s.clone.stop();
  });

  it('断り書きに「機械が名乗った記録を日誌に残せなかった」の1行が出る（`missing` とは別の断り）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('日誌が書けない（テスト用）')),
      },
    };
    const s = setup(broken);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('記録が落ちる報告', 'evt-1060-unrecorded-2'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    expect(await stores.commitments.get('evt-1060-unrecorded-2')).not.toBeNull();

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('機械が名乗った記録を');
    expect(turn).toContain('日誌に残せなかった');
    expect(turn).toContain('evt-1060-unrecorded-2');
    expect(turn).not.toContain('台帳に載っていない');

    await s.clone.stop();
  });
});

describe('Issue #1145: 台帳を読めなかった回に、断り書きが丸ごと消えない', () => {
  function withUnreadableList(stores: Stores, reason = '台帳が読めない（テスト用）'): Stores {
    return {
      ...stores,
      commitments: {
        ...stores.commitments,
        list: () => Promise.reject(new Error(reason)),
      },
    };
  }

  it('「台帳を読めなかった」と名乗る —— 無言にも、0 件にもならない', async () => {
    const stores = createMemoryStores();
    const s = setup(withUnreadableList(stores));
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('台帳が読めない回の報告', 'evt-1145-1'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('台帳を読めなかった');
    expect(turn).toContain('判定できていない');
    expect(turn).not.toContain('引き受けたまま終わっていない仕事は');

    await s.clone.stop();
  });

  it('台帳が読めない回でも、`unrecorded`（記録を残せなかった）の断りは生き残る', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...withUnreadableList(stores),
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('日誌が書けない（テスト用）')),
      },
    };
    const s = setup(broken);
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('記録も台帳の再読も落ちる報告', 'evt-1145-2'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    expect(await stores.commitments.get('evt-1145-2')).not.toBeNull();

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('機械が名乗った記録を');
    expect(turn).toContain('日誌に残せなかった');
    expect(turn).toContain('evt-1145-2');
    expect(turn).toContain('台帳を読めなかった');

    await s.clone.stop();
  });

  it('台帳が読める回の断り書きは、これまでどおり件数から始まる（回帰）', async () => {
    const s = setup();
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(managerMessage('普通の報告', 'evt-1145-3'));
    await waitFor(() => inputs().length >= 1, '合図がターンへ渡る');

    const turn = inputs()[0] ?? '';
    expect(turn).toContain('引き受けたまま終わっていない仕事は');
    expect(turn).toContain('いま届いたこの一件も台帳に載せた');
    expect(turn).not.toContain('台帳を読めなかった');

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

    expect(digest).toContain('引き受けたまま終わっていない仕事: 1 件');
    expect(digest).toContain('10 日前に頼まれてまだやっていないこと');
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

    expect(digest).toContain('引き受けたまま終わっていない仕事: 0 件');
    expect(digest).toContain('この期間に片付けた仕事: 1 件');
    expect(digest).toContain('片付いたとした理由: 済んだ');
  });

  it('片付けた仕事は期間で切る（日報が過去に終えた分を毎日並べ直さない）', async () => {
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

    expect(digest).toContain('この期間に片付けた仕事: 0 件');
    expect(digest).not.toContain('10 日前に片付けた依頼');
  });

  it('システムプロンプトが「順序は台帳に無い」と言っている（器に優先度を持たせない歯止め）', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });

    expect(prompt).toContain('commitment_close');
    expect(prompt).toContain('commitment_open');
    expect(prompt).toContain('委譲しただけでは閉じない');
    expect(prompt).toContain('どれを先にやるかは台帳に書いていない');
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

  it('editBody の ifMatch の契約（#3786。3実装で同じことを測る）', async () => {
    await verifyCommitmentEditIfMatchContract(createMemoryStores().commitments);
  });

  it('removeForConversation の契約（#4218。3実装で同じことを測る。human かつ source 一致の行だけを未了・片付いたとも物理的に消す）', async () => {
    await verifyCommitmentRemoveForConversationContract(createMemoryStores().commitments);
  });

  it('ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）', async () => {
    await verifyStoreIsolationContract(createMemoryStores());
  });
});
