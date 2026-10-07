import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

export async function readRuntimeInfo(stateDir: string): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFilePath(stateDir), 'utf8');
    return parseRuntimeInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseRuntimeInfo(value: unknown): DaemonRuntimeInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<DaemonRuntimeInfo>;
  if (typeof candidate.pid !== 'number' || typeof candidate.port !== 'number') return null;
  if (typeof candidate.token !== 'string' || candidate.token.length === 0) return null;
  return {
    pid: candidate.pid,
    port: candidate.port,
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
    token: candidate.token,
  };
}
