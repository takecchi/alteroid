import { reasonOf } from './dropped-record.js';
import type { RunnerClient, RunnerRegistry } from './runner-protocol.js';
import { createSerialQueue, type SerialQueue } from './serial-queue.js';

export interface PushChannel<R> {
  serial: SerialQueue['run'];
  onPushed(listener: (results: readonly R[]) => void): () => void;
  // 購読者の例外は握る: 帳面に積めなかっただけで、配布の結果そのものは呼び手が返す。
  notify(results: readonly R[]): void;
}

/** 配布サービスが持つ「直列の列」と「配った結果の購読」（`ManagerPool` が購読して押し込みの帳面に積む）。 */
export function createPushChannel<R>(): PushChannel<R> {
  const listeners = new Set<(results: readonly R[]) => void>();
  const { run: serial } = createSerialQueue();
  return {
    serial,
    onPushed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: (results) => {
      for (const listener of listeners) {
        try {
          listener(results);
        } catch {
          // 帳面に積めなかっただけ。
        }
      }
    },
  };
}

export interface RunnerPushResultBase {
  runnerId: string;
  ok: boolean;
  error?: string;
}

/**
 * 開いている全 runner のうち `accepts` が通したものへ `send` し、runner ごとの成否を集める（1台の失敗で他を止めない）。
 * `runners` が無ければ空。名簿（`list()`）の失敗は投げる。
 */
export async function pushToRunners<R extends RunnerPushResultBase>(
  runners: RunnerRegistry | undefined,
  accepts: (runner: RunnerClient) => boolean,
  send: (runner: RunnerClient) => Promise<Omit<R, keyof RunnerPushResultBase> | undefined>,
): Promise<R[]> {
  if (runners === undefined) return [];
  const open = await runners.list();
  return Promise.all(
    open.filter(accepts).map(async (runner): Promise<R> => {
      try {
        const placed = await send(runner);
        return { runnerId: runner.runnerId, ok: true, ...placed } as R;
      } catch (error) {
        return { runnerId: runner.runnerId, ok: false, error: reasonOf(error) } as R;
      }
    }),
  );
}
