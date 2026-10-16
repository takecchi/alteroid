import type {
  Job,
  LastRescue,
  LastUnpushedWorkObservation,
  RescueRemovalReason,
  RescueWorktree,
} from './schema.js';

// 判定できないもの（時刻が読めない・状態が分からない）を「消してよい」へ倒さない。
// 猶予の起点は `lastRescue.at` だけにしない: `lost` のまま長く放置されたものが abort で `stopped` になった瞬間に、猶予ゼロで唯一の写しが消える。
// `Job.updatedAt` も使わない: 後始末自身の台帳書き込みでも進む。
// `lost` は時間では消さない: 「戻れなかった」であって「成果が無い」ではなく、退避 ref は外へ出た成果を確かめる材料になる。
// `done` を即時にしない: 器の入れ替わりで作業ツリーが消えても、退避 ref が唯一の写しとして残る。

const DAY_MS = 24 * 60 * 60_000;

export const RESCUE_GRACE_MS = {
  done: 7 * DAY_MS,
  failed: 14 * DAY_MS,
  stopped: 14 * DAY_MS,
} as const;

export const RESCUE_RETRY_BASE_MS = 10 * 60_000;
export const RESCUE_RETRY_MAX_MS = DAY_MS;

export const RESCUE_LEDGER_REMOVED_KEEP_MS = 7 * DAY_MS;
export const RESCUE_LEDGER_NOTHING_KEEP_MS = 14 * DAY_MS;

function isGraceStatus(status: Job['status']): status is keyof typeof RESCUE_GRACE_MS {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

export function rescueRetryAfterMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(RESCUE_RETRY_MAX_MS, RESCUE_RETRY_BASE_MS * 2 ** Math.min(n - 1, 20));
}

export function rescueRemovalDue(
  status: Job['status'],
  rescue: LastRescue,
  tree: RescueWorktree,
  nowMs: number,
): RescueRemovalReason | undefined {
  const pushed = tree.pushed;
  if (pushed === undefined) return undefined;
  const removal = pushed.removal;
  if (removal !== undefined) {
    if (removal.failureKind === undefined) return undefined;
    // 同じ commit では所在は増えないので確定扱い（再試行も台帳の書き込みもしない）。
    if (removal.failureKind === 'no-remote') return undefined;
    // 時刻が読めなければ撃つ: lease があるので、消してはいけないものは消えない。
    const at = Date.parse(removal.at);
    if (!Number.isNaN(at) && nowMs - at < rescueRetryAfterMs(removal.attempts ?? 1)) {
      return undefined;
    }
  }
  if (pushed.landedAt !== undefined) return 'landed';
  return graceElapsed(status, rescue, nowMs);
}

function graceElapsed(
  status: Job['status'],
  rescue: LastRescue,
  nowMs: number,
): 'done' | 'failed' | 'stopped' | undefined {
  if (!isGraceStatus(status)) return undefined;
  if (rescue.terminal?.status !== status) return undefined;
  const at = Date.parse(rescue.at);
  const seenAt = Date.parse(rescue.terminal.seenAt);
  if (Number.isNaN(at) || Number.isNaN(seenAt)) return undefined;
  return nowMs - Math.max(at, seenAt) >= RESCUE_GRACE_MS[status] ? status : undefined;
}

/**
 * 未追跡のファイルの預かり（`Job.rescueStash`。#4863）を消してよいか。退避 ref と同じ猶予（done 7日・failed/stopped 14日・`lost` は時間で消さない）で、
 * 起点も同じ（`max(lastRescue.at, terminal.seenAt)`）。`landed` では消さない: 預かりは origin の枝に入っているかを確かめる材料が無い（公開 repo へ送らないファイルのため）。
 */
export function rescueStashRemovalDue(
  status: Job['status'],
  rescue: LastRescue,
  nowMs: number,
): boolean {
  return graceElapsed(status, rescue, nowMs) !== undefined;
}

export function syncTerminalMark(
  status: Job['status'],
  rescue: LastRescue,
  nowIso: string,
): LastRescue | null {
  if (isGraceStatus(status)) {
    if (rescue.terminal?.status === status) return null;
    return { ...rescue, terminal: { status, seenAt: nowIso } };
  }
  if (rescue.terminal === undefined) return null;
  const rest = { ...rescue };
  delete rest.terminal;
  return rest;
}

/**
 * 退避の時刻（runner の時計）と観測の時刻（デーモンの時計）を比べるときの余裕。時計のずれで、観測の往復の最中に作られて退避された作業ツリーへ
 * 印を付けないため。余裕の内側で付け損ねても、次の観測でまた判定する。
 */
export const RESCUE_GONE_CLOCK_MARGIN_MS = 60_000;

/**
 * 退避した器が生きているうちに、全部を見た観測でその作業ツリーが無かった項目へ `goneAt` を付ける（#4985）。変わらなければ `null`。
 * 「器の入れ替えで消えた」と区別するため、退避を預かった時の `instanceId` と観測を返した器の `instanceId` が同じときだけ付ける。
 * どちらかが分からなければ付けない: 付けると rescue-only の案内から外れ、入れ替えで消えた退避を黙って落とす向きに倒れるため。
 * 観測が途中で切れていた（件数の上限・早期停止・走査の起点が不明・読めないディレクトリ）なら付けない: 「無い」と「見えていない」を分けられないため。
 */
export function markRescueGoneWhileAlive(
  rescue: LastRescue | undefined,
  observation: LastUnpushedWorkObservation,
  observerInstanceId: string | undefined,
): LastRescue | null {
  if (rescue === undefined || observerInstanceId === undefined) return null;
  if (
    observation.kind !== 'observed' ||
    observation.truncatedAtCount !== undefined ||
    observation.stoppedEarly !== undefined ||
    observation.scratchRootsUnknown !== undefined ||
    observation.unreadableDirCount !== undefined
  ) {
    return null;
  }
  const seenAt = Date.parse(observation.at);
  if (Number.isNaN(seenAt)) return null;
  let changed = false;
  const worktrees = rescue.worktrees.map((tree) => {
    const rescuedAt = Date.parse(tree.at);
    if (
      tree.goneAt !== undefined ||
      tree.instanceId !== observerInstanceId ||
      Number.isNaN(rescuedAt) ||
      !(seenAt - rescuedAt > RESCUE_GONE_CLOCK_MARGIN_MS) ||
      observation.worktrees.some((worktree) => worktree.relativePath === tree.relativePath)
    ) {
      return tree;
    }
    changed = true;
    return { ...tree, goneAt: observation.at };
  });
  return changed ? { ...rescue, worktrees } : null;
}

// ref は触らない: 消すのは `rescueRemovalDue` の判定を通った後始末だけ。
export function pruneRescueLedger(
  status: Job['status'],
  rescue: LastRescue,
  nowMs: number,
): LastRescue | undefined | null {
  if (status === 'running' || status === 'waiting_human') return null;
  const quietSince = Date.parse(rescue.at);
  if (Number.isNaN(quietSince)) return null;
  const quietMs = nowMs - quietSince;
  const kept = rescue.worktrees.filter((tree) => {
    const removal = tree.pushed?.removal;
    if (tree.pushed === undefined) return quietMs < RESCUE_LEDGER_NOTHING_KEEP_MS;
    if (removal === undefined || removal.failureKind !== undefined) return true;
    const removedAt = Date.parse(removal.at);
    if (Number.isNaN(removedAt)) return true;
    return !(
      nowMs - removedAt >= RESCUE_LEDGER_REMOVED_KEEP_MS && quietMs >= RESCUE_LEDGER_REMOVED_KEEP_MS
    );
  });
  if (kept.length === rescue.worktrees.length) return null;
  return kept.length === 0 ? undefined : { ...rescue, worktrees: kept };
}
