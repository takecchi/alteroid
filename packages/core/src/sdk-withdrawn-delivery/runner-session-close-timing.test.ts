import { fileURLToPath } from 'node:url';

import type { Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from '../runner.js';
import type { RunnerEvent } from '../runner-protocol.js';

import {
  assertHealthyFakeCliExit,
  controlResponseDelivered,
  waitForFakeCliExit,
} from './log-wait.js';

/**
 * **`RunnerSession` を、本物の SDK の `query()` と偽 CLI（`./fake-cli.mjs`）
 * を通して実際に動かし、`settled` イベントの `withdrawn`（PR #1596）と
 * 「CLI へ control_response が届かない」が同じ経路で一致することを固定する。**
 *
 * ## 何を測っているか
 *
 * `host.stop(managerId)` を、未決の許可確認（`canUseTool` 経由の `ask`）が
 * 在る状態で呼ぶ。`runner.ts` の `stop()` はこのとき
 * `#settleAll(reason); #wakeInput(); this.#query?.close();` を await を
 * 挟まずに呼ぶ（Issue #1586 が指摘した並び）。
 *
 * 既存の歯（`runner-stop-finish-order.test.ts` 等）は、偽 SDK の足場が
 * `canUseTool` を直接呼び出す形なので、`handleControlRequest` /
 * `cleanupPerformed` という SDK 内部の窓を一度も通らない——ここが違う。
 * **ここでは `queryFn` に本物の `query()` を薄くラップしたものを渡し、
 * `pathToClaudeCodeExecutable` を偽 CLI へ差し替える。** `canUseTool` を
 * 起こすのは `RunnerSession` 自身の `#onPermission` ではなく、偽 CLI が
 * 実際に送ってくる `control_request(subtype=can_use_tool)` である。
 *
 * 固定するのは次の一致——
 * 1. `settled` イベントに `withdrawn: { reason }` が載る（PR #1596 の記録）
 * 2. その同じ回で、偽 CLI の受信ログに `control_response` が一度も現れない
 *    （Issue #1586 が言う「CLI へ届いていない」という実体）
 *
 * ## 何を測っていないか
 *
 * - **`queryFn` はテスト用の口である**（`AGENTS.md` 地雷表「provider の境界を
 *   `queryFn`… で作る」の注記どおり）。ここでの差し替えは
 *   `pathToClaudeCodeExecutable` と `env` だけで、`buildManagerSessionOptions`
 *   が組み立てる他の `Options`（`canUseTool` / `systemPrompt` / `agents` 等）は
 *   一切変えていない——本番の `#open()` が呼ぶ形をそのまま通す
 * - **`childUser` は設定していない。** コンテナ構成（`spawnAsUser`）は経由
 *   しない——ここで見るのは SDK 側の control プロトコルの窓であって、
 *   別 UID での spawn ではない
 * - `runner-stop-finish-order.test.ts` が固定している「経路A（`stop()`）と
 *   経路B（`#finish` 自然終了）で並びが同じか」は、ここでは経路A（`stop()`）
 *   しか踏んでいない
 * - タイミングの数値・「偽 CLI が早く死んだだけ」との区別（`assertHealthyFakeCliExit`）
 *   は `real-sdk-close-timing.test.ts` の doc と同じ断りが掛かる——ここでは
 *   `FAKE_CLI_EXIT_AFTER_MS` を渡していないので、偽 CLI 自身の既定
 *   （保険として 15000ms。正常系は stdin end で先に終わる）がそのまま効く
 */
const FAKE_CLI_PATH = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

/** `buildManagerSessionOptions` が組み立てた `Options` はそのまま通し、`pathToClaudeCodeExecutable` / `env` だけ上書きする。 */
function wrapQueryFnForFakeCli(logPath: string): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }): Query => {
    const options = params.options ?? {};
    return query({
      prompt: params.prompt as never,
      options: {
        ...options,
        pathToClaudeCodeExecutable: FAKE_CLI_PATH,
        env: {
          ...(options.env ?? process.env),
          FAKE_CLI_LOG: logPath,
          FAKE_CLI_ASK_REQUEST_ID: 'ask-1',
        },
      },
    });
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('RunnerSession を通した stop(): settled.withdrawn と「CLI へ届かない」が一致する（#1586 / #1596）', () => {
  it('stop() で畳むと、settled に withdrawn(reason) が載り、かつその回の control_response は偽 CLI に届かない', async () => {
    const dir = makeTempDirSync('sdk-withdrawn-delivery-runner-');
    const logPath = `${dir}/fake-cli.log`;
    const events: RunnerEvent[] = [];

    let resolveAsk: (() => void) | null = null;
    const askSeen = new Promise<void>((resolve) => {
      resolveAsk = resolve;
    });

    const host = createRunnerHost({
      runnerId: 'runner-sdk-withdrawn-delivery-test',
      workspacePath: dir,
      emit: (event) => {
        events.push(event);
        if (event.type === 'ask') resolveAsk?.();
      },
      queryFn: wrapQueryFnForFakeCli(logPath),
      permissionMode: 'default',
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-withdrawn-delivery', request: '調べて', cwd: dir });

    // 偽 CLI が control_request(can_use_tool) を送り、RunnerSession の
    // #onPermission がそれを受けて 'ask' を emit するまで待つ。
    await askSeen;

    // **ここが Issue #1586 の並びそのもの。** stop() の内部で
    // #settleAll(reason) → #wakeInput() → this.#query?.close() が
    // await を挟まずに呼ばれる。
    await host.stop('mgr-withdrawn-delivery');

    const settledEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'settled' }> => event.type === 'settled',
    );
    expect(settledEvent).toBeDefined();
    expect(settledEvent?.withdrawn?.reason).toBeTruthy();

    // **足場が壊れていないことを、届いたかを見る前に確かめる**（レビュー
    // 指摘。`real-sdk-close-timing.test.ts` の doc と同じ理由）。
    const log = await waitForFakeCliExit(logPath);
    assertHealthyFakeCliExit(log);

    expect(
      controlResponseDelivered(log),
      'SDK の内部が変わった。#1596 の withdrawn の前提（settle → close() を await なしで並べると ' +
        'control_response が CLI へ届かない）を見直せ。',
    ).toBe(false);
  }, 10_000);
});
