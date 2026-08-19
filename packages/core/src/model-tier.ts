/**
 * 層とモデル帯の対応を差し替えるための、たった1つの判定。
 *
 * **ここに居るのは間接層のためではなく、判定が3か所へ散るのを止めるためである。**
 * クローン（Fable）・マネージャー（Opus）・作業者（Sonnet）はどれも「既定値 ＋
 * 人間が環境変数に置いた承認」という同じ形をしていて、その判定には見落としやすい
 * 含みが3つある — 空文字は「未設定」／前後の空白は落とす／**置いた値がたまたま
 * 既定と同じでも「置いた」である**。3層で書き写せば、いずれか1層でこの3つ目が
 * 「既定と違うか」に化ける（`self_status` が答えているのは「差し替えの承認が
 * ここに置かれているか」であって、値の比較では言い換えられない）。
 *
 * **これは設定ではなく、人間の承認の置き場である。** 層とモデル帯の対応は設計判断で
 * あり（AGENTS.md 地雷5）、既定は動かさない。値を置けるのは人間だけで、置いた事実は
 * 起動時に必ず表へ出す（黙って上位帯から降りることを許さない）。
 *
 * **プロファイル（`alteroid profile edit`）でこれを解かないこと。** 理由は2つある。
 * 読むのは器（デーモンと runner）自身の `process.env` で、プロファイルが評価される
 * のはその先の SDK 子プロセスなので届かない。そしてプロファイルは**クローン自身が
 * `profile_write` で書ける**ので、そこから読めばクローンが自分のモデル帯を自分で
 * 差し替えられる ＝ 承認が承認でなくなる。
 */

/**
 * 人間が実際に値を置いたか（置いていなければ `null`）。
 *
 * 空・空白のみは「未設定」として扱う。器の側で `${VAR:-}` のように空文字で
 * 渡されても既定へ落ちる必要があるためで、ここを `!== undefined` で見ると
 * compose が渡す空文字がそのまま SDK へ流れて起動時に落ちる。
 */
export function placedModelTier(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 環境変数を見てモデル帯を決める。空・空白なら既定。
 *
 * **値は検証しない。** 既知の別名だけを通す関門を置くと、SDK が新しいモデルを
 * 増やすたびにこちらが追いつくまで人間が選べなくなる ＝ 能力の削除になる
 * （north_star 禁止1）。読めない値は SDK が起動時に弾く。
 */
export function resolveModelTier(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return placedModelTier(env, key) ?? fallback;
}
