/**
 * 期限付きで待つ（roadmap M5）。
 *
 * **「1台の不在が残りを止めない」は、応答しない相手を待ち続けないことでしか
 * 成立しない。** 接続を拒まれるなら例外はすぐ返るが、TCP は繋がったまま応答が
 * 無い・パケットが落ちる・half-open のまま残る、といった相手では約束が永久に
 * 解けない。生存判定も配置も全 runner を待ち合わせるので、そこに1本でも解けない
 * 約束が混ざると、**健康な器への委譲まで止まる**（M5 の中心要件が壊れる）。
 *
 * だから待ち合わせるところには必ず期限を置く。**期限切れは「失敗」であって
 * 「まだ分からない」ではない** — 失敗として確定させて初めて、名簿はその器を
 * 落ちた側に置き、残りの器で仕事を続けられる。
 *
 * 相手が `AbortSignal` を見てくれるとは限らないので、`signal` は片付けの合図で
 * あって期限の実装ではない。期限そのものは競争（`Promise.race`）で担保する。
 */

/** 期限切れ。相手の失敗と区別できるように型を分けてある。 */
export class DeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(what: string, timeoutMs: number) {
    super(`${what} が期限内（${timeoutMs}ms）に応答しない`);
    this.name = 'DeadlineError';
    this.timeoutMs = timeoutMs;
  }
}

export function isDeadlineError(error: unknown): error is DeadlineError {
  return error instanceof DeadlineError;
}

/**
 * `run` を期限付きで走らせる。期限を過ぎたら `DeadlineError` で確定させる。
 *
 * `timeoutMs` が 0 以下なら期限なし（設定で明示的に外したいとき用）。
 *
 * @param what 期限切れの文言に出す名前（人間が読む用）
 */
export async function withDeadline<T>(
  what: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return run(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 片付けの合図。見てくれる相手なら接続もここで畳まれる。
      controller.abort();
      reject(new DeadlineError(what, timeoutMs));
    }, timeoutMs);
    // 期限の見張りだけでプロセスを生かし続けない。
    timer.unref?.();
  });

  try {
    // `race` は両方に受け手を付けるので、期限後に相手が失敗しても未処理にならない。
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
