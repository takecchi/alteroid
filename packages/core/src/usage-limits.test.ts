import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  classifyUsageNotice,
  describeUsageNotice,
  knownLimitRecoveryPrefixes,
  limitRecoveryOf,
  longestMatchingPrefix,
  matchedUsageLimitPrefix,
  mergeRateLimitFacts,
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

describe('覚えている事実に新しい観測を重ねる', () => {
  it('運ばれてこなかったフィールドで、覚えていた値を消さない', () => {
    // **これが「同じ知らせが二度配られる」の根である。** `status` を運ばない観測
    // （全フィールドが省略可なので正常な入力である）で丸ごと置き換えると、
    // 「もう rejected を知らせた」という記憶が消え、次の rejected が新しい遷移に
    // 見える。重ねる形なら、覚えていた `status` はそのまま残る。
    const remembered = {
      kind: 'five_hour',
      status: 'rejected' as const,
      overageDisabledReason: 'org_level_disabled_until',
    };
    const merged = mergeRateLimitFacts(remembered, { kind: 'five_hour', resetsAt: 1_770_000_000 });
    expect(merged.status).toBe('rejected');
    expect(merged.overageDisabledReason).toBe('org_level_disabled_until');
    expect(merged.resetsAt).toBe(1_770_000_000);
    // 重ねた結果で判定すると、同じ rejected はもう遷移ではない。
    expect(usageTransitionOf(merged, remembered)).toBeUndefined();
  });

  it('運ばれてきた値は上書きする（枠が開いたことを見落とさない）', () => {
    // **消える道を塞がない。** ここまで残す形にすると、本物の再発が黙って消える。
    const merged = mergeRateLimitFacts(
      { kind: 'five_hour', status: 'rejected' },
      { kind: 'five_hour', status: 'allowed' },
    );
    expect(merged.status).toBe('allowed');
    expect(usageTransitionOf(merged, { kind: 'five_hour', status: 'rejected' })).toBe('rejected');
  });

  it('覚えている事実が無ければ、届いた観測がそのまま記憶になる', () => {
    const next = { kind: 'five_hour', status: 'rejected' as const };
    expect(mergeRateLimitFacts(undefined, next)).toEqual(next);
  });
});

/**
 * 回復の見込み（Issue #393）。**`kind` とは別の軸である**——`reached` の中に、
 * 待てば戻るものと人間が動かないと戻らないものが混ざっている。
 */
describe('回復の見込みを読む', () => {
  it('人間が実測した文言は「時間で戻る」側になる', () => {
    // **実測（2026-08-25 JST 報告）**: 無料枠を使い切って従量課金へ切り替わった
    // ときに組織の課金上限へ達すると出る。請求期間が変われば戻る。
    const real = "You've hit your org's monthly spend limit";
    // まず `reached` として拾えていること（回す契機そのもの）。
    expect(classifyUsageNotice(real)?.kind).toBe('reached');
    // そのうえで「待てば戻る」側であること。
    expect(limitRecoveryOf(real)).toBe('time');
  });

  it('組織の方針は「人間が動かないと戻らない」側（待っても直らない）', () => {
    expect(limitRecoveryOf('This service is disabled for your org')).toBe('action');
  });

  it('入金・管理者・座席種別を求める文言は action', () => {
    expect(limitRecoveryOf('Your org is out of usage · add funds to continue')).toBe('action');
    expect(limitRecoveryOf('Your usage allocation has been disabled by your admin')).toBe('action');
    expect(limitRecoveryOf("Your seat type doesn't include extra usage")).toBe('action');
  });

  it('クレジットが買うものか配られるものか分からないものは unknown（action へ倒さない）', () => {
    // **`unknown` を `action` の同義語にしない。** `action` と読むことは候補を
    // 1本永久に降ろす判断になりうる（`limitRecoverySchema` の doc）。
    expect(limitRecoveryOf("You're out of usage credits")).toBe('unknown');
    expect(limitRecoveryOf('Fable 5 requires usage credits')).toBe('unknown');
  });

  it('上限ではない文言（警告・課金枠への遷移）は unknown', () => {
    // どちらも「まだ動いている」状態。`time` と答えると「止まっていて、待てば
    // 戻る」と読める。
    expect(limitRecoveryOf("You've used 90% of your weekly limit")).toBe('unknown');
    expect(limitRecoveryOf("You're now using extra usage")).toBe('unknown');
    expect(limitRecoveryOf('まったく関係のない文字列')).toBe('unknown');
  });

  /**
   * **この歯が、書き写しを腐らせない唯一の仕組みである。**
   *
   * `LIMIT_RECOVERY_BY_PREFIX` は SDK の文字列を鍵として書き写している（接頭辞
   * ごとに違う注記を付けるには他に方法が無い）。SDK が1つ足しても1つ改名しても、
   * ここが両方向で落ちる。
   */
  it('分類の表は SDK の USAGE_LIMIT_ERROR_PREFIXES を1つ残さず覆う（両方向）', () => {
    const known = [...knownLimitRecoveryPrefixes()].sort();
    const sdk = [...USAGE_LIMIT_ERROR_PREFIXES].sort();
    // 生の集合を突き合わせる。片方向（覆っているか）だけだと、SDK が消した
    // 文言がこちらに残り続けても気づけない。
    expect(known).toEqual(sdk);
  });

  it('SDK の全接頭辞が、実行時に表の鍵まで到達する', () => {
    // 上のテストは集合の一致を見るが、**一致していても届かないことがある**
    // ——`longestMatchingPrefix` の取り違えで別の鍵へ当たれば、表に在る注記が
    // 使われない。⟹ 見るのは「当たった鍵が表に在ること」で、**注記の値では
    // ない**（3本は意図して `unknown` なので、値で測るとその3本が赤くなる）。
    const known = knownLimitRecoveryPrefixes();
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      const matched = matchedUsageLimitPrefix(prefix);
      expect(matched, prefix).toBeDefined();
      expect(known, prefix).toContain(matched);
    }
  });

  it('いちばん長い一致を採る。**並び順に依らない**', () => {
    // **SDK の配列の並び順では測れない。** 長いほうが先に在るので、「最初に
    // 当たったものを採る」に取り違えても同じ値が返る（変異試験で実測。その変異は
    // 生き残った）。⟹ 並び順を自分で決めて両方向から測る。
    expect(longestMatchingPrefix('abc def', ['abc', 'abc def'])).toBe('abc def');
    expect(longestMatchingPrefix('abc def', ['abc def', 'abc'])).toBe('abc def');
    // 当たらなければ undefined（「短いほうが当たった」と混ざらない）。
    expect(longestMatchingPrefix('zzz', ['abc', 'abc def'])).toBeUndefined();
  });

  it('短い接頭辞が長い接頭辞を食わない（SDK の実物で確かめる）', () => {
    // SDK には "Your seat type doesn't include usage" と "…usage credits" の
    // 両方が在り、前者は後者の接頭辞である。配列順で最初に当たったものを採ると、
    // 長いほうの文言でも短い側の鍵が選ばれる。
    const shorter = "Your seat type doesn't include usage";
    const longer = "Your seat type doesn't include usage credits";
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain(shorter);
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain(longer);
    expect(longer.startsWith(shorter)).toBe(true);

    // **返り値（`limitRecoveryOf`）では測れない**——いま両方 `action` なので、
    // 短い側を採っても同じ値が返る。⟹ どの鍵に当たったかを直接見る。
    expect(matchedUsageLimitPrefix(longer)).toBe(longer);
    expect(matchedUsageLimitPrefix(shorter)).toBe(shorter);
  });
});
