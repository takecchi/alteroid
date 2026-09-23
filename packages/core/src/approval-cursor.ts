/**
 * 承認待ち（`PendingApproval`）の位置（`(createdAt, id)`）と、その keyset の比較。
 * 使う側は `GET /approvals`（`apps/daemon/src/app.ts`）の `cursor` である。
 *
 * **`packages/core` は `apps/daemon` に依存できない**（依存の向きが逆——
 * `apps/daemon` が `@alteroid/core` を使う側）。台帳の側（`commitment-cursor.ts`）
 * は同じ契約を独立に2度実装して「歯で見張る」形にしたが、**その PR（#641）自身が
 * 「両側の歯はそれぞれ自分の実装しか見ていないので、片方だけを直しても赤くならない
 * ＝見張りとして成立していない」と結論して、位置と比較の2関数を core へ寄せた。**
 * ここではその結論を最初から採る——`ApprovalPagingKey` と2つの比較関数は
 * `apps/daemon/src/app.ts` から**移設したもので、中身は1バイトも変えていない。**
 * app.ts はこのファイルから import する側になった。
 *
 * ## `approvals_list` の継続点は、ここには無い（Issue #1392）
 *
 * かつてこのファイルには、クローンの道具 `approvals_list`（一覧モード）の継続点
 * （issue #640）として `encodeApprovalCursor` / `decodeApprovalCursor` /
 * `resolveApprovalCursor` が在った（PR #661）。**しかし `tools.ts` へは一度も
 * 配線されず、本番の呼び出し元は0件のまま**だった（`approvals_list` の引数は今も
 * `id` / `offset` だけである）。呼び手も利用者もいない関数は、いちばん可逆で小さい
 * 形として削った（#1392）。**配線が要るようになったら、PR #661 の版を git から
 * 戻して、`tools.ts` への配線と一緒に入れ直すこと**——配線の無い部品だけを先に
 * 置くと、同じ形でまた呼び出し元0件の関数が残る。
 */

/** `(createdAt, id)` で表した承認待ち1件の位置。 */
export type ApprovalPagingKey = { id: string; createdAt: string };

/**
 * `(createdAt, id)` の昇順比較。同時刻は `id` で決める。
 *
 * `apps/daemon/src/app.ts` から移設した（移設の時点で中身は1バイトも変えて
 * いない）。`createdAt` を文字列のまま比較するのは、`new Date().toISOString()`
 * が返す固定形式（UTC・ミリ秒3桁・`Z` 終端）に乗っているためである——理由の
 * 全文は `apps/daemon/src/app.ts` の `approvalsCursorSchema` の doc に在る。
 */
export function compareApprovalPagingKeyAsc(a: ApprovalPagingKey, b: ApprovalPagingKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** `order` に応じた向きの比較。`desc` は昇順比較を反転しただけ（別の比較関数を書かない）。 */
export function compareApprovalPagingKey(
  order: 'asc' | 'desc',
): (a: ApprovalPagingKey, b: ApprovalPagingKey) => number {
  return order === 'asc'
    ? compareApprovalPagingKeyAsc
    : (a, b) => compareApprovalPagingKeyAsc(b, a);
}
