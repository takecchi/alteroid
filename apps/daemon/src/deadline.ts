/**
 * 「期限内に応答が返らなかった」を、成功でも失敗でもない**第3の状態**として持つ。
 *
 * **なぜ `settleWithin`（`@alteroid/core` の `usage-probe.ts`）を使わないのか。**
 * あちらは締め切り・例外・`undefined` の3つを全部 `undefined` へ畳む。probe は
 * best-effort なのでそれで正しい（呼ぶ側は必ずフォールバックする）。だが制御面の
 * 操作では畳めない — `stop` や `send` は**届いていて応答だけが遅れている**ことが
 * あり、「失敗した」と扱って再送すれば二重に実行され、「死んだ」と扱って別の
 * runner へ引き取らせれば**同じマネージャーが2台で走る**（`docs/architecture.md`「実装フェーズ」
 * 「『落ちた』は観測の欠落であって停止の証明ではない」）。だから成功 / 明確な
 * 失敗 / **不明**を3つのまま返す。
 *
 * **なぜ名簿の `withDeadline`（`runner-protocol.ts`）を使わないのか。** あちらは
 * 期限で `AbortController` を畳んでから `Error` を投げる。生存確認にはそれが正しい
 * （返らない繋ぎを10秒ごとに積み上げない）が、制御面の操作でそれをやると
 * **相手の実行まで畳みうる**。ここは abort しない。
 */

/**
 * 制御面の応答を待つ期限。**この数を持つのはここだけである。**
 *
 * **この値で「遅い操作」と「返らない操作」を区別していない。** 区別できる材料は
 * 「応答が返ったか」しか無く、値はその判定に余白を与えるためだけにある。だから
 * 短く詰めない — 詰めると、長くかかるが正当な操作が「不明」に見える。
 *
 * 余白の根拠は runner の制御面の形である。`POST /managers` は
 * `host.start()`（`session.begin()` を蹴るだけ）で返り、`POST .../messages` は
 * `session.push()` で返る — **マネージャーのターンを待つ口は1つも無い。**
 * handler の中で待つのは高々2つで、どちらも runner 側で期限が付いている:
 * プロファイルの評価（`@alteroid/core` の `PROFILE_EVAL_TIMEOUT_MS`）と、`stop` の枠の書き出し。
 * ここはその両方を大きく上回る側に置く（`runner-deadline.test.ts` が関係を検査する）。
 *
 * 名簿は30秒黙った器を既に「落ちた」と見なしているので、その2倍を待って
 * なお返らないなら、それは「遅い」ではなく「返っていない」である。
 */
export const RUNNER_CALL_DEADLINE_MS = 60_000;

/**
 * 期限内に応答が返らなかった。**言えるのはそれだけである。**
 *
 * **「失敗した」でも「届かなかった」でも「runner が死んだ」でもない。** 制御面の
 * 操作は届いていて応答だけが遅れていることがあるので、これを失敗として再送すると
 * 二重に実行され、死亡として別の器へ引き取らせると同じマネージャーが2台で走る。
 *
 * `RunnerHttpError` の系列には**わざと乗せていない。** あちらは runner が返した
 * status を持つ＝「相手が答えた」の証拠であり、ここはその反対（答えが無い）である。
 */
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

/**
 * 期限切れのあと**遅れて**返ってきたときの通知。
 *
 * 中身も渡す。**渡さないと、受け取った側が応答を畳めない**（HTTP なら本文を
 * 読み捨てないと繋ぎが積み上がる）。**「不明」を言ったあとに真相が分かる唯一の
 * 経路**でもある。
 */
export type LateSettleListener<T> = (
  result: { ok: true; value: T } | { ok: false; error: unknown },
) => void;

export type Settled<T> =
  /** 応答が返った（中身の成否はここでは問わない）。 */
  | { readonly outcome: 'settled'; readonly value: T }
  /** 明確な失敗（接続を拒まれた・エラー応答・例外）。**言い切ってよい。** */
  | { readonly outcome: 'failed'; readonly error: unknown }
  /**
   * 期限内に応答が返らなかった。**これだけしか言えない。**
   *
   * 「届かなかった」でも「失敗した」でも「runner が死んだ」でもない。
   */
  | { readonly outcome: 'unknown'; readonly waitedMs: number };

/**
 * `promise` を `ms` だけ待ち、3つのどれかを返す。**投げない。**
 *
 * 期限が切れても `promise` は捨てない。`onLateSettle` を渡すと、遅れて返って
 * きたことを受け取れる（**「不明」のままにせず、後から真相が分かる経路**である）。
 * 渡さなくても未処理の rejection にはならない。
 */
export async function settleWithinDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onLateSettle?: LateSettleListener<T>,
): Promise<Settled<T>> {
  let expired = false;
  /**
   * 応答が返った瞬間に埋まる。**「まだ返っていない」を await 越しに推測しない**
   * ためにある — 推測すると、期限と応答が同じ回で揃ったときに**両方**が起きる
   * （呼ぶ側へ応答を渡しつつ「遅れて返った」とも言う）。HTTP ではそれが本文の
   * 二重読みになる（受け口が読み捨てた本文を、呼ぶ側がもう一度読もうとする）。
   */
  let arrived: Settled<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // **先に「遅れて返ってきたとき」の受け口を繋いでおく。** 期限側が勝ったあとに
  // 繋ぐと、その間に返った1件を落とす。
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
    // デーモンの終了をこのタイマーで引き延ばさない（`settleWithin` と同じ作法）。
    timer.unref?.();
  });

  try {
    const result = await Promise.race([watched, expiry]);
    if (result.outcome !== 'unknown') return result;
    // **「不明」を先に主張しない。** タイマーと応答が同じ回で揃ったときに、
    // 返っていた応答を捨てて「不明」と言うのが、この計器がいちばん嘘をつく形である。
    if (arrived !== undefined) return arrived;
    // **ここから下に await を挟まないこと。** 挟むと「返っていない」を確かめた
    // 後・印を付ける前に応答が返れる隙ができ、呼ぶ側へ応答を渡しながら
    // 「遅れて返った」とも言う（＝本文が二重に読まれる）。単一スレッドの
    // 直列実行そのものが、この隙が無いことの根拠である。
    expired = true;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
