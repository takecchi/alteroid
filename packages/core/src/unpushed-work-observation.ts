import { definedProps } from './defined-props.js';
import type { LastUnpushedWorkObservation, UnpushedWorkObservationSource } from './schema.js';
import type { UnpushedWorkResult } from './runner-protocol.js';

/**
 * `tools.ts` の `MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS` と同じ値だが共有しない: `tools.ts` が
 * `manager.ts` を import する向きを逆にしないため。実測に基づく値ではない。
 * 待たない（fire-and-forget）のに上限を置くのは、応答が永久に返らないと
 * `#unpushedWorkObservationInFlight` の印が残り、その委譲について以降1本も投げられなくなるため。
 */
export const UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS = 5_000;

/**
 * `undefined` へ畳まない: `unavailable` は「確かめられなかった」ことそのもので、
 * 0 と混ぜない（取れない軸に0の行を作らない）。`reason` は人間・クローンが読む文言に
 * 直接使うので、機微を含まない範囲で短く書く。
 */
export type ManagerUnpushedWork =
  | { readonly kind: 'ok'; readonly result: UnpushedWorkResult }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * 変換ロジックを複数の書き込み元で手で合わせないための1箇所。`source` は呼び出し元が
 * 明示する: 省けば「不明」のまま台帳へ残り、ここでは推測で埋めない。
 * 「確かめきれなかった」4欄は `outcome.result` にあればそのまま写し、無ければ省く。
 * `unreadableDirSample` だけは写さない: 絶対パスを含みうるため（`cwd` を出さないのと同じ理由）。
 */
export function unpushedWorkObservationOf(
  outcome: ManagerUnpushedWork,
  at: string,
  source: UnpushedWorkObservationSource | undefined,
): LastUnpushedWorkObservation {
  return outcome.kind === 'ok'
    ? {
        kind: 'observed',
        at,
        ...(source === undefined ? {} : { source }),
        // 出してよい範囲を継ぐ（`observedWorktreeBranchSchema` の doc）。
        // 件数は「出してよい範囲」の内側なので写す。
        cwd: outcome.result.cwd,
        worktrees: outcome.result.worktrees.map((worktree) => ({
          relativePath: worktree.relativePath,
          branch: worktree.branch,
          ...definedProps({
            remoteOrigin: worktree.remoteOrigin,
            unpushedCommitCount: worktree.unpushedCommitCount,
            unpushedCommitCountUnknown: worktree.unpushedCommitCountUnknown,
            uncommittedChangeCount: worktree.uncommittedChangeCount,
            uncommittedChangeCountUnknown: worktree.uncommittedChangeCountUnknown,
          }),
        })),
        ...definedProps({
          truncatedAtCount: outcome.result.truncatedAtCount,
          stoppedEarly: outcome.result.stoppedEarly,
          scratchRootsUnknown: outcome.result.scratchRootsUnknown,
          unreadableDirCount: outcome.result.unreadableDirCount,
        }),
      }
    : {
        kind: 'unavailable',
        at,
        ...(source === undefined ? {} : { source }),
        reason: outcome.reason,
      };
}

/** 同点は勝たせる: `existing.at` が厳密に新しいときだけ弾く。 */
export function isUnpushedWorkObservationAtLeastAsNewAs(
  candidate: LastUnpushedWorkObservation,
  existing: LastUnpushedWorkObservation | undefined,
): boolean {
  return existing === undefined || !(existing.at > candidate.at);
}

/**
 * 新しい観測の `branch: null` で、前に取れていた枝名を消さない: pids が尽きて git を起こせない回（fork の EAGAIN）は、
 * 作業ツリーは readdir で見つかるのに枝名だけが取れず、それが「より新しい観測」として台帳の枝名を上書きするため。
 * null の理由（detached HEAD か失敗か）では分けない: どちらでも引き継いだ枝名は `branchCarriedFromAt` の時刻には正しく、
 * 時刻を名乗るので嘘にならない。`unavailable` へは引き継がない: 欄の形が違い、「確かめられなかった」を観測で埋めないため。
 */
export function carryKnownBranches(
  candidate: LastUnpushedWorkObservation,
  existing: LastUnpushedWorkObservation | undefined,
): LastUnpushedWorkObservation {
  if (candidate.kind !== 'observed' || existing?.kind !== 'observed') return candidate;
  const known = new Map(
    existing.worktrees
      .filter((worktree) => worktree.branch !== null)
      .map((worktree) => [worktree.relativePath, worktree]),
  );
  let carried = false;
  const worktrees = candidate.worktrees.map((worktree) => {
    const before = known.get(worktree.relativePath);
    if (worktree.branch !== null || before === undefined) return worktree;
    carried = true;
    return {
      ...worktree,
      branch: before.branch,
      ...(worktree.remoteOrigin === undefined && before.remoteOrigin !== undefined
        ? { remoteOrigin: before.remoteOrigin }
        : {}),
      branchCarriedFromAt: before.branchCarriedFromAt ?? existing.at,
    };
  });
  return carried ? { ...candidate, worktrees } : candidate;
}
