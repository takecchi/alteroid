import { ApiError } from '~/lib/api';

/**
 * デーモンの `requireOwner` が返す本文（逐語は
 * `grep -Fn -- '実行環境の持ち主として宣言されたアカウントだけが操作できる' apps/daemon/src/app.ts`）。
 * CLI の `apps/cli/src/target.ts` の `forbiddenKindOf` が見る値と同じ。
 */
const NOT_OWNER_ERROR = '実行環境の持ち主として宣言されたアカウントだけが操作できる';

/**
 * 失敗が `requireOwner` の 403 のときだけ、持ち主として宣言する手を案内する。
 *
 * **403 の本文まで見る。** 403 は未許可（`authenticate`）でも返り、そちらの直し方
 * （`access grant`）は別である。判別できない失敗には案内を出さない
 * ——当てずっぽうで片方を出すと、状況によっては必ず嘘になる（CLI の
 * `forbiddenKindOf` と同じ考え方）。
 *
 * `routes/profile.tsx`（#1122）に在ったものを、同じ門（`requireOwner`）の画面
 * `routes/mcp-servers.tsx`（#325 段4）と共有するために切り出した。**`subject` の
 * 他は1文字も変えていない**（`profile.test.tsx` の案内の歯がそのまま通る）。
 */
export function NotOwnerHint({ failure, subject }: { failure: unknown; subject: string }) {
  if (!(failure instanceof ApiError && failure.status === 403)) return null;
  if (failure.message !== NOT_OWNER_ERROR) return null;
  return (
    <p className="text-[11px] break-words text-muted">
      {subject}に触れるのは、持ち主として宣言されたアカウントだけ。アクセスの画面から
      自分のアカウントを持ち主として宣言してください（端末からなら次を実行）:
      <br />
      <code className="font-mono">alteroid access owner &lt;アカウント id&gt;</code>
    </p>
  );
}
