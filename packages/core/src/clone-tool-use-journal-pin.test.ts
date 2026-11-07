import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import { createClone } from './clone.js';
import {
  setup,
  waitFor,
  waitForDone,
  fakeScriptedSdk,
  waitForTerminal,
  wireEvents,
} from './clone-test-harness.js';
import type { FakeCall, ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { MCP_INPUT_VALIDATION_ERROR_MARKER, qualifiedToolName } from './tools.js';
import type { Stores } from './store.js';

/**
 * 道具の呼びの日誌（C2。`clone.ts` の `#journalToolUse`・`#journalToolUseFailure`・`#journalSelfJournalingToolValidationFailure`・
 * `#journalUnparsedToolInput`・`#answeredApprovalFor`）を協力者へ切り出す前に置いた固定。今の作りの出力で通る。
 * 期待の行は仕様を先に書いたものではなく、今の作りの出力から生成して目で読んで確かめたものを写した
 * （既存の `clone-core-loop.test.ts` は `toBe` / `toContain` と欠落の有無が中心、`clone-unparsed-tool-input.test.ts` は raw を含めないことと二重に書かないことが中心。
 * ここは行の全文・秘密を運ぶ道具の分岐・伏せ字と切り詰め・承認の印・読めなかった入力の間引きの上限を足す）。
 * 切り出しの前後でこの試験を変えない。
 */

// 日誌の行から、毎回変わる欄（id と時刻）を除いて残りを全文で比べる
async function toolUseRows(stores: Stores): Promise<Record<string, unknown>[]> {
  const rows = await stores.journal.list({ types: ['tool_use'], order: 'asc', limit: 2000 });
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id' && key !== 'at')),
  );
}

async function openHooks(env: NodeJS.ProcessEnv = {}) {
  const s = setup(undefined, createMemoryStores(), {}, env);
  s.clone.post(humanMessage('やあ'));
  await waitForDone(s.events);
  const options = (s.calls[0] as FakeCall).options;
  const post = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  const failure = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
  if (post === undefined) throw new Error('PostToolUse フックが登録されていない');
  if (failure === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
  return {
    s,
    post: (input: Record<string, unknown>) => post(input as never, undefined, {} as never),
    failure: (input: Record<string, unknown>) => failure(input as never, undefined, {} as never),
  };
}

function validationFailure(tool: string, fieldsJson: string, extra = '') {
  return {
    content: [
      {
        type: 'text',
        text:
          `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}${tool}: ` +
          `[{"code":"invalid_type","path":${fieldsJson},"message":"x"}]${extra}`,
      },
    ],
    isError: true,
  };
}

describe('クローン — 成功した道具の tool_use の行（#journalToolUse。全文）', () => {
  it('本体の手・作業者の手（agent_type あり／無し）・名前が読めない手・自作ツールの成功（行を出さない）', async () => {
    const { s, post } = await openHooks();

    await post({ tool_name: 'Bash', tool_input: { command: 'git log' } });
    await post({
      tool_name: 'Read',
      tool_input: { file_path: '/a' },
      agent_id: 'agent-1',
      agent_type: 'Explore',
    });
    await post({ tool_name: 'Grep', tool_input: { pattern: 'x' }, agent_id: 'agent-2' });
    await post({ tool_name: 'Glob', tool_input: { pattern: 'x' }, agent_id: '' });
    await post({ tool_input: { command: 'ls' } });
    await post({});
    await post({ tool_name: qualifiedToolName('memory_write'), tool_input: { slug: 'v' } });
    await s.clone.stop();

    expect(await toolUseRows(s.stores)).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "input": {
            "command": "git log",
          },
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:Explore",
          "input": {
            "file_path": "/a",
          },
          "tool": "Read",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:(不明)",
          "input": {
            "pattern": "x",
          },
          "tool": "Grep",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": {
            "pattern": "x",
          },
          "tool": "Glob",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": {
            "command": "ls",
          },
          "tool": "(不明な道具)",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": undefined,
          "tool": "(不明な道具)",
          "type": "tool_use",
        },
      ]
    `);
  });

  it('秘密を運ぶ道具の成功は、検証落ちでなければ行を出さない（入力も残らない）', async () => {
    const { s, post } = await openHooks();

    await post({
      tool_name: qualifiedToolName('profile_write'),
      tool_input: { script: 'export TOKEN=かくしごと-ABCDEF123456' },
      tool_response: { content: [{ type: 'text', text: '書いた' }], isError: false },
    });
    await s.clone.stop();

    expect(await toolUseRows(s.stores)).toEqual([]);
  });
});

describe('クローン — 失敗した道具の tool_use の行（#journalToolUseFailure。全文）', () => {
  it('failed・interrupted・is_interrupt が真偽でない・error が文字列でない・名前が読めない（全文）', async () => {
    const { s, failure } = await openHooks();

    await failure({ tool_name: 'Bash', tool_input: { command: 'git push' }, error: 'exit code 1' });
    await failure({
      tool_name: 'Bash',
      tool_input: { command: 'sleep 9' },
      error: 'interrupted',
      is_interrupt: true,
    });
    await failure({ tool_name: 'Bash', tool_input: { command: 'x' }, is_interrupt: 'yes' });
    await failure({ tool_name: 'Bash', tool_input: { command: 'y' }, error: 42 });
    await failure({
      tool_name: 'Task',
      tool_input: { prompt: 'z' },
      error: 'ENOSPC',
      agent_id: 'agent-3',
      agent_type: 'general-purpose',
    });
    await failure({});
    await s.clone.stop();

    expect(await toolUseRows(s.stores)).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "error": "exit code 1",
          "input": {
            "command": "git push",
          },
          "outcome": "failed",
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "error": "interrupted",
          "input": {
            "command": "sleep 9",
          },
          "outcome": "interrupted",
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": {
            "command": "x",
          },
          "outcome": "failed",
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": {
            "command": "y",
          },
          "outcome": "failed",
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:general-purpose",
          "error": "ENOSPC",
          "input": {
            "prompt": "z",
          },
          "outcome": "failed",
          "tool": "Task",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "input": undefined,
          "outcome": "failed",
          "tool": "(不明な道具)",
          "type": "tool_use",
        },
      ]
    `);
  });

  it('error は伏せ字を通してから切る（env の秘密・URL のパスワード・params 以降）。上限は500字', async () => {
    const { s, failure } = await openHooks({ DEPLOY_TOKEN: 'tok-env-secret-98765' });

    await failure({
      tool_name: 'Bash',
      tool_input: { command: 'curl' },
      error: 'denied tok-env-secret-98765 at https://user:hunter2pw@example.com/x params: {"a":1}',
    });
    await failure({
      tool_name: 'Bash',
      tool_input: { command: 'curl' },
      error: 'あ'.repeat(600),
    });
    await s.clone.stop();

    const rows = await toolUseRows(s.stores);
    expect(rows[0]!.error).toBe(
      'denied [REDACTED] at https://user:[REDACTED]@example.com/x params: [REDACTED]',
    );
    // 500字で切り、切ったことと元の長さを足す（全文は上限の無い自由文で、日誌の1行を埋めうるため）
    expect(rows[1]!.error).toBe(`${'あ'.repeat(500)}…（100 文字省略。全 600 文字）`);
  });

  it('自作ツールの失敗は、成功と同じ規則で行を出さない', async () => {
    const { s, failure } = await openHooks();

    await failure({
      tool_name: qualifiedToolName('memory_write'),
      tool_input: { slug: 'v' },
      error: 'ストアに書けなかった',
    });
    await failure({
      tool_name: qualifiedToolName('memory_read'),
      tool_input: { slug: 'v' },
      error: '読めなかった',
    });
    await s.clone.stop();

    expect(await toolUseRows(s.stores)).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "error": "読めなかった",
          "input": {
            "slug": "v",
          },
          "outcome": "failed",
          "tool": "mcp__alteroid__memory_read",
          "type": "tool_use",
        },
      ]
    `);
  });
});

describe('クローン — 検証で落ちた自作ツールの tool_use の行（#journalSelfJournalingToolValidationFailure。全文）', () => {
  it('秘密を運ぶ道具（profile_write）: input を落とし、欄の名前だけの error（全文）。欄が取れないときは「（取れなかった）」', async () => {
    const { s, post } = await openHooks();

    await post({
      tool_name: qualifiedToolName('profile_write'),
      tool_input: { script: 'export TOKEN=かくしごと-ABCDEF123456' },
      tool_response: validationFailure('profile_write', '["summary"]'),
    });
    await post({
      tool_name: qualifiedToolName('profile_write'),
      tool_input: { script: 'export TOKEN=かくしごと-ABCDEF123456' },
      tool_response: `${MCP_INPUT_VALIDATION_ERROR_MARKER}profile_write: 欄の名前が読めない形`,
      agent_id: 'agent-4',
      agent_type: 'Explore',
    });
    await s.clone.stop();

    const rows = await toolUseRows(s.stores);
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "error": "入力検証で落ちた（この道具は実行環境の秘密を運びうるため、値は日誌へ写さない。欠けた/不正な引数: summary）",
          "outcome": "failed",
          "tool": "mcp__alteroid__profile_write",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:Explore",
          "error": "入力検証で落ちた（この道具は実行環境の秘密を運びうるため、値は日誌へ写さない。欠けた/不正な引数: （取れなかった））",
          "outcome": "failed",
          "tool": "mcp__alteroid__profile_write",
          "type": "tool_use",
        },
      ]
    `);
    expect(JSON.stringify(rows)).not.toContain('かくしごと');
  });

  it('秘密を運ばない道具（memory_write）: input を残し、検証の message を伏せ字を通して500字で切る（全文）', async () => {
    const { s, post } = await openHooks({ DEPLOY_TOKEN: 'tok-env-secret-98765' });

    await post({
      tool_name: qualifiedToolName('memory_write'),
      tool_input: { slug: 'values', content: '本文' },
      tool_response: validationFailure(
        'memory_write',
        '["summary"]',
        ' tok-env-secret-98765 https://user:hunter2pw@example.com/x',
      ),
    });
    await post({
      tool_name: qualifiedToolName('memory_write'),
      tool_input: { slug: 'values' },
      tool_response: validationFailure('memory_write', '["summary"]', 'あ'.repeat(700)),
    });
    await s.clone.stop();

    const rows = await toolUseRows(s.stores);
    // error は検証の message（tool_response の文字列化）。1本目: 伏せ字を通す
    expect(rows[0]).toEqual({
      type: 'tool_use',
      actor: 'clone',
      tool: 'mcp__alteroid__memory_write',
      outcome: 'failed',
      input: { slug: 'values', content: '本文' },
      error:
        '{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool memory_write: [{\\"code\\":\\"invalid_type\\",\\"path\\":[\\"summary\\"],\\"message\\":\\"x\\"}] [REDACTED] https://user:[REDACTED]@example.com/x"}],"isError":true}',
    });
    // 2本目: 500字で切る
    const long = JSON.stringify(validationFailure('memory_write', '["summary"]', 'あ'.repeat(700)));
    expect(rows[1]).toEqual({
      type: 'tool_use',
      actor: 'clone',
      tool: 'mcp__alteroid__memory_write',
      outcome: 'failed',
      input: { slug: 'values' },
      error: `${long.slice(0, 500)}…（${String(long.length - 500)} 文字省略。全 ${String(long.length)} 文字）`,
    });
  });

  it('journal_write の検証落ちだけが、判断そのものが落ちた跡（noteDroppedRecord）を出す。他の自作ツールは出さない', async () => {
    clearRecentTracesForTesting();
    const { s, post } = await openHooks();

    await post({
      tool_name: qualifiedToolName('journal_write'),
      tool_input: { grounds: 'g' },
      tool_response: validationFailure('journal_write', '["decision"]'),
    });
    await post({
      tool_name: qualifiedToolName('task_add'),
      tool_input: {},
      tool_response: validationFailure('task_add', '["title"]'),
    });
    await s.clone.stop();

    // 先頭の `alteroid: <時刻> ` は毎回変わるので外して比べる
    const traces = recentDroppedTraces()
      .filter((line) => line.includes('判断そのもの'))
      .map((line) => line.replace(/^alteroid: \S+ /, ''));
    expect(traces).toEqual([
      '判断そのもの（journal_write）を記録できませんでした（fields=decision）: Error: 入力検証で落ちた——decision が届かなかった可能性がある（issue #1338 残件1）',
    ]);
  });
});

// 答えのターン（`answerApproval` の回答が届いて走るターン）の中で hook を叩く。蒸留のサイドクエリの hook は PreCompact で起こして捕まえる
function answerTurnSdk(onAnswerTurn: (options: Options) => Promise<void>) {
  const distillOptions: { current?: Options } = {};
  const mainOptions: { current?: Options } = {};
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-pin',
        uuid: 'uuid-init',
        model: 'claude-fake',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      const prompt = params.prompt;
      if (typeof prompt === 'string') distillOptions.current = options;
      else mainOptions.current = options;
      const inputs: AsyncIterable<{ message: { content: unknown } }> =
        typeof prompt === 'string'
          ? (async function* () {
              yield { message: { content: prompt } };
            })()
          : (prompt as AsyncIterable<{ message: { content: unknown } }>);
      for await (const message of inputs) {
        const input = String(message.message.content);
        if (typeof prompt !== 'string' && input.includes('承認待ちにしていた質問に人間が答えた')) {
          await onAnswerTurn(options);
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '了解' }] },
          parent_tool_use_id: null,
          session_id: 'sess-pin',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '了解',
          session_id: 'sess-pin',
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
  return { fn, distillOptions, mainOptions };
}

describe('クローン — 承認の印（#answeredApprovalFor）', () => {
  it('答えのターンの本体の手（成功・失敗・検証落ち）に印が立ち、蒸留の手・作業者の手を含めた他の actor にも立つか立たないかを固定する', async () => {
    const stores = createMemoryStores();
    const dir = await makeTempDir('alteroid-tool-use-pin-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');

    const { fn, distillOptions, mainOptions } = answerTurnSdk(async (options) => {
      const call = (name: 'PostToolUse' | 'PostToolUseFailure', input: Record<string, unknown>) => {
        const hook = options.hooks?.[name]?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
        return hook(input as never, undefined, {} as never);
      };
      await call('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo 成功' } });
      await call('PostToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: '/w' },
        agent_id: 'agent-5',
        agent_type: 'Explore',
      });
      await call('PostToolUseFailure', {
        tool_name: 'Bash',
        tool_input: { command: 'echo 失敗' },
        error: 'exit code 2',
      });
      await call('PostToolUse', {
        tool_name: qualifiedToolName('memory_write'),
        tool_input: { slug: 'v' },
        tool_response: validationFailure('memory_write', '["summary"]'),
      });
      // 蒸留のサイドクエリの hook（別 actor）。答えのターンと並行して走りうるが、印は立たない
      const distillPost = distillOptions.current?.hooks?.PostToolUse?.[0]?.hooks?.[0];
      const distillFailure = distillOptions.current?.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
      if (distillPost === undefined || distillFailure === undefined) {
        throw new Error('蒸留側の hook が登録されていない');
      }
      await distillPost(
        { tool_name: 'Write', tool_input: { file_path: '/d' } } as never,
        undefined,
        {} as never,
      );
      await distillFailure(
        { tool_name: 'Write', tool_input: { file_path: '/e' }, error: 'ENOSPC' } as never,
        undefined,
        {} as never,
      );
    });
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);

    // 答えのターンの前に、PreCompact で蒸留のサイドクエリを起こして、その hook を捕まえておく（答えのターンの中で起こすと待ち合わせて止まる）
    const preCompact = mainOptions.current?.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-pin', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );

    await stores.jobs.putApproval({
      id: 'ap-pin',
      createdAt: new Date().toISOString(),
      question: '本番へ出してよいか',
    });
    await clone.answerApproval('ap-pin', '(b) でお願いします');
    // 答えのターンは別の会話へ流れるので、返答の行が2本（人間の発言のターンと答えのターン）になるのを日誌で待つ
    await waitFor(
      async () =>
        (await stores.journal.list({ types: ['exchange'], limit: 200 })).filter(
          (entry) => entry.type === 'exchange' && entry.role === 'outbound',
        ).length >= 2,
      '答えのターンの返答',
    );
    await clone.stop();

    const rows = await toolUseRows(stores);
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "answeredApprovalId": "ap-pin",
          "input": {
            "command": "echo 成功",
          },
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:Explore",
          "answeredApprovalId": "ap-pin",
          "input": {
            "file_path": "/w",
          },
          "tool": "Read",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "answeredApprovalId": "ap-pin",
          "error": "exit code 2",
          "input": {
            "command": "echo 失敗",
          },
          "outcome": "failed",
          "tool": "Bash",
          "type": "tool_use",
        },
        {
          "actor": "clone",
          "answeredApprovalId": "ap-pin",
          "error": "{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool memory_write: [{\\"code\\":\\"invalid_type\\",\\"path\\":[\\"summary\\"],\\"message\\":\\"x\\"}]"}],"isError":true}",
          "input": {
            "slug": "v",
          },
          "outcome": "failed",
          "tool": "mcp__alteroid__memory_write",
          "type": "tool_use",
        },
        {
          "actor": "clone:distill",
          "input": {
            "file_path": "/d",
          },
          "tool": "Write",
          "type": "tool_use",
        },
        {
          "actor": "clone:distill",
          "error": "ENOSPC",
          "input": {
            "file_path": "/e",
          },
          "outcome": "failed",
          "tool": "Write",
          "type": "tool_use",
        },
      ]
    `);
  });
});

async function runScripted(steps: ScriptedStep[], parentToolUseId?: string) {
  const stores = createMemoryStores();
  // 2ターン目以降は何もしない（単発の人間の発言のあとに別のターンが走っても、同じ steps を繰り返さない）
  const { fn } = fakeScriptedSdk((turnIndex) =>
    turnIndex === 0 ? steps : [{ assistant: [{ type: 'text', text: '了解' }] }],
  );
  const clone = createClone({
    stores,
    queryFn:
      parentToolUseId === undefined
        ? fn
        : (((params: Parameters<typeof sdkQuery>[0]) => {
            const query = fn(params) as AsyncGenerator<SDKMessage, void>;
            async function* withParent(): AsyncGenerator<SDKMessage, void> {
              for await (const message of query) {
                yield message.type === 'assistant'
                  ? ({ ...message, parent_tool_use_id: parentToolUseId } as SDKMessage)
                  : message;
              }
            }
            return Object.assign(withParent(), {
              close: () => undefined,
              interrupt: async () => undefined,
            }) as unknown as Query;
          }) as unknown as typeof sdkQuery),
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  clone.post(humanMessage('やって'));
  await waitForTerminal(events);
  await clone.stop();
  return stores;
}

const unparsed = (len: number) => ({ __unparsedToolInput: { raw: '壊れた JSON', len } });

describe('クローン — 入力が読めず断られた tool_use の行（#journalUnparsedToolInput。全文・間引き）', () => {
  it('本体の手の行（全文）と、作業者（parent_tool_use_id つき）の手の行（clone:sub:(不明)）', async () => {
    const own = await runScripted([
      {
        assistant: [{ type: 'tool_use', name: 'Write', id: 'tu-own', input: unparsed(4321) }],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);
    const sub = await runScripted(
      [
        {
          assistant: [{ type: 'tool_use', name: 'Edit', id: 'tu-sub', input: unparsed(77) }],
        },
        { toolResult: true },
        { assistant: [{ type: 'text', text: '了解' }] },
      ],
      'toolu-parent-1',
    );

    expect([...(await toolUseRows(own)), ...(await toolUseRows(sub))]).toMatchInlineSnapshot(`
      [
        {
          "actor": "clone",
          "error": "入力が JSON として読めず本体が断った（4321 bytes。入力は日誌へ写さない）",
          "outcome": "failed",
          "tool": "Write",
          "type": "tool_use",
        },
        {
          "actor": "clone:sub:(不明)",
          "error": "入力が JSON として読めず本体が断った（77 bytes。入力は日誌へ写さない）",
          "outcome": "failed",
          "tool": "Edit",
          "type": "tool_use",
        },
      ]
    `);
  });

  it('id の無い tool_use は間引かず、同じ内容でも毎回書く。id のあるものは2回目以降を書かない', async () => {
    const stores = await runScripted([
      {
        assistant: [
          { type: 'tool_use', name: 'Write', input: unparsed(1) },
          { type: 'tool_use', name: 'Write', input: unparsed(1) },
          { type: 'tool_use', name: 'Write', id: 'tu-a', input: unparsed(2) },
          { type: 'tool_use', name: 'Write', id: 'tu-a', input: unparsed(2) },
          { type: 'tool_use', name: 'Edit', id: 'tu-a', input: unparsed(3) },
        ],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);

    const rows = await toolUseRows(stores);
    expect(rows.map((row) => `${String(row.tool)}:${String(row.error)}`)).toMatchInlineSnapshot(`
      [
        "Write:入力が JSON として読めず本体が断った（1 bytes。入力は日誌へ写さない）",
        "Write:入力が JSON として読めず本体が断った（1 bytes。入力は日誌へ写さない）",
        "Write:入力が JSON として読めず本体が断った（2 bytes。入力は日誌へ写さない）",
      ]
    `);
  });

  it('覚える id は512件まで: 513件目で最古の id を忘れ、その id が再び届くと、もう1度書く', async () => {
    const first = Array.from({ length: 513 }, (_, i) => ({
      type: 'tool_use' as const,
      name: 'Write',
      id: `tu-${String(i)}`,
      input: unparsed(i),
    }));
    const stores = await runScripted([
      { assistant: first },
      { toolResult: true },
      // tu-1 は覚えている（書かない）、tu-0 は忘れている（もう1度書く）
      {
        assistant: [
          { type: 'tool_use', name: 'Write', id: 'tu-1', input: unparsed(1) },
          { type: 'tool_use', name: 'Write', id: 'tu-0', input: unparsed(0) },
        ],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);

    const rows = await toolUseRows(stores);
    expect(rows).toHaveLength(514);
    expect(rows.at(-1)).toMatchInlineSnapshot(`
      {
        "actor": "clone",
        "error": "入力が JSON として読めず本体が断った（0 bytes。入力は日誌へ写さない）",
        "outcome": "failed",
        "tool": "Write",
        "type": "tool_use",
      }
    `);
  });
});
