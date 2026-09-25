import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { assistantFailureOf, isAnsweredResult, resultFailureOf } from './sdk-failure.js';
import { cooldownDeadlineFrom } from './token-rotation.js';
import {
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type AgentToken,
  type TokenCredential,
} from './token-pool.js';
import { toRateLimitFacts } from './usage-limits.js';
import { describeProbeError, redactEnvSecrets } from './usage-probe.js';
import type { TokenCandidateVerdict } from './token-candidate.js';

/**
 * 冷却中の鍵を「ダメ元で」試す仕組み（Issue #1501）。
 *
 * ## 何のためにあるか
 *
 * `resetsAt` は Anthropic 側の予定であって約束ではない。モデルのリリースなど
 * 思わぬタイミングで枠が早くリセットされることがあるが、既存の仕組み
 * （`token-watch.ts` / `token-rotator.ts`）は冷却中の鍵を `cooldownUntil` まで
 * 一度も試さない——候補選び（`selectNextToken`）は `ready` な行しか見ず、候補の
 * probe（`probeTokenCandidate`）はプロンプトを送らないので判定できない
 * （本番では `undecidable` しか返さない）。
 *
 * ここは、**記録の上で通る鍵が1本も無いときだけ**、冷却中の鍵（現役自身も含む）を
 * 間隔を置いて本物の最小の1ターンで試す。通ったら既存の回転の経路（`recovered` /
 * `rotated`）へ素直に乗せる。外れても、層には一切撒かない——試す前に撒かないので
 * 本番の仕事が枠に当たることはない。
 *
 * ## 対象と間隔（点はすべて呼び出し側 `apps/daemon/src/token-trial-watch.ts` が持つ）
 *
 * この core 側のファイルが持つのは3つだけである。
 *
 * 1. **`selectTokenForTrial`** —— 純粋関数。「試すべきか、試すならどれか」を
 *    記録だけから決める
 * 2. **`TokenTrialPort`** —— 試す口。core は型だけを持ち、実装はデーモン
 *    （`apps/daemon/src/index.ts`）が `runTokenTrial` を使って組み立てる
 * 3. **`runTokenTrial`** —— 道具を持たない最小のプロンプトを1つ送る、本物の
 *    1ターン。判定は3値（`usable` / `unusable` / `undecidable`）
 */

// ---------------------------------------------------------------------------
// 対象の選び方（純粋関数）
// ---------------------------------------------------------------------------

/** 試しを試みる間隔の既定（30分）。 */
export const TOKEN_TRIAL_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 偽陽性の退き方（設計点8）の上限。**この値を超えて間隔を伸ばさない。**
 *
 * 上限が無いと、繰り返し偽陽性を踏んだ鍵が実質的に「二度と試さない」側へ
 * 倒れてしまう——それは `invalidatedAt`（恒常的に通らない）が持つべき意味で
 * あって、この仕組みが黙って肩代わりしてよいものではない。
 */
export const TOKEN_TRIAL_BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;

/**
 * 偽陽性を判定する窓（設計点8）。**この時間内に同じ鍵で本物の拒否が届いたら、
 * その試しは「通ったが層は通らなかった」偽陽性だったとみなす。**
 */
export const TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS = 15 * 60 * 1000;

/** 偽陽性1回ぶんの倍化。上限は {@link TOKEN_TRIAL_BACKOFF_CAP_MS}。 */
export function doubledTrialIntervalMs(current: number): number {
  return Math.min(current * 2, TOKEN_TRIAL_BACKOFF_CAP_MS);
}

export interface SelectTokenForTrialInput {
  /** プールの全行。 */
  tokens: readonly AgentToken[];
  /** いまの現役の指名。まだ一度も指名していなければ `null`。 */
  active: ActiveAgentToken | null;
  /** 現在時刻（epoch ミリ秒）。 */
  at: number;
  /**
   * そのトークンを最後に試した時刻（epoch ミリ秒）。**キーは `tokenId`。**
   * 一度も試していないトークンはキーを持たない（`0` で埋めない——「まだ
   * 試していない」と「epoch 0 の時刻に試した」を区別するため）。
   */
  lastTriedAt: Readonly<Record<string, number>>;
  /**
   * そのトークンの、いま効いている試しの間隔（ミリ秒）。省略すると
   * {@link TOKEN_TRIAL_INTERVAL_MS} を使う。**偽陽性で伸びた間隔はここで返す**
   * （呼び出し側が持つ状態であって、この純粋関数は持たない）。
   */
  intervalMsFor?: (tokenId: string) => number;
}

/**
 * いま試すべき鍵を1本選ぶ。**純粋関数。副作用も乱数も無い。**
 *
 * ## 試す条件（設計点1）
 *
 * 記録の上で通る鍵が1本も無いとき —— **プールのどの行も `ready` でないとき**
 * だけ。現役が `ready` なら、その時点で何もしない（健全な状態では費用0）。
 * `disabled` / 失効（`invalidatedAt`）の行は `ready` にも対象にも数えない。
 *
 * **現役が `cooling` であることは要求しない。** 現役が外された（`disabled`）・
 * 失効した・指名の先が消えた（`dangling`）ときも、残りが全部冷却中なら
 * 通る鍵が1本も無いのは同じだからである——そこで試さないと、早いリセットを
 * いちばん要る場面で取りこぼす。**まだ一度も指名していない**（`active` が無い）
 * プールだけは対象にしない（回し手がまだ一度も動いていない構成を触らない）。
 *
 * ## 対象（設計点2）
 *
 * 冷却中の鍵（現役自身も含む）のうち、`cooldownUntil - at` が
 * {@link TOKEN_TRIAL_INTERVAL_MS} より長いもの——間隔以内に時計で明けるものは
 * 既存の `reopened`（`token-rotator.ts`）に任せる。
 *
 * ## 選び方（設計点2）
 *
 * その中から、最後に試した時刻がいちばん古いもの（未試行が先）を選ぶ。
 * 同点（複数が未試行、または同じ時刻）は `order` 昇順。
 */
export function selectTokenForTrial(input: SelectTokenForTrialInput): AgentToken | undefined {
  const { tokens, active, at, lastTriedAt } = input;
  const intervalMsFor = input.intervalMsFor ?? (() => TOKEN_TRIAL_INTERVAL_MS);

  if (active === null || active.tokenId === undefined) return undefined;

  // **`ready` な行が1本でも在れば何もしない**（現役を含む。健全な状態では費用0）。
  const hasReadyCandidate = tokens.some((token) => tokenAvailabilityAt(token, at) === 'ready');
  if (hasReadyCandidate) return undefined;

  const eligible = tokens.filter((token) => {
    if (tokenAvailabilityAt(token, at) !== 'cooling') return false;
    // `tokenAvailabilityAt` が `cooling` を返した以上 `cooldownUntil` は必ず在る。
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

/** 失敗の件数を、次に通った回の1行へ畳むための文言。**0件なら空文字。** */
export function describeTrialFailureFold(failureCount: number): string {
  if (failureCount <= 0) return '';
  return `（ダメ元の試しで通る前に、それまで${String(failureCount)}回試して通らなかった）`;
}

// ---------------------------------------------------------------------------
// 試す口（core は型だけを持つ。実装はデーモンが組み立てる）
// ---------------------------------------------------------------------------

/** 冷却中の鍵を1本、本物の1ターンで試す口。 */
export interface TokenTrialPort {
  trial(token: { id: string } & TokenCredential): Promise<TokenCandidateVerdict>;
}

// ---------------------------------------------------------------------------
// 本物の1ターン（道具を持たない最小のプロンプト）
// ---------------------------------------------------------------------------

/** 試しに送る唯一のプロンプト。内容そのものに意味は無い——応答が返るかだけを見る。 */
export const TOKEN_TRIAL_PROMPT_TEXT = 'ping';

/**
 * 試しのシステムプロンプト。**最小。** クローン・マネージャーの人格を1文字も
 * 継がない——これは認証が生きているかだけを確かめる機械的な1ターンである。
 */
export const TOKEN_TRIAL_SYSTEM_PROMPT =
  'This is an automated authentication check, not a real conversation. Reply with a single short word.';

/** 締め切りの既定。probe（`USAGE_PROBE_TIMEOUT_MS` = 20秒）より長い —— 実際に
 * モデルが1トークン以上生成するので、idle の probe より遅くて当然である。 */
export const TOKEN_TRIAL_TIMEOUT_MS = 30_000;

/** `runTokenTrial` が呼ぶ `query` の顔。実物の `query()` と構造的に同じ形。 */
export type TokenTrialQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** 1つだけプロンプトを送って終わる入力ストリーム。 */
async function* singleTrialPrompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: TOKEN_TRIAL_PROMPT_TEXT },
    parent_tool_use_id: null,
  };
}

export interface RunTokenTrialOptions {
  cwd: string;
  /** 試す鍵の値。**`CLAUDE_CODE_OAUTH_TOKEN` として渡す以外の用途に使わない。** */
  token: string;
  /** クローンの層と同じモデルのエイリアス（`CLONE_MODEL` / `ALTEROID_CLONE_MODEL`）。 */
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** `probeTokenCandidate` / `fetchAccountUsage` と同じ作法で他の資格を外す（#431）。 */
  withheldEnvKeys?: readonly string[];
}

function buildTrialEnv(options: RunTokenTrialOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.token };
  for (const key of options.withheldEnvKeys ?? []) delete env[key];
  return env;
}

/**
 * 冷却中の鍵を1本、本物の最小の1ターンで試す。**投げない。**
 *
 * ## 判定（設計点5）
 *
 * - **`usable`**: 応答として返り（`result` が `success` かつ `is_error` で
 *   ない。`sdk-failure.ts` の `isAnsweredResult` と同じ基準）、**かつ**
 *   `rate_limit_event` が一度も `rejected` を運ばなかったとき。
 * - **`unusable`**: `rate_limit_event` が `rejected` を運んだとき、または
 *   `result` の失敗が 429 だったとき。`resetsAt` が取れれば持ち帰る
 *   （`cooldownDeadlineFrom` と同じ優先順——枠 → 課金枠）。
 * - **`undecidable`**: それ以外すべて（通信断・締め切り・中断・判定できない
 *   失敗）。#1456 の教訓（枠で落ちたターンを成功と読むと輪になる）に合わせ、
 *   **迷ったら `usable` にも `unusable` にもしない。**
 *
 * ## 層のセッションに撒かない
 *
 * これは使い捨ての1ターンであって、クローン・マネージャーのセッションには
 * 一切繋がらない。`settingSources` は空、`tools` は無し、`maxTurns: 1`。
 */
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
        // **人間の設定層を読ませない**（`usage-probe.ts` の probe と同じ判断）。
        // これはクローン・マネージャーのどちらの人格でもない、使い捨ての試しである。
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
              // **枠の `resetsAt` から採れたときだけ持ち帰る。** 受け手
              // （`TokenRotator.recordTrialVerdict`）はこの期限を `quota_reset` と
              // して書くので、課金枠の期限（`overage_reset`）を渡すと出所を偽る。
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
