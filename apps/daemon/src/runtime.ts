import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `~/.alteroid/state/daemon.json`。CLI が接続先と生死を知るためだけの情報。 */
export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export function runtimeFilePath(stateDir: string): string {
  return join(stateDir, 'daemon.json');
}

export async function writeRuntimeInfo(stateDir: string, info: DaemonRuntimeInfo): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(runtimeFilePath(stateDir), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

export async function clearRuntimeInfo(stateDir: string): Promise<void> {
  await rm(runtimeFilePath(stateDir), { force: true });
}

export async function readRuntimeInfo(stateDir: string): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFilePath(stateDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DaemonRuntimeInfo).pid === 'number' &&
      typeof (parsed as DaemonRuntimeInfo).port === 'number'
    ) {
      return parsed as DaemonRuntimeInfo;
    }
    return null;
  } catch {
    return null;
  }
}
