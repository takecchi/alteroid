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

/** manager.ts は `kind === 'permission'` の `summary` を Markdown でないと決め打ちして `markup: 'none'` を立てる。runner.ts がここへ記法を足したら黙って外れるので、字面をバイト単位で固定する。 */
function fakeManagerSdk() {
  const sessions: {
    options: Options;
    ask: (
      tool: string,
      input: Record<string, unknown>,
      decisionReason?: string,
    ) => Promise<PermissionResult>;
  }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};

    sessions.push({
      options,
      ask(tool, input, decisionReason) {
        const canUseTool = options.canUseTool as CanUseTool;
        return canUseTool(tool, input, {
          signal: new AbortController().signal,
          requestId: 'req-summary-markup',
          toolUseID: 'tool-summary-markup',
          ...(decisionReason === undefined ? {} : { decisionReason }),
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

    void session.ask('Bash', { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission' });
    expect((event as { text: string }).text).toBe('Bash の実行許可: {"a":1}');

    await pool.stop();
  });

  it('確認に上がった理由（canUseTool の decisionReason。Bash の門の ask、issue #2884）を summary の末尾に載せる', async () => {
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

    void session.ask('Bash', { a: 1 }, '無限待ちの形（代替あり）');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = inbox.find((entry) => entry.type === 'manager_message');
    expect((event as { text: string }).text).toBe(
      'Bash の実行許可: {"a":1}\n理由: 無限待ちの形（代替あり）',
    );

    await pool.stop();
  });
});
