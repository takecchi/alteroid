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

/**
 * 貸し出し期限の判定（roadmap M5 PR4）。
 *
 * **ここで守っているのは「生きている器の仕事を奪わない」ことと、「奪っていないと
 * 言えないときはそう言う」ことの2つである。** 前者だけを守ると、名乗らない runner の
 * ジョブが永久に引き取れなくなる（能力の削除）。後者だけを守ると、二重実行が
 * 「判定できませんでした」という報告つきで起きる。
 *
 * 時刻は全部この試験が持つ（`judgeLease` は `now` を受け取る）。器の時計に依存した
 * 判定を書かないための形でもある。
 */
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

  /**
   * **入れ替えを観測しても、その瞬間には引き取らない。** 器は古い器へ畳む猶予を
   * 与えてから殺すので、猶予の中では古いプロセスがまだ手を動かしている。
   */
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
    // 引き取れるのは「畳む猶予 + 余裕」を過ぎてから。
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

  /**
   * **入れ替えを観測できない構成のための材料。** 器が古い器を殺さない（経路だけが
   * 付け替わった等）場合、根拠になるのは runner 自身の約束（自己失効）だけである。
   */
  it('入れ替えが見えなくても、相手が自分で失効する時刻を過ぎていれば引き取れる', () => {
    const lease = leaseAt({ ttlMs: 60_000 });
    const verdict = judgeLease({
      lease,
      now: T0 + 60_000 + LEASE_MARGIN_MS,
      // 入れ替えは「たまたま今見た」形にする（drain 側の期限はまだ来ていない）
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
      // ttl 側（T0 + 5,000 + 余裕）が drain 側（swap + 60,000 + 余裕）より早い
      expect(verdict.claimableAt).toBe(T0 + 5_000 + LEASE_MARGIN_MS);
    }
  });

  /**
   * デーモンが再起動した直後は、入れ替えがいつ起きたかを知らない。**知らない時刻を
   * 過去に見積もらない** — 見積もると、まだ畳まれていない器の仕事を奪いに行く。
   */
  it('入れ替えの時刻が分からないときは「いま初めて見た」として猶予を数え直す', () => {
    const lease = leaseAt();
    const now = T0 + 3_600_000;
    const verdict = judgeLease({
      lease,
      now,
      // instanceSince が無い（＝この観測が初回で、いつ入れ替わったかを持っていない）
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2' },
    });
    // ttl（10分）はもう過ぎているので、そちらを根拠に引き取れる
    expect(verdict).toMatchObject({ kind: 'expired', because: 'ttl' });

    // ttl がまだ来ていない場合は、いまから猶予を数える（奪わない）
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

  /**
   * `identity()` を持たない runner（同一プロセスの `runner-local` や古い器）。
   * **「入れ替わっていない」とも「入れ替わった」とも読まない。**
   */
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

    // **判定できないことが報告から消えない。**
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

  /**
   * **壊れた時刻で「まだ握られている」と言わない。** 言うと、直せる者が居ないまま
   * その委譲が永久に引き取れなくなる（時刻を直せるのは書いた側だけである）。
   */
  it('seenAt が読めない値なら、期限が過ぎたものとして扱う', () => {
    const verdict = judgeLease({
      lease: { ...leaseAt(), seenAt: 'いつか' } as JobLease,
      now: T0,
      answering: { runnerId: 'runner-primary', instanceId: 'boot-2', instanceSince: T0 },
    });
    expect(verdict).toMatchObject({ kind: 'expired', because: 'ttl' });
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

  /**
   * **生存の確認で世代を進めてはいけない。** 進めると、台帳の世代が runner の持って
   * いる世代より新しくなり、次に出す命令が自分の runner から拒まれる。
   */
  it('生存を確かめただけのときは世代を進めない', () => {
    const lease = leaseAt();
    const touched = touchLease(lease, T0 + 30_000);
    expect(touched.fence).toBe(lease.fence);
    expect(touched.seenAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(touched.grantedAt).toBe(lease.grantedAt);
  });
});
