// マネージャーへの委譲の道具のうち `manager_send`。`clone-tools-manager.ts` の `managerTools` が並びのまま連結する。
// このファイルから `clone-tools-manager.ts` を import しない（一方向）。他の道具とも使う補助は `clone-tools-manager-describe.ts` に在る。

import { z } from 'zod';
import { readAttachmentLimits } from './attachment.js';
import { loadManagerAttachments } from './manager-attachments.js';
import { reasonOf } from './dropped-record.js';
import { excerptLine } from './excerpt.js';
import {
  decisionUnusedNote,
  type ManagerPool,
  type ManagerSendOptions,
  type ManagerSendResult,
} from './manager.js';
import { type JournalEntryInput } from './schema.js';
import { type Stores } from './store.js';
import { RESTART_BEFORE_CHECK_ADVICE } from './usage-limits.js';
import { describeStringLengthViolation } from './tool-arg-checks.js';
import {
  text,
  tool,
  NO_POOL,
  appendJournalOrThrow,
  appendJournalOrDrop,
  type ToolText,
  JOURNAL_TEXT_EXCERPT,
  foldFixedFor,
} from './clone-tools-common.js';
import type { ToolContext } from './clone-tools-context.js';
import { CLOSES_SCHEMA, describeClosesViolation, finishWithCloses } from './clone-tools-closes.js';
import { MANAGER_ATTACHMENTS_DESCRIPTION } from './clone-tools-manager-describe.js';

// daemon の `app-routes-managers.ts` の人間の直接送信の行（`excerptLine(text, 200)`）に合わせる
const MANAGER_ANSWER_MESSAGE_EXCERPT = 200;

/** 委譲が結び付いた task（`Job.taskId`）。読めない・見つからない・結び付いていないときは `undefined`（その回は委譲に数えない。走っている委譲は、閉じる直前に別に台帳を引いて見る）。 */
async function jobTaskIdOf(stores: Stores, managerId: string): Promise<string | undefined> {
  try {
    return (await stores.jobs.listJobs()).find((job) => job.id === managerId)?.taskId;
  } catch {
    return undefined;
  }
}

// 送れなかった（早い断り・保留・失敗）呼びは1行も閉じず、そう書く
function finishManagerSendNotDone(
  stores: Stores,
  res: ToolText,
  closes: readonly { id: string; reason: string }[] | undefined,
) {
  return finishWithCloses(stores, res, closes, false, 'manager_send');
}

// 先に書いた回答の行を書けたかを持つ箱（書けた確認の requestId）。`beforeAnswer` の中で代入する
type ManagerSendAnswerJournaled = { requestId?: string };

function buildManagerSendAnswerJournalEntry(args: {
  managerId: string;
  pending: { requestId: string; summary: string };
  decision: ManagerSendOptions['decision'];
  message: string;
}): JournalEntryInput {
  const { managerId, pending, decision, message } = args;
  return {
    type: 'decision',
    decision:
      `クローンが担当 ${managerId} の確認（${pending.requestId}: ` +
      `${excerptLine(pending.summary, JOURNAL_TEXT_EXCERPT)}）に自分で答える` +
      `（decision=${decision ?? '指定なし（runner が本文から読む）'}。` +
      `抜粋: ${excerptLine(message, MANAGER_ANSWER_MESSAGE_EXCERPT)}）`,
    grounds:
      'クローン自身が manager_send で、人間に聞かずに答えた（根拠は記憶。人間はこれを読んで後から否定する）',
  };
}

function buildManagerSendRetractJournalEntry(args: {
  managerId: string;
  answeredRequestId: string;
  detail: string;
}): JournalEntryInput {
  const { managerId, answeredRequestId, detail } = args;
  return {
    type: 'decision',
    decision:
      `クローンが担当 ${managerId} の確認（${answeredRequestId}）へ答えるとした直前の回答の行は` +
      `効いていない（答えは届いていない）。理由: ${excerptLine(detail, MANAGER_ANSWER_MESSAGE_EXCERPT)}`,
    grounds: '先に書いた回答の行の後で、答えが届かなかったため打ち消す',
  };
}

// 先に書いた行が効かなかったとき（答えが届かなかった）の打ち消し。書けなければ跡だけ残す
async function retractManagerSendAnswerJournal(
  stores: Stores,
  managerId: string,
  answerJournaled: ManagerSendAnswerJournaled,
  detail: string,
): Promise<void> {
  if (answerJournaled.requestId === undefined) return;
  await appendJournalOrDrop(
    'manager_send',
    stores.journal,
    buildManagerSendRetractJournalEntry({
      managerId,
      answeredRequestId: answerJournaled.requestId,
      detail,
    }),
  );
}

// 例外で終わったときも打ち消してから投げ直す（`try` の範囲は `pool.send` の呼びだけ）
async function sendManagerMessage(args: {
  pool: ManagerPool;
  stores: Stores;
  managerId: string;
  message: string;
  decision: ManagerSendOptions['decision'];
  requestId: string | undefined;
  attachments: NonNullable<ManagerSendOptions['attachments']>;
  answerJournaled: ManagerSendAnswerJournaled;
}): Promise<ManagerSendResult> {
  const { pool, stores, managerId, message, decision, requestId, attachments, answerJournaled } =
    args;
  try {
    return await pool.send(managerId, message, {
      ...(decision === undefined ? {} : { decision }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(attachments.length === 0 ? {} : { attachments }),
      beforeAnswer: async (pending) => {
        await appendJournalOrThrow(
          'manager_send',
          stores.journal,
          buildManagerSendAnswerJournalEntry({ managerId, pending, decision, message }),
          'act-not-performed',
        );
        answerJournaled.requestId = pending.requestId;
      },
    });
  } catch (error) {
    await retractManagerSendAnswerJournal(
      stores,
      managerId,
      answerJournaled,
      `送信が例外で終わった: ${reasonOf(error)}`,
    );
    throw error;
  }
}

function renderManagerSendSessionMissing(managerId: string, detail: string): string {
  return (
    `[${managerId}] ${detail}\n` +
    '**この委譲そのものは台帳に在る**（「そんな id は無い」ではない）。' +
    'runner に生きたセッションが無く、resume でも入り直せなかっただけである。' +
    'manager_list で状態を確かめ、時間で解ける理由（引き取り中・貸し出し期限）' +
    'なら少し置いてから送り直すこと。' +
    RESTART_BEFORE_CHECK_ADVICE
  );
}

function renderManagerSendHeld(detail: string, unusedNote: string): string {
  return `${detail}${unusedNote}`;
}

// 毎回返る文なので短く保つ（理由の詳しい説明は道具の説明文の側に1回だけ置く）: 送るたびにクローンの文脈へ積まれ、読み直しの費用になるため
// 「届けた」が保証する範囲を名乗る: 観測したのは resume の口が成功を返したところまでで、相手がこの本文を読んだかは見ていないため
// 「同じ本文で立て直さないこと」は落とさない: 送った直後の `manager_list` が `lost` のままで、クローンが指示を失ったと判断し出し直した実害があるため
// 札にする側（2回目から）の結論の「同じ本文で新しい委譲を立てない」も残す。畳みの口を呼ぶので、返す直前に1回だけ呼ぶこと
function foldManagerSendDeliveredNote(context: ToolContext, extra: unknown): string {
  return foldFixedFor(context, extra)(
    'manager-send:delivered-note',
    '（「届けた」は resume の口が成功を返したところまで。読んだかは manager_report で見る。' +
      '同じ本文で新しい委譲を立てないこと）',
    '（届けたのは resume の口まで。同じ本文で新しい委譲を立てないこと）',
  );
}

function renderManagerSendDelivered(
  managerId: string,
  detail: string,
  unusedNote: string,
  deliveredNote: string,
): string {
  return `[${managerId}] ${detail}${unusedNote}\n${deliveredNote}`;
}

export function managerSendTool(context: ToolContext, stores: Stores) {
  return tool(
    'manager_send',
    [
      '走行中のマネージャーへ追加指示を送る、または止まっている質問・許可確認に答える。',
      'requestId か decision を付けたときだけ回答として扱う（止まっていたその仕事だけが再開する）。',
      'どちらも無い本文は、相手が返事待ちでも回答にはならず追加指示として届く。',
      '許可確認への回答では decision を必ず付けること。',
      // 答える先の無い合図に decision を付けさせない: requestId 無しの decision は待ちが1件ならその1件へ当たり、無関係の確認を許可してしまうため
      // 答え方の細則（allow のあとの撃ち直し・一時規則・伝える文言）はここに書かない: 確認の本文が言うため（`classifier-denial-streak.ts` の `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH*`、`manager.ts` の `DENIAL_REPLY_ROUTE`）。ここに残すのは、本文に無い規則と、どの本文を読むかの指し先だけ
      '許可確認は2種類（分類器の拒否の確認は requestId が toolu_… の形、それ以外は UUID の形）で、答えたあとが違う。' +
        '答え方の細則は、届いた確認の本文が言う。' +
        'allow のあとに撃ち直し方を伝えるときは、decision を付けない追加指示で送ること。',
      '確認として届かない拒否の合図（拒否の報告だけが届いた回）には requestId が無く、許可として答える口は無い。' +
        'requestId 無しの decision は付けないこと（待っている別の確認へ当たりうる）。答え方は報告の本文が言う。',
      'manager_list が [running] と出していても、runner の側でセッションが畳まれていることがある' +
        '（その合図が届かなかった窓）。そのときは resume から入り直して届けるので、' +
        '返り値にそう書いてある。入り直せなかったときも「そんな id は無い」ではなく' +
        '「セッションが無い」と返る——委譲そのものは台帳に在るので、manager_start で' +
        '起こし直す前に、返ってきた文言をそのまま読むこと。',
      // 「セッションが無い」を「仕事が失われた」と読ませない: 完遂後に畳まれた回も同じ形に見え、決めつけると完遂済みの仕事を委譲し直すため
      // 「届けた」の保証の範囲はここに1回だけ詳しく書く: 返り値は送るたびに文脈へ積まれるので短くしてある
      '返り値の「届けた」が保証するのは、runner の resume の口を叩いて成功が返ったところまでで、' +
        '相手がこの本文を読んだかは見ていない。黙った器に載っている委譲へも送信は実際に届くので、' +
        '直後の manager_list が lost／セッション切断のままでも「届かなかった」とは読まず、' +
        '同じ本文で新しい委譲を立てないこと（同じ仕事が2本になる）。',
      'セッションが無いことは、その仕事が失われたことを意味しない——完遂した後に' +
        'セッションが畳まれ、終端イベントだけが届かなかった回も同じ形になる。' +
        '委譲し直す前に必ず manager_report を見ること（報告が空でも、生ログから' +
        '「生成されたが配られていない」報告を拾える）。',
    ].join(' '),
    {
      managerId: z.string().describe('manager_start が返した id'),
      message: z
        .string()
        .describe('マネージャーへの本文。deny のときは、なぜ駄目でどうしてほしいかを書く'),
      attachments: z.array(z.string().min(1)).optional().describe(MANAGER_ATTACHMENTS_DESCRIPTION),
      // `deny` を機械的に流さない: 受け取るマネージャーは「人間が拒否した」としか読めず、人間の承認の偽造になるため
      decision: z
        .enum(['allow', 'deny'])
        .optional()
        .describe('許可確認への回答のとき必須。それ以外では不要'),
      // 生ログの id では通らない: 名前空間の違う id は「待っていない」に落ち、「まだ届いていない」と見分けが付かないため
      requestId: z
        .string()
        .optional()
        .describe(
          'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
            '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること。' +
            '⚠️ 通るのは受信箱に確認として届いた requestId だけである。分類器の拒否の確認では toolu_… の形のことがあるが、' +
            '生ログから拾った toolu_…（tool_use_id）や req_…（API の request id）は、確認として届いていなければ通らない。' +
            '受信箱に届いていない確認に、生ログから答える手段は無い',
        ),
      closes: CLOSES_SCHEMA,
    },
    async ({ managerId, message, decision, requestId, attachments, closes }, extra: unknown) => {
      // 閉じる指定の誤りは、送る前に丸ごと断る（送ってから閉じる側だけ断ると、半分だけ済んだ呼びになるため）
      const closesError = describeClosesViolation(closes);
      if (closesError !== null) return text(closesError);
      if (!context.managers) return finishManagerSendNotDone(stores, NO_POOL, closes);
      // 空白だけは断らない: HTTP も通すため
      const messageError = describeStringLengthViolation('message', message, { min: 1 });
      if (messageError !== null) {
        return finishManagerSendNotDone(stores, text(messageError), closes);
      }
      const handover = await loadManagerAttachments(
        stores,
        attachments ?? [],
        context.attachmentLimits ?? readAttachmentLimits().limits,
      );
      if (!handover.ok) return finishManagerSendNotDone(stores, text(handover.message), closes);
      // 答える前に判断の行を書く: 答えが届いたのに跡が無い窓を作らないため。
      // この道具は自己記録なので PostToolUse の行が無く、この行が「クローンが人間に聞かず答えた」唯一の跡になる。
      // 行を書いたかを旗で持つ: 確認に当たらなかった送信では呼ばれず、書いていない行は打ち消さない
      // 関数へ渡して代入させるので、`let` ではなく箱にする
      const answerJournaled: ManagerSendAnswerJournaled = {};
      const result = await sendManagerMessage({
        pool: context.managers,
        stores,
        managerId,
        message,
        decision,
        requestId,
        attachments: handover.attachments,
        answerJournaled,
      });
      if (result.outcome !== 'answered') {
        await retractManagerSendAnswerJournal(stores, managerId, answerJournaled, result.detail);
      }
      // 届いた（delivered）か答えた（answered）ときだけ閉じる。それ以外は本来の作業が通っていない
      const sent = result.outcome === 'delivered' || result.outcome === 'answered';
      // 既存の委譲へ頼んだターンも、委譲に数える（その委譲に結び付いた task〔Job.taskId〕を、このターンの返答で自動 done にしない。#5469 P5）
      if (sent) context.noteDelegationStarted?.(await jobTaskIdOf(stores, managerId));
      // `session_missing` は必ず言い足す: そのものは居る側なので、`manager_start` で起こし直すと同じ仕事が2本になりうるため
      if (result.outcome === 'session_missing') {
        return finishManagerSendNotDone(
          stores,
          text(renderManagerSendSessionMissing(managerId, result.detail)),
          closes,
        );
      }
      // 警告の文は HTTP（POST /managers/:id/messages）と共有する（`decisionUnusedNote`）
      const unusedNote = decisionUnusedNote(decision, requestId, result.outcome);
      if (result.outcome === 'held') {
        return finishManagerSendNotDone(
          stores,
          text(renderManagerSendHeld(result.detail, unusedNote)),
          closes,
        );
      }
      if (result.outcome === 'delivered') {
        // 脚注は同じ会話の2回目から札にする。返す直前のここで呼ぶ
        const deliveredNote = foldManagerSendDeliveredNote(context, extra);
        return finishWithCloses(
          stores,
          text(renderManagerSendDelivered(managerId, result.detail, unusedNote, deliveredNote)),
          closes,
          sent,
          'manager_send',
        );
      }
      return finishWithCloses(stores, text(result.detail), closes, sent, 'manager_send');
    },
  );
}
