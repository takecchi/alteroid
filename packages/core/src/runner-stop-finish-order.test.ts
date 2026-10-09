import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import * as droppedRecord from './dropped-record.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `stop()` と `#finish()` の畳みの並びを、いまの実際のまま固定する測定（characterization）。
 * どちらの並びが正しいかは主張しない。赤くなったら「順序が変わった」事実だけを報告し、
 * 直す・戻すの判断はオーナーに委ねる。
 *
 * `emit` と偽 SDK の `Query#close()` は同期関数なので、1本の `timeline` に積んだ順が実際に呼ばれた順になる。
 * `onClosed` は `emit` を経由せず timeline に現れない。最後の `emit` の中ではまだ `host.list()` に載っていて、
 * 待ち終えた後には消えていることで位置を間接的に確かめる（1呼びの中の先後までは測れない）。
 */

interface FakeSession {
  options: Options;
  say(text: string): Promise<string>;
  postToolUse(input: Record<string, unknown>): Promise<unknown>;
  /** settle するまで解決しない。 */
  askPermission(toolName: string, requestId: string): Promise<PermissionResult>;
  taskStarted(taskId: string): Promise<void>;
  /** `result` を伴わずにストリームが自然終了する（経路Bの代表）。 */
  end(): void;
  /** `deferCloseEnd: true` のとき、`close()` で止めずに残したストリームをここで終える。 */
  endAfterClose(): void;
  /**
   * `deferCloseEnd: true` のとき、ストリームを例外で終える。`close()` 自体とは独立の
   * transport 故障を模す。
   */
  crashAfterClose(reason: string): void;
  /** 同期関数。呼んだ直後に `host.stop()` を重ねて、`#finish('lost', …)` が終わる前に `stop()` が割り込む窓を作る。 */
  resultFailed(text: string, subtype?: string): void;
  /** `deferUsage` で止めた usage 応答を解く。 */
  releaseUsage(): void;
}

/**
 * @param testOptions 名前を `options` にしない: 下の `params.options`（SDK の `Options`）にシャドウされて無効になる。
 */
function fakeSdk(
  onClose: () => void,
  testOptions: { deferCloseEnd?: boolean; deferUsage?: boolean } = {},
): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  let sayCounter = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    let fail: ((error: unknown) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const usageResolvers: Array<() => void> = [];

    const push = (message: SDKMessage | null) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        fail = null;
        resolve(message);
      } else if (message !== null) {
        buffered.push(message);
      }
    };

    const session: FakeSession = {
      options,
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
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
      async askPermission(toolName, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const result = await canUseTool(toolName, { command: 'rm -rf /' }, {
          signal: new AbortController().signal,
          requestId,
          toolUseID: `tool-${requestId}`,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
      async taskStarted(taskId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      end() {
        push(null);
      },
      endAfterClose() {
        push(null);
      },
      crashAfterClose(reason) {
        if (fail) {
          const reject = fail;
          emit = null;
          fail = null;
          reject(new Error(reason));
        }
      },
      resultFailed(text, subtype = 'error_during_execution') {
        push({
          type: 'result',
          subtype,
          is_error: true,
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result-failed',
        } as unknown as SDKMessage);
      },
      releaseUsage() {
        const resolve = usageResolvers.shift();
        if (resolve) resolve();
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
        onClose();
        if (testOptions.deferCloseEnd) return;
        push(null);
      },
      interrupt: async () => undefined,
      // 常に非ゼロの消費を返す: `readSessionUsage` は全部ゼロなら降ろさないので、
      // 無いと `usage` が timeline に乗らない。
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        if (testOptions.deferUsage) {
          await new Promise<void>((resolve) => {
            usageResolvers.push(resolve);
          });
        }
        return {
          session: {
            total_cost_usd: 0.1,
            total_api_duration_ms: 0,
            total_duration_ms: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            model_usage: {
              'claude-opus-4-8': {
                inputTokens: 10,
                outputTokens: 10,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
                costUSD: 0.1,
                contextWindow: 200_000,
                maxOutputTokens: 64_000,
              },
            },
          },
          subscription_type: 'max',
          rate_limits_available: false,
          rate_limits: null,
        };
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-stop-finish-order-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function labelOf(event: RunnerEvent): string {
  switch (event.type) {
    case 'closed':
      return `emit:closed(status=${event.status})`;
    case 'report':
      return `emit:report(status=${event.status},unreported=${String(event.unreported !== undefined)})`;
    case 'settled':
      return `emit:settled(requestId=${event.requestId})`;
    case 'worker_wait':
      return `emit:worker_wait(settled=${String(event.settled)})`;
    case 'archive':
      return `emit:archive(len=${String(event.body.length)})`;
    case 'usage':
      return 'emit:usage';
    case 'ask':
      return `emit:ask(requestId=${event.requestId})`;
    default:
      return `emit:${event.type}`;
  }
}

function setup(sdkOptions: { deferCloseEnd?: boolean; deferUsage?: boolean } = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
  timeline: string[];
  sessions: FakeSession[];
  stillListedAtLastEmit: () => boolean;
  /** 状態づくりが積んだ雑音（session・tool_use・ask）を、畳む手続きを呼ぶ直前に消す。 */
  resetTimeline: () => void;
} {
  const events: RunnerEvent[] = [];
  const timeline: string[] = [];
  const managerId = 'mgr-1';
  const { fn, sessions } = fakeSdk(() => timeline.push('query.close()'), sdkOptions);
  let stillListedAtLastEmit = false;

  const host = createRunnerHost({
    runnerId: 'runner-order-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      timeline.push(labelOf(event));
      // `onClosed()` はこの関数の外（呼び出し元の次の同期文）でしか起こらないので、
      // ここで見えるのは常に「まだ削除されていない」側。
      stillListedAtLastEmit = host.list().some((m) => m.managerId === managerId);
    },
    queryFn: fn,
    env: {},
  });
  hosts.push(host);
  return {
    host,
    events,
    timeline,
    sessions,
    stillListedAtLastEmit: () => stillListedAtLastEmit,
    resetTimeline: () => {
      timeline.length = 0;
    },
  };
}

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

async function primeState(
  session: FakeSession,
  transcriptPath: string,
): Promise<{ askPromise: Promise<PermissionResult>; saidUuid: string }> {
  const saidUuid = await session.say('畳まれる前に喋った本文');
  await session.postToolUse({
    tool_name: 'Bash',
    tool_input: {},
    transcript_path: transcriptPath,
  });
  await session.taskStarted('task-1');
  const askPromise = session.askPermission('Bash', 'req-1');
  // `askPermission` は async なので、呼び出し直後は `#pending` への push が終わっていないことがある。
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { askPromise, saidUuid };
}

describe('#1533: stop() と #finish の畳みの順序を、現状のまま固定する（characterization。正しさは主張しない）', () => {
  it('経路A（stop()）: いまの呼び出し順序', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-a.jsonl');
    const archivedBody = '経路Aの生ログ本文';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    s.resetTimeline();

    await s.host.stop('mgr-1');
    const settledAnswer = await askPromise;

    console.log('経路A timeline:', JSON.stringify(s.timeline));

    // status が `running` でなく `waiting_human` のままなのは、報告が stop を指示された時点の状態を
    // 名乗るため（`stop()` 冒頭で `statusAtStop` を控える）。`settleAll` 後の値に揃えない。
    expect(s.timeline).toEqual([
      'emit:usage',
      'emit:worker_wait(settled=false)',
      'emit:settled(requestId=req-1)',
      'query.close()',
      'emit:archive(len=9)',
      'emit:report(status=waiting_human,unreported=true)',
    ]);

    expect(s.events.some((e) => e.type === 'closed')).toBe(false);

    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'デーモンから停止を指示された。',
    });

    expect(s.stillListedAtLastEmit()).toBe(true);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);
  });

  it('経路B（#finish、ストリームが自然終了する代表経路）: いまの呼び出し順序', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-b.jsonl');
    const archivedBody = '経路Bの生ログ本文';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    s.resetTimeline();

    session.end();
    await vi.waitFor(() => {
      if (!s.events.some((e) => e.type === 'closed')) throw new Error('closed がまだ来ていない');
    });
    const settledAnswer = await askPromise;

    console.log('経路B timeline:', JSON.stringify(s.timeline));

    expect(s.timeline).toEqual([
      'emit:usage',
      'emit:worker_wait(settled=false)',
      'emit:settled(requestId=req-1)',
      'query.close()',
      'emit:archive(len=9)',
      'emit:report(status=done,unreported=true)',
      'emit:closed(status=done)',
    ]);

    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'マネージャーのセッションが閉じた。',
    });

    expect(s.stillListedAtLastEmit()).toBe(true);
    await vi.waitFor(() => {
      if (s.host.list().some((m) => m.managerId === 'mgr-1')) {
        throw new Error('まだ list に残っている');
      }
    });
  });
});

describe('#1533 (a)〜(e): 観測できる差があるかどうか', () => {
  it('(a) report の emit は query.close() の前か後か——#1533 の直しで揃った（以前は経路で違った）', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const reportIdxA = a.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdxA = a.timeline.indexOf('query.close()');
    expect(reportIdxA).toBeGreaterThanOrEqual(0);
    expect(closeIdxA).toBeGreaterThanOrEqual(0);
    expect(reportIdxA).toBeGreaterThan(closeIdxA);

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const reportIdxB = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdxB = b.timeline.indexOf('query.close()');
    expect(reportIdxB).toBeGreaterThanOrEqual(0);
    expect(closeIdxB).toBeGreaterThanOrEqual(0);
    expect(reportIdxB).toBeGreaterThan(closeIdxB);
  });

  it('(b) 未決の確認の解決（settled）は report の emit の前か後か——#1533 の直しで揃った（以前は経路で違った）', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    const { askPromise: askA } = await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');
    const answerA = await askA;

    const settledIdxA = a.timeline.findIndex((l) => l.startsWith('emit:settled'));
    const reportIdxA = a.timeline.findIndex((l) => l.startsWith('emit:report'));
    expect(settledIdxA).toBeLessThan(reportIdxA);

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    const { askPromise: askB } = await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });
    const answerB = await askB;

    const settledIdxB = b.timeline.findIndex((l) => l.startsWith('emit:settled'));
    const reportIdxB = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    expect(settledIdxB).toBeLessThan(reportIdxB);

    expect(answerA.behavior).toBe('deny');
    expect(answerB.behavior).toBe('deny');
    expect((answerA as { message?: string }).message).not.toBe(
      (answerB as { message?: string }).message,
    );
  });

  it('(c) 生ログの書き出し（archive）は query.close() の前か後か——#1533 の直しで揃った（以前は経路で違った）。fake が close 後の破損まで模していないことも書く', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const archiveIdxA = a.timeline.findIndex((l) => l.startsWith('emit:archive'));
    const closeIdxA = a.timeline.indexOf('query.close()');
    expect(archiveIdxA).toBeGreaterThan(closeIdxA);

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const archiveIdxB = b.timeline.findIndex((l) => l.startsWith('emit:archive'));
    const closeIdxB = b.timeline.indexOf('query.close()');
    expect(archiveIdxB).toBeGreaterThan(closeIdxB);

    // 「close の後に読むと壊れる／欠ける」かどうかは、この足場では測れない:
    // fake の `close()` は実ファイルに触らないので、いつ読んでも同じ内容が返る。
    // この歯は順序が動いたことだけを固定し、生ログの完全性が上がったとは主張しない。
  });

  it('(d) closed の emit（経路Bだけ）は report の前か後か', async () => {
    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const reportIdx = b.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closedIdx = b.timeline.findIndex((l) => l.startsWith('emit:closed'));
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeLessThan(closedIdx);
  });

  it('(e) それ以外に、経路で外から見える出来事の集合そのものが違う', async () => {
    const a = setup();
    await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionA = await firstSession(a.sessions);
    const pathA = join(dir, 'a.jsonl');
    writeFileSync(pathA, 'x', 'utf8');
    await primeState(sessionA, pathA);
    await a.host.stop('mgr-1');

    const b = setup();
    await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const sessionB = await firstSession(b.sessions);
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathB, 'x', 'utf8');
    await primeState(sessionB, pathB);
    sessionB.end();
    await vi.waitFor(() => {
      if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const typesA = new Set(a.events.map((e) => e.type));
    const typesB = new Set(b.events.map((e) => e.type));

    expect(typesA.has('closed')).toBe(false);
    expect(typesB.has('closed')).toBe(true);

    const withoutClosed = (set: Set<string>) => {
      const copy = new Set(set);
      copy.delete('closed');
      return copy;
    };
    expect([...withoutClosed(typesA)].sort()).toEqual([...withoutClosed(typesB)].sort());
  });
});

/**
 * `noteUnclassifiedFailuresSummary` と `flushUsage` の前後は、外から観測できる差が無いので
 * 「揃えない」と決めた。経路で前後が逆のままであることを固定する（どちらが正しいかは主張しない）。
 * `noteUnclassifiedFailuresSummary` は emit を経由しないので、本物を呼ぶだけの薄いスパイで timeline に積む。
 */
describe('#1533 (3): noteUnclassifiedFailuresSummary と flushUsage の前後は経路で逆順（揃えないという判断を固定する）', () => {
  it('経路Aは flushUsage の後、経路Bは flushUsage の前——揃えないと決めた差が今も逆順のまま残っている', async () => {
    const realSummary = droppedRecord.noteUnclassifiedFailuresSummary;
    // スパイはモジュール単位に1本しか立てられないので、測定中の `setup()` の timeline へ差し替える。
    let sink: string[] | undefined;
    const summarySpy = vi
      .spyOn(droppedRecord, 'noteUnclassifiedFailuresSummary')
      .mockImplementation((seen, managerId) => {
        sink?.push('call:noteUnclassifiedFailuresSummary');
        return realSummary(seen, managerId);
      });

    try {
      const a = setup();
      await a.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
      const sessionA = await firstSession(a.sessions);
      const pathA = join(dir, 'diff3-a.jsonl');
      writeFileSync(pathA, 'x', 'utf8');
      await primeState(sessionA, pathA);
      sink = a.timeline;
      await a.host.stop('mgr-1');

      const usageIdxA = a.timeline.indexOf('emit:usage');
      const summaryIdxA = a.timeline.indexOf('call:noteUnclassifiedFailuresSummary');
      expect(usageIdxA).toBeGreaterThanOrEqual(0);
      expect(summaryIdxA).toBeGreaterThanOrEqual(0);
      expect(summaryIdxA).toBeGreaterThan(usageIdxA);

      const b = setup();
      await b.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
      const sessionB = await firstSession(b.sessions);
      const pathB = join(dir, 'diff3-b.jsonl');
      writeFileSync(pathB, 'x', 'utf8');
      await primeState(sessionB, pathB);
      sink = b.timeline;
      sessionB.end();
      await vi.waitFor(() => {
        if (!b.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
      });

      const usageIdxB = b.timeline.indexOf('emit:usage');
      const summaryIdxB = b.timeline.indexOf('call:noteUnclassifiedFailuresSummary');
      expect(usageIdxB).toBeGreaterThanOrEqual(0);
      expect(summaryIdxB).toBeGreaterThanOrEqual(0);
      expect(summaryIdxB).toBeLessThan(usageIdxB);
    } finally {
      summarySpy.mockRestore();
    }
  });
});

describe('#1533 新しい歯: stop() の生ログの送り出しは #reader の終わりの後', () => {
  it('query.close() の直後にはまだ archive が出ない。#reader が終わって初めて出る', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-defer.jsonl');
    writeFileSync(transcriptPath, '遅延後に読まれる生ログ', 'utf8');
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    s.resetTimeline();

    const stopPromise = s.host.stop('mgr-1');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);

    session.endAfterClose();
    await stopPromise;

    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(true);
    const closeIdx = s.timeline.indexOf('query.close()');
    const archiveIdx = s.timeline.findIndex((l) => l.startsWith('emit:archive'));
    expect(archiveIdx).toBeGreaterThan(closeIdx);
  });
});

describe('#1533 + #1589 新しい歯: stop() の後に #reader が例外で抜けても、報告は stop() からの1本だけ', () => {
  it('report は1本だけ・reason/status は stop() のもの・closed は出ない・報告は #reader の終わりの後', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-crash.jsonl');
    writeFileSync(transcriptPath, '例外経路の生ログ', 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);
    s.resetTimeline();

    const stopPromise = s.host.stop('mgr-1');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:closed'))).toBe(false);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);

    session.crashAfterClose('SDK が close 時に例外を投げた');
    await stopPromise;
    const settledAnswer = await askPromise;

    expect(s.events.some((e) => e.type === 'closed')).toBe(false);

    const reports = s.events.filter(
      (e): e is Extract<RunnerEvent, { type: 'report' }> => e.type === 'report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.unreported).toEqual({ reason: 'デーモンから停止を指示された。' });
    // `#settleAll` が確認を解いた後の `running` ではなく、stop 指示時点の値を名乗る。
    expect(reports[0]?.status).toBe('waiting_human');

    const reportIdx = s.timeline.findIndex((l) => l.startsWith('emit:report'));
    const closeIdx = s.timeline.indexOf('query.close()');
    expect(reportIdx).toBeGreaterThan(closeIdx);

    expect(settledAnswer).toEqual({
      behavior: 'deny',
      message: 'デーモンから停止を指示された。',
    });
  });
});

describe('#1597: resume 直後に結果なし result（unresumable）と stop() が重なっても、closed は出ない', () => {
  it('closed が0本のまま、stop() が host.list() からセッションを消す', async () => {
    const s = setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-mgr',
      cwd: dir,
      request: '調べて',
      // entries を渡さない → renderSessionLog が null → unresumable
    });
    const session = await firstSession(s.sessions);
    s.resetTimeline();

    // await を挟まない: `resultFailed` は同期関数なので、`#read` が次のマイクロタスクで
    // このメッセージを処理する前に `stop()` を割り込ませる。
    session.resultFailed('失敗した', 'error_during_execution');
    await s.host.stop('mgr-1');
    // 競合した `#finish('lost', …)` が遅れて emit することがあるので、一呼吸置いてから数える。
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log('#1597 timeline:', JSON.stringify(s.timeline));

    expect(s.events.filter((e) => e.type === 'closed')).toHaveLength(0);

    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);
  });
});

describe('#1602: #finish() が畳んでいる間に stop() が来ると、待たずに戻ってしまう（再現）', () => {
  it('(a)(b)(c) stop() は #finish() の畳み終わり（closed の emit・#shipArchive）を待ってから解決する', async () => {
    const s = setup({ deferUsage: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-1602.jsonl');
    writeFileSync(transcriptPath, '#1602 の生ログ本文', 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    s.resetTimeline();

    // `#finish` は `deferUsage` ゲートにより `#flushUsage()` の usage 応答待ちで止まる。
    session.end();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(s.timeline.some((l) => l.startsWith('emit:closed'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);

    const stopPromise = s.host.stop('mgr-1');
    let stopSettled = false;
    void stopPromise.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stopSettled).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:closed'))).toBe(false);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);

    session.releaseUsage();
    await stopPromise;

    expect(s.timeline.some((l) => l.startsWith('emit:closed'))).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(true);
    expect(stopSettled).toBe(true);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);

    console.log('#1602 timeline:', JSON.stringify(s.timeline));
  });
});

describe('#1605: stop() 自身の畳みの途中でもう一本 stop()/shutdown() が来ると、待たずに戻ってしまう（再現）', () => {
  it('stop() を2回呼ぶと、2本目は1本目の畳み終わり（archive・report）を待ってから解決する', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-1605-a.jsonl');
    writeFileSync(transcriptPath, '#1605 の生ログ本文（stop 二重呼び）', 'utf8');
    // `say()` で本文を積む: `#flushUnreported` は `hasSaid` が false だと report を出さないので、
    // 無いと report の有無で直し前後を区別できない。
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    s.resetTimeline();

    const stopPromise1 = s.host.stop('mgr-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);

    const stopPromise2 = s.host.stop('mgr-1');
    let stop2Settled = false;
    void stopPromise2.then(
      () => {
        stop2Settled = true;
      },
      () => {
        stop2Settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stop2Settled).toBe(false);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);

    session.endAfterClose();
    await Promise.all([stopPromise1, stopPromise2]);

    expect(stop2Settled).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(true);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);

    console.log('#1605 (stop x2) timeline:', JSON.stringify(s.timeline));
  });

  it('host.shutdown() が stop() の畳みの途中で来ても、畳み終わり（archive・report）を待ってから解決する', async () => {
    const s = setup({ deferCloseEnd: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);

    const transcriptPath = join(dir, 'transcript-1605-b.jsonl');
    writeFileSync(transcriptPath, '#1605 の生ログ本文（shutdown）', 'utf8');
    // 上のテストと同じ理由（`#flushUnreported` の `hasSaid` 門）。
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    s.resetTimeline();

    const stopPromise1 = s.host.stop('mgr-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.timeline).toContain('query.close()');
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);

    const shutdownPromise = s.host.shutdown();
    let shutdownSettled = false;
    void shutdownPromise.then(() => {
      shutdownSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shutdownSettled).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(false);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(false);

    session.endAfterClose();
    await Promise.all([stopPromise1, shutdownPromise]);

    expect(shutdownSettled).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:archive'))).toBe(true);
    expect(s.timeline.some((l) => l.startsWith('emit:report'))).toBe(true);
    expect(s.host.list().some((m) => m.managerId === 'mgr-1')).toBe(false);

    console.log('#1605 (shutdown) timeline:', JSON.stringify(s.timeline));
  });
});

describe('#1586: 畳むときに解いた確認の settled には withdrawn(reason) が載る（answer() の経路には載らない）', () => {
  it('stop() で畳むと、未決の確認の settled に withdrawn(reason) が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'stop-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await primeState(session, transcriptPath);

    await s.host.stop('mgr-1');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    expect(settled?.withdrawn).toEqual({ reason: 'デーモンから停止を指示された。' });
  });

  it('#finish の自然終了（経路B）で畳んでも、未決の確認の settled に withdrawn(reason) が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'finish-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await primeState(session, transcriptPath);

    session.end();
    await vi.waitFor(() => {
      if (!s.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    expect(settled?.withdrawn).toEqual({ reason: 'マネージャーのセッションが閉じた。' });
  });

  it('answer()（クローンの回答）の経路では withdrawn が載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'answer-not-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    const { askPromise } = await primeState(session, transcriptPath);

    await s.host.answer('mgr-1', { requestId: 'req-1', decision: 'allow', message: 'どうぞ' });
    const answer = await askPromise;
    expect(answer.behavior).toBe('allow');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-1',
    );
    expect(settled).toBeDefined();
    expect(settled?.withdrawn).toBeUndefined();
  });

  it('マネージャー側の中断（onAbort）の経路でも withdrawn が載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'abort-not-withdrawn.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');

    await session.say('喋った');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    const controller = new AbortController();
    const canUseTool = session.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId?: string },
    ) => Promise<PermissionResult>;
    const askPromise = canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: controller.signal, requestId: 'req-abort' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    const answer = await askPromise;
    expect(answer.behavior).toBe('deny');

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-abort',
    );
    expect(settled).toBeDefined();
    expect(settled?.withdrawn).toBeUndefined();
  });
});

describe('#1593: 畳む・中断の経路では question も deny(理由付き)になる', () => {
  it('直す前は allow になっていた: stop() で畳むと、未決の question が deny(理由付き)で解ける', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'stop-question-deny.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    await session.taskStarted('task-1');
    const askPromise = session.askPermission('AskUserQuestion', 'req-q1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await s.host.stop('mgr-1');
    const answer = await askPromise;

    expect(answer).toEqual({ behavior: 'deny', message: 'デーモンから停止を指示された。' });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-q1',
    );
    expect(settled?.withdrawn).toEqual({ reason: 'デーモンから停止を指示された。' });
  });

  it('直す前は allow になっていた: #finish の自然終了（経路B）で畳んでも、未決の question が deny(理由付き)で解ける', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'finish-question-deny.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    await session.taskStarted('task-1');
    const askPromise = session.askPermission('AskUserQuestion', 'req-q2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    session.end();
    await vi.waitFor(() => {
      if (!s.events.some((e) => e.type === 'closed')) throw new Error('closed 待ち');
    });
    const answer = await askPromise;

    expect(answer).toEqual({ behavior: 'deny', message: 'マネージャーのセッションが閉じた。' });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-q2',
    );
    expect(settled?.withdrawn).toEqual({ reason: 'マネージャーのセッションが閉じた。' });
  });

  it('直す前は allow になっていた: マネージャー側の中断（onAbort）の経路でも、未決の question が deny(理由付き)で解ける', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'abort-question-deny.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await session.say('喋った');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    const controller = new AbortController();
    const canUseTool = session.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId?: string },
    ) => Promise<PermissionResult>;
    const askPromise = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: '続けますか？', header: 'Q', options: [], multiSelect: false }] },
      { signal: controller.signal, requestId: 'req-q-abort' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    const answer = await askPromise;

    expect(answer).toEqual({ behavior: 'deny', message: 'マネージャー側で中断された。' });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-q-abort',
    );
    expect(settled?.withdrawn).toBeUndefined();
  });

  it('再送されても同じ deny(理由付き)が返る(#resolved 経由)', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'stop-question-deny-resend.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await session.say('畳まれる前に喋った本文');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    const askPromise = session.askPermission('AskUserQuestion', 'req-q-resend');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await s.host.stop('mgr-1');
    const first = await askPromise;
    const second = await session.askPermission('AskUserQuestion', 'req-q-resend');

    expect(first).toEqual({ behavior: 'deny', message: 'デーモンから停止を指示された。' });
    expect(second).toEqual(first);
  });

  it('クローンの答え（answer()）の経路では、question はいまどおり allow + 答えになる（回帰の網。#322 と同じ計算のまま）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(s.sessions);
    const transcriptPath = join(dir, 'answer-question-allow.jsonl');
    writeFileSync(transcriptPath, 'x', 'utf8');
    await session.say('喋った');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    const canUseTool = session.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId?: string },
    ) => Promise<PermissionResult>;
    const askPromise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
        ],
      },
      { signal: new AbortController().signal, requestId: 'req-q-answer' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 矛盾した `decision: 'deny'` を明示しても、question は `decision` を見ず allow になる。
    await s.host.answer('mgr-1', {
      requestId: 'req-q-answer',
      decision: 'deny',
      message: 'PostgreSQL で',
    });
    const answer = await askPromise;

    expect(answer.behavior).toBe('allow');
    expect(
      (answer as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers,
    ).toEqual({ 'DB はどちらにする？': 'PostgreSQL で' });

    const settled = s.events.find(
      (e): e is Extract<RunnerEvent, { type: 'settled' }> =>
        e.type === 'settled' && e.requestId === 'req-q-answer',
    );
    expect(settled?.withdrawn).toBeUndefined();
  });
});
