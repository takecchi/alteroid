import { PEER_APPROVAL_STALE_AFTER_MS, type PeerPendingApprovalInfo } from './peer-broker.js';

/**
 * 確認待ちの peer（担当が `peer_approve` で答えるのを待っている Codex のセッション）が 10 分以上残っていれば、
 * その事実を道具の結果に添えて知らせる（#4886）。
 *
 * 確認に期限は無く、答え忘れると peer は止まったまま誰にも見えない。**期限で自動に閉じない**（閉じると、担当が答えるつもりだった確認が黙って拒否になる）。
 * 見える化だけをする: **知らせるだけで、止めない・断らない**。答えるか・閉じるか・待つかは担当が決める。
 */

/** 同じ相手へ知らせ直す間隔。確認待ちが残り続ける間、道具を使うたびに同じ段落が積まれて文脈を食わないため。 */
export const PEER_APPROVAL_NOTICE_INTERVAL_MS = 10 * 60_000;

const APPROVALS_LIMIT = 3;

/** `nowMs` までに `PEER_APPROVAL_STALE_AFTER_MS` 以上待っているもの（待ちが長い順）。 */
export function staleApprovals(
  pending: readonly PeerPendingApprovalInfo[],
  nowMs: number,
): PeerPendingApprovalInfo[] {
  return pending
    .filter((entry) => nowMs - entry.since >= PEER_APPROVAL_STALE_AFTER_MS)
    .sort((a, b) => a.since - b.since);
}

export function describePeerApprovalStale(
  stale: readonly PeerPendingApprovalInfo[],
  nowMs: number,
): string {
  const shown = stale.slice(0, APPROVALS_LIMIT).map((entry) => {
    const minutes = Math.floor((nowMs - entry.since) / 60_000);
    return `peer ${entry.sessionId} の確認（approval_id ${entry.approvalId}）が ${String(minutes)} 分待っている`;
  });
  const omitted = stale.length - APPROVALS_LIMIT;
  const list = shown.join('、') + (omitted > 0 ? `、ほか ${String(omitted)} 本` : '');
  return (
    `⚠ alteroid からの知らせ: ${list}。` +
    'peer_approve で答えるか、要らなければ閉じること。答えるまで peer は止まったままで、確認の期限は無い。' +
    'これは状況の知らせで、止める指示ではない。'
  );
}

/**
 * 1つのセッションの中で、誰（担当本人か、どの作業者か）にいつ知らせたかを覚える。
 * 古い確認待ちが無くなったら忘れる: 次に生じたときは、間隔を待たずにもう一度知らせる。
 */
export class PeerApprovalNotices {
  readonly #lastNotifiedAt = new Map<string, number>();

  /** 知らせるなら本文を、知らせないなら `null` を返す。 */
  next(
    actor: string,
    pending: readonly PeerPendingApprovalInfo[],
    nowMs: number,
  ): { text: string; count: number } | null {
    const stale = staleApprovals(pending, nowMs);
    if (stale.length === 0) {
      this.#lastNotifiedAt.clear();
      return null;
    }
    const last = this.#lastNotifiedAt.get(actor);
    if (last !== undefined && nowMs - last < PEER_APPROVAL_NOTICE_INTERVAL_MS) return null;
    this.#lastNotifiedAt.set(actor, nowMs);
    return { text: describePeerApprovalStale(stale, nowMs), count: stale.length };
  }
}
