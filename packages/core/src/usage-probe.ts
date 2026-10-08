import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { redactErrorText } from './denial-input-head.js';
import { redactEnvSecrets } from './redact-env-secrets.js';

// 実セッションに相乗りしない: ターンを回した直後のセッションへ usage 要求を出すと `ProcessTransport is not ready for writing` で失敗するため
// プロンプトを1つも送らない: 送ると推論が走ってトークンを消費するため
export const USAGE_PROBE_TIMEOUT_MS = 20_000;

// error.message をそのまま出さない: 値の出所を選べないので redactEnvSecrets を最後の網として必ず通す。`reasonOf` ではなく `redactErrorText` を使う: 1行目に畳む形（`name: message`）を保つため
export function describeProbeError(error: unknown, env: NodeJS.ProcessEnv | undefined): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactErrorText(redactEnvSecrets(text.split('\n', 1)[0] ?? text, env), env);
}

// 口を必須にしない: 実験的な口は SDK 側で改名・削除されうるので、必須にすると SDK が1つ改名した瞬間にデーモンが起動できなくなるため
export interface UsageProbeHandle extends AsyncIterable<unknown> {
  accountInfo?(): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
}

export type UsageProbeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => UsageProbeHandle;

export interface UsageProbeOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  // 素通しせず `{ ...process.env, ...env }` へ広げてから載せる: 広げないと PATH も HOME も消え、probe が起動できないため
  // [sdk-verbatim Options.env]
  // > this value REPLACES the subprocess environment entirely
  // ここへ渡す値をログ・例外に出さない: 資格そのもの（`CLAUDE_CODE_OAUTH_TOKEN` など）になりうるため
  env?: NodeJS.ProcessEnv;
  // env を省略しても「何も渡さない」ではない: Options.env を省略すると SDK の既定 `{ ...process.env }` がそのまま子へ渡るため
  withheldEnvKeys?: readonly string[];
}

// 待ちは abort で解く: 決して解決しない Promise だと `.return()` が完了せず、離れる側が永久に待つため
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

export type UsageProbeFailureKind = 'exception' | 'timeout' | 'aborted';

export interface UsageProbeFailure {
  kind: UsageProbeFailureKind;
  reason: string;
}

export type UsageProbeOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: UsageProbeFailure };

function buildProbeEnv(options: UsageProbeOptions): NodeJS.ProcessEnv {
  const env = { ...process.env, ...options.env };
  for (const key of options.withheldEnvKeys ?? []) delete env[key];
  return env;
}

// 締め切りは自分で持つ: SDK が abort で reject してくれることに頼ると、内部が変わったときに取得中のまま永久に止まるため
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
        // 'user' を足さない: 観測のたびに人間の hook が走るため
        settingSources: ['project'],
        ...(options.env !== undefined || (options.withheldEnvKeys?.length ?? 0) > 0
          ? { env: buildProbeEnv(options) }
          : {}),
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
    // 締め切りが勝った後に届いた rejection を unhandled にしない
    answer.catch(() => {});

    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      answer,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS);
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
    controller.abort();
  }
}
