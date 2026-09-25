import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `~/.alteroid/state/daemon.json`。CLI が接続先と生死を知るためだけの情報。
 *
 * `token` は起動ごとに作り直す本人確認用の値。**⚠️ 訂正: `/health` はこの値を
 * 返さない**（このコメントは長らく「同じものが返る」と書いていたが、実装済みの
 * 挙動と食い違っていた——`healthResponseSchema.operator` は真偽値だけを返す。
 * 返さなくなったのは 2026-08-13、#26、`cd8bb73`「ログインと、使う許可を人間が
 * 与える仕組みを入れる」で、この値が `access grant` を実行できる資格そのものに
 * なったため（`apps/daemon/src/openapi.ts` の `healthResponseSchema.operator` の
 * doc）。CLI は「自分の持っているトークンを提示して `operator: true` が返るか」
 * で本人確認する——PID の再利用検知としても同じ強さがある）。
 * PID だけを信じると、デーモンが異常終了してファイルが残った後に OS が同じ PID を
 * 別プロセスへ割り当てたとき、`alteroid daemon stop` が無関係なプロセスを殺しうる。
 */
export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
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
    return parseRuntimeInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseRuntimeInfo(value: unknown): DaemonRuntimeInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<DaemonRuntimeInfo>;
  if (typeof candidate.pid !== 'number' || typeof candidate.port !== 'number') return null;
  // token を持たない古い状態ファイルは本人確認できないので stale として扱う
  if (typeof candidate.token !== 'string' || candidate.token.length === 0) return null;
  return {
    pid: candidate.pid,
    port: candidate.port,
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
    token: candidate.token,
  };
}
