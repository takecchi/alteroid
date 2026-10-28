import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_REDELIVER,
  createClone,
  REPORT_FOLLOW_UP_GUIDE,
  REPORT_FOLLOW_UP_GUIDE_REF,
} from './clone.js';
import type { AgentCloneDriver } from './agent-clone-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { waitFor } from './clone-test-harness.js';
import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import type { CloneHost } from './host.js';
import { SOURCE_TALLY_HEADING } from './digest.js';
import { DigestSessionDelta, LEAN_EXTERNAL_TALLY_REF } from './digest-session-delta.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// #4937: tick の要約を、同じ会話の中では前回からの差分にする

const TIMER_KIND = 'issue-round';
const REQUEST_BODY = `open issue を見て、着手できるものから進める。${'依頼の本文の長い説明。'.repeat(40)}`;
const COMPLETELY_FULL_MARK = '本文はこうなっている。';
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
  /** 文脈の使用状況を出せない駆動役（`providesContextUsage: false`）で開く。 */
  unavailableDriver?: boolean;
  /** n 番目（1始まり）の入力を、成功ではなく失敗の result で終える。 */
  failResultAt?: number;
  /** 入力の受け付けが終わった後、この Promise が解けるまで出来事の列を閉じない（作り直しの窓を開けておく）。 */
  holdAfterInputEnd?: Promise<void>;
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
  for (let i = 0; i < 14; i += 1) {
    await stores.commitments.open({
      id: `cm-${i}`,
      at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      origin: 'human',
      body: `引き受けた仕事 ${i}。${'本文が続く。'.repeat(20)}`,
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
  // 文脈の使用状況を出せない駆動役（Codex 相当。`providesContextUsage: false`）: 最初の1回は error、2回目以降は観測が無い（null）
  const inner = new ClaudeCloneDriver({ queryFn: fn });
  const unavailableDriver: AgentCloneDriver = {
    providerId: 'claude',
    providesContextUsage: false,
    open: (spec) => {
      const session = inner.open(spec);
      return {
        readEvents: (onEvent) => session.readEvents(onEvent),
        interrupt: () => session.interrupt(),
        close: () => session.close(),
        contextUsage: () => Promise.reject(new Error('取れない')),
        sessionModelUsage: () => session.sessionModelUsage(),
      };
    },
  };
  const clone = createClone({
    stores,
    ...(script.unavailableDriver === true ? { driver: unavailableDriver } : { queryFn: fn }),
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
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

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

async function seedSettledAndMemory(stores: Stores): Promise<void> {
  // 片付けた時刻が要約の窓（直近）に入るよう、いまの時刻にする
  const at = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    await stores.commitments.open({
      id: `done-${i}`,
      at,
      origin: 'human',
      body: `片付けた仕事 ${i}`,
    });
    await stores.commitments.close(`done-${i}`, at, `理由 ${i}`, 'clone');
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      summary: `記憶の更新の要旨 ${i}`,
    });
  }
}

/** 完全な全文: 省いた節の参照が無く、発行元別の件数・使った分も載っている。 */
function expectCompleteFull(text: string): void {
  expect(text).not.toContain('この節は省いた');
  expect(text).toContain('## 使った分');
  expect(text).toContain('発行元（source）別の件数');
}

/** 軽い全文（案 A）の形: 判断の節は全文、省く節は引き口を名指しした1行の参照。 */
function expectLeanFull(text: string, options: { withSettledAndMemory?: boolean } = {}): void {
  // 残す
  expect(text).toContain('## 引き受けたまま終わっていない仕事');
  expect(text).toContain('引き受けた仕事 0');
  expect(text).toContain('## 人間の回答待ち');
  expect(text).toContain('人間への問い 0');
  expect(text).toContain('## 聞かずに決めたこと');
  expect(text).toContain('聞かずに決めたこと 0');
  expect(text).toContain('担当 7 の途中経過');
  expect(text).toContain('## 届いた外部イベント');
  expect(text).toContain('届いた出来事 19');
  // 先頭の件数行は節の外で、省いた節の件数も残る
  expect(text).toContain('外部イベント（日誌の行数）20');
  expect(text).toMatch(/片付けた仕事 \d+ \//);
  // 省く
  expect(text).toContain('## 使った分\n（この節は省いた。`usage_read` で引ける）');
  expect(text).toContain(
    '（発行元別の件数と本文の形は省いた。`journal_read` に types=["external_event"]',
  );
  expect(text).not.toContain('発行元（source）別の件数');
  expect(text).not.toContain('本文の形（保持した');
  if (options.withSettledAndMemory === true) {
    expect(text).toContain(
      '## この期間に片付けた仕事\n（この節は省いた。`commitment_list` に includeClosed=true',
    );
    expect(text).toContain(
      '## 記憶の更新\n（この節は省いた。`journal_read` に types=["memory_update"]',
    );
    expect(text).not.toContain('片付けた仕事 0');
    expect(text).not.toContain('記憶の更新の要旨 0');
  }
}

describe('tick の要約は、同じ会話の中では前回からの差分になる（#4937）', () => {
  it('⭐ 2回目は、変わらない節が1行に縮み、依頼の本文と固定の文言は短い参照になる。本文の合計が大きく減る', async () => {
    const s = boot();
    await seed(s.stores);

    // 2026-10-16 #4938 の案2で形を変えた（2026-10-18 に案2の中身を「担当の節と継続中の依頼の節だけ出す」へ直した）:
    // 定期の tick は要約の全体を持たなくなったので、要約の差分は自発の tick で見る。
    // 以前は定期の tick 2回（first / second）で、下の要約の節の期待値（'## 届いた外部イベント'・'担当 7 の途中経過'・件数の行・固定の注記）も見ていた
    const firstTimer = await timerTick(s);
    const secondTimer = await timerTick(s);
    // 依頼の本文・固定の指示は、定期の tick の側で今までどおり参照になる
    expect(firstTimer).toContain(COMPLETELY_FULL_MARK);
    expect(firstTimer).toContain(REQUEST_BODY.trim());
    expect(firstTimer).toContain(INSTRUCTION_HEAD);
    expect(secondTimer).not.toContain(REQUEST_BODY.trim());
    expect(secondTimer).toMatch(/依頼の本文は前回（\d\d:\d\dZ）の発火と同じ。会話の上にある/u);
    expect(secondTimer).not.toContain(INSTRUCTION_HEAD);
    expect(secondTimer).toContain(INSTRUCTION_REF);

    const first = await selfTick(s);
    const second = await selfTick(s);

    // 1回目は全文
    expect(first).toContain(SELF_INSTRUCTION_HEAD);
    expect(first).toContain('## 届いた外部イベント');
    expect(first).toContain('担当 7 の途中経過');
    // 2回目: 固定の指示・変わらない節は参照
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(second).toContain(INSTRUCTION_REF);
    expect(second).not.toContain('担当 7 の途中経過');
    // 節の名前は1行にまとめた参照に残る（節の件数の行はまえがきに残る）
    expect(second).toMatch(/変わらない節: .*届いた外部イベント/u);
    expect(second).toContain('外部イベント（日誌の行数）20 /');
    expect(second).toContain('未了の仕事 14');
    // 固定の注記は1回だけ全文
    expect(first).toContain('この件数は届いた合図の実数ではない');
    expect(second).not.toContain('この件数は届いた合図の実数ではない');

    process.stderr.write(
      `[#4937 測定] 1回目 ${first.length} 字 → 2回目 ${second.length} 字 ` +
        `（${Math.round((1 - second.length / first.length) * 100)}% 減）\n`,
    );
    expect(second.length).toBeLessThan(first.length * 0.4);
    await s.clone.stop();
  });

  it('⭐ 2回の間に担当が1本増える・回答待ちが1件片付くと、その行だけが出る（材料は落ちない）', async () => {
    const s = boot();
    await seed(s.stores);

    await selfTick(s);
    const now = new Date().toISOString();
    await s.stores.jobs.putJob({
      id: 'mgr-new-one',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '新しい担当',
      request: '新しい担当の依頼',
      lastReport: '新しい担当の最初の報告',
    });
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: now,
      question: '片付いた問い',
      answeredAt: now,
      answer: 'はい',
    });
    const second = await selfTick(s);

    expect(second).toContain('mgr-new-one');
    expect(second).toContain('新しい担当の最初の報告');
    // 変わっていない担当・回答待ちの行は出さない
    expect(second).not.toContain('担当 3 の途中経過');
    expect(second).not.toContain('人間への問い 0');
    // 回答待ちは件数が減っている（まえがき）・残りは「変わっていない」と数えて名乗る
    expect(second).toContain('回答待ち 3 /');
    expect(second).toMatch(/ほかの 3 件は前回/u);
    // 発意の固定の指示も参照になる
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(second).toContain(INSTRUCTION_REF);
    await s.clone.stop();
  });

  it('依頼の本文が変わったときは、その回だけ全文で出す', async () => {
    const s = boot();
    await seed(s.stores);

    await timerTick(s);
    await s.stores.schedules.put({
      kind: TIMER_KIND,
      spec: { type: 'daily', at: '09:00' },
      request: '依頼を書き換えた。新しい本文',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    const second = await timerTick(s);

    expect(second).toContain('依頼を書き換えた。新しい本文');
    expect(second).not.toMatch(/依頼の本文は前回/u);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの tick は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 要約の差分は自発の tick にだけ掛かるので、自発の tick で見る。
    // 以前は timerTick の3回で、third に REQUEST_BODY と INSTRUCTION_HEAD を期待していた（定期の側は下の別の試験へ移した）
    const first = await selfTick(s);
    const second = await selfTick(s);
    const third = await selfTick(s);

    expect(second).not.toContain('担当 7 の途中経過');
    expect(third).toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    expect(third).not.toContain(UNCHANGED_SECTION);
    // 要約が走った理由の全文は判断の節だけの軽い全文: 判断の節は全文、省く節は1行の参照（案 A）
    expectLeanFull(third);
    // 要約の部分（「期間:」以降）は、完全な全文より短い
    const digestOf = (text: string): string => text.slice(text.indexOf('期間:'));
    process.stderr.write(
      `[案A 測定] 要約の部分 完全な全文 ${digestOf(first).length} 字 → 軽い全文 ${digestOf(third).length} 字\n`,
    );
    expect(digestOf(third).length).toBeLessThan(digestOf(first).length);
    await s.clone.stop();
  });

  it('⭐ 軽い全文の次の回は、省いた節を「前と同じ」と畳まず全文で出す（差分の整合）', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);
    await seedSettledAndMemory(s.stores);

    const full = await selfTick(s);
    await selfTick(s);
    const lean = await selfTick(s);
    const next = await selfTick(s);

    expectLeanFull(lean, { withSettledAndMemory: true });
    const digestOf = (text: string): string => text.slice(text.indexOf('期間:'));
    process.stderr.write(
      `[案A 測定2] 要約の部分 完全な全文 ${digestOf(full).length} 字 → 軽い全文 ${digestOf(lean).length} 字\n`,
    );
    // 参照先の無い畳みを出さない: 省いた節は全文で出る
    expect(next).toContain('片付けた仕事 0');
    expect(next).toContain('記憶の更新の要旨 0');
    expect(next).toContain('## 使った分');
    expect(next).not.toContain('この節は省いた');
    expect(next).toContain('発行元（source）別の件数');
    expect(next).toContain('本文の形');
    // 軽い全文で全文を出した節は、通常どおり畳まれる
    expect(next).not.toContain('担当 7 の途中経過');
    expect(next).not.toContain('聞かずに決めたこと 0');
    expect(next).toMatch(/前回（\d\d:\d\dZ）の要約から変わっていない/u);
    expect(next).not.toContain(SELF_INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 軽い全文を挟んでも、その次の回までに起きた変化は漏れない（省いた節の新しい行も出る）', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);
    await seedSettledAndMemory(s.stores);

    await selfTick(s);
    await selfTick(s);
    await selfTick(s);
    await s.stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      summary: '軽い全文のあとに増えた更新',
    });
    const next = await selfTick(s);
    expect(next).toContain('軽い全文のあとに増えた更新');
    expect(next).toContain('記憶の更新の要旨 0');
    await s.clone.stop();
  });

  it('⭐ 定期の tick も、自動の要約が走ったあとは依頼の本文と固定の指示を全文へ戻す（#4938 で要約の側を自発の tick へ移した分の残り）', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).not.toContain(REQUEST_BODY.trim());
    expect(second).not.toContain(INSTRUCTION_HEAD);
    expect(third).toContain(REQUEST_BODY.trim());
    expect(third).toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる tick（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の3回で REQUEST_BODY の有無を見ていた
    await selfTick(s);
    const second = await selfTick(s);
    const third = await selfTick(s);

    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    expectLeanFull(third);
    await s.clone.stop();
  });

  it('閾値まで遠い tick は、全文へ戻さない', async () => {
    const s = boot({ contextTotals: [50_000, 60_000, 70_000] });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の3回で REQUEST_BODY が無いことを見ていた
    await selfTick(s);
    await selfTick(s);
    const third = await selfTick(s);

    expect(third).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(third).not.toContain('担当 7 の途中経過');
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの tick は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の3回で REQUEST_BODY の有無を見ていた
    await selfTick(s);
    const second = await selfTick(s);
    const third = await selfTick(s);

    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    // 会話が変わった回は、会話の上に何も残らないので完全な全文（軽い全文にしない）
    expectCompleteFull(third);
    await s.clone.stop();
  });

  it('⭐ PreCompact のあとの tick は全文へ戻る', async () => {
    // PreCompact は要約が走る直前の合図: フックを直接叩く（フックの引き方は clone-summary-reindex-and-tail.test.ts と同じ）
    const hooked = bootWithHooks();
    await seed(hooked.stores);
    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の3回で REQUEST_BODY の有無を見ていた
    await selfTick(hooked);
    const second = await selfTick(hooked);
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    await hooked.fire();
    const afterPreCompact = await selfTick(hooked);
    expect(afterPreCompact).toContain(SELF_INSTRUCTION_HEAD);
    expect(afterPreCompact).toContain('担当 7 の途中経過');
    expectLeanFull(afterPreCompact);
    await hooked.clone.stop();
  });

  it('⭐ 入力を SDK へ押し込めなかった回（起動の失敗）では、差分の記録が進まない', async () => {
    const s = boot({ failFirstStarts: 1 });
    await seed(s.stores);

    // 1回目の tick は起動に失敗して入力が入らない。ここで記録が進んでいたら、次に入る入力は差分になってしまう
    eventSeq += 1;
    s.clone.post({
      type: 'self_initiative',
      id: `evt-self-${eventSeq}`,
      at: new Date().toISOString(),
      reason: '起動に失敗する tick',
    });
    // 要約は組まれた（日誌に入力の行が残る）が、入力は SDK へ入らなかった
    await waitFor(async () => {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.some((row) => row.text.startsWith('ターンの入力: self_initiative'));
    }, '失敗する tick の入力の行');
    expect(s.inputs).toEqual([]);
    const first = await selfTick(s);
    // 最初に実際に入った入力は全文でなければならない
    expect(first).toContain(SELF_INSTRUCTION_HEAD);
    expect(first).toContain('担当 7 の途中経過');
    expect(first).not.toContain(UNCHANGED_SECTION);
    expectCompleteFull(first);
    await s.clone.stop();
  });

  it('⭐ 入力を閉じて作り直しを待っている窓で tick が来ると、新しい会話への入力は全文になる（#4941）', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = boot({ holdAfterInputEnd: hold });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timer の3回（3本目も timer を post）で REQUEST_BODY・INSTRUCTION_HEAD を見ていた
    await selfTick(s);
    const second = await selfTick(s);
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);

    // 人間の操作で開き直す: 入力は閉じるが、古い会話の終わり（`query` を下ろす）は hold が解けるまで来ない
    await s.clone.reopenSession?.({ distill: false, actor: 'human', reason: '試験' });
    await waitFor(() => s.inputEnded(), '入力が閉じる');

    const before = s.inputs.length;
    eventSeq += 1;
    s.clone.post({
      type: 'self_initiative',
      id: `evt-self-${eventSeq}`,
      at: new Date().toISOString(),
      reason: '窓の中の tick',
    });
    // 要約が組まれる（日誌に入力の行が残る）まで、古い会話の終わりを待たせる: 先に解くと、組む前に query が下りて窓が閉じてしまう
    await waitFor(async () => {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.filter((row) => row.text.startsWith('ターンの入力: self_initiative')).length >= 3;
    }, '窓の中で組まれた3本目の入力の行');
    release();
    await waitFor(() => s.inputs.length > before, '新しい会話の最初の入力');
    const third = s.inputs[before] ?? '';

    expect(third).toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    expect(third).not.toContain(UNCHANGED_SECTION);
    expectCompleteFull(third);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない（null の）回の tick は全文（#4941）', async () => {
    const s = boot({ noUsage: true });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の2回で REQUEST_BODY を見ていた
    await selfTick(s);
    const second = await selfTick(s);

    expect(second).toContain(SELF_INSTRUCTION_HEAD);
    expect(second).toContain('担当 7 の途中経過');
    expect(second).not.toContain(UNCHANGED_SECTION);
    // 要約が走るかどうか確かめられない回は、軽い全文にせず完全な全文へ倒す
    expectCompleteFull(second);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の tick は全文。成功したターンの次は差分のまま（#4941）', async () => {
    const s = boot({ failResultAt: 2 });
    await seed(s.stores);

    // 2026-10-16 #4938 の案2: 自発の tick で見る。以前は timerTick の4回で REQUEST_BODY の有無を見ていた
    await selfTick(s);
    // 2回目は差分で入るが、そのターンは失敗で終わる
    const second = await selfTick(s);
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    const third = await selfTick(s);
    // 3回目は全文
    expect(third).toContain(SELF_INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    expect(third).not.toContain(UNCHANGED_SECTION);
    expectCompleteFull(third);
    // 3回目は成功したので、4回目は今までどおり差分
    const fourth = await selfTick(s);
    expect(fourth).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(fourth).not.toContain('担当 7 の途中経過');
    await s.clone.stop();
  });

  describe('全文へ戻した理由が日誌に1行残る（畳めた割合を本番で数えるための観測）', () => {
    const RESET_LINE = '固定文を全文へ戻す';

    async function resetLines(s: Boot): Promise<string[]> {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.map((row) => row.text).filter((text) => text.includes(RESET_LINE));
    }

    // 日誌への書き込みは待たない（void）: 書かれていないことを確かめる前に少し待つ
    // 実時間の待ちを増やさない（#2146）: メモリ上の日誌への書き込みは、イベントループを数周回せば済む
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const line = (reason: string): string =>
      `${EXCHANGE_KIND_DECISION_PREFIX}${RESET_LINE}: 理由=${reason}`;

    it('使用量を返さない駆動役: 最初の全文は書かず、観測が無くなった回に usage_null の1行が出る', async () => {
      const s = boot({ unavailableDriver: true });
      await seed(s.stores);
      await selfTick(s);
      await settle();
      expect(await resetLines(s)).toEqual([]);
      // 2回目: 1回目の観測は error（usage_error）
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 1, 'usage_error の行');
      // 3回目: 以後は観測が無い（null）
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 2, 'usage_null の行');
      const lines = await resetLines(s);
      // 並びは見ない（日誌の書き込みは待たないため、同じ時刻の行の並びが揺れうる）
      expect([...lines].sort()).toEqual([line('usage_error'), line('usage_null')].sort());
      await s.clone.stop();
    });

    it('使用量の取得に失敗する回（getContextUsage が無い）は usage_error の1行', async () => {
      const s = boot({ noUsage: true });
      await seed(s.stores);
      await selfTick(s);
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 1, 'usage_error の行');
      await settle();
      expect(await resetLines(s)).toEqual([line('usage_error')]);
      // 測った字数（`[判断] ` つきの journal の text 全体）
      expect((await resetLines(s))[0]?.length).toBe(30);
      expect(line('usage_threshold_missing').length).toBe(42); // 最長のラベル
      await s.clone.stop();
    });

    it('使用量が取れて閾値の手前なら畳まれ、行は出ない', async () => {
      const s = boot({ contextTotals: [50_000, 60_000, 70_000] });
      await seed(s.stores);
      await selfTick(s);
      await selfTick(s);
      await selfTick(s);
      await settle();
      expect(await resetLines(s)).toEqual([]);
      await s.clone.stop();
    });

    it('閾値に届く見込みの回は compaction_likely の1行', async () => {
      const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
      await seed(s.stores);
      await selfTick(s);
      await selfTick(s);
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 1, 'compaction_likely の行');
      await settle();
      expect(await resetLines(s)).toEqual([line('compaction_likely')]);
      await s.clone.stop();
    });

    it('失敗したターンの次に turn_failed の1行が出る', async () => {
      const s = boot({ failResultAt: 2 });
      await seed(s.stores);
      await selfTick(s);
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 1, 'turn_failed の行');
      await selfTick(s);
      await settle();
      expect(await resetLines(s)).toEqual([line('turn_failed')]);
      await s.clone.stop();
    });

    it('同じターンに複数の理由が重なっても1行だけ（先頭で usage_error、失敗後の turn_failed は書かない）', async () => {
      const s = boot({ noUsage: true, failResultAt: 2 });
      await seed(s.stores);
      await selfTick(s);
      await selfTick(s);
      await waitFor(async () => (await resetLines(s)).length >= 1, 'usage_error の行');
      await settle();
      expect(await resetLines(s)).toEqual([line('usage_error')]);
      await s.clone.stop();
    });
  });

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
    expect(timer).toContain(
      '- 引き受けた仕事 14 / 回答待ち 4 / エスカレーション 0 / 聞かずに決めたこと 6 / 記憶の更新 0' +
        ' / 外部イベント 20 / 片付けた仕事 0 / 人間からの発言 0',
    );
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
    expect(self).not.toContain('- 引き受けた仕事 14 / 回答待ち 4 /');
    await s.clone.stop();
  });

  it('⭐ 定期の tick を挟んでも、自発の tick の差分の基準は前の自発の tick のまま（定期の形で上書きされない）', async () => {
    const s = boot();
    await seed(s.stores);

    await selfTick(s);
    const now = new Date().toISOString();
    await s.stores.jobs.putJob({
      id: 'mgr-between',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '間に増えた担当',
      request: '間に増えた担当の依頼',
      lastReport: '間に増えた担当の最初の報告',
    });
    const timer = await timerTick(s);
    const second = await selfTick(s);

    expect(timer).toContain('mgr-between');
    // 差分のまま（全文に戻っていない）: 前の自発の tick と変わらない担当の行は出ない
    expect(second).not.toContain('担当 7 の途中経過');
    expect(second).not.toContain(SELF_INSTRUCTION_HEAD);
    // 基準は前の自発の tick: 間に増えた担当は、定期の tick を挟んでも新しい行として出る
    expect(second).toContain('mgr-between');
    expect(second).toContain('間に増えた担当の最初の報告');
    await s.clone.stop();
  });
});

// 定期の tick（件数の形）の固定の説明文（#5392）。全文と参照は全文一致で固定する
const COUNTS_TOOLS_NOTE_FULL =
  '（#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— ' +
  '引き受けた仕事は `commitment_list`、回答待ちは `approvals_list`、' +
  '決めたこと・エスカレーション・記憶の更新・外部イベントは `journal_read`、使った分は `usage_read`）';
const COUNTS_TOOLS_NOTE_REF =
  '（#4938: 件数だけの節の引き口は会話の上と同じ。`commitment_list`・`approvals_list`・`journal_read`・`usage_read`）';
const IDLE_MANAGERS_NOTE_FULL =
  '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。';
const IDLE_MANAGERS_NOTE_REF =
  '依頼と直近の報告は載せていない。引き口は `manager_list` / `manager_report`（会話の上と同じ）。';
const COUNTS_LINE =
  '- 引き受けた仕事 14 / 回答待ち 4 / エスカレーション 0 / 聞かずに決めたこと 6 / 記憶の更新 0' +
  ' / 外部イベント 20 / 片付けた仕事 0 / 人間からの発言 0';
const IDLE_LINE = '- 手が止まっている担当（done・stopped）1 本: mgr-done';

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

describe('定期の tick（件数の形）の固定の説明文は、同じ会話の2回目から参照になる（#5392）', () => {
  it('⭐ 1回目は全文、2回目以降は参照になる。件数と行（可変部）は毎回出る', async () => {
    const s = boot();
    await seed(s.stores);
    await seedIdleManager(s.stores);

    const first = await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expectCountsFull(first);
    for (const text of [second, third]) {
      expect(text).toContain(COUNTS_TOOLS_NOTE_REF);
      expect(text).toContain(IDLE_MANAGERS_NOTE_REF);
      expect(text).not.toContain(COUNTS_TOOLS_NOTE_FULL);
      expect(text).not.toContain(IDLE_MANAGERS_NOTE_FULL);
    }
    for (const text of [first, second, third]) {
      expect(text).toContain(COUNTS_LINE);
      expect(text).toContain(IDLE_LINE);
    }
    expect(second.length).toBeLessThan(first.length);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの tick は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);
    await seedIdleManager(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).toContain(COUNTS_TOOLS_NOTE_REF);
    expectCountsFull(third);
    expect(third).toContain(COUNTS_LINE);
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの tick は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });
    await seed(s.stores);
    await seedIdleManager(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).toContain(COUNTS_TOOLS_NOTE_REF);
    expectCountsFull(third);
    await s.clone.stop();
  });

  it('⭐ 入力を SDK へ押し込めなかった回（起動の失敗）では控えが進まず、次も全文', async () => {
    const s = boot({ failFirstStarts: 1 });
    await seed(s.stores);
    await seedIdleManager(s.stores);

    // 1回目は起動に失敗して入力が入らない。2回目が会話の最初の入力になる
    s.clone.post({
      type: 'timer',
      id: 'evt-timer-fail',
      at: new Date().toISOString(),
      kind: TIMER_KIND,
      cause: 'manual',
    });
    await waitFor(async () => {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.some((row) => row.text.startsWith('ターンの入力: timer'));
    }, '失敗する tick の入力の行');
    expect(s.inputs).toEqual([]);
    const first = await timerTick(s);
    const second = await timerTick(s);

    expectCountsFull(first);
    expect(second).toContain(COUNTS_TOOLS_NOTE_REF);
    await s.clone.stop();
  });

  it('⭐ 自発の tick は変わらない: 要約の全体のまま、件数の形の参照は出ず、定期の tick を挟んでも差分の基準は動かない', async () => {
    const s = boot();
    await seed(s.stores);
    await seedIdleManager(s.stores);

    const firstSelf = await selfTick(s);
    await timerTick(s);
    await timerTick(s);
    const secondSelf = await selfTick(s);

    for (const text of [firstSelf, secondSelf]) {
      expect(text).not.toContain(COUNTS_TOOLS_NOTE_FULL);
      expect(text).not.toContain(COUNTS_TOOLS_NOTE_REF);
      expect(text).not.toContain(IDLE_MANAGERS_NOTE_REF);
    }
    // 要約の全体の側の文言は変わらない（1回目の自発の tick は全文）
    expect(firstSelf).toContain(IDLE_MANAGERS_NOTE_FULL);
    // 基準は前の自発の tick のまま: 変わらない担当の行は出ない
    expect(secondSelf).not.toContain('担当 7 の途中経過');
    await s.clone.stop();
  });
});

// 定期の tick の「継続中の依頼」の行は、前回の入力と1字も違わなければ、同じ会話の2回目から1行の参照にまとめる
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

/** 畳んだ行の kind の並び。畳んだ行が無ければ空。 */
function foldedStandingKinds(text: string): string[] {
  const line = text.split('\n').find((row) => row.includes(STANDING_FOLD_HEAD));
  if (line === undefined) return [];
  const after = line.slice(line.indexOf(STANDING_FOLD_HEAD) + STANDING_FOLD_HEAD.length);
  return after.slice(0, after.indexOf('。')).split('・');
}

function expectAllStandingRowsFull(text: string): void {
  for (const kind of [TIMER_KIND, ...EXTRA_KINDS]) expect(hasStandingRow(text, kind)).toBe(true);
  expect(text).not.toContain(STANDING_FOLD_HEAD);
}

describe('定期の tick の継続中の依頼の行は、前回から変わらなければ同じ会話の2回目から畳む', () => {
  it('⭐ 1回目は全行が全文。2回目は変わらない行が1行にまとまり（件数と kind と引き直しの道具つき）、動いた行だけ全文', async () => {
    const s = boot();
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    const first = await timerTick(s);
    const second = await timerTick(s);

    expectAllStandingRowsFull(first);
    // 動かした依頼の行は「前回動いた時刻」が進むので全文のまま
    expect(hasStandingRow(second, TIMER_KIND)).toBe(true);
    for (const kind of EXTRA_KINDS) expect(hasStandingRow(second, kind)).toBe(false);
    expect(foldedStandingKinds(second)).toEqual([...EXTRA_KINDS]);
    expect(second).toContain(
      `継続中の依頼 ${String(EXTRA_KINDS.length)} 件は、この会話で最後に全文で出した版と1字も`,
    );
    expect(second).toContain('引き直しは `schedule_list`');
    expect(second.length).toBeLessThan(first.length);
    await s.clone.stop();
  });

  it('⭐ 1行だけ変わると、その行だけが全文で出る（ほかは畳んだまま）', async () => {
    const s = boot();
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    await timerTick(s);
    await putStanding(s.stores, 'extra-b', 'extra-b の依頼が書き換わった。');
    const second = await timerTick(s);

    expect(hasStandingRow(second, 'extra-b')).toBe(true);
    expect(second).toContain('extra-b の依頼が書き換わった。');
    expect(foldedStandingKinds(second)).toEqual(['extra-a', 'extra-c']);
    await s.clone.stop();
  });

  it('⭐ ⚠ を含む行は、前回と同じでも毎回全文', async () => {
    const s = boot();
    await seed(s.stores);
    await seedExtraStanding(s.stores);
    await putStanding(s.stores, 'extra-b', '⚠️ 枠が閉じていたら動かさない。');

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    for (const text of [second, third]) {
      expect(hasStandingRow(text, 'extra-b')).toBe(true);
      expect(foldedStandingKinds(text)).toEqual(['extra-a', 'extra-c']);
    }
    await s.clone.stop();
  });

  it('⭐ 前回の入力に全文で出していない行（間に増えた依頼）は「前回と同じ」と言わず全文で出し、その次から畳む', async () => {
    const s = boot();
    await seed(s.stores);
    await putStanding(s.stores, 'extra-a', 'extra-a の依頼。');

    await timerTick(s);
    await putStanding(s.stores, 'extra-b', 'extra-b の依頼。');
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(hasStandingRow(second, 'extra-b')).toBe(true);
    expect(foldedStandingKinds(second)).toEqual(['extra-a']);
    expect(foldedStandingKinds(third)).toEqual(['extra-a', 'extra-b']);
    await s.clone.stop();
  });

  it('⭐ 定期 A → 自発 B → 定期 A: 自発の tick で別の版が全文で出たあと、A に戻った行を「前回と同じ」と畳まない', async () => {
    const s = boot();
    await seed(s.stores);
    await seedExtraStanding(s.stores);
    const original = `extra-a の依頼。${'説明が続く。'.repeat(20)}`;

    const first = await timerTick(s);
    expect(hasStandingRow(first, 'extra-a')).toBe(true);
    await putStanding(s.stores, 'extra-a', 'extra-a は B に書き換わった。');
    const self = await selfTick(s);
    expect(self).toContain('extra-a は B に書き換わった。');
    await putStanding(s.stores, 'extra-a', original);
    const third = await timerTick(s);

    expect(hasStandingRow(third, 'extra-a')).toBe(true);
    expect(third).toContain(original);
    expect(foldedStandingKinds(third)).toEqual(['extra-b', 'extra-c']);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの tick は全行が全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(foldedStandingKinds(second)).toEqual([...EXTRA_KINDS]);
    expectAllStandingRowsFull(third);
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの tick は全行が全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(foldedStandingKinds(second)).toEqual([...EXTRA_KINDS]);
    expectAllStandingRowsFull(third);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の tick は全行が全文。成功したターンの次は畳んだまま', async () => {
    const s = boot({ failResultAt: 2 });
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);
    const fourth = await timerTick(s);

    expect(foldedStandingKinds(second)).toEqual([...EXTRA_KINDS]);
    expectAllStandingRowsFull(third);
    expect(foldedStandingKinds(fourth)).toEqual([...EXTRA_KINDS]);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない回の tick は、毎回全行が全文', async () => {
    const s = boot({ noUsage: true });
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    await timerTick(s);
    const second = await timerTick(s);

    expectAllStandingRowsFull(second);
    await s.clone.stop();
  });

  it('⭐ 入力を SDK へ押し込めなかった回（起動の失敗）では控えが進まず、次も全行が全文', async () => {
    const s = boot({ failFirstStarts: 1 });
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    s.clone.post({
      type: 'timer',
      id: 'evt-timer-fail-standing',
      at: new Date().toISOString(),
      kind: TIMER_KIND,
      cause: 'manual',
    });
    await waitFor(async () => {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.some((row) => row.text.startsWith('ターンの入力: timer'));
    }, '失敗する tick の入力の行');
    const first = await timerTick(s);
    const second = await timerTick(s);

    expectAllStandingRowsFull(first);
    expect(foldedStandingKinds(second)).toEqual([...EXTRA_KINDS]);
    await s.clone.stop();
  });

  it('⭐ 畳みが続いても、20ターンごとの全文戻し（forgetFixed）で全行が全文へ戻る', async () => {
    const s = boot();
    await seed(s.stores);
    await seedExtraStanding(s.stores);

    const texts: string[] = [];
    for (let i = 0; i < 24; i += 1) texts.push(await timerTick(s));

    // 全文へ戻る回が、24回の中に2回目以降でも在る（周期の保険）
    const refullIndex = texts.findIndex((text, i) => i > 0 && !text.includes(STANDING_FOLD_HEAD));
    expect(refullIndex).toBeGreaterThan(1);
    expect(refullIndex).toBeLessThanOrEqual(21);
    expectAllStandingRowsFull(texts[refullIndex] ?? '');
    for (let i = 1; i < refullIndex; i += 1) {
      expect(foldedStandingKinds(texts[i] ?? '')).toEqual([...EXTRA_KINDS]);
    }
    await s.clone.stop();
  });
});

describe('DigestSessionDelta.foldStandingRows（単体）', () => {
  const row = (kind: string, last = '（まだ一度も動いていない）', request = `${kind} の依頼`) =>
    `- ${kind}（毎日 09:00）${request}\n  前回動いた時刻: ${last}`;
  const digestOf = (rows: string[], tail: string[] = []) =>
    [
      '期間: x',
      '',
      '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
      ...rows,
      ...tail,
      '',
      '- 件数',
    ].join('\n');

  it('全行が前回と同じなら、2回目は全行が1行にまとまる。全文の行は出ない', () => {
    const delta = new DigestSessionDelta();
    const digest = digestOf([row('a'), row('b')]);
    expect(delta.foldStandingRows(digest)).toBe(digest);
    delta.commit();
    const folded = delta.foldStandingRows(digest);
    expect(folded).not.toContain('- a（');
    expect(folded).toContain(
      '継続中の依頼 2 件は、この会話で最後に全文で出した版と1字も変わっていない: a・b。',
    );
    expect(folded).toContain('## 継続中の依頼');
    expect(folded.endsWith('\n\n- 件数')).toBe(true);
  });

  it('commit しなければ控えは進まない（押し込めなかった回の次は全文）', () => {
    const delta = new DigestSessionDelta();
    const digest = digestOf([row('a')]);
    delta.foldStandingRows(digest);
    delta.discardStaged();
    expect(delta.foldStandingRows(digest)).toBe(digest);
  });

  it('A→B→A と変わったとき、2回前の A を「前回と同じ」と言わない', () => {
    const delta = new DigestSessionDelta();
    const a = digestOf([row('a', '1')]);
    const b = digestOf([row('a', '2')]);
    delta.foldStandingRows(a);
    delta.commit();
    expect(delta.foldStandingRows(b)).toBe(b);
    delta.commit();
    expect(delta.foldStandingRows(a)).toBe(a);
  });

  it('自発の tick（renderDigest）で同じ kind の別の版が全文で出たら、控えの古い版を畳まない', () => {
    const delta = new DigestSessionDelta();
    const a = digestOf([row('a', '1'), row('b', '1')]);
    const b = digestOf([row('a', '1', 'a は別の版'), row('b', '1')]);
    delta.foldStandingRows(a);
    delta.commit();
    delta.renderDigest(b, new Date('2026-10-28T00:00:00.000Z'));
    delta.commit();
    const folded = delta.foldStandingRows(a);
    expect(folded).toContain('- a（');
    expect(folded).not.toContain('- b（');
    expect(folded).toContain('継続中の依頼 1 件は、');
  });

  it('reset（full・compaction とも）と forgetFixed の後は全文', () => {
    const digest = digestOf([row('a')]);
    for (const clear of [
      (d: DigestSessionDelta) => d.reset('full'),
      (d: DigestSessionDelta) => d.reset('compaction'),
      (d: DigestSessionDelta) => d.forgetFixed(),
    ]) {
      const delta = new DigestSessionDelta();
      delta.foldStandingRows(digest);
      delta.commit();
      clear(delta);
      expect(delta.foldStandingRows(digest)).toBe(digest);
    }
  });

  it('読めない行の注記・「…ほか N 件」・⚠ の行は、同じでも常に全文', () => {
    const delta = new DigestSessionDelta();
    const digest = digestOf(
      [row('a'), row('warn', '（まだ一度も動いていない）', '⚠️ 注意')],
      ['- …ほか 3 件（`schedule_list` で全部見える）', '- 読めない継続中の依頼の注記'],
    );
    delta.foldStandingRows(digest);
    delta.commit();
    const folded = delta.foldStandingRows(digest);
    expect(folded).toContain('- warn（');
    expect(folded).toContain('- …ほか 3 件');
    expect(folded).toContain('- 読めない継続中の依頼の注記');
    expect(folded).not.toContain('- a（');
  });

  it('継続中の依頼の節が無い要約は、そのまま返す', () => {
    const delta = new DigestSessionDelta();
    expect(delta.foldStandingRows('期間: x\n\n## マネージャー\n- m')).toBe(
      '期間: x\n\n## マネージャー\n- m',
    );
  });
});

// 自発の tick の件数の行の項目名（固定ラベル）は、同じ会話の2回目から参照になる。数字は毎回出る
const COUNTS_LABEL_REF_HEAD = '- 件数（項目は会話の上の件数の行と同じ。載せていない項目は 0）: ';

function countsLineOf(text: string): string {
  return text.split('\n').find((line) => line.startsWith('- 件数')) ?? '';
}

describe('自発の tick の件数の行は、同じ会話の2回目から項目名が参照になる', () => {
  it('⭐ 1回目は全文、2回目以降は 0 でない項目だけ名前つきで出る（数字は毎回出る）', async () => {
    const s = boot();
    await seed(s.stores);

    const first = await selfTick(s);
    const second = await selfTick(s);
    const third = await selfTick(s);

    const full = countsLineOf(first);
    expect(full).toContain('- 件数: 人間の発言 0 / 回答待ち 4 / ');
    expect(full).toContain('外部イベント（日誌の行数）20');
    for (const text of [second, third]) {
      const line = countsLineOf(text);
      expect(line.startsWith(COUNTS_LABEL_REF_HEAD)).toBe(true);
      expect(line).toContain('回答待ち 4');
      expect(line).toContain('外部イベント（日誌の行数）20');
      expect(line).not.toContain('人間の発言');
      expect(line).not.toContain('エスカレーション');
      expect(line.length).toBeLessThan(full.length);
    }
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの tick は件数の行も全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await seed(s.stores);

    await selfTick(s);
    const second = await selfTick(s);
    const third = await selfTick(s);

    expect(countsLineOf(second).startsWith(COUNTS_LABEL_REF_HEAD)).toBe(true);
    expect(countsLineOf(third).startsWith('- 件数: 人間の発言 0 / ')).toBe(true);
    await s.clone.stop();
  });
});

function bootWithHooks(): Boot & { fire: () => Promise<void> } {
  const captured: { options: Options | undefined } = { options: undefined };
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    captured.options ??= params.options;
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
      // 使用量の観測が取れない回は全文に戻す（#4941）ので、差分になる側を見るために閾値から遠い観測を返す
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
  const stores = createMemoryStores();
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return {
    clone,
    stores,
    inputs,
    inputEnded: () => false,
    fire: async () => {
      const hook = captured.options?.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      // transcript_path を渡さない: 退避と蒸留を飛ばして、印を立てるところまでだけを通す
      await hook({ session_id: 'sess-fake' } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    },
  };
}

describe('DigestSessionDelta（単体）', () => {
  const at = new Date('2026-10-16T12:34:00.000Z');
  const digest = [
    '期間: x',
    '',
    '## マネージャー（走行中・返事待ちから先に出す）',
    '- a [running] 仕事A',
    '  直近の報告: ひとつ目',
    '- b [running] 仕事B',
    '- …ほか 3 件（`manager_list` で状態を見る）',
    '',
    '## 使った分',
    '- 合計: $1',
  ].join('\n');

  it('控えは commit するまで進まない（押し込めなかった回は、次も全文）', () => {
    const delta = new DigestSessionDelta();
    expect(delta.renderDigest(digest, at).text).toBe(digest);
    // commit しない → 次も全文
    expect(delta.renderDigest(digest, at).text).toBe(digest);
    delta.commit();
    delta.renderDigest(digest, at);
    delta.commit();
    const third = delta.renderDigest(digest, at).text;
    expect(third).toContain(
      '（前回（12:34Z）の要約から変わらない節: マネージャー・使った分。各節の全文は会話の上にある）',
    );
    expect(third).not.toContain('仕事A');
  });

  it('discardStaged は控えへ移さず捨てる / reset は確定済みも消す', () => {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digest, at);
    delta.discardStaged();
    delta.commit();
    expect(delta.renderDigest(digest, at).text).toBe(digest);
    delta.commit();
    delta.reset();
    expect(delta.renderDigest(digest, at).text).toBe(digest);
  });

  it('一覧の節は、前回と1字も違わない行だけを省き、件数の行（…ほか N 件）は常に出す', () => {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digest, at);
    delta.commit();
    const changed = digest.replace('- b [running] 仕事B', '- b [done] 仕事B');
    const out = delta.renderDigest(changed, at).text;
    expect(out).toContain('- b [done] 仕事B');
    expect(out).not.toContain('仕事A');
    expect(out).toContain('ほかの 1 件は前回（12:34Z）から変わっていない');
    expect(out).toContain('- …ほか 3 件');
  });

  it('一覧でない節（使った分）は、変わっていれば全文のまま出す', () => {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digest, at);
    delta.commit();
    const out = delta.renderDigest(digest.replace('$1', '$2'), at).text;
    expect(out).toContain('- 合計: $2');
  });

  describe('件数の行の項目名の参照', () => {
    const counts = (values: number[]): string =>
      `- 件数: ${[
        `人間の発言 ${values[0]}`,
        `回答待ち ${values[1]}`,
        `エスカレーション ${values[2]}`,
        `委譲（この期間に動いた）${values[3]} 本`,
        `自分で決めたこと ${values[4]}`,
        `記憶の更新 ${values[5]}`,
        `外部イベント（日誌の行数）${values[6]}`,
        `委譲側のツール実行 ${values[7]}`,
        `自分の手（委譲せず使った道具）${values[8]}`,
        `継続中の依頼 ${values[9]}`,
        `未了の仕事 ${values[10]}`,
        `片付けた仕事 ${values[11]}`,
        `読めない未了の行 ${values[12]}`,
        `物理削除された片付き行（累計）${values[13]}`,
      ].join(' / ')}`;
    const withCounts = (line: string): string =>
      ['期間: x', line, '', '## 使った分', '- 合計: $1'].join('\n');

    it('⭐ 2回目は 0 でない項目だけ名前つき。全部 0 なら「すべて 0」。commit 前は全文のまま', () => {
      const delta = new DigestSessionDelta();
      const first = counts([0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0]);
      expect(delta.renderDigest(withCounts(first), at).text).toContain(first);
      // commit しない → 次も全文
      expect(delta.renderDigest(withCounts(first), at).text).toContain(first);
      delta.commit();
      const second = delta.renderDigest(
        withCounts(counts([0, 5, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0])),
        at,
      ).text;
      expect(second).toContain(
        '- 件数（項目は会話の上の件数の行と同じ。載せていない項目は 0）: 回答待ち 5 / 委譲（この期間に動いた）1 本 / 未了の仕事 3',
      );
      expect(second).not.toContain('人間の発言');
      delta.commit();
      const zero = delta.renderDigest(withCounts(counts(Array(14).fill(0) as number[])), at).text;
      expect(zero).toContain('- 件数: すべて 0（項目は会話の上の件数の行と同じ）');
    });

    it('形が想定と違う件数の行は、畳まず全文のまま', () => {
      const delta = new DigestSessionDelta();
      delta.renderDigest(withCounts(counts(Array(14).fill(0) as number[])), at);
      delta.commit();
      const odd = '- 件数: 人間の発言 0 / 回答待ち x';
      expect(delta.renderDigest(withCounts(odd), at).text).toContain(odd);
    });

    it('reset のあとは全文へ戻る', () => {
      const delta = new DigestSessionDelta();
      const line = counts(Array(14).fill(0) as number[]);
      delta.renderDigest(withCounts(line), at);
      delta.commit();
      delta.reset();
      expect(delta.renderDigest(withCounts(line), at).text).toContain(line);
    });
  });

  describe('2節以上が同時に前回と同じなら、参照を1行にまとめる（#5393）', () => {
    const ledger = ['## 引き受けたまま終わっていない仕事（自分の台帳）', '- c1 仕事C', ''];
    const sameDigest = [
      '期間: x',
      '',
      ...ledger,
      '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
      '- timer 毎朝',
      '',
      '## マネージャー（走行中・返事待ちから先に出す）',
      '- a [running] 仕事A',
      '',
      '## 使った分',
      '- 合計: $1',
    ].join('\n');

    it('⭐ 同じ節が3つ（台帳を除く）なら、節の名前を残した1行にまとまり、台帳は節ごとの参照のまま。出力は全文一致', () => {
      const delta = new DigestSessionDelta();
      expect(delta.renderDigest(sameDigest, at).text).toBe(sameDigest);
      delta.commit();
      expect(delta.renderDigest(sameDigest, at).text).toBe(
        [
          '期間: x',
          '',
          '## 引き受けたまま終わっていない仕事（自分の台帳）',
          '（前回（12:34Z）の要約から変わっていない。全文は会話の上にある）',
          '',
          '（前回（12:34Z）の要約から変わらない節: 継続中の依頼・マネージャー・使った分。各節の全文は会話の上にある）',
          '',
        ].join('\n'),
      );
    });

    it('⭐ 同じ節が1つだけの回は、従来どおり節ごとの参照のまま', () => {
      const delta = new DigestSessionDelta();
      delta.renderDigest(sameDigest, at);
      delta.commit();
      const out = delta.renderDigest(
        sameDigest.replace('- 合計: $1', '- 合計: $2').replace('仕事A', '仕事Z'),
        at,
      ).text;
      expect(out).not.toContain('変わらない節');
      expect(out).toContain(
        '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）\n（前回（12:34Z）の要約から変わっていない。全文は会話の上にある）',
      );
      expect(out).toContain('- 合計: $2');
    });

    it('⭐ 変わった節は全文・差分のまま出て、同じ節だけが1行にまとまる', () => {
      const delta = new DigestSessionDelta();
      delta.renderDigest(sameDigest, at);
      delta.commit();
      const out = delta.renderDigest(sameDigest.replace('- 合計: $1', '- 合計: $2'), at).text;
      expect(out).toContain('変わらない節: 継続中の依頼・マネージャー。');
      expect(out).toContain('## 使った分\n- 合計: $2');
      expect(out).not.toContain('仕事A');
    });

    it('⭐ 要約後（reset）の回は全文', () => {
      const delta = new DigestSessionDelta();
      delta.renderDigest(sameDigest, at);
      delta.commit();
      delta.reset();
      expect(delta.renderDigest(sameDigest, at).text).toBe(sameDigest);
    });
  });
});

describe('DigestSessionDelta（軽い全文。要約が走りうる／走った理由に限る）', () => {
  const at = new Date('2026-10-16T12:34:00.000Z');
  const digest = [
    '期間: x',
    '',
    '- この期間に片付けた仕事: 1 件',
    '',
    '## マネージャー（走行中・返事待ちから先に出す）',
    '- a [running] 仕事A',
    '',
    '## この期間に片付けた仕事',
    '- 片付いた仕事X',
    '',
    '## 聞かずに決めたこと',
    '- 決めたことY',
    '',
    '## 記憶の更新',
    '- 更新Z',
    '',
    '## 使った分',
    '- 合計: $1',
  ].join('\n');

  // 確定した全文が1回ある状態から、要約が走った理由の reset を受ける
  function afterFirstFull(): DigestSessionDelta {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digest, at);
    delta.commit();
    return delta;
  }

  it('⭐ 要約が走った理由の reset の次は、判断の節は全文・省く節は引き口つきの1行になる', () => {
    const delta = afterFirstFull();
    delta.reset('compaction');
    expect(delta.isLean()).toBe(true);
    const out = delta.renderDigest(digest, at).text;
    expect(out).toContain('- この期間に片付けた仕事: 1 件');
    expect(out).toContain('- a [running] 仕事A');
    expect(out).toContain('- 決めたことY');
    expect(out).not.toContain('片付いた仕事X');
    expect(out).not.toContain('更新Z');
    expect(out).not.toContain('合計: $1');
    expect(out).toContain(
      '## この期間に片付けた仕事\n（この節は省いた。`commitment_list` に includeClosed=true',
    );
    expect(out).toContain(
      '## 記憶の更新\n（この節は省いた。`journal_read` に types=["memory_update"]',
    );
    expect(out).toContain('## 使った分\n（この節は省いた。`usage_read` で引ける）');
  });

  it('⭐ 軽い全文の次の回は、省いた節を畳まず全文で出し、出した節だけを畳む', () => {
    const delta = afterFirstFull();
    delta.reset('compaction');
    delta.renderDigest(digest, at);
    delta.commit();
    expect(delta.isLean()).toBe(false);
    const next = delta.renderDigest(digest, at).text;
    expect(next).toContain('片付いた仕事X');
    expect(next).toContain('更新Z');
    expect(next).toContain('合計: $1');
    expect(next).not.toContain('この節は省いた');
    // 軽い全文で全文を出した節は畳まれる
    expect(next).not.toContain('決めたことY');
    expect(next).toContain(
      '（前回（12:34Z）の要約から変わらない節: マネージャー・聞かずに決めたこと。各節の全文は会話の上にある）',
    );
  });

  it('⭐ 完全な全文へ倒す理由の reset（既定）は、軽い全文にしない。先に full があれば、後の compaction でも倒れたまま', () => {
    const plain = afterFirstFull();
    plain.reset();
    expect(plain.isLean()).toBe(false);
    expect(plain.renderDigest(digest, at).text).toBe(digest);

    const mixed = afterFirstFull();
    mixed.reset('full');
    mixed.reset('compaction');
    expect(mixed.isLean()).toBe(false);
    expect(mixed.renderDigest(digest, at).text).toBe(digest);

    const reversed = afterFirstFull();
    reversed.reset('compaction');
    reversed.reset('full');
    expect(reversed.isLean()).toBe(false);
    expect(reversed.renderDigest(digest, at).text).toBe(digest);
  });

  it('⭐ 起動直後（確定した全文が無い）は、要約の理由の reset があっても完全な全文', () => {
    const delta = new DigestSessionDelta();
    delta.reset('compaction');
    expect(delta.isLean()).toBe(false);
    expect(delta.renderDigest(digest, at).text).toBe(digest);
  });

  it('入力が入らなかった回（commit しない）では、軽い全文のままで、完全な全文へも進まない', () => {
    const delta = afterFirstFull();
    delta.reset('compaction');
    delta.renderDigest(digest, at);
    delta.discardStaged();
    expect(delta.isLean()).toBe(true);
    expect(delta.renderDigest(digest, at).text).toContain('この節は省いた');
  });

  it('外部イベントの節は、件名の一覧と固定の注記を残し、発行元別の件数・本文の形だけを省く（節ごと控えへ入れない）', () => {
    const external = [
      '期間: x',
      '',
      '## 届いた外部イベント',
      '- ci: ビルドが落ちた',
      '',
      SOURCE_TALLY_HEADING,
      '- ci: 1 件',
      '',
      '**本文の形（保持した 1 件の標本。上の件数とは母数が違う）** —— 注記',
      '- ci: 同じ本文は 1 種。最も多い1種が 1 件',
    ].join('\n');
    const delta = afterFirstFull();
    delta.reset('compaction');
    const out = delta.renderDigest(external, at).text;
    expect(out).toContain('- ci: ビルドが落ちた');
    expect(out).toContain(LEAN_EXTERNAL_TALLY_REF);
    expect(out).not.toContain('- ci: 1 件');
    expect(out).not.toContain('本文の形（保持した');
    delta.commit();
    const next = delta.renderDigest(external, at).text;
    expect(next).toContain('- ci: 1 件');
    expect(next).toContain('本文の形（保持した');
    expect(next).not.toContain(LEAN_EXTERNAL_TALLY_REF);
  });
});

// 報告の包みの固定の文言（応じ方の案内）も、同じ会話の2回目から参照にする。本文は畳まない
describe('担当の報告の包みの固定の文言は、同じ会話の中では2回目から参照になる', () => {
  async function report(s: Boot, managerId: string, text: string): Promise<string> {
    const before = s.inputs.length;
    eventSeq += 1;
    s.clone.post({
      type: 'manager_message',
      id: `evt-report-${eventSeq}`,
      at: new Date().toISOString(),
      managerId,
      kind: 'report',
      text,
    });
    await waitFor(() => s.inputs.length > before, `報告の入力 ${before + 1} 本目`);
    return s.inputs[before] ?? '';
  }

  it('⭐ 1件目は案内の全文、2件目は短い参照になる。報告の本文はどちらも全文', async () => {
    const s = boot();

    const first = await report(s, 'mgr-a', '1件目の報告の本文');
    const second = await report(s, 'mgr-b', '2件目の報告の本文');

    expect(first).toContain('1件目の報告の本文');
    expect(first).toContain(REPORT_FOLLOW_UP_GUIDE);
    expect(second).toContain('2件目の報告の本文');
    expect(second).not.toContain(REPORT_FOLLOW_UP_GUIDE);
    expect(second).toContain(REPORT_FOLLOW_UP_GUIDE_REF);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの報告は、案内を全文へ戻す', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });

    await report(s, 'mgr-a', '1件目');
    const second = await report(s, 'mgr-b', '2件目');
    const third = await report(s, 'mgr-c', '3件目');

    expect(second).toContain(REPORT_FOLLOW_UP_GUIDE_REF);
    expect(third).toContain(REPORT_FOLLOW_UP_GUIDE);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない回は、毎回全文（安全側）', async () => {
    const s = boot({ noUsage: true });

    await report(s, 'mgr-a', '1件目');
    const second = await report(s, 'mgr-b', '2件目');

    expect(second).toContain(REPORT_FOLLOW_UP_GUIDE);
    await s.clone.stop();
  });
});
