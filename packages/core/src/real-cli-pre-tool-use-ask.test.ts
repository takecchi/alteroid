import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

/**
 * **本物の Claude Code 本体**が、PreToolUse のフックの `permissionDecision: 'ask'` を
 * `canUseTool` へ流すかを、マネージャー本体の `Bash` と作業者（サブエージェント）の
 * `Bash` の両方について測る（issue #2884）。
 *
 * Bash の門（`bash-wait-guard.ts`）は、これまで deny を返して誰も開けられなかった。
 * 「確認に上げる」へ変える前提は、次の2つが本物の本体で成り立つことである。
 * - フックの ask が `canUseTool` に届き、その答え（allow / deny）が実行を決める
 * - **作業者の `Bash` でも `canUseTool` に届く**（`options.agentID` が付く）
 *
 * 型（`HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'`）は「持てる」までしか
 * 言わない。SDK の更新は毎日の自動 PR で入るので、本体の挙動が変われば、ここが赤になって知らせる。
 *
 * ## どう測るか（本物の資格を使わない）
 * `real-cli-pre-tool-use-rewrite.test.ts` と同じ。127.0.0.1 の偽の API が、主セッションには
 * `Agent` の `tool_use` を、作業者の最初の要求には `Bash` の `tool_use` を返す。
 */

const WORKER = 'askprobeworker';
const WORKER_MARKER = 'ASK-PROBE-WORKER-PROMPT';

interface AskCall {
  readonly toolName: string;
  readonly agentID: string | undefined;
  readonly decisionReason: string | undefined;
  readonly command: string | undefined;
}

interface Probe {
  readonly asks: AskCall[];
  readonly bashResults: string[];
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

async function startFakeApi(
  target: 'main' | 'worker',
  command: string,
  probe: Probe,
): Promise<string> {
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
      let parsed: { messages?: unknown; tools?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = {};
      }
      const blocks = blocksOf(parsed.messages);
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id === 'toolu_bash') {
          const result =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          if (!probe.bashResults.includes(result)) probe.bashResults.push(result);
        }
      }
      const hasBashResult = blocks.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_bash',
      );
      const hasAgentResult = blocks.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_agent',
      );
      const toolNames = (Array.isArray(parsed.tools) ? parsed.tools : []).map(
        (tool) => (tool as { name?: string }).name,
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
        writeSse(res, toolUse('toolu_bash', 'Bash', { command, description: 'probe' }));
        return;
      }
      if (target === 'worker') {
        if (isWorkerRequest && toolNames.includes('Bash')) {
          writeSse(res, toolUse('toolu_bash', 'Bash', { command, description: 'probe' }));
          return;
        }
        if (!isWorkerRequest && !sentMainTool) {
          sentMainTool = true;
          writeSse(
            res,
            toolUse('toolu_agent', 'Agent', {
              description: 'ask probe',
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
  answer: 'allow' | 'deny';
  permissionMode: 'default' | 'auto';
}): Promise<Probe> {
  const probe: Probe = { asks: [], bashResults: [] };
  const command = 'echo ask-probe-ran';
  const baseUrl = await startFakeApi(options.target, command, probe);
  const home = await makeTempDir('alteroid-real-cli-pre-tool-use-ask-');

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
              async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'ask' as const,
                  permissionDecisionReason: 'ask-probe-reason',
                },
              }),
            ],
          },
        ],
      },
      canUseTool: async (toolName, input, opts) => {
        if (toolName === 'Bash') {
          probe.asks.push({
            toolName,
            agentID: opts.agentID,
            decisionReason: opts.decisionReason,
            command: typeof input.command === 'string' ? input.command : undefined,
          });
          return options.answer === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'ask-probe-denied' };
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

describe('本物の本体: PreToolUse の ask は canUseTool へ届く（#2884 の前提）', () => {
  for (const permissionMode of ['default', 'auto'] as const) {
    it(`マネージャー本体の Bash: ask が canUseTool に届き、allow なら実行される（${permissionMode}）`, async () => {
      const probe = await runProbe({ target: 'main', answer: 'allow', permissionMode });
      expect(probe.asks).toEqual([
        {
          toolName: 'Bash',
          agentID: undefined,
          decisionReason: 'ask-probe-reason',
          command: 'echo ask-probe-ran',
        },
      ]);
      expect(probe.bashResults.join('\n')).toContain('ask-probe-ran');
    }, 60_000);

    it(`作業者（サブエージェント）の Bash: ask が agentID つきで canUseTool に届き、allow なら実行される（${permissionMode}）`, async () => {
      const probe = await runProbe({ target: 'worker', answer: 'allow', permissionMode });
      expect(probe.asks).toHaveLength(1);
      expect(probe.asks[0]?.command).toBe('echo ask-probe-ran');
      expect(probe.asks[0]?.agentID).toEqual(expect.any(String));
      expect(probe.asks[0]?.decisionReason).toBe('ask-probe-reason');
      expect(probe.bashResults.join('\n')).toContain('ask-probe-ran');
    }, 60_000);

    it(`作業者の Bash: canUseTool が deny を返すと実行されず、拒否の文が作業者へ返る（${permissionMode}）`, async () => {
      const probe = await runProbe({ target: 'worker', answer: 'deny', permissionMode });
      expect(probe.asks).toHaveLength(1);
      const joined = probe.bashResults.join('\n');
      expect(joined).toContain('ask-probe-denied');
      expect(joined).not.toContain('ask-probe-ran');
    }, 60_000);
  }
});
