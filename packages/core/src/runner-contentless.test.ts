import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * **中身の無い報告が、クローンのターンを1本焼く。**
 *
 * 実測で、死んだマネージャーから「（報告なし）」が届いてクローンのターンが
 * 起きた事例が2体・計3回ある。経路は `runner.ts` の `resultText()` /
 * `reportText()` が SDK の `result` にも `said`（実際に喋った本文）にも
 * 文字が無いときだけ `'（報告なし）'` を作り、それがそのまま `report`
 * イベントの本文になる、というものだった。
 *
 * ここは `manager.ts` を経由せず `createRunnerHost` の生の `RunnerEvent` を
 * 直接見る（`runner-wakeup.test.ts` と同じ足場）。**`manager.test.ts` /
 * `runner-failure.test.ts` はデーモンを経由した見え方（クローンの受信箱へ
 * 届くか）を固定するが、ここは runner が実際に何を emit したかを直接見る** —
 * `contentless` フィールドがどう立つかは、この層でしか検査できない。
 */

interface FakeSession {
  /** マネージャーが本文を1つ喋る。 */
  say(text: string, options?: { error?: string }): Promise<void>;
  /** 1ターンを畳む。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
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
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result',
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('report イベントの contentless（文言ではなく構造で判定する）', () => {
  it('SDK の result が空・said も空のとき、text は従来どおり「（報告なし）」で、contentless が立つ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    // `say()` を1度も呼ばない ＝ said は空。result も空文字列。
    await session.finish('');

    const [report] = await reportEvents(s.events, 1);
    // **出力される文字列は1文字も変えていない。**
    expect(report?.text).toBe('（報告なし）');
    expect(report?.contentless).toBe(true);
    expect(report?.failure).toBeUndefined();
  });

  it('said に本文があれば、result が空でも contentless は立たない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('途中の一言');
    await session.finish('');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.text).toContain('途中の一言');
    expect(report?.contentless).toBeUndefined();
  });

  it('失敗（assistant.error）で終わった回は、本文が丸ごと空でも contentless に含めない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    // `say()` は1度も呼ばない。失敗の印だけを持つ本文が来て、result も空。
    await session.say('', { error: 'billing_error' });
    await session.finish('', { isError: true });

    const [report] = await reportEvents(s.events, 1);
    expect(report?.failure).toBeDefined();
    // **失敗で終わった回はここに含めない。** `failedReportText()` は必ず
    // 本文を作るので、`contentless` は立たない（`runner-protocol.ts` の doc）。
    expect(report?.contentless).toBeUndefined();
    expect(report?.text).toContain('応答を返さずに終わった');
  });

  it('中身のある報告では contentless は付かない（回帰）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('中身のある報告');
    await session.finish('中身のある報告');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.text).toContain('中身のある報告');
    expect(report?.contentless).toBeUndefined();
  });
});
