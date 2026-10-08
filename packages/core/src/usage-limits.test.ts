import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  classifyUsageNotice,
  describeUsageNotice,
  knownAssistantErrorRecoveryCodes,
  knownLimitRecoveryPrefixes,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  longestMatchingPrefix,
  matchedUsageLimitPrefix,
  mergeRateLimitFacts,
  STALE_TOKEN_RECOVERY_CAVEAT,
  toRateLimitFacts,
  usageLimitNoticeSchema,
  usageTransitionOf,
  withRecoveryNote,
} from './usage-limits.js';
import type { LimitRecovery } from './usage-limits.js';

describe('上限の文言を分類する', () => {
  it('実際に当たった文言を「当たった」として拾う', () => {
    const real =
      "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage";
    expect(classifyUsageNotice(real)).toEqual({ kind: 'reached', text: real });
  });

  it('文言は言い換えずにそのまま持つ（人間が claude.ai と突き合わせられる）', () => {
    const real = "You've hit your individual spend limit";
    expect(describeUsageNotice(classifyUsageNotice(real)!)).toContain(real);
  });

  it('課金枠へ移った瞬間を「遷移」として拾う（止まる一歩前）', () => {
    const notice = classifyUsageNotice("You're now using extra usage");
    expect(notice?.kind).toBe('transition');
    expect(describeUsageNotice(notice!)).toContain('まだ動く');
  });

  it('接近警告を拾う', () => {
    expect(classifyUsageNotice("You've used 90% of your weekly limit")?.kind).toBe('warning');
    expect(classifyUsageNotice("You're close to your limit")?.kind).toBe('warning');
  });

  it('組織の方針で止められているのを上限と混ぜない', () => {
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
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      expect(classifyUsageNotice(`${prefix} something`)?.kind).toBe('reached');
    }
  });

  it('文言だけの経路（classifyUsageNotice）は resetsAt を持たない（Issue #1240 続き）', () => {
    const real = "You've hit your individual spend limit";
    const notice = classifyUsageNotice(real);
    expect(notice).toBeDefined();
    expect(notice?.resetsAt).toBeUndefined();
    expect(Object.hasOwn(notice ?? {}, 'resetsAt')).toBe(false);
  });
});

describe('usageLimitNoticeSchema — resetsAt（Issue #1240 続き）', () => {
  it('resetsAt を省略しても通る（後方互換）', () => {
    const result = usageLimitNoticeSchema.safeParse({ kind: 'reached', text: 'x' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resetsAt).toBeUndefined();
  });

  it('epoch ミリ秒の正の整数なら通る', () => {
    const result = usageLimitNoticeSchema.safeParse({
      kind: 'reached',
      text: 'x',
      resetsAt: 1_785_414_600_000,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resetsAt).toBe(1_785_414_600_000);
  });

  it('0・負・非整数の resetsAt は拒む', () => {
    for (const bad of [0, -1, 1.5]) {
      const result = usageLimitNoticeSchema.safeParse({
        kind: 'reached',
        text: 'x',
        resetsAt: bad,
      });
      expect(result.success, `resetsAt=${String(bad)}`).toBe(false);
    }
  });

  it('resetsAt が在っても describeUsageNotice の出力は変わらない（既存の歯を壊さない）', () => {
    const withoutResetsAt = { kind: 'reached', text: 'x' } as const;
    const withResetsAt = { kind: 'reached', text: 'x', resetsAt: 1_785_414_600_000 } as const;
    expect(describeUsageNotice(withResetsAt)).toBe(describeUsageNotice(withoutResetsAt));
  });
});

describe('rate_limit_event の事実', () => {
  it('実測された形をそのまま読める', () => {
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
    expect(facts?.resetsAt).toBe(1785414600_000);
    expect(facts?.utilization).toBeUndefined();
  });

  it('課金枠が使えない理由を落とさない', () => {
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
    expect(usageTransitionOf(after, after)).toBeUndefined();
  });

  it('枠から追い返された瞬間だけ知らせる', () => {
    expect(usageTransitionOf({ status: 'allowed' }, { status: 'rejected' })).toBe('rejected');
    expect(usageTransitionOf({ status: 'rejected' }, { status: 'rejected' })).toBeUndefined();
  });

  it('変わっていなければ何も知らせない', () => {
    const same = { status: 'allowed' as const, utilization: 42 };
    expect(usageTransitionOf(same, same)).toBeUndefined();
  });

  it('rejected が続いていても、課金枠が使えない理由が変わった回は知らせる（#1222）', () => {
    const before = {
      kind: 'five_hour',
      status: 'rejected' as const,
      overageDisabledReason: 'member_zero_credit_limit',
    };
    const after = { ...before, overageDisabledReason: 'org_level_disabled_until' };
    expect(usageTransitionOf(before, after)).toBe('rejected');
    expect(usageTransitionOf(after, after)).toBeUndefined();
    expect(usageTransitionOf(after, { kind: 'five_hour', status: 'rejected' })).toBeUndefined();
    expect(
      usageTransitionOf(
        { status: 'allowed', overageDisabledReason: 'a' },
        { status: 'allowed', overageDisabledReason: 'b' },
      ),
    ).toBeUndefined();
  });

  it('追い返されたことを課金枠の話より優先する', () => {
    expect(usageTransitionOf(undefined, { status: 'rejected', usingOverage: true })).toBe(
      'rejected',
    );
  });
});

describe('覚えている事実に新しい観測を重ねる', () => {
  it('運ばれてこなかったフィールドで、覚えていた値を消さない', () => {
    const remembered = {
      kind: 'five_hour',
      status: 'rejected' as const,
      overageDisabledReason: 'org_level_disabled_until',
    };
    const merged = mergeRateLimitFacts(remembered, { kind: 'five_hour', resetsAt: 1_770_000_000 });
    expect(merged.status).toBe('rejected');
    expect(merged.overageDisabledReason).toBe('org_level_disabled_until');
    expect(merged.resetsAt).toBe(1_770_000_000);
    expect(usageTransitionOf(merged, remembered)).toBeUndefined();
  });

  it('運ばれてきた値は上書きする（枠が開いたことを見落とさない）', () => {
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

describe('回復の見込みを読む', () => {
  it('人間が実測した文言は「時間で戻る」側になる', () => {
    const real = "You've hit your org's monthly spend limit";
    expect(classifyUsageNotice(real)?.kind).toBe('reached');
    expect(limitRecoveryOf(real)).toBe('time');
  });

  it('individual spend limit は action（今朝の実害。人間が9時間を失った）', () => {
    const askAdmin =
      "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage";
    const forAccount = "You've hit your individual spend limit for this account.";
    expect(classifyUsageNotice(askAdmin)?.kind).toBe('reached');
    expect(limitRecoveryOf(askAdmin)).toBe('action');
    expect(limitRecoveryOf(forAccount)).toBe('action');
  });

  it('実物の逐語（今朝の実害そのもの）: individual spend limit と resets が同じ文言に同居しても action', () => {
    const real =
      "You've hit your individual spend limit · ask your admin to raise it at " +
      'claude.ai/settings/usage?from=cc_cli_limit_message · your session limit ' +
      'resets 11:40pm (Asia/Tokyo)';
    expect(real).toContain('individual spend limit');
    expect(real).toContain('resets');
    expect(classifyUsageNotice(real)?.kind).toBe('reached');
    expect(limitRecoveryOf(real)).toBe('action');
  });

  it('未知の "You\'ve hit your …" の変種は unknown へ倒す（time へ黙って落ちない）', () => {
    const unclassified = "You've hit your weekly team allowance";
    expect(limitRecoveryOf(unclassified)).toBe('unknown');
  });

  it('"You\'ve reached your …" の未分類の変種も unknown へ倒す（これは事故ではなく判断である）', () => {
    const unclassified = "You've reached your weekly team allowance";
    expect(classifyUsageNotice(unclassified)?.kind).toBe('reached');
    expect(limitRecoveryOf(unclassified)).toBe('unknown');
  });

  it('戻る時刻が本文に書いてある形（帯の有無どちらも）は time のまま', () => {
    const withZone = "You've hit your session limit · resets 3:50pm (Asia/Tokyo)";
    const withoutZone = "You've hit your usage limit · resets at 5pm";
    expect(limitRecoveryOf(withZone)).toBe('time');
    expect(limitRecoveryOf(withoutZone)).toBe('time');
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
    expect(limitRecoveryOf("You're out of usage credits")).toBe('unknown');
    expect(limitRecoveryOf('Fable 5 requires usage credits')).toBe('unknown');
  });

  it('上限ではない文言（警告・課金枠への遷移）は unknown', () => {
    expect(limitRecoveryOf("You've used 90% of your weekly limit")).toBe('unknown');
    expect(limitRecoveryOf("You're now using extra usage")).toBe('unknown');
    expect(limitRecoveryOf('まったく関係のない文字列')).toBe('unknown');
  });

  it('分類の表は SDK の USAGE_LIMIT_ERROR_PREFIXES を1つ残さず覆う（両方向）', () => {
    const known = [...knownLimitRecoveryPrefixes()].sort();
    const sdk = [...USAGE_LIMIT_ERROR_PREFIXES].sort();
    expect(known).toEqual(sdk);
  });

  it('SDK の全接頭辞が、実行時に表の鍵まで到達する', () => {
    const known = knownLimitRecoveryPrefixes();
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      const matched = matchedUsageLimitPrefix(prefix);
      expect(matched, prefix).toBeDefined();
      expect(known, prefix).toContain(matched);
    }
  });

  it('いちばん長い一致を採る。**並び順に依らない**', () => {
    expect(longestMatchingPrefix('abc def', ['abc', 'abc def'])).toBe('abc def');
    expect(longestMatchingPrefix('abc def', ['abc def', 'abc'])).toBe('abc def');
    expect(longestMatchingPrefix('zzz', ['abc', 'abc def'])).toBeUndefined();
  });

  it('短い接頭辞が長い接頭辞を食わない（SDK の実物で確かめる）', () => {
    const shorter = "Your seat type doesn't include usage";
    const longer = "Your seat type doesn't include usage credits";
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain(shorter);
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain(longer);
    expect(longer.startsWith(shorter)).toBe(true);

    expect(matchedUsageLimitPrefix(longer)).toBe(longer);
    expect(matchedUsageLimitPrefix(shorter)).toBe(shorter);
  });
});

describe('回復の見込みの表（12件を機械的に生成する歯）', () => {
  const DIRECT_VALUE_CASES: ReadonlyArray<[prefix: string, expected: LimitRecovery]> = [
    ["You're out of usage credits", 'unknown'],
    ['Your org is out of usage · add funds to continue', 'action'],
    ['Your org is out of usage · contact your admin', 'action'],
    ["Your seat type doesn't include usage credits", 'action'],
    ["Your seat type doesn't include usage", 'action'],
    ['Your usage allocation has been disabled by your admin', 'action'],
    ["Your group's usage limit is set to $0", 'action'],
    ['Fable 5 requires usage credits', 'unknown'],
    ["You're out of extra usage", 'unknown'],
    ["Your seat type doesn't include extra usage", 'action'],
  ];

  it.each(DIRECT_VALUE_CASES)('%s → %s', (prefix, expected) => {
    expect(limitRecoveryOf(prefix)).toBe(expected);
  });

  const REFINED_FAMILY_CASES: ReadonlyArray<
    [prefix: string, text: string, expected: LimitRecovery, branch: string]
  > = [
    [
      "You've hit your",
      "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage",
      'action',
      'individual spend limit',
    ],
    [
      "You've hit your",
      "You've hit your org's monthly spend limit",
      'time',
      "org's monthly spend limit",
    ],
    [
      "You've hit your",
      "You've hit your session limit · resets 3:50pm (Asia/Tokyo)",
      'time',
      'resets',
    ],
    ["You've hit your", "You've hit your weekly team allowance", 'unknown', '未分類'],
    [
      "You've reached your",
      "You've reached your individual spend limit · ask your admin to raise it at claude.ai/settings/usage",
      'action',
      'individual spend limit',
    ],
    [
      "You've reached your",
      "You've reached your org's monthly spend limit",
      'time',
      "org's monthly spend limit",
    ],
    [
      "You've reached your",
      "You've reached your session limit · resets 3:50pm (Asia/Tokyo)",
      'time',
      'resets',
    ],
    ["You've reached your", "You've reached your weekly team allowance", 'unknown', '未分類'],
  ];

  it.each(REFINED_FAMILY_CASES)('%s / text=%s → %s（branch=%s）', (_prefix, text, expected) => {
    expect(limitRecoveryOf(text)).toBe(expected);
  });

  it('この表（DIRECT_VALUE_CASES ＋ REFINED_FAMILY_CASES の接頭辞）は knownLimitRecoveryPrefixes() を1つ残さず覆う', () => {
    const coveredPrefixes = new Set<string>([
      ...DIRECT_VALUE_CASES.map(([prefix]) => prefix),
      ...REFINED_FAMILY_CASES.map(([prefix]) => prefix),
    ]);
    const known = [...knownLimitRecoveryPrefixes()].sort();
    expect([...coveredPrefixes].sort()).toEqual(known);
  });

  it('直値10件＋関数2件で SDK の全接頭辞（実測12件）を尽くす', () => {
    const distinctRefinedPrefixes = new Set(REFINED_FAMILY_CASES.map(([prefix]) => prefix));
    expect(DIRECT_VALUE_CASES.length + distinctRefinedPrefixes.size).toBe(
      USAGE_LIMIT_ERROR_PREFIXES.length,
    );
  });
});

describe('SDKAssistantMessageError の語から回復の見込みを読む（limitRecoveryOfAssistantError）', () => {
  const ASSISTANT_ERROR_CASES: ReadonlyArray<[code: string, expected: LimitRecovery]> = [
    ['authentication_failed', 'action'],
    ['oauth_org_not_allowed', 'action'],
    ['account_on_hold', 'action'],
    ['verification_required', 'action'],
    ['billing_error', 'unknown'],
    ['rate_limit', 'time'],
    ['overloaded', 'time'],
    ['invalid_request', 'unknown'],
    ['model_not_found', 'unknown'],
    ['server_error', 'time'],
    ['unknown', 'unknown'],
    ['max_output_tokens', 'unknown'],
    ['cloud_credential_error', 'unknown'],
  ];

  it.each(ASSISTANT_ERROR_CASES)('%s → %s', (code, expected) => {
    expect(limitRecoveryOfAssistantError(code)).toBe(expected);
  });

  it('この一覧（ASSISTANT_ERROR_CASES）は knownAssistantErrorRecoveryCodes() を1つ残さず覆う', () => {
    const covered = ASSISTANT_ERROR_CASES.map(([code]) => code).sort();
    const known = [...knownAssistantErrorRecoveryCodes()].sort();
    expect(covered).toEqual(known);
  });

  it('表に無い語（将来の14番目・版のずれ）では unknown を返す（実行時の倒れ先）', () => {
    expect(limitRecoveryOfAssistantError('a_future_14th_word_not_yet_classified')).toBe('unknown');
    expect(limitRecoveryOfAssistantError('')).toBe('unknown');
  });
});

describe('回復の見込みを添える（withRecoveryNote）', () => {
  it('time のときは末尾に1行足す。既存の文言は1文字も変えない', () => {
    const base = '利用上限に当たった。この文言で仕事が止まっている: SOME TEXT';
    const decorated = withRecoveryNote(base, 'time');
    expect(decorated.startsWith(base)).toBe(true);
    expect(decorated).toContain('（回復の見込み: 時間で戻る（time））');
  });

  it('action のときは末尾に1行足す。既存の文言は1文字も変えない', () => {
    const base =
      '組織の方針で止められている（利用上限ではないので、待っても増やしても直らない）: SOME TEXT';
    const decorated = withRecoveryNote(base, 'action');
    expect(decorated.startsWith(base)).toBe(true);
    expect(decorated).toContain('（回復の見込み: 人間が動かないと戻らない（action））');
  });

  it('unknown のときは1文字も足さない（ノイズを作らない）', () => {
    const base = '利用上限に近づいている: SOME TEXT';
    expect(withRecoveryNote(base, 'unknown')).toBe(base);
  });
});

describe('世代が食い違う委譲には「時間で戻る」だけを出さない（withRecoveryNote の staleToken）', () => {
  const base = '⚠ 直近のターンは報告ではなく失敗で終わっている: SOME CODE';

  it('time かつ staleToken のときだけ但し書きを足す', () => {
    const decorated = withRecoveryNote(base, 'time', { staleToken: true });
    expect(decorated.startsWith(base)).toBe(true);
    expect(decorated).toContain('（回復の見込み: 時間で戻る（time））');
    expect(decorated).toContain(STALE_TOKEN_RECOVERY_CAVEAT);
  });

  it('staleToken が偽なら、いままでと1文字も変わらない', () => {
    expect(withRecoveryNote(base, 'time', { staleToken: false })).toBe(
      withRecoveryNote(base, 'time'),
    );
    expect(withRecoveryNote(base, 'time', {})).toBe(withRecoveryNote(base, 'time'));
  });

  it('action には足さない（既に「待っても戻らない」と言っている）', () => {
    expect(withRecoveryNote(base, 'action', { staleToken: true })).toBe(
      withRecoveryNote(base, 'action'),
    );
  });

  it('unknown には足さない（1文字も増やさない側を保つ）', () => {
    expect(withRecoveryNote(base, 'unknown', { staleToken: true })).toBe(base);
  });
});
