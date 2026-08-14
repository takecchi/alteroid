import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  classifyUsageNotice,
  describeUsageNotice,
  toRateLimitFacts,
  usageTransitionOf,
} from './usage-limits.js';

describe('上限の文言を分類する', () => {
  it('実際に当たった文言を「当たった」として拾う', () => {
    // 走行中のマネージャー2本が同時にこれを返して終わった。文言の先頭は
    // SDK の USAGE_LIMIT_ERROR_PREFIXES の1つめ（"You've hit your"）。
    const real =
      "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage";
    expect(classifyUsageNotice(real)).toEqual({ kind: 'reached', text: real });
  });

  it('文言は言い換えずにそのまま持つ（人間が claude.ai と突き合わせられる）', () => {
    const real = "You've hit your individual spend limit";
    expect(describeUsageNotice(classifyUsageNotice(real)!)).toContain(real);
  });

  it('課金枠へ移った瞬間を「遷移」として拾う（止まる一歩前）', () => {
    // ここがこの機能の核心。支出上限の残額が取れなくても、この遷移を捉えられれば
    // 「そろそろ止まる」と判断できる。
    const notice = classifyUsageNotice("You're now using extra usage");
    expect(notice?.kind).toBe('transition');
    expect(describeUsageNotice(notice!)).toContain('まだ動く');
  });

  it('接近警告を拾う', () => {
    expect(classifyUsageNotice("You've used 90% of your weekly limit")?.kind).toBe('warning');
    expect(classifyUsageNotice("You're close to your limit")?.kind).toBe('warning');
  });

  it('組織の方針で止められているのを上限と混ぜない', () => {
    // 待っても直らないし、増やす先も違う。SDK 自身が「上限のカードへ回すな」と
    // 言っている。
    const notice = classifyUsageNotice('This service is disabled for your org');
    expect(notice?.kind).toBe('org_policy');
    expect(describeUsageNotice(notice!)).toContain('待っても増やしても直らない');
  });

  it('関係ない文言は拾わない', () => {
    expect(classifyUsageNotice('Compacting conversation…')).toBeUndefined();
    expect(classifyUsageNotice('')).toBeUndefined();
    expect(classifyUsageNotice('   ')).toBeUndefined();
  });

  it('SDK の定数を使っている（自前のパターンを持たない）', () => {
    // 文言は将来変わる。手で書いた正規表現は必ず腐り、しかも腐り方が
    // 「検知しなくなる」なので静かに効かなくなる。SDK が持っている全部を拾えること。
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      expect(classifyUsageNotice(`${prefix} something`)?.kind).toBe('reached');
    }
  });
});

describe('rate_limit_event の事実', () => {
  it('実測された形をそのまま読める', () => {
    // 実測（SDK v0.3.214）: five_hour には utilization が付かず、overage には付いた。
    const facts = toRateLimitFacts({
      status: 'allowed',
      resetsAt: 1785414600,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      overageResetsAt: 1785542400,
      isUsingOverage: false,
    });
    expect(facts).toMatchObject({
      kind: 'five_hour',
      status: 'allowed',
      usingOverage: false,
    });
    // Unix 秒 → epoch ミリ秒（`/usage` 側は ISO 文字列で単位が違う）。
    expect(facts?.resetsAt).toBe(1785414600_000);
    // **付かなかった utilization を 0 にしない。**
    expect(facts?.utilization).toBeUndefined();
  });

  it('課金枠が使えない理由を落とさない', () => {
    // 「当たった」しか分からないと、次に当たったときも同じところで推測することになる。
    const facts = toRateLimitFacts({
      status: 'rejected',
      rateLimitType: 'overage',
      overageDisabledReason: 'member_zero_credit_limit',
      errorCode: 'credits_required',
    });
    expect(facts?.overageDisabledReason).toBe('member_zero_credit_limit');
    expect(facts?.errorCode).toBe('credits_required');
  });

  it('既にミリ秒の桁ならそのまま通す（将来 SDK が単位を変えても壊れない）', () => {
    expect(toRateLimitFacts({ resetsAt: 1785414600_000 })?.resetsAt).toBe(1785414600_000);
  });

  it('読めない形は無いものとして扱う（空の行を作らない）', () => {
    expect(toRateLimitFacts(null)).toBeUndefined();
    expect(toRateLimitFacts({})).toBeUndefined();
    expect(toRateLimitFacts({ status: 'nonsense', utilization: -1 })).toBeUndefined();
  });
});

describe('知らせるべき変化', () => {
  it('課金枠へ入った瞬間だけ知らせる', () => {
    const before = { usingOverage: false };
    const after = { usingOverage: true };
    expect(usageTransitionOf(before, after)).toBe('entered_overage');
    // 2回目は知らせない（同じ事実で受信箱を埋めない）。
    expect(usageTransitionOf(after, after)).toBeUndefined();
  });

  it('枠から追い返された瞬間だけ知らせる', () => {
    expect(usageTransitionOf({ status: 'allowed' }, { status: 'rejected' })).toBe('rejected');
    expect(usageTransitionOf({ status: 'rejected' }, { status: 'rejected' })).toBeUndefined();
  });

  it('変わっていなければ何も知らせない', () => {
    // rate_limit_event はターンの頭ごとに来る。状態をそのまま流すと、クローンは
    // 同じ通知を何十回も読むことになり、本当に変わった1回が埋もれる。
    const same = { status: 'allowed' as const, utilization: 42 };
    expect(usageTransitionOf(same, same)).toBeUndefined();
  });

  it('追い返されたことを課金枠の話より優先する', () => {
    expect(usageTransitionOf(undefined, { status: 'rejected', usingOverage: true })).toBe(
      'rejected',
    );
  });
});
