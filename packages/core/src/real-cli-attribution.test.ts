import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { NO_ATTRIBUTION_SETTINGS } from './claude-provider.js';

/**
 * 同梱の CLI が帰属の行を付けさせる知らせを、`NO_ATTRIBUTION_SETTINGS` で親にも作業者にも載せないことを固定する（#4480）。
 * 本物の資格は使わず、偽の API を 127.0.0.1 に立てて、CLI が送った要求の本文を読む。
 * 既定（settings なし）で知らせが載ることも確かめる: 載らなくなった版では、こちらの主張が空回りになるため。
 */

const WORKER_MARK = 'ALTEROID_ATTRIBUTION_PROBE_WORKER';
const ATTRIBUTION_MARKS = ['Co-Authored-By', 'Generated with'];

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

function reply(
  res: http.ServerResponse,
  block: Record<string, unknown>,
  delta: Record<string, unknown>,
  stopReason: string,
): void {
  writeSse(res, [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

interface Captured {
  readonly parent: string[];
  readonly worker: string[];
}

async function startFakeApi(captured: Captured): Promise<string> {
  let sentAgentCall = false;
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
      let parsed: { system?: unknown; tools?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = {};
      }
      const isWorker = JSON.stringify(parsed.system ?? '').includes(WORKER_MARK);
      (isWorker ? captured.worker : captured.parent).push(body);
      const offersAgent =
        Array.isArray(parsed.tools) &&
        (parsed.tools as Array<{ name?: string }>).some((tool) => tool.name === 'Agent');
      if (!isWorker && offersAgent && !sentAgentCall) {
        sentAgentCall = true;
        reply(
          res,
          { type: 'tool_use', id: 'toolu_probe', name: 'Agent', input: {} },
          {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              subagent_type: 'worker',
              description: 'probe',
              prompt: 'probe',
              run_in_background: false,
            }),
          },
          'tool_use',
        );
        return;
      }
      reply(res, { type: 'text', text: '' }, { type: 'text_delta', text: 'done' }, 'end_turn');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runProbe(settings: Settings | undefined): Promise<Captured> {
  const captured: Captured = { parent: [], worker: [] };
  const baseUrl = await startFakeApi(captured);
  const home = await makeTempDir('alteroid-real-cli-attribution-');

  const q = query({
    prompt: 'probe',
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 4,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'probe' },
      agents: {
        worker: {
          description: 'probe',
          prompt: WORKER_MARK,
          model: 'claude-haiku-4-5-20251001',
        },
      },
      settingSources: [],
      ...(settings === undefined ? {} : { settings }),
      cwd: home,
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
  for await (const message of q) void message;
  return captured;
}

function marksIn(bodies: readonly string[]): string[] {
  return ATTRIBUTION_MARKS.filter((mark) => bodies.some((body) => body.includes(mark)));
}

describe('real CLI: 帰属の行の知らせ（#4480）', () => {
  it('settings を置かないと、親にも作業者にも帰属の行を付けさせる知らせが載る（対照）', async () => {
    const captured = await runProbe(undefined);

    expect(captured.worker.length).toBeGreaterThan(0);
    expect(marksIn(captured.parent)).toEqual(ATTRIBUTION_MARKS);
    expect(marksIn(captured.worker)).toEqual(ATTRIBUTION_MARKS);
  }, 60_000);

  it('NO_ATTRIBUTION_SETTINGS を置くと、親にも作業者にも載らない', async () => {
    const captured = await runProbe({ ...NO_ATTRIBUTION_SETTINGS });

    expect(captured.parent.length).toBeGreaterThan(0);
    expect(captured.worker.length).toBeGreaterThan(0);
    expect(marksIn(captured.parent)).toEqual([]);
    expect(marksIn(captured.worker)).toEqual([]);
  }, 60_000);
});
