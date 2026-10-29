import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5297: 台帳の2行（件数の行・いま届いた一件の行）の骨組みを、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。

const SKELETON = '返事をしただけでは閉じない';
const BUNDLE_SKELETON = '閉じるのは id ごとである';
const FULL_COUNT_HEAD = '引き受けたまま終わっていない仕事は';
const SHORT_COUNT_HEAD = '[system] 未了 ';

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
    redeliveryGate: ALWAYS_REDELIVER,
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

/** 台帳の2行（件数の行〜いま届いた一件の行）だけを取り出す。固定の1文（#4937）の手前まで。 */
function ledgerLines(input: string): string {
  const lines = input.split('\n');
  const start = lines.findIndex(
    (line) => line.includes(FULL_COUNT_HEAD) || line.startsWith(SHORT_COUNT_HEAD),
  );
  expect(start, '台帳の件数の行が入力に無い').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line.includes('全文と齢'));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
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

    // (d) 初回は全文（今までと1字も違わない骨組み）
    const firstLines = ledgerLines(first.input);
    expect(firstLines).toContain(`${FULL_COUNT_HEAD}（`);
    expect(firstLines).toContain('**1 件** ある（いちばん古いものは ');
    expect(firstLines).toContain(`いま届いたこの一件も台帳に載せた（id: \`${first.id}\`）。`);
    expect(firstLines).toContain(SKELETON);

    // (a)(b)(e) 2回目以降は短い形。件数は新しい値、最古の時刻は毎回、この一件の id も毎回
    for (const [turn, count] of [
      [second, 2],
      [third, 3],
    ] as const) {
      const lines = ledgerLines(turn.input);
      expect(lines).toContain(`${SHORT_COUNT_HEAD}${String(count)} 件（最古 `);
      expect(lines).toMatch(/最古 \d{4}-\d{2}-\d{2}T[\d:.]+Z、\d{2}:\d{2}:\d{2}Z 時点）/u);
      expect(lines).toContain(`いま届いたこの一件も台帳に載せた（id: \`${turn.id}\`）。`);
      // 閉じる道具の名前は短い形にも残る（閉じ方の参照は末尾の参照と1行にまとまっている）
      expect(turn.input).toContain('`commitment_close`');
      expect(lines).not.toContain(FULL_COUNT_HEAD);
      expect(lines).not.toContain(SKELETON);
      expect(lines.length).toBeLessThan(firstLines.length * 0.7);
    }
    // 最古の時刻は、台帳でいちばん古い行（1件目）のもので、2回目以降も同じ
    const oldestOf = (text: string): string | undefined => /最古 (\S+?)、/u.exec(text)?.[1];
    const oldestAtFirst = /いちばん古いものは (\S+) に受け取った/u.exec(firstLines)?.[1];
    expect(oldestAtFirst).toBeDefined();
    expect(oldestOf(ledgerLines(second.input))).toBe(oldestAtFirst);
    expect(oldestOf(ledgerLines(third.input))).toBe(oldestAtFirst);

    process.stderr.write(
      `[#5297 測定] 台帳の2行 1回目 ${String(firstLines.length)} 字 → 2回目 ${String(ledgerLines(second.input).length)} 字\n`,
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
      expect(lines).toContain(`${FULL_COUNT_HEAD}（`);
      expect(lines).toContain(SKELETON);
      expect(lines).toContain(`いま届いたこの一件も台帳に載せた（id: \`${turn.id}\`）。`);
      expect(turn.input).toContain('全文と齢は `commitment_list` で見られる');
      expect(turn.input).not.toContain('会話の上と同じ');
      expect(lines).not.toContain(SHORT_COUNT_HEAD);
    }
    await s.clone.stop();
  });

  it('⭐ 2回目以降は、閉じ方の参照と末尾の参照が1行にまとまる（指し先の道具は残る）', async () => {
    const s = boot();
    const first = await humanTurn(s);
    const second = await humanTurn(s);

    // 1回目は全文: 閉じ方の骨組みと末尾の固定文が別々に在る
    expect(first.input).toContain(SKELETON);
    expect(first.input).toContain('全文と齢は `commitment_list` で見られる');
    // 2回目: 参照は1行だけ。`commitment_list` と `commitment_close` の両方を指す
    const refLines = second.input.split('\n').filter((line) => line.includes('会話の上と同じ'));
    expect(refLines).toHaveLength(1);
    expect(refLines[0]).toContain('`commitment_list`');
    expect(refLines[0]).toContain('`commitment_close`');
    expect(refLines[0]).toContain('毎回決め直す');
    // 参照行は短く保つ（毎ターン載るため）。以前は 82 字だった
    expect(refLines[0]?.length).toBeLessThanOrEqual(75);
    expect(second.input).not.toContain('閉じ方は会話の上と同じ');

    const tailOf = (input: string): number =>
      input
        .split('\n')
        .filter(
          (line) =>
            line.includes('会話の上と同じ') ||
            (line.startsWith('いま届いたこの') && line.includes('台帳に載せた')),
        )
        .join('\n').length;
    process.stderr.write(
      `[台帳の参照 測定] 2回目の「この一件」行+参照行 ${String(tailOf(second.input))} 字（統合前は別 2 行の参照を含む）\n`,
    );
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
    expect(ledgerLines(third.input)).toContain('**3 件** ある');
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
    expect(ledgerLines(second.input)).not.toContain(SHORT_COUNT_HEAD);
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
    expect(ledgerLines(fourth.input)).toContain(`${SHORT_COUNT_HEAD}4 件（最古 `);
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
    // 束として全文が会話に載るのは1つ目の束が最初（先客の1件は束ではなく、束の骨組みはまだ載っていない）
    expect(firstBundle).toContain('いま届いたこの 2 件も台帳に載せた（id: ');
    expect(firstBundle).toContain(BUNDLE_SKELETON);
    expect(firstBundle).toContain(SKELETON);
    expect(firstBundle).toContain(`${SHORT_COUNT_HEAD}3 件（最古 `);
    // 末尾の固定文は先客の入力で全文が載っているので、この束の入力では参照だけになる（閉じ方は全文のまま別に出る）
    const tailRefLine = (s.inputs[1] ?? '')
      .split('\n')
      .find((line) => line.includes('会話の上と同じ'));
    expect(tailRefLine).toContain('`commitment_list`');
    expect(tailRefLine).toContain('毎回決め直す');
    expect(tailRefLine?.length).toBeLessThanOrEqual(50);
    // 2つ目の束: 骨組みは参照。件数と id の列は出る
    expect(secondBundle).toContain('いま届いたこの 2 件も台帳に載せた（id: ');
    expect(secondBundle).toContain('evt-束B1');
    expect(secondBundle).toContain('evt-束B2');
    expect(s.inputs[2]).toContain('まとめて答えても id ごとに `commitment_close`');
    expect(secondBundle).toContain(`${SHORT_COUNT_HEAD}5 件（最古 `);
    expect(secondBundle).not.toContain(BUNDLE_SKELETON);
    expect(secondBundle).not.toContain(SKELETON);
    expect(secondBundle.length).toBeLessThan(firstBundle.length * 0.7);
    await s.clone.stop();
  });
});
