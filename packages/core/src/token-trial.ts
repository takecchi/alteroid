import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { ANTHROPIC_ENDPOINT_KEY_ENV_NAMES } from './anthropic-route-env.js';
import { assistantFailureOf, isAnsweredResult, resultFailureOf } from './sdk-failure.js';
import { cooldownDeadlineFrom } from './token-rotation.js';
import {
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type AgentToken,
  type TokenCredential,
} from './token-pool.js';
import { toRateLimitFacts } from './usage-limits.js';
import { redactEnvSecrets } from './redact-env-secrets.js';
import { describeProbeError } from './usage-probe.js';
import type { TokenCandidateVerdict } from './token-candidate.js';

export const TOKEN_TRIAL_INTERVAL_MS = 30 * 60 * 1000;

// 上限を超えて間隔を伸ばさない: 偽陽性を踏んだ鍵が二度と試されない側へ倒れ、invalidatedAt の意味を黙って肩代わりするため
export const TOKEN_TRIAL_BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;

export const TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS = 15 * 60 * 1000;

export function doubledTrialIntervalMs(current: number): number {
  return Math.min(current * 2, TOKEN_TRIAL_BACKOFF_CAP_MS);
}

export interface SelectTokenForTrialInput {
  tokens: readonly AgentToken[];
  active: ActiveAgentToken | null;
  at: number;
  // lastTriedAt を 0 で埋めない: まだ試していないと epoch 0 の時刻に試したを区別するため
  lastTriedAt: Readonly<Record<string, number>>;
  intervalMsFor?: (tokenId: string) => number;
}

export function selectTokenForTrial(input: SelectTokenForTrialInput): AgentToken | undefined {
  const { tokens, active, at, lastTriedAt } = input;
  const intervalMsFor = input.intervalMsFor ?? (() => TOKEN_TRIAL_INTERVAL_MS);

  if (active === null || active.tokenId === undefined) return undefined;

  const hasReadyCandidate = tokens.some((token) => tokenAvailabilityAt(token, at) === 'ready');
  if (hasReadyCandidate) return undefined;

  const eligible = tokens.filter((token) => {
    if (tokenAvailabilityAt(token, at) !== 'cooling') return false;
    const cooldownUntil = token.cooldownUntil as number;
    return cooldownUntil - at > TOKEN_TRIAL_INTERVAL_MS;
  });

  const due = eligible.filter((token) => {
    const last = lastTriedAt[token.id];
    if (last === undefined) return true;
    return at - last >= intervalMsFor(token.id);
  });
  if (due.length === 0) return undefined;

  due.sort((a, b) => {
    const lastA = lastTriedAt[a.id] ?? Number.NEGATIVE_INFINITY;
    const lastB = lastTriedAt[b.id] ?? Number.NEGATIVE_INFINITY;
    if (lastA !== lastB) return lastA - lastB;
    return a.order - b.order;
  });
  return due[0];
}

export function describeTrialFailureFold(failureCount: number): string {
  if (failureCount <= 0) return '';
  return `（ダメ元の試しで通る前に、それまで${String(failureCount)}回試して通らなかった）`;
}

export interface TokenTrialPort {
  trial(token: { id: string } & TokenCredential): Promise<TokenCandidateVerdict>;
}

export const TOKEN_TRIAL_PROMPT_TEXT = 'ping';

// クローン・マネージャーの人格を継がない: 認証が生きているかだけを確かめる機械的な1ターンのため
export const TOKEN_TRIAL_SYSTEM_PROMPT =
  'This is an automated authentication check, not a real conversation. Reply with a single short word.';

export const TOKEN_TRIAL_TIMEOUT_MS = 30_000;

export type TokenTrialQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

async function* singleTrialPrompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: TOKEN_TRIAL_PROMPT_TEXT },
    parent_tool_use_id: null,
  };
}

export interface RunTokenTrialOptions {
  cwd: string;
  token: string;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  withheldEnvKeys?: readonly string[];
}

// 接続先用の鍵（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`）を外す: 在ると SDK はそちらを候補の鍵より優先して送り、
// 中継の 200 を「候補が通った」と読んで、死んだ鍵を冷却から戻すため（#4284 の実測）。接続先（`ANTHROPIC_BASE_URL`）は残す:
// 中継へ Claude の鍵を送る使い方は正当で（#4263 の決定）、外すと中継経由でしか外へ出られない器で試しが届かなくなるため
function buildTrialEnv(options: RunTokenTrialOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.token };
  for (const key of ANTHROPIC_ENDPOINT_KEY_ENV_NAMES) delete env[key];
  for (const key of options.withheldEnvKeys ?? []) delete env[key];
  return env;
}

// 迷ったら usable にも unusable にもしない: 枠で落ちたターンを成功と読むと輪になるため
export async function runTokenTrial(
  queryFn: TokenTrialQuery,
  options: RunTokenTrialOptions,
): Promise<TokenCandidateVerdict> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const env = buildTrialEnv(options);

  try {
    const handle = queryFn({
      prompt: singleTrialPrompt(),
      options: {
        cwd: options.cwd,
        abortController: controller,
        model: options.model,
        maxTurns: 1,
        tools: [],
        // 人間の設定層を読ませない: クローン・マネージャーのどちらの人格でもない使い捨ての試しのため
        settingSources: [],
        systemPrompt: TOKEN_TRIAL_SYSTEM_PROMPT,
        env,
      },
    });

    let rejected: { reason: string; retryAt?: number } | undefined;
    let answered = false;
    let sawAnyMessage = false;
    let lastFailureReason: string | undefined;
    let sawHttp429 = false;

    const consume = (async (): Promise<void> => {
      for await (const message of handle) {
        sawAnyMessage = true;
        if (controller.signal.aborted) return;
        const type = (message as { type?: unknown }).type;
        if (type === 'rate_limit_event') {
          const facts = toRateLimitFacts(
            (message as { rate_limit_info?: unknown }).rate_limit_info,
          );
          if (facts?.status === 'rejected' && rejected === undefined) {
            const deadline = cooldownDeadlineFrom(facts);
            rejected = {
              reason: 'rate_limit_event が rejected を運んだ',
              // 課金枠の期限は持ち帰らない: 受け手はこの期限を quota_reset として書くので出所を偽るため
              ...(deadline?.source === 'quota_reset' ? { retryAt: deadline.at } : {}),
            };
          }
          continue;
        }
        if (type === 'assistant') {
          const failure = assistantFailureOf((message as { error?: unknown }).error, '');
          if (failure !== undefined) {
            lastFailureReason = redactEnvSecrets(`${failure.code}: ${failure.text}`, env);
          }
          continue;
        }
        if (type === 'result') {
          if (isAnsweredResult(message)) {
            answered = true;
          } else {
            const failure = resultFailureOf(message as SDKMessage);
            if (failure !== undefined) {
              lastFailureReason = redactEnvSecrets(`${failure.code}: ${failure.text}`, env);
              if (failure.code.endsWith('/429')) sawHttp429 = true;
            }
          }
        }
      }
    })();
    // 締め切り後に届く rejection を unhandled にしない。
    consume.catch(() => {});

    const timedOut = Symbol('timeout');
    const raced = await Promise.race([
      consume.then(() => 'done' as const),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), options.timeoutMs ?? TOKEN_TRIAL_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (rejected !== undefined) {
      return {
        verdict: 'unusable',
        reason: rejected.reason,
        ...(rejected.retryAt === undefined ? {} : { retryAt: rejected.retryAt }),
      };
    }
    if (raced === timedOut) {
      return controller.signal.aborted
        ? { verdict: 'undecidable', reason: '締め切り前に中断された' }
        : {
            verdict: 'undecidable',
            reason: `締め切り（${String(options.timeoutMs ?? TOKEN_TRIAL_TIMEOUT_MS)}ms）に間に合わなかった`,
          };
    }
    if (controller.signal.aborted) {
      return { verdict: 'undecidable', reason: '試しの最中に中断された' };
    }
    if (answered) return { verdict: 'usable' };
    if (sawHttp429) {
      return { verdict: 'unusable', reason: lastFailureReason ?? 'HTTP 429' };
    }
    if (!sawAnyMessage) {
      return { verdict: 'undecidable', reason: 'SDK から1件もメッセージが届かなかった' };
    }
    return {
      verdict: 'undecidable',
      reason: lastFailureReason ?? '応答として扱える result が届かなかった',
    };
  } catch (error) {
    return {
      verdict: 'undecidable',
      reason: describeProbeError(error, env),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
