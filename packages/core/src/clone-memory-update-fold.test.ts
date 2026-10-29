import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5301: 記憶更新の頭（「記憶が更新された…」の説明）を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。
// 載せる文書の本文（差分）・誰が書いたかの行・削除の行は畳まず毎回出る。

/** 全文にだけ在る説明の文（畳まれる側）。 */
const FULL_ONLY = '大きく変わっていなければ';
const FULL_ONLY_2 = 'このセッションを組んだ時点の索引';
/** 短い形にだけ在る印。 */
const REF_MARK = '読み方は前の更新と同じ';
/** 短い形にも残す要点。 */
const KEEP_UNCHANGED = 'ここに出ていない文書は変わっていない';
const KEEP_SECTION_READ = '`memory_section_read` で開くこと';
/** 索引の載せ直し（要約が走った直後）の頭。 */
const REFRESH_HEAD = '要約に潰された';

interface SdkScript {
  contextTotals?: readonly number[];
  noUsage?: boolean;
  failResultAt?: number;
  after?: (inputCount: number) => SDKMessage[];
  // クローンの env。既定は節約を有効にした env（本番の既定は無効: `ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT` / `ALTEROID_TOKEN_SAVING_COMPACTION`）
  env?: NodeJS.ProcessEnv;
}

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
  /** 文書を書き換えてから、人間の発言で1ターン回し、そのターンの入力を返す。 */
  update: (n: number) => Promise<string>;
}

function boot(script: SdkScript = {}): Boot {
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

  const stores = createMemoryStores();
  const clone = createClone({
    reportSettleMs: 2500,
    stores,
    queryFn: fn,
    env: script.env ?? TOKEN_SAVING_ENABLED_ENV,
    redeliveryGate: ALWAYS_REDELIVER,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });

  const update = async (n: number): Promise<string> => {
    const before = inputs.length;
    await stores.persona.write(
      'notes',
      `# notes\n\n${Array.from({ length: n }, (_, i) => `メモ${String(i)}行目`).join('\n')}\n`,
    );
    clone.post(humanMessage(`発言${String(n)}`));
    await waitFor(() => inputs.length > before, `入力 ${String(before + 1)} 本目`);
    return inputs[before] ?? '';
  };
  return { clone, stores, inputs, update };
}

/** 変わらない文書を先に置き、最初のターン（差分なし）を回しておく。 */
async function bootWithBaseline(script: SdkScript = {}): Promise<Boot> {
  const s = boot(script);
  await s.stores.persona.write('about-me', '# about-me\n\n変わらない文書の本文\n');
  await s.update(1);
  return s;
}

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

/** 記憶更新の頭の部分（`[system] 記憶が更新された` から、最初の空行まで）。 */
function headOf(input: string): string {
  const at = input.indexOf('[system] 記憶が更新された');
  expect(at, '記憶更新の頭が入力に無い').toBeGreaterThanOrEqual(0);
  const rest = input.slice(at);
  const end = rest.indexOf('\n');
  // 頭は1行（誰が書いたかの行以降は別の行）
  return rest.slice(0, end < 0 ? undefined : end);
}

describe('記憶更新の頭は、同じ会話の2回目から短い形になる（#5301）', () => {
  it('⭐ 初回は全文。2回目以降は字数が減り、「ここに出ていない文書は変わっていない」と節の読み方は残る。差分の本文は毎回出る', async () => {
    const s = await bootWithBaseline();
    const firstInput = await s.update(2);
    const secondInput = await s.update(3);
    const thirdInput = await s.update(4);
    const first = headOf(firstInput);

    // (d) 初回は全文
    expect(first).toContain(FULL_ONLY);
    expect(first).toContain(FULL_ONLY_2);
    expect(first).toContain(KEEP_UNCHANGED);

    for (const input of [secondInput, thirdInput]) {
      const text = headOf(input);
      // (a) 字数が減る
      expect(text).not.toContain(FULL_ONLY);
      expect(text).not.toContain(FULL_ONLY_2);
      expect(text).toContain(REF_MARK);
      expect(text.length).toBeLessThan(first.length * 0.7);
      // (b) 要点は短い形にも残る
      expect(text).toContain(KEEP_UNCHANGED);
      expect(text).toContain(KEEP_SECTION_READ);
      // 載せる差分の本文は毎回出る
      expect(input).toContain('<!-- memory: notes.md');
      expect(input).toContain('日誌に書き手が残っていない変更: notes');
      // 変わっていない文書の本文は出ない（既存の約束のまま）
      expect(input).not.toContain('変わらない文書の本文');
    }
    process.stderr.write(
      `[#5301 測定] 記憶更新の頭 1回目 ${String(first.length)} 字 → 2回目 ${String(headOf(secondInput).length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 畳みが切り（既定）なら、2回目以降も記憶更新の頭が全文のまま', async () => {
    const s = await bootWithBaseline({ env: {} });
    const inputs = [await s.update(2), await s.update(3), await s.update(4)];
    const first = headOf(inputs[0] ?? '');
    for (const input of inputs) {
      const text = headOf(input);
      expect(text).toContain(FULL_ONLY);
      expect(text).toContain(FULL_ONLY_2);
      expect(text).not.toContain(REF_MARK);
      expect(text.length).toBe(first.length);
    }
    await s.clone.stop();
  });

  it('⭐ 他の控えの全文表示に影響されない: 外部イベントなど別の固定文を全文で出しても、記憶更新の初回は全文', async () => {
    const s = await bootWithBaseline();
    const before = s.inputs.length;
    s.clone.post({
      type: 'manager_message',
      id: 'evt-report-1',
      at: new Date().toISOString(),
      managerId: 'mgr-x',
      kind: 'report',
      text: '報告',
    } as never);
    await waitFor(() => s.inputs.length > before, '報告の入力');
    const first = headOf(await s.update(2));
    expect(first).toContain(FULL_ONLY);
    const second = headOf(await s.update(3));
    expect(second).not.toContain(FULL_ONLY);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの入力は短い形にならない（全文または索引の載せ直し）', async () => {
    const s = await bootWithBaseline({ after: (n) => (n === 3 ? [compactBoundary] : []) });
    await s.update(2);
    const second = headOf(await s.update(3));
    const third = headOf(await s.update(4));
    expect(second).toContain(REF_MARK);
    expect(third).not.toContain(REF_MARK);
    // 要約の直後は索引ごと載せ直す頭（既存の挙動）か全文のどちらか。どちらも説明を含む
    expect(third.includes(FULL_ONLY) || third.includes(REFRESH_HEAD)).toBe(true);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる入力（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = await bootWithBaseline({ contextTotals: [150_000, 160_000, 180_000, 185_000] });
    await s.update(2);
    const second = headOf(await s.update(3));
    const third = headOf(await s.update(4));
    expect(second).toContain(REF_MARK);
    expect(third).not.toContain(REF_MARK);
    expect(third).toContain(FULL_ONLY);
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの入力は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = await bootWithBaseline({ after: (n) => (n === 3 ? [changedSession] : []) });
    await s.update(2);
    const second = headOf(await s.update(3));
    const third = headOf(await s.update(4));
    expect(second).toContain(REF_MARK);
    expect(third).not.toContain(REF_MARK);
    expect(third.includes(FULL_ONLY) || third.includes(REFRESH_HEAD)).toBe(true);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない入力は全文', async () => {
    const s = await bootWithBaseline({ noUsage: true });
    await s.update(2);
    const second = headOf(await s.update(3));
    expect(second).not.toContain(REF_MARK);
    expect(second).toContain(FULL_ONLY);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の入力は全文。成功したターンの次は短い形のまま', async () => {
    const s = await bootWithBaseline({ failResultAt: 3 });
    await s.update(2);
    expect(headOf(await s.update(3))).toContain(REF_MARK);
    expect(headOf(await s.update(4))).toContain(FULL_ONLY);
    expect(headOf(await s.update(5))).toContain(REF_MARK);
    await s.clone.stop();
  });
});
