import {
  fetchAccountUsage,
  type AccountUsageState,
  type LimitsUnavailableCause,
  type UsageProbeQuery,
  reasonOf,
} from '@alteroid/core';

export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;

// 取れないと分かっても止めず間隔だけ伸ばす: 鍵は走行中に回せる設計で、恒久停止すると後から鍵が届いても「取れない」と表示し続けるため。
export const USAGE_POLL_UNAVAILABLE_INTERVAL_MS = 30 * 60_000;

// `undetermined` と欄が無い回は通常の間隔へ倒す: 「取れない」と断定できておらず、長い間隔だと取れるようになった瞬間を平均15分見落とすため。
// 3つ目の間隔を作らない: 根拠の無い新しい数になるため。
export function intervalForState(
  state: AccountUsageState,
  intervals: { normal: number; unavailable: number },
): number {
  switch (state.state) {
    case 'ok':
    case 'unknown':
    case 'failed':
      return intervals.normal;
    case 'unavailable':
      return intervalForUnavailableCause(state.cause, intervals);
    default: {
      // 実行時の倒れ先は「聞き続ける」側にする: 版がずれた応答が知らない状態を運んできても、黙って諦める側へ倒さない。
      const unhandled: never = state;
      void unhandled;
      return intervals.normal;
    }
  }
}

function intervalForUnavailableCause(
  cause: LimitsUnavailableCause | undefined,
  intervals: { normal: number; unavailable: number },
): number {
  switch (cause) {
    case 'not_logged_in':
    case 'non_first_party':
      return intervals.unavailable;
    case 'undetermined':
    case undefined:
      return intervals.normal;
    default: {
      // 実行時の倒れ先は「聞き続ける」側にする: 黙って諦める側へ倒さない。
      const unhandled: never = cause;
      void unhandled;
      return intervals.normal;
    }
  }
}

export interface UsagePollerOptions {
  queryFn: UsageProbeQuery;
  cwd: string;
  intervalMs?: number;
  unavailableIntervalMs?: number;
  signal?: AbortSignal;
  // `storage.withheldEnvKeys` をそのまま渡す: 省略すると SDK の既定で `process.env` をそのまま子へ継承し、一番広く晒す経路になるため。
  withheldEnvKeys?: readonly string[];
  env?: () => NodeJS.ProcessEnv;
  identity?: () => { tokenId: string; generation: number } | undefined;
  onState?: (
    state: AccountUsageState,
    measuredBy?: { tokenId: string; generation: number },
  ) => void;
}

// どちらも身元を持たない構成は同じ鍵として扱う: 箱が空＝器の環境変数の鍵のままで、回せない構成のため。
function sameKey(
  a: { tokenId: string; generation: number } | undefined,
  b: { tokenId: string; generation: number } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.tokenId === b.tokenId;
}

export interface UsagePoller {
  state(): AccountUsageState;
  refresh(): Promise<AccountUsageState>;
  stop(): void;
}

export function startUsagePolling(options: UsagePollerOptions): UsagePoller {
  const interval = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
  const unavailableInterval = options.unavailableIntervalMs ?? USAGE_POLL_UNAVAILABLE_INTERVAL_MS;

  let current: AccountUsageState = { state: 'unknown' };
  let currentKey: { tokenId: string; generation: number } | undefined;
  let inFlight: Promise<AccountUsageState> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  const refresh = async (): Promise<AccountUsageState> => {
    if (inFlight !== null) return inFlight;
    // 空なら渡さない: 空の `env` を渡すと `fetchAccountUsage` が `env` を組み立ててしまい、既定の構成の挙動が変わりうるため。
    const env = options.env?.();
    const measuredBy = options.identity?.();
    inFlight = fetchAccountUsage(options.queryFn, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      ...(options.withheldEnvKeys === undefined
        ? {}
        : { withheldEnvKeys: options.withheldEnvKeys }),
    })
      .then((next) => {
        // 知らせるのは「この回に取れたもの」で、`current` ではない: `current` は古い `ok` を保つので、渡すと同じ観測を何度も新しい観測として渡すことになるため。
        // 切り離して呼ぶ: 待つと聞き手が遅いぶん次の probe が遅れるため。
        if (options.onState !== undefined) {
          const notify = options.onState;
          const handoff = setTimeout(() => {
            // 投げてもポーリングを止めず、黙らせず跡を残す。
            try {
              notify(next, measuredBy);
            } catch (error) {
              process.stderr.write(
                `alteroidd: 枠の観測を見張りへ渡せませんでした: ${reasonOf(error)}\n`,
              );
            }
          }, 0);
          handoff.unref?.();
        }
        // 取れた値は同じ鍵での一時的な失敗のときだけ保つ: 失敗のたびに表示が消えると、使い切ったのか観測できないのかを区別できないため。鍵が変わったら捨てる（降りた鍵の枠をいまの枠として語らない）。
        if (next.state === 'ok') {
          current = next;
          currentKey = measuredBy;
        } else if (
          current.state === 'ok' &&
          next.state !== 'unknown' &&
          sameKey(currentKey, measuredBy)
        ) {
          current = {
            state: 'ok',
            usage: current.usage,
            refreshFailure: {
              since: current.refreshFailure?.since ?? next.at,
              at: next.at,
              reason: next.reason,
            },
          };
        } else {
          current = next;
          currentKey = measuredBy;
        }
        return current;
      })
      .catch(() => current)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  // 判定は `intervalForState` の1箇所に閉じる: 2箇所に同じ式を書くと片方だけ直す形が作れるため。
  const nextInterval = (state: AccountUsageState) =>
    intervalForState(state, { normal: interval, unavailable: unavailableInterval });

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh().then((state) => {
        schedule(nextInterval(state));
      });
    }, delay);
    timer.unref?.();
  };

  void refresh().then((state) => schedule(nextInterval(state)));

  return {
    state: () => {
      // 回した後に降りた鍵の `ok` を返さない: 次の probe を待つ間も、現役の鍵で測れていない事実は「まだ分からない」と言うため。
      if (current.state === 'ok' && !sameKey(currentKey, options.identity?.())) {
        return { state: 'unknown' };
      }
      return current;
    },
    refresh,
    stop,
  };
}
