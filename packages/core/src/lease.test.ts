import { describe, expect, it } from 'vitest';

import {
  LEASE_DRAIN_MS,
  LEASE_MARGIN_MS,
  LEASE_TTL_MS,
  describeVerdict,
  grantLease,
  judgeLease,
  mayClaim,
  touchLease,
} from './lease.js';
import { jobLeaseSchema, type JobLease } from './schema.js';

const T0 = Date.parse('2026-08-22T00:00:00.000Z');

function leaseAt(overrides: Partial<JobLease> = {}): JobLease {
  return jobLeaseSchema.parse({
    runnerId: 'runner-primary',
    instanceId: 'boot-1',
    fence: 3,
    grantedAt: new Date(T0).toISOString(),
    seenAt: new Date(T0).toISOString(),
    ttlMs: LEASE_TTL_MS,
    ...overrides,
  });
}

describe('judgeLease', () => {
  it('貸し出しの記録が無いジョブは引き取れる（この欄より前の委譲を締め出さない）', () => {
    const verdict = judgeLease({
      lease: undefined,
      now: T0,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-1' },
    });
    expect(verdict).toEqual({ kind: 'unheld' });
    expect(mayClaim(verdict)).toBe(true);
  });

  it('持ち主が返している貸し出しは、期限を待たずに引き取れる（世代は残る）', () => {
    const lease = leaseAt({ releasedAt: new Date(T0).toISOString() });
    const verdict = judgeLease({
      lease,
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-9', instanceSince: T0 + 500 },
    });
    expect(verdict).toEqual({ kind: 'released', lease });
    expect(mayClaim(verdict)).toBe(true);
    expect(grantLease({ previous: lease, runnerId: 'runner-primary', now: T0 + 2_000 }).fence).toBe(
      lease.fence + 1,
    );
  });

  it('持ち主が名乗っていなくても、貸す前から居るプロセスなら持ち主だと言える', () => {
    const lease = leaseAt({ instanceId: undefined });
    const verdict = judgeLease({
      lease,
      now: T0 + 5_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-1', instanceSince: T0 - 60_000 },
    });
    expect(verdict).toEqual({ kind: 'same-holder', lease });
  });

  it('持ち主が名乗っていなくて、貸した後に現れたプロセスなら入れ替えとして猶予を数える', () => {
    const lease = leaseAt({ instanceId: undefined });
    const appeared = T0 + 1_000;
    const verdict = judgeLease({
      lease,
      now: appeared + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: appeared },
    });
    expect(verdict.kind).toBe('held');
    if (verdict.kind === 'held') {
      expect(verdict.claimableAt).toBe(appeared + LEASE_DRAIN_MS + LEASE_MARGIN_MS);
    }
  });

  it('持ち主が名乗っておらず、いまの相手をいつから見ているかも分からなければ判定しない', () => {
    const verdict = judgeLease({
      lease: leaseAt({ instanceId: undefined }),
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2' },
    });
    expect(verdict.kind).toBe('undecidable');
    expect(mayClaim(verdict)).toBe(true);
  });

  it('いま応えているプロセスが持ち主なら「奪う話ではない」と答える（繋ぎ直し）', () => {
    const lease = leaseAt();
    const verdict = judgeLease({
      lease,
      now: T0 + 5_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-1', instanceSince: T0 - 60_000 },
    });
    expect(verdict).toEqual({ kind: 'same-holder', lease });
    expect(mayClaim(verdict)).toBe(true);
  });

  it('器が入れ替わった直後は、まだ握られていると答える（猶予の中では奪わない）', () => {
    const lease = leaseAt();
    const swapAt = T0 + 10_000;
    const verdict = judgeLease({
      lease,
      now: swapAt + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: swapAt },
    });
    expect(verdict.kind).toBe('held');
    expect(mayClaim(verdict)).toBe(false);
    if (verdict.kind === 'held') {
      expect(verdict.claimableAt).toBe(swapAt + LEASE_DRAIN_MS + LEASE_MARGIN_MS);
    }
  });

  it('畳む猶予を過ぎたら、入れ替えを根拠に引き取れる', () => {
    const lease = leaseAt();
    const swapAt = T0 + 10_000;
    const verdict = judgeLease({
      lease,
      now: swapAt + LEASE_DRAIN_MS + LEASE_MARGIN_MS,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: swapAt },
    });
    expect(verdict).toMatchObject({ kind: 'expired', because: 'drained' });
    expect(mayClaim(verdict)).toBe(true);
  });

  it('入れ替えが見えなくても、相手が自分で失効する時刻を過ぎていれば引き取れる', () => {
    const lease = leaseAt({ ttlMs: 60_000 });
    const verdict = judgeLease({
      lease,
      now: T0 + 60_000 + LEASE_MARGIN_MS,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: T0 + 55_000 },
    });
    expect(verdict).toMatchObject({ kind: 'expired', because: 'ttl' });
  });

  it('引き取れる時刻は2つの期限の早い方である（どちらか片方で「もう動いていない」と言える）', () => {
    const lease = leaseAt({ ttlMs: 5_000 });
    const swapAt = T0 + 1_000;
    const verdict = judgeLease({
      lease,
      now: T0 + 100,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: swapAt },
    });
    expect(verdict.kind).toBe('held');
    if (verdict.kind === 'held') {
      expect(verdict.claimableAt).toBe(T0 + 5_000 + LEASE_MARGIN_MS);
    }
  });

  it('入れ替えの時刻が分からないときは「いま初めて見た」として猶予を数え直す', () => {
    const lease = leaseAt();
    const now = T0 + 3_600_000;
    const verdict = judgeLease({
      lease,
      now,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2' },
    });
    expect(verdict).toMatchObject({ kind: 'expired', because: 'ttl' });

    const fresh = judgeLease({
      lease: leaseAt({ seenAt: new Date(now - 1_000).toISOString() }),
      now,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2' },
    });
    expect(fresh.kind).toBe('held');
    if (fresh.kind === 'held') {
      expect(fresh.claimableAt).toBe(now + LEASE_DRAIN_MS + LEASE_MARGIN_MS);
    }
  });

  it('どちらかが instanceId を名乗らないときは判定しない（それでも引き取りは許す）', () => {
    const answeringSilent = judgeLease({
      lease: leaseAt(),
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary' },
    });
    expect(answeringSilent.kind).toBe('undecidable');
    expect(mayClaim(answeringSilent)).toBe(true);

    const holderSilent = judgeLease({
      lease: leaseAt({ instanceId: undefined }),
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-9' },
    });
    expect(holderSilent.kind).toBe('undecidable');

    expect(describeVerdict(holderSilent)).toContain('判定できない');
  });

  it('台帳が別の宛先を指しているときは、相手の約束だけを根拠にする', () => {
    const lease = leaseAt({ runnerId: 'runner-2', ttlMs: 60_000 });
    const held = judgeLease({
      lease,
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: T0 },
    });
    expect(held.kind).toBe('held');
    if (held.kind === 'held') expect(held.claimableAt).toBe(T0 + 60_000 + LEASE_MARGIN_MS);

    const expired = judgeLease({
      lease,
      now: T0 + 60_000 + LEASE_MARGIN_MS,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: T0 },
    });
    expect(expired).toMatchObject({ kind: 'expired', because: 'ttl' });
  });

  it('seenAt が読めない値なら、引き取りは許すが「失効した」とは言わない', () => {
    const verdict = judgeLease({
      lease: { ...leaseAt(), seenAt: 'いつか' } as JobLease,
      now: T0,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: T0 },
    });
    expect(verdict.kind).toBe('undecidable');
    expect(mayClaim(verdict)).toBe(true);
    expect(describeVerdict(verdict)).toContain('判定できない');
    expect(describeVerdict(verdict)).not.toContain('失効した');
  });
});

describe('judgeLease > 持ち主の名乗りを最後に聞けた時刻（holderSeenAt。#4454）', () => {
  const expiredAt = T0 + LEASE_TTL_MS + LEASE_MARGIN_MS;

  it('台帳の seenAt の期限を過ぎていても、持ち主の名乗りを後で聞けていれば、そこから数え直すまで別の器は引き取れない', () => {
    const lease = leaseAt();
    const heard = T0 + 9 * 60_000;
    const verdict = judgeLease({
      lease,
      now: expiredAt + 1_000,
      answering: { runnerId: 'runner-other', instanceId: 'boot-x' },
      holderSeenAt: heard,
    });
    expect(verdict).toEqual({
      kind: 'held',
      claimableAt: heard + LEASE_TTL_MS + LEASE_MARGIN_MS,
      lease,
    });
    expect(mayClaim(verdict)).toBe(false);
  });

  it('持ち主の名乗りも期限より前で止まっていれば、これまでどおり引き取れる', () => {
    const lease = leaseAt();
    const verdict = judgeLease({
      lease,
      now: expiredAt,
      answering: { runnerId: 'runner-other', instanceId: 'boot-x' },
      holderSeenAt: T0 - 60_000,
    });
    expect(verdict).toEqual({ kind: 'expired', because: 'ttl', lease });
  });

  it('同じ器への引き取り（持ち主自身の入れ替え）には効かせない', () => {
    const lease = leaseAt();
    const appeared = T0 + 1_000;
    const now = appeared + LEASE_DRAIN_MS + LEASE_MARGIN_MS;
    const verdict = judgeLease({
      lease,
      now,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: appeared },
      holderSeenAt: now,
    });
    expect(verdict).toEqual({ kind: 'expired', because: 'drained', lease });
  });
});

describe('judgeLease > 併存（同じ runnerId を名乗る器が2台以上）', () => {
  it('併存では ambiguous を返し、mayClaim は false', () => {
    const lease = leaseAt();
    const verdict = judgeLease({
      lease,
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', duplicates: 2 },
    });
    expect(verdict).toEqual({
      kind: 'ambiguous',
      lease,
      runnerId: 'runner-primary',
      duplicates: 2,
    });
    expect(mayClaim(verdict)).toBe(false);
    expect(verdict).not.toHaveProperty('claimableAt');
    expect(describeVerdict(verdict)).toContain('引き取らない');
    expect(describeVerdict(verdict)).toContain('ALTEROID_RUNNER_ID');
  });

  // 併存を `decideAfterSwap` へ流す形へ「素朴に」戻されないための固定: 併存は入れ替えではなく、`drained` の前提（器が古いプロセスを畳む）が成り立たない。
  it('併存で、入れ替えなら drained が出る時刻条件を作っても、drained にならず ambiguous のままである', () => {
    const lease = leaseAt();
    const swapAt = T0 + 10_000;
    const now = swapAt + LEASE_DRAIN_MS + LEASE_MARGIN_MS;
    const verdict = judgeLease({
      lease,
      now,
      answering: {
        runnerId: 'runner-primary',
        instanceId: 'boot-2',
        instanceSince: swapAt,
        duplicates: 2,
      },
    });
    expect(verdict.kind).toBe('ambiguous');
    expect(verdict.kind).not.toBe('expired');
    expect(mayClaim(verdict)).toBe(false);
  });

  it('台帳と応答の宛先が食い違っていても、報告するのは実際に併存している側の名前である', () => {
    const lease = leaseAt({ runnerId: 'runner-2' });
    const verdict = judgeLease({
      lease,
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', duplicates: 2 },
    });
    expect(verdict).toEqual({
      kind: 'ambiguous',
      lease,
      runnerId: 'runner-primary',
      duplicates: 2,
    });
    const description = describeVerdict(verdict);
    expect(description).toContain('runner-primary');
    expect(description).not.toContain('runner-2');
  });

  it('unheld は併存でも従来どおり通る（残る穴。#200「6. 塞げない部分」）', () => {
    const verdict = judgeLease({
      lease: undefined,
      now: T0,
      answering: { runnerId: 'runner-primary', duplicates: 2 },
    });
    expect(verdict).toEqual({ kind: 'unheld' });
    expect(mayClaim(verdict)).toBe(true);
  });

  it('released は併存でも従来どおり通る（持ち主が自分で返したことは併存と無関係）', () => {
    const lease = leaseAt({ releasedAt: new Date(T0).toISOString() });
    const verdict = judgeLease({
      lease,
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary', duplicates: 2 },
    });
    expect(verdict).toEqual({ kind: 'released', lease });
    expect(mayClaim(verdict)).toBe(true);
  });

  it('名乗らない runner（duplicates 無し）は従来どおり undecidable のままで、引き取れる', () => {
    const verdict = judgeLease({
      lease: leaseAt(),
      now: T0 + 1_000,
      answering: { runnerId: 'runner-primary' },
    });
    expect(verdict.kind).toBe('undecidable');
    expect(mayClaim(verdict)).toBe(true);
  });
});

describe('grantLease / touchLease', () => {
  it('貸し直すたびに世代が1つ進む（古い命令を runner が見分けられる）', () => {
    const first = grantLease({ previous: undefined, runnerId: 'runner-primary', now: T0 });
    expect(first.fence).toBe(1);
    expect(first.ttlMs).toBe(LEASE_TTL_MS);

    const second = grantLease({
      previous: first,
      runnerId: 'runner-primary',
      instanceId: 'boot-2',
      now: T0 + 1_000,
    });
    expect(second.fence).toBe(2);
    expect(second.instanceId).toBe('boot-2');
    expect(jobLeaseSchema.parse(second)).toEqual(second);
  });

  it('生存を確かめただけのときは世代を進めない', () => {
    const lease = leaseAt();
    const touched = touchLease(lease, T0 + 30_000);
    expect(touched.fence).toBe(lease.fence);
    expect(touched.seenAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(touched.grantedAt).toBe(lease.grantedAt);
  });
});
