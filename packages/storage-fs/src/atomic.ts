import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * tmp へ書いて `rename` する、原子的な書き込みの共有実装。
 *
 * 書き込みの形を1本にしてあるのは、同じディレクトリを向いた書き手が2つ在ると
 * 互いの tmp を踏むという穴を、呼び出し側ごとに別々に塞がないためである。
 *
 * **tmp 名は呼び出しごとに一意にする**（`${path}.tmp.${pid}.${random}`）。
 * pid を混ぜるのは、同じプロセスでクラッシュ直後に残った tmp と、いま動いている
 * プロセスの tmp を見分ける材料を残すためであって、一意性そのものは
 * `randomUUID()` が既に持つ。
 *
 * **`mode` は tmp を作る時点で渡す。** rename 後に `chmod` で絞る形だと、その
 * 隙間で他人が読める（`auth.ts` / `credentials.ts` / `token-pool.ts` の doc と
 * 同じ理由）。0600 で持つべきファイル（認証・鍵）が一瞬でも既定の権限（0644 相当）
 * で存在する窓を作らない。
 *
 * **rename が失敗したら、tmp を消してから投げる。** 消し損ねた tmp を残さない
 * ——ディレクトリを readdir で列挙する読み手が居れば、それが誤って拾われる
 * 経路を作ることになる。`rm` 自体の失敗（既に消えている等）は握りつぶす。
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, data, { encoding: 'utf8', mode: options?.mode });
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
