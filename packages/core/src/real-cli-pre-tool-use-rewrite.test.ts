import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

/**
 * 型は「持てる」までしか言わず、SDK の更新は毎日の自動 PR で入る。本体の挙動が変われば、
 * ここが赤になって知らせる。本物の資格は使わず、偽の API を 127.0.0.1 に立てる
 * （`query()` の `env` を明示し、親の env を継がせない）。
 */

interface Probe {
  readonly hookInputs: unknown[];
  readonly toolResults: string[];
}

interface ProbeOptions {
  readonly toolInput: Record<string, unknown>;
  readonly rewrite?: (input: Record<string, unknown>) => Record<string, unknown>;
  readonly permissionMode: 'auto' | 'bypassPermissions';
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

async function startFakeApi(toolInput: Record<string, unknown>, probe: Probe): Promise<string> {
  let sentToolUse = false;
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
      for (const message of Array.isArray(parsed.messages) ? parsed.messages : []) {
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<{
          type?: string;
          tool_use_id?: string;
          content?: unknown;
        }>) {
          if (block.type === 'tool_result' && block.tool_use_id === 'toolu_probe') {
            probe.toolResults.push(
              typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            );
          }
        }
      }
      const offersBash =
        Array.isArray(parsed.tools) &&
        (parsed.tools as Array<{ name?: string }>).some((tool) => tool.name === 'Bash');
      if (offersBash && !sentToolUse) {
        sentToolUse = true;
        writeSse(res, [
          messageStart('msg_tool'),
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ...messageEnd('tool_use'),
        ]);
        return;
      }
      writeSse(res, [
        messageStart('msg_text'),
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
      ]);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runProbe(options: ProbeOptions): Promise<Probe> {
  const probe: Probe = { hookInputs: [], toolResults: [] };
  const baseUrl = await startFakeApi(options.toolInput, probe);
  const home = await makeTempDir('alteroid-real-cli-pre-tool-use-');

  const q = query({
    prompt: 'probe',
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 3,
      permissionMode: options.permissionMode,
      ...(options.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      settingSources: [],
      cwd: home,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              async (input) => {
                const toolInput =
                  (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
                probe.hookInputs.push(toolInput);
                if (options.rewrite === undefined) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    updatedInput: options.rewrite(toolInput),
                  },
                };
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
      },
    },
  });
  for await (const message of q) {
    if (message.type === 'result') break;
  }
  return probe;
}

describe('本物の本体: PreToolUse の updatedInput（#2088 の前提）', () => {
  for (const permissionMode of ['auto', 'bypassPermissions'] as const) {
    it(`フックの tool_input に timeout が載り、permissionDecision 無しの updatedInput が適用される（${permissionMode}）`, async () => {
      const probe = await runProbe({
        permissionMode,
        toolInput: { command: 'echo original-command', timeout: 345678, description: 'probe' },
        rewrite: (input) => ({ ...input, command: 'echo rewritten-command' }),
      });
      expect(probe.hookInputs).toEqual([
        { command: 'echo original-command', timeout: 345678, description: 'probe' },
      ]);
      expect(probe.toolResults).toHaveLength(1);
      expect(probe.toolResults[0]).toContain('rewritten-command');
      expect(probe.toolResults[0]).not.toContain('original-command');
    }, 60_000);
  }

  it('updatedInput で書き換えた timeout が効く（元は十分長いのに、書き換えた短い値で打ち切られる）', async () => {
    const probe = await runProbe({
      permissionMode: 'auto',
      toolInput: { command: 'sleep 4; echo slept', timeout: 345678, description: 'probe' },
      rewrite: (input) => ({ ...input, timeout: 1500 }),
    });
    expect(probe.toolResults).toHaveLength(1);
    expect(probe.toolResults[0]).not.toContain('slept');
    expect(probe.toolResults[0]).toMatch(/timed out/i);
  }, 60_000);
});
