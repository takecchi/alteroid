// 承認への回答の口にだけ掛ける期限（#4713）。web の fetch の口は会話の流れ（SSE）や大きい添付と共有なので、一律には掛けない

/** 1件の回答（`POST /approvals/{id}/answer`）の期限。デーモンは台帳と日誌へ書くだけで、普段は1秒もかからない。 */
export const APPROVAL_ANSWER_TIMEOUT_MS = 30_000;

/** まとめ回答（`POST /approvals/answer`）の期限。件数ぶん書くので、1件の倍にする。 */
export const APPROVALS_ANSWER_TIMEOUT_MS = 60_000;

/** 回答の後の一覧の取り直しを待つ上限。取り直しそのものは止めない（返れば一覧は更新される）。 */
export const APPROVALS_REFRESH_WAIT_MS = 15_000;

/**
 * 回答の要求に期限を掛ける。期限切れは「届いたかは分からない」として投げる:
 * デーモンは受け取って書いた後に応答だけ返せなかったのかもしれず、呼び手は続けて一覧を取り直す（届いていれば回答済みに見える）。
 */
export async function answerWithin<T>(
  ms: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  try {
    return await request(signal);
  } catch (caught) {
    if (signal.aborted) {
      throw new Error(
        `回答の送信に ${String(Math.round(ms / 1000))} 秒待っても応答が無かった。届いたかは分からない` +
          '（一覧を取り直したので、回答済みになっていれば届いている。なっていなければ送り直す）',
        { cause: caught },
      );
    }
    throw caught;
  }
}

/**
 * 取り直しを待つのは上限まで。上限に達したら待つのをやめて返る（投げない）: 取り直しが返らないことで、回答が通ったのに「送信中」が解けなくなるため。
 * 上限より前に取り直しが失敗したら、今までどおりそのまま投げる。
 */
export function refreshWithin(refresh: Promise<unknown>, ms: number): Promise<unknown> {
  refresh.catch(() => undefined);
  const expired = AbortSignal.timeout(ms);
  return Promise.race([
    refresh,
    new Promise<void>((resolve) => {
      expired.addEventListener('abort', () => resolve(), { once: true });
    }),
  ]);
}
