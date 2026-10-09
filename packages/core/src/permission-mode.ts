/**
 * 判定を1か所に置くのは、層ごとに書き写すと「綴りの間違いは黙って既定へ倒さず落とす」が
 * 既定へ落とす形に化けるため。型でなく配列で持つのは、値が環境変数で実行時に検査が要るため。
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

/**
 * `default` に倒さない: canUseTool を渡していない query() では ask がそのまま拒否になり、答える相手の居ない確認が出るから。
 * `auto` は緩めているのではなく、人間が Claude Code を開いたときと同じ（モードは実行環境の設定で、締めても道具は減らない）。
 */
export const DEFAULT_PERMISSION_MODE: PermissionModeName = 'auto';

/** 既定との比較にしない（既定と同じ値でも「置いた」）。不正な値も `null` にしない（弾くのは {@link resolvePermissionModeFor}）。 */
export function placedPermissionMode(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 不正な値は既定へ倒さず落とす: 綴りを間違えた持ち主が「確認が来ない」ことに気づけなくなるため。 */
export function resolvePermissionModeFor(env: NodeJS.ProcessEnv, key: string): PermissionModeName {
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
