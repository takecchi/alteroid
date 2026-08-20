/**
 * SDK の権限モードを読む、たった1つの判定（`model-tier.ts` と同じ形）。
 *
 * **ここに居るのは間接層のためではなく、判定が層ごとに散るのを止めるためである。**
 * クローンとマネージャーはどちらも「既定は人間が開く Claude Code と同じ `auto` ＋
 * 人間が環境変数に置いた差し替え」という同じ形をしていて、その判定には見落としやすい
 * 含みが2つある — 空文字は「未設定」（器が `${VAR:-}` で空文字を渡す）／**綴りの
 * 間違いは黙って既定へ倒さず落とす**。層ごとに書き写せば、いずれかでこの2つ目が
 * 「既定へ落とす」に化ける ＝ 都度確認にしたはずの人間が「確認が来ない」ことに
 * 気づけない。
 *
 * **これは能力の制限ではなく実行環境の設定である。** モードを締めても道具は1つも
 * 減らない（`tools` を絞ることとは別の軸である）。逆に、ここを既定で `default` に
 * 倒すと**答える相手が居ない確認**が発生し、道具を渡したのに使えない状態になる
 * （SDK: `canUseTool` を渡していない `query()` では `ask` の判断はそのまま拒否で
 * 終わる）。だから既定は `auto` であって、これは緩めているのではなく**人間が
 * Claude Code を開いたときと同じ**という意味である（north_star 禁止1）。
 */

/**
 * SDK が受け取る権限モードの一覧（`PermissionMode` と同じ綴り）。
 *
 * **SDK の型をそのまま使わずここに並べているのは、実行時に検査するためである。**
 * 値は人間が環境変数へ置くので、型では守れない。
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

export type PermissionModeName = (typeof PERMISSION_MODES)[number];

/** 既定の権限モード。ここを `default` に倒すと持ち主が確認で止まり続ける。 */
export const DEFAULT_PERMISSION_MODE: PermissionModeName = 'auto';

/**
 * 環境変数を見て権限モードを決める。空・空白なら既定。
 *
 * **不正な値は落とす。** 黙って既定へ倒すと、綴りを間違えた持ち主が「都度確認に
 * したはずなのに確認が来ない」状態に気づけない（`model-tier.ts` が値を検査しない
 * のとは逆である — あちらは SDK が増やしたモデル名を人間が選べる必要があるが、
 * ここは SDK 側の閉じた列挙で、増えたらこちらも足すことになる）。
 */
export function resolvePermissionModeFor(
  env: NodeJS.ProcessEnv,
  key: string,
): PermissionModeName {
  const given = env[key]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_PERMISSION_MODE;
  if ((PERMISSION_MODES as readonly string[]).includes(given)) {
    return given as PermissionModeName;
  }
  throw new Error(
    `${key} の値が不正: ${given}` +
      `（使えるのは ${PERMISSION_MODES.join(' / ')}。既定は ${DEFAULT_PERMISSION_MODE}）`,
  );
}
