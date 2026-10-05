import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * Issue #1554: 打ち切った作業者の背景処理が終わったとき、マネージャーが
 * 止まっていれば alteroid が `push()` で起こす。
 *
 * 配達経路は2つ（走っているとき＝次の道具呼び出し〈PostToolUse〉、止まって
 * いるとき＝`push()`）で、取り出し＝消費なので二重には届かない。走っている
 * 最中に積まれた分は、道具呼び出しが無いまま `result` で畳まれたときに拾う。
 * 偽の SDK は `runner-wakeup.test.ts` の形（`inputs` = `#inputStream` が
 * 実際に `yield` した入力）に、フックを直接叩く口を足したもの。
 */

interface FakeSession {
  options: Options;
  inputs: string[];
  /** `close()` が来てもストリームを終わらせない（畳み中の窓を作る）。 */
  holdClose(): void;
  /** 止めていた `close()` の分のストリーム終了を流す。 */
  releaseClose(): void;
  /** 1ターンを畳む（`result`）。 */
  finish(text: string): Promise<void>;
  /** `system/task_notification` を1件流す。 */
  notify(taskId: string, extra?: Record<string, unknown>): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    let closed = false;
    let holdClose = false;

    sessions.push({
      options,
      inputs,
      holdClose() {
        holdClose = true;
      },
      releaseClose() {
        holdClose = false;
        if (closed) emit?.(null);
      },
      async finish(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${text}`,
        } as unknown as SDKMessage);
        await tick();
      },
      async notify(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          output_file: '/tmp/out-1554.txt',
          summary: '完了',
          uuid: `uuid-task-notification-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
        } as unknown as SDKMessage);
        await tick();
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
        }
      })();
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed && !holdClose) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => {
        closed = true;
        if (!holdClose) emit?.(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(): { host: RunnerHost; events: RunnerEvent[]; sessions: FakeSession[] } {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  return { host, events, sessions };
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
const notes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  events.filter((event): event is NoteEvent => event.type === 'note');
const wakeNotes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  notes(events).filter((note) => note.text.includes('止まっていたマネージャーを起こした'));

function fire(
  options: Options,
  name: 'PostToolUse' | 'SubagentStop',
  input: Record<string, unknown>,
) {
  const hook = options.hooks?.[name]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const bashByWorker = (taskId: string, agentId: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'pnpm test', run_in_background: true },
  tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
  agent_id: agentId,
  agent_type: 'worker',
});

const managerTool = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/tmp/x' },
  tool_response: { content: 'ok' },
};

/**
 * 作業者が背景処理を残したまま畳もうとし、完了を待つ上限（30分。偽の時計で進める）に達して
 * 打ち切られ、その作業者が背景の Bash を1本残した状態にする（Issue #3008。以前は起こし直しの
 * 回数を使い切らせていた）。
 */
async function cutOffWithBackgroundBash(
  options: Options,
  agentId: string,
  taskId: string,
): Promise<void> {
  await fire(options, 'PostToolUse', {
    ...bashByWorker(`bg-${agentId}`, agentId),
    tool_input: { command: 'sleep 90', run_in_background: true },
  });
  vi.useFakeTimers();
  try {
    const stopped = fire(options, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      agent_type: 'worker',
      session_crons: [],
      agent_id: agentId,
      background_tasks: [
        { id: agentId, type: 'subagent', status: 'running', description: '当人' },
        { id: `bg-${agentId}`, type: 'monitor', status: 'running', command: 'sleep 90' },
      ],
    });
    await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
    // 打ち切り（起こし直さない）なので、追加の文脈は無い。
    expect(await stopped).toEqual({ continue: true });
  } finally {
    vi.useRealTimers();
  }
  await fire(options, 'PostToolUse', bashByWorker(taskId, agentId));
}

/** 委譲を始め、最初の依頼文のターンを畳んで `done`（止まっている）にする。 */
async function startIdle(s: ReturnType<typeof setup>): Promise<FakeSession> {
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
  const session = await vi.waitFor(() => {
    const found = s.sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
  await session.finish('了解した。待つ。');
  return session;
}

const contextOf = (result: HookJSONOutput): string | undefined =>
  (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

describe('打ち切った作業者の背景処理が終わったとき、止まっているマネージャーを起こす（#1554）', () => {
  it('(i) マネージャーが止まっていると、入力が1件積まれ、output_file と再開の案内（agentId）が載る', async () => {
    const s = setup();
    const session = await startIdle(s);
    await vi.waitFor(() => expect(session.inputs).toHaveLength(1));

    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-test-1');
    await session.notify('bg-test-1');

    await vi.waitFor(() => expect(session.inputs).toHaveLength(2));
    const pushed = session.inputs[1] ?? '';
    expect(pushed).toContain('alteroid が自動で送った知らせである（#1554）');
    expect(pushed).toContain('agent_id=agent-1');
    expect(pushed).toContain('command=pnpm test');
    expect(pushed).toContain('/tmp/out-1554.txt');
    expect(pushed).toContain('select:SendMessage');
    expect(pushed).toContain('agentId=agent-1');
    expect(wakeNotes(s.events)).toHaveLength(1);
    expect(
      notes(s.events).some((n) => n.text.includes('打ち切った作業者の背景処理が終わった（#1554）')),
    ).toBe(true);
  });

  it('(ii) その後にマネージャーが道具を呼んでも、同じ知らせは PostToolUse で二重に届かない', async () => {
    const s = setup();
    const session = await startIdle(s);
    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-test-1');
    await session.notify('bg-test-1');
    await vi.waitFor(() => expect(session.inputs).toHaveLength(2));

    expect(await fire(session.options, 'PostToolUse', managerTool)).toEqual({ continue: true });
  });

  it('(iii) 走っている最中に来たら push せず、PostToolUse が配達する', async () => {
    const s = setup();
    // 最初のターンは閉じない（`running` のまま）。
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });
    await vi.waitFor(() => expect(session.inputs).toHaveLength(1));

    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-test-1');
    await session.notify('bg-test-1');
    expect(session.inputs).toHaveLength(1);
    expect(wakeNotes(s.events)).toHaveLength(0);

    // 道具を呼べば、既存の経路で配達される（push は増えない）。
    const delivered = await fire(session.options, 'PostToolUse', managerTool);
    expect(contextOf(delivered)).toContain('id=bg-test-1');
    await session.finish('道具を呼んだ後に畳む');
    expect(session.inputs).toHaveLength(1);
    expect(wakeNotes(s.events)).toHaveLength(0);

    // 別の1本は、道具呼び出しが無いまま result で畳まれたときに push される。
    await fire(session.options, 'PostToolUse', bashByWorker('bg-test-2', 'agent-1'));
    await session.notify('bg-test-2');
    await session.finish('道具を呼ばずに畳む');
    // 上の finish は notify より前に来た result ではないので、ここでは既に done
    // ＝ notify の時点で push されている。走っている間の分は下の別セッションで見る。
    await vi.waitFor(() => expect(session.inputs).toHaveLength(2));
  });

  it('(iii-b) 走っている最中に積まれ、道具呼び出しが無いまま result で畳まれたら、その result で push する', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });
    await vi.waitFor(() => expect(session.inputs).toHaveLength(1));

    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-test-1');
    await session.notify('bg-test-1');
    expect(session.inputs).toHaveLength(1);

    await session.finish('道具を呼ばずに畳む');
    await vi.waitFor(() => expect(session.inputs).toHaveLength(2));
    expect(session.inputs[1]).toContain('id=bg-test-1');
    expect(wakeNotes(s.events)).toHaveLength(1);
    // 配達済みなので、後の道具呼び出しには載らない。
    expect(await fire(session.options, 'PostToolUse', managerTool)).toEqual({ continue: true });
  });

  it('(iv) 打ち切られていない作業者・所有者不明・マネージャー自身・作業者そのものの通知では push しない', async () => {
    const s = setup();
    const session = await startIdle(s);
    await vi.waitFor(() => expect(session.inputs).toHaveLength(1));
    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-cut-1');

    // 打ち切られていない作業者（agent-2）の背景処理。
    await fire(session.options, 'PostToolUse', bashByWorker('bg-live', 'agent-2'));
    await session.notify('bg-live');
    // 所有者不明（PostToolUse を見ていない id）。
    await session.notify('bg-unknown');
    // マネージャー自身の背景処理（agent_id 無し）。
    await fire(session.options, 'PostToolUse', {
      ...bashByWorker('bg-mine', 'x'),
      agent_id: undefined,
      agent_type: undefined,
    });
    await session.notify('bg-mine');
    // 作業者そのもの（local_agent。task_id === agentId）の完了。
    await session.notify('agent-1');

    expect(session.inputs).toHaveLength(1);
    expect(wakeNotes(s.events)).toHaveLength(0);
  });

  it('(v) 畳み中（stopped）なら push しない', async () => {
    const s = setup();
    const session = await startIdle(s);
    await vi.waitFor(() => expect(session.inputs).toHaveLength(1));
    await cutOffWithBackgroundBash(session.options, 'agent-1', 'bg-test-1');

    // 畳みが始まった（stopped が立つ）後、ストリームが閉じる前に通知が届く窓を作る。
    session.holdClose();
    const stopping = s.host.stop('mgr-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.notify('bg-test-1');
    session.releaseClose();
    await stopping;

    expect(session.inputs).toHaveLength(1);
    expect(wakeNotes(s.events)).toHaveLength(0);
  });
});
