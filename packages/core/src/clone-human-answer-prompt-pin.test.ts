import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import type { ManagerSummary } from './manager.js';
import type { ApprovalSelection, InboxEvent, PendingApproval } from './schema.js';
import { UnreadableApprovalError } from './store.js';
import { createMemoryStores } from './testing.js';

// `Clone` の private メソッド `#handleHumanAnswer` が組み立てる `answerPrompt`（`human_answer` を受けたターンで、モデルへ渡る入力）を、`createClone` 経由で逐語に固定する。
// 期待の文字列は仕様を先に書いたものではない: 今の作りの出力を `vitest -u` で生成し、目で読んで確かめたものを置いている。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 枝: 質問（取れた／行が無い／行が読めない）・`waiting`（宛先なし／決着済み／待たれている／分からない／requestId なし）・選択の構造の有無・回答経路（未指定／account／operator の2種）。
// 基準の指示（`HUMAN_ANSWER_CRITERIA_GUIDE`）は全ケースの末尾に全文で入る。
// `human_answer` は `clone.post` で直接置く: `answerApproval` を通すと回答の文・印が別の経路で変わり、組み立ての枝だけを動かせないため。

const MARKER = '[system] 承認待ちにしていた質問に人間が答えた';

function summary(waiting: { requestId: string }[]): ManagerSummary {
  const at = '2026-10-08T00:00:00.000Z';
  return {
    managerId: 'm1',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: at,
    updatedAt: at,
    waiting,
    runnerId: 'runner-a',
  } as unknown as ManagerSummary;
}

interface Case {
  /** 承認待ちの行。`undefined` なら行は無い（質問が取れない） */
  approval?: Partial<PendingApproval>;
  /** `getApproval` を「在るが読めない」で落とす */
  unreadable?: boolean;
  /** `managers.list` の返り */
  list?: () => Promise<ManagerSummary[]>;
  event?: Partial<Extract<InboxEvent, { type: 'human_answer' }>>;
}

async function answerPromptOf(c: Case): Promise<string> {
  const stores = createMemoryStores();
  const inputs: string[] = [];
  const { fn } = fakeSdk((input) => {
    inputs.push(input);
    return '進めた';
  });
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    managers: {
      list: c.list ?? (async () => []),
      stop: async () => undefined,
    } as never,
  });
  if (c.approval !== undefined) {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-10-08T00:00:00.000Z',
      question: '本番へ出してよいか',
      ...c.approval,
    });
  }
  if (c.unreadable === true) {
    stores.jobs.getApproval = async (id) => {
      throw new UnreadableApprovalError({ id });
    };
  }
  clone.post({
    type: 'human_answer',
    id: 'evt-answer-1',
    at: '2026-10-08T00:00:01.000Z',
    approvalId: 'ap-1',
    answer: 'はい、進めてください',
    ...c.event,
  });
  await waitFor(() => inputs.some((input) => input.includes(MARKER)), '人間の答えのターンの入力');
  await clone.stop();
  const input = inputs.find((entry) => entry.includes(MARKER)) ?? '';
  // 入力の前には、待ち行列の件数などの `[system]` の節が付く（時刻を含み揺れる）。`answerPrompt` は入力の最後の節なので、印から末尾までを取る
  return input.slice(input.indexOf(MARKER));
}

const SELECTIONS: ApprovalSelection[] = [
  { questionId: 'target', optionIds: ['railway'] },
  { questionId: 'notify', optionIds: ['slack', 'mail'], other: '夜は避けたい' },
];

describe('human_answer の入力の文面（#handleHumanAnswer の answerPrompt）の逐語固定', () => {
  it('行が無い（質問が取れない）・宛先なし・選択なし・回答経路なし', async () => {
    expect(await answerPromptOf({})).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: (不明な質問)
      回答: はい、進めてください

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('行が在るが読めない: 質問の代わりに「読めない形で入っている」と言う（回答の本文は失わない）', async () => {
    expect(await answerPromptOf({ unreadable: true })).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: (不明な質問。承認待ちの行は在るが読めない形で入っている)
      回答: はい、進めてください

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('質問が取れる・宛先なし（jobId なし）', async () => {
    expect(await answerPromptOf({ approval: {} })).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('宛先あり・確認が待たれている（live）: requestId 付きで返すと再開すると案内する', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1', requestId: 'r1' },
        list: async () => [summary([{ requestId: 'r1' }])],
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この確認はマネージャー m1 のものである。回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。
      宛先: managerId: "m1", requestId: "r1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('宛先あり・確認がもう待たれていない（settled）: 普通の伝言として送らせる（requestId は付けない）', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1', requestId: 'r1' },
        list: async () => [summary([])],
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この確認はマネージャー m1 のものである。この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。回答の中身を担当へ届けるなら、確認への返答ではなく普通の伝言として \`manager_send\` で送ること（requestId は付けない）。
      宛先: managerId: "m1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('宛先あり・一覧が読めない（unknown）: 待たれていないと言わず live と同じ案内', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1', requestId: 'r1' },
        list: async () => {
          throw new Error('一覧が取れない');
        },
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この確認はマネージャー m1 のものである。回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。
      宛先: managerId: "m1", requestId: "r1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('宛先あり・マネージャーが一覧に居ない（unknown）: live と同じ案内', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1', requestId: 'r1' },
        list: async () => [{ ...summary([]), managerId: 'other' }],
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この確認はマネージャー m1 のものである。回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。
      宛先: managerId: "m1", requestId: "r1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('宛先あり・requestId なし: 宛先に requestId を付けない（待たれているかは決めず live と同じ案内）', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1' },
        list: async () => [summary([])],
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください

      この確認はマネージャー m1 のものである。回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。
      宛先: managerId: "m1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('選択の構造（selections）がある: JSON で添える', async () => {
    expect(await answerPromptOf({ approval: {}, event: { selections: SELECTIONS } }))
      .toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください
      選択（構造。設問 id → 選んだ選択肢 id ＋ その他）: [{"questionId":"target","optionIds":["railway"]},{"questionId":"notify","optionIds":["slack","mail"],"other":"夜は避けたい"}]

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('回答経路: account', async () => {
    expect(
      await answerPromptOf({
        approval: {},
        event: { answeredVia: { kind: 'account', accountId: 'acc-1' } },
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください
      回答経路: account（acc-1）

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('回答経路: operator（認証無効）', async () => {
    expect(
      await answerPromptOf({
        approval: {},
        event: { answeredVia: { kind: 'operator', auth: 'disabled' } },
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください
      回答経路: operator（認証無効）

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('回答経路: operator（operator token）', async () => {
    expect(
      await answerPromptOf({
        approval: {},
        event: { answeredVia: { kind: 'operator', auth: 'operator-token' } },
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください
      回答経路: operator（operator token）

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });

  it('全部入り（selections・回答経路・settled の宛先）: 並びは 質問・回答・選択・回答経路・宛先', async () => {
    expect(
      await answerPromptOf({
        approval: { jobId: 'm1', requestId: 'r1' },
        list: async () => [summary([])],
        event: {
          selections: SELECTIONS,
          answeredVia: { kind: 'account', accountId: 'acc-1' },
        },
      }),
    ).toMatchInlineSnapshot(`
      "[system] 承認待ちにしていた質問に人間が答えた。

      質問: 本番へ出してよいか
      回答: はい、進めてください
      選択（構造。設問 id → 選んだ選択肢 id ＋ その他）: [{"questionId":"target","optionIds":["railway"]},{"questionId":"notify","optionIds":["slack","mail"],"other":"夜は避けたい"}]
      回答経路: account（acc-1）

      この確認はマネージャー m1 のものである。この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。回答の中身を担当へ届けるなら、確認への返答ではなく普通の伝言として \`manager_send\` で送ること（requestId は付けない）。
      宛先: managerId: "m1"

      この回答に沿って続きを進めよ。

      この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。基準が読み取れないなら、推測で書かずに人間に訊くこと。"
    `);
  });
});
