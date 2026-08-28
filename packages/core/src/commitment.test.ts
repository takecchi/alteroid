import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { closedRedeliveryNotice, commitmentFor, createClone } from './clone.js';
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

/**
 * 「引き受けたまま終わっていない仕事」が消えないことの検証。
 *
 * **ここで守っているのは1つの性質だけである** — 頼まれたことは、クローンが
 * 明示的に閉じるまで台帳に残る。残る側へ倒れる失敗（雑音）は許すが、消える側へ
 * 倒れる失敗（依頼の喪失）は許さない。
 *
 * 消える経路は3つあった。①その場で着手しなかった依頼はターンの終了とともに
 * 受信箱から消え、どの器にも残らない ②ターンが例外で落ちた合図は「失敗が記録
 * された」ことを根拠に消される ③発意 tick に渡る digest は人間の発言を件数でしか
 * 出さず、24時間の窓を過ぎれば件数からも消える。この3つそれぞれに対応する
 * テストがここにある。
 */

/** SDK を呼ばずにターンを1往復させる偽物（`clone.test.ts` の同名関数と同じ形）。 */
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
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const events: ChatStreamEvent[] = [];
  clone.subscribe('conv-1', (event) => events.push(event));
  return { clone, stores, calls, events };
}

/** 何らかの終端（done か error）が届くまで待つ。 */
function waitForSettled(events: ChatStreamEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (events.some((event) => event.type === 'done' || event.type === 'error')) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > 3000) {
        clearInterval(tick);
        reject(new Error(`終端が来ない: ${JSON.stringify(events)}`));
      }
    }, 5);
  });
}

/** 内部ターン（人間に見せない起点）が器へ届くまで待つ。 */
async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    // **本文は全文で残る。** 要約にすると、頼まれた内容そのものが二度と取れない
    expect(open[0]?.body).toBe('リリースノートを書いておいて');
    expect(open[0]?.origin).toBe('human');

    await s.clone.stop();
  });

  it('ターンが例外で落ちても未了は残る（失敗した依頼こそ失われてはいけない）', async () => {
    // ターンの中で開く形だと、ここだけが台帳に載らない。受理の瞬間に開いている
    // ことの検証であって、失敗の記録（`#reportFailure`）とは別の保証である。
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

    // ターンは終わっている。それでも開いたまま
    const beforeClose = (await stores.commitments.list()).entries;
    expect(beforeClose).toHaveLength(1);
    const id = beforeClose[0]?.id ?? '';

    // クローンが道具で閉じたときだけ閉じる
    const tools = createCloneTools({ stores, emit: () => undefined, memoryCause: () => 'clone' });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    await close?.handler({ id, reason: '直してマージした' } as never, {} as never);

    expect((await stores.commitments.list()).entries).toHaveLength(0);
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    expect(all).toHaveLength(1);
    // **「閉じた」だけを残さない。** 何をもって終わりとしたかが無いと、人間は否定できない
    expect(all[0]?.closedReason).toBe('直してマージした');
    // **`commitment_close` ツールは `closedBy: 'clone'` を書く**（issue #286）。
    // `POST /commitments/:id/close`（人間の経路）と同じ欄を、書いた側で分ける。
    expect(all[0]?.closedBy).toBe('clone');

    await s.clone.stop();
  });

  it('片付けた仕事は、同じ合図が配り直されても開き直らない', async () => {
    // 器が落ちると未読は配り直される（`InboxStore` の取引）。そのとき台帳を
    // 上書きしてしまうと、**片付いた仕事が器の再起動のたびに蘇る**。
    const stores = createMemoryStores();
    const event = humanMessage('一度だけやる仕事');

    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toBe(true);
    await stores.commitments.close(event.id, new Date().toISOString(), '済んだ', 'clone');

    // 配り直し = 同じ id でもう一度開こうとする
    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toBe(false);

    expect((await stores.commitments.list()).entries).toHaveLength(0);
  });

  /**
   * `closedBy`（issue #286）が in-memory 実装（`testing.ts`）でも記録され、
   * かつ導入前の行では既定へ倒れないことを固定する。fs / pg 版と同じ性質を
   * `packages/core` 側（`createMemoryStores`）でも問う。
   */
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

    // 導入前の記録を模す: open() へ closedAt/closedReason 付きで直接渡す
    // （close() を経由していない = closedBy を書く機会が無かった行）。
    await stores.commitments.open({
      id: 'c-legacy',
      at: new Date().toISOString(),
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: new Date().toISOString(),
      closedReason: '当時は書き手を記録していなかった',
    });
    // **`'clone'` にも `'human'` にも倒れず、そもそも無いままである。**
    expect((await stores.commitments.get('c-legacy'))?.closedBy).toBeUndefined();
  });

  /**
   * `editBody`（本 PR）。in-memory 実装（`testing.ts`）でも fs / pg 版と同じ
   * 振る舞いになることを問う——`origin` が `'human'` かどうかの判定は
   * ストアの責務ではない（`CommitmentStore.editBody` の doc）ので、ここでは
   * 問わない。その判定は `apps/daemon/src/app.test.ts` の
   * `PATCH /commitments/:id` のテストで別に問う。
   */
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
    // 他の欄は無傷
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

  /**
   * `commitment_edit`（issue #580 の (B)）。**クローンが自分で載せた行
   * （`origin: 'self'`）の本文を、自分で直せること。**
   *
   * 守りたい線は「書き換えられるのは常に自分自身の言葉だけ」であり、これを
   * 人間側（`PATCH /commitments/:id` — `origin: 'human'` だけ）とクローン側
   * （この道具 — `origin: 'self'` だけ）で対称にしたものである
   * （`commitmentSchema.editedAt` の doc）。
   *
   * **⚠️ 歯の書き方について。** ここで固定するのは「何が在るか / 何が無いか」
   * であって、応答や日誌の**文面そのものではない**。文面を完全一致で固定すると、
   * 守りたいものと無関係な変更まで赤くし、赤の原因が「別の PR が正しく足した
   * もの」になる。だから応答の文言は見ず、台帳の欄と日誌の中身の**有無**で見る。
   */
  describe('commitment_edit（クローンが自分の行の本文を直す。issue #580 の (B)）', () => {
    /** その `stores` に配線した `commitment_edit` を呼ぶ関数を返す。 */
    function editor(stores: Stores) {
      const tools = createCloneTools({ stores, emit: () => undefined, memoryCause: () => 'clone' });
      const found = tools.find((entry) => entry.name === 'commitment_edit');
      // 道具そのものが無ければ、下の検査は全部「直せなかった」に倒れて緑に
      // 見えうる。**その状態を「直せないことを確かめた」と読み替えないこと。**
      expect(found, 'commitment_edit という道具が無い').toBeDefined();
      return async (args: { id: string; body: string }) => {
        const result = await found?.handler(args as never, {} as never);
        return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      };
    }

    /** 日誌に積まれた `decision` の本文だけを取り出す。 */
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
      // 固定したいこと(1): 本文が入れ替わっていること。
      expect(edited?.body).toBe('直した本文');
      // 固定したいこと(2): 「編集した」という事実が欄として残ること
      //（時刻そのものは器の時計なので値では固定しない——**在ること**を見る）。
      expect(edited?.editedAt).not.toBeUndefined();
      // 固定したいこと(3): 書いた主体が 'clone' であること（人間の経路と
      // 同じ欄を、書いた側で分ける。`closedBy` の 'clone' と同じ語彙）。
      expect(edited?.editedBy).toBe('clone');
      // 固定したいこと(4): 本文以外は1つも動かないこと（`editBody` の契約）。
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

      // 固定したいこと: **原文が日誌から読み戻せること。** 台帳が守っている
      // のは「一字一句が凍ること」ではなく「クローンが過去の自分を追える
      // こと」で、日誌に前後が逐語で残ることがその条件そのものである
      //（`commitmentSchema.editedAt` の doc / `PATCH /commitments/:id` の doc）。
      // **文面ではなく、前後の本文が在るかどうかだけを見る。**
      const texts = await decisions(stores);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('もとの本文');
      expect(texts[0]).toContain('直した本文');
      // id も同じ1本に入っている（どの行の編集かが日誌だけで辿れる）。
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

      // 固定したいこと(1): 本文が1文字も動いていないこと。
      //（`manager` は `bodyMarkup` の接頭辞の契約が `body` に掛かっている
      //  ので、直すとその前提が壊れる。`human` は人間自身の言葉である。）
      expect((await stores.commitments.get('c-human'))?.body).toBe('人間が頼んだこと');
      expect((await stores.commitments.get('c-manager'))?.body).toBe('[report] マネージャーの報告');
      // 固定したいこと(2): 「編集した」という跡も付いていないこと
      //（断られたのに欄だけ立つ、という中途半端な状態を作らない）。
      expect((await stores.commitments.get('c-human'))?.editedAt).toBeUndefined();
      expect((await stores.commitments.get('c-manager'))?.editedAt).toBeUndefined();
      // 固定したいこと(3): 断ったものは日誌にも積まない
      //（日誌へ載るのは実際に書き換えた分だけである）。
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

      // 固定したいこと(1): 片付いた行の本文も片付け方も動かないこと。
      const closed = await stores.commitments.get('c-closed');
      expect(closed?.body).toBe('もう片付いた仕事');
      expect(closed?.closedReason).toBe('片付けた');
      expect(closed?.editedAt).toBeUndefined();
      // 固定したいこと(2): 無い id で新しい行が生えないこと。
      expect(await stores.commitments.get('しらない')).toBeNull();
      // 固定したいこと(3): どちらも日誌に積まない。
      expect(await decisions(stores)).toEqual([]);
    });
  });

  it('渡されたものは起点を問わず載り、起こされただけの合図は載らない', async () => {
    // **判定の基準は「誰かが渡してきたか」である。** 発意 tick で1件増える形にすると
    // 台帳が数時間で読めなくなり、載っているのに見えない仕事が生まれる。
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

  /**
   * `manager_message.markup`（issue #287）が `Commitment.bodyMarkup` へ
   * そのまま持ち越されること。**印が無いイベントでは `bodyMarkup` が
   * `undefined` のままで、既定（`'markdown'` や `'none'`）へ倒れないこと**
   * を別々の歯で確かめる — `close は closedBy を記録し…` （直上の describe 内
   * のテスト）が `closedBy` で固定しているのと同じ形の保証を、`bodyMarkup`
   * について問う。
   */
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
    expect(input).toContain('引き受けたまま終わっていない仕事は **1 件** ある');
    // 閉じ方が分からなければ閉じられない
    expect(input).toContain('commitment_close');
    // **器は並べ替えない。** 順序を器が決めた瞬間に「何を先にやるか」の判断が器へ移る
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

    // 応答は返る
    expect(s.events.some((event) => event.type === 'done')).toBe(true);
    // **黙って失敗しない。** 跡が無いと「載っていない」と「読めなかった」が同じ形になる
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
    // 跡に本文を載せない（`dropped-record.ts`。テスト出力に GH_TOKEN が全文で
    // 出た前例がある。railway/setup.test.ts の差分アサーション、#52）
    expect(stderr).not.toContain('秘密を含むかもしれない依頼');

    await s.clone.stop();
  });
});

describe('未了の見え方', () => {
  it('digest には期間によらず載る（24時間の窓で切ると、放置された依頼だけが落ちる）', async () => {
    const stores = createMemoryStores();
    // 10 日前に受け取ってまだ片付いていない依頼
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await stores.commitments.open({
      id: 'c-old',
      at: old,
      origin: 'human',
      body: '10 日前に頼まれてまだやっていないこと',
    });

    // 窓は直近1時間だけ
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
    // 未了の節からは外れるが、**何を片付けたかは日報の材料として残る**
    // （人間が普段読むのは日報だけである。PRD「可観測性」）
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
    // **委譲しただけでは閉じない**（ここが緩むと、投げた時点で片付いたことになる）
    expect(prompt).toContain('委譲しただけでは閉じない');
    // 順序の判断はクローンに残る（PRD「自律」: 器は「やることの一覧」を持たない）
    expect(prompt).toContain('どれを先にやるかは台帳に書いていない');
  });
});

/**
 * `closedRedeliveryNotice`（片付け済みの配り直しの断り書き）の単体テスト。
 *
 * **狙いは「本文を全文渡さずに、依頼者の5条件を全部満たすか」だけを見ること。**
 * `#restoreUnread` / `#handle` に全部を通す統合テストは `inbox-persistence.test.ts`
 * に別で置く（このファイルは純粋関数だけを速く・精密に見る）。
 */
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

    // (1) 再起動後の配り直しであること
    expect(notice).toContain('再起動後の配り直しである');
    // (2) どの合図か（`inboxEventShape` を流用。本文そのものではなく見分け）
    expect(notice).toContain('human_message');
    // (3) いつ受け取ったか
    expect(notice).toContain(event.at);
    // (4) 既に閉じていること・閉じた時刻・closedReason
    expect(notice).toContain('片付けた時刻');
    expect(notice).toContain(commitment.closedAt);
    expect(notice).toContain('もう対応済みだった');
    // (5) 全文の取り方（具体的な手掛かり）
    expect(notice).toContain('journal_read');
    expect(notice).toContain('conv-9');
    // 本文そのものは1文字も載らない
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

    // **ここが本題。** `#handle` の `human_answer` 分岐は `#journal` を呼ばない
    // ので、`journal_read` を案内すると取れない指示になる（禁止事項）。
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
      // closedReason は付けない
    };

    const notice = closedRedeliveryNotice(event, commitment);

    expect(notice).toContain('再起動後の配り直しである');
    expect(notice).toContain(commitment.closedAt);
    expect(notice).toContain('journal_read');
    // 「全文は省略した」とだけ言って終わっていない（依頼者の禁止）。
    expect(notice).not.toMatch(/全文は省略した。?$/m);
  });
});
