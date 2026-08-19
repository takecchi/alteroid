import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { commitmentFor, createClone } from './clone.js';
import { buildActivityDigest } from './digest.js';
import type { CloneHost } from './host.js';
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

    const open = await s.stores.commitments.list();
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

    const open = await s.stores.commitments.list();
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
    const beforeClose = await stores.commitments.list();
    expect(beforeClose).toHaveLength(1);
    const id = beforeClose[0]?.id ?? '';

    // クローンが道具で閉じたときだけ閉じる
    const tools = createCloneTools({ stores, emit: () => undefined });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    await close?.handler({ id, reason: '直してマージした' } as never, {} as never);

    expect(await stores.commitments.list()).toHaveLength(0);
    const all = await stores.commitments.list({ includeClosed: true });
    expect(all).toHaveLength(1);
    // **「閉じた」だけを残さない。** 何をもって終わりとしたかが無いと、人間は否定できない
    expect(all[0]?.closedReason).toBe('直してマージした');

    await s.clone.stop();
  });

  it('片付けた仕事は、同じ合図が配り直されても開き直らない', async () => {
    // 器が落ちると未読は配り直される（`InboxStore` の取引）。そのとき台帳を
    // 上書きしてしまうと、**片付いた仕事が器の再起動のたびに蘇る**。
    const stores = createMemoryStores();
    const event = humanMessage('一度だけやる仕事');

    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toBe(true);
    await stores.commitments.close(event.id, new Date().toISOString(), '済んだ');

    // 配り直し = 同じ id でもう一度開こうとする
    expect(await stores.commitments.open(commitmentFor(event) as Commitment)).toBe(false);

    expect(await stores.commitments.list()).toHaveLength(0);
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

  it('マネージャーからの報告も台帳に載る（受け取っただけでは始末がついていない）', async () => {
    const s = setup();

    s.clone.post(managerMessage('PR を出した。レビュー待ち'));
    await waitFor(async () => (await s.stores.commitments.list()).length > 0, 'マネージャーの記帳');

    const open = await s.stores.commitments.list();
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

    expect(await s.stores.commitments.list()).toHaveLength(0);

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
    // 跡に本文を載せない（`dropped-record.ts`。報告本文に GH_TOKEN が全文で出た前例がある）
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
    await stores.commitments.close('c-1', new Date().toISOString(), '済んだ');

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
    await stores.commitments.close('c-old', old, '10 日前に済んだ');

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect(digest).toContain('この期間に片付けた仕事: 0 件');
    expect(digest).not.toContain('10 日前に片付けた依頼');
  });

  it('システムプロンプトが「順序は台帳に無い」と言っている（器に優先度を持たせない歯止め）', () => {
    const prompt = buildCloneSystemPrompt({ memory: '' });

    expect(prompt).toContain('commitment_close');
    expect(prompt).toContain('commitment_open');
    // **委譲しただけでは閉じない**（ここが緩むと、投げた時点で片付いたことになる）
    expect(prompt).toContain('委譲しただけでは閉じない');
    // 順序の判断はクローンに残る（PRD「自律」: 器は「やることの一覧」を持たない）
    expect(prompt).toContain('どれを先にやるかは台帳に書いていない');
  });
});
