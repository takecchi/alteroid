import { placedEnvValue } from '@alteroid/core';

// 起動の env の2つの読み方を `index.ts` から切り出した: `index.ts` は import すると起動してしまい、
// 「空白だけの値は既定に倒れる」を試験で確かめられないため。

/** `ALTEROID_BIND`。置かれていない（未設定・空・空白だけ）なら `fallback`。 */
export function bindHostnameOf(env: NodeJS.ProcessEnv, fallback: string): string {
  return placedEnvValue(env, 'ALTEROID_BIND') ?? fallback;
}

/** `ALTEROID_WORKSPACE`。置かれていない（未設定・空・空白だけ）なら `cwd`。 */
export function workspaceOf(env: NodeJS.ProcessEnv, cwd: string): string {
  return placedEnvValue(env, 'ALTEROID_WORKSPACE') ?? cwd;
}
