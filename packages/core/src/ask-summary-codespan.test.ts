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
 * **`ask` イベントの `summary` が、Markdown として無害な形で包まれること**
 * （issue #287）。
 *
 * `summary`（`packages/core/src/runner.ts` の `#onPermission`）は少なくとも3経路
 * ——`ask` イベント → `manager.ts` の `#emit()` → 受信箱 →
 * `apps/web/app/routes/commitments.tsx` が `<Markdown>` で描く経路、
 * `record.waiting` 経由のデーモン API、`#journal` の `escalation`——を流れる。
 * このうち Markdown で描く経路（受信箱・台帳）では、`toolName`（SDK のツール名）
 * と `brief(input)`（SDK のツール引数の JSON ダンプ）にバッククォートや
 * `_word_` / `*word*` が載ると、`` `date` `` が `<code>` に、`_init_` が `<em>` に
 * 化けて**字面が黙って消える**。これは人間が allow / deny を判断する材料である。
 *
 * ここで固定するのは、`kind === 'permission'` の `summary` が `toolName` /
 * `brief(input)` を `codeSpan()` で包んでいること、そして `kind === 'question'`
 * （`describeQuestions(input)` ——クローン自身が書いた prose）は包まれずに
 * 残ることの2つである。受信箱（`manager_message.text`）まで見るのは、
 * `manager.ts` の `case 'ask'` が `event.summary` を一切加工せずそのまま運ぶ
 * ことも一緒に固定するためである（`markdown-span.ts` の doc、`manager.ts` の
 * `case 'permission_denied'` のコメントと同じ形）。
 */

/** マネージャー側の SDK の代わり。`canUseTool` を外から任意の入力で叩けるようにする。 */
function fakeManagerSdk() {
  const sessions: {
    options: Options;
    ask: (
      tool: string,
      input: Record<string, unknown>,
      id: string,
    ) => Promise<PermissionResult>;
  }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};

    sessions.push({
      options,
      ask(tool, input, id) {
        const canUseTool = options.canUseTool as CanUseTool;
        return canUseTool(tool, input, {
          signal: new AbortController().signal,
          requestId: id,
          toolUseID: id,
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function askAndCollectSummary(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
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

  // 応答は待たない——この検証が見るのは summary の字面だけで、
  // allow/deny の結果までは要らない。
  void session.ask(toolName, input, 'req-1');
  await tick();

  const message = inbox.find(
    (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
      event.type === 'manager_message' && event.requestId === 'req-1',
  );
  if (!message) throw new Error('manager_message が届いていない');

  await pool.stop();
  return message.text;
}

describe('ask の summary が Markdown として無害な形で包まれること（issue #287）', () => {
  it('kind === "permission" は toolName と brief(input) をどちらも codeSpan で包む', async () => {
    const summary = await askAndCollectSummary('Bash', {
      command: 'echo `date` && rm -rf /',
    });

    // 中身は1本のバッククォートを持つので、包みは2連続以上でなければ
    // 閉じ損ねる（codeSpan の可変長フェンス）。
    expect(summary).toMatch(/``.*echo `date` && rm -rf \/.*``/s);
    // toolName（識別子）も同じく codeSpan で包まれている。
    expect(summary).toMatch(/`Bash`/);
  });

  it('brief(input) 側のバッククォートの連なりが2連続でも可変長フェンスで包む', async () => {
    const summary = await askAndCollectSummary('Bash', {
      command: 'echo ``x`` ',
    });

    // 中身が2連続のバッククォートを持つので、包みは3連続以上でなければならない。
    // codeSpan() は「中身の最長の連なり + 1」を包みの長さにする。
    expect(summary).toMatch(/```+.*```+/s);
  });

  it('brief(input) 側の `_word_` / `*word*` も codeSpan で包む', async () => {
    const summary = await askAndCollectSummary('Bash', {
      path: 'src/_init_/x.ts',
    });

    expect(summary).toContain('_init_');
    // 包まれていれば、`_init_` はバッククォートで挟まれている。
    expect(summary).toMatch(/`[^`]*_init_[^`]*`/);
  });

  it('kind === "question"（describeQuestions）は包まれない', async () => {
    const summary = await askAndCollectSummary('AskUserQuestion', {
      questions: [{ question: 'DB は `orders` と `orders_v2` のどちらにする？' }],
    });

    // クローン自身が書いた prose なので、codeSpan の可変長フェンスで
    // 包まれていない——素のバッククォート1本のままである。
    expect(summary).toBe('DB は `orders` と `orders_v2` のどちらにする？');
    expect(summary).not.toMatch(/``/);
  });
});
