import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { CloneNotices } from './clone-notices.js';
import type { TurnNoticeKey } from './clone-notices.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * Issue #1744（負債1「ハブの順序」の一部。負債3の候補PRの1つ）。
 *
 * **これは characterization test である。正しさは主張しない**
 * （`runner-stop-finish-order.test.ts` の断り書きと同じ形）。固定するのは
 * 「いま実際にどう並んでいるか」だけであり、この並びが正しいかどうかは
 * この歯には判断できない。
 *
 * ## 何を固定するか
 *
 * `Clone#pump`（`clone.ts`）は、受信箱から1件（または束）を取り出すたびに、
 * ターンを回す（`#runHumanTurn` / `#runManagerReportBatch` / `#runExternalBatch` /
 * `#handle` のどれか）**前**に、`CloneNotices#set` を6回——
 * `mergedBatchTruncation`（リセット）→ `redelivery` → `commitment` → `situation` →
 * `validity` → `superseded` の順で——呼ぶ。現物は `grep -Fn --
 * "this.#notices.set('mergedBatchTruncation', '');" packages/core/src/clone.ts`
 * から辿れる（残り5回はこの直後、同じ関数の中に1本ずつ続く）。
 *
 * この歯は、その6回の呼び出し順を `CloneNotices.prototype.set` への spy で
 * タイムラインとして記録し、固定する。**production コード（`clone.ts` /
 * `clone-notices.ts` ほか）は1行も変えていない。**
 *
 * ## 固定していないもの（#1744 の下調べで「未固定」と判定した部分）
 *
 * - **`redelivery`/`commitment`/`situation`/`validity`/`superseded` の
 *   あいだに条件付きで挟まる `#noteRedeliveryPredicateHitB`
 *   （`validityNotice !== '' && event.type === 'manager_message'` のときだけ、
 *   `validity` の set の直後・`superseded` の set の前に呼ばれる——現物は
 *   `grep -Fn -- 'await this.#noteRedeliveryPredicateHitB(event.managerId);' packages/core/src/clone.ts`
 *   から辿れる）は、この歯では確かめていない。
 *   **確かめられない理由**: `#noteRedeliveryPredicateHitB` は private メソッドで、
 *   `CloneNotices.prototype.set` のような prototype 越しの spy を当てる経路が
 *   無い（private メソッドは外から参照を取れない）。この歯が固定するのは
 *   あくまで `CloneNotices#set` という**公開 API 越しに観測できる順序**だけ
 *   である。
 * - `Clone#handle`（`clone.ts` の同名メソッド）の内部にある `#sdkSession.query` の有無
 *   チェック → `#distillMemory.hasUndistilledActivity` チェック →
 *   `#distillMemory.markDistilled()` → `#runTurn` という順序は、この歯の対象外
 *   である（別の下調べ項目。時間の都合で未着手）。
 * - `#mergedHumanBatch` / `#mergedManagerReportBatch` / `#mergedExternalBatch`
 *   のうちどれが束を作るか（＝どの dispatch 先が選ばれるか）による違いは、
 *   この歯では human_message の1件だけを確認しており、他の2経路
 *   （manager report・external）でも同じ順序になるかは確認していない
 *   （束を計算する3つの関数はどれも、6回の `set` より前で呼ばれる——現物は
 *   `grep -Fn -- 'const mergedHuman = this.#mergedHumanBatch(event);' packages/core/src/clone.ts`
 *   から辿れる——ので、経路によって順序が変わる理由は現物からは読めないが、
 *   実測はしていない）。
 */

/** `clone.test.ts` の `fakeSdk` を大きく簡略化したもの。この歯が要るのは
 * 「1件の human_message が1ターンとして最後まで処理された」ことだけなので、
 * 既存のオプション一式（`modelUsage` / `resultFor` 等）は要らない。 */
function fakeSdk(): { fn: typeof sdkQuery } {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        void message;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'わかった' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'わかった',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        return;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn };
}

describe('Issue #1744: Clone#pump — #notices.set の呼び出し順（characterization）', () => {
  it(
    'human_message を1件処理する反復では、mergedBatchTruncation のリセット→' +
      'redelivery→commitment→situation→validity→superseded の順で ' +
      '#notices.set が呼ばれる（noteRedeliveryPredicateHitB は human_message では ' +
      '条件を満たさないので鳴らない・上の doc を参照）',
    async () => {
      const order: TurnNoticeKey[] = [];
      // **`CloneNotices.prototype.set` を包む。中身（`#turn` への代入）は
      // 元の実装をそのまま呼ぶので、`Clone` から見た挙動は1文字も変わらない
      // ——変えているのは「呼ばれた順を配列へ積む」という観測だけである。**
      const originalSet = CloneNotices.prototype.set;
      // 6回目（`superseded`）が積まれた瞬間に解決する——壁時計のポーリングを
      // 持たない（`clone.test.ts` の `waitFor` と同じ考え方。ここでは spy
      // 自身が同期の通知点になるので、専用の待ち行列を組む必要が無い）。
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      vi.spyOn(CloneNotices.prototype, 'set').mockImplementation(function (
        this: CloneNotices,
        key: TurnNoticeKey,
        text: string,
      ) {
        order.push(key);
        const result = originalSet.call(this, key, text);
        if (key === 'superseded') resolveDone?.();
        return result;
      });

      const stores = createMemoryStores();
      const { fn } = fakeSdk();
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        // 委譲先も偽物にしておく（`clone.test.ts` の `setup()` と同じ理由——
        // ここで確かめたいのは `#pump` の通知の順序だけであり、誤って本物の
        // SDK を起こさないようにする）。
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      clone.subscribe('conv-1', () => undefined);

      clone.post(humanMessage('順序を確かめる'));
      await done;

      expect(order).toEqual([
        'mergedBatchTruncation',
        'redelivery',
        'commitment',
        'situation',
        'validity',
        'superseded',
      ] satisfies TurnNoticeKey[]);

      await clone.stop();
    },
  );
});
