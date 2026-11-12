import { placedEnvValue } from './placed-env.js';

/**
 * 外した調整用の環境変数。どれも読まれなくなった（値は既定の定数に固定してある）。
 * 置かれたままなら、効いていると思い込ませないために起動のときに名前だけ言う（{@link retiredEnvWarnings}）。
 * 外した変数を足すときはここへ足す。
 */
export const RETIRED_ENV_KEYS = [
  'ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS',
  'ALTEROID_MERGED_BATCH_SIZE_LIMIT',
  'ALTEROID_PEER_MAX_SESSIONS',
  'ALTEROID_PEER_IDLE_MINUTES',
  'ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES',
] as const;

/**
 * 外した環境変数が置かれていれば、変数ごとに1行（`alteroidd: ` の接頭辞と改行は呼び手が付ける）。
 * **変数の名前だけを言い、値は載せない**: 値は秘密を含みうるし、読まれない値を出す意味もない。空・空白だけは置かれていないと見る。
 */
export function retiredEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return RETIRED_ENV_KEYS.filter((key) => placedEnvValue(env, key) !== null).map(
    (key) => `${key} が置かれていますが、この環境変数はもう読まれません。外してください`,
  );
}
