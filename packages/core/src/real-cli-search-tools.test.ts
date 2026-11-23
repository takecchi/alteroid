import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { SEARCH_TOOLS_OPT_IN } from './claude-provider.js';

/**
 * 同梱の CLI が、preset のままでは Grep / Glob を外すこと、`SEARCH_TOOLS_OPT_IN` を渡すと親にも作業者にも戻ること、
 * 戻した Grep / Glob で作業ディレクトリの外を探すと Read と同じく確認（`canUseTool`）へ回ることを固定する。
 * 本物の資格は使わず、偽の API を 127.0.0.1 に立てて、CLI が送った要求の本文（道具の一覧と道具の結果）を読む。
 * 対照（何も渡さないと外れる・素の名前だと確認を経ない）も確かめる: 外れなくなった版や、素の名前が確認を経るようになった版では、こちらの主張が空回りになるため。
 */

const WORKER_MARK = 'ALTEROID_SEARCH_TOOLS_PROBE_WORKER';
const SEARCH_TOOLS = ['Glob', 'Grep'];

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

function replyToolUse(res: http.ServerResponse, name: string, input: unknown): void {
  reply(
    res,
    { type: 'tool_use', id: 'toolu_probe', name, input: {} },
    { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    'tool_use',
  );
}

function replyDone(res: http.ServerResponse): void {
  reply(res, { type: 'text', text: '' }, { type: 'text_delta', text: 'done' }, 'end_turn');
}

interface ParsedRequest {
  system?: unknown;
  tools?: Array<{ name?: string }>;
}

/** 偽の API。最初の要求にだけ `firstCall` の道具呼び出しを返し、あとは終える。受けた要求を親と作業者に分けて残す。 */
async function startFakeApi(
  firstCall: { name: string; input: unknown },
  captured: { parent: ParsedRequest[]; worker: ParsedRequest[]; bodies: string[] },
): Promise<string> {
  let sent = false;
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
      let parsed: ParsedRequest = {};
      try {
        parsed = JSON.parse(body) as ParsedRequest;
      } catch {
        parsed = {};
      }
      const isWorker = JSON.stringify(parsed.system ?? '').includes(WORKER_MARK);
      (isWorker ? captured.worker : captured.parent).push(parsed);
      captured.bodies.push(body);
      if (!isWorker && !sent) {
        sent = true;
        replyToolUse(res, firstCall.name, firstCall.input);
        return;
      }
      replyDone(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface ProbeResult {
  parentTools: string[];
  workerTools: string[];
  asked: string[];
  bodies: string[];
}

async function runProbe(
  allowedTools: readonly string[] | undefined,
  firstCall: { name: string; input: unknown },
): Promise<ProbeResult> {
  const captured = {
    parent: [] as ParsedRequest[],
    worker: [] as ParsedRequest[],
    bodies: [] as string[],
  };
  const baseUrl = await startFakeApi(firstCall, captured);
  const home = await makeTempDir('alteroid-real-cli-search-tools-');
  const asked: string[] = [];

  const q = query({
    prompt: 'probe',
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 4,
      // `default` にする: 確認へ回るかどうかを `canUseTool` の呼ばれ方で見るため
      permissionMode: 'default',
      canUseTool: async (name, input) => {
        asked.push(`${name} ${JSON.stringify(input)}`);
        // 作業者を起こす呼び出しだけは通す: 作業者の道具の一覧を取るため
        return name === 'Agent'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'probe-deny' };
      },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'probe' },
      agents: {
        worker: {
          description: 'probe',
          prompt: WORKER_MARK,
          model: 'claude-haiku-4-5-20251001',
        },
      },
      ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
      settingSources: [],
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

  const namesIn = (requests: ParsedRequest[]) =>
    [...new Set(requests.flatMap((r) => (r.tools ?? []).map((t) => t.name ?? '')))].sort();
  return {
    parentTools: namesIn(captured.parent),
    workerTools: namesIn(captured.worker),
    asked,
    bodies: captured.bodies,
  };
}

const START_WORKER = {
  name: 'Agent',
  input: {
    subagent_type: 'worker',
    description: 'probe',
    prompt: 'probe',
    run_in_background: false,
  },
};
// 作業ディレクトリ（一時の HOME）の外。読めるファイルが在る所を選ぶ: 確認を経ずに通ったとき、結果が本文に現れて見分けられるため
const GREP_OUTSIDE = { name: 'Grep', input: { pattern: 'root', path: '/etc' } };
const GLOB_OUTSIDE = { name: 'Glob', input: { pattern: '*', path: '/etc' } };

function searchToolsIn(tools: readonly string[]): string[] {
  return tools.filter((name) => SEARCH_TOOLS.includes(name));
}

describe('real CLI: Grep / Glob の道具', () => {
  it('allowedTools を渡さないと、親にも作業者にも Grep / Glob が無く、Bash は在る（対照）', async () => {
    const result = await runProbe(undefined, START_WORKER);

    expect(result.workerTools.length).toBeGreaterThan(0);
    expect(result.parentTools).toContain('Bash');
    expect(searchToolsIn(result.parentTools)).toEqual([]);
    expect(searchToolsIn(result.workerTools)).toEqual([]);
  }, 60_000);

  it('SEARCH_TOOLS_OPT_IN を渡すと、親にも作業者にも Grep / Glob が戻る', async () => {
    const result = await runProbe(SEARCH_TOOLS_OPT_IN, START_WORKER);

    expect(result.workerTools.length).toBeGreaterThan(0);
    expect(searchToolsIn(result.parentTools)).toEqual(SEARCH_TOOLS);
    expect(searchToolsIn(result.workerTools)).toEqual(SEARCH_TOOLS);
  }, 60_000);

  it('SEARCH_TOOLS_OPT_IN で戻した Grep / Glob は、作業ディレクトリの外を探すと確認へ回る', async () => {
    for (const call of [GREP_OUTSIDE, GLOB_OUTSIDE]) {
      const result = await runProbe(SEARCH_TOOLS_OPT_IN, call);

      expect(result.asked).toEqual([`${call.name} ${JSON.stringify(call.input)}`]);
      expect(result.bodies.some((body) => body.includes('probe-deny'))).toBe(true);
    }
  }, 60_000);

  it('素の名前（Grep / Glob）で戻すと、作業ディレクトリの外の検索が確認を経ずに通る（対照: 範囲を付ける理由）', async () => {
    for (const call of [GREP_OUTSIDE, GLOB_OUTSIDE]) {
      const result = await runProbe(SEARCH_TOOLS, call);

      expect(result.asked).toEqual([]);
      expect(result.bodies.some((body) => body.includes('probe-deny'))).toBe(false);
    }
  }, 60_000);
});
