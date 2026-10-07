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

const FAKE_CLI_PATH = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

interface Harness {
  q: Query;
  logPath: string;
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

  // 文字列ではなく非同期反復子にする: 文字列プロンプトだと SDK が `isSingleUserTurn` を立て、`result` を受けた時点で自分から `endInput()` を呼んで畳み始めるため
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
      // 親の env を丸ごとは渡さない: 渡すのは `PATH` と `FAKE_CLI_LOG` だけ。`PATH` が無いと SDK の spawn が `node` を解決できず起動しないため
      env: { PATH: process.env.PATH ?? '', FAKE_CLI_LOG: logPath },
      canUseTool: () =>
        new Promise<PermissionResult>((resolve) => {
          resolveAsk?.(resolve);
        }),
    },
  });

  void (async () => {
    try {
      for await (const message of q) {
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
