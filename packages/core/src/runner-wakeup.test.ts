import type {
  HookCallbackMatcher,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `worker_wait` — マネージャーが作業者へ委譲したあと、何を契機にターンが
 * 回ったかを1区間1行で数える（runner.ts の doc に経緯がある。「残り5体を
 * 待ちます」だけのターンを40回以上回した事故が発端）。
 *
 * ここで固定するのは `RunnerSession` の `#dispatch` が実際に読んでいることと、
 * 契機（`byCause`）が排他で `turns` と一致すること、道具を1つも動かさなかった
 * ターン（`toolless`）の判定がマネージャー自身の道具だけを見ること、区間が
 * 閉じずにセッションが畳まれたら `settled: false` が上がることの4つである。
 *
 * **`runner-failure.test.ts` / `manager.test.ts` の偽 SDK の足場を真似ている。**
 * 待ち方（`emit`/`buffered` の形）は実績のある形をそのまま踏襲した — 自前の
 * ポーリングにすると `close()` で畳めずテストが終わらない。
 */

interface FakeSession {
  options: Options;
  /** 背景の読み手が実際に消費した入力（`#inputStream` が `yield` したもの）。 */
  inputs: string[];
  say(text: string): Promise<void>;
  /** 1ターンを畳む（`result`）。 */
  finish(text: string): Promise<void>;
  /** PostToolUse フックを鳴らす（既定はマネージャー自身の道具）。 */
  usedTool(tool: string, extra?: Record<string, unknown>): Promise<void>;
  /** UserPromptSubmit フックを鳴らす（既定はマネージャー自身への発火）。 */
  submitPrompt(extra?: Record<string, unknown>): Promise<void>;
  /** `system/task_started` を流す。 */
  taskStarted(taskId: string, extra?: Record<string, unknown>): Promise<void>;
  /** `system/task_notification` を流す。 */
  taskNotification(taskId: string, extra?: Record<string, unknown>): Promise<void>;
  /** ストリームを畳む（SDK 側が黙って落ちた形を模す）。 */
  endStream(): void;
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

    async function fireHook(
      name: 'PostToolUse' | 'UserPromptSubmit',
      input: Record<string, unknown>,
    ): Promise<void> {
      const matchers = options.hooks?.[name] as HookCallbackMatcher[] | undefined;
      if (matchers === undefined) return;
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          await hook(input as never, undefined, { signal: new AbortController().signal });
        }
      }
    }

    const session: FakeSession = {
      options,
      inputs,
      async say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text}-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${text}-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedTool(tool, extra = {}) {
        await fireHook('PostToolUse', {
          hook_event_name: 'PostToolUse',
          tool_name: tool,
          tool_input: { a: 1 },
          transcript_path: '/tmp/does-not-exist.jsonl',
          ...extra,
        });
      },
      async submitPrompt(extra = {}) {
        await fireHook('UserPromptSubmit', {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'なにかの一言',
          ...extra,
        });
      },
      async taskStarted(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskNotification(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          output_file: '/tmp/out.txt',
          summary: '完了',
          uuid: `uuid-task-notification-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      endStream() {
        if (emit) emit(null);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // 背景の読み手。**`#inputStream` が実際に `yield` したものだけを記録する**
      // — 積んだ時点ではなく消費された時点を見るための材料（`inputs`）。
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

type WorkerWaitEvent = Extract<RunnerEvent, { type: 'worker_wait' }>;

function workerWaitEvents(events: readonly RunnerEvent[]): WorkerWaitEvent[] {
  return events.filter((event): event is WorkerWaitEvent => event.type === 'worker_wait');
}

/** `byCause` の3つは排他で数える約束。合計が `turns` と一致することを毎回検算する。 */
function expectExclusiveCauses(event: WorkerWaitEvent): void {
  const { input, notification, continuation } = event.byCause;
  expect(input + notification + continuation).toBe(event.turns);
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

/**
 * 委譲を開始し、`begin()` が押し込んだ最初の依頼文をここで消費させておく。
 *
 * **ここが無いと、テストの意図がずれる。** `host.start` は内部で `push(request)`
 * を呼ぶので、window を開く前にこの入力を1ターンぶん畳んでおかないと、
 * `taskStarted` の直後に来る最初の `result` がこの入力を拾って
 * `byCause.input` に数えられてしまう（window が無い間に畳まれた分はどのみち
 * 捨てられるので、ここで先に消費してしまうのが素直である）。
 */
async function startPrimed(host: RunnerHost, sessions: FakeSession[]): Promise<FakeSession> {
  await host.start({ managerId: 'mgr-1', request: '委譲して進めて', cwd: '/work/project' });
  const session = await firstSession(sessions);
  await session.finish('了解した。進める。');
  return session;
}

describe('worker_wait — 委譲1区間ぶんの契機の集計', () => {
  it('task_started → 入力なしで result×3 → task_notification → result で turns=4、契機は notification 1 / continuation 3 / input 0', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);
    expect(workerWaitEvents(s.events)).toHaveLength(0);

    await session.taskStarted('task-1');
    await session.finish('turn1');
    await session.finish('turn2');
    await session.finish('turn3');
    await session.taskNotification('task-1');
    await session.finish('turn4（完了通知を契機に回った回）');

    const events = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.tasks).toBe(1);
    expect(event.turns).toBe(4);
    expect(event.byCause).toEqual({ input: 0, notification: 1, continuation: 3 });
    expect(event.settled).toBe(true);
    expectExclusiveCauses(event);
  });

  it('入力を渡してから result が来た回は byCause.input に入る（契機は排他で turns と一致する）', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await s.host.send('mgr-1', '状況はどう？');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.finish('進捗を答えた'); // 入力を消費した回 → input
    await session.taskNotification('task-1');
    await session.finish('完了通知を契機に回った回'); // → notification

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.turns).toBe(2);
    expect(event.byCause).toEqual({ input: 1, notification: 1, continuation: 0 });
    expectExclusiveCauses(event);
  });

  it('マネージャー自身の道具が1回でも動いたターンは toolless に数えない。動かなかったターンは数える', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await session.usedTool('Bash'); // マネージャー自身の道具（agent_id 無し）
    await session.finish('道具を使った回');
    await session.finish('何もしなかった回');
    await session.taskNotification('task-1');
    await session.finish('完了通知の回（道具は動かしていない）');

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.turns).toBe(3);
    // 道具を使った1ターン目だけ数えない → toolless は残り2ターン分。
    expect(event.toolless).toBe(2);
  });

  it('作業者の道具（agent_id 付き）は toolless の判定に影響しない（マネージャー自身は何もしていない）', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    // 作業者（Task の中）の道具実行。`agent_id` が付く。
    await session.usedTool('Read', { agent_id: 'sub-1', agent_type: 'worker' });
    await session.finish('作業者だけが動いた回');
    await session.taskNotification('task-1');
    await session.finish('完了通知の回');

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.turns).toBe(2);
    // マネージャー自身は2ターンとも何も動かしていない＝両方 toolless。
    expect(event.toolless).toBe(2);
  });

  it('task_started が2件で task_notification が1件だけの状態でセッションが畳まれたら settled: false が上がる（区間が開いたまま消えない）', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.finish('作業中');
    await session.taskNotification('task-1'); // task-2 はまだ開いたまま

    // セッションが黙って畳まれる（SDK 側が落ちた形を模す）。
    session.endStream();

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.tasks).toBe(2);
    expect(event.settled).toBe(false);
  });

  it('window が開いていないあいだの result は worker_wait を1件も生まない', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.finish('委譲なしで進んだ回1');
    await session.finish('委譲なしで進んだ回2');
    await s.host.send('mgr-1', 'まだ委譲していない');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.finish('委譲なしで進んだ回3');

    expect(workerWaitEvents(s.events)).toHaveLength(0);
  });

  it('task_notification を受けても #input へは1件も積まれない（守られていない前提: 作業者の完了を契機に push を呼ばない）', async () => {
    // **これは「たまたま」ではなく確かめられる前提である。** `push()`
    // （マネージャーのセッションへ入力を押し込む唯一の経路）は作業者の完了を
    // 契機に呼ばれる箇所が実装のどこにも無い — 呼んでいれば SDK 側の
    // 自己継続と二重にターンが回り、この区間の `byCause.input` が動いて
    // しまうはずである。ここでは `task_notification` の前後で `session.inputs`
    // （`#inputStream` が実際に `yield` した入力）が増えないことと、閉じる
    // ターンの契機が `input` ではなく `notification` になることの両方を見る。
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);
    const inputsBefore = session.inputs.length;

    await session.taskStarted('task-1');
    await session.taskNotification('task-1');
    expect(session.inputs.length).toBe(inputsBefore);

    await session.finish('完了通知を契機に回った回');
    expect(session.inputs.length).toBe(inputsBefore);

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.byCause).toEqual({ input: 0, notification: 1, continuation: 0 });
  });

  it('UserPromptSubmit の発火回数（submits）は result（turns）と別に数える', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await session.submitPrompt({ source: 'system' });
    await session.finish('自己継続かもしれない回');
    await session.taskNotification('task-1');
    await session.finish('完了通知の回');

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.submits).toBe(1);
    expect(event.sources).toEqual({ system: 1 });
  });

  it('UserPromptSubmit に source が付かなければ sources へ0件の行を作らない', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await session.submitPrompt(); // source を付けない
    await session.finish('回1');
    await session.taskNotification('task-1');
    await session.finish('回2');

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.submits).toBe(1);
    expect(event.sources).toBeUndefined();
  });

  it('作業者側の UserPromptSubmit（agent_id 付き）は submits に数えない', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1');
    await session.submitPrompt({ agent_id: 'sub-1', source: 'sdk' });
    await session.finish('回1');
    await session.taskNotification('task-1');
    await session.finish('回2');

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(s.events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.submits).toBe(0);
    expect(event.sources).toBeUndefined();
  });
});
