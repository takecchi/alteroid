import { describe, expect, it } from 'vitest';

import type { AgentStopRecord } from './agent-hooks.js';
import { RunnerStopObserver } from './runner-stop-observer.js';
import { RunnerSubagentStopState } from './runner-subagent-stop-state.js';

// `RunnerStopObserver#observe`（`RunnerSession#onStop` を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口（`stopState` の各メソッド・`note`）を呼ぶ順と回数・結果が Promise であること・
// `note` が同期で投げたときの握り方・`stopState` が参照のまま使われること・await を足さない／外さないこと。
// note の全文・欄ごとの値は `runner-stop-pin.test.ts`（切り出し前の作りの出力）が縛っている。
// 実時間では待たない（待つのはマイクロタスクの周回だけ）。

interface Harness {
  observer: RunnerStopObserver;
  calls: string[];
  notes: string[];
}

function harness(
  options: {
    owners?: Record<string, string>;
    note?: (text: string) => void;
  } = {},
): Harness {
  const calls: string[] = [];
  const notes: string[] = [];
  let firings = 0;
  let idleNoted = false;
  const owners = options.owners ?? {};
  const observer = new RunnerStopObserver({
    stopState: {
      incrementStopFirings: () => {
        calls.push('incrementStopFirings');
        firings += 1;
        return firings;
      },
      backgroundTaskOwner: (id) => {
        calls.push(`backgroundTaskOwner:${id}`);
        return owners[id];
      },
      get stopFirings() {
        calls.push('stopFirings');
        return firings;
      },
      get stopIdleNoted() {
        calls.push('stopIdleNoted');
        return idleNoted;
      },
      markStopIdleNoted: () => {
        calls.push('markStopIdleNoted');
        idleNoted = true;
      },
    },
    note:
      options.note ??
      ((text) => {
        calls.push('note');
        notes.push(text);
      }),
  });
  return { observer, calls, notes };
}

const shell = (id: string, status = 'running') => ({
  id,
  type: 'shell',
  status,
  description: 'd',
});

describe('口を呼ぶ順と回数', () => {
  it('0 件の回: incrementStopFirings → stopIdleNoted → markStopIdleNoted → stopFirings → note。2 回目は note まで進まない', async () => {
    const h = harness();
    await h.observer.observe({ backgroundTasks: [], sessionCrons: [] });
    const first = [...h.calls];
    h.calls.length = 0;
    await h.observer.observe({});
    expect({ first, second: h.calls }).toMatchInlineSnapshot(`
      {
        "first": [
          "incrementStopFirings",
          "stopIdleNoted",
          "markStopIdleNoted",
          "stopFirings",
          "note",
        ],
        "second": [
          "incrementStopFirings",
          "stopIdleNoted",
        ],
      }
    `);
  });

  it('在り高の回: incrementStopFirings が先頭。タスクごとに所有者を引く（内訳で 1 回・行で 1 回、worker はさらに 1 回）', async () => {
    const h = harness({ owners: { w: 'agent-1', m: '' } });
    await h.observer.observe({
      backgroundTasks: [shell('m'), shell('w'), shell('x'), { type: 'subagent' }],
    });
    expect(h.calls).toMatchInlineSnapshot(`
      [
        "incrementStopFirings",
        "backgroundTaskOwner:m",
        "backgroundTaskOwner:w",
        "backgroundTaskOwner:x",
        "backgroundTaskOwner:m",
        "backgroundTaskOwner:w",
        "backgroundTaskOwner:w",
        "backgroundTaskOwner:x",
        "note",
      ]
    `);
  });

  it('読み取りの失敗（readError）の回: incrementStopFirings だけ呼んで、note は失敗の 1 本', async () => {
    const h = harness();
    await h.observer.observe({ readError: new Error('読めなかった') });
    expect({ calls: h.calls, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "calls": [
          "incrementStopFirings",
          "note",
        ],
        "notes": [
          "Stop の観測に失敗した: Error: 読めなかった",
        ],
      }
    `);
  });

  it('id が文字列でないタスクは所有者を引かない', async () => {
    const h = harness();
    await h.observer.observe({ backgroundTasks: [{ type: 'shell' }, { id: 3, type: 'shell' }] });
    expect(h.calls.filter((call) => call.startsWith('backgroundTaskOwner'))).toEqual([]);
  });
});

describe('結果の形', () => {
  it('戻り値は Promise で、undefined へ解ける。どの枝でも同じ', async () => {
    const h = harness();
    const records: AgentStopRecord[] = [
      {},
      { backgroundTasks: [shell('a')] },
      { readError: new Error('x') },
    ];
    for (const record of records) {
      const result = h.observer.observe(record);
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBeUndefined();
    }
  });

  it('note は呼んだ時点（await 無し）で届いている', () => {
    const h = harness();
    void h.observer.observe({});
    expect(h.notes).toHaveLength(1);
  });

  it('await を足さない・外さない: 呼んでから解けるまでの周回数（0 件・在り高・失敗）', async () => {
    async function ticksOf(record: AgentStopRecord): Promise<number> {
      const h = harness();
      let ticks = 0;
      let settledAt = -1;
      void h.observer.observe(record).then(() => {
        settledAt = ticks;
      });
      while (settledAt < 0 && ticks < 50) {
        await Promise.resolve();
        ticks += 1;
      }
      return settledAt;
    }
    expect({
      idle: await ticksOf({}),
      busy: await ticksOf({ backgroundTasks: [shell('a')] }),
      failed: await ticksOf({ readError: new Error('x') }),
    }).toMatchInlineSnapshot(`
      {
        "busy": 0,
        "failed": 0,
        "idle": 0,
      }
    `);
  });
});

describe('note が同期で投げたときの握り方（observe は投げない）', () => {
  it('本文の note が投げる: 失敗の note を 1 本足す。通算は進んでいる', async () => {
    const texts: string[] = [];
    let first = true;
    const h = harness({
      note: (text) => {
        texts.push(text);
        if (first) {
          first = false;
          throw new Error('note が落ちた');
        }
      },
    });
    await expect(h.observer.observe({ backgroundTasks: [shell('a')] })).resolves.toBeUndefined();
    expect({
      count: texts.length,
      second: texts[1],
      firings: h.calls.filter((call) => call === 'incrementStopFirings').length,
    }).toMatchInlineSnapshot(`
      {
        "count": 2,
        "firings": 1,
        "second": "Stop の観測に失敗した: Error: note が落ちた",
      }
    `);
  });

  it('失敗の note も投げる: 黙って諦める（投げ直さない）。2 回呼ばれて終わる', async () => {
    let count = 0;
    const h = harness({
      note: () => {
        count += 1;
        throw new Error('note が落ちた');
      },
    });
    await expect(h.observer.observe({ backgroundTasks: [shell('a')] })).resolves.toBeUndefined();
    expect(count).toBe(2);
  });

  it('0 件の回の note が投げる: 診断は済んだ扱い（markStopIdleNoted は note の前）', async () => {
    let throwOnce = true;
    const h = harness({
      note: (text) => {
        h.notes.push(text);
        if (throwOnce) {
          throwOnce = false;
          throw new Error('note が落ちた');
        }
      },
    });
    await h.observer.observe({});
    await h.observer.observe({});
    expect(h.notes.map((text) => text.slice(0, 20))).toMatchInlineSnapshot(`
      [
        "Stop: マネージャーのターンが閉じた",
        "Stop の観測に失敗した: Error",
      ]
    `);
  });

  it('stopState の口が同期で投げる: 握る（incrementStopFirings が投げても失敗の note が出る）', async () => {
    const notes: string[] = [];
    const observer = new RunnerStopObserver({
      stopState: {
        incrementStopFirings: () => {
          throw new Error('数えられなかった');
        },
        backgroundTaskOwner: () => undefined,
        stopFirings: 0,
        stopIdleNoted: false,
        markStopIdleNoted: () => undefined,
      },
      note: (text) => notes.push(text),
    });
    await expect(observer.observe({})).resolves.toBeUndefined();
    expect(notes).toMatchInlineSnapshot(`
      [
        "Stop の観測に失敗した: Error: 数えられなかった",
      ]
    `);
  });
});

describe('stopState は参照のまま使われる', () => {
  it('協力者が進めた通算・診断済みの旗が、外から同じ器で見える', async () => {
    const state = new RunnerSubagentStopState();
    const notes: string[] = [];
    const observer = new RunnerStopObserver({ stopState: state, note: (text) => notes.push(text) });
    await observer.observe({});
    await observer.observe({});
    expect({ firings: state.stopFirings, idleNoted: state.stopIdleNoted, notes: notes.length })
      .toMatchInlineSnapshot(`
        {
          "firings": 2,
          "idleNoted": true,
          "notes": 1,
        }
      `);
  });

  it('外から表へ入れた所有者が、後の回の内訳に効く（写しではない）', async () => {
    const state = new RunnerSubagentStopState();
    const notes: string[] = [];
    const observer = new RunnerStopObserver({ stopState: state, note: (text) => notes.push(text) });
    await observer.observe({ backgroundTasks: [shell('late')] });
    state.setBackgroundTaskOwner('late', 'agent-9');
    await observer.observe({ backgroundTasks: [shell('late')] });
    const lines = notes.map((text) => text.split('\n').find((line) => line.startsWith('- id=')));
    expect(lines).toMatchInlineSnapshot(`
      [
        "- id=late owner=unresolved type=shell status=running description=d",
        "- id=late owner=worker:agent-9 type=shell status=running description=d",
      ]
    `);
  });

  it('外から通算を進めておくと、note の通算に出る', async () => {
    const state = new RunnerSubagentStopState();
    state.incrementStopFirings();
    state.incrementStopFirings();
    const notes: string[] = [];
    const observer = new RunnerStopObserver({ stopState: state, note: (text) => notes.push(text) });
    await observer.observe({ backgroundTasks: [shell('a')] });
    expect(notes[0]?.slice(0, 50)).toMatchInlineSnapshot(
      `"Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 3回目）: **背景処理 1件 /"`,
    );
  });
});
