import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { withManagerWorkerCacheTtl } from './claude-provider.js';

/**
 * 同梱の CLI が作業者（サブエージェント）の要求に付けるキャッシュの寿命を固定する。
 * 本物の資格は使わず、偽の API を 127.0.0.1 に立てて、CLI が送った要求の `cache_control` を読む。
 * 既定（env なし）で作業者が 1h を付けないことも確かめる: 既定が 1h に変わった版では、こちらの主張が空回りになるため。
 */

const WORKER_MARK = 'ALTEROID_CACHE_TTL_PROBE_WORKER';

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
  readonly parent: unknown[];
  readonly worker: unknown[];
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
      (isWorker ? captured.worker : captured.parent).push(parsed);
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

async function runProbe(extraEnv: NodeJS.ProcessEnv): Promise<Captured> {
  const captured: Captured = { parent: [], worker: [] };
  const baseUrl = await startFakeApi(captured);
  const home = await makeTempDir('alteroid-real-cli-cache-ttl-');

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
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-dummy-probe-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        ...extraEnv,
      },
    },
  });
  for await (const message of q) void message;
  return captured;
}

/** 要求の本文に現れる `cache_control` をすべて拾う（system・tools・messages のどこに付いても数える）。 */
function cacheControlsIn(body: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cache_control' && value !== null && typeof value === 'object') {
        found.push(value as Record<string, unknown>);
      } else {
        walk(value);
      }
    }
  };
  walk(body);
  return found;
}

function ttlsIn(bodies: readonly unknown[]): Array<string | undefined> {
  return bodies.flatMap((body) =>
    cacheControlsIn(body).map((control) =>
      typeof control.ttl === 'string' ? control.ttl : undefined,
    ),
  );
}

describe('real CLI: 作業者の要求のキャッシュの寿命', () => {
  it('env を置かないと、作業者の要求は 1h を付けない（対照: 既定は 5 分）', async () => {
    const captured = await runProbe({});

    expect(captured.worker.length).toBeGreaterThan(0);
    const ttls = ttlsIn(captured.worker);
    expect(ttls.length).toBeGreaterThan(0);
    expect(ttls).not.toContain('1h');
  }, 60_000);

  it('withManagerWorkerCacheTtl の env を置くと、作業者の要求のキャッシュの印がすべて 1h になる', async () => {
    const captured = await runProbe(withManagerWorkerCacheTtl({}));

    expect(captured.worker.length).toBeGreaterThan(0);
    const ttls = ttlsIn(captured.worker);
    expect(ttls.length).toBeGreaterThan(0);
    expect(new Set(ttls)).toEqual(new Set(['1h']));
  }, 60_000);

  it('親（マネージャー本体）の寿命は動かさない（主の会話の寿命は CLI の自動判定に任せたまま）', async () => {
    const before = await runProbe({});
    const after = await runProbe(withManagerWorkerCacheTtl({}));

    expect(after.parent.length).toBeGreaterThan(0);
    expect(new Set(ttlsIn(after.parent))).toEqual(new Set(ttlsIn(before.parent)));
  }, 120_000);
});
