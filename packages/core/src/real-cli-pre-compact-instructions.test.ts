import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  query,
  type HookCallback,
  type McpServerConfig,
  type SDKUserMessage,
  type SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { buildCloneSessionOptions, buildManagerSessionOptions } from './claude-provider.js';
import { CLONE_COMPACTION_INSTRUCTIONS } from './clone-compaction-instructions.js';
import { MANAGER_COMPACTION_INSTRUCTIONS } from './manager-compaction-instructions.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';

/**
 * 同梱の CLI が、クローンの PreCompact フックの返り値 `systemMessage` を、自動要約の指示（"Additional Instructions"）に入れることを固定する。
 * SDK の更新は毎日の自動 PR で入る。型は「持てる」までしか言わず、`systemMessage` が要約の指示になるのは CLI の実装の都合なので、挙動が変われば、ここが赤になって知らせる。
 * 本物の資格は使わず、偽の API を 127.0.0.1 に立てて、要約の要求の本文を読む（`query()` の `env` を明示し、親の env を継がせない）。
 * 窓は 100k（CLI が受け付ける下限）にし、返答が「150k トークン読んだ」と名乗ることで、次の入力の前に自動要約を起こす。
 * 対照も置く: 指示を返さないフックでは載らないことを見ないと、載ったことが指示の効果だと言えない。
 */

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function writeSse(res: http.ServerResponse, events: ReadonlyArray<[string, unknown]>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

// 返答ごとに別の id にする: CLI は assistant の id の区切りで会話を「群」に分け、同じ id だと1群にしかならず、要約が too_few_groups で失敗する
let replySeq = 0;

function textReply(res: http.ServerResponse, text: string, inputTokens: number): void {
  replySeq += 1;
  writeSse(res, [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_probe_${replySeq}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

async function startFakeApi(bodies: string[]): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const url = req.url ?? '';
      if (!url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      bodies.push(body);
      // 要約の要求は、要約を書く指示を持つ。それ以外の要求は、150k 読んだと名乗って窓を超えさせる
      const isSummary = body.includes('<summary>') && body.includes('summary');
      textReply(
        res,
        isSummary ? '<analysis>probe</analysis><summary>probe summary</summary>' : 'done',
        isSummary ? 1_000 : 150_000,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function cloneCompactHook(): HookCallback {
  const options = buildCloneSessionOptions({
    model: 'haiku',
    permissionMode: DEFAULT_PERMISSION_MODE,
    mcpServer: { type: 'sdk', name: 'test', instance: {} } as unknown as McpServerConfig,
    systemPrompt: 'probe',
    env: {},
    resume: null,
    onPreCompact: () => {},
    onPostToolUse: () => {},
    onPostToolUseFailure: () => {},
    onPreToolUse: () => ({ kind: 'continue' }),
    onSubagentStop: () => {},
  });
  const hook = options.hooks?.PreCompact?.[0]?.hooks[0];
  if (hook === undefined) throw new Error('クローンの PreCompact フックが無い');
  return hook;
}

// マネージャーの組み立てから PreCompact フックだけを取り出す（セッションの他の欄は偽の API の試験には要らない）
function managerCompactHook(): HookCallback {
  const options = buildManagerSessionOptions({
    model: 'haiku',
    permissionMode: DEFAULT_PERMISSION_MODE,
    systemPromptAppend: 'probe',
    workerAgentName: 'worker',
    workerPrompt: 'probe',
    workerModel: 'haiku',
    cwd: '/tmp',
    env: {},
    sessionStore: {} as unknown as SessionStore,
    canUseTool: async () => ({ behavior: 'deny', message: 'probe' }),
    onPostToolUse: () => ({ kind: 'continue' }),
    onPostToolUseFailure: () => {},
    onPreCompact: () => {},
    onSubagentStop: () => ({ kind: 'continue' }),
    onStop: () => {},
    onPreToolUse: () => ({ kind: 'continue' }),
    onPermissionDenied: async () => ({ kind: 'no-retry' }),
    managerAutoMemoryEnabled: false,
  });
  const hook = options.hooks?.PreCompact?.[0]?.hooks[0];
  if (hook === undefined) throw new Error('マネージャーの PreCompact フックが無い');
  return hook;
}

// 本文は JSON の中に入っているので、先頭の1行を JSON の文字列の形（改行などのエスケープ）にして照合する
function firstLineAsJson(instructions: string): string {
  return JSON.stringify(instructions.split('\n')[0] ?? '').slice(1, -1);
}

/** 自動要約を1回起こし、要約の要求の本文のうち "Additional Instructions" を持つものと、フックの契機を返す。 */
async function runAutoCompaction(
  hook: HookCallback,
): Promise<{ additional: string[]; trigger: unknown; compacted: boolean }> {
  const bodies: string[] = [];
  const baseUrl = await startFakeApi(bodies);
  const home = await makeTempDir('alteroid-real-cli-pre-compact-');
  let trigger: unknown;

  // 前の返答（result）が返るまで次の入力を出さない: 続けて出すと CLI が1つの入力に束ね、ターンが増えない
  let turnsDone = 0;
  let wake: (() => void) | undefined;
  const wait = (): Promise<void> => new Promise<void>((resolve) => (wake = resolve));
  async function* prompts(): AsyncGenerator<SDKUserMessage> {
    for (let turn = 1; turn <= 4; turn += 1) {
      while (turnsDone < turn - 1) await wait();
      yield userMessage(`${turn}回目`);
    }
    while (turnsDone < 4) await wait();
  }

  const q = query({
    prompt: prompts(),
    options: {
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      // 先読みの要約を切る: 先読みだと要約は背景で走り、次の入力はそれを待たずに通常の要求として出る
      settings: { precomputeCompactionEnabled: false },
      cwd: home,
      hooks: {
        PreCompact: [
          {
            hooks: [
              async (input, toolUseId, options) => {
                trigger = (input as { trigger?: unknown }).trigger;
                return hook(input, toolUseId, options);
              },
            ],
          },
        ],
      },
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-dummy-probe-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100k',
      },
    },
  });
  let compacted = false;
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') compacted = true;
    if (message.type !== 'result') continue;
    turnsDone += 1;
    wake?.();
  }
  return {
    additional: bodies.filter((body) => body.includes('Additional Instructions')),
    trigger,
    compacted,
  };
}

describe('real CLI: クローンの PreCompact の指示が自動要約の指示に入る', () => {
  it('自動要約の要求に、クローンの要約の指示が "Additional Instructions" として載る', async () => {
    const { additional, trigger, compacted } = await runAutoCompaction(cloneCompactHook());

    expect(trigger).toBe('auto');
    expect(compacted).toBe(true);
    expect(additional.length).toBeGreaterThan(0);
    // 本文は JSON の中に入っているので、先頭の1行を JSON の文字列の形（改行などのエスケープ）にして照合する
    const head = JSON.stringify(CLONE_COMPACTION_INSTRUCTIONS.split('\n')[0] ?? '').slice(1, -1);
    expect(additional.some((body) => body.includes(head))).toBe(true);
  }, 120_000);

  it('マネージャー: 自動要約の要求に、マネージャーの要約の指示が載り、クローンの指示は載らない', async () => {
    const { additional, trigger, compacted } = await runAutoCompaction(managerCompactHook());

    expect(trigger).toBe('auto');
    expect(compacted).toBe(true);
    expect(additional.length).toBeGreaterThan(0);
    const manager = firstLineAsJson(MANAGER_COMPACTION_INSTRUCTIONS);
    const clone = firstLineAsJson(CLONE_COMPACTION_INSTRUCTIONS);
    expect(additional.some((body) => body.includes(manager))).toBe(true);
    expect(additional.some((body) => body.includes(clone))).toBe(false);
  }, 120_000);

  it('対照: 指示を返さないフックでは、要約の指示に載らない', async () => {
    const { additional, trigger, compacted } = await runAutoCompaction(async () => ({
      continue: true,
    }));

    expect(trigger).toBe('auto');
    // 要約が起きていないと、載らなかったことが何も言わない
    expect(compacted).toBe(true);
    const head = JSON.stringify(CLONE_COMPACTION_INSTRUCTIONS.split('\n')[0] ?? '').slice(1, -1);
    expect(additional.some((body) => body.includes(head))).toBe(false);
  }, 120_000);
});
