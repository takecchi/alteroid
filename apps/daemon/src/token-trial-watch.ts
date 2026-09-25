import {
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  credentialOf,
  describeTrialFailureFold,
  doubledTrialIntervalMs,
  selectTokenForTrial,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenTrialPort,
} from '@alteroid/core';

/**
 * ダメ元の試し（Issue #1501）の**目盛りとメモリ状態**。
 *
 * 「試すべきか・どれを・どんな結果だったか」の判断そのものは core
 * （`packages/core/src/token-trial.ts`）が持つ純粋関数（`selectTokenForTrial`）
 * とポート（`TokenTrialPort`）に任せてある。ここが持つのはそれをいつ呼ぶか、
 * 結果をどう既存の経路（`TokenRotator.reconsider` → `settleTokenOutcome`）へ
 * 乗せるか、そして偽陽性の退き方（設計点8）のためのメモリだけである。
 *
 * ## 通ったら
 *
 * - **現役自身**が試しで通った場合: `reconsider({ reason: 'turn_succeeded',
 *   current: { verdict: usable, origin: { source: 'turn_success', ... } } })`
 *   を呼ぶ。これは本当に1ターン通った観測なので嘘ではない —— ただし `why` に
 *   ダメ元の試しで通った旨と、それまでの不通過回数を畳んで足す
 * - **現役以外**の候補が試しで通った場合: その行を `markTokenUsable` で
 *   `ready` に戻し、`reconsider({ reason: 'trial_succeeded' })` で通常の
 *   見直しを1回走らせる。既存の状態判定（現役が通らないのに `ready` な候補が
 *   在る）がそのまま拾い、`rotated` を出す
 *
 * どちらも結果は `onOutcome`（＝ `apps/daemon/src/index.ts` の
 * `settleTokenOutcome`）へそのまま渡す —— 層を起こす経路は1本しか無い。
 *
 * ## 失敗したら
 *
 * **日誌にも受信箱にも1行も積まない。層も起こさない。** `stderr` へ高々1行。
 * `unusable` で `resetsAt` が取れて記録と違えば、冷却を権威ある値で書き直す
 * （書く必要が無ければストアを書かない）。失敗の件数は鍵ごとにメモリで数え、
 * 次に通った回の1行へ畳んで載せる（{@link describeTrialFailureFold}）。
 *
 * ## 偽陽性の退き方（設計点8）
 *
 * 試しで通した鍵が、その後 {@link TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS}
 * 以内に**同じ鍵**で本物の拒否（`noteRejection`）を観測したら、その鍵の
 * 試しの間隔を倍にする（上限あり）。窓のあいだに何も無ければ、次の目盛りで
 * 既定へ戻す。
 */

export const TOKEN_TRIAL_WATCH_TICK_MS = 60_000;

export interface TokenTrialWatchOptions {
  stores: Stores;
  trial: TokenTrialPort;
  /** `TokenRotator.reconsider` そのもの。この見張りは回し手の判断を1つも持たない。 */
  reconsider: TokenRotator['reconsider'];
  /**
   * `TokenRotator.recordTrialVerdict` そのもの。**記録を書くのは回し手の列の中だけ**
   * （あちらの doc）——この見張りは `stores` を読むだけで、1行も書かない。
   */
  recordTrialVerdict: TokenRotator['recordTrialVerdict'];
  /** 結果の行き先。`apps/daemon/src/index.ts` の `settleTokenOutcome` と同じ1本。 */
  onOutcome: (outcome: TokenRotationOutcome) => Promise<void>;
  /** 主にテスト用。 */
  now?: () => number;
  tickMs?: number;
  signal?: AbortSignal;
}

export interface TokenTrialWatch {
  /**
   * **本物の拒否**（セッション由来の観測。`observe()` が実際に処理した回）を
   * 伝える。偽陽性の判定だけに使う——ここで日誌や受信箱には触らない
   * （それは通常の `observe()` の経路が既にやっている）。
   *
   * `tokenId` は拒否を観測したときの身元（`observedBy.tokenId` /
   * `outgoingId`）。試しの成功から遠い（窓の外）鍵、あるいは試したことが
   * 無い鍵を渡しても何も起きない。
   */
  noteRejection(tokenId: string, at?: number): void;
  stop(): void;
}

/** `why` に注記を1つ足す。**`rotated` / `recovered`（`ignored` の一種）にだけ効く。** */
function annotateOutcome(outcome: TokenRotationOutcome, note: string): TokenRotationOutcome {
  if (note === '') return outcome;
  if (outcome.kind === 'rotated') return { ...outcome, why: `${outcome.why}${note}` };
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    return { ...outcome, why: `${outcome.why}${note}` };
  }
  return outcome;
}

export function startTokenTrialWatch(options: TokenTrialWatchOptions): TokenTrialWatch {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? TOKEN_TRIAL_WATCH_TICK_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;

  /** キーはすべて `tokenId`。プロセスの寿命でしか持たない（記憶ストアは変えない）。 */
  const lastTriedAt = new Map<string, number>();
  const failureCount = new Map<string, number>();
  const intervalOverride = new Map<string, number>();
  /** 試しが通った直後、偽陽性の窓のあいだだけ持つ（値は通った時刻）。 */
  const pendingConfirmation = new Map<string, number>();

  const intervalMsFor = (tokenId: string): number =>
    intervalOverride.get(tokenId) ?? TOKEN_TRIAL_INTERVAL_MS;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  /** 窓を過ぎても本物の拒否が来なかった鍵は、間隔を既定へ戻す。 */
  function confirmPendingSuccesses(at: number): void {
    for (const [tokenId, successAt] of pendingConfirmation) {
      if (at - successAt >= TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS) {
        pendingConfirmation.delete(tokenId);
        intervalOverride.delete(tokenId);
      }
    }
  }

  async function handleFailure(
    token: AgentToken,
    verdict: Exclude<TokenCandidateVerdict, { verdict: 'usable' }>,
  ): Promise<void> {
    const count = (failureCount.get(token.id) ?? 0) + 1;
    failureCount.set(token.id, count);
    if (verdict.verdict === 'unusable') {
      // `retryAt` が取れて記録と違うときだけ、回し手の列の中で書き直す。
      await options.recordTrialVerdict({ tokenId: token.id, verdict });
      process.stderr.write(
        `alteroidd: 認証トークンの試し（id ${token.id} / 「${token.label}」）は通らなかった` +
          `（${verdict.reason}）。連続不通過: ${String(count)}\n`,
      );
      return;
    }
    process.stderr.write(
      `alteroidd: 認証トークンの試し（id ${token.id} / 「${token.label}」）は判定できなかった` +
        `（${verdict.reason}）。連続不通過（未判定を含む）: ${String(count)}\n`,
    );
  }

  async function handleSuccess(token: AgentToken): Promise<void> {
    const failedBefore = failureCount.get(token.id) ?? 0;
    failureCount.delete(token.id);
    pendingConfirmation.set(token.id, now());
    const fold = describeTrialFailureFold(failedBefore);

    // **現役かどうかは、いま読み直して決める。** 選んだ時点から結果が届く
    // までのあいだ（本物の1ターンぶん）に、既に回っている可能性がある。
    const active = await options.stores.tokens.readActive();
    if (active !== null && active.tokenId === token.id) {
      const outcome = await options.reconsider({
        reason: 'turn_succeeded',
        current: {
          verdict: { verdict: 'usable' },
          origin: {
            source: 'turn_success',
            observedBy: { tokenId: active.tokenId, generation: active.generation },
          },
        },
      });
      await options.onOutcome(annotateOutcome(outcome, fold));
      return;
    }

    // **現役ではない。** 冷却の記録を消して、通常の見直しに委ねる
    // （`selectNextToken` が `ready` になったこの行を拾う）。
    await options.recordTrialVerdict({ tokenId: token.id, verdict: { verdict: 'usable' } });
    const outcome = await options.reconsider({ reason: 'trial_succeeded' });
    await options.onOutcome(annotateOutcome(outcome, fold));
  }

  async function runOneTrial(token: AgentToken): Promise<void> {
    lastTriedAt.set(token.id, now());
    let verdict: TokenCandidateVerdict;
    try {
      verdict = await options.trial.trial({ id: token.id, ...credentialOf(token) });
    } catch (error) {
      verdict = { verdict: 'undecidable', reason: String(error) };
    }
    if (verdict.verdict === 'usable') {
      await handleSuccess(token);
      return;
    }
    await handleFailure(token, verdict);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const at = now();
    confirmPendingSuccesses(at);
    if (inFlight) return;
    const [tokens, active] = await Promise.all([
      options.stores.tokens.list(),
      options.stores.tokens.readActive(),
    ]);
    const target = selectTokenForTrial({
      tokens,
      active,
      at,
      lastTriedAt: Object.fromEntries(lastTriedAt),
      intervalMsFor,
    });
    if (target === undefined || target.value === undefined) return;
    inFlight = true;
    try {
      await runOneTrial(target);
    } catch (error) {
      process.stderr.write(`alteroidd: 認証トークンの試しが落ちました: ${String(error)}\n`);
    } finally {
      inFlight = false;
    }
  }

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
    timer.unref?.();
  };
  schedule();

  return {
    noteRejection: (tokenId, at) => {
      const when = at ?? now();
      const successAt = pendingConfirmation.get(tokenId);
      if (successAt === undefined) return;
      if (when - successAt > TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS) return;
      pendingConfirmation.delete(tokenId);
      intervalOverride.set(tokenId, doubledTrialIntervalMs(intervalMsFor(tokenId)));
    },
    stop,
  };
}
