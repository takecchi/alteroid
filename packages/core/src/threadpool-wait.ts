import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/**
 * libuv のスレッドの枠（既定4本）の待ちを測る（#4890）。
 *
 * ファイルの非同期の読み書き・`dns.lookup`・crypto の非同期は、同じ枠で回る。枠が塞がると、イベントループは空いたまま
 * （使用率 0%）、runner への接続の名前解決も PostgreSQL への接続も待たされる。ループの使用率や CPU 時間では、
 * この詰まりと網の揺れを見分けられないので、枠を使う軽い処理（`stat('/')`）を1つ投げ、返るまでの ms を測る。
 * 枠が空いていれば数 ms 以内に返る。何百 ms も掛かれば、枠が塞がっている。
 *
 * `performance` は大域ではなく `node:perf_hooks` から読む: `vi.useFakeTimers()` は大域の `performance` を差し替えるため
 * （`runner-protocol.ts` の `measureProbeLoopDefault` と同じ理由）。
 */

export interface ThreadpoolWait {
  /** 返るまで待った ms。`settled` が false のときは、待つのをやめた上限。 */
  readonly waitedMs: number;
  /** false は、上限まで待っても返らなかった（枠が塞がっている見込み）。 */
  readonly settled: boolean;
}

export interface MeasureThreadpoolWaitOptions {
  /** 返らないときに待つのをやめる上限（ms）。上限を切らずに待ち続けると、期限切れの知らせ自体が遅れる。 */
  readonly capMs?: number;
  /** 枠を使う軽い処理。既定は `fs.promises.stat('/')`（名前解決を挟まない）。試験で差し替える。 */
  readonly probe?: () => Promise<unknown>;
}

const DEFAULT_CAP_MS = 2_000;

export async function measureThreadpoolWait(
  options: MeasureThreadpoolWaitOptions = {},
): Promise<ThreadpoolWait> {
  const capMs = options.capMs ?? DEFAULT_CAP_MS;
  const probe = options.probe ?? (() => stat('/'));
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      // 失敗も「枠を通って返ってきた」ことには変わらない
      probe().then(
        () => 'returned' as const,
        () => 'returned' as const,
      ),
      new Promise<'capped'>((resolve) => {
        timer = setTimeout(() => {
          resolve('capped');
        }, capMs);
        timer.unref();
      }),
    ]);
    return outcome === 'returned'
      ? { waitedMs: Math.round(performance.now() - startedAt), settled: true }
      : { waitedMs: capMs, settled: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 日誌の文に添える形。測れなかった回（`undefined`）は「不明」と書き、推し量らない。 */
export function describeThreadpoolWait(wait: ThreadpoolWait | undefined): string {
  const size = process.env.UV_THREADPOOL_SIZE;
  const sizeText = `環境変数 UV_THREADPOOL_SIZE=${size === undefined || size === '' ? '未設定' : size}`;
  if (wait === undefined) return `スレッドの枠の待ち: 不明（${sizeText}）`;
  return wait.settled
    ? `スレッドの枠の待ち ${String(wait.waitedMs)}ms（${sizeText}）`
    : `スレッドの枠の待ち ${String(wait.waitedMs)}ms 以上（上限で測るのをやめた・まだ返っていない。${sizeText}）`;
}
