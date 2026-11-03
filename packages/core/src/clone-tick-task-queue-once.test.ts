import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { DAILY_REPORT_KIND, localDate } from './schedule.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// tick のターンで待ち行列の先頭を1回だけ載せる。
// 断り書き（`commitment`）の待ち行列の先頭と、tick の要約（digest）の「待ち行列の先頭」の節は、同じ `describeTaskQueueHead` で、tick のたびに同じ数行が2回載っていた。
// 要約が先頭を載せる tick（発意・日報）では断り書き側を出さない。件数の形の要約（定期の依頼の tick）は先頭を持たないので断り書き側に残す。人間の発言のターンは従来どおり断り書き側。

const TIMER_KIND = 'issue-round';
const NOTICE_HEAD = '[system] 待ち行列（';
const DIGEST_HEAD = '## 待ち行列の先頭';
const TAIL = '全文は `task_list`。並べ替えは `task_move`。';
const FIRST_TASK_LINE = '- task-0（';

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
}

function boot(stores: Stores = createMemoryStores()): Boot {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(inputs.length)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    stores,
    queryFn: fn,
    env: TOKEN_SAVING_ENABLED_ENV,
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, stores, inputs };
}

async function seed(stores: Stores): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString();
    await stores.tasks.add({
      id: `task-${i}`,
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'self',
      title: `待ち行列の仕事 ${i}`,
      body: `待ち行列の本文 ${i}`,
    });
  }
  await stores.schedules.put({
    kind: TIMER_KIND,
    spec: { type: 'daily', at: '09:00' },
    request: '起票されている仕事を見て、着手できるものから進める。',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
}

let seq = 0;

type Post = Parameters<CloneHost['post']>[0];

async function turnOf(s: Boot, event: Post): Promise<string> {
  const before = s.inputs.length;
  s.clone.post(event);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

function selfTick(s: Boot): Promise<string> {
  seq += 1;
  return turnOf(s, {
    type: 'self_initiative',
    id: `evt-self-${String(seq)}`,
    at: new Date().toISOString(),
    reason: '定期 tick',
  });
}

function timerTick(s: Boot): Promise<string> {
  seq += 1;
  return turnOf(s, {
    type: 'timer',
    id: `evt-timer-${String(seq)}`,
    at: new Date().toISOString(),
    kind: TIMER_KIND,
    cause: 'manual',
  });
}

function dailyReportTick(s: Boot): Promise<string> {
  seq += 1;
  return turnOf(s, {
    type: 'timer',
    id: `evt-daily-${String(seq)}`,
    at: new Date().toISOString(),
    kind: DAILY_REPORT_KIND,
    target: localDate(new Date()),
    cause: 'manual',
  });
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('tick のターンで待ち行列の先頭を1回だけ載せる', () => {
  it('⭐ 発意の tick: 先頭は要約の節に1回だけ。断り書きの見出しと末尾の1文は出ない', async () => {
    const s = boot();
    await seed(s.stores);
    const input = await selfTick(s);

    process.stderr.write(`[tick 重複 測定] 発意の tick 入力 ${String(input.length)} 字\n`);
    expect(count(input, FIRST_TASK_LINE)).toBe(1);
    expect(count(input, DIGEST_HEAD)).toBe(1);
    expect(input).not.toContain(NOTICE_HEAD);
    expect(input).not.toContain(TAIL);
    await s.clone.stop();
  });

  it('⭐ 日報の tick: 先頭は要約の節に1回だけ。断り書きの見出しと末尾の1文は出ない', async () => {
    const s = boot();
    await seed(s.stores);
    const input = await dailyReportTick(s);

    process.stderr.write(`[tick 重複 測定] 日報の tick 入力 ${String(input.length)} 字\n`);
    expect(input).toContain('日報をまとめよ');
    expect(count(input, FIRST_TASK_LINE)).toBe(1);
    expect(count(input, DIGEST_HEAD)).toBe(1);
    expect(input).not.toContain(NOTICE_HEAD);
    expect(input).not.toContain(TAIL);
    await s.clone.stop();
  });

  it('⭐ 定期の依頼の tick: 要約は件数の形で先頭を持たないので、先頭は断り書きに1回だけ（情報を落とさない）', async () => {
    const s = boot();
    await seed(s.stores);
    const input = await timerTick(s);

    expect(count(input, FIRST_TASK_LINE)).toBe(1);
    expect(count(input, NOTICE_HEAD)).toBe(1);
    expect(input).not.toContain(DIGEST_HEAD);
    expect(input).toContain(TAIL);
    process.stderr.write(`[tick 重複 測定] 定期の依頼の tick 入力 ${String(input.length)} 字\n`);
    await s.clone.stop();
  });

  it('⭐ 人間の発言のターン: 従来どおり、先頭は断り書きの側に1回だけ（積んだ行も出る）', async () => {
    const s = boot();
    await seed(s.stores);
    const event = humanMessage('やってほしいこと');
    const input = await turnOf(s, event);

    expect(count(input, FIRST_TASK_LINE)).toBe(1);
    expect(count(input, NOTICE_HEAD)).toBe(1);
    expect(input).toContain(TAIL);
    expect(input).toContain(`いま届いたこの一件は task \`${event.id}\` として積んだ。`);
    expect(input).not.toContain(DIGEST_HEAD);
    await s.clone.stop();
  });

  it.each([
    ['発意の tick', selfTick],
    ['日報の tick', dailyReportTick],
  ] as const)(
    '⭐ %s: 要約が組めなかった回にも、先頭は要約の失敗の行のあとに1回だけ載る',
    async (_name, tick) => {
      const stores = createMemoryStores();
      await seed(stores);
      stores.jobs.listUnreadableJobs = async () => {
        throw new Error('委譲の台帳が読めない');
      };
      const s = boot(stores);
      const input = await tick(s);

      expect(input).toContain('まとめられなかった');
      expect(input).toContain('委譲の台帳が読めない');
      expect(count(input, FIRST_TASK_LINE)).toBe(1);
      expect(count(input, DIGEST_HEAD)).toBe(1);
      expect(input).not.toContain(NOTICE_HEAD);
      expect(input).not.toContain('待ち行列を読めなかった');
      await s.clone.stop();
    },
  );

  it('⭐ 要約が組めた回の入力には、失敗の行も読めなかった断りも出ない', async () => {
    const s = boot();
    await seed(s.stores);
    for (const input of [await selfTick(s), await dailyReportTick(s)]) {
      expect(input).not.toContain('まとめられなかった');
      expect(input).not.toContain('待ち行列を読めなかった');
    }
    await s.clone.stop();
  });

  it('⭐ 待ち行列を読めない回は、要約側に同じ断りが無いので、tick でも断り書きが「読めなかった」と名乗る', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    stores.tasks.list = async () => {
      throw new Error('task 台帳が壊れている');
    };
    const s = boot(stores);
    const input = await dailyReportTick(s);

    expect(input).toContain('待ち行列を読めなかった');
    expect(input).toContain('task 台帳が壊れている');
    // 要約の失敗の行のあとにも、読めなかったと名乗る（0 件と書かない）。断り書き側と合わせて2回出る
    expect(count(input, '待ち行列を読めなかった')).toBe(2);
    expect(input).not.toContain('開いている 0 件');
    await s.clone.stop();
  });
});
