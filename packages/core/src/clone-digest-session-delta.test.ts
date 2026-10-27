import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_REDELIVER,
  createClone,
  REPORT_FOLLOW_UP_GUIDE,
  REPORT_FOLLOW_UP_GUIDE_REF,
} from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { DigestSessionDelta } from './digest-session-delta.js';
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
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
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
    // 見出しは残る（節の件数の行はまえがきに残る）
    expect(second).toContain('## 届いた外部イベント');
    expect(second).toContain('外部イベント（日誌の行数）20 /');
    expect(second).toContain('未了の仕事 14 /');
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
    expect(third.length).toBeGreaterThan(first.length * 0.9);
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
    // 3回目は成功したので、4回目は今までどおり差分
    const fourth = await selfTick(s);
    expect(fourth).not.toContain(SELF_INSTRUCTION_HEAD);
    expect(fourth).not.toContain('担当 7 の途中経過');
    await s.clone.stop();
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
    expect(third).toContain('前回（12:34Z）の要約から変わっていない');
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
