import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #1744（負債1「ハブの順序」）の残り —— `Clone#runTurn` と、`#handle` の
 * うち #1914（PR）が当たっていない型（`human_answer` / `timer` /
 * `self_initiative`）の中の順序を characterization test で固定する。
 *
 * 前任（#1808 / #1876 / #1914）と同じ方針: 構造の切り出しはしない。本体
 * （`clone.ts`）は1文字も変えていない。
 *
 * ## なぜこの3本か
 *
 * `.claude/skills/mutation-testing/` のハーネスで、各分岐の隣り合う
 * await/副作用の対を入れ替える変異を当て、`packages/core/src/clone*.test.ts`
 * 全44ファイル（+ 分岐ごとに関連する追加ファイル）を回して確かめた
 * （実測は PR 本文の表）。**全部緑（＝どの歯も守っていない）だった候補の
 * うち、順序に意味があって「当てすぎ」にならないもの**をここで固定する。
 *
 * ## 待ち方
 *
 * 壁時計の締め切りで打ち切らない（Issue #1220）。独自の `waitFor` は持たず、
 * `clone-test-harness.ts` の `waitFor` を使う —— 打ち切りの根拠が壁時計では
 * なく「テストが終わったか」（`afterEach` が進める `testEpoch`）である形。
 * 「起きない」と言い切らない理由（#890）も、そちらの doc にある逐語のとおり。
 */

const AT = '2026-08-12T00:00:00.000Z';

/**
 * `order` へ印を積むだけの偽 SDK。**1メッセージ受け取るごとに `assistant` →
 * `result` を返す1本道**（`clone-turn-input.test.ts` の `fakeSdk` と同じ骨格）。
 * `label` は印の名前（複数のテストで使い回すので、生成のたびに名前を変えられる
 * ようにしてある）。
 */
function markingSdk(order: string[], label: string): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-order',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        void message;
        order.push(label);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-order',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-order',
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
}

describe('Clone#handle — 未着手だった分岐の順序（characterization。Issue #1744 の一部）', () => {
  /**
   * `#handle` の `'timer'` 分岐: `turnInputEntry` の日誌書き込み →
   * （ターンの実行。モデルへ入力が渡る）→ `completeScheduledRun`、の順。
   *
   * **この1本で2つの隣り合う対を測る。**
   * 1. `await this.#journal(turnInputEntry(...))` ⇄
   *    `await this.#runInternal(buildTimerPrompt(...))`
   * 2. `await this.#runInternal(...)` ⇄
   *    `if (plan !== null) await this.#completeScheduledRun(...)`
   *
   * 変異試験の実測（PR 本文）: 対1・対2 とも、入れ替えても
   * `packages/core/src/clone*.test.ts` 全44ファイルが緑のまま（歯が無い）。
   *
   * **なぜ対2に意味があるか（`clone.ts` の doc の逐語）**:
   * 「終わったことを記録するのはここ。claim（引き受けた印）とは別に置く。
   * ここまで来ないうちに器が落ちたら、印が残っているので配り直される」
   * —— `completeScheduledRun` を `runInternal` より先に呼ぶと、ターンが
   * 器の落下で終わらなかった回まで「終わった」と記録してしまい、次の起動で
   * 配り直されなくなる（取りこぼしが永久に消える）。
   */
  it('timer: turnInputEntry の書き込み → モデルへの入力 → completeScheduledRun、の順で呼ばれる', async () => {
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
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: timer')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
      schedules: {
        ...base.schedules,
        completeRun: async (kind, at, cause) => {
          order.push('complete-run');
          return base.schedules.completeRun(kind, at, cause);
        },
      },
    };

    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て、着手できるものから進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });

    const fn = markingSdk(order, 'model-input');
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
      type: 'timer',
      id: 'evt-timer-order',
      at: AT,
      kind: 'issue-round',
      cause: 'manual',
    };
    clone.post(event);

    await waitFor(() => order.includes('complete-run'), 'completeScheduledRun が呼ばれる');
    // **`clone.stop()` より前に読む。** stop() 自身が蒸留の内部ターンをもう1本
    // 起こすので、そちらの 'model-input' が紛れ込む前に確定させる。
    expect(order).toEqual(['journal-marker', 'model-input', 'complete-run']);

    await clone.stop();
  });

  /**
   * `#handle` の `'human_answer'` 分岐: 入力の印（`turnInputEntry`。
   * `type: 'human_answer'`）の日誌書き込み → `#runTurn` の呼び出し
   * （＝モデルへ入力が渡る）、の順。
   *
   * 変異対象: `await this.#journal(...)` ⇄ `await this.#runTurn(...)`。
   * 実測（PR 本文）: 入れ替えても `clone-answer-action-stamp.test.ts` /
   * `approval-trace.test.ts` を含む関連ファイルすべてが緑（歯が無い）。
   */
  it('human_answer: 入力の印の日誌書き込み → モデルへの入力、の順で呼ばれる', async () => {
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
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: human_answer')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
    };

    await stores.jobs.putApproval({
      id: 'ap-order-1',
      createdAt: '2026-08-12T00:00:00.000Z',
      question: '本番へ出してよいか',
    });

    const fn = markingSdk(order, 'model-input');
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
      ]),
    });

    await clone.answerApproval('ap-order-1', '(b) でお願いします');

    await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
    expect(order).toEqual(['journal-marker', 'model-input']);

    await clone.stop();
  });

  /**
   * `#handle` の `'self_initiative'` 分岐: `turnInputEntry` の日誌書き込み →
   * `#runInternal` の呼び出し（＝モデルへ入力が渡る）、の順。
   *
   * 変異対象: `await this.#journal(...)` ⇄
   * `await this.#runInternal(buildSelfInitiativePrompt(...))`。
   * 実測（PR 本文）: 入れ替えても `clone*.test.ts` 全44ファイルが緑（歯が無い）。
   */
  it('self_initiative: turnInputEntry の書き込み → モデルへの入力、の順で呼ばれる', async () => {
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
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: self_initiative')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
    };

    const fn = markingSdk(order, 'model-input');
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
      type: 'self_initiative',
      id: 'evt-self-order',
      at: AT,
      reason: '定期 tick: 記憶にある目的から次にやることを決める',
    };
    clone.post(event);

    await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
    expect(order).toEqual(['journal-marker', 'model-input']);

    await clone.stop();
  });
});
