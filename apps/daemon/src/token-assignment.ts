import {
  fingerprintOf,
  keepsContainerToken,
  selectBalancedToken,
  tokenAvailabilityAt,
  tokenLoadScoreOf,
  type AgentToken,
  type AccountUsageState,
} from '@alteroid/core';

/** 作業単位（委譲の managerId、またはクローン）に割り当てた鍵の身元と値。値はこの帳面とセッションの env の外へ出さない。 */
export interface AssignedToken {
  tokenId: string;
  label: string;
  generation: number;
  fingerprint: string;
  value: string;
}

export type AssignmentIdentity = Pick<AssignedToken, 'tokenId' | 'generation' | 'fingerprint'>;

/** 枠に当たった鍵の持ち主を移した結果。 */
export interface TokenEvacuation {
  moved: { unitId: string; from: AssignmentIdentity; to: AssignmentIdentity; label: string }[];
  /** 通る鍵が1本も無く、移せなかった持ち主（割り当ては外す。戻るまで現役＝器の鍵で走る）。 */
  stranded: string[];
}

export interface TokenAssignmentBookOptions {
  readTokens: () => Promise<AgentToken[]>;
  /** いまの配り方。`failover` の間は何も割り当てない。 */
  balanced: () => Promise<boolean>;
  loads: () => readonly { tokenId: string; state: AccountUsageState }[];
  now?: () => number;
}

/** クローンの作業単位の id。委譲の managerId と重ならない形にする。 */
export const CLONE_ASSIGNMENT_UNIT = 'clone';

/**
 * 測れない鍵で、コンテナを空いている鍵へ移す差（#6649）。コンテナの鍵に寄っている数が、いちばん少ない通る鍵よりこれ以上多いときだけ移す。
 */
export const CONTAINER_REBALANCE_GAP = 2;

/**
 * 配り方 `balanced` の割り当ての帳面（#6633）。デーモンのメモリにだけ持つ（委譲の割り当ては job に id だけ残し、引き取りで `adopt` し直す）。
 *
 * **同じ担当（コンテナ）には、できるかぎり同じ鍵を割り当て続ける**（#6642。キャッシュはアカウントをまたがないため）。
 * 散らし方を変える前に `.claude/skills/token-pool/SKILL.md` の「配り方」の節を読むこと。
 *
 * 世代は割り当てのたびに単調に増やす（`max(前+1, now)`）: 同じ鍵を冷却明けにもう一度割り当てた後に、
 * 前の在任期間の遅れた枠の知らせが届いても、いまの割り当ての知らせと取り違えないため（現役の世代と同じ考え方）。
 */
export interface TokenAssignmentBook {
  /**
   * 作業単位に鍵を割り当てる。`failover` のとき・通る鍵が1本も無いときは `undefined`（器の現役で走る＝従来どおり）。
   * `prior` の鍵が通るなら替えない（作業の途中で鍵を替えない）。いま持っている割り当てがその鍵なら世代も替えない。
   * 新しく選ぶときは `container`（省けば作業単位そのもの）がいま使っている鍵を、混み具合が閾値未満なら使い続ける（#6642）。
   */
  assign(
    unitId: string,
    hint?: { prior?: string; container?: string },
  ): Promise<AssignedToken | undefined>;
  target(unitId: string): AssignmentIdentity | undefined;
  /** クローンの env へ重ねる値（同期で読む口。値はここからセッションの env へだけ渡る）。 */
  valueOf(unitId: string): string | undefined;
  release(unitId: string): void;
  /** `tokenId` を持つ作業単位を、次に空いている鍵へ移す。通る鍵が無ければ割り当てを外す。 */
  evacuate(tokenId: string): Promise<TokenEvacuation>;
  /** 割り当てた鍵が通らなくなっている作業単位を、通る鍵へ移し直す（見張りの目盛りから呼ぶ）。 */
  reconcile(): Promise<TokenEvacuation>;
  /**
   * 枠の知らせの身元がいまの割り当てか。この帳面が出した世代でなければ `unknown`（現役の回し手の側で判断する）。
   */
  freshnessOf(observedBy: { tokenId: string; generation: number }): 'current' | 'stale' | 'unknown';
}

export function createTokenAssignmentBook(
  options: TokenAssignmentBookOptions,
): TokenAssignmentBook {
  const now = options.now ?? Date.now;
  const assignments = new Map<string, AssignedToken>();
  const issued = new Set<string>();
  let lastGeneration = 0;

  const keyOf = (identity: { tokenId: string; generation: number }) =>
    `${identity.tokenId}\u0000${String(identity.generation)}`;

  const nextGeneration = () => {
    lastGeneration = Math.max(lastGeneration + 1, now());
    return lastGeneration;
  };

  const issue = (token: AgentToken & { value: string }): AssignedToken => {
    const assigned = {
      tokenId: token.id,
      label: token.label,
      generation: nextGeneration(),
      fingerprint: fingerprintOf(token.value),
      value: token.value,
    };
    issued.add(keyOf(assigned));
    return assigned;
  };

  const countsExcluding = (unitId: string) => {
    const counts = new Map<string, number>();
    for (const [unit, assigned] of assignments) {
      if (unit === unitId) continue;
      counts.set(assigned.tokenId, (counts.get(assigned.tokenId) ?? 0) + 1);
    }
    return counts;
  };

  const loadScores = () =>
    new Map(options.loads().map((load) => [load.tokenId, tokenLoadScoreOf(load.state)]));

  const usable = (
    token: AgentToken | undefined,
    at: number,
  ): token is AgentToken & { value: string } =>
    token?.value !== undefined && tokenAvailabilityAt(token, at) === 'ready';

  // コンテナ（runner・クローン）ごとの「いま使っている鍵」（#6642）。作業単位が畳まれても消さない: 次の作業が同じ鍵へ寄れるため
  const containerOf = new Map<string, string>();
  const containerToken = new Map<string, string>();

  const containerKey = (unitId: string) => containerOf.get(unitId) ?? unitId;

  // 記録が無い（再起動の後）ときは、そのコンテナの作業単位がいちばん多く持っている鍵を採る: 引き取った委譲が前の鍵のまま走っているため
  const containerTokenOf = (container: string, unitId: string): string | undefined => {
    const recorded = containerToken.get(container);
    if (recorded !== undefined) return recorded;
    const counts = new Map<string, number>();
    for (const [unit, assigned] of assignments) {
      if (unit === unitId || containerKey(unit) !== container) continue;
      counts.set(assigned.tokenId, (counts.get(assigned.tokenId) ?? 0) + 1);
    }
    let best: string | undefined;
    for (const [tokenId, count] of counts) {
      if (best === undefined || count > (counts.get(best) ?? 0)) best = tokenId;
    }
    return best;
  };

  const pick = (
    tokens: readonly AgentToken[],
    unitId: string,
    at: number,
    exclude?: readonly string[],
  ): (AgentToken & { value: string }) | undefined => {
    const container = containerKey(unitId);
    const preferredId = containerTokenOf(container, unitId);
    const preferred = tokens.find((token) => token.id === preferredId);
    if (usable(preferred, at) && !(exclude ?? []).includes(preferred.id)) {
      const score = loadScores().get(preferred.id);
      if (score !== undefined) {
        if (keepsContainerToken(score)) {
          containerToken.set(container, preferred.id);
          return preferred;
        }
      } else {
        // 測れない鍵では使用率の閾値が成り立たない（profile スコープの無い鍵ではふつう）ので、寄っているコンテナの数で偏りを見る（#6649）。
        // これが無いと、一度の停止で全コンテナが残った鍵へ寄り、止まった鍵が戻っても failover と同じ偏りのまま戻らない
        const relief = lessCrowdedToken(tokens, container, preferred.id, at, exclude);
        if (relief === undefined) {
          containerToken.set(container, preferred.id);
          return preferred;
        }
        containerToken.set(container, relief.id);
        return relief;
      }
    }
    const picked = pickBalanced(tokens, unitId, at, exclude);
    if (picked !== undefined) containerToken.set(container, picked.id);
    return picked;
  };

  const containersOn = (tokenId: string, exceptContainer: string): number => {
    let count = 0;
    for (const [other, held] of containerToken) {
      if (other !== exceptContainer && held === tokenId) count += 1;
    }
    return count;
  };

  /**
   * コンテナの鍵より空いている通る鍵（#6649）。寄っているコンテナの数の差が {@link CONTAINER_REBALANCE_GAP} 以上のときだけ返す。
   * 差 1 で移さない: 移した先が今度は 1 多くなり、行ったり来たりしてキャッシュを毎回失うため。
   */
  const lessCrowdedToken = (
    tokens: readonly AgentToken[],
    container: string,
    currentId: string,
    at: number,
    exclude?: readonly string[],
  ): (AgentToken & { value: string }) | undefined => {
    const here = containersOn(currentId, container) + 1;
    let best: (AgentToken & { value: string }) | undefined;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const token of [...tokens].sort((a, b) => a.order - b.order)) {
      if (token.id === currentId || (exclude ?? []).includes(token.id) || !usable(token, at)) {
        continue;
      }
      const count = containersOn(token.id, container);
      if (count < bestCount) {
        best = token;
        bestCount = count;
      }
    }
    return best !== undefined && here - bestCount >= CONTAINER_REBALANCE_GAP ? best : undefined;
  };

  const pickBalanced = (
    tokens: readonly AgentToken[],
    unitId: string,
    at: number,
    exclude?: readonly string[],
  ): (AgentToken & { value: string }) | undefined => {
    const selection = selectBalancedToken({
      // 値の無い行は配れない
      tokens: tokens.filter((token) => token.value !== undefined),
      at,
      loadScores: loadScores(),
      assignedCounts: countsExcluding(unitId),
      ...(exclude === undefined ? {} : { exclude }),
    });
    return selection.kind === 'candidate' && selection.token.value !== undefined
      ? (selection.token as AgentToken & { value: string })
      : undefined;
  };

  const moveHolders = async (
    shouldMove: (assigned: AssignedToken, row: AgentToken | undefined, at: number) => boolean,
  ): Promise<TokenEvacuation> => {
    const result: TokenEvacuation = { moved: [], stranded: [] };
    if (!(await options.balanced())) return result;
    const tokens = await options.readTokens();
    const at = now();
    for (const [unitId, assigned] of [...assignments]) {
      const row = tokens.find((token) => token.id === assigned.tokenId);
      if (!shouldMove(assigned, row, at)) continue;
      const next = pick(tokens, unitId, at, [assigned.tokenId]);
      if (next === undefined) {
        assignments.delete(unitId);
        result.stranded.push(unitId);
        continue;
      }
      const to = issue(next);
      assignments.set(unitId, to);
      result.moved.push({
        unitId,
        from: identityOf(assigned),
        to: identityOf(to),
        label: to.label,
      });
    }
    return result;
  };

  return {
    async assign(unitId, hint = {}) {
      if (!(await options.balanced())) {
        assignments.delete(unitId);
        return undefined;
      }
      if (hint.container !== undefined) containerOf.set(unitId, hint.container);
      const tokens = await options.readTokens();
      const at = now();
      const current = assignments.get(unitId);
      const priorId = hint.prior ?? current?.tokenId;
      const prior = tokens.find((token) => token.id === priorId);
      if (usable(prior, at)) {
        // 同じ鍵・同じ値を持ち続けているなら身元も替えない: 替えると走っているセッションが「古い鍵」と読まれ、畳み直されるため
        if (current?.tokenId === prior.id && current.fingerprint === fingerprintOf(prior.value)) {
          return current;
        }
        const assigned = issue(prior);
        assignments.set(unitId, assigned);
        return assigned;
      }
      const next = pick(tokens, unitId, at);
      if (next === undefined) {
        assignments.delete(unitId);
        return undefined;
      }
      const assigned = issue(next);
      assignments.set(unitId, assigned);
      return assigned;
    },
    target(unitId) {
      const assigned = assignments.get(unitId);
      return assigned === undefined ? undefined : identityOf(assigned);
    },
    valueOf(unitId) {
      return assignments.get(unitId)?.value;
    },
    release(unitId) {
      assignments.delete(unitId);
      containerOf.delete(unitId);
    },
    evacuate(tokenId) {
      return moveHolders((assigned) => assigned.tokenId === tokenId);
    },
    reconcile() {
      return moveHolders(
        (assigned, row, at) =>
          !usable(row, at) || fingerprintOf(row.value) !== assigned.fingerprint,
      );
    },
    freshnessOf(observedBy) {
      if (!issued.has(keyOf(observedBy))) return 'unknown';
      for (const assigned of assignments.values()) {
        if (
          assigned.tokenId === observedBy.tokenId &&
          assigned.generation === observedBy.generation
        ) {
          return 'current';
        }
      }
      return 'stale';
    },
  };
}

function identityOf(assigned: AssignedToken): AssignmentIdentity {
  return {
    tokenId: assigned.tokenId,
    generation: assigned.generation,
    fingerprint: assigned.fingerprint,
  };
}
