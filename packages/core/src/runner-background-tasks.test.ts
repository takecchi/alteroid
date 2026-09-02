import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * **`awaitingBackground` —— 背景処理の完了待ちで畳んだターンの報告に印を付ける。**
 *
 * 実測の経緯（依頼者が生ログで実測）: マネージャーが `Bash` を
 * `run_in_background: true` で起こした直後、「完了を待つ」とだけ言って
 * `end_turn` で畳むと、その最後の発話がそのまま「報告」としてクローンへ
 * 配られ、クローンのターンを1本無駄に起こしていた。`contentless`
 * （`runner-contentless.test.ts`）と同型の直しなので、ここも同じ足場
 * （`createRunnerHost` の生の `RunnerEvent` を直接見る）を使う。
 */

interface FakeSession {
  /** マネージャーが本文を1つ喋る。 */
  say(text: string, options?: { error?: string }): Promise<void>;
  /** SDK が背景タスクの在り高を通知する（REPLACE 意味論）。 */
  backgroundTasksChanged(
    tasks: readonly { id: string; taskType: string; ambient?: boolean }[],
  ): Promise<void>;
  /** 1ターンを畳む。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
  /** 器（CLI プロセス）が入れ替わったことにする — 新しい `init` を流す。 */
  restart(): Promise<void>;
  /**
   * マネージャーが確認を上げる（`waiting_human` を作る）。**わざと待たない**
   * ——`#onPermission` は最初の `await` の手前で `#pending` へ同期的に積むので
   * （`runner.ts` の `#onPermission`）、この呼び出しが返るのを待つ必要が無い。
   * 返す `Promise` は誰も解決しないまま残る（このテストでは答えないため）。
   */
  ask(toolName: string, input: Record<string, unknown>): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}-${String(Math.random())}`,
          ...(sayOptions.error === undefined ? {} : { error: sayOptions.error }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
            ...(task.ambient === undefined ? {} : { ambient: task.ambient }),
          })),
          session_id: 'sess-mgr',
          uuid: `uuid-bg-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${String(Math.random())}`,
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async restart() {
        push({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-mgr',
          uuid: `uuid-init-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      ask(toolName, input) {
        const canUseTool = (params.options ?? {}).canUseTool;
        if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
        // **わざと await しない。** `#onPermission` は最初の await の手前で
        // `#pending` へ同期的に積む（`runner.ts` の `#onPermission`）ので、
        // ここで返る Promise を待つ必要が無い——待つと `waiting_human` の
        // まま `finish()` を呼ぶテストが書けなくなる（誰も答えないため）。
        void canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${String(Math.random())}`,
          requestId: `req-${String(Math.random())}`,
        } as never);
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
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
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

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

async function reportEvents(events: readonly RunnerEvent[], expected: number) {
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

describe('report イベントの awaitingBackground（3条件すべてを満たすときだけ載る）', () => {
  it('背景タスクが在り、成功して done で終わった回に載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.status).toBe('done');
    expect(report?.awaitingBackground).toEqual({ count: 1, breakdown: 'shell×1' });
  });

  it('背景タスクが無ければ載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('中身のある報告');
    await session.finish('中身のある報告');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });

  it('失敗（assistant.error）で終わった回は、背景タスクが在っても載らない（必ず配る）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('', { error: 'billing_error' });
    await session.finish('', { isError: true });

    const [report] = await reportEvents(s.events, 1);
    expect(report?.failure).toBeDefined();
    expect(report?.awaitingBackground).toBeUndefined();
  });

  it('待ちが在って waiting_human になった回は、背景タスクが在っても載らない（必ず配る）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    // 答えないまま確認を1件開く（`ask()` の doc）——`#pending` が非空のまま
    // `result` が来るので、`this.#status` は `done` ではなく `waiting_human`
    // になる（`runner.ts` の `#apply` の `case 'turn_ended'`）。
    session.ask('Bash', { command: 'echo hi' });
    await session.finish('確認をお願いします');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.status).toBe('waiting_human');
    expect(report?.awaitingBackground).toBeUndefined();
  });
});

describe('session_started で背景タスクの在り高が空に戻る', () => {
  it('resume（器の入れ替え）を挟むと、古い在り高は次の報告に引き継がれない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    // **`init` をもう一度流す**（新しいプロセスが立ったのと同じ形）——
    // `#liveBackgroundTasks` が空へ戻るはずである。
    await session.restart();
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });
});

describe('REPLACE 意味論（差分ではなく、2回目のペイロードが1回目を置き換える）', () => {
  it('2回目のペイロードで件数が変わる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([
      { id: 'bg-1', taskType: 'shell' },
      { id: 'bg-2', taskType: 'shell' },
    ]);
    // **加算ではなく置き換え。** 2回目は1件だけ——1回目の2件と合算されて
    // 3件になってはいけない。
    await session.backgroundTasksChanged([{ id: 'bg-3', taskType: 'shell' }]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toEqual({ count: 1, breakdown: 'shell×1' });
  });

  it('ambient なタスクは在り高に数えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([
      { id: 'bg-1', taskType: 'skip_transcript', ambient: true },
    ]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });
});
