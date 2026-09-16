import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * `${targetPath}.lock` に置く中身。**`token` が「誰の持ち物か」を決める唯一の
 * 材料である**（`release` の doc）。
 */
interface LockPayload {
  pid: number;
  host: string;
  /** ロックを取得した時刻（ISO 8601）。 */
  at: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 10;

/**
 * プロセス内の層。**同じプロセス内の複数インスタンスが、O_EXCL の取り合いで
 * 無駄にリトライし合わないようにする**——鍵は `${targetPath}.lock` そのもの
 * （ファイルロックのパスと1対1）。ここで直列化された時点で、同じプロセス内の
 * 呼び出しはファイルロックの外側で既に順番を持つ。
 */
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

/** 取得に失敗したときに投げる。**保持者の情報を持たせる**——「取れなかった」だけでは人が動けない。 */
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

/**
 * 古いロックの回収を1回分試す。
 *
 * **勝者を決めるのは `unlink` ではなく、次に呼ばれる `open(lockPath, 'wx')` の
 * 成功である。** 2つの呼び手が同時にここへ来て両方が「古い」と判定しても、
 * 両方が `unlink` して構わない（対象は既に無くなっているだけ）——その後
 * `wx` を取れるのはどちらか1つだけである。
 *
 * 戻り値 `'retry-now'` は「バックオフせずにもう一度 `wx` を試してよい」
 * （ロックファイルが既に無い、または回収できた）。`'contended'` は「まだ
 * 生きている持ち主が居る」——呼び出し側はバックオフしてから再試行する。
 */
async function tryReclaimStale(
  lockPath: string,
  staleMs: number,
): Promise<'retry-now' | 'contended'> {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    // 既に消えている（他の誰かが解放・回収した）。すぐ取り直してよい。
    return 'retry-now';
  }
  if (Date.now() - info.mtimeMs <= staleMs) return 'contended';
  // **もう一度 stat して、依然として古いことを確かめてから消す。** 直前の
  // stat から今までの間に持ち主が生きて更新した可能性を狭める（TOCTOU を
  // 完全には消せないが、最終的な勝敗は wx が決めるので、ここでの誤判定は
  // 「無駄に unlink する」以上の実害を持たない）。
  try {
    const recheck = await stat(lockPath);
    if (Date.now() - recheck.mtimeMs <= staleMs) return 'contended';
    await unlink(lockPath);
  } catch {
    // 消えていた／消せなかった。次の wx 試行に委ねる。
  }
  return 'retry-now';
}

async function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
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
        // **ロック対象のディレクトリがまだ無い**（初回起動などで、対象ファイル
        // のディレクトリごと未作成）。ここで作ってから retry する。
        //
        // ⚠️ **呼び出し側（各ストアの `#update`）で先に `mkdir` してはいけない**
        // ——プロセス内の直列化（`processChains`）は「`withPathLock` を呼んだ
        // 時点」で同期的にキューへ並ぶことに依存している。呼ぶ前に `await
        // mkdir(...)` を挟むと、複数の同時呼び出しが `withPathLock` へ実際に
        // 到達する順序が mkdir の完了順（呼び出し順とは限らない）にずれ、
        // FIFO が壊れる（実測: `usage.ts` の累積 fold で先着順が入れ替わり、
        // 合計が最終値ではなく中間値になった）。ディレクトリの用意はこの
        // 関数の内側——`processChains` へ並んだ*後*——に置く。
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

/**
 * 自分が持つロックだけを消す。
 *
 * **`token` が一致するときだけ `unlink` する。** 一致しなければ、`staleMs` を
 * 過ぎて誰か他人に回収され、その他人が既に持っている——ここで消すと他人の
 * ロックを奪うことになる。`ENOENT`（既に無い）は握りつぶす。
 *
 * **⚠️ `readLockPayload` で読んでから `unlink` するまでの間に、別の主体が
 * `staleMs` を過ぎたと判定して回収することは理屈上ありうる。** その窓に
 * 割り込まれれば、ここで一致を確認した token はもう自分のものではなくなって
 * おり、他人のロックを消すことになりうる——`tryReclaimStale` と同じ
 * TOCTOU で、ここだけを直しても消えない。最終的な安全は、この窓が
 * `staleMs` の見積もり（「これより長く1回の区間がかかることは無い」）より
 * 十分短いことに寄りかかっている。
 */
async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  const payload = await readLockPayload(lockPath);
  if (payload === null) return;
  if (payload.token !== token) return;
  await rm(lockPath, { force: true }).catch(() => undefined);
}

/**
 * `targetPath` に対する区間を排他する（issue #1113 / #1050）。
 *
 * ## これは advisory（勧告的）ロックである
 *
 * **このロックを見ない書き手が同じファイルを触れば、守られない。** `${targetPath}
 * .lock` の存在は慣習でしかなく、OS がファイルへのアクセスそのものを禁じるわけ
 * ではない——`storage-pg` の部分 unique 索引（DB の制約）とは強さが違う。ロック
 * を取らずに直接 `writeFile` する経路が1つでもあれば、この関数は無力である。
 * **`packages/storage-fs` 内の read-modify-write は必ずこの関数を経由すること
 * で初めて意味を持つ。**
 *
 * ## 2層構造
 *
 * 1. **プロセス内**: モジュールレベルの `Map` による直列化（`processChains`）。
 *    同じプロセス内の別インスタンス同士が、ファイルロックの `EEXIST` で無駄に
 *    リトライし合わない。
 * 2. **プロセス間**: `${targetPath}.lock` を `open(path, 'wx')` で取り合う。
 *
 * ## `staleMs` を過ぎた回収は lease（貸与）である
 *
 * **プロセスが落ちたときのロックが以後ずっと書けなくなる形にしないことが、
 * この回収の存在理由そのものである**（#1113 が名指しで警告している——回収を
 * 誤ると「今より悪い」）。裏側として、回収された瞬間から**元の保持者と新しい
 * 保持者が同時に区間へ入りうる**（真の相互排他ではなく、期限付きの貸与）。
 * 元の保持者がまだ生きていて `staleMs` を超えて処理を続けていた場合、両者は
 * 同時に `fn` を実行することになる——`staleMs` は「これより長く1回の区間が
 * かかることは無い」という見積もりの上に成り立つ。
 *
 * ## `fn` が throw しても解放する
 *
 * 取得できたロックは `finally` で必ず解放する。
 *
 * ## 取得できなければ {@link LockTimeoutError}
 *
 * 「取れなかった」だけでは人が動けないので、ロックのパスと、そのとき
 * ロックファイルに記録されていた保持者（pid/host/at）を含める。
 */
export async function withPathLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; staleMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = `${targetPath}.lock`;

  const prior = processChains.get(lockPath) ?? Promise.resolve();
  const attempt = prior.then(async () => {
    const token = await acquireFileLock(lockPath, timeoutMs, staleMs);
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
