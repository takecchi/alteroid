import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **マネージャーの側でも、SDK のエラーを「報告」として扱わない。**
 *
 * クローン側で塞いだのと同じ穴がここにもあった（`sdk-failure.ts` の doc）。
 * 直す前の runner は成否によらず `report` を上げていたので、支出上限の英語文言が
 * そのまま「マネージャーの報告」として台帳（`lastReport`）・日誌・クローンの
 * 受信箱へ流れていた。クローンから見て「報告が来た」と「エラーで死んだ」が
 * 区別できない ＝ 手が正反対（待つ / 挑み直す）になる場面で判断材料が無い。
 *
 * **`manager.test.ts` とは別ファイルにしてある。** あちらの `FakeSession` は
 * 成功する `result` しか出せない作りで、失敗の印（`assistant.error` /
 * `is_error`）を1本も通せない。あちらへ口を足すと既存の100本超が同じ偽物を
 * 共有することになるので、ここでは**この関心に必要な形だけを出せる偽物**を持つ。
 */

/** 実機で観測された文言そのまま。 */
const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

interface FakeSession {
  say(text: string, options?: { error?: string }): Promise<void>;
  /** 1ターンを畳む。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    // **`manager.test.ts` の偽 SDK と同じ待ち方にしてある。** 自前のポーリング
    // ループにすると、`close()` で畳めず `pool.stop()` の後もジェネレータが生き
    // 残る（テストが終わらない）。実績のある形を写す。
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}`,
          ...(sayOptions.error === undefined ? {} : { error: sayOptions.error }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result',
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // 入力を読み続ける裏方（読まないと送り手が詰まる）。中身は使わない。
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function setup(): {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
} {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return { pool, stores, sessions, inbox };
}

/**
 * 台帳の1件（`JobStore` は id 引数の `get` を持たないので一覧から引く）。
 *
 * **台帳を直接読む。** `ManagerSummary` 経由にすると、要約に載せ忘れた項目が
 * 「台帳にも無い」ことになって、どちらの層の抜けなのか分からなくなる。
 */
async function jobOf(stores: Stores, managerId: string) {
  return (await stores.jobs.listJobs()).find((job) => job.id === managerId);
}

/**
 * クローンの受信箱へ届いた `kind: 'report'` の本文を、届いた順に。
 *
 * **枠の知らせ（`usage_notice`）も同じ `kind: 'report'` で降りてくる**
 * （`manager.ts` の `case 'usage_notice'`）。しかも runner は同じ `dispatch` の中で
 * **知らせ → 報告**の順に emit するので、`find` で最初の1本を取ると枠の知らせを
 * 「ターンの報告」として読んでしまう。だから件数で待って、順序で選ぶ。
 */
async function reportTexts(inbox: InboxEvent[], expected: number): Promise<string[]> {
  return await vi.waitFor(() => {
    const found = inbox.filter(
      (entry) => entry.type === 'manager_message' && entry.kind === 'report',
    );
    if (found.length < expected) {
      throw new Error(
        `報告が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found.map((entry) => (entry as { text: string }).text);
  });
}

describe('マネージャーの報告 — SDK のエラーを報告として扱わない', () => {
  it('assistant.error が付いた本文は報告に混ぜず、失敗として包んで上げる', async () => {
    const s = setup();
    const started = await s.pool.start({ request: 'ログイン周りを直して' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // 実機の形: 上限の文言は assistant メッセージとして届き、`error` が付く。
    // その後の `result` は成功で返る（＝印を見ないと成功と区別が付かない）。
    await session.say('途中まではここまでやった');
    await session.say(ORG_SPEND_LIMIT, { error: 'billing_error' });
    await session.finish('');

    // 枠の知らせ（1本目）＋ ターンの報告（2本目）。順序は runner の dispatch が
    // 決めている（上の `reportTexts` の doc）。
    const texts = await reportTexts(s.inbox, 2);
    expect(texts[0]).toContain('利用上限に当たった');
    const text = texts[1] ?? '';

    // **本文の先頭で「応答ではない」と言い切っている。**
    expect(text).toContain('応答を返さずに終わった');
    expect(text).toContain('billing_error');
    // SDK の文言は言い換えずそのまま残す（人間が検索できる形）。
    expect(text).toContain(ORG_SPEND_LIMIT);
    // 途中まで出ていた本文は捨てない（次に何を頼み直すかの材料）。
    expect(text).toContain('途中まではここまでやった');
    // ただし**印の付いた本文が「マネージャーが喋ったこと」の側に混ざっていない**。
    // 混ざっていれば `（失敗する前に出ていた本文）` の後ろに現れる。
    const partial = text.split('（失敗する前に出ていた本文）')[1] ?? '';
    expect(partial).toContain('途中まではここまでやった');
    expect(partial).not.toContain(ORG_SPEND_LIMIT);

    // 台帳にも「報告ではなく失敗」として残る（`status` では表せない事実）。
    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (!found?.lastFailure) throw new Error('台帳にまだ載っていない');
      return found;
    });
    expect(job.lastFailure).toMatchObject({ code: 'billing_error', via: 'assistant_error' });
    // セッションは生きているので `status` は倒さない（話しかければ続く）。
    expect(job.status).toBe('done');

    await s.pool.stop();
  });

  it('subtype:success でも is_error が立っていれば報告として扱わない', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // `isSuccessResult`（台帳の問い）はこの回を成功として通す。
    await session.finish(ORG_SPEND_LIMIT, { isError: true });

    const texts = await reportTexts(s.inbox, 2);
    const text = texts[1] ?? '';
    expect(text).toContain('応答を返さずに終わった');
    expect(text).toContain('result_is_error');

    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (!found?.lastFailure) throw new Error('台帳にまだ載っていない');
      return found;
    });
    expect(job.lastFailure?.via).toBe('result_is_error');

    await s.pool.stop();
  });

  it('成功したターンでは包まず、台帳の lastFailure も消える（「直近」の意味を守る）', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '2回に分けて答えて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // 1回目は失敗（印が立つ）。
    await session.finish(ORG_SPEND_LIMIT, { isError: true });
    await vi.waitFor(async () => {
      const job = await jobOf(s.stores, started.managerId);
      if (!job?.lastFailure) throw new Error('まだ失敗が載っていない');
      return job;
    });

    // 2回目は成功。**印が残ったままだと、生きているマネージャーに過去の失敗が
    // 貼り付いて見える。**
    await session.say('直した');
    await session.finish('直した');

    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (found?.lastReport !== '直した') throw new Error('2回目の報告がまだ載っていない');
      return found;
    });
    expect(job.lastFailure).toBeUndefined();
    expect(job.lastReport).not.toContain('応答を返さずに終わった');

    await s.pool.stop();
  });
});
