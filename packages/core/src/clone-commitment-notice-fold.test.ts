import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5297: 断り書きの骨組みの文を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。
// #5469 P6c: 骨組みは「待ち行列の先頭・task として積んだ・全文と並べ替え」に替わった（旧: 台帳の件数・commitment_close・commitment_list）。
// #5923: クローンは台帳へ書かなくなったので、台帳の閉じ方（commitment_close）の骨組みと、その畳みの歯（回答のターン）は外した。

const SKELETON = '返事をしたターンの終わりに自動で done になる';
const TAIL_FULL = '全文は `task_list`。並べ替えは `task_move`。';
const QUEUE_HEAD = '[system] 待ち行列（';

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

describe('台帳の2行は、同じ会話の2回目から骨組みが参照になる（#5297）', () => {
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
});
