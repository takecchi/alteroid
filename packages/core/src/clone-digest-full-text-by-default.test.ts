import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { REPORT_FOLLOW_UP_GUIDE } from './clone-batch-prompts.js';
import { waitFor, withoutQueueNotice } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// #4937: tick の要約は、同じ会話の中でも前回からの差分にせず、毎回全文で出す

const TIMER_KIND = 'issue-round';
const REQUEST_BODY = `open issue を見て、着手できるものから進める。${'依頼の本文の長い説明。'.repeat(40)}`;
const UNCHANGED_SECTION = 'の要約から変わっていない。全文は会話の上にある';
const INSTRUCTION_HEAD = 'この依頼と記憶にある目的・価値観に照らして';
const INSTRUCTION_REF = '（固定の指示は会話の上と同じ）';
const SELF_INSTRUCTION_HEAD = '記憶にある目的と、いまの状況を見て、次にやることがあるかを決めよ。';

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
  /** 入力の受け付けが終わった（作り直しのために入力が閉じた）か。 */
  inputEnded: () => boolean;
}

interface SdkScript {
  /** n 番目（1始まり）の入力を受けたあとで、結果の前に流す出来事。 */
  after?: (inputCount: number) => SDKMessage[];
  /** ターンの終わりに測る文脈の量。 */
  contextTotals?: readonly number[];
  /** 起動そのものを失敗させる回数（先頭から）。 */
  failFirstStarts?: number;
  /** 使用量の観測を取れなくする（`getContextUsage` を持たない）。既定は閾値から遠い観測を返す（#4941）。 */
  noUsage?: boolean;
  /** n 番目（1始まり）の入力を、成功ではなく失敗の result で終える。 */
  failResultAt?: number;
  /** 入力の受け付けが終わった後、この Promise が解けるまで出来事の列を閉じない（作り直しの窓を開けておく）。 */
  holdAfterInputEnd?: Promise<void>;
  /** クローンの env。既定は空。 */
  env?: NodeJS.ProcessEnv;
}

async function seed(stores: Stores): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i += 1) {
    await stores.jobs.putJob({
      id: `mgr-${String(i).padStart(3, '0')}`,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: `担当 ${i} の仕事`,
      request: `担当 ${i} の仕事。${'依頼の説明が続く。'.repeat(8)}`,
      lastReport: `担当 ${i} の途中経過。${'報告の本文が続く。'.repeat(10)}`,
    });
  }
  // 待ち行列（#5469 P6b）: 開いている 4 件。先頭の3件が自発の tick の入力に載る
  for (let i = 0; i < 4; i += 1) {
    await stores.tasks.add({
      id: `task-${i}`,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      updatedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      status: 'queued',
      origin: 'self',
      // 起点の会話を持たせる: 持たない自分のメモだけでは発意 tick の門が開かず、2回目の tick が回らないため
      originConversationId: `conv-task-${i}`,
      title: `待ち行列の仕事 ${i}`,
      body: `待ち行列の本文 ${i}`,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    await stores.jobs.putApproval({
      id: `ap-${i}`,
      createdAt: now,
      question: `人間への問い ${i}。${'確かめたいことが続く。'.repeat(6)}`,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    await stores.journal.append({
      type: 'external_event',
      source: i % 2 === 0 ? 'github' : 'ci',
      summary: `届いた出来事 ${i}。${'要旨が続く。'.repeat(8)}`,
    });
  }
  for (let i = 0; i < 6; i += 1) {
    await stores.journal.append({
      type: 'decision',
      decision: `聞かずに決めたこと ${i}`,
      grounds: '記憶の根拠',
    });
  }
  await stores.schedules.put({
    kind: TIMER_KIND,
    spec: { type: 'daily', at: '09:00' },
    request: REQUEST_BODY,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
}

function boot(script: SdkScript = {}): Boot {
  const inputs: string[] = [];
  let starts = 0;
  let totalsIndex = 0;
  let inputEnded = false;
  const contextTotals = script.contextTotals ?? [10_000];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    starts += 1;
    if (starts <= (script.failFirstStarts ?? 0)) throw new Error('起動に失敗した');
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
        for (const extra of script.after?.(inputs.length) ?? []) yield extra;
        yield (script.failResultAt === inputs.length
          ? {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['途中で失敗した'],
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }
          : {
              type: 'result',
              subtype: 'success',
              result: 'ok',
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }) as unknown as SDKMessage;
      }
      inputEnded = true;
      await script.holdAfterInputEnd;
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      ...(script.noUsage === true
        ? {}
        : {
            getContextUsage: async () => {
              const totals = contextTotals;
              const totalTokens = totals[Math.min(totalsIndex, totals.length - 1)] ?? 0;
              totalsIndex += 1;
              return {
                categories: [],
                totalTokens,
                maxTokens: 1_000_000,
                rawMaxTokens: 1_000_000,
                percentage: totalTokens / 10_000,
                autoCompactThreshold: 200_000,
                isAutoCompactEnabled: true,
              };
            },
          }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const stores = createMemoryStores();
  const clone = createClone({
    stores,
    queryFn: fn,
    env: script.env ?? {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, stores, inputs, inputEnded: () => inputEnded };
}

let eventSeq = 0;

async function timerTick(s: Boot): Promise<string> {
  const before = s.inputs.length;
  eventSeq += 1;
  s.clone.post({
    type: 'timer',
    id: `evt-timer-${eventSeq}`,
    at: new Date().toISOString(),
    kind: TIMER_KIND,
    cause: 'manual',
  });
  await waitFor(() => s.inputs.length > before, `timer の入力 ${before + 1} 本目`);
  return s.inputs[before] ?? '';
}

async function selfTick(s: Boot): Promise<string> {
  const before = s.inputs.length;
  eventSeq += 1;
  s.clone.post({
    type: 'self_initiative',
    id: `evt-self-${eventSeq}`,
    at: new Date().toISOString(),
    reason: '定期 tick',
  });
  await waitFor(() => s.inputs.length > before, `発意の入力 ${before + 1} 本目`);
  return s.inputs[before] ?? '';
}

/** 完全な全文: 省いた節の参照が無く、発行元別の件数・使った分も載っている。 */
function expectCompleteFull(text: string): void {
  expect(text).not.toContain('この節は省いた');
  expect(text).toContain('## 使った分');
  expect(text).toContain('発行元（source）別の件数');
}

describe('tick の要約は、同じ会話の中でも前回からの差分にならず全文で出る（#4937）', () => {
  it('日報は全文のまま（差分にしない）', async () => {
    const s = boot();
    await seed(s.stores);

    await timerTick(s);
    const before = s.inputs.length;
    eventSeq += 1;
    s.clone.post({
      type: 'timer',
      id: `evt-report-${eventSeq}`,
      at: new Date().toISOString(),
      kind: 'daily_report',
      cause: 'manual',
      target: new Date().toISOString().slice(0, 10),
    });
    await waitFor(() => s.inputs.length > before, '日報の入力');
    const report = s.inputs[before] ?? '';

    expect(report).toContain('日報');
    expect(report).toContain('担当 7 の途中経過');
    expect(report).not.toContain(UNCHANGED_SECTION);
    expect(report).not.toMatch(/ほかの \d+ 件は前回/u);
    await s.clone.stop();
  });
});

describe('tick の種類で要約を出し分ける（#4938 の案2）', () => {
  it('⭐ 定期の tick には、担当の節と継続中の依頼の節が中身つきで付き、他の節は件数の行だけになる', async () => {
    const s = boot();
    await seed(s.stores);

    const timer = await timerTick(s);

    expect(timer).toContain(REQUEST_BODY.trim());
    // 中身を出す2節
    expect(timer).toContain('## マネージャー');
    expect(timer).toContain('担当 7 の途中経過');
    expect(timer).toContain('## 継続中の依頼');
    expect(timer).toContain(`- ${TIMER_KIND}（`);
    // 他の節は件数の行だけ。重なる数（担当の status 別・継続中の依頼の数）は件数の行に載らない
    expect(timer).toContain(COUNTS_LINE);
    // 待ち行列は件数の1行だけ。先頭の描画（task の行・案内・節）は出さない
    // #5469 P6c: ターン頭の断り書きの待ち行列の節にも同じ件数・先頭の行が出る。ここで見たいのは要約（digest）の側なので、節を落としてから見る
    const digestOnly = withoutQueueNotice(timer);
    expect(digestOnly).toContain(QUEUE_COUNT_LINE);
    expect(digestOnly).not.toContain('待ち行列の仕事 0');
    expect(digestOnly).not.toContain('先頭が先にやるもの');
    expect(digestOnly).not.toContain('## 待ち行列');
    expect(timer).not.toContain('担当 running');
    expect(timer.match(/^## /gmu)).toHaveLength(2);
    expect(timer).not.toContain('人間への問い 0');
    expect(timer).not.toContain('届いた出来事 0');
    expect(timer).not.toContain('記憶の根拠');
    await s.clone.stop();
  });

  it('⭐ 自発の tick には、今までどおり要約の全体が付く', async () => {
    const s = boot();
    await seed(s.stores);

    const self = await selfTick(s);

    expect(self).toContain('## マネージャー');
    expect(self).toContain('担当 7 の途中経過');
    expect(self).toContain('## 人間の回答待ち');
    expect(self).toContain('人間への問い 0');
    expect(self).toContain('## 届いた外部イベント');
    expect(self).not.toContain('- 回答待ち 4 /');
    // 発意の tick には待ち行列の先頭（先頭の3件＋案内）が付く。4件目は件数の断りだけ
    expect(self).toContain('## 待ち行列の先頭');
    expect(self).toContain(QUEUE_COUNT_LINE);
    for (const i of [0, 1, 2]) expect(self).toContain(`- task-${i}（`);
    expect(self).not.toContain('- task-3（');
    expect(self).toContain('- …ほか 1 件（task_list で全部見える）');
    expect(self).toContain('先頭が先にやるもの');
    await s.clone.stop();
  });
});

// 定期の tick（件数の形）の固定の説明文（#5392）。全文は全文一致で固定し、省略形（REF）は出ないことを見る。
const COUNTS_TOOLS_NOTE_FULL =
  '（#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— ' +
  '待ち行列は `task_list`、回答待ちは `approvals_list`、' +
  '決めたこと・エスカレーション・記憶の更新・外部イベントは `journal_read`、使った分は `usage_read`）';
const COUNTS_TOOLS_NOTE_REF =
  '（#4938: 件数だけの節の引き口は会話の上と同じ。`task_list`・`approvals_list`・`journal_read`・`usage_read`）';
const IDLE_MANAGERS_NOTE_FULL =
  '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。';
const IDLE_MANAGERS_NOTE_REF =
  '依頼と直近の報告は載せていない。引き口は `manager_list` / `manager_report`（会話の上と同じ）。';
const COUNTS_LINE =
  '- 回答待ち 4 / エスカレーション 0 / 聞かずに決めたこと 6 / 記憶の更新 0' +
  ' / 外部イベント 20 / 人間からの発言 0';
// 待ち行列の件数の1行（#5469 P6b）。件数の形は先頭の描画を出さない
const QUEUE_COUNT_LINE = '- 待ち行列: 開いている 4 件（queued 4 / waiting 0 / needs_decision 0）';

async function seedIdleManager(stores: Stores): Promise<void> {
  const now = new Date().toISOString();
  await stores.jobs.putJob({
    id: 'mgr-done',
    createdAt: now,
    updatedAt: now,
    status: 'done',
    summary: '終わった担当',
    request: '終わった担当の依頼',
    lastReport: '終わった担当の報告',
  });
}

function expectCountsFull(text: string): void {
  expect(text).toContain(COUNTS_TOOLS_NOTE_FULL);
  expect(text).toContain(IDLE_MANAGERS_NOTE_FULL);
  expect(text).not.toContain(COUNTS_TOOLS_NOTE_REF);
  expect(text).not.toContain(IDLE_MANAGERS_NOTE_REF);
}

// 定期の tick の「継続中の依頼」の行は、前回の入力と1字も違わなくても、同じ会話の2回目以降も毎回全文で出す（1行の参照にまとめない）
const STANDING_FOLD_HEAD = '件は、この会話で最後に全文で出した版と1字も変わっていない: ';
const EXTRA_KINDS = ['extra-a', 'extra-b', 'extra-c'] as const;

async function putStanding(stores: Stores, kind: string, request: string): Promise<void> {
  await stores.schedules.put({
    kind,
    spec: { type: 'daily', at: '10:00' },
    request,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
}

async function seedExtraStanding(stores: Stores): Promise<void> {
  for (const kind of EXTRA_KINDS) {
    await putStanding(stores, kind, `${kind} の依頼。${'説明が続く。'.repeat(20)}`);
  }
}

/** 行が全文で載っているか（kind の行の頭は `- <kind>（`）。 */
function hasStandingRow(text: string, kind: string): boolean {
  return text.includes(`\n- ${kind}（`);
}

function expectAllStandingRowsFull(text: string): void {
  for (const kind of [TIMER_KIND, ...EXTRA_KINDS]) expect(hasStandingRow(text, kind)).toBe(true);
  expect(text).not.toContain(STANDING_FOLD_HEAD);
}

// 自発の tick の件数の行の項目名（固定ラベル）も、2回目以降に参照の形（これ）にならず毎回全文で出る。数字は毎回出る
const COUNTS_LABEL_REF_HEAD = '- 件数（項目は会話の上の件数の行と同じ。載せていない項目は 0）: ';

function countsLineOf(text: string): string {
  return text.split('\n').find((line) => line.startsWith('- 件数')) ?? '';
}

// 2回目以降も毎回全文になる（既定の全文を固定する）。
describe('tick・報告の包みの固定文は、2回目以降も毎回全文のまま', () => {
  const OFF_ENVS = [['未設定', {}]] as const;

  it.each(OFF_ENVS)(
    '⭐ 定期の tick（%s）: 依頼の本文・固定の指示・件数の形の固定の注記・継続中の依頼の行が毎回全文',
    async (_name, env) => {
      const s = boot({ env });
      await seed(s.stores);
      await seedIdleManager(s.stores);
      await seedExtraStanding(s.stores);

      const first = await timerTick(s);
      const second = await timerTick(s);
      const third = await timerTick(s);

      expectCountsFull(first);
      for (const text of [first, second, third]) {
        // 依頼の本文（requestSeenAt）と固定の指示（fixed）
        expect(text).toContain(REQUEST_BODY.trim());
        expect(text).toContain(INSTRUCTION_HEAD);
        expect(text).not.toContain(INSTRUCTION_REF);
        expect(text).not.toMatch(/依頼の本文は前回/u);
        // 件数の形の固定の注記（#5392）
        expectCountsFull(text);
        expect(text).not.toContain(COUNTS_TOOLS_NOTE_REF);
        expect(text).not.toContain(IDLE_MANAGERS_NOTE_REF);
        // 継続中の依頼の行（1行の参照にまとめない）
        expectAllStandingRowsFull(text);
      }
      // 2回目の字数も1回目と同じ形（前回との差が出るのは「前回動いた時刻」の行だけ）
      expect(second.length).toBeGreaterThanOrEqual(first.length - 20);
      await s.clone.stop();
    },
  );

  it.each(OFF_ENVS)(
    '⭐ 自発の tick（%s）: 固定の指示・変わらない節・件数の行の項目名が毎回全文',
    async (_name, env) => {
      const s = boot({ env });
      await seed(s.stores);

      const first = await selfTick(s);
      const second = await selfTick(s);
      const third = await selfTick(s);

      for (const text of [first, second, third]) {
        expect(text).toContain(SELF_INSTRUCTION_HEAD);
        expect(text).not.toContain(INSTRUCTION_REF);
        expectCompleteFull(text);
        expect(text).toContain('担当 7 の途中経過');
        expect(text).toContain('聞かずに決めたこと 0');
        expect(text).not.toContain(UNCHANGED_SECTION);
        expect(text).not.toMatch(/変わらない節:/u);
        expect(text).toContain('この件数は届いた合図の実数ではない');
        const line = countsLineOf(text);
        expect(line).toContain('- 件数: 人間の発言 0 / 回答待ち 4 / ');
        expect(line.startsWith(COUNTS_LABEL_REF_HEAD)).toBe(false);
      }
      await s.clone.stop();
    },
  );

  it.each(OFF_ENVS)('⭐ 担当の報告の包み（%s）: 応じ方の案内が毎回全文', async (_name, env) => {
    const s = boot({ env });
    const report = async (managerId: string, text: string): Promise<string> => {
      const before = s.inputs.length;
      eventSeq += 1;
      s.clone.post({
        type: 'manager_message',
        id: `evt-report-off-${eventSeq}`,
        at: new Date().toISOString(),
        managerId,
        kind: 'report',
        text,
      });
      await waitFor(() => s.inputs.length > before, `報告の入力 ${before + 1} 本目`);
      return s.inputs[before] ?? '';
    };

    const first = await report('mgr-a', '1件目の報告の本文');
    const second = await report('mgr-b', '2件目の報告の本文');
    const third = await report('mgr-c', '3件目の報告の本文');

    for (const text of [first, second, third]) {
      expect(text).toContain(REPORT_FOLLOW_UP_GUIDE);
    }
    await s.clone.stop();
  });
});

// ALTEROID_TOKEN_SAVING_EXCERPT: Clone は要約を組むとき trimHistory をこの系統から渡す（切ると、履歴の節の件数の上限が節約の前の形に戻る）
// 以前は「この期間に片付けた仕事」の節の件数（5 / 8）で測っていた。その節は #5469 P6b で無くなったので、同じ trimHistory が効く履歴の節（外部イベントの本文の形。DIGEST_BODY_SHAPE_LIMIT = 5 / MAX_ITEMS）で測る
describe('抜粋の系統（ALTEROID_TOKEN_SAVING_EXCERPT）は、自発の tick の要約の履歴の節の件数に効く', () => {
  async function bodyShapeShown(env: NodeJS.ProcessEnv): Promise<number> {
    const s = boot({ env });
    for (let i = 0; i < 8; i += 1) {
      await s.stores.journal.append({
        type: 'external_event',
        source: `lim-src-${i}`,
        summary: `上限の出来事 ${i}`,
      });
    }
    const text = await selfTick(s);
    await s.clone.stop();
    return Array.from({ length: 8 }, (_, i) => i).filter((i) =>
      text.includes(`- lim-src-${i}: 同じ本文は`),
    ).length;
  }

  it('⭐ 既定（入り）は 5 件、切り（0）は 8 件すべてが出る', async () => {
    expect(await bodyShapeShown({})).toBe(5);
    expect(await bodyShapeShown({ ALTEROID_TOKEN_SAVING_EXCERPT: '0' })).toBe(8);
    expect(await bodyShapeShown({ ALTEROID_TOKEN_SAVING_EXCERPT: 'off' })).toBe(8);
  });
});
