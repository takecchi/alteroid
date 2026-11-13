import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import type { AgentChildProcess } from './agent-session.js';
import { createCredentialStore } from './credentials.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 出し箱の取り込み（`collectManagerOutbox`）だけを、決着を試験が握れる Promise に差し替える（他の関数は本物）。
// 取り込みの待ちの途中で、背景の peer を止めるため。
const outboxGate = vi.hoisted(() => ({ current: undefined as Promise<unknown> | undefined }));
vi.mock('./runner-outbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runner-outbox.js')>();
  return {
    ...original,
    collectManagerOutbox: (...args: Parameters<typeof original.collectManagerOutbox>) =>
      outboxGate.current ?? original.collectManagerOutbox(...args),
  };
});

// `RunnerSession` が `RunnerReportEmitter` へ値を渡す所（呼び元 `#applyTurnEnded`）の、`runner-report-emit-pin.test.ts` が縛れない 2 点を縛る。
// (1) 呼び元の周回数: pin は「1 本目の report が見える周回数」を縛るが、呼び元が `emit` をどう呼ぶか（`await` を足す・`async` で包む・
//     `return` へ変える）は、1 本目が出た後の周回なので見えない。それは、後ろに続く出来事（直後に積んだ 2 本目・3 本目の `result`）が処理される
//     周回数として現れる: `#read` は出来事を 1 件ずつ `await #apply` で処理するので、`#applyTurnEnded` の Promise が決着する周回が 1 つ増えると、
//     続く report が見える周回も増える。値（3 / 8 / 13）は切り出し前の runner.ts（a9f8fa8b）でも同じであることを実測した。
// (2) 背景処理の一覧を取り込みの `await` より前に 1 回だけ読むこと: 取り込みの待ちの間に背景の peer が止まっても、`awaitingBackground` は
//     取り込み前の一覧で出る。SDK 由来の一覧は `#read` が出来事を直列に処理するので待ちの間には変わらず、変わりうるのは背景の peer だけ
//     （Codex の app server の偽物と peer_run の run_in_background が要る）。
// 実時間では待たない。フェイクの SDK と rig は pin のものと同じ形（pin は変えないので写した）。

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    let ended = false;
    const buffered: SDKMessage[] = [];
    const endOutput = () => {
      ended = true;
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(null);
      }
    };
    const record: Started = {
      options: input.options,
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
    };
    started.push(record);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: endOutput,
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-report-emit-wiring-');
  outboxGate.current = undefined;
});

afterEach(async () => {
  outboxGate.current = undefined;
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

async function open(
  throwOn?: (event: RunnerEvent) => boolean,
): Promise<{ started: Started; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  let thrown = false;
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (!thrown && throwOn?.(event) === true) {
        thrown = true;
        throw new Error('emit が落ちた（テスト用）');
      }
    },
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started: first, events };
}

function result(started: Started, uuid: string): void {
  started.push({
    type: 'result',
    subtype: 'success',
    result: uuid,
    session_id: 'sess-mgr',
    uuid,
  } as unknown as SDKMessage);
}

const reportsOf = (events: readonly RunnerEvent[]): ReportEvent[] =>
  events.filter((event): event is ReportEvent => event.type === 'report');
const reportIds = (events: readonly RunnerEvent[]): string[] =>
  reportsOf(events).flatMap((e) => (e.reportId === undefined ? [] : [e.reportId]));

describe('呼び元 #applyTurnEnded の周回（emit を同期で呼ぶ）', () => {
  // 文脈占有の観測を `report` の後ろの鎖へ移したので、先頭の `await #observeContextUsage` の1周が無くなり、切り出し前の 3 / 8 / 13 から各 1 周回減って 2 / 7 / 12（間隔 5 は同じ）
  it('result を 3 本続けて積んだとき、各 report が見える周回数（2 / 7 / 12。間隔は切り出し前と同じ）', async () => {
    const rig = await open();
    result(rig.started, 'r1');
    result(rig.started, 'r2');
    result(rig.started, 'r3');
    const seenAt: Record<string, number> = {};
    for (let ticks = 0; ticks < 200 && Object.keys(seenAt).length < 3; ticks += 1) {
      await Promise.resolve();
      for (const id of reportIds(rig.events)) seenAt[id] ??= ticks;
    }
    expect(seenAt).toMatchInlineSnapshot(`
      {
        "r1": 2,
        "r2": 7,
        "r3": 12,
      }
    `);
  });
});

describe('wakeForFinishedBackgroundTaskOutputs の口は同期のまま渡す（async で包まない）', () => {
  it('起こしの中の emit が同期で投げたら、その投げは report の後の呼び元へ伝わり、セッションが閉じる', async () => {
    // 打ち切った作業者の背景処理が、走っている最中に終わった状態を作る（`runner-report-emit-pin.test.ts` と同じ手順）
    const rig = await open(
      (event) => event.type === 'note' && event.text.includes('止まっていたマネージャーを起こした'),
    );
    const hook = (name: 'PostToolUse' | 'SubagentStop', input: Record<string, unknown>) => {
      const found = rig.started.options.hooks?.[name]?.[0]?.hooks?.[0];
      if (found === undefined) throw new Error(`${name} フックが登録されていない`);
      return found(input as never, undefined, { signal: new AbortController().signal });
    };
    await hook('PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 90', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-agent-1' },
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    vi.useFakeTimers();
    try {
      const stopped = hook('SubagentStop', {
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_transcript_path: '/tmp/does-not-exist.jsonl',
        agent_type: 'worker',
        session_crons: [],
        agent_id: 'agent-1',
        background_tasks: [
          { id: 'agent-1', type: 'subagent', status: 'running', description: '当人' },
          { id: 'bg-agent-1', type: 'monitor', status: 'running', command: 'sleep 90' },
        ],
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
    await hook('PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-test-1' },
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    rig.started.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bg-test-1',
      status: 'completed',
      summary: '完了',
      output_file: '/tmp/out-1554.txt',
      uuid: 'uuid-task-notification-w',
      session_id: 'sess-mgr',
    } as unknown as SDKMessage);
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    result(rig.started, 'r-wake');
    // 投げた後にセッションが閉じる（`closed`）のは非同期で、いつ届くかが揺れる: 届くまで回す（実時間では待たない）
    for (let ticks = 0; ticks < 100 && !rig.events.some((e) => e.type === 'closed'); ticks += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(rig.events.some((event) => event.type === 'closed')).toBe(true);
  });
});

// --- 背景の peer（Codex の app server の偽物）---

type Json = Record<string, unknown>;
const THREAD = '0199c0a1-2b3c-7d4e-8f50-123456789abc';

/** turn/start のあと、`release()` が呼ばれるまで turn/completed を返さない偽の app-server。 */
function fakeAppServer(rolloutFile: string, gate: { release: () => void }) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';
  const send = (message: Json): void => void stdout.write(`${JSON.stringify(message)}\n`);
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, i)) as Json;
      buffer = buffer.slice(i + 1);
      const id = message['id'] as number | undefined;
      const method = message['method'];
      if (typeof method !== 'string' || id === undefined) continue;
      if (method === 'account/read') {
        send({
          id,
          result: {
            requiresOpenaiAuth: false,
            account: { type: 'chatgpt', email: null, planType: 'plus' },
          },
        });
      } else if (method === 'thread/start' || method === 'thread/resume') {
        send({
          id,
          result: {
            thread: { id: THREAD, cwd: '/work', path: rolloutFile },
            model: 'gpt-5',
            approvalPolicy: 'untrusted',
          },
        });
      } else if (method === 'turn/start') {
        send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        gate.release = () => {
          mkdirSync(dirname(rolloutFile), { recursive: true });
          appendFileSync(rolloutFile, '\n');
          send({
            method: 'item/completed',
            params: {
              threadId: THREAD,
              turnId: 'turn-1',
              item: { type: 'agentMessage', id: 'm1', text: '終わった' },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: 'turn-1', status: 'completed', items: [] } },
          });
        };
      } else {
        send({
          id,
          result: { userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' },
        });
      }
    }
  });
  return Object.assign(emitter, {
    stdin,
    stdout,
    killed: false,
    exitCode: null,
    pid: 7002,
    kill: () => true,
  }) as unknown as AgentChildProcess;
}

describe('liveBackground は取り込みの await より前に 1 回だけ読む', () => {
  it('取り込みの待ちの間に背景の peer が止まっても、awaitingBackground は取り込み前の一覧（peer 1 件）で出る', async () => {
    const home = makeTempDirSync('alteroid-report-emit-wiring-home-');
    const rolloutFile = join(home, '.codex', 'sessions', 'rollout.jsonl');
    const outboxRoot = join(dir, 'outbox');
    const events: RunnerEvent[] = [];
    const { fn, started } = fakeRunnerSdk();
    const turn = { release: () => undefined as void };
    let captured: (() => McpServer) | undefined;
    const peerHost: PeerSocketHost = {
      socketPath: '/run/alteroid/peer/peer.sock',
      register: (factory) => {
        captured = factory;
        return 'tok-1';
      },
      close: () => undefined,
    };
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => {
        events.push(event);
      },
      queryFn: fn,
      env: {},
      childUser: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home },
      spawnAgentProcessFn: () => fakeAppServer(rolloutFile, turn),
      credentials: createCredentialStore({
        dir: makeTempDirSync('alteroid-report-emit-wiring-cred-'),
        seed: {},
      }),
      codexHome: makeTempDirSync('alteroid-report-emit-wiring-codex-'),
      peer: {
        openSocket: async () => peerHost,
        reportsUsage: () => true,
        childEntry: '/app/relay.js',
        workdirRoot: makeTempDirSync('alteroid-report-emit-wiring-workdir-'),
      },
      outboxRoot,
      outboxStagedRoot: join(dir, 'outbox-staged'),
    });
    await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const sdk = started[0];
    if (sdk === undefined || captured === undefined) throw new Error('rig が組めていない');
    const server = captured();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: '調べて', run_in_background: true },
    });
    // 出し箱に 1 件置く（空でなければ取り込みの `await` に入る）。取り込みは決着を握った Promise に差し替えてある
    mkdirSync(join(outboxRoot, 'mgr-1'), { recursive: true });
    writeFileSync(join(outboxRoot, 'mgr-1', 'a.txt'), 'a');
    let openGate: (value: unknown) => void = () => undefined;
    outboxGate.current = new Promise((resolve) => {
      openGate = resolve;
    });
    events.length = 0;
    result(sdk, 'r-bg');
    // 取り込みの待ちに入るまで回す。この間は report が出ない
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const reportsBefore = reportsOf(events).length;
    // 待ちの間に、背景の peer を止める（`inBackground` が下りる）
    turn.release();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    openGate({});
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const reports = reportsOf(events).filter((report) => report.reportId === 'r-bg');
    expect({
      reportsBefore,
      awaitingBackground: reports.map((report) => report.awaitingBackground),
    }).toMatchInlineSnapshot(`
      {
        "awaitingBackground": [
          {
            "breakdown": "peer:codex×1",
            "count": 1,
          },
        ],
        "reportsBefore": 0,
      }
    `);
    await client.close();
  });
});
