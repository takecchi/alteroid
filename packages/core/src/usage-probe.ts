import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * 「SDK に1つ聞いて、すぐ立ち去る」ための配管。
 *
 * **実セッションに相乗りしない。** 実測で、ターンを回した直後のセッションに対して
 * usage 要求を出すと `ProcessTransport is not ready for writing` で失敗する。
 * alteroid のマネージャーは**常にターンを回している**ので、相乗りする設計は必ず詰まる。
 *
 * 代わりに使い捨てのセッションを1本立てる。**プロンプトを1つも送らない**ので推論は
 * 走らず、トークンを消費しない（実測 300〜400ms）。それでもサブプロセスではあるので、
 * 短命・自前の締め切り・どの経路でも必ず abort、を守る。
 */

/** 起動を待たせないための上限。取れなければ呼ぶ側がフォールバックする。 */
export const USAGE_PROBE_TIMEOUT_MS = 20_000;

/**
 * probe が読む口だけを抜き出した顔。
 *
 * **すべて省略可能にしてある。** 実験的な口（長い名前のあれ）は SDK 側で改名・削除
 * されうるので、無くなったときに「枠が取れない」へ落ちるだけで済むようにする。
 * ここを必須にすると、SDK が1つ改名した瞬間にデーモンが起動できなくなる。
 * テストの偽物が必要な分だけ実装できる、という利点もある。
 */
export interface UsageProbeHandle extends AsyncIterable<unknown> {
  /** ログインしているアカウント（プラン名・組織・バックエンド・認証の出所）。 */
  accountInfo?(): Promise<unknown>;
  /** claude.ai の `/usage`（枠の利用率と支出上限）。SDK では実験的な扱い。 */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
}

/**
 * probe が呼ぶ `query` の顔。
 *
 * **streaming-input モード（`prompt` が `AsyncIterable`）でなければならない。**
 * 上の control channel の口はそのモードにしか存在しない。
 */
export type UsageProbeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => UsageProbeHandle;

export interface UsageProbeOptions {
  cwd: string;
  /** 外から畳む（デーモンの終了時に abort する）。 */
  signal?: AbortSignal;
  /** 締め切りの上書き（既定 {@link USAGE_PROBE_TIMEOUT_MS}）。 */
  timeoutMs?: number;
}

/**
 * 何も送らないプロンプト。
 *
 * **待ち続けること自体が「推論を走らせない」の実装である。** 入力待ちのまま
 * 置いておけばモデルは1回も呼ばれない。
 *
 * 待ちは abort で解けるようにしておくこと。**決して解決しない Promise にすると、
 * この generator が `.return()` を完了できず、読み終わって離れる側が永久に待つ。**
 */
export async function* idleUsagePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * 値・`undefined` のどちらかに必ず落ちる読み取り。
 *
 * **片方の失敗や停滞で、もう片方の答えを捨てないため。** 実測で「`accountInfo()` は
 * 答えるのに usage 側は答えない」という食い違いが出ている。遅れて来た rejection は
 * ここで飲む（unhandled にしない）。
 */
export async function settleWithin<T>(
  promise: Promise<T> | undefined,
  ms: number,
): Promise<T | undefined> {
  if (promise === undefined) return undefined;
  const settled = promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 使い捨ての probe で `read` を1回走らせる。失敗・締め切り・中断は `undefined`。
 * **決して投げない**（probe は best-effort であって、呼ぶ側は必ずフォールバックする）。
 *
 * 締め切りは自分で持つ。**SDK が abort で reject してくれることに頼らない** —
 * 内部が変わったときに「取得中のまま永久に止まる」を作らないため。
 */
export async function runUsageProbe<T>(
  queryFn: UsageProbeQuery,
  options: UsageProbeOptions,
  read: (handle: UsageProbeHandle) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const handle = queryFn({
      prompt: idleUsagePrompt(controller.signal),
      options: {
        cwd: options.cwd,
        abortController: controller,
        // **人間の設定層まで読ませない。** probe は init と control channel しか
        // 読まないので、`user` 層を読むと観測のたびに人間の hook が走る。
        settingSources: ['project'],
      },
    });

    const answer = read(handle);
    // 締め切りが勝った後に届いた rejection を unhandled にしない。
    answer.catch(() => {});

    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      answer,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS);
        // 観測中に終了されても、このタイマーがプロセスを生かし続けないように。
        timer.unref?.();
      }),
    ]);
    return result === timedOut ? undefined : result;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    // **どの経路でも畳む。** 常駐させない。
    controller.abort();
  }
}
