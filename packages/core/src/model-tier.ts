/**
 * 層とモデル帯の対応を差し替えるための、たった1つの判定。
 *
 * 3層へ書き写さない: 「置いた値がたまたま既定と同じでも『置いた』」という含みが、
 * いずれかの層で「既定と違うか」に化ける（`self_status` が答えるのは承認の有無で、値の比較ではない）。
 *
 * プロファイル（`alteroid profile edit`）でこれを解かない: 読むのは器自身の `process.env` で
 * プロファイルの評価はその先の SDK 子プロセスだから届かず、プロファイルはクローン自身が
 * `profile_write` で書けるので、クローンが自分のモデル帯を差し替えられて承認が承認でなくなる。
 */

/**
 * 空・空白のみは「未設定」: compose が `${VAR:-}` で渡す空文字を `!== undefined` で見ると、
 * そのまま SDK へ流れて起動時に落ちる。
 */
export function placedModelTier(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 値は検証しない: 既知の別名だけを通すと、SDK が新モデルを増やすたびに人間が選べなくなる
 * （north_star 禁止1）。読めない値は SDK が起動時に弾く。
 */
export function resolveModelTier(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return placedModelTier(env, key) ?? fallback;
}
