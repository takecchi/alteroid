import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, failingInboxPut, humanMessage } from './testing.js';

/**
 * 未読の受信箱が、プロセスの死を跨いで残るか（欠陥: 受信箱が完全にインメモリで、
 * デーモンが死ぬと未読が消える）。
 *
 * **`inbox.test.ts` は `Inbox` そのものの単体テストで、「プロセスが死んだとき
 * どうなるか」を1本も持っていない。ここがその主題である。** 器の死は
 * 「`Clone` を止めずに捨てて、同じ `Stores` から作り直す」で再現する — 実際に
 * 起きるのはそれ（記憶ストアは生き残り、デーモンだけが入れ替わる）だからで、
 * ここを `stop()` で代用すると**片付けの経路しか通らず、肝心の「終える前に
 * 消える」が再現できない**。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/**
 * SDK の代わり。`hang` を渡すと**入力を受け取ったきり結果を返さない** —
 * 「ターンの途中で器ごと落ちた」を、待っている状態のまま作るためのもの。
 */
function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  // 解かない約束。タイマーを持たないので、これでテストの終了が遅れることはない。
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
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

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    // 委譲先も偽物にしておく（誤って本物の SDK を起こさない）。
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { ...fake, clone };
}

/** マネージャーの報告 = 実測で消えていたもの。 */
function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 受信箱のループが動き出し、次の合図を待っている状態にする。 */
async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('未読の永続化', () => {
  it('クローンが暇なときに届いた合図も器に残る（queue を通らない経路）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores, 'hang');
    // ここが要点。**受信箱が空でループが待っている**とき、`Inbox#push` は
    // `#waiters` へ直接渡すので合図は `#queue` を一度も通らない。「落ちる前に
    // queue を吐き出す」形の永続化は、この経路を1件も救わない。
    await idle();

    clone.post(report('PR #99 をマージした'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');

    const pending = await stores.inbox.claimPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-report');
    // 本文まで残っていること。抜粋では拾い直せない。
    expect((pending[0]?.event as { text: string }).text).toBe('PR #99 をマージした');
  });

  it('処理を終えたら器から消える（再起動のたびに処理済みを配り直さない）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(report('終わった'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    // `stop()` は片付けの蒸留を受信箱へ積んでその完了を待つので、先に積んだ報告の
    // 処理（＝消し込みまで）が終わっていることの保証になる。
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('終える前に器が落ちたら、次の起動で配り直される（本文ごと）', async () => {
    const stores = createMemoryStores();

    // 1つ目の器。報告を受け取ったところで死ぬ（stop を呼ばない＝片付けを通らない）。
    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('作業者が3本走っている。判断を仰ぎたい'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    // 2つ目の器。記憶ストアだけが生き残っている。
    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('作業者が3本走っている。判断を仰ぎたい');
    // 起点ごとのプロンプト（ここではマネージャーからの報告）はそのまま生きている。
    expect(prompt).toContain('マネージャー mgr-1 から届いた');

    await reborn.clone.stop();
  });

  it('配り直しだと分かる形で届く（二度目だと分からないのは受け入れない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('同じ報告'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    // 本文より先に断り書きが来ること。読む側が本文へ入る前に「前に見たかもしれない」
    // と分かる位置に無いと、二度応答してからでは遅い。
    expect(prompt).toContain('配り直し');
    expect(prompt).toContain('1 回目の配達');
    expect(prompt.indexOf('配り直し')).toBeLessThan(prompt.indexOf('同じ報告'));

    // 人間が後から「なぜ二度来たのか」を追えること。
    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) =>
          entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
      ),
    ).toBe(true);

    await reborn.clone.stop();
  });

  it('配り直すたびに回数が上がる（毎回落ちているなら、それが見える）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('処理するたびに器が落ちる合図'));
    await waitFor(() => first.inputs.length > 0, '合図が処理に入る');

    const second = bootClone(stores, 'hang');
    await waitFor(() => second.inputs.length > 0, '1 回目の配り直し');
    expect(second.inputs[0] ?? '').toContain('1 回目の配達');

    const third = bootClone(stores);
    await waitFor(() => third.inputs.length > 0, '2 回目の配り直し');
    const prompt = third.inputs[0] ?? '';
    expect(prompt).toContain('2 回目の配達');
    // 回数が2以上なら、同じやり方をなぞる前に理由を見るよう促す。
    expect(prompt).toContain('2 回以上配り直している');

    await third.clone.stop();
  });

  it('例外で終わった合図も消える（記録は残っているので、永久に配り直さない）', async () => {
    // `#handle` を確実に落とす。承認の読み出しが失敗すると `human_answer` の
    // 処理は例外で終わり、失敗は `#reportFailure` 経由で日誌に残る。
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      jobs: { ...base.jobs, getApproval: () => Promise.reject(new Error('台帳が壊れている')) },
    };
    const { clone } = bootClone(stores);

    clone.post({
      type: 'human_answer',
      id: 'evt-answer',
      at: new Date(0).toISOString(),
      approvalId: 'apv-1',
      answer: 'よい',
    });

    // 失敗は握り潰されず日誌に残る。**消してよい根拠はここにある。**
    await waitForJournal(stores, '内部ターンが失敗した');

    // 残すと、決定的に失敗する合図が起動のたびに配り直され、そのたびに同じ失敗を
    // 繰り返してクローンのターンを1本ずつ焼く。**残るのはプロセスが死んだときだけ。**
    await waitForNoUnread(stores);
    await clone.stop();
  });

  it('未読を書けなくても post は落ちない。跡は stderr に1行で、本文は出ない', async () => {
    const stores = failingInboxPut(createMemoryStores(), '器が閉じている');
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';

    const lines = await captureStderr(async () => {
      const { clone, inputs } = bootClone(stores);
      // 未読を書けないことでその合図の処理まで止めない（塞ぐべき穴より広くなる）。
      clone.post(humanMessage(secret));
      await waitFor(() => inputs.length > 0, '合図が処理に入る');
      await clone.stop();
    });

    const trace = lines.filter((line) => line.includes('未読の合図を記録できませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    // 本文は出さない（報告本文に GH_TOKEN が全文で出た前例がある。#52）。
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    // 長さだけは出す（「空だった」と「書けなかった」の区別が付く）。
    expect(trace[0]).toContain(`chars=${secret.length}`);
  });

  it('消し込みが書き込みを追い越さない（追い越すと永久に配り直される）', async () => {
    const base = createMemoryStores();
    const written: string[] = [];
    // 書き込みが遅い器。`post` は同期で返るので、短いターンなら「終えた」が
    // 「書けた」より先に来る。
    const stores: Stores = {
      ...base,
      inbox: {
        ...base.inbox,
        put: async (event, at) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await base.inbox.put(event, at);
          written.push(event.id);
        },
      },
    };

    const { clone, inputs } = bootClone(stores);
    clone.post(report('速く終わる報告'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    await clone.stop();

    // **書き込みが器へ落ちるまで待ってから見ること。** ここを待たずに見ると、
    // 追い越しの跡（後から書かれる行）がまだ現れておらず、壊れていても通る。
    await waitFor(() => written.length > 0, '未読の書き込みが終わる');
    // 消し込みが書き込みを待たずに走っていたら、後から書かれた行がここに残る。
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('蒸留は器に置かない（拾い直しても対象のセッションはもう無い）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(humanMessage('やあ'));
    await waitFor(() => inputs.length > 0, '発言が処理に入る');
    await clone.endConversation('conv-1');
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  /**
   * 配り直しで本文が二度載ること自体を固定する。
   *
   * **これは受け入れた側の帰結である。** 消し込みが「終えた時点」なのと同じ取引で、
   * 「消えるより配り直す」を選んだ結果として重複しうる。**回数はこの直しの前と
   * 同じ**（以前も `#handle` が配達のたびに書いていた）。ここを「二度載らないよう
   * 直す」方向へ動かすと、受理の瞬間の追記が器へ届く前に落ちた発言が消える側へ
   * 倒れる。**どちらの向きを選んだかが読めるように、期待値として残す。**
   */
  it('配り直しでは本文が二度載る（消えるより配り直す。回数は直す前と同じ）', async () => {
    const stores = createMemoryStores();

    // 1つ目の器。追記は成功したが、ターンの途中で死ぬ。
    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(humanMessage('MSG-TWICE', 'conv-1'));
    await waitForJournal(stores, 'MSG-TWICE');
    expect(await inboundCount(stores, 'MSG-TWICE')).toBe(1);

    // 2つ目の器。拾い直した配達で、もう一度書かれる。
    const reborn = bootClone(stores);
    await expect.poll(() => inboundCount(stores, 'MSG-TWICE'), { timeout: 3000 }).toBe(2);

    await reborn.clone.stop();
  });

  /**
   * 受理の瞬間に書いた発言の本文が、その追記だけ器へ届かないまま落ちても失われないか。
   *
   * **`post` は同期なので、追記が届いたかどうかは `post` からは分からない。**
   * だから配り直しの側でもう一度書く。書かない側を選ぶと、未読の器には在るのに
   * 日誌にも `GET /conversations` にも無い発言ができる。重複しうる代わりに消えない、
   * という向きを記録でも揃えている（消し込みが「終えた時点」なのと同じ取引）。
   */
  it('配り直しでも発言の本文が日誌に残る（受理の瞬間の追記が落ちていても）', async () => {
    const stores = createMemoryStores();

    await captureStderr(async () => {
      // 1つ目の器。受理の瞬間の追記（＝最初の1本）だけを落として、そのまま死ぬ。
      const dying = bootClone(droppingFirstJournalAppend(stores), 'hang');
      await idle();
      dying.clone.post(humanMessage('MSG-BODY', 'conv-1'));
      await waitFor(() => dying.inputs.length > 0, '発言が処理に入る');
      // 落ちた側は日誌に何も残していない。
      expect(await stores.journal.list({ types: ['exchange'] })).toEqual([]);

      // 2つ目の器。記憶ストアだけが生き残っている。
      const reborn = bootClone(stores);
      await waitForJournal(stores, 'MSG-BODY');
      await reborn.clone.stop();
    });
  });
});

/** 同じ本文の inbound が日誌に何本あるか。 */
async function inboundCount(stores: Stores, text: string): Promise<number> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.filter(
    (entry) => entry.type === 'exchange' && entry.role === 'inbound' && entry.text === text,
  ).length;
}

/**
 * 追記の1本目だけを落とす（受理の瞬間の追記が器へ届く前に落ちた形）。
 *
 * 全部を落とすと配り直しの側の追記も落ちるので、直したことが見えない。
 */
function droppingFirstJournalAppend(stores: Stores): Stores {
  let first = true;
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append(entry) {
        if (first) {
          first = false;
          return Promise.reject(new Error('器が閉じている'));
        }
        return stores.journal.append(entry);
      },
    },
  };
}

async function waitForJournal(stores: Stores, needle: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const entries = await stores.journal.list({ types: ['exchange'] });
    if (entries.some((entry) => entry.type === 'exchange' && entry.text.includes(needle))) return;
    if (Date.now() - started > 3000) throw new Error(`日誌に「${needle}」が出ない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 未読が空になるまで待つ（消し込みは `#handle` の後に走るので同期では見られない）。 */
async function waitForNoUnread(stores: Stores): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await stores.inbox.claimPending()).length === 0) return;
    if (Date.now() - started > 3000) throw new Error('未読が消えない');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 台帳にその id が現れるまで待つ（`#commit` は `post` から見て非同期）。 */
async function waitForCommitment(stores: Stores, id: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await stores.commitments.get(id)) !== null) return;
    if (Date.now() - started > 3000) throw new Error(`台帳に ${id} が現れない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 「クローンが既に片付けたと宣言済みの合図が、再起動後にまた全文で配り直される」
 * という実測の直し（`#restoreUnread` が `stores.commitments` を引く）。
 *
 * **合図は落とさない。ターンも焼く。短くするのは本文だけ**という仕様をそのまま
 * テストにする。`fakeSdk` はツール呼び出しを再現しないので、「クローンが
 * `commitment_close` を呼んだ」状態は台帳を直接閉じて代用する。
 */
describe('片付け済みの配り直し（本文だけを短くする）', () => {
  it('既に commitment_close で片付けていたら、配り直しは短縮され、全文の取り方が具体的に入る', async () => {
    // **最初の1回分の日誌書き込みだけを落とす。** 落とさないと、この検証は
    // 「dying（クローズ前）が書いた全文」で満たせてしまい、「配り直しでも日誌の
    // 書き込みは変えていない」を測ったことにならない（`droppingFirstJournalAppend`
    // と同じ形。修復＝別の書き込みが同じ結論を出してしまう問題）。
    const base = createMemoryStores();
    let droppedFirstManagerExchange = false;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append(entry) {
          if (
            !droppedFirstManagerExchange &&
            entry.type === 'exchange' &&
            entry.with === 'manager' &&
            entry.role === 'inbound'
          ) {
            droppedFirstManagerExchange = true;
            return Promise.reject(new Error('最初の1回だけ落とす（検証のため）'));
          }
          return base.journal.append(entry);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('CLOSED-REPORT 本文はこれだけ長くしておく', 'evt-closed'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-closed');

    expect(
      await stores.commitments.close('evt-closed', '2026-08-02T00:00:00.000Z', 'もう対応済み'),
    ).toBe(true);

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    // 本文はもう全文では載らない。
    expect(prompt).not.toContain('CLOSED-REPORT 本文はこれだけ長くしておく');
    // だが「配り直しである」ことと、片付いていることは分かる。
    expect(prompt).toContain('再起動後の配り直しである');
    expect(prompt).toContain('片付けた時刻');
    expect(prompt).toContain('2026-08-02T00:00:00.000Z');
    expect(prompt).toContain('もう対応済み');
    // 全文の取り方（journal_read）が具体的に書いてある（「省略した」だけで終わらない）。
    expect(prompt).toContain('journal_read');
    // どの合図かも分かる（マネージャー id。`inboxEventShape` を流用）。
    expect(prompt).toContain('mgr-1');

    // **日誌への書き込みは変えない。** dying の1回目は上で落としてあるので、
    // ここに全文があるのは配り直し（reborn）自身の書き込みでしかありえない。
    expect(droppedFirstManagerExchange).toBe(true);
    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) =>
          entry.type === 'exchange' &&
          entry.role === 'inbound' &&
          entry.with === 'manager' &&
          entry.text.includes('CLOSED-REPORT 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);

    // それでも「合図は落とさない。ターンも焼く」— 消し込みは通常どおり進む。
    await reborn.clone.stop();
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('human_message でも同じく短縮される（配線は起点ごとに分かれているので `manager_message` だけでは足りない）', async () => {
    const stores = createMemoryStores();
    const text = 'CLOSED-HUMAN-MSG 本文はこれだけ長くしておく';
    const event = humanMessage(text);

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);

    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', 'もう対応済み'),
    ).toBe(true);

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).not.toContain(text);
    expect(prompt).toContain('再起動後の配り直しである');
    expect(prompt).toContain('journal_read');

    await reborn.clone.stop();
  });

  it('未了（クローンがまだ片付けていない）合図の配り直しは、1文字も変えず全文のまま届く', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('OPEN-REPORT 本文はこれだけ長くしておく', 'evt-open'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-open');
    // 閉じない（未了のまま次の器を起こす）。

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('OPEN-REPORT 本文はこれだけ長くしておく');
    // 短縮側の断り書きは出ない。
    expect(prompt).not.toContain('クローンは既にこの合図を片付けている');

    await reborn.clone.stop();
  });

  it('片付き確認（commitments.get）が失敗しても全文で配る。ターンは落ちない（雑音であって喪失ではない側へ倒す）', async () => {
    const base = createMemoryStores();
    let failNextGet = false;
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        get: (id: string) => {
          if (failNextGet) return Promise.reject(new Error('台帳が読めない'));
          return base.commitments.get(id);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('THROW-REPORT 本文はこれだけ長くしておく', 'evt-throw'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-throw');
    expect(await stores.commitments.close('evt-throw', new Date().toISOString(), '片付けた')).toBe(
      true,
    );

    // 拾い直しの側でだけ読み出しを落とす。
    failNextGet = true;
    const lines = await captureStderr(async () => {
      const reborn = bootClone(stores);
      await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

      const prompt = reborn.inputs[0] ?? '';
      // **閉じているのに、読めなかったので全文のまま届く。** ターンは落ちていない
      // （待てたこと自体が、ターンが最後まで走った証拠である）。
      expect(prompt).toContain('THROW-REPORT 本文はこれだけ長くしておく');

      await reborn.clone.stop();
    });
    expect(lines.some((line) => line.includes('配り直しの片付き確認'))).toBe(true);
  });
});
