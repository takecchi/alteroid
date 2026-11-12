import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  fakeGatedSdk,
  fakeSdk,
  lineStartingWith,
  setup,
  waitFor,
  waitForDone,
  wireEvents,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { HumanAction, HumanActionKind, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// `Clone` の、状態を読まず書かない「ターン入力側」の文面（人間の操作の節・記憶の載せ直し・記憶の帰属の行・文脈窓の畳みの断り・待ち行列の積んだ／積めなかった行・上限切りの断り）を、
// `createClone` 経由で逐語に固定する。モデルへ渡る入力（`#runTurn` が `#pushInput` へ渡す文字列）を観測する。
// 期待の文字列は仕様を先に書いたものではない: 今の作りの出力を `vitest -u` で生成し、目で読んで確かめたものを置いている。
// 「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 時刻の入る文面（待ち行列の見出し・上限切りの断り）は `Date` だけを止めて固定する（タイマーは本物のまま）。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';
const VIA_TOKEN = { kind: 'operator', auth: 'operator-token' } as const;
const VIA_DISABLED = { kind: 'operator', auth: 'disabled' } as const;
const VIA_ACCOUNT = { kind: 'account', accountId: 'acc-1' } as const;
const SECTION_START = '[system] 前回のターンの後に';
const SEPARATOR = '\n\n---\n\n';
const NOTICE_END = '\n\n---\n';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

/** `from` から、その後ろの最初の `to` の手前までを返す（`to` は含めない）。 */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

// 1回目のターンでセッションを組ませ、`change` の後の2回目のターン入力を返す
async function secondInput(stores: Stores, change: () => Promise<void>): Promise<string> {
  const s = setup(undefined, stores);
  s.clone.post(humanMessage('1回目'));
  await waitForDone(s.events);

  await change();

  s.clone.post(humanMessage('2回目'));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= 2);
  const input = s.calls[0]?.inputs[1] ?? '';
  await s.clone.stop();
  return input;
}

describe('人間の操作の節（renderHumanActionSection）の逐語固定', () => {
  function humanDecision(
    kind: HumanActionKind,
    target: string,
    options: { decision?: string; via?: HumanAction['via'] } = {},
  ): JournalEntryInput {
    return {
      type: 'decision',
      decision: options.decision ?? `${target} を人間が操作した`,
      grounds: 'API',
      humanAction: { kind, target, via: options.via ?? VIA_TOKEN },
    };
  }

  const sectionOf = (input: string): string => between(input, SECTION_START, SEPARATOR);

  it('全 9 種の kind の言い方と、3 通りの経路の言い方（古い順に並ぶ）', async () => {
    const stores = createMemoryStores();
    const rows: [HumanActionKind, HumanAction['via']][] = [
      ['manager_message', VIA_TOKEN],
      ['commitment_close', VIA_DISABLED],
      ['commitment_reopen', VIA_ACCOUNT],
      ['task_close', VIA_TOKEN],
      ['task_reopen', VIA_TOKEN],
      ['task_move', VIA_TOKEN],
      ['schedule_remove', VIA_TOKEN],
      ['practice_remove', VIA_TOKEN],
      ['practice_write', VIA_TOKEN],
    ];
    const input = await secondInput(stores, async () => {
      for (const [kind, via] of rows) {
        await stores.journal.append(humanDecision(kind, `t-${kind}`, { via }));
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - 担当へ直接送った: t-manager_message（t-manager_message を人間が操作した） 経路: operator（operator token）
      - 台帳の行を閉じた: t-commitment_close（t-commitment_close を人間が操作した） 経路: operator（認証無効）
      - 台帳の行を開き直した: t-commitment_reopen（t-commitment_reopen を人間が操作した） 経路: account（acc-1）
      - task を閉じた: t-task_close（t-task_close を人間が操作した） 経路: operator（operator token）
      - 閉じた task を開き直した: t-task_reopen（t-task_reopen を人間が操作した） 経路: operator（operator token）
      - task を並べ替えた: t-task_move（t-task_move を人間が操作した） 経路: operator（operator token）
      - 定期の依頼を外した: t-schedule_remove（t-schedule_remove を人間が操作した） 経路: operator（operator token）
      - やり方を消した: t-practice_remove（t-practice_remove を人間が操作した） 経路: operator（operator token）
      - やり方を書き直した: t-practice_write（t-practice_write を人間が操作した） 経路: operator（operator token）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  it('上限（20 行）ちょうどなら「ほか」は出ない', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      for (let i = 0; i < 20; i += 1) {
        await stores.journal.append(humanDecision('commitment_reopen', `c-${i}`));
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - 台帳の行を開き直した: c-0（c-0 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-1（c-1 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-2（c-2 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-3（c-3 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-4（c-4 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-5（c-5 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-6（c-6 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-7（c-7 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-8（c-8 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-9（c-9 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-10（c-10 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-11（c-11 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-12（c-12 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-13（c-13 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-14（c-14 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-15（c-15 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-16（c-16 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-17（c-17 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-18（c-18 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-19（c-19 を人間が操作した） 経路: operator（operator token）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  it('上限を 1 件超えたら、新しい側の 20 行だけを古い順に載せ、残りを「ほか 1 件」と言う', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      for (let i = 0; i < 21; i += 1) {
        await stores.journal.append(humanDecision('commitment_reopen', `c-${i}`));
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - 台帳の行を開き直した: c-1（c-1 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-2（c-2 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-3（c-3 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-4（c-4 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-5（c-5 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-6（c-6 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-7（c-7 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-8（c-8 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-9（c-9 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-10（c-10 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-11（c-11 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-12（c-12 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-13（c-13 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-14（c-14 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-15（c-15 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-16（c-16 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-17（c-17 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-18（c-18 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-19（c-19 を人間が操作した） 経路: operator（operator token）
      - 台帳の行を開き直した: c-20（c-20 を人間が操作した） 経路: operator（operator token）
      - ほか 1 件（\`journal_read\` の \`types: ["decision"]\` で読める）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  it('窓ちょうど（200 行）が全部印付きなら、20 行・「ほか 180 件」・窓の外の断りが並ぶ', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      for (let i = 0; i < 200; i += 1) {
        await stores.journal.append(humanDecision('manager_message', `job-${i}`));
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - 担当へ直接送った: job-180（job-180 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-181（job-181 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-182（job-182 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-183（job-183 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-184（job-184 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-185（job-185 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-186（job-186 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-187（job-187 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-188（job-188 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-189（job-189 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-190（job-190 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-191（job-191 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-192（job-192 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-193（job-193 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-194（job-194 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-195（job-195 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-196（job-196 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-197（job-197 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-198（job-198 を人間が操作した） 経路: operator（operator token）
      - 担当へ直接送った: job-199（job-199 を人間が操作した） 経路: operator（operator token）
      - ほか 180 件（\`journal_read\` の \`types: ["decision"]\` で読める）
      （日誌の直近の窓だけを見た。窓の外にもあるかもしれない。これで全部とは限らない）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  // 1 回目のターンが `decision` を 1 行（task の自動 done）残すので、窓の行数はそれを含めて数える
  it('窓ちょうど（200 行）でも印付きが 1 件だけなら、窓の断りは行数（印の無い行を含む）で決まる', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      await stores.journal.append(humanDecision('task_close', 'only-one'));
      for (let i = 0; i < 198; i += 1) {
        await stores.journal.append({
          type: 'decision',
          decision: `自分で決めた ${i}`,
          grounds: '記憶',
        });
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - task を閉じた: only-one（only-one を人間が操作した） 経路: operator（operator token）
      （日誌の直近の窓だけを見た。窓の外にもあるかもしれない。これで全部とは限らない）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  it('窓に 1 行足りない（199 行）なら窓の断りは出ない', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      await stores.journal.append(humanDecision('task_close', 'only-one'));
      for (let i = 0; i < 197; i += 1) {
        await stores.journal.append({
          type: 'decision',
          decision: `自分で決めた ${i}`,
          grounds: '記憶',
        });
      }
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - task を閉じた: only-one（only-one を人間が操作した） 経路: operator（operator token）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });

  it('decision の抜粋は 160 字まで（160 字ちょうどは切らず、161 字は切る。改行・連続する空白は 1 つに畳む）', async () => {
    const stores = createMemoryStores();
    const input = await secondInput(stores, async () => {
      await stores.journal.append(
        humanDecision('task_close', 'len-160', { decision: 'あ'.repeat(160) }),
      );
      await stores.journal.append(
        humanDecision('task_close', 'len-161', { decision: 'い'.repeat(161) }),
      );
      await stores.journal.append(
        humanDecision('task_close', 'multi-line', { decision: '一行目\n\n  二行目\t三行目' }),
      );
    });

    expect(sectionOf(input)).toMatchInlineSnapshot(`
      "[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。
      - task を閉じた: len-160（ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ） 経路: operator（operator token）
      - task を閉じた: len-161（いいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいい…（1 文字省略。全 161 文字）） 経路: operator（operator token）
      - task を閉じた: multi-line（一行目 二行目 三行目） 経路: operator（operator token）
      人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。人間が取り消したものを、同じ形でやり直さないこと。なぜそうしたのかが読み取れなければ、人間に聞いてよい。経路は監査の記録であって、人間がした証拠ではない（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。"
    `);
  });
});

describe('記憶の載せ直し（composeFreshMemoryInput）と帰属の行（describeMemoryEditAttribution）の逐語固定', () => {
  const doc = (title: string, body: string): string => `## ${title}\n${body}\n`;

  function memoryUpdate(
    slug: string,
    cause: 'distill' | 'clone' | 'human',
    action: 'write' | 'write_failed' = 'write',
  ): JournalEntryInput {
    return { type: 'memory_update', slug, cause, action, summary: `${slug} を書いた` };
  }

  /** 入力の先頭（記憶の載せ直し）から、本文の区切り（`---`）の手前まで。 */
  const blockOf = (input: string): string => input.slice(0, input.indexOf(SEPARATOR));

  async function firePreCompact(s: Setup): Promise<void> {
    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-turn-input-pin-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );
  }

  it('差分あり（変わった文書 1 つ）・人間の行だけ', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', '旧い本文。'));
    const input = await secondInput(stores, async () => {
      await stores.persona.write('notes', doc('notes見出し', '新しい本文。'));
      await stores.journal.append(memoryUpdate('notes', 'human'));
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      **人間が書き換えた記憶: notes**（日誌に人間の書き込みとして残っている）。人間が直したのは、あなたの理解のどこかが人間の考えとずれていたからである。何が変わったかを読み、同じずれが他の記憶や進行中の判断・委譲に残っていないかを確かめること。なぜ直したのかが読み取れなければ、人間に聞いてよい。

      <!-- memory: notes.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 2 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
      <!-- memory: notes.md（premise・本文は載っていない。全 19 文字 / 1 節） -->
        [8518fc1a-9c49d20c] ## notes見出し"
    `);
  });

  it('差分あり・書き手が日誌に無い行だけ', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', '旧い本文。'));
    const input = await secondInput(stores, async () => {
      await stores.persona.write('notes', doc('notes見出し', '新しい本文。'));
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: notes（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      <!-- memory: notes.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 2 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
      <!-- memory: notes.md（premise・本文は載っていない。全 19 文字 / 1 節） -->
        [8518fc1a-9c49d20c] ## notes見出し"
    `);
  });

  it('人間の行と書き手不明の行が両方出る（人間の行が先）。クローン・蒸留の更新は両方から外れる', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alpha', doc('alpha', '旧'));
    await stores.persona.write('beta', doc('beta', '旧'));
    await stores.persona.write('gamma', doc('gamma', '旧'));
    await stores.persona.write('delta', doc('delta', '旧'));
    await stores.persona.write('epsilon', doc('epsilon', '旧'));
    const input = await secondInput(stores, async () => {
      for (const slug of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
        await stores.persona.write(slug, doc(slug, '新'));
      }
      await stores.journal.append(memoryUpdate('alpha', 'human'));
      await stores.journal.append(memoryUpdate('beta', 'clone'));
      await stores.journal.append(memoryUpdate('gamma', 'distill'));
      await stores.journal.append(memoryUpdate('epsilon', 'human', 'write_failed'));
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      **人間が書き換えた記憶: alpha**（日誌に人間の書き込みとして残っている）。人間が直したのは、あなたの理解のどこかが人間の考えとずれていたからである。何が変わったかを読み、同じずれが他の記憶や進行中の判断・委譲に残っていないかを確かめること。なぜ直したのかが読み取れなければ、人間に聞いてよい。
      日誌に書き手が残っていない変更: delta / epsilon（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      <!-- memory: alpha.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [b3713935-db3c7c8f] ## alpha

      <!-- memory: beta.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [8edd5b21-46b71a0d] ## beta

      <!-- memory: delta.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [0a725583-c09ec642] ## delta

      <!-- memory: epsilon.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [5799a2c7-14bdfbd8] ## epsilon

      <!-- memory: gamma.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [d3c87009-258b52e4] ## gamma"
    `);
  });

  it('引いた行がちょうど 200 件なら、書き手不明の行は作らない（窓の外に書き手がいるかもしれない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', '旧い本文。'));
    const input = await secondInput(stores, async () => {
      await stores.persona.write('notes', doc('notes見出し', '新しい本文。'));
      for (let i = 0; i < 200; i += 1) {
        await stores.journal.append(memoryUpdate('filler', 'clone'));
      }
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**

      <!-- memory: notes.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 2 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
      <!-- memory: notes.md（premise・本文は載っていない。全 19 文字 / 1 節） -->
        [8518fc1a-9c49d20c] ## notes見出し"
    `);
  });

  it('引いた行が 199 件なら、書き手不明の行を作る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', '旧い本文。'));
    const input = await secondInput(stores, async () => {
      await stores.persona.write('notes', doc('notes見出し', '新しい本文。'));
      for (let i = 0; i < 199; i += 1) {
        await stores.journal.append(memoryUpdate('filler', 'clone'));
      }
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: notes（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      <!-- memory: notes.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 2 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
      <!-- memory: notes.md（premise・本文は載っていない。全 19 文字 / 1 節） -->
        [8518fc1a-9c49d20c] ## notes見出し"
    `);
  });

  it('slug の列挙は 400 字で切る（人間の行・書き手不明の行とも）', async () => {
    const stores = createMemoryStores();
    const slugs = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => `${letter}${'x'.repeat(89)}`);
    for (const slug of slugs) await stores.persona.write(slug, doc(slug, '旧'));
    const humanLine = '**人間が書き換えた記憶: ';
    const untracedLine = '日誌に書き手が残っていない変更: ';
    const input = await secondInput(stores, async () => {
      for (const slug of slugs) await stores.persona.write(slug, doc(slug, '新'));
      for (const slug of slugs) await stores.journal.append(memoryUpdate(slug, 'human'));
    });
    const untracedInput = await (async () => {
      const other = createMemoryStores();
      for (const slug of slugs) await other.persona.write(slug, doc(slug, '旧'));
      return secondInput(other, async () => {
        for (const slug of slugs) await other.persona.write(slug, doc(slug, '新'));
      });
    })();

    expect(lineStartingWith(input, humanLine)).toMatchInlineSnapshot(
      `"**人間が書き換えた記憶: axxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / exxxxxxxxxxxxxxxxxxxxxxxxxxx…（155 文字省略。全 555 文字）**（日誌に人間の書き込みとして残っている）。人間が直したのは、あなたの理解のどこかが人間の考えとずれていたからである。何が変わったかを読み、同じずれが他の記憶や進行中の判断・委譲に残っていないかを確かめること。なぜ直したのかが読み取れなければ、人間に聞いてよい。"`,
    );
    expect(lineStartingWith(untracedInput, untracedLine)).toMatchInlineSnapshot(
      `"日誌に書き手が残っていない変更: axxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx / exxxxxxxxxxxxxxxxxxxxxxxxxxx…（155 文字省略。全 555 文字）（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。"`,
    );
  });

  it('削除（名前だけを `.md` 付きで ` / ` 区切り）と、変わった文書が同居する', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('keep', doc('keep', '旧'));
    await stores.persona.write('gone-1', doc('gone-1', '本文1'));
    await stores.persona.write('gone-2', doc('gone-2', '本文2'));
    const input = await secondInput(stores, async () => {
      await stores.persona.write('keep', doc('keep', '新'));
      await stores.persona.remove('gone-1');
      await stores.persona.remove('gone-2');
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: keep / gone-1 / gone-2（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      <!-- memory: keep.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [2b4c321f-a140a399] ## keep

      削除された記憶: gone-1.md / gone-2.md"
    `);
  });

  it('削除だけ（変わった文書は無い）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('keep', doc('keep', '本文'));
    await stores.persona.write('gone', doc('gone', '本文'));
    const input = await secondInput(stores, async () => {
      await stores.persona.remove('gone');
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: gone（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      削除された記憶: gone.md"
    `);
  });

  it('全部消えたら「記憶は空になった」が付く', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('only', doc('only', '本文'));
    const input = await secondInput(stores, async () => {
      await stores.persona.remove('only');
    });

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: only（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      削除された記憶: only.md

      （記憶は空になった）"
    `);
  });

  it('要約の後（refreshIndex）は、頭が索引の載せ直しの文になり、帰属の行を出さず、索引の全体を載せる。削除は名前で言う', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('keep', doc('keep', '旧'));
    await stores.persona.write('stay', doc('stay', '本文'));
    await stores.persona.write('gone', doc('gone', '本文'));
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);
    await stores.persona.write('keep', doc('keep', '新'));
    await stores.persona.remove('gone');
    await stores.journal.append(memoryUpdate('keep', 'human'));
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const input = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] この会話の文脈が要約に潰された。**それまでに載せた記憶の差分も、その要約の中へ畳まれている**（残っているとは限らない）。だから**いまの索引を丸ごと載せ直す** —— 下に在るのが現在の記憶の全体（要旨と節の目次）であり、システムプロンプト側の「現在の記憶」より新しい。食い違ったら下を採ること。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**

      <!-- memory: keep.md（premise・本文は載っていない。全 10 文字 / 1 節） -->
      要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）
      節（memory_section_read に節id を渡せば本文が開く。文字数（子込み）は memory_outline で見られる）:
        [2b4c321f-a140a399] ## keep

      <!-- memory: stay.md（premise・本文は載っていない。全 11 文字 / 1 節） -->
      要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）
      節（memory_section_read に節id を渡せば本文が開く。文字数（子込み）は memory_outline で見られる）:
        [9f8a4d1f-02e2aa0e] ## stay

      削除された記憶: gone.md"
    `);
  });

  it('要約の後に記憶が空なら、索引は載せず「記憶は空になった」だけが付く', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const input = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] この会話の文脈が要約に潰された。**それまでに載せた記憶の差分も、その要約の中へ畳まれている**（残っているとは限らない）。だから**いまの索引を丸ごと載せ直す** —— 下に在るのが現在の記憶の全体（要旨と節の目次）であり、システムプロンプト側の「現在の記憶」より新しい。食い違ったら下を採ること。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**

      （記憶は空になった）"
    `);
  });

  it('resume した最初のターンで、差分も無ければ、断りだけを本文の前に置く', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', doc('価値観', 'V1'));
    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await first.clone.stop();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);
    const input = second.calls[0]?.inputs[0] ?? '';
    await second.clone.stop();

    expect(blockOf(input)).toMatchInlineSnapshot(
      `"[system] このセッションは前のセッションを引き継いで（resume して）開いたものである。**現在の記憶は、システムプロンプトの「現在の記憶」に載っているものである。** この下より前の会話に「記憶が更新された」として載っている塊は、それより古い可能性がある（デーモンが落ちている間に人間が直していれば、正本のほうが新しい）。食い違ったらシステムプロンプト側を採ること。確かめたければ \`memory_read\` で読み直せる。"`,
    );
  });

  it('resume した最初のターンで、セッションを組んだ後に記憶が変わっていれば、断り・頭・差分が並ぶ', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', doc('価値観', 'V1'));
    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await first.clone.stop();

    // 1回目の読み出し（セッションを組む）は旧、2回目以降（ターンの頭）は新: 組んだ後・入力の前に人間が直した形を作る
    const original = stores.persona.documents.bind(stores.persona);
    let reads = 0;
    const racing: Stores = {
      ...stores,
      persona: {
        ...stores.persona,
        documents: async () => {
          reads += 1;
          if (reads === 1) return original();
          await stores.persona.write('values', doc('価値観', 'V2'));
          return original();
        },
      },
    };
    const second = setup(undefined, racing);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);
    const input = second.calls[0]?.inputs[0] ?? '';
    await second.clone.stop();

    expect(blockOf(input)).toMatchInlineSnapshot(`
      "[system] このセッションは前のセッションを引き継いで（resume して）開いたものである。**現在の記憶は、システムプロンプトの「現在の記憶」に載っているものである。** この下より前の会話に「記憶が更新された」として載っている塊は、それより古い可能性がある（デーモンが落ちている間に人間が直していれば、正本のほうが新しい）。食い違ったらシステムプロンプト側を採ること。確かめたければ \`memory_read\` で読み直せる。

      [system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る（省いた側は行数と文字数で名乗ってある）。システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、それに続けてこれらの差分を当てたものが現在の索引である。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**
      日誌に書き手が残っていない変更: values（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。

      <!-- memory: values.md（カードの変わった範囲だけ） -->
      （このカードは全 4 行。うち 3 行は変わっていないので載せていない。カードの全体は memory_list、節の本文は memory_section_read で開ける）
        [075432cc-ca75ddf7] ## 価値観"
    `);
  });
});

describe('文脈窓の畳みの断り（#contextWindowFoldNotice の固定文）の逐語固定', () => {
  const TOO_LONG = { subtype: 'success', isError: true, text: 'Prompt is too long' } as const;

  /** 2 ターン目が長さで落ちる（答えを返したことのあるセッションなので畳む）。畳んだ後の新しいセッションの最初の入力を返す。 */
  async function inputAfterFold(options: { reopen: boolean }): Promise<string> {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, {
      resultFor: (turnIndex) => (turnIndex === 1 ? TOO_LONG : undefined),
    });
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('1回目'));
    await waitForDone(events);
    clone.post(humanMessage('長さで落ちる'));
    await waitForEvents((seen) => seen.some((event) => event.type === 'error'));
    if (options.reopen) {
      if (clone.reopenSession === undefined) throw new Error('reopenSession の口が無い');
      await clone.reopenSession({ reason: '試験', distill: false, actor: 'テスト' });
    }
    clone.post(humanMessage('畳みの後'));
    await waitFor(
      () => calls.filter((call) => call.kind === 'session').length >= 2,
      '新しいセッションが開く',
    );
    await waitFor(
      () => (calls.filter((call) => call.kind === 'session')[1]?.inputs.length ?? 0) >= 1,
      '新しいセッションが最初の入力を受ける',
    );
    const input = calls.filter((call) => call.kind === 'session')[1]?.inputs[0] ?? '';
    await clone.stop();
    return input;
  }

  // 固定文の終わりの区切り（`---`）までを含める
  const foldNoticeOf = (input: string): string =>
    between(input, '[system] 直前のターンが文脈窓', SEPARATOR) + SEPARATOR;

  it('畳んだ次のセッションの最初の入力に、固定文が 1 度だけ載る', async () => {
    const input = await inputAfterFold({ reopen: false });

    expect(foldNoticeOf(input)).toMatchInlineSnapshot(`
      "[system] 直前のターンが文脈窓（プロンプトの長さ）に当たって失敗したので、このセッションは前の会話を引き継がずに開き直したものである。**⟹ あなたはそれまでのやりとりを文脈として持っていない。**ただし会話の記録そのものは消えていない（\`conversation_read\` で読み直せる。生ログはアーカイブに退避してある）。⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである——失われたのは会話の文脈だけである。

      ---

      "
    `);
    expect(input.split('直前のターンが文脈窓').length - 1).toBe(1);
  });

  it('開き直しの断りと並ぶときは、開き直しが先で、固定文が後', async () => {
    const input = await inputAfterFold({ reopen: true });

    const foldAt = input.indexOf('[system] 直前のターンが文脈窓');
    expect(foldAt).toBeGreaterThan(0);
    expect(input.slice(0, foldAt)).toMatchInlineSnapshot(`
      "[system] 人間（テスト）の操作で、このセッションは前のセッションを resume せずに開き直したものである（理由: 試験）。古いセッション id: sess-fake。古いセッションには退避するものが無かった。**⟹ あなたはそれまでのやりとりを文脈として持っていない。**ただし会話の記録そのものは消えていない（\`conversation_read\` で読み直せる）。⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである。古いセッションの末尾は記憶へ蒸留していない。理由が安全分類器（safeguards）の拒否だった場合、同じ内容がこのセッションへ入るとまた弾かれうる。

      ---

      "
    `);
    expect(foldNoticeOf(input)).toMatchInlineSnapshot(`
      "[system] 直前のターンが文脈窓（プロンプトの長さ）に当たって失敗したので、このセッションは前の会話を引き継がずに開き直したものである。**⟹ あなたはそれまでのやりとりを文脈として持っていない。**ただし会話の記録そのものは消えていない（\`conversation_read\` で読み直せる。生ログはアーカイブに退避してある）。⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである——失われたのは会話の文脈だけである。

      ---

      "
    `);
  });
});

describe('待ち行列の「積んだ／積めなかった」の行（#taskQueueNotice の placedLines・failedLines）の逐語固定', () => {
  /** 先客のターンを止めておき、続きを束ねて 2 ターン目に入れる。2 ターン目の入力の待ち行列の節を返す。 */
  async function mergedQueueNotice(stores: Stores, texts: readonly string[]): Promise<string> {
    const gated = fakeGatedSdk();
    const clone = createClone({
      stores,
      queryFn: gated.fn,
      env: {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { waitForEvents } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('先客'));
    await waitFor(() => (gated.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    for (const text of texts) clone.post(humanMessage(text));
    gated.release();
    await waitFor(() => (gated.calls[0]?.inputs.length ?? 0) === 2, '束のターンが投げられる');
    await waitForEvents((seen) => seen.filter((event) => event.type === 'done').length >= 2);
    const second = gated.calls[0]?.inputs[1] ?? '';
    await clone.stop();
    return noticeOf(second);
  }

  // 節の頭は、読めた回の「待ち行列（…に数えた材料）」か、読めなかった回の「待ち行列を読めなかった」
  const noticeOf = (input: string): string => {
    const starts = ['[system] 待ち行列（', '[system] **待ち行列を読めなかった']
      .map((marker) => input.indexOf(marker))
      .filter((index) => index >= 0);
    expect(starts).toHaveLength(1);
    const start = starts[0] as number;
    // 断り書きの終わりは `---` の行（直後に次の節が続くので、空行は挟まない）
    return input.slice(start, input.indexOf(NOTICE_END, start) + NOTICE_END.length);
  };

  it('1 件・積めた（「いま届いたこの一件は」）', async () => {
    const s = setup();
    s.clone.post(humanMessage('一件だけ'));
    await waitForDone(s.events);
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）
      - evt-一件だけ（状態: queued（待ち行列） / origin: human）一件だけ
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）
      いま届いたこの一件は task \`evt-一件だけ\` として積んだ。返事をしたターンの終わりに自動で done になる。続けるなら \`task_keep\`、委譲するなら \`manager_start\` に \`taskId\`。
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('複数件・積めた（「いま届いたこの 2 件は」・id は `, ` 区切り）', async () => {
    const notice = await mergedQueueNotice(createMemoryStores(), ['続き1', '続き2']);

    expect(notice).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 2 件（queued 2 / waiting 0 / needs_decision 0）
      - evt-続き1（状態: queued（待ち行列） / origin: human）続き1
      - evt-続き2（状態: queued（待ち行列） / origin: human）続き2
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）
      いま届いたこの 2 件は task \`evt-続き1\`, \`evt-続き2\` として積んだ。返事をしたターンの終わりに自動で done になる。続けるなら \`task_keep\`、委譲するなら \`manager_start\` に \`taskId\`。
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('id の列挙は 400 字で切る（50 件）', async () => {
    const texts = Array.from({ length: 50 }, (_, i) => `続き${i}`);
    const notice = await mergedQueueNotice(createMemoryStores(), texts);

    expect(lineStartingWith(notice, 'いま届いたこの 50 件は task ')).toMatchInlineSnapshot(
      `"いま届いたこの 50 件は task \`evt-続き0\`, \`evt-続き1\`, \`evt-続き2\`, \`evt-続き3\`, \`evt-続き4\`, \`evt-続き5\`, \`evt-続き6\`, \`evt-続き7\`, \`evt-続き8\`, \`evt-続き9\`, \`evt-続き10\`, \`evt-続き11\`, \`evt-続き12\`, \`evt-続き13\`, \`evt-続き14\`, \`evt-続き15\`, \`evt-続き16\`, \`evt-続き17\`, \`evt-続き18\`, \`evt-続き19\`, \`evt-続き20\`, \`evt-続き21\`, \`evt-続き22\`, \`evt-続き23\`, \`evt-続き24\`, \`evt-続き25\`, \`evt-続き26\`, \`evt-続き27\`, \`evt-続き28\`, \`evt-続き29\`, \`evt-続き30\`, \`evt-続き31\`, \`evt-続き32\`, \`evt-続き33\`, \`e…（188 文字省略。全 588 文字） として積んだ。返事をしたターンの終わりに自動で done になる。続けるなら \`task_keep\`、委譲するなら \`manager_start\` に \`taskId\`。"`,
    );
  });

  function failingAdd(stores: Stores, pattern: RegExp): Stores {
    return {
      ...stores,
      tasks: {
        ...stores.tasks,
        add: async (entry, placement) => {
          if (pattern.test(entry.id)) throw new Error('台帳が書けない');
          return stores.tasks.add(entry, placement);
        },
      },
    };
  }

  it('1 件・積めなかった（`**⚠️ いま届いたこの 1 件は Task として積めなかった`）', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('ng-one'));
    await waitForDone(s.events);
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）
      **⚠️ いま届いたこの 1 件は Task として積めなかった（id: \`evt-ng-one\`）。** 待ち行列には載っていない。必要なら \`task_add\` で載せ直すこと（理由は日誌に残してある）。
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('複数件のうち一部だけ積めなかった（積んだ行が先、積めなかった行が後）', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/);
    const notice = await mergedQueueNotice(stores, ['ok-1', 'ng-1', 'ok-2', 'ng-2']);

    expect(notice).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 2 件（queued 2 / waiting 0 / needs_decision 0）
      - evt-ok-1（状態: queued（待ち行列） / origin: human）ok-1
      - evt-ok-2（状態: queued（待ち行列） / origin: human）ok-2
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）
      いま届いたこの 2 件は task \`evt-ok-1\`, \`evt-ok-2\` として積んだ。返事をしたターンの終わりに自動で done になる。続けるなら \`task_keep\`、委譲するなら \`manager_start\` に \`taskId\`。
      **⚠️ いま届いたこの 2 件は Task として積めなかった（id: \`evt-ng-1\`, \`evt-ng-2\`）。** 待ち行列には載っていない。必要なら \`task_add\` で載せ直すこと（理由は日誌に残してある）。
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('待ち行列を読めない回も、積んだ・積めなかった行は読めなかった断りの後ろに並ぶ', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...failingAdd(base, /ng/),
      tasks: {
        ...failingAdd(base, /ng/).tasks,
        list: async () => {
          throw new Error('task 台帳が壊れている');
        },
      },
    };
    const notice = await mergedQueueNotice(stores, ['ok-1', 'ng-1']);

    expect(notice).toMatchInlineSnapshot(`
      "[system] **待ち行列を読めなかった（09:00:00Z に試みた材料。理由: Error: task 台帳が壊れている）。** ⟹ **開いている仕事が何件あるかは、この回は判定できていない——0 件だったのでも、異常が無かったのでもない。** 読み直す手は \`task_list\` である（同じ理由で失敗するなら、失敗として返る）。
      いま届いたこの一件は task \`evt-ok-1\` として積んだ。返事をしたターンの終わりに自動で done になる。続けるなら \`task_keep\`、委譲するなら \`manager_start\` に \`taskId\`。
      **⚠️ いま届いたこの 1 件は Task として積めなかった（id: \`evt-ng-1\`）。** 待ち行列には載っていない。必要なら \`task_add\` で載せ直すこと（理由は日誌に残してある）。
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });
});

describe('上限切りの断り書き（mergedBatchTruncationNoticeFor）の時刻の逐語固定', () => {
  it('数えた時点（`Date.now()` を評価した時刻）が「HH:MM:SSZ 時点」に入る', async () => {
    const gated = fakeGatedSdk();
    const stores = createMemoryStores();
    const clone = createClone({
      stores,
      queryFn: gated.fn,
      env: {},
      mergedBatchLimit: 2,
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { waitForEvents } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('先客'));
    await waitFor(() => (gated.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    for (const id of ['r1', 'r2', 'r3']) {
      clone.post({
        type: 'manager_message',
        id,
        at: FROZEN_AT,
        managerId: 'mgr-T',
        kind: 'report',
        text: `本文${id}`,
      });
    }
    gated.release();
    await waitFor(() => (gated.calls[0]?.inputs.length ?? 0) === 3, '3 ターンが投げられる');
    await waitForEvents((seen) => seen.filter((event) => event.type === 'done').length >= 1);
    const second = gated.calls[0]?.inputs[1] ?? '';
    await clone.stop();

    expect(between(second, '[system] **このターンへ束ねる合図は、上限', '---\n') + '---\n')
      .toMatchInlineSnapshot(`
      "[system] **このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。09:00:00Z 時点）。**同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。
      **1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。

      ---
      "
    `);
  });
});
