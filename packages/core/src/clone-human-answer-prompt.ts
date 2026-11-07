import type { ConfirmationLiveness } from './clone-batch-prompts.js';
import { describeAnsweredVia } from './schema.js';
import type { InboxEvent, PendingApproval } from './schema.js';

// `clone.ts` の `Clone#handleHumanAnswer`（`human_answer` 1 件の処理）のうち、モデルへ渡す文面（`answerPrompt`）の組み立てだけを、状態を持たない純関数として出したもの。
// 切り出した理由: `Clone` の private で直接呼べず、`clone-human-answer-prompt-pin.test.ts` が `createClone` 越しにしか縛れなかったため。
// `Clone` の状態も口も読まない: 承認待ちの行（`getApproval`）と確認の決着（`confirmationLiveness`。`managers.list()` を引く）は非同期なので、呼び元が `await` して値で渡す。
// 同期のまま保つ: 呼び元の `await` の数と位置を変えないため。重複排除・配達の印・日誌・`#runTurn` は `Clone` に残る。

// 「必要なら」で写すかを任せない（#5125 c30-2）: 承認への答えは人間の判断の合図で最も濃いのに、基準として記憶へ写されず、同じ種類の確認を何度も人間へ上げていたため
const HUMAN_ANSWER_CRITERIA_GUIDE =
  'この回答は、同じ種類の確認が次に来たときにあなたが自分で決めるための材料である。' +
  '拒否・条件付き・理由付きの答えなら、結論だけでなく理由と条件を、どの種類の確認に効く基準かが分かる言葉に言い換えて記憶へ書くこと。' +
  '基準が読み取れないなら、推測で書かずに人間に訊くこと。';

export function buildHumanAnswerPrompt(
  approval: PendingApproval | null,
  approvalUnreadable: boolean,
  event: Extract<InboxEvent, { type: 'human_answer' }>,
  answerLiveness: ConfirmationLiveness,
): string {
  const question =
    approval?.question ??
    (approvalUnreadable
      ? '(不明な質問。承認待ちの行は在るが読めない形で入っている)'
      : '(不明な質問)');
  // 宛先は managerId と requestId の対で戻す: requestId を落とすと、複数を待っているマネージャーの宛先が決まらず、人間が答えたのに仕事が再開しないため
  // 決着済みの確認へ requestId 付きで返すと `gone` で弾かれ、答えの中身が担当へ届かない: `manager_message` の枝と同じく、待たれていないと分かるときだけ案内を変える（分からないときは変えない）
  const waiting =
    approval?.jobId === undefined
      ? ''
      : answerLiveness === 'settled'
        ? `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
          `この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。` +
          `回答の中身を担当へ届けるなら、確認への返答ではなく普通の伝言として \`manager_send\` で送ること（requestId は付けない）。` +
          `\n宛先: managerId: "${approval.jobId}"`
        : `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
          `回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。` +
          `\n宛先: managerId: "${approval.jobId}"` +
          (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`);
  // 回答経路を添える: `operator` 経由の回答が人間本人とは限らないことを、クローンが判断材料にできるようにするため
  const viaLine =
    event.answeredVia === undefined ? '' : `\n回答経路: ${describeAnsweredVia(event.answeredVia)}`;
  // 構造も JSON で添える: 回答の文は人間向けに畳んだもので、設問 id と選択肢 id の対が文から読み取れないため
  const selectionsLine =
    event.selections === undefined
      ? ''
      : `\n選択（構造。設問 id → 選んだ選択肢 id ＋ その他）: ${JSON.stringify(event.selections)}`;
  return (
    `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}` +
    `${selectionsLine}${viaLine}${waiting}\n\n` +
    'この回答に沿って続きを進めよ。\n\n' +
    HUMAN_ANSWER_CRITERIA_GUIDE
  );
}
