import type { Job, LastRescue, RescueRemovalReason, RescueWorktree } from './schema.js';

/**
 * 退避 ref（`refs/alteroid-rescue/…`）の後始末の**判定**（Issue #1266）。副作用は持たない
 * （消すのは runner。台帳を書くのは `manager.ts` の `Pool#sweepRescueRefs`）。
 *
 * ## 決めたこと（理由つき）
 *
 * 消すのは次の2つの契機だけ。**どちらにも当たらなければ消さない**——判定できない
 * （時刻が読めない・状態が分からない）を「消してよい」へ倒さない。
 *
 * 1. **内容が origin の枝に入っている**（`pushed.landedAt`。runner が、退避 commit の
 *    tree と同じ tree を origin の remote-tracking の直近の commit に見つけた）。
 *    退避の目的（未 push の作業を失わない）が果たされているので、**委譲の状態によらず
 *    即座に**消す。tree の一致で見るので、「未コミットの変更を捨てただけ」（HEAD が
 *    origin に在るだけ）では当たらない。
 * 2. **委譲が終端して、猶予を過ぎた。** 退避 ref は「作業ツリーが消えたとき」の唯一の写しに
 *    なりうる。猶予は**終端してからの時間**で測り、その印は `lastRescue.at`（runner から最後に
 *    届いた時刻）を使う——`Job.updatedAt` は台帳へ書くたびに進む（この後始末自身の書き込み
 *    でも）ので使えない。生きているセッションは 30 分ごとに運び直すので、`lastRescue.at` が
 *    古いのは「セッションがもう無い」ことと同じ意味になる。
 *    - `done`: {@link RESCUE_GRACE_MS}.done（3日）。`done` は死ではなく待機（`schema.ts` の
 *      `jobStatusSchema`）で、話しかければ続く。**即時にしない**のは、`done` で畳んだ
 *      委譲の作業ツリーが器の入れ替わりで消えても、退避 ref が唯一の写しとして残るため
 *      （#1266 の動機そのもの）。ただし生きているセッションは `lastRescue.at` が進み続けるので
 *      この猶予に入らない。
 *    - `failed` / `stopped`: 14日。失敗・停止した仕事は、人間が原因を調べて取り戻しに来る
 *      のが数日〜週の単位で起きる。
 *    - **`lost` は時間では消さない。** `lost` は「戻れなかった」であって「成果が無い」では
 *      ない（`jobStatusSchema` の doc）。起こし直すかどうかはリモートを確かめて決める——退避 ref は
 *      その材料である。長期放置された `lost` の ref は溜まるが、1作業ツリーにつき1本で、
 *      人間が `lost` を `stopped` へ畳めば14日で消える。`running` / `waiting_human` も時間では
 *      消さない。
 */

const DAY_MS = 24 * 60 * 60_000;

/** 終端した委譲の退避 ref を消すまでの猶予（`lastRescue.at` から）。`lost` は無い（時間では消さない）。 */
export const RESCUE_GRACE_MS = {
  done: 3 * DAY_MS,
  failed: 14 * DAY_MS,
  stopped: 14 * DAY_MS,
} as const;

/** 消せなかった ref を再試行する間隔の最小（以後は回数で倍々）。 */
export const RESCUE_RETRY_BASE_MS = 10 * 60_000;
/** 再試行の間隔の上限。 */
export const RESCUE_RETRY_MAX_MS = DAY_MS;

/** 台帳から消えた作業ツリーの項目を片付ける猶予（C3）。 */
export const RESCUE_LEDGER_REMOVED_KEEP_MS = 7 * DAY_MS;
/** 退避された ref を持たない項目（名前だけの記録）を片付ける猶予。 */
export const RESCUE_LEDGER_NOTHING_KEEP_MS = 14 * DAY_MS;

function isGraceStatus(status: Job['status']): status is keyof typeof RESCUE_GRACE_MS {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

/** 消せなかった回の次の試行までの間隔。 */
export function rescueRetryAfterMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(RESCUE_RETRY_MAX_MS, RESCUE_RETRY_BASE_MS * 2 ** Math.min(n - 1, 20));
}

/**
 * この作業ツリーの退避 ref を、いま消すべきか。消すなら理由、消さないなら `undefined`。
 *
 * @param rescueAt `Job.lastRescue.at`（runner から最後に届いた時刻）
 */
export function rescueRemovalDue(
  status: Job['status'],
  rescueAt: string,
  tree: RescueWorktree,
  nowMs: number,
): RescueRemovalReason | undefined {
  const pushed = tree.pushed;
  if (pushed === undefined) return undefined;
  const removal = pushed.removal;
  if (removal !== undefined) {
    // 消した。もう何もしない。
    if (removal.failureKind === undefined) return undefined;
    // 消せなかった回。間隔が空くまで撃たない。時刻が読めなければ撃つ（lease があるので
    // 消してはいけないものは消えない）。
    const at = Date.parse(removal.at);
    if (!Number.isNaN(at) && nowMs - at < rescueRetryAfterMs(removal.attempts ?? 1)) {
      return undefined;
    }
  }
  if (pushed.landedAt !== undefined) return 'landed';
  if (!isGraceStatus(status)) return undefined;
  const quietSince = Date.parse(rescueAt);
  // 時刻が読めないものは判定しない（消さない）。
  if (Number.isNaN(quietSince)) return undefined;
  return nowMs - quietSince >= RESCUE_GRACE_MS[status] ? status : undefined;
}

/**
 * 台帳（`Job.lastRescue`）から、もう要らない作業ツリーの項目を落とす（C3）。**ref は触らない**
 * ——消すのは {@link rescueRemovalDue} の判定を通った後始末だけである。
 *
 * 落とすのは、委譲が `running` / `waiting_human` でなく、`lastRescue.at` から十分に時間が経った
 * 項目だけ:
 * - 消した記録（`pushed.removal` の `failureKind` 無し）が {@link RESCUE_LEDGER_REMOVED_KEEP_MS}
 *   より古い。
 * - 退避された ref が無い（名前だけの記録）まま {@link RESCUE_LEDGER_NOTHING_KEEP_MS} 経った。
 *
 * 消せなかった記録・消していない ref は**残す**。落としたものを runner が運び直したら
 * （生きているセッション）また載り、次の後始末で消し直す（lease があるので無害）。
 *
 * 変わらなければ `null`。全部落ちたら `undefined`（欄ごと外す）。
 */
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
