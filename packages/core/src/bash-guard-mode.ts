export const BASH_GUARD_ENV = 'ALTEROID_BASH_GUARD';

export const BASH_GUARD_VALUES = ['ask', 'deny', 'off'] as const;
export type BashGuardMode = (typeof BASH_GUARD_VALUES)[number];

// 既定は確認に上げる: 止めっぱなしにも、黙って通すことにもしないため
export const DEFAULT_BASH_GUARD: BashGuardMode = 'ask';

// Bash の形の歯（`bash-shape-guard.ts`。#4947・#4949）の入り切り。`ALTEROID_BASH_GUARD` とは独立
export const BASH_SHAPE_GUARD_ENV = 'ALTEROID_BASH_SHAPE_GUARD';

export const BASH_SHAPE_GUARD_VALUES = ['on', 'off'] as const;
export type BashShapeGuardMode = (typeof BASH_SHAPE_GUARD_VALUES)[number];

// 既定は掛けない: 作者の運用スタイルを要件にしない（north_star 禁止2）。掛けたい器が env かプロファイルで開ける
export const DEFAULT_BASH_SHAPE_GUARD: BashShapeGuardMode = 'off';

export function resolveBashShapeGuard(env: NodeJS.ProcessEnv = process.env): BashShapeGuardMode {
  const given = env[BASH_SHAPE_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_BASH_SHAPE_GUARD;
  if ((BASH_SHAPE_GUARD_VALUES as readonly string[]).includes(given)) {
    return given as BashShapeGuardMode;
  }
  // 綴り違いは黙って既定へ倒さず落とす: 持ち主が気づけないままにならないため
  throw new Error(
    `${BASH_SHAPE_GUARD_ENV} の値が不正: ${given}（使えるのは ${BASH_SHAPE_GUARD_VALUES.join(' / ')}。既定は ${DEFAULT_BASH_SHAPE_GUARD}）`,
  );
}

// 実効の値: 実行環境プロファイルの値を優先し、無ければ runner の env の値（プロファイルに1行置けば次の呼び出しから効く）
export function resolveEffectiveBashShapeGuard(
  env: NodeJS.ProcessEnv,
  profileEnv: Readonly<Record<string, string>>,
): BashShapeGuardMode {
  const fromProfile = profileEnv[BASH_SHAPE_GUARD_ENV]?.trim();
  if (fromProfile !== undefined && fromProfile.length > 0) {
    return resolveBashShapeGuard({ [BASH_SHAPE_GUARD_ENV]: fromProfile });
  }
  return resolveBashShapeGuard(env);
}

// 起動行・出し直しの行。不正な値でも投げず、不正だと分かるように書く（起動は落とさない）
export function describeBashShapeGuard(
  env: NodeJS.ProcessEnv,
  profileEnv: Readonly<Record<string, string>>,
): string {
  // どちらから読んだかを書く: プロファイルで上書きしたのに「runner の env の値」と読ませないため
  const fromProfile = (profileEnv[BASH_SHAPE_GUARD_ENV]?.trim() ?? '').length > 0;
  const tail = fromProfile
    ? `（${BASH_SHAPE_GUARD_ENV}。実行環境プロファイルの値。runner の env より優先される）`
    : `（${BASH_SHAPE_GUARD_ENV}。runner の env の値。実行環境プロファイルに置けばそちらが優先される）`;
  try {
    return `Bash の形の歯: ${resolveEffectiveBashShapeGuard(env, profileEnv)}${tail}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Bash の形の歯: 不正な値（${message}）。直すまで Bash の呼び出しは確認に倒れる${tail}`;
  }
}

export function resolveBashGuardMode(env: NodeJS.ProcessEnv = process.env): BashGuardMode {
  const given = env[BASH_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_BASH_GUARD;
  if ((BASH_GUARD_VALUES as readonly string[]).includes(given)) return given as BashGuardMode;
  // 綴り違いは黙って既定へ倒さず落とす: 持ち主が気づけないままにならないため
  throw new Error(
    `${BASH_GUARD_ENV} の値が不正: ${given}（使えるのは ${BASH_GUARD_VALUES.join(' / ')}。既定は ${DEFAULT_BASH_GUARD}）`,
  );
}
