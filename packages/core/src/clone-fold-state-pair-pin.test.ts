import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone, SITUATION_FULL_EVERY_TURNS } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 畳みの控えは2系統ある: 断り書きの待ち行列の先頭は `#situationExplained`（鍵 `taskQueueHead`）、同じ断り書きの固定の末尾1文は `DigestSessionDelta`（`fixed('task-queue-notice-tail')`）。
// 同じ出来事で両方が全文へ戻るか・片方だけ残るかを、1ターンの入力の上で「いまのまま」固定する。
// 先頭が畳まれた = `[system] 待ち行列: …前のターンと変化なし`、末尾が畳まれた = `（`task_list`・`task_move` は会話の上と同じ）`。

const AT = '2026-11-04T00:00:00.000Z';
const HEAD_FOLDED = '前のターンと変化なし（';
const TAIL_FOLDED = '（`task_list`・`task_move` は会話の上と同じ）';
const TAIL_FULL = '全文は `task_list`。並べ替えは `task_move`。';

interface Boot {
  clone: CloneHost;
  inputs: string[];
  stores: Stores;
}

function boot(
  options: {
    stores?: Stores;
    compactAtInput?: number;
    failResultAtInput?: number;
  } = {},
): Boot {
  const stores = options.stores ?? createMemoryStores();
  const inputs: string[] = [];
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
        if (inputs.length === options.compactAtInput) {
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
            session_id: 'sess-fake',
            uuid: 'uuid-compact',
          } as unknown as SDKMessage;
        }
        yield (inputs.length === options.failResultAtInput
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
    env: TOKEN_SAVING_ENABLED_ENV,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs, stores };
}

function human(id: string): InboxEvent {
  return {
    type: 'human_message',
    id,
    at: new Date().toISOString(),
    text: id,
    conversationId: 'conv-1',
  };
}

function seededTask(id: string): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'queued',
    origin: 'self',
    title: `題-${id}`,
    body: `body-${id}`,
  };
}

async function seededStores(): Promise<Stores> {
  const stores = createMemoryStores();
  // 先頭は3件までなので、古い task を 3 件以上積んで、新しい発言の task が先頭の材料に入らない形にする
  for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
  return stores;
}

let seq = 0;

type Pair =
  'head=畳み tail=畳み' | 'head=全文 tail=全文' | 'head=畳み tail=全文' | 'head=全文 tail=畳み';

function pairOf(input: string): Pair {
  // 「いまの全体」の節にも同じ言い回しがあるので、待ち行列の行に限って見る
  const head = input
    .split('\n')
    .some((line) => line.startsWith('[system] 待ち行列: ') && line.includes(HEAD_FOLDED));
  const tail = input.includes(TAIL_FOLDED);
  if (!head && !input.includes('[system] 待ち行列（')) throw new Error('待ち行列の節が無い');
  if (!tail && !input.includes(TAIL_FULL)) throw new Error('固定の末尾が無い');
  if (head && tail) return 'head=畳み tail=畳み';
  if (!head && !tail) return 'head=全文 tail=全文';
  return head ? 'head=畳み tail=全文' : 'head=全文 tail=畳み';
}

/** 発言を1つ投げて、その入力の（先頭, 末尾）の畳み方を返す。ターンが終わってから返し、その発言の task は閉じる。 */
async function turn(s: Boot): Promise<Pair> {
  const before = s.inputs.length;
  const timings = (await s.stores.journal.list({ types: ['turn_timing'] })).length;
  seq += 1;
  const id = `pair-evt-${String(seq)}`;
  s.clone.post(human(id));
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  await waitFor(
    async () => (await s.stores.journal.list({ types: ['turn_timing'] })).length > timings,
    'ターン終わり',
  );
  await s.stores.tasks.setStatus(id, 'done', { reason: 'test', by: 'human', at: AT });
  return pairOf(s.inputs[before] ?? '');
}

async function turns(s: Boot, count: number): Promise<Pair[]> {
  const out: Pair[] = [];
  for (let i = 0; i < count; i += 1) out.push(await turn(s));
  return out;
}

describe('畳みの控えの2系統（situation 側の先頭 / DigestSessionDelta 側の末尾）は、同じ出来事でどう消えるか', () => {
  it('⭐ 基準: 同じ会話の1回目は両方全文、2回目以降は両方畳む', async () => {
    const s = boot({ stores: await seededStores() });
    expect(await turns(s, 4)).toEqual([
      'head=全文 tail=全文',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
    ]);
    await s.clone.stop();
  });

  it('⭐ 要約（compact_boundary）: 次のターンは両方全文へ戻る（対で消える。`#situationExplained.clear()` と `reset("compaction")` が同じ分岐）', async () => {
    const s = boot({ stores: await seededStores(), compactAtInput: 3 });
    expect(await turns(s, 5)).toEqual([
      'head=全文 tail=全文',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
      // 3回目の途中で要約が起きる。4回目が全文
      'head=全文 tail=全文',
      'head=畳み tail=畳み',
    ]);
    await s.clone.stop();
  });

  // ⚠ 片方だけ残る場面（いまの振る舞い）: 失敗したターンの後は、DigestSessionDelta 側だけが全文へ戻る（`#pump` の finally の `#resetDigestDelta('full', 'turn_failed')`）。
  // situation 側の控え（`#situationExplained`。先頭の鍵 `taskQueueHead` と「いまの全体」の鍵）は消えない。#4941 が digest 側に置いた
  // 「失敗したターンの入力が SDK の履歴に残るかは SDK の挙動に頼らない」は、situation 側には掛かっていない。
  // 期待値を「両方全文」に直す変更は、この歯の意図した反転である（まとめる PR で直すなら、この2本を反転する）。
  it('⭐ 片方だけ残る: 3回目が失敗した次の回は、末尾（digest 側）だけ全文に戻り、先頭（situation 側）は畳んだまま', async () => {
    const s = boot({ stores: await seededStores(), failResultAtInput: 3 });
    expect(await turns(s, 5)).toEqual([
      'head=全文 tail=全文',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
      'head=畳み tail=全文',
      'head=畳み tail=畳み',
    ]);
    await s.clone.stop();
  });

  it('⭐ 片方だけ残る: 全文を最初に出した1回目が失敗しても、次の回の先頭（situation 側）は畳まれる（末尾は全文）', async () => {
    const s = boot({ stores: await seededStores(), failResultAtInput: 1 });
    expect(await turns(s, 4)).toEqual([
      'head=全文 tail=全文',
      'head=畳み tail=全文',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
    ]);
    await s.clone.stop();
  });

  // ⚠ 周期の全文戻しは1ターンずれる: 断り書きの末尾（`#taskQueueNoticeFor`）を組んだ後に `#situationNoticeFor` が `forgetFixed()` を呼ぶため、
  // 先頭（`#foldedTaskQueueHead` が「次の周期か」を先読みする）は周期のターンで全文、末尾は次のターンで全文になる。
  it(`⭐ 周期（${String(SITUATION_FULL_EVERY_TURNS)} ターン）: 先頭は周期のターン、末尾はその次のターンで全文へ戻る（1ターンずれる）`, async () => {
    const s = boot({ stores: await seededStores() });
    const result = await turns(s, SITUATION_FULL_EVERY_TURNS + 2);
    expect(result[0]).toBe('head=全文 tail=全文');
    // 周期の手前までは両方畳んだまま
    for (const pair of result.slice(1, SITUATION_FULL_EVERY_TURNS)) {
      expect(pair).toBe('head=畳み tail=畳み');
    }
    expect(result[SITUATION_FULL_EVERY_TURNS]).toBe('head=全文 tail=畳み');
    expect(result[SITUATION_FULL_EVERY_TURNS + 1]).toBe('head=畳み tail=全文');
    await s.clone.stop();
  }, 60_000);

  // 設計どおりの片側: 待ち行列を読めなかった回は先頭の鍵だけを消す（`#taskQueueNotice`）。末尾（固定の1文）は読めなくても会話に出ているので畳んだまま
  it('⭐ 待ち行列を読めなかった回の次: 先頭だけ全文に戻り、末尾は畳んだまま', async () => {
    const stores = await seededStores();
    const originalList = stores.tasks.list.bind(stores.tasks);
    let failing = false;
    stores.tasks.list = (async () => {
      if (failing) throw new Error('読めない(test)');
      return originalList();
    }) as typeof stores.tasks.list;
    const s = boot({ stores });
    const result: string[] = [...(await turns(s, 3))];
    failing = true;
    const before = s.inputs.length;
    seq += 1;
    s.clone.post(human(`pair-evt-${String(seq)}`));
    await waitFor(() => s.inputs.length > before, '読めなかった回の入力');
    result.push('(読めなかった回)');
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['turn_timing'] })).length >= 4,
      'ターン終わり',
    );
    failing = false;
    result.push(...(await turns(s, 2)));
    expect(result).toEqual([
      'head=全文 tail=全文',
      'head=畳み tail=畳み',
      'head=畳み tail=畳み',
      '(読めなかった回)',
      'head=全文 tail=畳み',
      'head=畳み tail=畳み',
    ]);
    await s.clone.stop();
  });
});
