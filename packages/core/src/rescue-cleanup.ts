import type { Job, LastRescue, RescueRemovalReason, RescueWorktree } from './schema.js';

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
  if (!isGraceStatus(status)) return undefined;
  if (rescue.terminal?.status !== status) return undefined;
  const at = Date.parse(rescue.at);
  const seenAt = Date.parse(rescue.terminal.seenAt);
  if (Number.isNaN(at) || Number.isNaN(seenAt)) return undefined;
  return nowMs - Math.max(at, seenAt) >= RESCUE_GRACE_MS[status] ? status : undefined;
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
