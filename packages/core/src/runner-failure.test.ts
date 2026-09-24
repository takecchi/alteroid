import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

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
  /** `parentToolUseId` を渡すと作業者（Task の中）の発言になる（#1373）。 */
  say(text: string, options?: { error?: string; parentToolUseId?: string }): Promise<void>;
  /** 1ターンを畳む。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
  /**
   * `system/task_started` を流す（#1373）。`runner-wakeup.test.ts` の同名の
   * ヘルパーと同じ形（`task_id` を持つ `system` メッセージ）を踏襲する。
   */
  taskStarted(taskId: string): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    // **`manager.test.ts` の偽 SDK と同じ待ち方にしてある。** 自前のポーリング
    // ループにすると、`close()` で畳めず `pool.stop()` の後もジェネレータが生き
    // 残る（テストが終わらない）。実績のある形を写す。
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    // **#206: `result` の `uuid` は実機では毎ターン別の値になる。** `runner.ts`
    // はこれを `reportId` としてそのまま運び、`manager.ts` はそれで冪等化する
    // ので、この fake が固定値を返すと2回目以降の `finish()` が冪等化で
    // 握りつぶされる（`manager.test.ts` の同種の fake と同じ直し方）。
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}-${sayOptions.parentToolUseId ?? 'main'}-${Math.random()}`,
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
          uuid: `uuid-result-${(finishes += 1)}`,
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskStarted(taskId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
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
  return await vi.waitFor(
    () => {
      const found = inbox.filter(
        (entry) => entry.type === 'manager_message' && entry.kind === 'report',
      );
      if (found.length < expected) {
        throw new Error(
          `報告が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
        );
      }
      return found.map((entry) => (entry as { text: string }).text);
    },
    // **失敗した回の報告は機構が合成した知らせ（`synthesized: 'turn_failed'`）
    // として合流窓（既定3000ms）に積まれる**（「一枠落ち一合図」）。`vi.waitFor`
    // の既定（1000ms）ではこの窓を待ちきれないので明示的に伸ばす。
    { timeout: 4000 },
  );
}

/**
 * **2件目以降の完全な重複が、日誌へ「畳んだ」と記録されるまで待つ。**
 *
 * PR #946（`fix/429-notice-amplification-cap`。窓をまたいだ `turn_failed` の
 * 完全な重複を畳む）が入ったので、`本文が完全に同一な turn_failed` を
 * 2回連続で起こしても**受信箱には1件しか立たない**（2件目は畳まれて
 * 日誌にだけ残る）。この関数が導入される前は `reportTexts(s.inbox, 2)` を
 * バリアに使っていたが、それは「2件目の `finish()` がここまで処理された」
 * ことを確かめるための代用でしかなく、この2本のテストが実際に検算している
 * のは受信箱の件数ではなく**stderr の集計行**（`captureStderr` で取った
 * `lines`）である。畳まれた事実は受信箱ではなく日誌に残るので、バリアも
 * そちらへ合わせる（`manager-synthesized-notices.test.ts` の「配らなかった
 * 束は、1束ごとに日誌へ1行残る」と同じ形）。
 */
async function waitForSuppressedTurnFailed(stores: Stores, count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const entries = await stores.journal.list({ types: ['exchange'] });
      const suppressed = entries.filter((entry) =>
        JSON.stringify(entry).includes('受信箱へは回さず数だけ残した'),
      );
      if (suppressed.length < count) {
        throw new Error(
          `畳んだ記録が ${String(count)} 件届いていない（いま ${String(suppressed.length)} 件）`,
        );
      }
    },
    { timeout: 4000 },
  );
}

/**
 * **回し手が原理的に聞けない失敗を数える（Issue #393）。**
 *
 * 回し手の入口は `usage_notice` / `rate_limit` の2つだけなので、
 * `classifyUsageNotice` が分類できなかった失敗は**回し手に届かない**。資格
 * （`CLAUDE_CODE_OAUTH_TOKEN`）が1つも無い器で起こしたときがその形で、
 * マネージャーが落ち続けてもプールは何も検知しない。
 *
 * **ここが固定するのは「数えていること」と「出す判断を変えていないこと」の
 * 両方である。** 後者を落とすと、計器のつもりで挙動を変えたことに気づけない。
 */
describe('分類できなかった失敗の跡（回し手には届かない側）', () => {
  it('枠の文言として分類できた回は跡を残さない（出す判断を変えていない）', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      // 実機で観測された文言。**分類できる**ので `usage_notice` が出る。
      // **`usage_notice` とターンの報告（`synthesized: 'turn_failed'`）は
      // 同じ1つの出来事の別の顔として合流窓で1件にまとまる**（「一枠落ち
      // 一合図」）ので、受信箱に立つのは1件である。
      await session.finish(ORG_SPEND_LIMIT, { isError: true });
      await reportTexts(s.inbox, 1);
      await s.pool.stop();
    });
    expect(lines.join('\n')).not.toContain('枠の文言として分類できなかった');
  });

  it('分類できなかった回は初出で1行出し、同じ組の2回目は出さない', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      // **本文が空**＝分類にかける材料が1文字も無い。資格ゼロの器で起こした
      // ときと同じ形である（`is_error` は立つが、枠の文言はどこにも出ない）。
      // **2回とも単独の断片**（伴走する `usage_notice` が無い）なので、
      // それぞれ独立した合流窓として扱われる。**ただし本文はどちらも逐語で
      // 同一なので、PR #946（窓をまたいだ `turn_failed` の完全な重複を畳む）
      // により2件目は受信箱へは回らず、日誌にだけ「畳んだ」と残る**
      // （`waitForSuppressedTurnFailed` の doc）。ここで検算したいのは受信箱の
      // 件数ではなく下の stderr 集計（`first`）なので、バリアも畳んだ記録の
      // 側で待つ。
      await session.finish('', { isError: true });
      await reportTexts(s.inbox, 1);
      await session.finish('', { isError: true });
      await waitForSuppressedTurnFailed(s.stores, 1);
      await s.pool.stop();
    });
    const first = lines.filter((line) => line.includes('（初出。**回し手には届かない**）'));
    // **2回起きても初出は1行きり。** 全件出すと跡それ自体がログを埋める。
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('via=result_is_error');
    expect(first[0]).toContain('code=success');
    // **本文を載せていない**（テスト出力に秘密が混ざった前例がある。
    // railway/setup.test.ts の差分アサーション、#52）。
    expect(first[0]).not.toContain(ORG_SPEND_LIMIT);
  }, 12_000);

  it('stop() で畳まれても件数が出る（この経路は #finish を通らない）', async () => {
    // **ここが要点である。** `pool.stop()`（器の入れ替えと `manager_stop` が通る道）は
    // `RunnerSession#finish()` を通らない —— `stop()` の中に逐語で
    // 「この経路は `#finish` を通らないので、ここで閉じないと開いたままの区間が
    // 黙って消える」と書いてある。**合計を `#finish` にだけ置くと、この経路の
    // 量だけが黙って失われる**（初出の1行は出ているので、失われたことに気づけない）。
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('', { isError: true });
      await reportTexts(s.inbox, 1);
      await session.finish('', { isError: true });
      // **2件目は PR #946 の窓またぎ畳み込みで受信箱へは回らない**
      // （`waitForSuppressedTurnFailed` の doc）。ここが検算したいのは
      // stderr の合計行（`summary`）であって受信箱の件数ではないので、
      // バリアも畳んだ記録の側で待つ。
      await waitForSuppressedTurnFailed(s.stores, 1);
      await s.pool.stop();
    });
    const summary = lines.filter((line) => line.includes('このセッションの合計'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('result_is_error:success×2');
  }, 12_000);
});

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

    // **枠の知らせ（`usage_notice`）とターンの報告（`synthesized: 'turn_failed'`）
    // は、同じ1つの出来事の別の顔として合流窓で1件にまとまる**（「一枠落ち
    // 一合図」）ので、受信箱に立つのは1件——その1件の中に両方の本文が入る。
    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toContain('利用上限に当たった');

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

    // **`usage_notice` と `turn_failed` は合流窓で1件にまとまる**（上のテストと
    // 同じ理由）。
    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
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

/**
 * **失敗で終わった回は「中身が無い」に畳まれない（`runner-contentless.test.ts`
 * が runner の生イベントで固定する保証を、デーモンを経由した見え方でも固定する）。**
 *
 * `said`（実際に喋った本文）も SDK の `result` も空という、単独なら
 * `contentless: true` になる条件が揃っていても、`failure` が付く回は
 * `failedReportText()` が必ず本文を作るので `contentless` は立たない
 * （`runner-protocol.ts` の doc）。ここが誤って畳まれると、支出上限や
 * エラーで死んだ回がクローンに一切知らされなくなる — 待つ／挑み直すの
 * 判断材料が消える。
 */
describe('失敗で終わった回は畳まれない', () => {
  it('本文が丸ごと空（said も result も空）でも、失敗した回はクローンへ届く', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // `say()` を1度も呼ばない。`is_error` だけを立てて、result も空にする。
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toContain('応答を返さずに終わった');
    expect(texts[0]).toContain('result_is_error');

    await s.pool.stop();
  });
});

/**
 * **#1373: 委譲の下で動く作業者が枠（429）に当たったとき、デーモンはそれを
 * 委譲本体（マネージャー）のターンの失敗として名乗る。** 本体が枠に当たった
 * 場合と文言が同じなので、クローン側からはどちらの層が塞がっているかが
 * 区別できない。
 *
 * **ここで足すのは判定ではなく状況証拠である。** SDK の `result` は「誰の
 * 言葉が最後だったか」を運べる形をしていないので、`describeManagerFailure`
 * や文言からの読み取りは増やさない（Issue が明示的に禁じている）。代わりに
 * runner が「このターンの中で1度でも開いた作業者の数」を数え、`failedReportText`
 * が1以上のときだけ状況証拠の1行を足す。
 *
 * 4本の歯で固定する:
 * 1. 作業者を開いたターンが失敗で終わると、その1行が付く（N の値も検算する）
 * 2. 陽性対照A: 作業者を開いていないターンが失敗で終わっても、本文は
 *    従来と1文字も変わらない
 * 3. 陽性対照B: 作業者を開いたターンが成功で終わったら、その1行は付かない
 * 4. ターンをまたいで数が持ち越されない（前のターンで開いた作業者は、次の
 *    ターンの N に入らない）
 */
describe('失敗で終わったターンの本文に、そのターンで開いた作業者の数を添える（#1373）', () => {
  /** 作業者を開いていない・失敗したターンの本文（変更されない側の基準値）。 */
  const BASELINE_FAILURE_TEXT =
    '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

  it('作業者を2体開いたターンが失敗で終わると、本文に「作業者が2体開いていた」の1行が付く（同じ task_id の重複は1と数える）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    // 同じ task_id をもう1度観測しても、2体目としては数えない。
    await session.taskStarted('task-1');
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 2 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it('陽性対照A: 作業者を開いていないターンが失敗で終わっても、本文は従来と1文字も変わらない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // `taskStarted` を1度も呼ばない。
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(BASELINE_FAILURE_TEXT);
    expect(text).not.toContain('体開いていた');

    await s.pool.stop();
  });

  it('陽性対照B: 作業者を開いたターンが成功で終わったら、報告の本文にその1行は付かない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    // `isError` を立てない ＝ 成功で終わる。
    await session.finish('作業者からの結果を踏まえて完了した');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe('作業者からの結果を踏まえて完了した');
    expect(text).not.toContain('体開いていた');
    expect(text).not.toContain('SDK からは分からない');

    await s.pool.stop();
  });

  it('ターンをまたいで数が持ち越されない（前のターンで開いた作業者は、次のターンの N に入らない）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // 1ターン目: 作業者を1体開いて、成功で畳む。
    await session.taskStarted('task-1');
    await session.finish('1ターン目は成功した');
    await reportTexts(s.inbox, 1);

    // 2ターン目: 作業者を1体も開かずに失敗する。
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 2);
    const text = texts[1] ?? '';
    expect(text).toBe(BASELINE_FAILURE_TEXT);
    expect(text).not.toContain('体開いていた');

    await s.pool.stop();
  });

  it('作業者の発言に拒否の印が付いたターンが失敗で終わると、状況証拠の行の代わりに「作業者の発言に拒否の印が付いていた」の行が付く（種類ごとに件数で畳む）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-2' });
    await session.say('課金', { error: 'billing_error', parentToolUseId: 'toolu-2' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: rate_limit ×2 / billing_error ×1。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`,
    );
    // 作業者の拒否の文言は、マネージャーの報告本文へは混ざらない。
    expect(text).not.toContain('作業者の枠の文言');

    await s.pool.stop();
  });

  it('作業者の発言に拒否の印が付いても、ターンが成功で終わったら失敗にはならず、行も付かない（本体は作業者を立て直して進めることがある）', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('作業者を立て直して終えた');
    await session.finish('作業者を立て直して終えた');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe('作業者を立て直して終えた');
    const job = await jobOf(s.stores, started.managerId);
    expect(job?.lastFailure).toBeUndefined();

    await s.pool.stop();
  });

  it('作業者の拒否の印はターンをまたいで持ち越されない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('1回目');
    await session.finish('1回目');
    await reportTexts(s.inbox, 1);

    await session.finish('', { isError: true });
    const texts = await reportTexts(s.inbox, 2);
    expect(texts[1]).toBe(BASELINE_FAILURE_TEXT);

    await s.pool.stop();
  });
});
