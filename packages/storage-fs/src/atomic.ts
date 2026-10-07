import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function writeFileAtomic(
  path: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  // tmp 名を固定にしない: 同じディレクトリを向いた書き手が2つ居ると互いの tmp を踏むため
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  // rename 後に chmod で絞らず、tmp を作る時点で mode を渡す: 0600 のファイルが既定の権限で存在する窓を作らないため
  await writeFile(tmp, data, { encoding: 'utf8', mode: options?.mode });
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
