export const BASH_GUARD_ENV = 'ALTEROID_BASH_GUARD';

export const BASH_GUARD_VALUES = ['ask', 'deny', 'off'] as const;
export type BashGuardMode = (typeof BASH_GUARD_VALUES)[number];

// 既定は確認に上げる: 止めっぱなしにも、黙って通すことにもしないため
export const DEFAULT_BASH_GUARD: BashGuardMode = 'ask';

export function resolveBashGuardMode(env: NodeJS.ProcessEnv = process.env): BashGuardMode {
  const given = env[BASH_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_BASH_GUARD;
  if ((BASH_GUARD_VALUES as readonly string[]).includes(given)) return given as BashGuardMode;
  // 綴り違いは黙って既定へ倒さず落とす: 持ち主が気づけないままにならないため
  throw new Error(
    `${BASH_GUARD_ENV} の値が不正: ${given}（使えるのは ${BASH_GUARD_VALUES.join(' / ')}。既定は ${DEFAULT_BASH_GUARD}）`,
  );
}
