import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone, REDELIVERY_COUNT_PREFIX_B } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #1744（負債1「ハブの順序」の一部）。`Clone#pump` が `validity` の
 * `#notices.set` の直後・条件付きで呼ぶ `#noteRedeliveryPredicateHitB`
 * （issue #1374。(B) の述語が当たってターンを起こしたことを、日誌へ1行だけ
 * 数える跡として残す）の位置を characterization test で固定する。
 *
 * ## なぜ2本の PR（#1914 / #1931）が確かめずに持ち越したか
 *
 * `clone-notices-order.test.ts` の doc（逐語）: 「`#noteRedeliveryPredicateHitB`
 * は private メソッドで、`CloneNotices.prototype.set` のような prototype 越しの
 * spy を当てる経路が無い」。あちらの歯は `CloneNotices#set` という**公開 API**
 * 越しの順序だけを固定しており、private メソッドの中身（`#journal` 呼び出し）は
 * 観測できない。
 *
 * **この歯は spy を使わない。** PR #1914（`#foldClosedRedelivery`）・PR #1931
 * （`#handle` の残り4分岐）と同じ手 —— `stores.journal.append` と偽 SDK の
 * `reply` を薄く包み、実際に書かれた日誌・実際にモデルへ渡った入力を `order`
 * 配列で観測する。private かどうかは関係ない —— 見ているのは外から見える
 * 副作用（ストアへの書き込み・モデルへの入力）だけである。
 *
 * ## 下調べ（`clone.ts` の `#pump`、`validityNotice` の set 以降）
 *
 * 対象コード（`grep -Fn -- 'await this.#noteRedeliveryPredicateHitB(event.managerId);' packages/core/src/clone.ts`）:
 *
 * ```
 * this.#notices.set('validity', validityNotice);
 * // …
 * if (validityNotice !== '' && event.type === 'manager_message') {
 *   await this.#noteRedeliveryPredicateHitB(event.managerId);
 * }
 * this.#notices.set('superseded', await this.#supersededNoticeFor(batch)…);
 * try {
 *   …ターンを起こす（#runHumanTurn / #runManagerReportBatch / #runExternalBatch / #handle）…
 * } catch { … } finally { …#settleInboxEvent… }
 * ```
 *
 * 変異試験ハーネス（`.claude/skills/mutation-testing/`）で3つの隣接対を
 * 入れ替え、`clone-notices-order.test.ts` を含む的を絞った8ファイルと、
 * `packages/core/src/clone*.test.ts` 全45ファイル（3バッチ）を回して確かめた
 * （実測は PR 本文の表）。**3対とも全緑（＝どの歯も守っていない）だった。**
 *
 * このうち、**hitB ブロックを「superseded の set + ターンの実行一式」の後ろへ
 * 動かす対**（下の1本）だけを固定する。他の2対（`validity` の set・
 * `superseded` の set という隣接する notice との順序）は、`CloneNotices` の
 * 内部の記帳順序でしかなく、`clone-notices-order.test.ts` が既に扱っている
 * 6つの notice の順序と同型の繰り返しになるため見送った（当てすぎ回避。
 * PR #1931 が `#noteRedeliveryPredicateHitA` のゲージ行で同じ理由から見送った
 * 判断と同じ形）。
 *
 * ## なぜこの1本だけ固定するか
 *
 * 直上のコードの doc（逐語）: 「この時点から先、この反復は必ずいずれかの
 * ターンを起こす」。**hitB の日誌書き込みは、ターンの本体（`#handle` の
 * `#journalIncomingBody` や `#runInternal` によるモデル呼び出し）より前に、
 * `try` の外側で行われる。** ⟹ もしプロセスがターンの最中（モデル呼び出し中・
 * 日誌書き込み中）に落ちても、hitB の1行は既にストアへ書き終わっている
 * ——「(B) の述語が当たってターンを起こした」という事実そのものは失われない。
 *
 * **入れ替えて hitB をターンの後ろへ動かすと、この保証が逆転する。** ターンの
 * 途中でプロセスが落ちれば、実際にはターンが起きた（モデルへ入力が渡った）のに
 * hitB の計数が永久に欠落する——`#noteRedeliveryPredicateHitA` と非対称になる
 * （あちらは `#handle` の中で `#runInternal` より前に呼ばれ、同じ「ターンより先に
 * 書く」形を保っている）。
 */

const AT = '2026-08-12T00:00:00.000Z';

describe('Clone#pump — #noteRedeliveryPredicateHitB の位置（characterization。Issue #1744 の一部）', () => {
  /**
   * hitB の日誌書き込み（`REDELIVERY_COUNT_PREFIX_B` を含む1行）→
   * `#handle` の `manager_message` 分岐が書く本文追記（`#journalIncomingBody`。
   * `with: 'manager', role: 'inbound'`）→ モデルへの入力、の順で起きることを
   * 固定する。
   *
   * **`validityNotice` を非空にする条件**（`#validityNoticeFor` の doc）:
   * `event.kind === 'report'` かつ `statusAtDelivery` を名乗っており、かつ
   * 「いまの状態」と突き合わせられない（この歯では `managers.list()` を
   * 差し替えず、既定の空プールのまま——`managerId` が一覧に居ないので
   * `describeValidity` は `unknowable` を返す。`inbox-persistence.test.ts` の
   * 「起動前に stores.inbox へ直に積んだ statusAtDelivery は…」と同じ
   * 組み立て方）。
   */
  it(
    'manager_message（kind: report）で validity notice が非空になる回、' +
      'hitB の日誌書き込み → 本文追記の日誌書き込み → モデルへの入力、の順で呼ばれる',
    async () => {
      const order: string[] = [];
      const base = createMemoryStores();
      const stores: Stores = {
        ...base,
        journal: {
          ...base.journal,
          append: async (entry) => {
            if (
              entry.type === 'exchange' &&
              entry.with === 'self' &&
              entry.role === 'outbound' &&
              entry.text.includes(REDELIVERY_COUNT_PREFIX_B)
            ) {
              order.push('hitb-journal');
            }
            if (entry.type === 'exchange' && entry.with === 'manager' && entry.role === 'inbound') {
              order.push('incoming-body-journal');
            }
            return base.journal.append(entry);
          },
        },
      };

      const { fn } = fakeSdk((input) => {
        order.push('model-input');
        void input;
        return 'わかった';
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
        ]),
      });

      const event: InboxEvent = {
        type: 'manager_message',
        id: 'evt-hitb-order',
        at: AT,
        managerId: 'mgr-hitb-order',
        kind: 'report',
        text: '終わった',
        // **一覧に居ないマネージャーを名乗る。** 既定（空）の `ManagerPool` は
        // このマネージャーを一度も知らないので、`#validityNoticeFor` は
        // 「一覧に居ない」を理由に `unknowable` を返し、`describeValidity` が
        // 空文字でない断り書きを組む——これが hitB を鳴らす条件そのものである。
        statusAtDelivery: 'running',
      };
      clone.post(event);

      await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
      // **`clone.stop()` より前に読む。** stop() 自身が蒸留の内部ターンを
      // もう1本起こすので、そちらの journal 書き込みが紛れ込む前に確定させる
      // （`clone-handle-order.test.ts` の同じ注記と同じ理由）。
      expect(order).toEqual(['hitb-journal', 'incoming-body-journal', 'model-input']);

      await clone.stop();
    },
  );
});
