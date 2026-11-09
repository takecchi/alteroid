import { tokenAvailabilityAt, type AgentToken } from './token-pool.js';
import { selectNextToken, type TokenSelection } from './token-rotation.js';
import type { AccountUsageState } from './usage-snapshot.js';

/**
 * 鍵1本の「混み具合」（#6633）。窓ごとの使用率の最大（0〜100）。取れなければ `undefined`。
 *
 * 最大を採る: どれか1つの窓が尽きればその鍵は止まるので、平均すると週の窓が尽きかけの鍵を空いていると読むため。
 */
export function tokenLoadScoreOf(state: AccountUsageState | undefined): number | undefined {
  if (state?.state !== 'ok') return undefined;
  const utilizations = state.usage.windows.flatMap((window) =>
    window.utilization === undefined ? [] : [window.utilization],
  );
  return utilizations.length === 0 ? undefined : Math.max(...utilizations);
}

export interface BalancedTokenPickInput {
  tokens: readonly AgentToken[];
  at: number;
  /** 鍵ごとの混み具合（`tokenLoadScoreOf`）。測っていない鍵は入れないか `undefined`。 */
  loadScores: ReadonlyMap<string, number | undefined>;
  /** いまその鍵を割り当てているセッションの数。 */
  assignedCounts: ReadonlyMap<string, number>;
  exclude?: readonly string[];
}

/**
 * 配り方 `balanced` で、新しい作業単位に割り当てる鍵を選ぶ（#6633）。
 *
 * 厳密な均等は狙わない（オーナーの依頼は「なんとなくならせれば良い」）。順は:
 * 1. 混み具合が低い。**測っていない鍵は、プール全体で測れた鍵の平均として扱う** —— 最も空いている扱いにすると、
 *    probe が取れない鍵へ全部が流れ、最も混んでいる扱いにすると、足したばかりの鍵が測れるまで使われないため
 * 2. 割り当て中のセッションが少ない（どれも測れていない構成では、これが実質の振り分けになる）
 * 3. 人間が決めた試す順（`order`）
 *
 * 通る鍵が1本も無ければ `selectNextToken` と同じ `none`（いちばん早く戻る鍵の見込み付き）を返す。
 */
export function selectBalancedToken(input: BalancedTokenPickInput): TokenSelection {
  const excluded = new Set(input.exclude ?? []);
  const ready = input.tokens.filter(
    (token) => !excluded.has(token.id) && tokenAvailabilityAt(token, input.at) === 'ready',
  );
  if (ready.length === 0) {
    return selectNextToken(input.tokens, {
      at: input.at,
      ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    });
  }

  // 平均はプール全体の観測で取る（通る鍵だけに絞らない）: 絞ると、測れた通る鍵が1本のとき新しい鍵がそれと同点になり、試す順だけで負け続けるため
  const measured = [...input.loadScores.values()].filter(
    (score): score is number => score !== undefined,
  );
  const fallbackScore =
    measured.length === 0 ? 0 : measured.reduce((sum, score) => sum + score, 0) / measured.length;
  const scoreOf = (token: AgentToken) => input.loadScores.get(token.id) ?? fallbackScore;
  const countOf = (token: AgentToken) => input.assignedCounts.get(token.id) ?? 0;

  const [best] = [...ready].sort(
    (a, b) => scoreOf(a) - scoreOf(b) || countOf(a) - countOf(b) || a.order - b.order,
  );
  // `ready` が空でないので必ず在る
  return { kind: 'candidate', token: best as AgentToken };
}
