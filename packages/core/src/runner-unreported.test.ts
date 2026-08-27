import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * **`result` を受け取らないまま畳んだ回の本文を報告として出す（#323）— `#flushUnreported` の歯。**
 *
 * `runner.ts` の `#flushUnreported()` を直接呼ぶテストは無い（private メソッド）。
 * ここは `runner-contentless.test.ts` と同じ足場（`createRunnerHost` の生の
 * `RunnerEvent` を直接見る）で、`#flushUnreported` が呼ばれる2つの経路
 * （`stop()` と `#finish()`）を外から踏む。
 */

interface FakeSession {
  /**
   * マネージャーが本文を1つ喋る。積んだ本文を運ぶ assistant メッセージの
   * `uuid` を返す — `#saidUuid` 経由で `reportId` に化けるはずの値を、
   * テスト側でも掴めるようにする。
   */
  say(text: string): Promise<string>;
  /** 通常経路: `result` を伴って1ターンを畳む（`#dispatch` の `result` の枝）。 */
  finish(text: string): Promise<void>;
  /**
   * ストリームが `result` を伴わずに自然終了する（SDK 側が黙って閉じる）。
   * `#read` の `for await` がそのまま抜け、`#finish('done', …)` へ落ちる。
   */
  end(): void;
  /**
   * ストリームが `result` を伴わずに例外を投げて落ちる（SDK 側のクラッシュ）。
   * `#read` の catch 節から `#finish('failed', …)` へ落ちる。
   */
  crash(reason: string): void;
}

/**
 * @param closeThrows `Query#close()` を呼んだときに、待っている読み手を
 *   `null`（正常終了）ではなく例外で落とす。**`stop()` が `this.#query?.close()`
 *   を呼んだ後、`#read` の catch 節から `#finish` がもう一度呼ばれる経路**
 *   （`#flushUnreported` の doc が名指ししている「`stop()` の後に `#read` の
 *   catch から `#finish` が来る経路」）を実際に踏むためだけに立てる。既定
 *   （false）は他のテストと同じ「素直に閉じる」動き。
 */
function fakeSdk(options: { closeThrows?: boolean } = {}): {
  fn: typeof sdkQuery;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];
  let sayCounter = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    let fail: ((error: unknown) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        fail = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    };

    const session: FakeSession = {
      async say(text) {
        sayCounter += 1;
        const uuid = `uuid-say-${String(sayCounter)}`;
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return uuid;
      },
      async finish(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      end() {
        if (emit) {
          const resolve = emit;
          emit = null;
          fail = null;
          resolve(null);
        }
      },
      crash(reason) {
        if (fail) {
          const reject = fail;
          emit = null;
          fail = null;
          reject(new Error(reason));
        }
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

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve, reject) => {
          emit = resolve;
          fail = reject;
        });
        emit = null;
        fail = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (options.closeThrows) {
          if (fail) {
            const reject = fail;
            emit = null;
            fail = null;
            reject(new Error('SDK が close 時に例外を投げた'));
          }
          return;
        }
        if (emit) {
          const resolve = emit;
          emit = null;
          fail = null;
          resolve(null);
        }
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

function setup(sdkOptions: { closeThrows?: boolean } = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
  sessions: FakeSession[];
} {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk(sdkOptions);
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
type ClosedEvent = Extract<RunnerEvent, { type: 'closed' }>;

function reportEventsSync(events: readonly RunnerEvent[]): ReportEvent[] {
  return events.filter((event): event is ReportEvent => event.type === 'report');
}

async function reportEvents(events: readonly RunnerEvent[], expected: number) {
  return vi.waitFor(() => {
    const found = reportEventsSync(events);
    if (found.length < expected) {
      throw new Error(
        `report が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found;
  });
}

async function closedEvents(events: readonly RunnerEvent[], expected: number) {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ClosedEvent => event.type === 'closed');
    if (found.length < expected) {
      throw new Error(
        `closed が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found;
  });
}

describe('#flushUnreported — result を受け取らないまま畳んだ回の本文を報告として出す', () => {
  it('say() で積んだ本文は、finish() を呼ばず stop() で畳んでも report として1本出る（全文を運ぶ）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('途中まで調べた内容その1');
    await session.say('途中まで調べた内容その2');

    // `finish()` は1度も呼ばない — `result` が来ないまま畳む。
    await s.host.stop('mgr-1');

    const reports = await reportEvents(s.events, 1);
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report?.managerId).toBe('mgr-1');
    // **積んだ本文が全部入っている。** どちらの `say()` の中身も欠けない。
    expect(report?.text).toContain('途中まで調べた内容その1');
    expect(report?.text).toContain('途中まで調べた内容その2');
    // 畳まれたことが分かる印が先頭に付く（`unreportedText` の doc）。
    expect(report?.text).toContain('結果を受け取らないまま畳まれた');
    // `stop()` の時点では `result` を受け取っていないので `#status` は
    // 初期値の `running` のまま渡る。
    expect(report?.status).toBe('running');
  });

  it('#finish 経路（ストリームが自然終了する）でも、report が closed より前に1本出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('自然終了する前に喋った本文');
    // `host.stop()` を経由せず、SDK 側のストリームが自分で終わる。
    session.end();

    const closed = await closedEvents(s.events, 1);
    const reports = reportEventsSync(s.events);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('自然終了する前に喋った本文');
    expect(closed[0]?.status).toBe('done');
    expect(reports[0]?.status).toBe('done');
    // **report が closed より前に出る**（`#finish` の doc — `#shipArchive` の
    // 後、`closed` を emit する直前に置いた、の裏取り）。
    const reportIndex = s.events.indexOf(reports[0] as RunnerEvent);
    const closedIndex = s.events.indexOf(closed[0] as RunnerEvent);
    expect(reportIndex).toBeGreaterThanOrEqual(0);
    expect(reportIndex).toBeLessThan(closedIndex);
  });

  it('#finish 経路（ストリームが例外を投げる）でも、report が closed より前に1本出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('落ちる前に喋った本文');
    session.crash('SDK がクラッシュした');

    const closed = await closedEvents(s.events, 1);
    const reports = reportEventsSync(s.events);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('落ちる前に喋った本文');
    expect(closed[0]?.status).toBe('failed');
    expect(reports[0]?.status).toBe('failed');
    const reportIndex = s.events.indexOf(reports[0] as RunnerEvent);
    const closedIndex = s.events.indexOf(closed[0] as RunnerEvent);
    expect(reportIndex).toBeGreaterThanOrEqual(0);
    expect(reportIndex).toBeLessThan(closedIndex);
  });

  it('say() を1度も呼ばずに畳んだら、report は1本も出ない（中身の無い報告でクローンのターンを焼かない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    await firstSession(s.sessions);

    // `say()` を1度も呼ばずに、`stop()` で畳む — `#said` は空のまま。
    await s.host.stop('mgr-1');

    expect(reportEventsSync(s.events)).toHaveLength(0);
  });

  it('二度畳んでも report は1本しか出ない（stop() の後に #read の catch から #finish が来る経路）', async () => {
    // `close()` が例外を投げる偽 SDK — `stop()` が `this.#query?.close()` を
    // 呼んだ後、`#read` の catch 節から `#finish` がもう一度呼ばれる（`#flushUnreported`
    // の doc が名指ししている経路）。`#said` は最初の `stop()` の中で既に畳んで
    // あるので、2度目は空振りするはず。
    const s = setup({ closeThrows: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('二度畳まれる前の本文');
    // `host.stop()` は `#read` の catch 節から呼ばれる `#finish` の完了まで
    // 待ってから戻る（`stop()` 内の `await this.#reader?.catch(...)`）。
    await s.host.stop('mgr-1');

    // 念のため、非同期の取りこぼしが無いか一呼吸置いてからも数える。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reportEventsSync(s.events)).toHaveLength(1);
    expect(reportEventsSync(s.events)[0]?.text).toContain('二度畳まれる前の本文');
  });

  it('通常の経路（say → finish）では #flushUnreported の本文が混ざらず、その後さらに畳んでも余分な report は出ない', async () => {
    const s = setup({ closeThrows: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('通常に終わる回の本文');
    // `result` を伴って畳む — `#said` はここで通常どおり畳まれ、報告が1本出る。
    await session.finish('通常の結果');

    const firstReports = await reportEvents(s.events, 1);
    expect(firstReports).toHaveLength(1);
    // **`#flushUnreported` の文言（「結果を受け取らないまま畳まれた」）が
    // 混ざらない。** 通常経路の報告本文はそれとは別の組み立て
    // （`reportText()`）である。
    expect(firstReports[0]?.text).not.toContain('結果を受け取らないまま畳まれた');
    expect(firstReports[0]?.text).toContain('通常に終わる回の本文');

    // ここから先の `#said` は空のはず。さらに畳んでも report は増えない
    // （`stop()` → `#flushUnreported` は空振り。`closeThrows: true` により
    // その後 `#read` の catch から `#finish` も来るが、そちらも空振りする）。
    await s.host.stop('mgr-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reportEventsSync(s.events)).toHaveLength(1);
  });

  it('reportId は、本文を運んだ assistant メッセージの uuid と一致する', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    const uuid = await session.say('id を確かめたい本文');
    await s.host.stop('mgr-1');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.reportId).toBe(uuid);
  });
});
