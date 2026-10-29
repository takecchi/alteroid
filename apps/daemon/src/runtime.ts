import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
}

export function runtimeFilePath(stateDir: string): string {
  return join(stateDir, 'daemon.json');
}

// `mode` オプションだけにしない: 新規作成のときしか効かず、既存の緩い `daemon.json` のパーミッションが残るため。
// 既存ファイルへ `writeFile` してから `chmod` しない: その2手の間、group/other から読める状態で新しい token が乗るため。
// `stateDir` 自体は 0700 にしない: 他のファイルも並ぶ場所で、ディレクトリの権限を絞ると影響が広がるため。
export async function writeRuntimeInfo(stateDir: string, info: DaemonRuntimeInfo): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = runtimeFilePath(stateDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function clearRuntimeInfo(stateDir: string): Promise<void> {
  await rm(runtimeFilePath(stateDir), { force: true });
}
