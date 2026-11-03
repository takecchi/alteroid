// 承認の状態（未回答・回答済・取り下げ）の判定の置き場。`schema.ts` を引かない軽いファイル: zod を引き込むとサーバ専用の層がブラウザバンドルへ入るため。
// 新しい出口（package.json の exports）を足さずに web・cli・logic から引けるよう、既存の軽い出口 `@alteroid/core/answered-via` から再公開している。

/** 承認の行のうち、状態の判定に使う 2 つの欄だけ。`null` を許すのは、API 越しの行（web・cli）が欄の無いことを `null` で持つことがあるため。 */
export interface ApprovalStateFields {
  readonly answeredAt?: string | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}

export type ApprovalState = 'withdrawn' | 'answered' | 'unanswered';

/**
 * 欄が「立っている」か。`undefined` と `null` だけが「立っていない」。空文字は「立っている」（型の上は時刻の文字列で空文字は来ないが、来たときは「無い」と決めつけない）。
 * 以前は core・logic・web が `!== undefined`（web は `null` も外す）、cli が真偽（空文字・null を外す）と割れていた。
 */
export function isApprovalFieldSet(value: string | null | undefined): boolean {
  return value !== undefined && value !== null;
}

/**
 * 承認の状態。取り下げを先に見る: 回答の後で取り下げた行・取り下げの後に回答が届いた行（両方立った行）は取り下げ。
 * 取り下げの行は `answer` を持たないので、回答済みを先に見ると破損の分岐に誤って落ちる。
 */
export function approvalStateOf(approval: ApprovalStateFields): ApprovalState {
  if (isApprovalFieldSet(approval.withdrawnAt)) return 'withdrawn';
  return isApprovalFieldSet(approval.answeredAt) ? 'answered' : 'unanswered';
}
