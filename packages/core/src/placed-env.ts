/**
 * 環境変数が「置かれている」かの、たった1つの判定。置かれていれば前後の空白を落とした値、置かれていなければ `null`。
 *
 * 空・空白のみは「未設定」: compose が `${VAR:-}` で渡す空文字を `!== undefined` で見ると、
 * そのまま SDK へ流れて起動時に落ちる。
 * 既定との比較にしない（既定と同じ値でも「置いた」）。値の検査もしない（弾くのは読む側）。
 */
export function placedEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
