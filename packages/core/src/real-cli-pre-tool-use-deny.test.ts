import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

/**
 * #4348 の前提: PreToolUse のフックが Bash に deny を返したとき、
 * (a) 確認の口（canUseTool）へ上がらない
 * (b) auto mode で分類器の問い合わせ（偽の API への要求）が飛ばない
 * (c) 理由文が次のターンの tool_result としてモデルへ届く
 * (d) 作業者（サブエージェント）の Bash にも効く
 * 本物の資格は使わず、偽の API を 127.0.0.1 に立てる。
 */

const WORKER = 'denyprobeworker';
const WORKER_MARKER = 'DENY-PROBE-WORKER-PROMPT';
const DENY_REASON = 'deny-probe-reason: use Write or Edit instead';
const COMMAND = "python3 -c \"open('deny-probe-out.txt', 'w').write('deny-probe-ran')\"";

interface RequestRecord {
  readonly url: string;
  readonly toolNames: readonly string[];
  readonly systemHead: string;
  readonly mentionsCommand: boolean;
  readonly hasBashToolResult: boolean;
}

interface Probe {
  readonly asks: string[];
  readonly bashResults: string[];
  readonly requests: RequestRecord[];
  readonly hookCalls: string[];
}

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

function messageStart(id: string): [string, unknown] {
  return [
    'message_start',
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

function messageEnd(stopReason: string): Array<[string, unknown]> {
  return [
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Array<[string, unknown]> {
  return [
    messageStart(`msg_${id}`),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('tool_use'),
  ];
}

function text(id: string): Array<[string, unknown]> {
  return [
    messageStart(`msg_${id}`),
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('end_turn'),
  ];
}

type Block = { type?: string; tool_use_id?: string; content?: unknown; text?: string };

function blocksOf(messages: unknown): Block[] {
  const out: Block[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') out.push({ type: 'text', text: content });
    else if (Array.isArray(content)) out.push(...(content as Block[]));
  }
  return out;
}

function systemHeadOf(system: unknown): string {
  if (typeof system === 'string') return system.slice(0, 80);
  if (Array.isArray(system)) {
    return system
      .map((part) => (part as { text?: string }).text ?? '')
      .join(' ')
      .slice(0, 80);
  }
  return '';
}

async function startFakeApi(target: 'main' | 'worker', probe: Probe): Promise<string> {
  let sentMainTool = false;
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
      let parsed: { messages?: unknown; tools?: unknown; system?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = {};
      }
      const blocks = blocksOf(parsed.messages);
      const toolNames = (Array.isArray(parsed.tools) ? parsed.tools : []).map(
        (tool) => (tool as { name?: string }).name ?? '',
      );
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id === 'toolu_bash') {
          const result =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          if (!probe.bashResults.includes(result)) probe.bashResults.push(result);
        }
      }
      probe.requests.push({
        url,
        toolNames,
        systemHead: systemHeadOf(parsed.system),
        mentionsCommand: body.includes('deny-probe-out'),
        hasBashToolResult: blocks.some(
          (b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_bash',
        ),
      });
      const hasBashResult = blocks.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_bash',
      );
      const hasAgentResult = blocks.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_agent',
      );
      const isWorkerRequest = blocks.some(
        (b) => typeof b.text === 'string' && b.text.includes(WORKER_MARKER),
      );
      if (hasBashResult || hasAgentResult) {
        writeSse(res, text('end'));
        return;
      }
      if (target === 'main' && !isWorkerRequest && toolNames.includes('Bash') && !sentMainTool) {
        sentMainTool = true;
        writeSse(res, toolUse('toolu_bash', 'Bash', { command: COMMAND, description: 'probe' }));
        return;
      }
      if (target === 'worker') {
        if (isWorkerRequest && toolNames.includes('Bash')) {
          writeSse(res, toolUse('toolu_bash', 'Bash', { command: COMMAND, description: 'probe' }));
          return;
        }
        if (!isWorkerRequest && !sentMainTool) {
          sentMainTool = true;
          writeSse(
            res,
            toolUse('toolu_agent', 'Agent', {
              description: 'deny probe',
              prompt: WORKER_MARKER,
              subagent_type: WORKER,
              run_in_background: false,
            }),
          );
          return;
        }
      }
      writeSse(res, text('other'));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runProbe(options: {
  target: 'main' | 'worker';
  hook: 'deny' | 'none';
  permissionMode: 'default' | 'auto';
}): Promise<Probe> {
  const probe: Probe = { asks: [], bashResults: [], requests: [], hookCalls: [] };
  const baseUrl = await startFakeApi(options.target, probe);
  const home = await makeTempDir('alteroid-real-cli-pre-tool-use-deny-');

  const q = query({
    prompt: 'probe',
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 6,
      permissionMode: options.permissionMode,
      settingSources: [],
      cwd: home,
      agents: {
        [WORKER]: { description: 'probe worker', prompt: 'probe', model: 'haiku' },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              async (input) => {
                probe.hookCalls.push(
                  'agent_id' in input && typeof input.agent_id === 'string' ? 'worker' : 'main',
                );
                if (options.hook === 'none') return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: DENY_REASON,
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: async (toolName, input) => {
        if (toolName === 'Bash') {
          probe.asks.push(typeof input.command === 'string' ? input.command : '');
        }
        return { behavior: 'allow', updatedInput: input };
      },
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-dummy-probe-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
    },
  });
  for await (const message of q) {
    if (message.type === 'result') break;
  }
  return probe;
}

// 分類器の要求の見分け方: フックを置かない同じ構成（基準）で走らせ、基準にだけ在る要求を数える。
// 偽の API には「どれが分類器か」を教える印が無いので、deny 有りと無しの差で数える。
function requestSignature(request: RequestRecord): string {
  return `${request.toolNames.length > 0 ? 'tools' : 'no-tools'}|${request.systemHead}|${request.mentionsCommand}`;
}

describe('本物の本体: PreToolUse の deny は確認の口にも分類器にも上がらない（#4348 の前提）', () => {
  for (const target of ['main', 'worker'] as const) {
    it(`${target}: default でフックの deny は canUseTool を呼ばず、実行されず、理由文がモデルへ届く`, async () => {
      const probe = await runProbe({ target, hook: 'deny', permissionMode: 'default' });
      expect(probe.hookCalls).toEqual([target]);
      expect(probe.asks).toEqual([]);
      const joined = probe.bashResults.join('\n');
      expect(joined).toContain(DENY_REASON);
      expect(joined).not.toContain('deny-probe-ran');
    }, 60_000);

    it(`${target}: auto でフックの deny は canUseTool を呼ばず、要求の本数が基準（フック無し）を超えない（分類器の要求そのものは偽の API の下では基準でも飛ばず、測れていない）`, async () => {
      const baseline = await runProbe({ target, hook: 'none', permissionMode: 'auto' });
      const denied = await runProbe({ target, hook: 'deny', permissionMode: 'auto' });
      const describeAll = (probe: Probe): string[] =>
        probe.requests.map(
          (r) => `${r.url} ${requestSignature(r)} bashResult=${String(r.hasBashToolResult)}`,
        );
      // 生の観測を試験の出力へ残す（報告の材料）
      console.log(
        `[deny-probe:${target}] baseline requests:\n${describeAll(baseline).join('\n')}\n` +
          `[deny-probe:${target}] baseline asks=${JSON.stringify(baseline.asks)} bashResults=${JSON.stringify(baseline.bashResults)}\n` +
          `[deny-probe:${target}] denied requests:\n${describeAll(denied).join('\n')}\n` +
          `[deny-probe:${target}] denied asks=${JSON.stringify(denied.asks)} bashResults=${JSON.stringify(denied.bashResults)}`,
      );
      expect(denied.asks).toEqual([]);
      expect(denied.bashResults.join('\n')).toContain(DENY_REASON);

      // 基準で「コマンドを含み、tool_result がまだ無い」要求が、deny 側では1本も無い
      const classifierLike = (probe: Probe): RequestRecord[] =>
        probe.requests.filter((r) => r.mentionsCommand && !r.hasBashToolResult);
      const baselineSignatures = classifierLike(baseline).map(requestSignature);
      const deniedSignatures = classifierLike(denied).map(requestSignature);
      console.log(
        `[deny-probe:${target}] classifier-like baseline=${JSON.stringify(baselineSignatures)} denied=${JSON.stringify(deniedSignatures)}`,
      );
      expect(deniedSignatures).toEqual([]);
      // 実測（2026-10-09）: 偽の API の下では、フック無しの基準でも分類器の要求は1本も飛ばない
      // （canUseTool も呼ばれない）。つまり (b) は「測れなかった」であり、ここで言えるのは
      // 「deny 側の要求の本数が基準を超えない」までである。
      expect(denied.requests.length).toBeLessThanOrEqual(baseline.requests.length);
    }, 120_000);
  }
});
