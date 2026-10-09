import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore, fingerprintOf } from './credentials.js';
import { PEER_MCP_SERVER_NAME } from './peer-broker.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';
import { runnerManagerStateSchema, type RunnerEvent } from './runner-protocol.js';

interface FakeManagerSession {
  inputs: readonly string[];
  say(text: string): void;
  ask(toolName: string, input: Record<string, unknown>): void;
  backgroundTasksChanged(tasks: readonly { id: string; taskType: string }[]): void;
  restartInit(sessionId: string): void;
  finish(text: string, options?: { subtype?: string; isError?: boolean }): void;
  crash(): void;
}

function fakeSdk(opts: { abortOnInputClose?: boolean; skipInit?: boolean } = {}): {
  fn: typeof sdkQuery;
  sessions: FakeManagerSession[];
  startedOptions: Options[];
} {
  const abortOnInputClose = opts.abortOnInputClose ?? false;
  const sessions: FakeManagerSession[] = [];
  const startedOptions: Options[] = [];
  let seq = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const isFirstSession = sessions.length === 0;
    startedOptions.push(params.options as Options);
    const label =
      (params.options as Options | undefined)?.resume ?? `sess-${String(sessions.length + 1)}`;
    const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
      Symbol.asyncIterator
    ]();
    const inputs: string[] = [];
    const queued: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let crashed = false;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (message: SDKMessage) => {
      queued.push(message);
      notify();
    };

    const session: FakeManagerSession = {
      inputs,
      say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: label,
          uuid: `uuid-say-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
          })),
          session_id: label,
          uuid: `uuid-bg-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      ask(toolName, input) {
        const canUseTool = params.options?.canUseTool;
        if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
        // await しない: 確認を開いたまま答えない状態を作るため。
        void canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${String(++seq)}`,
          requestId: `req-${String(++seq)}`,
        } as never);
      },
      restartInit(sessionId) {
        push({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          uuid: `uuid-init-restart-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      finish(text, options = {}) {
        push({
          type: 'result',
          subtype: options.subtype ?? 'success',
          result: text,
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
      },
      crash() {
        crashed = true;
        notify();
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (!(opts.skipInit === true && isFirstSession)) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: label,
          uuid: `uuid-init-${String(sessions.length)}`,
        } as unknown as SDKMessage;
      }

      let pendingInput = iterator.next();
      for (;;) {
        const current = await pendingInput;
        if (current.done === true) return;
        inputs.push(String(current.value.message.content));

        // 読み先行: `#inputStream` の境界判定が「ターンが走っている」状態で発火するのは、この形のときだけ。
        const lookahead = iterator.next();

        let sawResult = false;
        while (!sawResult) {
          if (crashed) return;
          const queuedNext = queued.shift();
          if (queuedNext !== undefined) {
            if (queuedNext.type === 'result') sawResult = true;
            yield queuedNext;
            continue;
          }
          if (abortOnInputClose) {
            const raced = await Promise.race([
              lookahead.then(() => 'closed' as const),
              new Promise<'wake'>((resolve) => {
                wake = () => resolve('wake');
              }),
            ]);
            if (raced === 'closed') return;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }

        pendingInput = lookahead;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, startedOptions };
}

interface OutOfBandSession {
  say(text: string): void;
  backgroundTasksChanged(tasks: readonly { id: string; taskType: string }[]): void;
  finish(text: string, options?: { subtype?: string; isError?: boolean }): void;
}

function fakeSdkOutOfBand(): {
  fn: typeof sdkQuery;
  sessions: OutOfBandSession[];
  startedOptions: Options[];
} {
  const sessions: OutOfBandSession[] = [];
  const startedOptions: Options[] = [];
  let seq = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    startedOptions.push(params.options as Options);
    const label =
      (params.options as Options | undefined)?.resume ?? `sess-${String(sessions.length + 1)}`;

    let emit: ((message: SDKMessage | null) => void) | null = null;
    let outputEnded = false;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    };
    // `emit` は必ずこの関数越しに解決する: 場所ごとに書くと、閉包を跨いだ `emit` の型の絞り込みが崩れる。
    const endOutput = () => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(null);
      }
    };

    const session: OutOfBandSession = {
      say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: label,
          uuid: `uuid-say-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
          })),
          session_id: label,
          uuid: `uuid-bg-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      finish(text, options = {}) {
        push({
          type: 'result',
          subtype: options.subtype ?? 'success',
          result: text,
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: label,
        uuid: `uuid-init-${String(sessions.length)}`,
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (outputEnded) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          if (outputEnded) {
            resolve(null);
            return;
          }
          emit = resolve;
        });
        if (message === null) return;
        yield message;
      }
    }

    // 入力側を読み続けるのは必須: 読まないと本物の `#inputStream` が駆動されず、境界判定が走らない。
    void (async () => {
      const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          outputEnded = true;
          endOutput();
          return;
        }
      }
    })();

    const generator = generate();
    return Object.assign(generator, {
      close: endOutput,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, startedOptions };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-token-rotation-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

const OLD_TOKEN = 'token-fake-old-000';

// 既定の根（os.tmpdir() 配下の共有の名前）に触らない: runner の器では root 所有で作れず、余計な note が出るため
function outboxRoots(): { outboxRoot: string; outboxStagedRoot: string } {
  return { outboxRoot: join(dir, 'outbox'), outboxStagedRoot: join(dir, 'outbox-staged') };
}

function setup(
  fakeOpts?: Parameters<typeof fakeSdk>[0],
  extra: Pick<RunnerHostOptions, 'peer' | 'codexHome'> = {},
) {
  const events: RunnerEvent[] = [];
  const { fn, sessions, startedOptions } = fakeSdk(fakeOpts);
  const credentials = createCredentialStore({
    dir: join(dir, 'creds'),
    seed: { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN },
    names: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    credentials,
    ...outboxRoots(),
    ...extra,
  });
  hosts.push(host);
  return { host, events, sessions, startedOptions };
}

async function nthSession(
  sessions: readonly FakeManagerSession[],
  index: number,
): Promise<FakeManagerSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) {
      throw new Error(`${String(index + 1)}本目のセッションがまだ開いていない`);
    }
    return found;
  });
}

function setupOutOfBand() {
  const events: RunnerEvent[] = [];
  const { fn, sessions, startedOptions } = fakeSdkOutOfBand();
  const credentials = createCredentialStore({
    dir: join(dir, 'creds-oob'),
    seed: { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN },
    names: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    credentials,
    ...outboxRoots(),
  });
  hosts.push(host);
  return { host, events, sessions, startedOptions };
}

async function nthOutOfBandSession(
  sessions: readonly OutOfBandSession[],
  index: number,
): Promise<OutOfBandSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) {
      throw new Error(`${String(index + 1)}本目のセッションがまだ開いていない`);
    }
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;
type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

async function reportEvents(
  events: readonly RunnerEvent[],
  expected: number,
): Promise<ReportEvent[]> {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ReportEvent => event.type === 'report');
    if (found.length < expected) {
      throw new Error(
        `report が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found;
  });
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('認証トークンを回した後、走行中のマネージャーのセッションを畳んで開き直す', () => {
  it('⚠️ ターンの途中では畳まない。走っているターンは最後まで走る', async () => {
    const s = setup({ abortOnInputClose: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-111' }]);
    await tick();

    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.text).toContain('わかった');
  });

  it('ターンの境界で、指紋が変わったときだけ畳んで開き直す（同じ指紋では開き直さない）', async () => {
    const s = setup({ abortOnInputClose: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-222' }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await nthSession(s.sessions, 1);
    expect(s.sessions).toHaveLength(2);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-222');
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
    expect(s.startedOptions[0]?.resume).toBeUndefined();
  });

  it('同じ指紋を何度渡しても開き直さない（再接続の追いつかせが繰り返し呼んでも壊れない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await tick(40);

    expect(s.sessions).toHaveLength(1);
  });

  it('認証トークン以外の名前（任意の名前・GH_TOKEN）が増えても、ターンの境界で畳んで新しい env で開き直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);
    expect(s.sessions).toHaveLength(1);

    await s.host.setCredentials([
      { name: 'GH_TOKEN', value: 'ghp-fake-new-1' },
      { name: 'MY_CUSTOM_VAR', value: 'custom-1' },
    ]);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.GH_TOKEN).toBe('ghp-fake-new-1');
    expect(s.startedOptions[1]?.env?.MY_CUSTOM_VAR).toBe('custom-1');
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
  });

  it('認証トークン以外の名前の値が変わっても畳む。同じ値の書き直しでは畳まない', async () => {
    const s = setup();
    await s.host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp-fake-v1' }]);
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp-fake-v1' }]);
    await tick(40);
    expect(s.sessions).toHaveLength(1);

    await s.host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp-fake-v2' }]);
    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.GH_TOKEN).toBe('ghp-fake-v2');
  });

  it('削除（空値）も変更として畳む。開き直した env からその名前は消えている', async () => {
    const s = setup();
    await s.host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp-fake-v1' }]);
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);
    expect(s.startedOptions[0]?.env?.GH_TOKEN).toBe('ghp-fake-v1');

    await s.host.setCredentials([{ name: 'GH_TOKEN', value: '' }]);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env).not.toHaveProperty('GH_TOKEN');
  });

  it('ターンの途中では、認証トークン以外の更新でも畳まない（走っているターンは最後まで走る）', async () => {
    const s = setup({ abortOnInputClose: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);

    await s.host.setCredentials([{ name: 'MY_CUSTOM_VAR', value: 'custom-1' }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');
    const [report] = await reportEvents(s.events, 1);
    expect(report?.text).toContain('わかった');
    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.MY_CUSTOM_VAR).toBe('custom-1');
  });

  it('確認待ちが在るあいだは畳まない。答えて片付いた境界で畳む', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.ask('Bash', { command: 'echo hi' });
    first.finish('確認をお願いします');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.status).toBe('waiting_human');

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-333' }]);
    await tick(30);
    expect(s.sessions).toHaveLength(1);

    const requestId = s.host.list()[0]?.waiting[0]?.requestId;
    if (requestId === undefined) throw new Error('waiting が見つからない');
    await s.host.answer('mgr-1', { requestId, decision: 'allow', message: 'どうぞ' });
    await tick();
    expect(s.sessions).toHaveLength(1);

    // 偽 SDK は「1つの入力 ⟹ 1ターン」しか表せないので、答えた後の続きは新しい入力にする。
    await s.host.send('mgr-1', '続けて');
    await tick(10);
    first.say('実行した');
    first.finish('実行した');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-333');
  });

  it('背景処理が生きているあいだは畳まない。片付いた境界で畳む', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.awaitingBackground).toBeDefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-444' }]);
    await tick(30);
    expect(s.sessions).toHaveLength(1);

    await s.host.send('mgr-1', '続けて');
    await tick(10);
    first.backgroundTasksChanged([]);
    first.say('続けました');
    first.finish('続けました');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-444');
  });

  it('#sessionId がまだ無ければ畳まない。session_started の後は畳む', async () => {
    const s = setup({ skipInit: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.say('init を一度も見ていない状態で終える');
    first.finish('init を一度も見ていない状態で終える');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.status).toBe('done');
    expect(s.host.list()[0]?.sessionId).toBeUndefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-555' }]);
    await tick(30);
    expect(s.sessions).toHaveLength(1);

    first.restartInit('sess-late');
    await s.host.send('mgr-1', 'つづき');
    await tick(10);
    first.say('つづきの結果');
    first.finish('つづきの結果');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-555');
    expect(s.startedOptions[1]?.resume).toBe('sess-late');
  });

  it('跡（note）を1本出す。値も指紋の照合結果も書かない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-666' }]);
    await tick(30);
    await nthSession(s.sessions, 1);

    const notes = s.events.filter((event): event is NoteEvent => event.type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('認証トークン');
    expect(notes[0]?.text).not.toContain('token-fake-new-666');
    expect(notes[0]?.text).not.toContain(OLD_TOKEN);
    expect(notes[0]?.tokenRotation).toBe(true);
  });

  /**
   * 印を `#recycleForToken` 1本にしない: 意図が立ったまま境界が来る前に SDK
   * が自分の理由で閉じると、畳み直しと誤認して嘘の `note` を出し、答えていない
   * 確認を道連れに開き直す。`#endedInputForTokenRotation` との2本で見分ける。
   */
  it('⚠️ 印が立っている最中に SDK が自分の理由で閉じても、畳み直しとして開き直さない（note も出ない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.ask('Bash', { command: 'echo hi' });
    await tick();
    expect(s.host.list()[0]?.status).toBe('waiting_human');

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-777' }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.crash();

    await vi.waitFor(() => {
      const found = s.events.filter((event) => event.type === 'closed');
      if (found.length === 0) throw new Error('closed がまだ届いていない');
      return found;
    });

    expect(s.sessions).toHaveLength(1);
    const notes = s.events.filter((event): event is NoteEvent => event.type === 'note');
    expect(notes).toHaveLength(0);
  });

  it('畳み直しの後もマネージャーは使える（closed が出ない・新しいセッションに入力が届く）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-888' }]);
    const second = await nthSession(s.sessions, 1);

    expect(s.events.some((event) => event.type === 'closed')).toBe(false);

    await s.host.send('mgr-1', 'つづけて');
    await vi.waitFor(() => {
      if (!second.inputs.includes('つづけて')) {
        throw new Error('新しいセッションに入力が届いていない');
      }
    });

    second.say('つづけました');
    second.finish('つづけました');
    const reports = await reportEvents(s.events, 2);
    expect(reports[1]?.text).toContain('つづけました');
    expect(s.events.some((event) => event.type === 'closed')).toBe(false);
  });

  it('⚠️ 新しい入力を伴わない、背景処理の完了だけでも起こす（#apply の background_tasks 枝）', async () => {
    const s = setupOutOfBand();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthOutOfBandSession(s.sessions, 0);

    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.awaitingBackground).toBeDefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-999' }]);
    await tick(30);
    expect(s.sessions).toHaveLength(1);

    first.backgroundTasksChanged([]);

    await nthOutOfBandSession(s.sessions, 1);
    expect(s.sessions).toHaveLength(2);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-999');
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
  });
});

describe('resume が生きた旧プロセスへ短絡したかを応答で名乗る（#2877）', () => {
  it('⚠️ 境界に達していない旧セッションへ resume すると、旧プロセスへ流れ、reusedLiveSession: true が返る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    await reportEvents(s.events, 1);
    await s.host.setCredentials([
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-2877' },
    ]);

    const resumed = await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/work/project',
      request: '調べて',
      message: '続けて',
    });

    expect(resumed.reusedLiveSession).toBe(true);
    await vi.waitFor(() => {
      if (!first.inputs.includes('続けて')) throw new Error('旧プロセスに届いていない');
    });
    expect(s.startedOptions).toHaveLength(1);
    first.backgroundTasksChanged([]);
    first.finish('終わり');
  });

  it('生きたセッションが居なければ新しい SDK が起き、reusedLiveSession: false が返る', async () => {
    const s = setup();

    const resumed = await s.host.resume({
      managerId: 'mgr-9',
      sessionId: 'sess-9',
      cwd: '/work/project',
      request: '調べて',
      message: '続けて',
    });

    expect(resumed.reusedLiveSession).toBe(false);
    const opened = await nthSession(s.sessions, 0);
    opened.finish('終わり');
    expect(s.startedOptions[0]?.resume).toBe('sess-9');
    expect(s.startedOptions[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(OLD_TOKEN);
  });
});

describe('list() が、セッションが起動時に掴んだ鍵の指紋を運ぶ（#2877 PR2）', () => {
  it('起動時の鍵の指紋を返す。値そのものは載せない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    const [state] = s.host.list();

    expect(state?.tokenFingerprint).toBe(fingerprintOf(OLD_TOKEN));
    expect(JSON.stringify(s.host.list())).not.toContain(OLD_TOKEN);
    first.finish('終わり');
  });

  it('⚠️ 鍵が回っても、境界に達していない旧セッションは古い指紋のまま。畳み直した後は新しい指紋', async () => {
    const s = setupOutOfBand();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthOutOfBandSession(s.sessions, 0);
    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    await reportEvents(s.events, 1);
    const NEW_TOKEN = 'token-fake-new-2877-fp';
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: NEW_TOKEN }]);

    expect(s.host.list()[0]?.tokenFingerprint).toBe(fingerprintOf(OLD_TOKEN));

    first.backgroundTasksChanged([]);
    await nthOutOfBandSession(s.sessions, 1);
    expect(s.host.list()[0]?.tokenFingerprint).toBe(fingerprintOf(NEW_TOKEN));
    expect(JSON.stringify(s.host.list())).not.toContain(NEW_TOKEN);
  });
});

describe('古い daemon の schema が、tokenFingerprint 付きの応答を落とさず読める（#2877 PR2）', () => {
  // 本物の schema を `omit` しない: 本物が strict でないことに頼らず、古い形を手で再現する。
  const legacyRunnerManagerStateSchema = z.object({
    managerId: z.string(),
    status: z.string(),
    cwd: z.string(),
    request: z.string(),
    waiting: z.array(
      z.object({
        requestId: z.string(),
        summary: z.string(),
        kind: z.string(),
        askedAt: z.string(),
      }),
    ),
    sessionId: z.string().optional(),
    liveBackgroundTasks: z.number().int().nonnegative().optional(),
  });

  it('本物の新しい runner の state()（tokenFingerprint 付き）を、古い schema がそのまま読める', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    const listed = s.host.list();
    expect(listed[0]?.tokenFingerprint).toBe(fingerprintOf(OLD_TOKEN));

    const parsed = z.array(legacyRunnerManagerStateSchema).safeParse(listed);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.[0]).toMatchObject({
      managerId: 'mgr-1',
      status: listed[0]?.status,
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
    });
    first.finish('終わり');
  });

  it('将来だれかが本物の schema を .strict() にしたら落ちる（未知の欄を捨てて読めること自体を固定する）', () => {
    const withFutureField = {
      managerId: 'mgr-1',
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      tokenFingerprint: 'aaaaaaaaaaaa',
      someFutureField: 'まだ誰も知らない欄',
    };

    const parsed = runnerManagerStateSchema.safeParse(withFutureField);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ managerId: 'mgr-1', cwd: '/work/project' });
  });
});

describe('Codex の資格が届いた・外れたら、走行中のマネージャーをターンの境界で組み直して peer の道具を出し入れする（#4118）', () => {
  const peerNames = (options: Options | undefined): string[] =>
    Object.keys((options?.mcpServers as Record<string, unknown> | undefined) ?? {});

  function setupWithPeer() {
    return setup(
      { abortOnInputClose: true },
      {
        codexHome: join(dir, 'codex-home'),
        peer: {
          openSocket: async () => ({
            socketPath: '/run/alteroid/peer/peer.sock',
            register: () => 'tok',
            close: () => undefined,
          }),
          reportsUsage: () => true,
          childEntry: '/app/relay.js',
        },
      },
    );
  }

  it('ログインが届いても走っているターンは畳まず、境界で開き直したセッションに peer が載る', async () => {
    const s = setupWithPeer();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);
    expect(peerNames(s.startedOptions[0])).toEqual([]);

    await s.host.setCodexAuth({ value: '{}', revision: 'r1' });
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);
    await nthSession(s.sessions, 1);
    expect(peerNames(s.startedOptions[1])).toEqual([PEER_MCP_SERVER_NAME]);
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
  });

  it('ログアウトでも走っているターンは畳まず、境界で開き直したセッションから peer が消える', async () => {
    const s = setupWithPeer();
    await s.host.setCodexAuth({ value: '{}', revision: 'r1' });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);
    expect(peerNames(s.startedOptions[0])).toEqual([PEER_MCP_SERVER_NAME]);

    await s.host.setCodexAuth(null);
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);
    await nthSession(s.sessions, 1);
    expect(peerNames(s.startedOptions[1])).toEqual([]);
  });

  it('トークンの更新（ログインのまま版だけ変わる）では開き直さない', async () => {
    const s = setupWithPeer();
    await s.host.setCodexAuth({ value: '{}', revision: 'r1' });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);
    expect(peerNames(s.startedOptions[0])).toEqual([PEER_MCP_SERVER_NAME]);

    await s.host.setCodexAuth({ value: '{"refreshed":true}', revision: 'r2' });
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);
    await tick();
    expect(s.sessions).toHaveLength(1);
  });
});
