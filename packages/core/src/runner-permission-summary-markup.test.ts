import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **issue #287 の残りの範囲に立てる歯。**
 *
 * `packages/core/src/manager.ts` の `case 'ask'` は、`event.kind ===
 * 'permission'` のときだけ `manager_message` に `markup: 'none'` を立てる。
 * これは「runner.ts の `#onPermission` が組み立てる `summary` は Markdown の
 * 記法として書かれていない」という**事実を、`kind` という構造化された欄から
 * 推し量る**形であって、`summary` の中身そのものは見ていない。
 *
 * **⚠️ だから runner.ts 側がその字面を変え、Markdown の記法（`` ` `` や `**`
 * など）を使い始めたら、`manager.ts` の対策は黙って前提を失う。** この歯は
 * その「黙って外れる」を黙らせない — `#onPermission` を実際に動かして
 * `permission` の `ask` を1本起こし、**Markdown の特殊文字を含まない良性の
 * 入力**（`{ a: 1 }`）を与えたときの `summary` をバイト単位で固定する。誰かが
 * `` `${toolName} の実行許可: ${brief(input)}` ``（`runner.ts` の
 * `#onPermission`）へ `` ` `` や `**` を足した瞬間にここが落ちる。
 *
 * **`runner.ts` 本体はこの PR では変更しない。** この歯はそれを守るために
 * 追加しただけで、対象の実装には触れていない。
 */

/** マネージャー側の SDK の代わり。`canUseTool` を外から任意の入力で叩けるようにする。 */
function fakeManagerSdk() {
  const sessions: {
    options: Options;
    ask: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};

    sessions.push({
      options,
      ask(tool, input) {
        const canUseTool = options.canUseTool as CanUseTool;
        return canUseTool(tool, input, {
          signal: new AbortController().signal,
          requestId: 'req-summary-markup',
          toolUseID: 'tool-summary-markup',
        } as never) as Promise<PermissionResult>;
      },
    });

    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
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

describe('runner.ts の #onPermission が組み立てる summary（issue #287）', () => {
  it('良性の入力（{"a":1}）での summary をバイト単位で固定する', async () => {
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

    await pool.start({ request: '確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // Markdown の記法に当たる文字（` * # _ [ ] など）を一切含まない入力。
    void session.ask('Bash', { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission' });
    // **ここがこの歯の本体。** `brief()` は `JSON.stringify` なので
    // `{ a: 1 }` は `{"a":1}` になる（`runner.ts` の `brief()` の実装）。
    expect((event as { text: string }).text).toBe('Bash の実行許可: {"a":1}');

    await pool.stop();
  });
});
