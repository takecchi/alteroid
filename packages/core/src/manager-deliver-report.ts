import { excerptLine } from './excerpt.js';
import { reportDeliveryTextOf, reportFullTextOf } from './manager-notices.js';
import { failedReportBodyOf, partialBeforeFailureOf } from './quota-stop-notice.js';
import type { ManagerReportFiles } from './manager-outbox-fetch.js';
import type { JournalEntryInput } from './schema.js';
import { WITHHELD_REPORT_EXCERPT } from './withheld-reports.js';

/*
 * `Pool#deliverReport`（`report` の段4）の、状態にも時計にも触れない同期の部分（`Pool` から切り出した。振る舞いは変えていない）。
 * 時計（`#now`）の読み・`#fetchReportFiles` / `#journal` / `#emit` ほかの協力者の呼び出し・`await`・早い `return` の骨格は `Pool` に残す:
 * 注入された時計は呼び出しごとに違う値を返しうるので、読む回数と位置は `Pool` が握り、ここへは値で渡す。
 */

type DecisionEntry = Extract<JournalEntryInput, { type: 'decision' }>;

/** 添えられたもの・断ったものが在るか（在れば `Pool` が取りに行く。無ければ `await` を挟まない）。 */
export function hasReportFileRefs(event: {
  files?: readonly unknown[];
  rejectedFiles?: readonly unknown[];
}): boolean {
  return (event.files?.length ?? 0) > 0 || (event.rejectedFiles?.length ?? 0) > 0;
}

/** 取って来た結果に、添付か断った理由が在るか。 */
export function carriesFilesOf(reportFiles: ManagerReportFiles | undefined): boolean {
  return (
    reportFiles !== undefined &&
    (reportFiles.attachments.length > 0 || reportFiles.rejected.length > 0)
  );
}

/** 外へ出した成果を含むので畳まず受信箱へ回す、という日誌の `decision`。 */
export function outwardReportDecisionOf(
  managerId: string,
  outwardActions: readonly string[],
  awaitingBackground: { count: number },
): DecisionEntry {
  return {
    type: 'decision',
    decision: `[${managerId}] 背景処理の完了待ちのターンだが、外へ出した成果を含むので受信箱へ回す`,
    grounds:
      `managerId=${managerId} ` +
      `outwardActions=${outwardActions.join(', ')} ` +
      `awaitingBackground.count=${String(awaitingBackground.count)}`,
  };
}

/** 背景処理の完了待ちで畳んだので受信箱へ回さない、という日誌の `decision`。 */
export function foldedReportDecisionOf(
  managerId: string,
  text: string,
  awaitingBackground: { count: number; breakdown: string },
): DecisionEntry {
  return {
    type: 'decision',
    decision: `[${managerId}] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない`,
    grounds:
      `managerId=${managerId} ` +
      `awaitingBackground.count=${String(awaitingBackground.count)} ` +
      `breakdown=${awaitingBackground.breakdown} ` +
      `本文冒頭: ${excerptLine(text, WITHHELD_REPORT_EXCERPT)}`,
    routine: true,
  };
}

/** 畳んだ後に同じ担当の `closed` に追い越されたと分かり、実際には配ったことを足す日誌の `decision`。 */
export function overtakenReportDecisionOf(
  managerId: string,
  text: string,
  awaitingBackground: { count: number },
): DecisionEntry {
  return {
    type: 'decision',
    decision: `[${managerId}] 同じ担当の closed に追い越されたので、畳まずに受信箱へ配った`,
    grounds:
      `managerId=${managerId} ` +
      `awaitingBackground.count=${String(awaitingBackground.count)} ` +
      `本文冒頭: ${excerptLine(text, WITHHELD_REPORT_EXCERPT)}`,
    routine: true,
  };
}

/** `foldedTurn` は本文の文言ではなく構造化された印（`event.failure` / `event.unreported`）だけで判定する。 */
export function foldedTurnOf(event: { failure?: unknown; unreported?: unknown }): boolean {
  return event.failure !== undefined || event.unreported !== undefined;
}

/** `quotaMarkOf` へ渡す第 1・第 3 引数。第 2 引数の `now` は `Pool` が（この組み立ての後に）読んで渡す。 */
export function quotaMarkArgsOf(text: string): {
  source: { text?: string };
  extra: { sdkText?: string; said?: string };
} {
  const body = failedReportBodyOf(text);
  const said = partialBeforeFailureOf(text);
  return {
    source: body === undefined ? {} : { text: body },
    extra: {
      ...(body === undefined ? {} : { sdkText: body }),
      ...(said === undefined ? {} : { said }),
    },
  };
}

/** `#emit` へ渡す報告の本文。系統3の節約が無効なら、途中の発言を含む全文を配る（#5269 の前の形）。 */
export function reportEmitTextOf(
  tokenSavingExcerpt: boolean,
  event: { managerId: string; text: string; fullText?: string },
): string {
  return tokenSavingExcerpt ? reportDeliveryTextOf(event) : reportFullTextOf(event);
}
