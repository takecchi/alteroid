/**
 * 書き込みを1つ回し、**成否に関わらず**一覧を取り直す（issue #2455）。
 *
 * 台帳の書き込み hooks（`mutations.ts` の `usePushCommitment` /
 * `useCloseCommitment` / `useAppraiseCommitment` / `useEditCommitment`）が使う。
 * パッケージの入口（`index.ts`）からは出していない——画面から直接呼ぶものではない。
 *
 * `useAnswerApproval`（#1619）と同じ形である。台帳の行は裏で先に片付くことがある
 * ——クローンが `commitment_close` で閉じた（クローン自身の tool_use なので SSE でも
 * キャッシュは落ちない）・別のタブや CLI が先に閉じた——と、close / 編集は 409 で
 * 断られる。`expectOk` の例外でそのまま抜けると取り直しに届かず、行は未了の
 * 見た目で編集と閉じるの入口を出したまま残り、押し直しても同じ 409 が繰り返される。
 * **409 に限らず失敗全般を対象にする**のも `useAnswerApproval` と同じ理由
 * （サーバ側の実際の状態を見に行くほうが安全側）。
 *
 * **取り直し自体が失敗しても、元の失敗を上書きしない。** 呼び出し側へ伝えるのは
 * 「なぜ書けなかったか」であって「なぜ取り直せなかったか」ではない。書き込みが
 * 通って取り直しだけが失敗したときは、取り直しの失敗をそのまま投げる。
 */
export async function writeThenRefresh(
  write: () => Promise<void>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  let writeError: unknown;
  let failed = false;
  try {
    await write();
  } catch (caught) {
    writeError = caught;
    failed = true;
  }
  try {
    await refresh();
  } catch (refreshError) {
    if (!failed) throw refreshError;
  }
  if (failed) throw writeError;
}
