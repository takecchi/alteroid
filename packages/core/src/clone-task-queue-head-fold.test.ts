import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone, SITUATION_FULL_EVERY_TURNS } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import { parseFoldState, serializeFoldState } from './fold-state.js';
import type { FoldState } from './fold-state.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 断り書きの待ち行列の先頭は、前のターンに全文を出した先頭の行と1文字も違わなければ、見出しを含む全体を1行に畳む。
// 畳まないもの: 積んだ・積めなかった行、返事待ちの行、固定の末尾。

const AT = '2026-10-29T00:00:00.000Z';
const HEAD = '[system] 待ち行列（';
// 畳んだ1行は2通り: 先頭から「いま積んだ task」の行を除いて比べた回は、そう言う（新しい task が先頭に加わっているのに「変化なし」とだけ書くと嘘になるため）
const FOLDED_PLAIN = '[system] 待ち行列: 前のターンと変化なし（';
const FOLDED_EXCLUDING = '[system] 待ち行列: いま積んだ task を除くと、前のターンと変化なし（';
const FOLDED = '[system] 待ち行列: ';
const TAIL_FULL = '全文は `task_list`。並べ替えは `task_move`。';

interface Boot {
  clone: CloneHost;
  inputs: string[];
  stores: Stores;
}

function boot(
  options: {
    stores?: Stores;
    env?: NodeJS.ProcessEnv;
    compactAtInput?: number;
    /** 最初の query() の生成を投げさせる: 断り書きを組んだ後、入力を SDK へ入れる前に落ちる回を作る */
    failFirstQuery?: boolean;
  } = {},
): Boot {
  const stores = options.stores ?? createMemoryStores();
  const inputs: string[] = [];
  let queryCalls = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    queryCalls += 1;
    if (options.failFirstQuery === true && queryCalls === 1) {
      throw new Error('query の生成に失敗した(test)');
    }
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
        if (inputs.length === options.compactAtInput) {
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
            session_id: 'sess-fake',
            uuid: 'uuid-compact',
          } as unknown as SDKMessage;
        }
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
    env: options.env ?? TOKEN_SAVING_ENABLED_ENV,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs, stores };
}

function human(id: string, conversationId = 'conv-1'): InboxEvent {
  return { type: 'human_message', id, at: new Date().toISOString(), text: id, conversationId };
}

function seededTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'queued',
    origin: 'self',
    title: `題-${id}`,
    body: `body-${id}`,
    ...overrides,
  };
}

let seq = 0;

/**
 * 発言を1つ投げて入力を返す。その発言の task は閉じてから返す: 閉じないと次の回の待ち行列に残り、「同じ待ち行列」が作れないため。
 * 入力が返ったあと控えが確定するまでの間に次を投げないよう、結果の event（turn_timing）を待たずとも `inputs` が増えた時点で十分（確定は押し込んだ直後）
 */
async function turn(s: Boot, conversationId = 'conv-1'): Promise<{ input: string; id: string }> {
  const before = s.inputs.length;
  const timings = await timingCount(s);
  seq += 1;
  const id = `fold-evt-${String(seq)}`;
  s.clone.post(human(id, conversationId));
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  await settle(s, timings + 1);
  await s.stores.tasks.setStatus(id, 'done', { reason: 'test', by: 'human', at: AT });
  return { input: s.inputs[before] ?? '', id };
}

async function timingCount(s: Boot): Promise<number> {
  return (await s.stores.journal.list({ types: ['turn_timing'] })).length;
}

/** 次の回を投げて良い状態まで待つ: 結果が返って `turn_timing` が日誌に載ったら前のターンは終わっている。 */
async function settle(s: Boot, count: number): Promise<void> {
  await waitFor(
    async () => (await timingCount(s)) >= count,
    `ターン終わり（${String(count)} 本目）`,
  );
}

function noticeLines(input: string): string[] {
  const lines = input.split('\n');
  const start = lines.findIndex((line) => line.startsWith(HEAD) || line.startsWith(FOLDED));
  expect(start, '待ち行列の節が入力に無い').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line === '---');
  return lines.slice(start, end < 0 ? undefined : end);
}

const isFolded = (input: string): boolean =>
  input.includes(FOLDED_PLAIN) || input.includes(FOLDED_EXCLUDING);

describe('断り書きの待ち行列の先頭は、前のターンと同じなら1行に畳む', () => {
  it('⭐ 先頭の行（材料）が1文字も変わらなければ、2回目は1行になり字数が減る。placed と固定の末尾は畳まない', async () => {
    const stores = createMemoryStores();
    // 先頭は limit 件までなので、古い task を limit 以上積んで、新しい発言の task が先頭に載らない形にする
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    const first = await turn(s);
    const second = await turn(s);
    expect(isFolded(first.input)).toBe(false);
    expect(isFolded(second.input)).toBe(true);
    const fullLines = noticeLines(first.input);
    const lines = noticeLines(second.input);
    expect(lines[0]).toMatch(
      /^\[system\] 待ち行列: いま積んだ task を除くと、前のターンと変化なし（.+に数え直した）。$/,
    );
    // 積んだ旨の行と固定の末尾は畳まない
    expect(
      lines.some((line) =>
        line.includes(`いま届いたこの一件は task \`${second.id}\` として積んだ。`),
      ),
    ).toBe(true);
    // 固定の末尾は既存の `fixed` のまま: 2回目は短い参照になる（この畳みとは別の仕組み）
    expect(first.input).toContain(TAIL_FULL);
    expect(lines).toContain('（`task_list`・`task_move` は会話の上と同じ）');
    expect(lines.join('\n').length).toBeLessThan(fullLines.join('\n').length);
    // 先頭の部分だけの字数（積んだ旨の行より前）
    const headOnly = (list: string[]): string =>
      list
        .slice(
          0,
          list.findIndex((line) => line.startsWith('いま届いた')),
        )
        .join('\n');
    process.stderr.write(
      `[待ち行列の先頭 測定] 先頭の部分 ${String(headOnly(fullLines).length)} 字 → ${String(headOnly(lines).length)} 字\n`,
    );
    process.stderr.write(
      `[待ち行列の先頭 測定] 全文の節\n${fullLines.join('\n')}\n--- 畳んだ節\n${lines.join('\n')}\n(${String(fullLines.join('\n').length)} 字 → ${String(lines.join('\n').length)} 字)\n`,
    );
    await s.clone.stop();
  });

  it('1件でも変われば（追加・状態の変化・順序）全文に戻る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    await turn(s);
    await turn(s);
    const same = await turn(s);
    expect(isFolded(same.input)).toBe(true);

    // 追加
    await stores.tasks.add(seededTask('added'));
    const added = await turn(s);
    expect(isFolded(added.input)).toBe(false);
    const sameAgain = await turn(s);
    expect(isFolded(sameAgain.input)).toBe(true);

    // 状態の変化
    await stores.tasks.setStatus('old-0', 'waiting', { reason: 'test', by: 'clone', at: AT });
    const changed = await turn(s);
    expect(isFolded(changed.input)).toBe(false);
    await s.clone.stop();
  });

  it('⭐ 文脈が要約されると全文に戻る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores, compactAtInput: 4 });
    await turn(s);
    await turn(s);
    const folded = await turn(s);
    expect(isFolded(folded.input)).toBe(true);
    // 4回目の途中で要約が起きる（4回目自身は畳める）。5回目は全文
    const fourth = await turn(s);
    expect(isFolded(fourth.input)).toBe(true);
    const afterCompaction = await turn(s);
    expect(isFolded(afterCompaction.input)).toBe(false);
    await s.clone.stop();
  });

  it(`${String(SITUATION_FULL_EVERY_TURNS)} ターンごとに全文へ戻る（周期の保険）`, async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    const folds: boolean[] = [];
    for (let i = 0; i < SITUATION_FULL_EVERY_TURNS + 3; i += 1) {
      folds.push(isFolded((await turn(s)).input));
    }
    const firstFold = folds.indexOf(true);
    expect(firstFold).toBeGreaterThan(-1);
    expect(folds.slice(firstFold).includes(false)).toBe(true);
    await s.clone.stop();
  });

  it('節約が無効（既定）なら毎回全文', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores, env: {} });
    for (let i = 0; i < 4; i += 1) {
      const result = await turn(s);
      expect(isFolded(result.input)).toBe(false);
      expect(result.input).toContain(HEAD);
    }
    await s.clone.stop();
  });

  it('⭐ 待ち行列を読めなかった回は全文の断りを出し、控えを消すので、次に読めた回は全文', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const originalList = stores.tasks.list.bind(stores.tasks);
    let failing = false;
    stores.tasks.list = (async () => {
      if (failing) throw new Error('読めない(test)');
      return originalList();
    }) as typeof stores.tasks.list;
    const s = boot({ stores });
    await turn(s);
    await turn(s);
    expect(isFolded((await turn(s)).input)).toBe(true);

    failing = true;
    const unreadable = await turn(s);
    expect(unreadable.input).toContain('待ち行列を読めなかった');
    expect(isFolded(unreadable.input)).toBe(false);
    failing = false;
    // 控えを消したので、同じ待ち行列でも次の回は全文
    const afterFailure = await turn(s);
    expect(isFolded(afterFailure.input)).toBe(false);
    expect(isFolded((await turn(s)).input)).toBe(true);
    await s.clone.stop();
  });

  it('⭐ 返事待ち（waiting）の行は畳まれない', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    await stores.tasks.add(
      seededTask('wait-1', { status: 'waiting', origin: 'self', originConversationId: 'conv-1' }),
    );
    const s = boot({ stores });
    await turn(s);
    await turn(s);
    const folded = await turn(s);
    expect(isFolded(folded.input)).toBe(true);
    expect(folded.input).toContain('返事待ち（waiting）の task: `wait-1`');
    expect(folded.input).toContain('wait-1` 題-wait-1');
    await s.clone.stop();
  });

  it('会話が変わる（別の会話の発言）だけでは、待ち行列が同じなら畳む。控えは会話の切り替えで消える仕組みに乗る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    await turn(s);
    await turn(s);
    const folded = await turn(s, 'conv-2');
    // 発言の会話が変わっても、クローンの会話（SDK のセッション）は同じ。控えが指すのは SDK の会話
    expect(isFolded(folded.input)).toBe(true);
    expect(TAIL_FULL.length).toBeGreaterThan(0);
    await s.clone.stop();
  });
});

describe('畳んだ1行の文言は、先頭から除いた行があるかで2通り', () => {
  it('⭐ いま積んだ task の行を除いて比べた回は「いま積んだ task を除くと、」と言う', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    await turn(s);
    const second = await turn(s);
    expect(second.input).toContain(`${FOLDED_EXCLUDING}`);
    expect(second.input).not.toContain(FOLDED_PLAIN);
    // 除いた行は、畳んだ回には見えない。名乗るのは「いま積んだ」の行
    expect(second.input).toContain(`いま届いたこの一件は task \`${second.id}\` として積んだ。`);
    await s.clone.stop();
  });

  it('⭐ 除いた行が無い回（積んだ発言が無い tick）は元の「前のターンと変化なし」のまま', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    const tick = async (id: string): Promise<string> => {
      const before = s.inputs.length;
      const timings = await timingCount(s);
      s.clone.post({ type: 'timer', id, at: new Date().toISOString(), kind: 'tick' });
      await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
      await settle(s, timings + 1);
      return s.inputs[before] ?? '';
    };
    const first = await tick('tick-a');
    const second = await tick('tick-b');
    expect(isFolded(first)).toBe(false);
    expect(first).toContain(HEAD);
    expect(second).toContain(FOLDED_PLAIN);
    expect(second).not.toContain(FOLDED_EXCLUDING);
    await s.clone.stop();
  });
});

describe('入力を SDK へ入れる前に落ちた回は、控えが進まない', () => {
  it('⭐ 断り書きを組んだ後に query の生成で落ちた回の全文は「出した」扱いにならず、次の回は全文', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores, failFirstQuery: true });
    seq += 1;
    const failedId = `fold-evt-${String(seq)}`;
    s.clone.post(human(failedId));
    // 落ちた回は失敗の行が日誌に残る（入力は SDK に入っていない）
    await waitFor(
      async () => (await stores.journal.list({ types: ['exchange'] })).length > 0,
      '失敗の行',
    );
    expect(s.inputs).toHaveLength(0);
    await stores.tasks.setStatus(failedId, 'done', { reason: 'test', by: 'human', at: AT });

    // 落ちた回が控えを進めていたら、同じ待ち行列のこの回は畳まれてしまう
    const next = await turn(s);
    expect(isFolded(next.input)).toBe(false);
    expect(next.input).toContain(HEAD);
    await s.clone.stop();
  });
});

describe('預けた控え（fold-state）の互換: 鍵が増えても読める。鍵が無い古い控えは全文になる', () => {
  const base = (situation: [string, string][]): FoldState => ({
    v: 1,
    sessionId: 'sess-1',
    situation,
    turnsSinceFull: 3,
    digest: { sections: null, fixed: [], requests: [], paragraphs: [], reports: [] },
    usage: null,
    growthTokens: 0,
  });

  it('新しい鍵（taskQueueHead）入りの控えは、そのまま預けて読み戻せる', () => {
    const raw = serializeFoldState(base([['taskQueueHead', '- 待ち行列: 開いている 1 件']]));
    expect(raw).not.toBeNull();
    expect(parseFoldState(raw!)?.situation).toEqual([
      ['taskQueueHead', '- 待ち行列: 開いている 1 件'],
    ]);
  });

  it('鍵が無い古い控えも読める（読み戻した後 `get` が undefined なので全文になる）', () => {
    const raw = serializeFoldState(base([['materials', 'm']]));
    const parsed = parseFoldState(raw!);
    expect(parsed).not.toBeNull();
    expect(new Map(parsed!.situation).get('taskQueueHead')).toBeUndefined();
  });
});
