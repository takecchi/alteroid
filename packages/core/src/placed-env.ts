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

/**
 * 候補の中から1つを選ぶ env の読み方の、たった1つの形。置かれていなければ `fallback`。
 * 綴り違いは黙って既定へ倒さず、候補と既定を添えて投げる: 守っているつもりの持ち主が気づけなくなるため。
 * 文言は試験が見ている（`bash-guard-mode.test.ts` ほか）。
 */
export function resolveEnumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const given = placedEnvValue(env, key);
  if (given === null) return fallback;
  if ((values as readonly string[]).includes(given)) return given as T;
  throw new Error(
    `${key} の値が不正: ${given}（使えるのは ${values.join(' / ')}。既定は ${fallback}）`,
  );
}
