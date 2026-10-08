import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

interface LockPayload {
  pid: number;
  host: string;
  at: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 10;

// プロセス内でも先に直列化する: 同じプロセス内の複数インスタンスが、O_EXCL の取り合いで無駄にリトライし合わないため
const processChains = new Map<string, Promise<unknown>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

// 保持者の情報を持たせる: 「取れなかった」だけでは人が動けないため
export class LockTimeoutError extends Error {
  readonly lockPath: string;
  readonly holder: LockPayload | null;

  constructor(lockPath: string, holder: LockPayload | null, timeoutMs: number) {
    const holderText =
      holder === null
        ? '保持者不明（ロックファイルを読めなかった——既に解放されたか、壊れている）'
        : `pid=${holder.pid} host=${holder.host} at=${holder.at}`;
    super(`ロックを ${timeoutMs}ms 以内に取得できなかった: ${lockPath}（保持者: ${holderText}）`);
    this.name = 'LockTimeoutError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

// 勝者は `unlink` ではなく次の `open(lockPath, 'wx')` の成功が決める: 両方が「古い」と判定して両方が `unlink` しても構わないため
async function tryReclaimStale(
  lockPath: string,
  staleMs: number,
): Promise<'retry-now' | 'contended'> {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    return 'retry-now';
  }
  if (Date.now() - info.mtimeMs <= staleMs) return 'contended';
  // もう一度 stat して古さを確かめてから消す: 直前の stat から今までの間に持ち主が更新した可能性を狭めるため
  try {
    const recheck = await stat(lockPath);
    if (Date.now() - recheck.mtimeMs <= staleMs) return 'contended';
    await unlink(lockPath);
  } catch {
    // 消えていた／消せなかった: 次の wx 試行に委ねる
  }
  return 'retry-now';
}

async function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
  createDir: boolean,
): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) {
      const holder = await readLockPayload(lockPath);
      throw new LockTimeoutError(lockPath, holder, timeoutMs);
    }
    try {
      const handle = await open(lockPath, 'wx');
      try {
        const payload: LockPayload = {
          pid: process.pid,
          host: hostname(),
          at: new Date().toISOString(),
          token,
        };
        await handle.writeFile(JSON.stringify(payload));
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (!createDir) throw error;
        // 呼び出し側で先に `mkdir` しない: `withPathLock` へ並ぶ前に await を挟むと到達順が mkdir の完了順にずれ、FIFO が壊れるため
        await mkdir(dirname(lockPath), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') throw error;
      const outcome = await tryReclaimStale(lockPath, staleMs);
      if (outcome === 'retry-now') continue;
      await sleep(RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS);
    }
  }
}

async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  const payload = await readLockPayload(lockPath);
  if (payload === null) return;
  // `token` が一致するときだけ消す: 一致しなければ `staleMs` を過ぎて他人に回収されており、消すと他人のロックを奪うため
  if (payload.token !== token) return;
  await rm(lockPath, { force: true }).catch(() => undefined);
}

/** `targetPath` に対する区間を排他する。advisory なので、ロックを見ない書き手は防げない。 */
export async function withPathLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; staleMs?: number; createDir?: boolean },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const createDir = options?.createDir ?? true;
  const lockPath = `${targetPath}.lock`;

  const prior = processChains.get(lockPath) ?? Promise.resolve();
  const attempt = prior.then(async () => {
    const token = await acquireFileLock(lockPath, timeoutMs, staleMs, createDir);
    try {
      return await fn();
    } finally {
      await releaseFileLock(lockPath, token);
    }
  });
  const guard = attempt.catch(() => undefined);
  processChains.set(lockPath, guard);
  void guard.finally(() => {
    if (processChains.get(lockPath) === guard) processChains.delete(lockPath);
  });
  return attempt;
}
