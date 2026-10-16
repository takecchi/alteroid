import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
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
}

interface SdkScript {
  /** n 番目（1始まり）の入力を受けたあとで、結果の前に流す出来事。 */
  after?: (inputCount: number) => SDKMessage[];
  /** ターンの終わりに測る文脈の量。 */
  contextTotals?: readonly number[];
  /** 起動そのものを失敗させる回数（先頭から）。 */
  failFirstStarts?: number;
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
      ...(script.contextTotals === undefined
        ? {}
        : {
            getContextUsage: async () => {
              const totals = script.contextTotals ?? [];
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
  return { clone, stores, inputs };
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

    const first = await timerTick(s);
    const second = await timerTick(s);

    // 1回目は全文
    expect(first).toContain(COMPLETELY_FULL_MARK);
    expect(first).toContain(REQUEST_BODY.trim());
    expect(first).toContain(INSTRUCTION_HEAD);
    expect(first).toContain('## 届いた外部イベント');
    expect(first).toContain('担当 7 の途中経過');
    // 2回目: 依頼の本文・固定の指示・変わらない節は参照
    expect(second).not.toContain(REQUEST_BODY.trim());
    expect(second).toMatch(/依頼の本文は前回（\d\d:\d\dZ）の発火と同じ。会話の上にある/u);
    expect(second).not.toContain(INSTRUCTION_HEAD);
    expect(second).toContain(INSTRUCTION_REF);
    expect(second).not.toContain('担当 7 の途中経過');
    // 見出しは残る（節の件数の行はまえがきに残る）
    expect(second).toContain('## 届いた外部イベント');
    expect(second).toContain('- 外部イベント（日誌 external_event の行数）: 20 件');
    expect(second).toContain('- 引き受けたまま終わっていない仕事: 14 件');
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
    expect(second).toContain('- いま人間の回答を待っているもの: 3 件');
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

    const first = await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).not.toContain('担当 7 の途中経過');
    expect(third).toContain(REQUEST_BODY.trim());
    expect(third).toContain(INSTRUCTION_HEAD);
    expect(third).toContain('担当 7 の途中経過');
    expect(third).not.toContain(UNCHANGED_SECTION);
    expect(third.length).toBeGreaterThan(first.length * 0.9);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる tick（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await seed(s.stores);

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).not.toContain(REQUEST_BODY.trim());
    expect(third).toContain(REQUEST_BODY.trim());
    expect(third).toContain('担当 7 の途中経過');
    await s.clone.stop();
  });

  it('閾値まで遠い tick は、全文へ戻さない', async () => {
    const s = boot({ contextTotals: [50_000, 60_000, 70_000] });
    await seed(s.stores);

    await timerTick(s);
    await timerTick(s);
    const third = await timerTick(s);

    expect(third).not.toContain(REQUEST_BODY.trim());
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

    await timerTick(s);
    const second = await timerTick(s);
    const third = await timerTick(s);

    expect(second).not.toContain(REQUEST_BODY.trim());
    expect(third).toContain(REQUEST_BODY.trim());
    expect(third).toContain('担当 7 の途中経過');
    await s.clone.stop();
  });

  it('⭐ PreCompact のあとの tick は全文へ戻る', async () => {
    // PreCompact は要約が走る直前の合図: フックを直接叩く（フックの引き方は clone-summary-reindex-and-tail.test.ts と同じ）
    const hooked = bootWithHooks();
    await seed(hooked.stores);
    await timerTick(hooked);
    const second = await timerTick(hooked);
    expect(second).not.toContain(REQUEST_BODY.trim());
    await hooked.fire();
    const afterPreCompact = await timerTick(hooked);
    expect(afterPreCompact).toContain(REQUEST_BODY.trim());
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
