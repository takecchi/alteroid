// 人間への確認と承認（ask_human / request_permission / approvals_list / approval_trace / approval_withdraw）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { approvalShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { renderApprovalTrace, traceApproval } from './approval-trace.js';
import { stripNulDeep } from './nul-guard.js';
import { validatePermissionRequest } from './permission-rule.js';
import {
  describePage,
  excerpt,
  excerptLine,
  fillListingBudget,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';
import { commandHeadWord, type RecentDenial } from './denial-shape.js';
import {
  PERMISSION_GRANT_CONSENT_PHRASE,
  approvalQuestionSchema,
  type PendingApproval,
} from './schema.js';
import {
  describeQuestionLines,
  describeQuestionsViolation,
  summarizeQuestions,
} from './approval-choices.js';
import { UnreadableApprovalError, describeUnreadableApprovals, type Stores } from './store.js';
import {
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import { tool, text, appendJournalOrThrow, foldFixedFor } from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

const APPROVAL_LIST_BUDGET = 8_000;

const APPROVAL_QUESTION_EXCERPT = 200;

function describeUnreadableApproval(id: string): string {
  return `承認待ち ${id} は在るが読めない（壊れた行。消されたのではない。id は合っている）。行は書き換えていない。`;
}

const APPROVAL_PAGE = 8_000;

// `APPROVAL_LIST_BUDGET` と値が同じでも使い回さない: 片方だけ直したくなったとき一緒に動くため
const APPROVAL_TRACE_BUDGET = 8_000;

const APPROVAL_TRACE_SUMMARY_EXCERPT = 200;

const APPROVAL_TITLE_EXCERPT = 60;

// 詳細が予算に入りきらないときに出す、全件の短い索引の字数の予算と件名の長さ（#4997）: 索引だけで出力が際限なく育たないため。
// 詳細はこの索引が使った分を `APPROVAL_LIST_BUDGET` から引いた残りで出すので、一覧の全体は今と同じ大きさに収まる
const APPROVAL_INDEX_BUDGET = 4_000;

const APPROVAL_INDEX_TITLE_EXCERPT = 30;

// 索引が食い尽くしても、詳細に最低これだけは残す
const APPROVAL_DETAIL_MIN_BUDGET = 2_000;

function approvalTitle(question: string): string {
  const firstLine = (question.split('\n', 1)[0] ?? '').trim();
  // 空の札を出さない: 空欄は「名前が無い」のか「取り忘れ」なのか区別できないため、1行目が空なら全体を潰した抜粋へ落とす
  return excerpt(
    firstLine === '' ? question.replace(/\s+/g, ' ').trim() : firstLine,
    APPROVAL_TITLE_EXCERPT,
  );
}

class ApprovalNotRecordedError extends Error {
  constructor(approval: PendingApproval, cause: unknown) {
    super(formatApprovalNotRecordedMessage(approval, cause));
    this.name = 'ApprovalNotRecordedError';
  }
}

function formatApprovalNotRecordedMessage(approval: PendingApproval, cause: unknown): string {
  const shape = approvalShape(approval);
  const reason = collapseErrorCause(cause);
  return [
    '⚠⚠ 未記録・確認は人間へ届いていない・やり直してよい',
    'ask_human は承認待ちキューへの記録に失敗した。人間はまだこの質問を見ていない。',
    `記録できなかった確認: ${shape}`,
    `理由: ${reason}`,
    'やり直してよい（同じ内容でもう一度呼べる。id は呼ぶたびに新しく振られるので重複は起きない）。',
  ].join('\n');
}

const PERMISSION_EVIDENCE_EXCERPT = 400;

// クローンの要約を挟まない: 要約の誤りが承認画面へ載るのを防ぐため。見つからないときも1行で言う: 黙って省くと「証拠が無い」ことが読めないため
export function describePermissionEvidence(
  rule: string,
  recentDenials: (() => readonly RecentDenial[]) | undefined,
): string {
  if (recentDenials === undefined) {
    return '直前の拒否: この層は拒否の記録を読む口を持たない（照合していない）。';
  }
  const wrapped = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(rule);
  const tool = wrapped?.[1];
  const content = wrapped?.[2]?.replace(/:\*$/, '');
  const headWord = content === undefined ? undefined : commandHeadWord(content);
  if (tool === undefined || headWord === undefined) {
    return '直前の拒否: 規則から道具と先頭の語が取れないので、照合していない。';
  }
  const found = [...recentDenials()]
    .reverse()
    .find((it) => it.tool === tool && it.headWord === headWord);
  if (found === undefined) {
    return `直前の拒否: この規則と照合できる直前の拒否（${tool} / 先頭の語 ${headWord}）は、このセッションの記録に無い。`;
  }
  const parts = [
    `時刻 ${found.at}`,
    `道具 ${found.tool}`,
    `先頭の語 ${headWord}`,
    found.reasonType === undefined
      ? undefined
      : `分類 ${excerptLine(found.reasonType, PERMISSION_EVIDENCE_EXCERPT)}`,
    found.reason === undefined
      ? undefined
      : `理由 ${excerptLine(found.reason, PERMISSION_EVIDENCE_EXCERPT)}`,
    found.message === undefined
      ? undefined
      : `拒否文 ${excerptLine(found.message, PERMISSION_EVIDENCE_EXCERPT)}`,
  ].filter((part): part is string => part !== undefined);
  return `直前の拒否（器が返した原文。クローンの要約ではない。長い欄は ${PERMISSION_EVIDENCE_EXCERPT} 字で切る）: ${parts.join(' / ')}`;
}

/** 承認待ちの行へ写す、問いを出したターンが答えていた task の id（空なら欄ごと付けない）。 */
function approvalTaskIdsEntry(context: ToolContext): { taskIds?: string[] } {
  const ids = context.currentTaskIds?.() ?? [];
  return ids.length === 0 ? {} : { taskIds: [...ids] };
}

/** 委譲の起点の会話（`Job.conversationId`）。読めない・見つからないときも `undefined`。 */
// 読めないときに断らない: 起点は承認を会話へ結ぶための手がかりで、無くても従来どおり会話の無い承認として積めるため
async function jobConversationOf(
  stores: Stores,
  managerId: string | undefined,
): Promise<string | undefined> {
  if (managerId === undefined) return undefined;
  try {
    return (await stores.jobs.listJobs()).find((job) => job.id === managerId)?.conversationId;
  } catch {
    return undefined;
  }
}

export function approvalTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores, getConversationId, getWorkConversationId } = shared;
  return [
    // 取り下げても `deny` は自動で飛ばさない: 取り下げの場面で人間は何も言っておらず、機械が人間の承認を偽造することになるため
    tool(
      'ask_human',
      [
        '人間に確認する。記憶に根拠が無いことだけをここへ回す。',
        'これは承認待ちキューに積むだけで、人間の応答を待たない。',
        '止まるのはこの件だけであり、他の仕事は進めてよい。',
        '回答は後から受信箱に届く。',
        '不要になったら approval_withdraw で理由付きで取り下げられる（未回答のうちだけ）。',
        '複数の案から選んでもらうときは、question の本文に (a)(b)(c) を書くより questions を使うほうが人間が答えやすい（選択肢を押して答えられる）。',
        'questions は任意で、question（全体の前置き・背景）は必須のまま。',
        '各設問は { id, prompt, options: [{ id, label, description?, recommended? }], multiple?, allowOther? }。',
        'id は設問が承認待ちの中で、選択肢は設問の中で一意にする。multiple: true で複数選択、allowOther は既定 true（選択肢の最後に自由入力の「その他」が付く）。',
        'あなたの推しの選択肢には recommended: true を付ける。',
        '例: question: "デプロイ先を決めたい"、questions: [{ id: "target", prompt: "デプロイ先は？", options: [{ id: "railway", label: "Railway", recommended: true }, { id: "fly", label: "Fly.io" }] }, { id: "notify", prompt: "通知する先（複数可）", multiple: true, allowOther: false, options: [{ id: "slack", label: "Slack" }, { id: "mail", label: "メール" }] }]。',
        '人間の回答は「Q1 デプロイ先は？: (a) Railway［推奨］ / その他: …」のような文に畳まれて届き、構造（設問 id → 選んだ選択肢 id）も添えられる。未回答の設問は「未回答」と出る。',
      ].join(' '),
      {
        question: z.string().describe('人間への質問。何を判断してほしいかを具体的に'),
        context: z.string().optional().describe('判断に必要な背景'),
        questions: z
          .array(approvalQuestionSchema)
          .optional()
          .describe(
            '選んで答えてほしい設問（任意）。設問の id は一意、選択肢の id は設問の中で一意（重複は断られる）。' +
              '複数案の提示は question に (a)(b)(c) を書かずこちらへ',
          ),
        managerId: z
          .string()
          .optional()
          .describe('マネージャーからの確認を人間に回す場合、その manager_id'),
        // 生ログの id では通らない: `request_id` は生ログの `tool_use_id` や API の request id とは名前空間が違うため
        requestId: z
          .string()
          .optional()
          .describe(
            'マネージャーからの確認を人間に回す場合、受信箱に届いた requestId。' +
              '人間の回答をこの確認へ返すために必要なので、managerId と必ず対で渡すこと。' +
              '⚠️ 通るのは受信箱に確認として届いた requestId だけである（生ログから拾った id は通らない。形の詳細は manager_send の requestId）',
          ),
      },
      async ({ question, context: background, questions, managerId, requestId }) => {
        if (questions !== undefined) {
          const violation = describeQuestionsViolation(questions);
          if (violation !== null) return text(`承認待ちには積まなかった: ${violation}`);
        }
        const questionError =
          describeStringLengthViolation('question', question, { min: 1 }) ??
          describeBlankViolation('question', question);
        if (questionError !== null) return text(`承認待ちには積まなかった: ${questionError}`);
        // 回す確認の委譲の起点を、ターンの起点より先に見る: 別の委譲の報告を読んでいるターンで回すこともあるため
        const conversationId =
          getConversationId() ??
          (await jobConversationOf(stores, managerId)) ??
          getWorkConversationId();
        await context.flushReply?.();
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          ...(background === undefined ? {} : { context: background }),
          ...(questions === undefined || questions.length === 0 ? {} : { questions }),
          ...(managerId === undefined ? {} : { jobId: managerId }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...approvalTaskIdsEntry(context),
        };
        try {
          await stores.jobs.putApproval(approval);
        } catch (error) {
          noteDroppedRecord('承認待ち', approvalShape(approval), error);
          throw new ApprovalNotRecordedError(approval, error);
        }
        await appendJournalOrThrow(
          'ask_human',
          stores.journal,
          {
            type: 'escalation',
            question,
            approvalId: approval.id,
          },
          'act-completed',
        );
        // 問いを積んだ時点で控える（日誌が書けなかった呼びは上で投げており、ここへ来ない）。
        // ターンの会話があれば conversationId はそれと同じ（上の連鎖の先頭）なので、1回だけ呼ぶ
        context.noteQuestionAsked?.(conversationId);
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(`承認待ちキューに積んだ（${approval.id}）。回答は後から届く。`);
      },
    ),

    // 自己矛盾した要求はキューに積む前に拒否する: 人間の確認画面に壊れた要求を出さないため
    // 許可の記録はここで持たない: 道具から許可を書く経路は作らないため
    tool(
      'request_permission',
      [
        '特定の Bash コマンドの規則を、以降は聞かずに通してよいか人間に確認する。',
        'rule は Bash(<完全なコマンド>) の完全一致か、Bash(<前方一致>:*) の前方一致（語境界で切る）。',
        'allows にはその規則が通すべき具体例、denies には通ってはならない具体例を挙げる——',
        '両方とも検算する（allows が1つでも規則に一致しない・denies が1つでも一致してしまうなら、',
        'この道具はキューに積む前に拒否する）。',
        '積むだけで人間の応答は待たない。人間が定型文でちょうど答えなければ許可は記録されない。',
        '質問文には、同じ道具・同じ先頭の語の直前の拒否（器が返した理由の原文・時刻）が自動で添えられる（コマンドの値は添えない）。',
      ].join(' '),
      {
        rule: z.string().describe('Bash(<完全な文字列>) または Bash(<前方一致>:*) の形の規則'),
        allows: z
          .array(z.string())
          .describe('この規則が通すべき具体的なコマンド例（1件以上、全部が規則に一致すること）'),
        denies: z
          .array(z.string())
          .describe('この規則が拒むべき具体的なコマンド例（1件以上、1件も規則に一致しないこと）'),
        reason: z.string().describe('なぜこの許可が要るか。人間が承認画面で読む理由文'),
      },
      async (args) => {
        // 検算は承認の行に残る値と同じもので行う: 入口で NUL が落ちるので、落とす前の値で検算すると通ったはずの要求が自己矛盾するため
        const { rule, allows, denies, reason } = stripNulDeep(args);
        const validation = validatePermissionRequest({ rule, allows, denies });
        if (!validation.ok) {
          return text(
            `request_permission を拒否した（キューに積んでいない）: ${validation.reason}`,
          );
        }
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) {
          return text(`request_permission を拒否した（キューに積んでいない）: ${reasonError}`);
        }

        const conversationId = getWorkConversationId();
        const question =
          `以降 ${rule} を聞かずに通してよいか。理由: ${reason}\n` +
          `通る例: ${allows.join(' / ')}\n通らない例: ${denies.join(' / ')}\n` +
          `${describePermissionEvidence(rule, context.recentDenials)}\n` +
          `許可するなら「${PERMISSION_GRANT_CONSENT_PHRASE}」とだけ答える（句点や言い換えがあると記録しない）。`;
        await context.flushReply?.();
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          context: reason,
          permissionRequest: { rule, allows: [...allows], denies: [...denies] },
          ...(conversationId === undefined ? {} : { conversationId }),
          ...approvalTaskIdsEntry(context),
        };
        try {
          await stores.jobs.putApproval(approval);
        } catch (error) {
          noteDroppedRecord('承認待ち', approvalShape(approval), error);
          throw new ApprovalNotRecordedError(approval, error);
        }
        await appendJournalOrThrow(
          'request_permission',
          stores.journal,
          {
            type: 'escalation',
            question,
            approvalId: approval.id,
          },
          'act-completed',
        );
        context.noteQuestionAsked?.(conversationId);
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(
          `承認待ちキューに積んだ（${approval.id}）。人間が「${PERMISSION_GRANT_CONSENT_PHRASE}」とちょうど答え、` +
            'かつ許可されたアカウント経由の回答だった場合だけ、以降この規則に一致する Bash が自動で通る。',
        );
      },
    ),

    tool(
      'approvals_list',
      [
        'いま人間の回答を待っている件の一覧。',
        '人間が席に居ないあいだに溜まる。溜まっていても他の仕事は進めてよい。',
        '一覧の質問は抜粋で、全文が要る1件は id を渡して取る。',
        '一覧の各件は作成時刻だけを出す（回答待ちだけの一覧なので、更新はいつも作成と同じ）。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, offset = 0 }, extra: unknown) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          let approval: PendingApproval | null;
          try {
            approval = await stores.jobs.getApproval(id);
          } catch (error) {
            if (error instanceof UnreadableApprovalError)
              return text(describeUnreadableApproval(id));
            throw error;
          }
          if (!approval) return text(`承認待ち ${id} は無い（id が違う）。`);
          // 答えが付いた件も取り下げた件も読める: 「その質問が何だったか」は終端が付いた後にこそ要るため
          const status =
            approval.withdrawnAt !== undefined
              ? `${approval.withdrawnAt} に取り下げ`
              : approval.answeredAt === undefined
                ? '回答待ち'
                : `${approval.answeredAt} に回答済み`;
          const head =
            `${approval.id}（${approval.createdAt}）` +
            status +
            (approval.jobId === undefined
              ? ''
              : ` / 宛先 managerId: "${approval.jobId}"` +
                (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`));
          const body = [
            `質問: ${approval.question}`,
            ...(approval.context === undefined ? [] : [`背景: ${approval.context}`]),
            ...(approval.questions === undefined
              ? []
              : [`設問:\n${describeQuestionLines(approval.questions).join('\n')}`]),
            ...(approval.answer === undefined ? [] : [`回答: ${approval.answer}`]),
            ...(approval.withdrawnReason === undefined
              ? []
              : [`取り下げた理由: ${approval.withdrawnReason}`]),
          ].join('\n\n');
          const part = page(body, offset, APPROVAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは approvals_list id=${approval.id} offset=${part.to}）`
            : '';
          return text(`${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // ここで全順序にする（`createdAt` 昇順、同着は `id` 昇順）: この一覧は予算で切るので、並びがストア実装依存だと切り落とされる側が構成によって変わるため
        // ストア側の `orderBy` は消さない: 消すと pg が大きな表を未整列のまま全件返してからここで並べることになるため
        const approvalList = await stores.jobs.listApprovals({ pendingOnly: true });
        const pending = [...approvalList.entries].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        // 読めない行は一覧から消さず、件数と id で言う
        const unreadableNote = describeUnreadableApprovals(approvalList.unreadable);
        if (pending.length === 0) {
          return text(
            unreadableNote === null
              ? '（人間の回答待ちは無い）'
              : `（読めた回答待ちは無い）\n${unreadableNote}`,
          );
        }
        const items = pending.map((approval) =>
          renderListingEntry({
            id: approval.id,
            title: approvalTitle(approval.question),
            // 更新は出さない: 回答待ちだけの一覧では `approvalUpdatedAt` が常に `createdAt` と同じで、同じ時刻の2回目は情報にならないため（読み方は説明文が持つ）
            createdAt: approval.createdAt,
            summary: excerptLine(approval.question, APPROVAL_QUESTION_EXCERPT),
            extra: [
              approval.questions === undefined || approval.questions.length === 0
                ? null
                : `  ${summarizeQuestions(approval.questions)}（詳細は approvals_list id=<id>）`,
              approval.jobId === undefined
                ? null
                : `  宛先: managerId: "${approval.jobId}"` +
                  (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`),
            ],
          }),
        );
        // 末尾の固定の注記は、同じ会話の2回目から札にする（質問が抜粋であること・並びの向きは札にも残す）。
        // 件ごとの行（`（詳細は approvals_list id=<id>）`）は畳まない: 予算で出ない件が先に「全文を出した」と控えられるため
        const fold = foldFixedFor(context, extra);
        const notes = [
          fold(
            'approvals-list:note-excerpt',
            '（質問は抜粋。全文は approvals_list id=<id> で取れる。答えが付いた件・取り下げた件も id で開けて、回答/取り下げ理由もそこに出る）',
            '（質問は抜粋。全文は id=<id> で取れる）',
          ),
          ...(unreadableNote === null ? [] : [unreadableNote]),
        ];
        // 詳細が予算に入りきれば、今どおり作成の古い順に全件の詳細を出す
        if (fillListingBudget(items, APPROVAL_LIST_BUDGET, false).rest === 0) {
          return text(
            [
              renderListing(items, { budget: APPROVAL_LIST_BUDGET, omitted: () => '' }),
              ...notes,
              fold(
                'approvals-list:order-note',
                '（並び順: 作成時刻の昇順。同じ作成時刻なら id の昇順で全順序にしてある。保存先の実装には依存しない）',
                '（並び: 作成時刻の昇順、同着は id の昇順）',
              ),
            ].join('\n'),
          );
        }
        // 入りきらないときは、全件の短い索引を頭に出し、詳細は新しい順に入るだけ出す（#4997）:
        // 重複を確かめる口なのに、古い順に先頭から切ると、いちばん要る新しく積んだ問いが必ず落ちるため
        // 索引の行は `- ` で始めない: `- ` は1件の詳細（id・件名／作成・更新／概要）の頭として読まれるため
        // 予算に入りきらなければ古い側を件数で省く: 重複を確かめたいのは新しく積んだ側のため
        const indexLines = renderListingFromEnd(
          pending.map(
            (approval) =>
              `・${approval.id}（${approval.createdAt}）${excerpt(approvalTitle(approval.question), APPROVAL_INDEX_TITLE_EXCERPT)}`,
          ),
          {
            budget: APPROVAL_INDEX_BUDGET,
            omitted: ({ rest }) => `…索引も古い側の ${rest} 件を省いた（id で開ける）。`,
          },
        );
        const newestFirst = [...items].reverse();
        return text(
          [
            `回答待ちは ${pending.length} 件ある。まず索引（id・作成時刻・件名。作成の古い順）:`,
            indexLines,
            '',
            '詳細（新しい順）:',
            renderListing(newestFirst, {
              budget: Math.max(
                APPROVAL_DETAIL_MIN_BUDGET,
                APPROVAL_LIST_BUDGET - indexLines.length,
              ),
              omitted: ({ rest, shown }) =>
                `…ほか ${rest} 件は詳細を省略（新しい順に先頭から ${shown} 件だけ出した。残りは上の索引の id で approvals_list id=<id> として開ける）。`,
            }),
            ...notes,
            fold(
              'approvals-list:order-note-indexed',
              '（索引の並び: 作成時刻の昇順。同じ作成時刻なら id の昇順。詳細はその逆順。保存先の実装には依存しない）',
              '（索引は作成時刻の昇順、同着は id の昇順。詳細はその逆順）',
            ),
          ].join('\n'),
        );
      },
    ),

    // `approvals_list` の `id` モードへ相乗りさせない: 承認の口（`ask_human` / `approvals_list`）の形を変えないと決めているため
    tool(
      'approval_trace',
      [
        '承認への人間の答えと、その答えを受けたターンで自分が取った行動（判断・記憶の更新・道具・返答）を対で並べる。',
        '答えの後で自分が何をしたか、答えと行動が食い違っていないかを確かめるための口で、解釈や一般化は足さない。',
        '対が無いときは、まだ答えが無い／ターンが無い／記録を始める前の答え／記録が動いていない疑い、を分けて言う。',
        '行動は抜粋で、全文は日誌の id を journal_read に渡して取る。',
      ].join(' '),
      {
        id: z.string().describe('承認の id（approvals_list や日誌の escalation に出ている id）'),
      },
      async ({ id }) => {
        let trace: Awaited<ReturnType<typeof traceApproval>>;
        try {
          trace = await traceApproval(stores, id);
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (trace === null) return text(`承認 ${id} は無い（id が違う）。`);
        return text(
          renderApprovalTrace(trace, {
            budget: APPROVAL_TRACE_BUDGET,
            summaryLimit: APPROVAL_TRACE_SUMMARY_EXCERPT,
            detailHint: '（行動は抜粋。全文は journal_read id=<日誌の id> で取れる）',
          }),
        );
      },
    ),

    // 自動 `deny` は選択肢として持たない: 取り下げの場面で人間は何も言っておらず、機械が人間の承認を偽造することになるため
    // `jobId`/`requestId` を持つ件を取り下げ不可にしない: マネージャー自体が既に停止している場合に詰むため
    tool(
      'approval_withdraw',
      [
        '未回答の承認待ちを、理由付きで取り下げる。行は消えず、取り下げた事実と理由が残る。',
        '回答済みの件は取り下げられない（先に answered ならここでは断られる）。',
        '⚠️ マネージャーからの許可確認を人間へ回した件（jobId/requestId 付き）を取り下げても、',
        'そのマネージャーは自動では解放されない——待ったままなら manager_send（decision 付き）で',
        '自分から答えること。ここでの取り下げは「人間の承認キューから消す」だけである。',
      ].join(' '),
      {
        id: z.string().describe('approvals_list に出ている id'),
        reason: z
          .string()
          .describe(
            `なぜ取り下げるか（不要になった経緯・自分で答えを見つけた等。${formatStringLengthJa({ min: 1 })}）。` +
              '人間はこれを読んで後から否定する',
          ),
      },
      async ({ id, reason }) => {
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) return text(reasonError);
        let existing: PendingApproval | null;
        try {
          existing = await stores.jobs.getApproval(id);
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (!existing) return text(`承認待ち ${id} は無い（id が違う）。`);
        if (existing.answeredAt !== undefined) {
          return text(
            `${id} は既に ${existing.answeredAt} に回答済みなので取り下げられない` +
              `（回答: ${existing.answer ?? '（本文なし）'}）。`,
          );
        }
        if (existing.withdrawnAt !== undefined) {
          return text(
            `${id} は既に ${existing.withdrawnAt} に取り下げ済み（理由: ${existing.withdrawnReason ?? ''}）。`,
          );
        }
        const withdrawnAt = new Date().toISOString();
        // 読み直す1操作で書く: 写しを丸ごと書き戻すと、読んでから書くまでの間に入った人間の回答を消してしまうため
        let settledNow: PendingApproval | undefined;
        let written: PendingApproval | null;
        try {
          written = await stores.jobs.updateApproval(id, (current) => {
            if (current.answeredAt !== undefined || current.withdrawnAt !== undefined) {
              settledNow = current;
              return null;
            }
            return { ...current, withdrawnAt, withdrawnReason: reason };
          });
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (written === null) {
          if (settledNow?.answeredAt !== undefined) {
            return text(
              `${id} は既に ${settledNow.answeredAt} に回答済みなので取り下げられない` +
                `（回答: ${settledNow.answer ?? '（本文なし）'}）。`,
            );
          }
          if (settledNow?.withdrawnAt !== undefined) {
            return text(
              `${id} は既に ${settledNow.withdrawnAt} に取り下げ済み（理由: ${settledNow.withdrawnReason ?? ''}）。`,
            );
          }
          return text(`承認待ち ${id} は無い（id が違う）。`);
        }
        // 自分で閉じたことは日誌に残す: 人間が後から否定するための材料は台帳だけでなく日誌にも要るため
        await appendJournalOrThrow(
          'approval_withdraw',
          stores.journal,
          {
            type: 'escalation',
            question: existing.question,
            approvalId: id,
            ...(existing.jobId === undefined ? {} : { managerId: existing.jobId }),
            withdrawnAt,
            withdrawnReason: reason,
          },
          'act-completed',
        );
        const waiting =
          existing.jobId === undefined
            ? ''
            : ` ⚠️ この確認はマネージャー ${existing.jobId} のものである` +
              (existing.requestId === undefined ? '' : `（requestId: "${existing.requestId}"）`) +
              '。取り下げてもそのマネージャーは自動では解放されない——待ったままなら、' +
              '自分から manager_send（decision 付き）で答えて始末をつけること。';
        return text(`${id} を取り下げた。${waiting}`);
      },
    ),
  ];
}
