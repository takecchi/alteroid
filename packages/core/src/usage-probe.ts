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
 * `UsageProbeOptions.env` に渡した値（候補トークンなど）を、文字列から取り除く。
 *
 * **理由の文字列は、呼び出し元が保存したり画面に出したりしうる。** `env` の doc に
 * 書いたとおり「ここへ渡す値は資格そのものになりうる」ので、SDK やその配下が
 * 例外メッセージへ値をそのまま含めて返してきても、`reason` へ漏らさないための
 * 最後の網である。**単純な文字列置換なので、値が変形されて出てきた場合までは
 * 塞げない**（これは「塞げないと分かっていることを塞いだことにしない」ため、
 * ここに明記する）。
 */
export function redactEnvSecrets(text: string, env: NodeJS.ProcessEnv | undefined): string {
  if (env === undefined) return text;
  let result = text;
  for (const value of Object.values(env)) {
    if (typeof value === 'string' && value.length > 0) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result;
}

/**
 * 例外・rejection の理由を、秘密を伏せた1行に丸める。
 *
 * **`error.message` をそのまま出さないのは、ここへ来る値の出所を選べないから
 * である。** SDK やその配下が投げるものは呼び出し側の型宣言に無いので、
 * `redactEnvSecrets` は最後の網として必ず通す。改行は1行目だけを見る
 * （複数行のスタックトレースを理由として持ち帰らない）。
 */
export function describeProbeError(error: unknown, env: NodeJS.ProcessEnv | undefined): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactEnvSecrets(text.split('\n', 1)[0] ?? text, env);
}

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
  /**
   * probe のサブプロセスへ足す環境変数の上書き。
   *
   * **`@anthropic-ai/claude-agent-sdk@0.3.241` の `sdk.d.ts` は `Options.env` の doc に
   * 逐語でこう書いている**（`grep -Fn -- 'REPLACES the subprocess environment entirely'
   * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` で当たる）:
   *
   * > When set, this value REPLACES the subprocess environment entirely — it is
   * > not merged with process.env.
   *
   * **だから、ここへ渡された値は素通しせず `{ ...process.env, ...env }` へ広げてから
   * `Options.env` へ載せる。** 広げずに渡すと `PATH` も `HOME` も消え、probe の
   * サブプロセスが起動できなくなる。
   *
   * **⚠️ ここへ渡す値は資格そのものになりうる（例: `CLAUDE_CODE_OAUTH_TOKEN`）。
   * ログにも例外のメッセージにも出さないこと。** `runUsageProbe` 自身も、この値を
   * 読み取って `Options.env` へ渡す以外の用途に使わない（保存しない・再送しない）。
   */
  env?: NodeJS.ProcessEnv;
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
// yield が無いことがこの関数の要件そのもの（1つでも送ったら推論が走る）。
// eslint-disable-next-line require-yield
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
 * ここで飲む（unhandled にしない）が、**戻り値はこれまでどおり `T | undefined` の
 * ままにしてある** — 呼び出し元（`runner.ts` の `#flushUsage` 等）は理由を受け取る
 * 気が無い呼び方のままでよい。
 *
 * **理由だけを別口で渡したい呼び出し元は、第3引数 `onRejected` を渡す。** 省略すれば
 * 挙動もシグネチャの意味も1文字も変わらない（省略時は `undefined` を渡すのと同じ）。
 */
export async function settleWithin<T>(
  promise: Promise<T> | undefined,
  ms: number,
  onRejected?: (error: unknown) => void,
): Promise<T | undefined> {
  if (promise === undefined) return undefined;
  const settled = promise.catch((error: unknown) => {
    onRejected?.(error);
    return undefined;
  });
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
 * `runUsageProbe` が値を持ち帰れなかった理由の内訳。
 *
 * 呼ぶ側（`fetchAccountUsage`）が長らく「起動失敗・締め切り・中断」という固定文言
 * 1本で畳んでいたのを構造化したもの。**この3値がその固定文言の内訳そのものである**
 * （`exception` ＝ 起動失敗、`timeout` ＝ 締め切り、`aborted` ＝ 中断）。
 */
export type UsageProbeFailureKind = 'exception' | 'timeout' | 'aborted';

export interface UsageProbeFailure {
  kind: UsageProbeFailureKind;
  /**
   * 人が読める短い理由。**秘密は含まない** — `options.env` に渡した値は
   * {@link redactEnvSecrets} で必ず伏せてある。
   */
  reason: string;
}

/** `runUsageProbe` の結果。**決して投げない**契約を、型でも表す。 */
export type UsageProbeOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: UsageProbeFailure };

/**
 * 使い捨ての probe で `read` を1回走らせる。
 * **決して投げない**（probe は best-effort であって、呼ぶ側は必ずフォールバックする）。
 * 失敗したときは `{ ok: false, failure }` を返す —— 以前はここで理由を捨てて
 * `undefined` にしていたが、`fetchAccountUsage` 側が「なぜ取れなかったか」を
 * 一切言えなくなる帰結を生んでいた（#429）。
 *
 * 締め切りは自分で持つ。**SDK が abort で reject してくれることに頼らない** —
 * 内部が変わったときに「取得中のまま永久に止まる」を作らないため。
 */
export async function runUsageProbe<T>(
  queryFn: UsageProbeQuery,
  options: UsageProbeOptions,
  read: (handle: UsageProbeHandle) => Promise<T>,
): Promise<UsageProbeOutcome<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  let handle: UsageProbeHandle;
  try {
    handle = queryFn({
      prompt: idleUsagePrompt(controller.signal),
      options: {
        cwd: options.cwd,
        abortController: controller,
        // **人間の設定層まで読ませない。** probe は init と control channel しか
        // 読まないので、`user` 層を読むと観測のたびに人間の hook が走る。
        // ⚠️ ここへ `'user'` を足さないこと（この PR でも変えていない） —
        // 候補トークンの観測は普段より頻繁に走りうるので、足せば人間の hook が
        // そのぶん多く走ることになる。
        settingSources: ['project'],
        // **`options.env` が渡されたときだけ載せる。** 省略すれば `Options.env` 自体を
        // 組み立てに含めない ⟹ SDK は省略時に `process.env` をそのまま継承するので、
        // 既定の経路（`env` を渡さない呼び出し）の挙動は1文字も変わらない。
        // 渡されたときは、上の doc のとおり必ず `process.env` と spread する
        // （でなければ `PATH` / `HOME` が消えてサブプロセスが起動できない）。
        ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
      },
    });
  } catch (error) {
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    return {
      ok: false,
      failure: { kind: 'exception', reason: describeProbeError(error, options.env) },
    };
  }

  try {
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
    if (result === timedOut) {
      return controller.signal.aborted
        ? { ok: false, failure: { kind: 'aborted', reason: '締め切り前に中断された' } }
        : {
            ok: false,
            failure: {
              kind: 'timeout',
              reason: `締め切り（${options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS}ms）に間に合わなかった`,
            },
          };
    }
    return { ok: true, value: result };
  } catch (error) {
    return controller.signal.aborted
      ? { ok: false, failure: { kind: 'aborted', reason: '観測中に中断された' } }
      : {
          ok: false,
          failure: { kind: 'exception', reason: describeProbeError(error, options.env) },
        };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    // **どの経路でも畳む。** 常駐させない。
    controller.abort();
  }
}
