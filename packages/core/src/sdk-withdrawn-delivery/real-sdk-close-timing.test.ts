import { fileURLToPath } from 'node:url';

import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../../vitest.tmpdir.js';

import {
  assertHealthyFakeCliExit,
  controlResponseDelivered,
  waitForFakeCliExit,
} from './log-wait.js';

/**
 * **本物の SDK の `query()` を、`pathToClaudeCodeExecutable` で偽 CLI
 * （`./fake-cli.mjs`）に差し替えて動かし、Issue #1586 / PR #1596 の中核の
 * 前提を直接測る。**
 *
 * ## 何を測っているか
 *
 * `RunnerSession#settleAll` は `canUseTool` の Promise を**同期で** resolve
 * したうえで、**await を挟まずに** `query.close()` を呼ぶ（`runner.ts` の
 * `stop()` / `#finish()` のどちらも同じ並び）。PR #1596 はこのとき
 * `settled` イベントに `withdrawn: { reason }` を足して「CLI へは届いていない」
 * と記録した——**その前提（届かないこと）を、本物の SDK を通して測る。**
 *
 * ここでは `RunnerSession` は経由しない（下の `runner-session-close-timing.
 * test.ts` がそちらを持つ）。**ここが固定するのは SDK 単体の挙動である**:
 * `canUseTool` の Promise を同期で解いた直後に `close()` を呼ぶと、その
 * `control_response` は偽 CLI に届かない。1回でも macrotask を挟んでから
 * 閉じれば届く。
 *
 * ## 何を測っていないか
 *
 * - **`RunnerSession` は経由していない。** `#settleAll` の実装・`withdrawn`
 *   フラグの配線・`stop()`/`#finish()` の呼び出し順は、この歯では見ていない
 *   （`runner-session-close-timing.test.ts` が見る）
 * - **1マイクロタスクと2マイクロタスクの境界は測らない。** 依頼の指示
 *   （「1マイクロタスク/2マイクロタスクの境界のような、SDK の内部の段数に
 *   依存する細かい表明は入れない」）のとおり、ここで固定するのは
 *   「同期で close すれば届かない」と「マクロタスクを待てば届く」の2点だけ
 * - **CLI バイナリ本体の挙動は見ていない。** 偽 CLI は stream-json の
 *   control プロトコルの往復だけを模した node スクリプトで、本物の CLI が
 *   `deny` を受けてどう振る舞うかは分からない（Issue #1586 本文の「確かめて
 *   いないこと」のまま）
 * - **`(b)` のマクロタスク待ち（20ms）は、この器・この SDK 版での実測に
 *   基づく閾値であって、SDK が変われば動きうる。** 赤くなったらまずここを
 *   疑うこと（下の `describe` の doc）
 *
 * ## 「偽 CLI が早く死んだだけ」と区別する
 *
 * **レビュー指摘（PR #1609）: 偽 CLI の寿命が固定の短い時間だと、CI が
 * 混んでいて起動が遅いとき、settle → close() を撃つ前に偽 CLI が自分から
 * 死んでしまい、(a) が「本当は届くはずなのに、CLI がもう居ないから届かない
 * ように見える」形で誤って緑になりうる。** これは #1596 の前提が崩れていても
 * 気づけないということで、この歯の目的そのものを壊す。
 *
 * 対策は2つ——
 * 1. `fake-cli.mjs` 自身を、固定の短い寿命ではなく **SDK の `close()` が
 *    送る stdin の EOF を受けて終わる**形にした（`fake-cli.mjs` の doc）。
 *    固定寿命は「ぶら下がり防止の保険」としてだけ長く（15000ms）残してある
 * 2. `delivered/not-delivered` を見る**前に**、`assertHealthyFakeCliExit()`
 *    で「ask を送った」「保険の寿命ではなく stdin end で終わった」ことを
 *    確かめる。**この表明が落ちたら、それは前提の変化ではなく足場の壊れで
 *    あり、`delivered` の値をそのまま読んではいけない**
 *
 * ## 足場について
 *
 * `fake-cli.mjs` は `/tmp/mgr-c58f4f73/w1586/repo` の枝 `test/1586-repro`
 * （未 push）に置かれていた手作業の再現ドライバ（`repro-driver.mjs` /
 * `fake-cli.mjs`）を、vitest の歯として書き直したものである。**手作業での
 * 実測は Issue #1586 のコメントに残っている**（2026-09-25 観測、SDK
 * `0.3.282`）——ここでは `0.3.283`（`pnpm-lock.yaml` の版）で同じ前提を
 * 自動化して固定する。
 */
const FAKE_CLI_PATH = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

interface Harness {
  q: Query;
  logPath: string;
  /** `canUseTool` が呼ばれるまで待つ。呼ばれたら settle 用の関数を返す。 */
  waitForAsk: () => Promise<(answer: PermissionResult) => void>;
  close: () => void;
}

function startQuery(): Harness {
  const dir = makeTempDirSync('sdk-withdrawn-delivery-');
  const logPath = `${dir}/fake-cli.log`;

  let resolveAsk: ((settle: (answer: PermissionResult) => void) => void) | null = null;
  const askPromise = new Promise<(answer: PermissionResult) => void>((resolve) => {
    resolveAsk = resolve;
  });

  // **文字列ではなく非同期反復子にする。** 文字列プロンプトだと SDK が
  // `isSingleUserTurn` を立て、`result` を受けた時点で SDK 自身が
  // `endInput()` を呼んで先に畳み始める（手作業の再現ドライバが実測で
  // 突き止めた落とし穴——`repro-driver.mjs` のコメントに逐語で残っている）。
  // ここでは `result` を送らないので実害は薄いが、`RunnerSession` の
  // 実際の使い方（複数ターンにまたがるストリーミング入力）に形を揃える。
  async function* promptStream(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;
    await new Promise<never>(() => {
      // 明示的に close() されるまで終わらない。
    });
  }

  const q = query({
    prompt: promptStream(),
    options: {
      cwd: dir,
      permissionMode: 'default',
      pathToClaudeCodeExecutable: FAKE_CLI_PATH,
      env: { ...process.env, FAKE_CLI_LOG: logPath },
      canUseTool: () =>
        new Promise<PermissionResult>((resolve) => {
          resolveAsk?.(resolve);
        }),
    },
  });

  // ストリームを読み進めないと control_request が処理されない
  // （`for await` が transport の読み取りループを駆動する）。
  void (async () => {
    try {
      for await (const message of q) {
        // 中身は見ない。読み進めること自体が目的。
        void message;
      }
    } catch {
      // close() 後の読み取りエラーは無視する（本テストが見るのは fake-cli の
      // ログだけである）。
    }
  })();

  return {
    q,
    logPath,
    waitForAsk: () => askPromise,
    close: () => {
      try {
        q.close();
      } catch {
        // 既に閉じている場合は無視。
      }
    },
  };
}

async function waitTicks(mode: 'sync' | 'macrotask'): Promise<void> {
  if (mode === 'sync') return;
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('SDK 単体: settle → close() の間に何を挟むかで control_response の到達が変わる（#1586 / #1596 の前提）', () => {
  const harnesses: Harness[] = [];

  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.close();
  });

  it(
    '(a) 何も挟まずに close() すると、deny の control_response は偽 CLI に届かない ' +
      '——ここが崩れたら（届くようになったら）赤くなる。SDK の内部が変わった。' +
      '#1596 の withdrawn の前提（「CLI へ届いていない」という記録）を見直せ。',
    async () => {
      const harness = startQuery();
      harnesses.push(harness);
      const settle = await harness.waitForAsk();

      settle({ behavior: 'deny', message: 'デーモンから停止を指示された。' });
      await waitTicks('sync');
      harness.close();

      const log = await waitForFakeCliExit(harness.logPath);
      // **足場が壊れていないことを、届いたかを見る前に確かめる。** ここが
      // 落ちたら「(a) の届かない」は偽 CLI が早く死んだだけの可能性があり、
      // 前提の裏付けとして使えない（レビュー指摘、上の doc）。
      assertHealthyFakeCliExit(log);

      expect(
        controlResponseDelivered(log),
        'SDK の内部が変わった。#1596 の withdrawn の前提（settle → close() を await なしで並べると ' +
          'control_response が CLI へ届かない）を見直せ。',
      ).toBe(false);
    },
    10_000,
  );

  it(
    '(b) 対照: 1回でもマクロタスクを挟んでから close() すると、control_response は届く ' +
      '——これが崩れたら、(a) の「届かない」が前提の変化ではなく足場そのものの壊れである疑いが強い。',
    async () => {
      const harness = startQuery();
      harnesses.push(harness);
      const settle = await harness.waitForAsk();

      settle({ behavior: 'deny', message: 'デーモンから停止を指示された。' });
      await waitTicks('macrotask');
      harness.close();

      const log = await waitForFakeCliExit(harness.logPath);
      assertHealthyFakeCliExit(log);

      expect(controlResponseDelivered(log)).toBe(true);
    },
    10_000,
  );
});
