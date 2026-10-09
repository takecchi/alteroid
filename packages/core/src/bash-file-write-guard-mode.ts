export const BASH_FILE_WRITE_GUARD_ENV = 'ALTEROID_BASH_FILE_WRITE_GUARD';

export const BASH_FILE_WRITE_GUARD_VALUES = ['off', 'deny'] as const;
export type BashFileWriteGuardMode = (typeof BASH_FILE_WRITE_GUARD_VALUES)[number];

// 製品の既定は off: 人間が素の Claude Code を使うときには無い制限を、既定で入れないため（north_star 禁止2）。運用の方針として deny にするのは設定の仕事である（#4348）
// `ask` を持たない: この門の目的は「クローンへ確認を上げずに、作業者が自分で道具を替える」ことで、確認に上げる値は症状を解かないため
export const DEFAULT_BASH_FILE_WRITE_GUARD: BashFileWriteGuardMode = 'off';

export function resolveBashFileWriteGuardMode(
  env: NodeJS.ProcessEnv = process.env,
): BashFileWriteGuardMode {
  const given = env[BASH_FILE_WRITE_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_BASH_FILE_WRITE_GUARD;
  if ((BASH_FILE_WRITE_GUARD_VALUES as readonly string[]).includes(given)) {
    return given as BashFileWriteGuardMode;
  }
  // 綴り違いは黙って既定へ倒さず落とす: 持ち主が気づけないままにならないため
  throw new Error(
    `${BASH_FILE_WRITE_GUARD_ENV} の値が不正: ${given}（使えるのは ${BASH_FILE_WRITE_GUARD_VALUES.join(' / ')}。既定は ${DEFAULT_BASH_FILE_WRITE_GUARD}）`,
  );
}
