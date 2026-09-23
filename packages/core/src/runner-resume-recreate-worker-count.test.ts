import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * **#1373 の残り1点。** `runner.ts` の `#recoverFromFailedResume` は、resume が
 * 効かずに新しいセッションを作り直す経路（戻り値 `'recovered'`）でも、
 * 「このターンで開いた作業者の数」（`#openedWorkersThisTurn`）を捨てる
 * （`grep -Fn -- 'このターンで開いた作業者の数（#1373）も、同じ理由で持ち越さない' packages/core/src/runner.ts`）。
 * ここにはこれまで歯が無かった —— Issue #1373 の最新コメントが指す1行である。
 *
 * `runner-failure.test.ts` の #1373 ブロックが固定する4本は、すべて `turn_ended`
 * が正常に通る経路（`pool.start()` → 成否どちらのターンも同じセッションのまま
 * 終わる）だけを通す。**resume に失敗して作り直す経路は `turn_ended` を経由
 * しない**（`#read()` がストリームの終わりを検知して直接
 * `#recoverFromFailedResume` を呼ぶ）ので、あちらの歯は1本もここを通らない。
 *
 * ## 足場
 *
 * `runner-wakeup.test.ts` の偽 SDK（`taskStarted` / `endStream` を持つ）と
 * `runner-failure.test.ts` の偽 SDK（`finish` が `isError` を取れる）を
 * 合わせた形にしてある。`createRunnerHost` を直接使う（`createManagerPool`
 * を経由しない）のは `runner-wakeup.test.ts` / `runner-closed-system-error.test.ts`
 * と同じ理由——resume を起こすには `host.resume()` を直接呼ぶのがいちばん
 * 素直で、`createManagerPool` 経由だと daemon 再起動相当の `#restoreJobs()` を
 * 組み立てる必要が出て遠回りになる。
 */

interface FakeSession {
  finish(text: string, options?: { isError?: boolean }): Promise<void>;
  taskStarted(taskId: string): Promise<void>;
  /** ストリームを畳む（SDK 側が結果を1つも返さずに黙って落ちた形を模す）。 */
  endStream(): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      async finish(text, options = {}) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskStarted(taskId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}-${String(Math.random())}`,
          session_id: 'sess-mgr',
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

      // 入力を読み続ける裏方（読まないと送り手が詰まる）。中身は使わない。
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

async function nthSession(sessions: readonly FakeSession[], index: number): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) throw new Error(`${String(index)} 本目のセッションがまだ開いていない`);
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

async function nthReport(events: readonly RunnerEvent[], index: number): Promise<ReportEvent> {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ReportEvent => event.type === 'report');
    const report = found[index];
    if (!report) throw new Error(`${String(index)} 本目の報告がまだ届いていない`);
    return report;
  });
}

/** 作業者を1体も開いていない・失敗したターンの本文（変更されない側の基準値）。 */
const BASELINE_FAILURE_TEXT =
  '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

describe('#1373: resume に失敗して作り直す経路でも、そのターンで開いた作業者の数を持ち越さない', () => {
  it('前のセッションで開いた作業者は、作り直した後の最初の失敗の本文には出ない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: '/work/project',
      request: '最初の依頼',
      // renderSessionLog が null を返さないよう、素材を1件渡す
      // （`renderSessionLog` は空配列/undefined だけ null を返す）。
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    // 前のセッションで作業者を2体開いたまま、結果を1つも返さずに閉じる。
    // 実機では「resume したが、いちど手が動く前に SDK 側が黙って落ちた」形。
    await first.taskStarted('task-1');
    await first.taskStarted('task-2');
    first.endStream();

    // `#recoverFromFailedResume` が 'recovered' を返し、作り直した2本目の
    // セッションが立ち上がる（`renderSessionLog` が null を返さないので
    // `renderSessionLog` を返す枝、`this.#progressed` は false のまま）。
    const second = await nthSession(sessions, 1);
    // 作り直した後の最初のターンは、作業者を1体も開かずに失敗する。
    await second.finish('', { isError: true });

    const report = await nthReport(events, 0);
    expect(report.managerId).toBe('mgr-1');
    expect(report.text).not.toContain('体開いていた');
    expect(report.text).toBe(BASELINE_FAILURE_TEXT);
  });

  it('陽性対照: 前のセッションで作業者を開いていなければ、作り直した後の失敗の本文はもとから変わらない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-dead-2',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    // `taskStarted` を1度も呼ばない。
    first.endStream();

    const second = await nthSession(sessions, 1);
    await second.finish('', { isError: true });

    const report = await nthReport(events, 0);
    expect(report.text).toBe(BASELINE_FAILURE_TEXT);
  });

  it('過剰な握り潰しの回帰防止: resume で開いたセッションが一度進行した後の、無関係な通常の失敗では数を消さない', async () => {
    // **これは「やりすぎた直し方」を捕まえるための歯である。** `#resumeAttempt` は
    // `#recoverFromFailedResume` が呼ばれるまで立ったままなので、もし直し方を
    // 「`#resumeAttempt` が立っていたら（成否を問わず）`#openedWorkersThisTurn` を
    // 捨てる」という形にすると、resume が実際には効いていて（`#progressed` が
    // 立っていて）ただの通常の失敗が後から来ただけの回まで、数を握り潰して
    // しまう。正しい直し方（`#recoverFromFailedResume` の中でだけ捨てる）は
    // この回を通らない——1ターン目が成功した時点で `#resumeAttempt` を読む
    // 呼び出し自体が一度も起きないからである。
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-3',
      sessionId: 'sess-dead-3',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const session = await nthSession(sessions, 0);
    // 1ターン目は成功させる（resume は実際に効いた ＝ progressed）。
    await session.finish('続きを再開した');

    // 2ターン目: 作業者を2体開いてから失敗する。これは resume の失敗ではない、
    // ただの通常の失敗である。
    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.finish('', { isError: true });

    // 2本目の報告（1本目は1ターン目の成功）。作り直しは起きていないので、
    // 2本目のセッションは立たない。
    const secondReport = await nthReport(events, 1);
    expect(secondReport.text).toContain(
      'このターンでは作業者が 2 体開いていた。どちらが当たったかは SDK からは分からない',
    );
    expect(sessions).toHaveLength(1);
  });
});
