import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * エスカレーションの通し検証（受け入れ基準2）。
 *
 * 作業者 → マネージャー → クローン → 承認待ちキュー → 人間 → マネージャー、の
 * 一本道を端から端まで通す。**同じマネージャーが2件を同時に待ち、人間が逆順に
 * 答える**という、宛先を取り違えたら必ず壊れる形で確かめる。
 *
 * 唯一模擬するのはモデルの手（どの道具をどう呼ぶか）だけで、道具の実体・ジョブ台帳・
 * 受信箱・マネージャー側の待ちはすべて本物を通す。
 */
function fakeManagerSdk() {
  const sessions: {
    options: Options;
    ask: (tool: string, id: string) => Promise<PermissionResult>;
  }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};

    sessions.push({
      options,
      ask(tool, id) {
        const canUseTool = options.canUseTool as CanUseTool;
        return canUseTool(tool, { command: `${tool}:${id}` }, {
          signal: new AbortController().signal,
          requestId: id,
          toolUseID: id,
        } as never) as Promise<PermissionResult>;
      },
    });

    // 閉じられる形にしておく。閉じられないと `stop()` が読み取りを待って固まる。
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      // 報告は出さない。ここで見たいのは確認の往復だけ。
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

/** クローンの「頭」の代わり。内部ターンに渡された本文だけを記録する。 */
function fakeCloneSdk() {
  const inputs: string[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-clone',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-clone',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

/** クローンが道具を呼ぶところ（＝モデルの手）を、手で再現する。 */
function handsOf(stores: Stores, managers: ManagerPool) {
  const tools = createCloneTools({ stores, emit: () => undefined, managers });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`ツール ${name} が無い`);
    const result = await tool.handler(args as never, {});
    return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  return { call };
}

describe('エスカレーション（受け入れ基準2）', () => {
  it('同じマネージャーの2件を人間へ回し、逆順に答えても、それぞれの仕事だけが再開する', async () => {
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const clone = fakeCloneSdk();

    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });

    const host = createClone({ stores, queryFn: clone.fn, managers: pool });
    const hands = handsOf(stores, pool);

    const { managerId } = await pool.start({ request: '2つ確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // --- マネージャーが同時に2件の確認を降ろす -----------------------------
    const first = session.ask('Bash', 'req-first');
    const second = session.ask('WebFetch', 'req-second');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = inbox.filter((event) => event.type === 'manager_message');
    expect(asked.map((event) => event.requestId)).toEqual(['req-first', 'req-second']);

    // --- クローンは根拠が無いので2件とも人間へ回す -------------------------
    for (const event of asked) {
      if (event.type !== 'manager_message') continue;
      await hands.call('ask_human', {
        question: event.text,
        managerId: event.managerId,
        requestId: event.requestId,
      });
    }

    const approvals = await stores.jobs.listApprovals({ pendingOnly: true });
    expect(approvals).toHaveLength(2);
    // 宛先が承認待ちの永続データに残っていること（ここが欠けると戻せない）
    expect(approvals.map((a) => [a.jobId, a.requestId])).toEqual([
      [managerId, 'req-first'],
      [managerId, 'req-second'],
    ]);

    const idOf = (requestId: string) =>
      (approvals.find((a) => a.requestId === requestId) as PendingApproval).id;

    // --- 人間が **逆順** に答える -----------------------------------------
    await host.answerApproval(idOf('req-second'), 'それは駄目だ');
    await expect
      .poll(() => clone.inputs.some((input) => input.includes('req-second')), { timeout: 3000 })
      .toBe(true);

    // 回答が届いたターンには、戻すべき宛先が両方載っている
    const secondTurn = clone.inputs.find((input) => input.includes('req-second')) ?? '';
    expect(secondTurn).toContain(managerId);
    expect(secondTurn).toContain('それは駄目だ');
    expect(secondTurn).not.toContain('req-first');

    // クローンがその宛先へ返す
    const reply = await hands.call('manager_send', {
      managerId,
      requestId: 'req-second',
      message: 'それは駄目だ',
      decision: 'deny',
    });
    expect(reply).toContain('回答した');

    // 後から回した方だけが解け、先の1件はまだ待っている
    expect(await second).toMatchObject({ behavior: 'deny', message: 'それは駄目だ' });
    expect(
      (await pool.list()).find((m) => m.managerId === managerId)?.waiting.map((w) => w.requestId),
    ).toEqual(['req-first']);

    // --- 残りの1件も同じ経路で解ける ---------------------------------------
    await host.answerApproval(idOf('req-first'), 'それはよい');
    await expect
      .poll(() => clone.inputs.some((input) => input.includes('req-first')), { timeout: 3000 })
      .toBe(true);

    await hands.call('manager_send', {
      managerId,
      requestId: 'req-first',
      message: 'それはよい',
      decision: 'allow',
    });
    expect(await first).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await host.stop();
  }, 15_000);

  it('宛先を落として人間へ回すと、答えても戻せないことが分かる（黙って通さない）', async () => {
    // requestId を落としたまま回答すると、宛先が決まらない。ここで黙って
    // 先頭へ入れてしまうと、人間の「駄目だ」が別の確認の承認になる。
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });

    const { managerId } = await pool.start({ request: '2件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    void session.ask('Bash', 'req-a');
    void session.ask('WebFetch', 'req-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blind = await pool.send(managerId, 'それは駄目だ', { decision: 'deny' });
    expect(blind.outcome).toBe('unknown');
    expect(blind.detail).toContain('requestId');
    // どちらも解けていない（取り違えて片方を通したりしない）
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(2);

    await pool.stop();
  });
});

describe('クローンが記憶を根拠に、人間を経由せず答える経路（ask_human を通らない manager_send）', () => {
  /**
   * ⭐ このテストが固定しているのは「経路の処理」であって、モデルの判定そのものではない。
   *
   * `clone.ts` の `managerPrompt()` は、マネージャーからの質問・許可確認をモデルへ
   * 渡すとき「記憶に根拠があるなら自分で決めて `manager_send` で返し、その判断を
   * `journal_write` に残せ。根拠が無いなら `ask_human` に積め」という**指示文**を
   * 渡す。これはコード側の分岐ではなくモデルへの依頼であり、`manager_send`
   * （`tools.ts`）は `ask_human` を経由せずに直接呼べる（ゲートされていない）。
   *
   * 上の「エスカレーション（受け入れ基準2）」は根拠が無い側（2件とも `ask_human`
   * へ回す）だけを固定していて、**人間を迂回してクローンが自分で答える経路**を
   * 通すテストが1本も無かった。ここが埋める箇所である。このテストが固定するのは:
   *
   * 1. `ask_human` を呼ばずに `manager_send` で回答できる
   * 2. その判断が `journal_write` で日誌（`decision`）に残る
   * 3. 承認待ちキュー（`listApprovals`）には何も積まれない（`ask_human` を経て
   *    いないことの裏）
   * 4. マネージャー側の返事待ちが実際に解ける（回答が届く）
   *
   * という一連をコードが正しく扱えること、**それだけ**である。
   *
   * ⭐ 固定していないこと — ここで `manager_send` と `journal_write` を呼んでいる
   * のは**テストの作者**であり、モデルではない。偽 SDK には「根拠があるかどうか」
   * を判定する能力が無いので、その判定を代わりに手順としてスクリプトしているに
   * すぎない。M2 受け入れ基準3（「記憶に根拠がある確認はクローンが人間に聞かずに
   * 返している」）が言っているのは*モデルがそう判断すること*であり、それは
   * このテストでは原理的に確かめられない。**このテストが緑であることを
   * 「受け入れ基準3を満たした」の根拠にしないこと。**
   */
  it('ask_human を経由せず manager_send で返すと、日誌に残り、承認待ちは増えず、マネージャーへ届く', async () => {
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });
    const hands = handsOf(stores, pool);

    const { managerId } = await pool.start({ request: '1件確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // マネージャーが1件の許可確認を上げる。
    const pending = session.ask('Bash', 'req-self');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = inbox.filter((event) => event.type === 'manager_message');
    expect(asked).toHaveLength(1);

    // --- クローンは ask_human を呼ばず、記憶に根拠があるとして自分で答える -----
    const reply = await hands.call('manager_send', {
      managerId,
      requestId: 'req-self',
      message: '過去に同種の許可を出している前例があるので進めてよい',
      decision: 'allow',
    });
    expect(reply).toContain('回答した');

    // managerPrompt() の指示どおり、その判断を journal_write で日誌に残す。
    await hands.call('journal_write', {
      decision: `マネージャー ${managerId} の req-self へ、人間に聞かずに allow で答えた`,
      grounds: '記憶に同種の許可を出した前例がある',
    });

    // --- ① ask_human を経由していない証拠: 承認待ちキューが1件も増えていない ---
    // 承認待ちキュー（jobs.putApproval）へ積むのは `ask_human` だけである。
    // `escalation` 型の日誌は `manager.ts` が ask/answer のたびに機械的に書く
    // （どちらの経路でも書かれるので、ここでは経路の判定材料にしない）。
    const approvals = await stores.jobs.listApprovals({ pendingOnly: true });
    expect(approvals).toHaveLength(0);

    // --- ② 判断が journal_write で日誌（decision）に残っている ---------------
    const decisions = (await stores.journal.list({ types: ['decision'] })) as {
      type: 'decision';
      decision: string;
      grounds: string;
    }[];
    const found = decisions.find((d) => d.decision.includes('req-self'));
    expect(found).toBeDefined();
    expect(found?.grounds).toBe('記憶に同種の許可を出した前例がある');

    // --- ③ マネージャー側に実際に届いている（止まっていた返事待ちが解ける） ---
    expect(await pending).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  });
});
