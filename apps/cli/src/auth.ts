import { readFileSync } from 'node:fs';

/**
 * CLI がデーモンへ名乗るための鍵。
 *
 * **鍵を置いた瞬間に持ち主が自分の道具を使えなくなる、をやらない。** 守るのは
 * 外から叩かれることであって、持ち主を締め出すことではない（それは能力の削除に
 * なる — north_star 禁止1）。
 *
 * **ここを1か所に集めているのは、付け忘れが致命的だからである。** `alteroid chat`
 * は `GET /health` で「いま応答しているのが自分の記録したデーモンか」を確かめて
 * から動く。この1本に鍵が付いていないだけで、CLI は走っているデーモンを
 * 「停止中」と誤認し、同じポートへもう1つ起こそうとして延々と失敗する。
 * デーモンを叩く経路を足すときは、必ずここを通すこと。
 */
export function apiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.ALTEROID_API_TOKEN?.split(',')[0]?.trim();
  if (direct !== undefined && direct.length > 0) return direct;

  // デーモン側がファイルで鍵を配っている構成でも、同じ器に居る持ち主は名乗れる。
  // env だけを見ていると、`ALTEROID_API_TOKEN_FILE` の構成で CLI が締め出される。
  const path = env.ALTEROID_API_TOKEN_FILE;
  if (path === undefined || path.length === 0) return undefined;
  try {
    const first = readFileSync(path, 'utf8')
      .split(/[,\n]/)
      .map((token) => token.trim())
      .find((token) => token.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

/** デーモンを叩くときに必ず付けるヘッダ。鍵が無ければ何も足さない。 */
export function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = apiToken(env);
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}
