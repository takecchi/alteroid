import { createHash } from 'node:crypto';

import { clipWithEllipsis } from './excerpt.js';

// 独自のワーカープールを作らない: 作業者層の本体はこの `agents` 定義1個だけ
export const WORKER_AGENT_NAME = 'worker';

// 10分: 短すぎると許可が間に合わず失効し、長すぎると状況が変わった後に古い許可が生きる。フックの持ち時間の既定（600000ms）と同じ桁に揃えた経験的な値
export const ONE_SHOT_ALLOW_TTL_MS = 10 * 60 * 1000;

// 暗号としての強度は要らない: 要るのは「同じ文字列は同じ鍵になる」ことと「鍵を見ても元の文字列が読めない」ことだけのため
export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// 作業者の名札: 型までしか区別しない表示用の値（許可の一度きりの鍵には `oneShotActorOf` を使う）
export function workerActorOf(managerId: string, agentType: string | undefined): string {
  return `worker:${managerId}:${agentType ?? WORKER_AGENT_NAME}`;
}

export function actorOf(
  managerId: string,
  record: { readonly agentId?: string | undefined; readonly agentType?: string | undefined },
): string {
  return record.agentId === undefined
    ? `manager:${managerId}`
    : workerActorOf(managerId, record.agentType);
}

// 切り口を補助面の文字（絵文字の多く）の途中に置かない: 素の `slice` だと高サロゲートだけが残り、UTF-8 で届いたところで U+FFFD に化けるため
export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return clipWithEllipsis(text, limit);
}
