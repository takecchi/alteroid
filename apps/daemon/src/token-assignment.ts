import {
  fingerprintOf,
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
 * 配り方 `balanced` の割り当ての帳面（#6633）。デーモンのメモリにだけ持つ（委譲の割り当ては job に id だけ残し、引き取りで `adopt` し直す）。
 *
 * 世代は割り当てのたびに単調に増やす（`max(前+1, now)`）: 同じ鍵を冷却明けにもう一度割り当てた後に、
 * 前の在任期間の遅れた枠の知らせが届いても、いまの割り当ての知らせと取り違えないため（現役の世代と同じ考え方）。
 */
export interface TokenAssignmentBook {
  /**
   * 作業単位に鍵を割り当てる。`failover` のとき・通る鍵が1本も無いときは `undefined`（器の現役で走る＝従来どおり）。
   * `prior` の鍵が通るなら替えない（作業の途中で鍵を替えない）。いま持っている割り当てがその鍵なら世代も替えない。
   */
  assign(unitId: string, hint?: { prior?: string }): Promise<AssignedToken | undefined>;
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
  units(): string[];
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

  const pick = (
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
    units() {
      return [...assignments.keys()];
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
