import { describe, expect, it } from 'vitest';

import { PEER_APPROVAL_STALE_AFTER_MS } from './peer-broker.js';
import {
  PEER_APPROVAL_NOTICE_INTERVAL_MS,
  PeerApprovalNotices,
} from './runner-peer-approval-notice.js';

const entry = (n: number, since: number) => ({
  sessionId: `peer-${String(n)}`,
  approvalId: `appr-${String(n)}`,
  since,
});

describe('PeerApprovalNotices', () => {
  it('10 分未満は添えない。10 分以上で session・approval_id・待ち分数と「止める指示ではない」を添える', () => {
    const notices = new PeerApprovalNotices();
    expect(notices.next('manager', [entry(1, 0)], PEER_APPROVAL_STALE_AFTER_MS - 1)).toBeNull();
    const notice = notices.next('manager', [entry(1, 0)], PEER_APPROVAL_STALE_AFTER_MS);
    expect(notice?.count).toBe(1);
    expect(notice?.text).toContain('peer peer-1 の確認（approval_id appr-1）が 10 分待っている');
    expect(notice?.text).toContain('確認の期限は無い');
    expect(notice?.text).toContain('止める指示ではない');
  });

  it('3 本まで列挙し、残りは「ほか N 本」。待ちの短いものは数えない', () => {
    const notices = new PeerApprovalNotices();
    const pending = [1, 2, 3, 4, 5].map((n) => entry(n, 0));
    const now = PEER_APPROVAL_STALE_AFTER_MS;
    const notice = notices.next('manager', [...pending, entry(6, now - 1)], now);
    expect(notice?.count).toBe(5);
    expect(notice?.text).toContain('appr-3');
    expect(notice?.text).not.toContain('appr-4');
    expect(notice?.text).toContain('ほか 2 本');
  });

  it('同じ相手へは 10 分に 1 回まで。相手ごとに数え、確認待ちが無くなったら覚えを消す', () => {
    const notices = new PeerApprovalNotices();
    const pending = [entry(1, 0)];
    const t0 = PEER_APPROVAL_STALE_AFTER_MS;
    expect(notices.next('manager', pending, t0)).not.toBeNull();
    expect(notices.next('manager', pending, t0 + PEER_APPROVAL_NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(notices.next('agent-1', pending, t0 + 1)).not.toBeNull();
    expect(notices.next('manager', pending, t0 + PEER_APPROVAL_NOTICE_INTERVAL_MS)).not.toBeNull();
    expect(notices.next('manager', [], t0 + 1)).toBeNull();
    expect(notices.next('manager', pending, t0 + 2)).not.toBeNull();
  });
});
