import { reasonOf } from './dropped-record.js';
import type { RunnerClient, RunnerRegistry } from './runner-protocol.js';
import { createSerialQueue, type SerialQueue } from './serial-queue.js';

interface PushChannel<R, S> {
  serial: SerialQueue['run'];
  onPushed(listener: (results: readonly R[], scope?: S) => void): () => void;
  // 購読者の例外は握る: 帳面に積めなかっただけで、配布の結果そのものは呼び手が返す。
  // `scope` は省略できる2つめの引数（委譲の許可の「名指しなし」の印）。省略したときは購読者へ渡さない。
  notify(results: readonly R[], scope?: S): void;
}

/**
 * 配布サービスが持つ「直列の列」と「配った結果の購読」（`ManagerPool` が購読して押し込みの帳面に積む）。
 * `S` は購読者へ添える2つめの引数の型（既定は無し: 使わないサービスの型と振る舞いは変わらない）。
 */
export function createPushChannel<R, S = never>(): PushChannel<R, S> {
  const listeners = new Set<(results: readonly R[], scope?: S) => void>();
  const { run: serial } = createSerialQueue();
  return {
    serial,
    onPushed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: (results, scope) => {
      for (const listener of listeners) {
        try {
          if (scope === undefined) listener(results);
          else listener(results, scope);
        } catch {
          // 帳面に積めなかっただけ。
        }
      }
    },
  };
}

interface RunnerPushResultBase {
  runnerId: string;
  ok: boolean;
  error?: string;
}

/**
 * 開いている全 runner へ `send` し、runner ごとの成否を集める（1台の失敗で他を止めない）。
 * `runners` が無ければ空。名簿（`list()`）の失敗は投げる。
 */
export async function pushToRunners<R extends RunnerPushResultBase>(
  runners: RunnerRegistry | undefined,
  send: (runner: RunnerClient) => Promise<Omit<R, keyof RunnerPushResultBase> | undefined>,
): Promise<R[]> {
  if (runners === undefined) return [];
  const open = await runners.list();
  return Promise.all(
    open.map(async (runner): Promise<R> => {
      try {
        const placed = await send(runner);
        return { runnerId: runner.runnerId, ok: true, ...placed } as R;
      } catch (error) {
        return { runnerId: runner.runnerId, ok: false, error: reasonOf(error) } as R;
      }
    }),
  );
}
