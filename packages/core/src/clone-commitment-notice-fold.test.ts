import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5297: 断り書きの骨組みの文を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。
// #5469 P6c: 骨組みは「待ち行列の先頭・task として積んだ・全文と並べ替え」に替わった（旧: 台帳の件数・commitment_close・commitment_list）。
// 台帳の閉じ方の骨組み（回答 human_answer のターンにだけ出る）は下の別の describe が同じ畳みを確かめる。

const SKELETON = '返事をしたターンの終わりに自動で done になる';
const TAIL_FULL = '全文は `task_list`。並べ替えは `task_move`。';
const QUEUE_HEAD = '[system] 待ち行列（';
const CLOSE_SKELETON = '返事をしただけでは閉じない';
const BUNDLE_SKELETON = '閉じるのは id ごとである';

interface SdkScript {
  contextTotals?: readonly number[];
  noUsage?: boolean;
  failResultAt?: number;
  /** n 番目（1始まり）の入力の結果を、この Promise が解けるまで返さない（次の入力を束ねさせるため）。 */
  holdResultAt?: Readonly<Record<number, Promise<void>>>;
  after?: (inputCount: number) => SDKMessage[];
  // クローンの env。既定は畳みを有効にした env（本番の既定は無効: `ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT`）
  env?: NodeJS.ProcessEnv;
}

interface Boot {
  clone: CloneHost;
  inputs: string[];
}

function boot(script: SdkScript = {}, stores = createMemoryStores()): Boot {
  const inputs: string[] = [];
  let usageIndex = 0;
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
        for (const extra of script.after?.(inputs.length) ?? []) yield extra;
        await script.holdResultAt?.[inputs.length];
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
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      ...(script.noUsage === true
        ? {}
        : {
            getContextUsage: async () => {
              const totals = script.contextTotals ?? [10_000];
              const totalTokens = totals[Math.min(usageIndex, totals.length - 1)] ?? 0;
              usageIndex += 1;
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
  const clone = createClone({
    stores,
    queryFn: fn,
    env: script.env ?? TOKEN_SAVING_ENABLED_ENV,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs };
}

let seq = 0;

/** 1回の入力として届く人間の発言を1つ投げ、その入力を返す。 */
async function humanTurn(s: Boot): Promise<{ input: string; id: string }> {
  const before = s.inputs.length;
  seq += 1;
  const event = humanMessage(`発言${String(seq)}`);
  s.clone.post(event);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return { input: s.inputs[before] ?? '', id: event.id };
}

/** 断り書きの節（待ち行列の見出し〜次の区切り `---` の手前）だけを取り出す。 */
function ledgerLines(input: string): string {
  const lines = input.split('\n');
  const start = lines.findIndex((line) => line.startsWith(QUEUE_HEAD));
  expect(start, '待ち行列の見出しが入力に無い').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line === '---');
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** 骨組みの文の行だけ（「task として積んだ」の行と末尾の行）。畳みで短くなるのはここ。件数と先頭は毎回全文なので含めない。 */
function skeletonLines(input: string): string {
  return ledgerLines(input)
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('いま届いたこの') ||
        line.startsWith('全文は `task_list`') ||
        line.startsWith('（`task_list`'),
    )
    .join('\n');
}

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

describe('台帳の2行は、同じ会話の2回目から骨組みが参照になる（#5297）', () => {
  it('⭐ 初回は全文。2回目以降は短い形になり、字数が減る（件数・最古の時刻・この一件の id は毎回出る）', async () => {
    const s = boot();
    const first = await humanTurn(s);
    const second = await humanTurn(s);
    const third = await humanTurn(s);

    // 初回は全文の骨組み
    const firstLines = ledgerLines(first.input);
    expect(firstLines).toContain(
      '- 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）',
    );
    expect(firstLines).toContain(`いま届いたこの一件は task \`${first.id}\` として積んだ。`);
    expect(firstLines).toContain(SKELETON);
    expect(firstLines).toContain('`task_keep`');
    expect(firstLines).toContain('`manager_start` に `taskId`');
    expect(firstLines).toContain(TAIL_FULL);

    // 2回目以降は骨組みだけが参照になる。件数は新しい値、先頭の行・この一件の id は毎回出る
    for (const [turn, count] of [
      [second, 2],
      [third, 3],
    ] as const) {
      const lines = ledgerLines(turn.input);
      expect(lines).toContain(`- 待ち行列: 開いている ${String(count)} 件（`);
      expect(lines).toContain(`- ${turn.id}（状態: queued`);
      expect(lines).toContain(`いま届いたこの一件は task \`${turn.id}\` として積んだ。`);
      // 道具の名前は参照にも残る
      expect(lines).toContain('`task_keep`');
      expect(lines).toContain('`manager_start`');
      expect(lines).toContain('`task_list`');
      expect(lines).toContain('`task_move`');
      expect(lines).not.toContain(SKELETON);
      expect(lines).not.toContain(TAIL_FULL);
      expect(skeletonLines(turn.input).length).toBeLessThan(
        skeletonLines(first.input).length * 0.8,
      );
    }

    process.stderr.write(
      `[#5297 測定] 骨組みの行 1回目 ${String(skeletonLines(first.input).length)} 字 → 2回目 ${String(skeletonLines(second.input).length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 畳みが切り（既定）なら、台帳の2行も末尾の固定文も2回目以降も全文のまま', async () => {
    const s = boot({ env: {} });
    const first = await humanTurn(s);
    const second = await humanTurn(s);
    const third = await humanTurn(s);

    for (const turn of [first, second, third]) {
      const lines = ledgerLines(turn.input);
      expect(lines).toContain(SKELETON);
      expect(lines).toContain(`いま届いたこの一件は task \`${turn.id}\` として積んだ。`);
      expect(lines).toContain(TAIL_FULL);
      expect(turn.input).not.toContain('会話の上と同じ');
    }
    await s.clone.stop();
  });

  it('⭐ 2回目の参照は短く保たれ、指し先の道具は残る（毎ターン載るため）', async () => {
    const s = boot();
    await humanTurn(s);
    const second = await humanTurn(s);

    const refLines = second.input.split('\n').filter((line) => line.includes('会話の上と同じ'));
    // 参照は2行だけ: 「task として積んだ」の行の末尾と、末尾の1行
    expect(refLines).toHaveLength(2);
    expect(refLines.join('\n')).toContain('`task_keep`');
    expect(refLines.join('\n')).toContain('`manager_start`');
    expect(refLines.join('\n')).toContain('`task_list`');
    expect(refLines.join('\n')).toContain('`task_move`');
    const tailRef = refLines.find((line) => line.startsWith('（'));
    expect(tailRef?.length).toBeLessThanOrEqual(40);
    await s.clone.stop();
  });

  it('⭐ 人間操作の節の末尾段落: 1回目は全文・同じ会話の2回目は参照（操作の内容は毎回出る）・要約の後は全文', async () => {
    const stores = createMemoryStores();
    const s = boot({ after: (n) => (n === 4 ? [compactBoundary] : []) }, stores);
    const act = (target: string) =>
      stores.journal.append({
        type: 'decision',
        decision: `${target} を人間が操作した`,
        grounds: 'API',
        humanAction: {
          kind: 'practice_remove',
          target,
          via: { kind: 'operator', auth: 'operator-token' },
        },
      });
    const FULL = '経路は監査の記録であって、人間がした証拠ではない';
    const REF = '読み方は会話の上と同じ';
    await humanTurn(s);
    await act('way-a');
    const second = await humanTurn(s);
    await act('way-b');
    const third = await humanTurn(s);
    await act('way-c');
    const fourth = await humanTurn(s);
    await act('way-d');
    const fifth = await humanTurn(s);

    expect(second.input).toContain(FULL);
    expect(second.input).toContain('やり方を消した: way-a');
    expect(third.input).not.toContain(FULL);
    expect(third.input).toContain(REF);
    expect(third.input).toContain('やり方を消した: way-b');
    expect(fourth.input).toContain(REF);
    expect(fourth.input).toContain('やり方を消した: way-c');
    // compact_boundary は4本目の入力の処理中に届く: 5本目は全文へ戻る
    expect(fifth.input).toContain(FULL);
    expect(fifth.input).toContain('やり方を消した: way-d');
    const paragraph = (input: string): string =>
      input.split('\n').find((line) => line.includes(FULL) || line.includes(REF)) ?? '';
    process.stderr.write(
      `[人間操作の末尾段落 測定] 全文 ${String(paragraph(second.input).length)} 字 → 参照 ${String(paragraph(third.input).length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 畳みが切り（既定）なら、人間操作の節の末尾段落も毎回全文', async () => {
    const stores = createMemoryStores();
    const s = boot({ env: {} }, stores);
    const act = (target: string) =>
      stores.journal.append({
        type: 'decision',
        decision: `${target} を人間が操作した`,
        grounds: 'API',
        humanAction: {
          kind: 'practice_remove',
          target,
          via: { kind: 'operator', auth: 'operator-token' },
        },
      });
    const FULL = '経路は監査の記録であって、人間がした証拠ではない';
    await humanTurn(s);
    await act('way-a');
    const second = await humanTurn(s);
    await act('way-b');
    const third = await humanTurn(s);
    await act('way-c');
    const fourth = await humanTurn(s);

    for (const [turn, target] of [
      [second, 'way-a'],
      [third, 'way-b'],
      [fourth, 'way-c'],
    ] as const) {
      expect(turn.input).toContain(FULL);
      expect(turn.input).toContain(`やり方を消した: ${target}`);
      expect(turn.input).not.toContain('読み方は会話の上と同じ');
    }
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの入力は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await humanTurn(s);
    const second = await humanTurn(s);
    const third = await humanTurn(s);

    expect(ledgerLines(second.input)).not.toContain(SKELETON);
    expect(ledgerLines(third.input)).toContain(SKELETON);
    expect(ledgerLines(third.input)).toContain('- 待ち行列: 開いている 3 件（');
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる入力（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await humanTurn(s);
    const second = await humanTurn(s);
    const third = await humanTurn(s);

    expect(ledgerLines(second.input)).not.toContain(SKELETON);
    expect(ledgerLines(third.input)).toContain(SKELETON);
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの入力は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });
    await humanTurn(s);
    const second = await humanTurn(s);
    const third = await humanTurn(s);

    expect(ledgerLines(second.input)).not.toContain(SKELETON);
    expect(ledgerLines(third.input)).toContain(SKELETON);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない入力は全文', async () => {
    const s = boot({ noUsage: true });
    await humanTurn(s);
    const second = await humanTurn(s);

    expect(ledgerLines(second.input)).toContain(SKELETON);
    expect(ledgerLines(second.input)).not.toContain('会話の上と同じ');
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の入力は全文。成功したターンの次は短い形のまま', async () => {
    const s = boot({ failResultAt: 2 });
    await humanTurn(s);
    const second = await humanTurn(s);
    expect(ledgerLines(second.input)).not.toContain(SKELETON);
    const third = await humanTurn(s);
    expect(ledgerLines(third.input)).toContain(SKELETON);
    const fourth = await humanTurn(s);
    expect(ledgerLines(fourth.input)).not.toContain(SKELETON);
    expect(ledgerLines(fourth.input)).toContain('- 待ち行列: 開いている 4 件（');
    await s.clone.stop();
  });

  it('⭐ 束のとき（まとめて届いた N 件）も、2回目から骨組みが参照になる。件数・id の列は毎回出る', async () => {
    let release1: () => void = () => undefined;
    let release2: () => void = () => undefined;
    const hold1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const hold2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const s = boot({ holdResultAt: { 1: hold1, 2: hold2 } });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => s.inputs.length >= 1, '先客の入力');
    // 先客のターンが終わらないあいだに2件届く: 次の入力へ束ねられる
    s.clone.post(humanMessage('束A1'));
    s.clone.post(humanMessage('束A2'));
    release1();
    await waitFor(() => s.inputs.length >= 2, '1つ目の束の入力');
    s.clone.post(humanMessage('束B1'));
    s.clone.post(humanMessage('束B2'));
    release2();
    await waitFor(() => s.inputs.length >= 3, '2つ目の束の入力');

    const firstBundle = ledgerLines(s.inputs[1] ?? '');
    const secondBundle = ledgerLines(s.inputs[2] ?? '');
    // 先客の入力で骨組みは全文が会話に載っているので、束の入力は束でも参照になる。件数と id の列は毎回出る
    expect(ledgerLines(s.inputs[0] ?? '')).toContain(SKELETON);
    for (const [bundle, count, ids] of [
      [firstBundle, 3, ['evt-束A1', 'evt-束A2']],
      [secondBundle, 5, ['evt-束B1', 'evt-束B2']],
    ] as const) {
      expect(bundle).toContain('いま届いたこの 2 件は task ');
      for (const id of ids) expect(bundle).toContain(id);
      expect(bundle).toContain(`- 待ち行列: 開いている ${String(count)} 件（`);
      expect(bundle).not.toContain(SKELETON);
      expect(bundle).toContain('`task_keep`');
      expect(bundle).toContain('`manager_start`');
    }
    await s.clone.stop();
  });
});

describe('回答（human_answer）のターンは Task に積まず、台帳の閉じ方を出す。骨組みは同じ畳みに乗る', () => {
  let answerSeq = 0;
  async function answerTurn(s: Boot): Promise<{ input: string; id: string }> {
    const before = s.inputs.length;
    answerSeq += 1;
    const id = `evt-answer-${String(answerSeq)}`;
    s.clone.post({
      type: 'human_answer',
      id,
      at: new Date().toISOString(),
      approvalId: `apv-${String(answerSeq)}`,
      answer: `回答${String(answerSeq)}`,
    });
    await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
    return { input: s.inputs[before] ?? '', id };
  }

  it('⭐ 1回目は台帳の閉じ方の全文、2回目は参照。Task に積んだとは言わない', async () => {
    const s = boot();
    const first = await answerTurn(s);
    const second = await answerTurn(s);

    expect(first.input).toContain(
      `いま届いたこの一件は台帳の行として開いた（id: \`${first.id}\`）。`,
    );
    expect(first.input).toContain('`commitment_close`');
    expect(first.input).toContain(CLOSE_SKELETON);
    expect(first.input).not.toContain('として積んだ');

    expect(second.input).toContain(
      `いま届いたこの一件は台帳の行として開いた（id: \`${second.id}\`）。`,
    );
    expect(second.input).toContain('閉じ方は会話の上と同じ: `commitment_close`');
    expect(second.input).not.toContain(CLOSE_SKELETON);
    expect(second.input).not.toContain('として積んだ');
    await s.clone.stop();
  });

  it('⭐ Task に積めなかった束（2件）は、台帳の行として開いた＋「id ごとに閉じる」の骨組みを出す（積んだとは言わない）', async () => {
    const stores = createMemoryStores();
    const failing: Stores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        add: () => Promise.reject(new Error('task が積めない（テスト用）')),
      },
    };
    let release1: () => void = () => undefined;
    const hold1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const s = boot({ holdResultAt: { 1: hold1 } }, failing);
    s.clone.post(humanMessage('先客'));
    await waitFor(() => s.inputs.length >= 1, '先客の入力');
    s.clone.post(humanMessage('束B1'));
    s.clone.post(humanMessage('束B2'));
    release1();
    await waitFor(() => s.inputs.length >= 2, '束の入力');

    const bundle = s.inputs[1] ?? '';
    expect(bundle).toContain('いま届いたこの 2 件は台帳の行として開いた（id: ');
    expect(bundle).toContain(BUNDLE_SKELETON);
    expect(bundle).toContain('Task として積めなかった');
    expect(bundle).not.toContain('として積んだ');
    await s.clone.stop();
  });
});
