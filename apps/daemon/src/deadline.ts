// `settleWithin` を使わない: 制御面の操作は届いていて応答だけが遅れていることがあり、「失敗」で再送すると二重に実行され、「死んだ」で引き取らせると同じマネージャーが2台で走るため。
// 名簿の `withDeadline` を使わない: 期限で `AbortController` を畳むと相手の実行まで畳みうるため。
// 値を短く詰めない: 詰めると、長くかかるが正当な操作が「不明」に見えるため。
export const RUNNER_CALL_DEADLINE_MS = 60_000;

// `RunnerHttpError` の系列には乗せない: あちらは runner が返した status を持つ＝「相手が答えた」の証拠で、ここはその反対のため。
export class RunnerUnknownError extends Error {
  readonly waitedMs: number;
  readonly method: string;
  readonly path: string;

  constructor(input: { method: string; path: string; waitedMs: number }) {
    super(
      `runner ${input.method} ${input.path} が ${String(input.waitedMs)}ms 以内に応答を返さなかった。` +
        '**届いたかどうかは分かっていない** — 失敗とは限らないので送り直すと二重に実行され、' +
        '死んだとも限らないので別の runner へ引き取らせると同じマネージャーが2台で走る。',
    );
    this.name = 'RunnerUnknownError';
    this.waitedMs = input.waitedMs;
    this.method = input.method;
    this.path = input.path;
  }
}

export type LateSettleListener<T> = (
  result: { ok: true; value: T } | { ok: false; error: unknown },
) => void;

export type Settled<T> =
  | { readonly outcome: 'settled'; readonly value: T }
  | { readonly outcome: 'failed'; readonly error: unknown }
  | { readonly outcome: 'unknown'; readonly waitedMs: number };

export async function settleWithinDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onLateSettle?: LateSettleListener<T>,
): Promise<Settled<T>> {
  let expired = false;
  // 「まだ返っていない」を await 越しに推測しない: 期限と応答が同じ回で揃うと両方が起き、HTTP では本文の二重読みになるため。
  let arrived: Settled<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // 「遅れて返ってきたとき」の受け口は先に繋ぐ: 期限側が勝ったあとに繋ぐと、その間に返った1件を落とすため。
  const watched = promise.then(
    (value): Settled<T> => {
      arrived = { outcome: 'settled', value };
      if (expired) onLateSettle?.({ ok: true, value });
      return arrived;
    },
    (error): Settled<T> => {
      arrived = { outcome: 'failed', error };
      if (expired) onLateSettle?.({ ok: false, error });
      return arrived;
    },
  );

  const expiry = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'unknown', waitedMs: ms }), ms);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([watched, expiry]);
    if (result.outcome !== 'unknown') return result;
    // 「不明」を先に主張しない: タイマーと応答が同じ回で揃ったときに返っていた応答を捨てるのが、いちばん嘘をつく形のため。
    if (arrived !== undefined) return arrived;
    // ここから下に await を挟まない: 挟むと「返っていない」を確かめた後・印を付ける前に応答が返れる隙ができ、本文が二重に読まれるため。
    expired = true;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
