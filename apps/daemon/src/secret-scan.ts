import {
  createSecretRedactor,
  ROTATABLE_CREDENTIAL_KEYS,
  WITHHELD_ENV_KEYS,
  type SecretRedactor,
} from '@alteroid/core';
import { AUTH_WITHHELD_ENV_KEYS } from './auth.js';

// 秘密走査の器をデーモンの1か所で作る: `GET /self/prompt` と MCP の読み取りの道具が別々の一覧で走査すると、片方だけ伏せ漏れる。
// 既知の秘密名は既存の一覧を使う（新しい一覧を手書きしない）。名前に TOKEN・KEY などが入る変数は、走査の側が拾う。
export function createDaemonSecretRedactor(env: NodeJS.ProcessEnv): SecretRedactor {
  return createSecretRedactor({
    env,
    knownSecretEnvNames: [
      ...WITHHELD_ENV_KEYS,
      ...AUTH_WITHHELD_ENV_KEYS,
      ...ROTATABLE_CREDENTIAL_KEYS,
    ],
  });
}

export interface ToolSecretScan {
  scanned: true;
  // 規則の名前と件数だけ。値・位置・前後の文脈は載せない
  hits: { rule: string; count: number }[];
}

/**
 * 道具の結果（構造化結果の全部の文字列。キーを含む）を、返す直前に走査して伏せる。走査した事実は当たり0件でも `secretScan` に載せる。
 * 走査が例外で落ちたらここで投げる: 呼び手は結果を返さない（走査できていない結果を返さない）。
 */
export function withSecretScan<T extends Record<string, unknown>>(
  data: T,
  redactor: SecretRedactor,
): T & { secretScan: ToolSecretScan } {
  const scanned = redactor.redactDeep(data);
  return {
    ...scanned,
    secretScan: {
      scanned: true,
      hits: redactor.hits().map((hit) => ({ rule: hit.rule, count: hit.count })),
    },
  };
}
