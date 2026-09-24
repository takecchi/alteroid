import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { traceApproval } from './approval-trace.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

/**
 * 答えのターンの中でクローンが書いた行に、その承認の印（`answeredApprovalId`）が
 * 立つこと（issue #847 の案B の書く側）。
 *
 * ## なぜ専用の偽 SDK を持つのか
 *
 * 印は「いま走っているターン」（`Clone` の `#turn`）から読むので、**道具の実行と
 * フックはターンが開いている間に起きなければ測れない。** `clone.test.ts` の
 * `fakeSdk` は入力を受けると同期に返答を作って即座にターンを閉じるので、その間に
 * 非同期の道具（`journal_write` のハンドラ）を走らせる口が無い。ここの偽 SDK は
 * 入力を受けたあと `onTurn` を **await してから** 返答を流す——実物の SDK が道具を
 * 呼び終えてから返答を返す順序と同じである。
 *
 * 道具のハンドラは `mcpServerFactory` で控えた本物の `ToolContext` から
 * `createCloneTools` で取り出す（`clone.test.ts` の `self_status` の節と同じ形）。
 * ⟹ クローンが道具へ渡す日誌の包み（`#toolContext` の `stampingJournal`）を
 * 本物のまま通る。
 */

const ANSWER_MARKER = '承認待ちにしていた質問に人間が答えた';

function gatedSdk(onTurn: (input: string, options: Options) => Promise<string>) {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-stamp',
        uuid: 'uuid-init',
        model: 'claude-fake',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      const prompt = params.prompt;
      // 蒸留のサイドクエリ（1本の文字列）は道具を呼ばずに返す。
      const inputs: AsyncIterable<{ message: { content: unknown } }> =
        typeof prompt === 'string'
          ? (async function* () {
              yield { message: { content: prompt } };
            })()
          : (prompt as AsyncIterable<{ message: { content: unknown } }>);
      for await (const message of inputs) {
        const input = String(message.message.content);
        const text = typeof prompt === 'string' ? '蒸留した' : await onTurn(input, options);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-stamp',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-stamp',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        if (typeof prompt === 'string') return;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return fn;
}

/** 壁時計で打ち切らない（打ち切りは vitest のテスト単位の timeout に任せる）。 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
}

function stampOf(entry: JournalEntry): string | undefined {
  return 'answeredApprovalId' in entry ? entry.answeredApprovalId : undefined;
}

describe('クローン — 答えのターンの行へ承認の印を立てる（issue #847 の案B）', () => {
  it('答えのターンの decision / 自分の tool_use / 返答 / 入口に印が立ち、人間の発言のターンには立たない', async () => {
    const stores = createMemoryStores();
    let captured: ToolContext | undefined;

    /** ターンの中で、道具（journal_write）とフック（PostToolUse の Bash）を実際に通す。 */
    async function act(label: string, options: Options): Promise<void> {
      if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
      const journalWrite = createCloneTools(captured).find(
        (entry) => entry.name === 'journal_write',
      );
      if (!journalWrite) throw new Error('journal_write という道具が無い');
      await journalWrite.handler({ decision: `${label}の判断`, grounds: '根拠' } as never, {});
      const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
      await hook(
        { tool_name: 'Bash', tool_input: { command: `echo ${label}` } } as never,
        undefined,
        {} as never,
      );
    }

    const fn = gatedSdk(async (input, options) => {
      if (input.includes(ANSWER_MARKER)) {
        await act('答え', options);
        return '答えを受けて進めた';
      }
      await act('人間', options);
      return '人間への返事';
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });

    const outbound = async (text: string) =>
      (await stores.journal.list({ types: ['exchange'], limit: 200 })).some(
        (entry) =>
          entry.type === 'exchange' && entry.role === 'outbound' && entry.text.includes(text),
      );

    // 1. 承認に由来しないターン（契約の反対側）。
    clone.post(humanMessage('やあ'));
    await waitFor(() => outbound('人間への返事'));

    // 2. 答えのターン。
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: '本番へ出してよいか',
    });
    await clone.answerApproval('ap-1', '(b) でお願いします');
    await waitFor(() => outbound('答えを受けて進めた'));
    await clone.stop();

    const entries = await stores.journal.list({ order: 'asc', limit: 1000 });
    const find = (predicate: (entry: JournalEntry) => boolean, label: string) => {
      const found = entries.find(predicate);
      if (found === undefined) throw new Error(`${label} が日誌に無い`);
      return found;
    };
    const decisionOf = (label: string) =>
      find((e) => e.type === 'decision' && e.decision === `${label}の判断`, `${label}の decision`);
    const toolUseOf = (label: string) =>
      find(
        (e) =>
          e.type === 'tool_use' &&
          e.tool === 'Bash' &&
          JSON.stringify(e.input).includes(`echo ${label}`),
        `${label}の tool_use`,
      );
    const replyOf = (text: string) =>
      find((e) => e.type === 'exchange' && e.role === 'outbound' && e.text.includes(text), text);

    // 答えのターン: 行動の3種と入口に印が立つ。
    expect(stampOf(decisionOf('答え'))).toBe('ap-1');
    expect(stampOf(toolUseOf('答え'))).toBe('ap-1');
    expect(stampOf(replyOf('答えを受けて進めた'))).toBe('ap-1');
    expect(
      stampOf(
        find(
          (e) =>
            e.type === 'exchange' &&
            e.role === 'inbound' &&
            e.text.includes('human_answer approvalId=ap-1'),
          '答えのターンの入口',
        ),
      ),
    ).toBe('ap-1');

    // 人間の発言のターン: 1つも立たない（片側だけの歯だと「全部に立てる」実装も緑になる）。
    expect(stampOf(decisionOf('人間'))).toBeUndefined();
    expect(stampOf(toolUseOf('人間'))).toBeUndefined();
    expect(stampOf(replyOf('人間への返事'))).toBeUndefined();

    // 読む側と繋がっている: 同じ日誌から対が引ける。
    const trace = await traceApproval(stores, 'ap-1');
    expect(trace?.state).toBe('paired');
    expect(trace?.actions.map((entry) => entry.type).sort()).toEqual(
      ['decision', 'exchange', 'tool_use'].sort(),
    );
    expect(trace?.unstampedInTurn).toBe(0);
  });
});
