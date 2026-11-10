import { describe, expect, it } from 'vitest';

import { fingerprintOf } from './credentials.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import {
  emptyPoolOutcome,
  probeUnusableUnrecordedOutcome,
  readyNoTriggerOutcome,
  recoveredOutcome,
  reopenedOutcome,
  respreadOutcome,
  respreadTargetOf,
  staleObservationOutcome,
  strandedDecisionOf,
  strandedWhyOf,
  successNotReflectedOutcome,
  unnominatedDecision,
  usableNoTriggerOutcome,
} from './token-rotator-reconsider-precheck.js';
import type { TokenSpreadResult, TokenVerdictOrigin } from './token-rotator.js';

// `token-rotator-reconsider-precheck.ts`（`reconsiderLocked` が回す前に返す結果と、撒き直しの条件式の前半だけを切り出した同期の純関数）を、入力 → 出力で縛る。
// 呼び元（`reconsiderLocked`）を通した縛りは `token-rotator-reconsider-precheck-pin.test.ts`。ここは関数を直に呼び、
// 全欄・`why` の全文・欄が `undefined` のとき欄ごと無いこと・引数をそのまま通す参照・各枝・条件式の各項を1つずつ外した回を見る。
// 期待の文字列・欄は、切り出した関数の出力を目で読んで確かめたもの（仕様を先に書いたものではない）。
// 時計は読まない（日時は引数の `cooldownUntil` から作る）。

function row(id: string, label: string, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label, order: 0, ...extra };
}

const active: ActiveAgentToken = { tokenId: 'a', generation: 3 } as ActiveAgentToken;
const usable: TokenCandidateVerdict = { verdict: 'usable' };
const UNTIL = Date.parse('2026-08-25T04:00:00.000Z');
const UNTIL_ISO = '2026-08-25T04:00:00.000Z';

describe('emptyPoolOutcome', () => {
  it('欄は kind・signal・reason・why の4つだけ', () => {
    const outcome = emptyPoolOutcome('tick');
    expect(outcome).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'tick',
      why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
    });
    expect(Object.keys(outcome)).toStrictEqual(['kind', 'signal', 'reason', 'why']);
  });
});

describe('unnominatedDecision', () => {
  const settings = { rotateOn: 'on', cooldownMs: 1 };

  it('turn_succeeded は設定より先に返す（設定が読めなくても成功の文面）', () => {
    for (const settingsRead of [
      { readable: false as const, reason: '壊れていた' },
      { readable: true as const, settings },
    ]) {
      expect(unnominatedDecision({ reason: 'turn_succeeded', settingsRead })).toStrictEqual({
        kind: 'ignored',
        outcome: {
          kind: 'ignored',
          signal: 'none',
          reason: 'turn_succeeded',
          why: 'ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）',
        },
      });
    }
  });

  it('設定が読めない: settings_unreadable と理由入りの文面', () => {
    expect(
      unnominatedDecision({
        reason: 'startup',
        settingsRead: { readable: false, reason: '壊れていた' },
      }),
    ).toStrictEqual({
      kind: 'ignored',
      outcome: {
        kind: 'ignored',
        signal: 'settings_unreadable',
        reason: 'startup',
        why: 'まだ一度も指名していない。回転の設定が読めなかった（壊れていた）ので、この回は回さない',
      },
    });
  });

  it('rotateOn が off: stranded の印', () => {
    expect(
      unnominatedDecision({
        reason: 'pool_changed',
        settingsRead: { readable: true, settings: { rotateOn: 'off' } },
      }),
    ).toStrictEqual({
      kind: 'ignored',
      outcome: {
        kind: 'ignored',
        signal: 'stranded',
        reason: 'pool_changed',
        why: 'まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）',
      },
    });
  });

  it('どれにも当たらなければ continue で、読めた設定を同じ参照で運ぶ', () => {
    const decision = unnominatedDecision({
      reason: 'tick',
      settingsRead: { readable: true, settings },
    });
    expect(decision).toStrictEqual({ kind: 'continue', settings });
    expect((decision as { settings: unknown }).settings).toBe(settings);
  });
});

describe('respreadTargetOf', () => {
  const currentRow = row('a', 'A', { value: 'sk-new' });
  const spreadMark = { tokenId: 'a', generation: 3, fingerprint: fingerprintOf('sk-old') };
  const base = { reason: 'pool_changed' as const, currentRow, spreadMark, active };

  it('全項が真: 行と現役を同じ参照で返す', () => {
    const target = respreadTargetOf(base);
    expect(target?.currentRow).toBe(currentRow);
    expect(target?.active).toBe(active);
    expect(Object.keys(target ?? {})).toStrictEqual(['currentRow', 'active']);
  });

  it.each([
    ['reason が pool_changed でない', { ...base, reason: 'tick' as const }],
    ['現役の行が無い', { ...base, currentRow: undefined }],
    ['値が無い', { ...base, currentRow: row('a', 'A') }],
    ['値が空', { ...base, currentRow: row('a', 'A', { value: '' }) }],
    ['spreadMark が無い', { ...base, spreadMark: null }],
    ['現役の記録が無い', { ...base, active: null }],
    ['spreadMark の tokenId が違う', { ...base, spreadMark: { ...spreadMark, tokenId: 'b' } }],
    ['spreadMark の世代が違う', { ...base, spreadMark: { ...spreadMark, generation: 2 } }],
    [
      '指紋が同じ（差し替わっていない）',
      { ...base, spreadMark: { ...spreadMark, fingerprint: fingerprintOf('sk-new') } },
    ],
  ])('項を1つ外す: %s なら撒き直さない', (_name, input) => {
    expect(respreadTargetOf(input)).toBeUndefined();
  });
});

describe('respreadOutcome', () => {
  it('全欄・欄の順・spread は同じ参照', () => {
    const spread: TokenSpreadResult[] = [];
    const outcome = respreadOutcome({
      reason: 'pool_changed',
      currentRow: row('a', 'A'),
      generation: 4,
      spread,
    });
    expect(outcome).toStrictEqual({
      kind: 'rotated',
      fromTokenId: 'a',
      toTokenId: 'a',
      toLabel: 'A',
      generation: 4,
      signal: 'none',
      reason: 'pool_changed',
      spread,
      why: '現役「A」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した',
    });
    expect(outcome.spread).toBe(spread);
    expect(Object.keys(outcome)).toStrictEqual([
      'kind',
      'fromTokenId',
      'toTokenId',
      'toLabel',
      'generation',
      'signal',
      'reason',
      'spread',
      'why',
    ]);
  });
});

describe('staleObservationOutcome', () => {
  const turnSuccess = (observedBy: { tokenId: string; generation: number }) => ({
    verdict: usable,
    origin: { source: 'turn_success', observedBy } as TokenVerdictOrigin,
  });
  const trial = (observedBy: { tokenId: string; generation: number }) => ({
    verdict: usable,
    origin: { source: 'trial', observedBy } as TokenVerdictOrigin,
  });
  const probe = (observedBy?: { tokenId: string; generation: number }) => ({
    verdict: usable,
    origin: {
      source: 'account_probe',
      ...(observedBy === undefined ? {} : { observedBy }),
    } as TokenVerdictOrigin,
  });
  const fresh = { tokenId: 'a', generation: 3 };
  const old = { tokenId: 'a', generation: 2 };

  it('current が無ければ何も言わない', () => {
    expect(staleObservationOutcome({ reason: 'tick', current: undefined, active })).toBeUndefined();
  });

  it('turn_success: 世代が合わなければ「ターンの成功」の文面で捨てる（全欄・全文）', () => {
    const outcome = staleObservationOutcome({
      reason: 'turn_succeeded',
      current: turnSuccess(old),
      active,
    });
    expect(outcome).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'turn_succeeded',
      why: 'ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）',
    });
  });

  it('trial: 世代が合わなければ「試しの成功」の文面で捨てる', () => {
    expect(
      staleObservationOutcome({ reason: 'trial_succeeded', current: trial(old), active })?.why,
    ).toBe(
      '試しの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）',
    );
  });

  it('turn_success / trial: 現役が null（unknown）でも捨てる。current のときだけ通す', () => {
    expect(
      staleObservationOutcome({ reason: 'tick', current: turnSuccess(fresh), active: null }),
    ).toBeDefined();
    expect(
      staleObservationOutcome({ reason: 'tick', current: turnSuccess(fresh), active }),
    ).toBeUndefined();
    expect(
      staleObservationOutcome({ reason: 'tick', current: trial(fresh), active }),
    ).toBeUndefined();
  });

  it('account_probe: 身元が在って stale なら捨てる（全欄・全文）', () => {
    expect(
      staleObservationOutcome({ reason: 'account_probe', current: probe(old), active }),
    ).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'account_probe',
      why: '枠の probe を観測したが、測った鍵がもう現役ではない（測っている間に回った）ので、その判定は現役へ当てずに捨てる',
    });
  });

  it('account_probe: 項を1つ外す（身元が無い・current・unknown は捨てない）', () => {
    expect(
      staleObservationOutcome({ reason: 'account_probe', current: probe(), active }),
    ).toBeUndefined();
    expect(
      staleObservationOutcome({ reason: 'account_probe', current: probe(fresh), active }),
    ).toBeUndefined();
    expect(
      staleObservationOutcome({ reason: 'account_probe', current: probe(old), active: null }),
    ).toBeUndefined();
  });
});

describe('usable で回す契機が無い枝の3出所', () => {
  const currentRow = row('a', 'A');
  const cases = [
    ['turn_success', 'ターンが実際に成功した'],
    ['trial', '試しで通ることを観測した'],
    ['account_probe', 'probe で通ることを観測した'],
  ] as const;

  it.each(cases)('recoveredOutcome: %s（全欄・全文・欄の順）', (source, how) => {
    const outcome = recoveredOutcome({ reason: 'tick', currentRow, source });
    expect(outcome).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'tick',
      recovered: { tokenId: 'a', label: 'A', source },
      why: `現役「A」は${how}（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）`,
    });
    expect(Object.keys(outcome)).toStrictEqual(['kind', 'signal', 'reason', 'recovered', 'why']);
  });

  it.each(cases)('usableNoTriggerOutcome: %s（全欄・全文）', (source, how) => {
    const outcome = usableNoTriggerOutcome({ reason: 'tick', currentRow, source });
    expect(outcome).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'tick',
      why: `現役「A」は${how}（回す契機が無い）`,
    });
    expect(Object.keys(outcome)).toStrictEqual(['kind', 'signal', 'reason', 'why']);
  });
});

describe('successNotReflectedOutcome', () => {
  const failed: TokenCandidateVerdict = { verdict: 'undecidable', reason: 'x' };

  it('origin が trial: 試しの成功の文面', () => {
    expect(
      successNotReflectedOutcome({
        reason: 'trial_succeeded',
        current: {
          verdict: failed,
          origin: { source: 'trial', observedBy: { tokenId: 'a', generation: 1 } },
        },
      }),
    ).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'trial_succeeded',
      why: '試しの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない',
    });
  });

  it('current が無い・trial でない: ターンの成功の文面', () => {
    const why =
      'ターンの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない';
    expect(successNotReflectedOutcome({ reason: 'turn_succeeded', current: undefined }).why).toBe(
      why,
    );
    expect(
      successNotReflectedOutcome({
        reason: 'turn_succeeded',
        current: {
          verdict: failed,
          origin: { source: 'turn_success', observedBy: { tokenId: 'a', generation: 1 } },
        },
      }),
    ).toStrictEqual({ kind: 'ignored', signal: 'none', reason: 'turn_succeeded', why });
  });
});

describe('末尾の ready 枝', () => {
  it('probeUnusableUnrecordedOutcome: 行が在れば label、無ければ currentId（全欄・全文）', () => {
    expect(
      probeUnusableUnrecordedOutcome({
        reason: 'account_probe',
        row: row('a', 'A'),
        currentId: 'a',
        probeUnusableUnrecorded: '枠切れ',
        settingsReason: '壊れていた',
      }),
    ).toStrictEqual({
      kind: 'ignored',
      signal: 'settings_unreadable',
      reason: 'account_probe',
      why: '現役「A」は probe で通らないことを観測した（枠切れ）。回転の設定が読めなかったので冷却を書けず、この回は回さない（壊れていた）',
    });
    expect(
      probeUnusableUnrecordedOutcome({
        reason: 'account_probe',
        row: undefined,
        currentId: 'a',
        probeUnusableUnrecorded: '枠切れ',
        settingsReason: '壊れていた',
      }).why,
    ).toBe(
      '現役「a」は probe で通らないことを観測した（枠切れ）。回転の設定が読めなかったので冷却を書けず、この回は回さない（壊れていた）',
    );
  });

  it('reopenedOutcome: cooldownUntil から ISO を作り、reopened と why に同じ値を入れる（全欄・欄の順）', () => {
    const outcome = reopenedOutcome({ reason: 'tick', row: row('a', 'A'), cooldownUntil: UNTIL });
    expect(outcome).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'tick',
      reopened: { tokenId: 'a', label: 'A', cooldownUntil: UNTIL_ISO },
      why: `現役「A」の冷却が明けた（${UNTIL_ISO}）。**時計で明けたのであって、通ることを観測したわけではない**`,
    });
    expect(Object.keys(outcome)).toStrictEqual(['kind', 'signal', 'reason', 'reopened', 'why']);
  });

  it('reopenedOutcome: 日時にならない cooldownUntil は RangeError で投げる（握り潰さない）', () => {
    expect(() =>
      reopenedOutcome({ reason: 'tick', row: row('a', 'A'), cooldownUntil: Number.NaN }),
    ).toThrow(RangeError);
  });

  it('readyNoTriggerOutcome: 行が在れば label、無ければ currentId', () => {
    expect(
      readyNoTriggerOutcome({ reason: 'tick', row: row('a', 'A'), currentId: 'a' }),
    ).toStrictEqual({
      kind: 'ignored',
      signal: 'none',
      reason: 'tick',
      why: '記録の上ではいまの現役「A」が通る（回す契機が無い。健全な鍵から勝手に移らない）',
    });
    expect(readyNoTriggerOutcome({ reason: 'tick', row: undefined, currentId: 'a' }).why).toBe(
      '記録の上ではいまの現役「a」が通る（回す契機が無い。健全な鍵から勝手に移らない）',
    );
  });
});

describe('strandedWhyOf', () => {
  const base = {
    currentId: 'a',
    row: row('a', 'A'),
    blockedByProbe: false,
    currentVerdict: undefined as TokenCandidateVerdict | undefined,
  };

  it('dangling は blockedByProbe より先', () => {
    expect(
      strandedWhyOf({ ...base, availability: 'dangling', blockedByProbe: true, row: undefined }),
    ).toBe('現役として記録された id（a）の行がプールに無い');
  });

  it('blockedByProbe: unusable なら理由、そうでなければ空', () => {
    expect(
      strandedWhyOf({
        ...base,
        availability: 'cooling',
        blockedByProbe: true,
        currentVerdict: { verdict: 'unusable', reason: '枠切れ' },
      }),
    ).toBe('現役「A」は probe で通らないことを観測した（枠切れ）');
    expect(
      strandedWhyOf({
        ...base,
        availability: 'cooling',
        blockedByProbe: true,
        currentVerdict: usable,
      }),
    ).toBe('現役「A」は probe で通らないことを観測した（）');
    expect(
      strandedWhyOf({ ...base, availability: 'cooling', blockedByProbe: true, row: undefined }),
    ).toBe('現役「a」は probe で通らないことを観測した（）');
  });

  it('それ以外は availability を括弧に出す', () => {
    expect(strandedWhyOf({ ...base, availability: 'disabled' })).toBe(
      '記録の上でいまの現役「A」は通らない（disabled）',
    );
    expect(strandedWhyOf({ ...base, availability: 'invalidated', row: undefined })).toBe(
      '記録の上でいまの現役「a」は通らない（invalidated）',
    );
  });
});

describe('strandedDecisionOf', () => {
  it('設定が読めない: settings_unreadable（全欄・全文）', () => {
    expect(
      strandedDecisionOf({
        reason: 'tick',
        stranded: '頭',
        settingsRead: { readable: false, reason: '壊れていた' },
      }),
    ).toStrictEqual({
      kind: 'ignored',
      outcome: {
        kind: 'ignored',
        signal: 'settings_unreadable',
        reason: 'tick',
        why: '頭。回転の設定が読めなかった（壊れていた）ので、この回は回さない',
      },
    });
  });

  it('rotateOn が off: stranded（全欄・全文）', () => {
    expect(
      strandedDecisionOf({
        reason: 'tick',
        stranded: '頭',
        settingsRead: { readable: true, settings: { rotateOn: 'off' } },
      }),
    ).toStrictEqual({
      kind: 'ignored',
      outcome: {
        kind: 'ignored',
        signal: 'stranded',
        reason: 'tick',
        why: '頭。回す契機の設定が off なので回さない（記録だけする）',
      },
    });
  });

  it('それ以外は continue で、設定を同じ参照で運ぶ', () => {
    const settings = { rotateOn: 'on' };
    const decision = strandedDecisionOf({
      reason: 'tick',
      stranded: '頭',
      settingsRead: { readable: true, settings },
    });
    expect(decision).toStrictEqual({ kind: 'continue', settings });
    expect((decision as { settings: unknown }).settings).toBe(settings);
  });

  it('同期の関数が throw したときはそのまま呼び元へ伝わる（settings が getter で投げる）', () => {
    const boom = new Error('読めない');
    const settingsRead = {
      readable: true as const,
      get settings(): { rotateOn: string } {
        throw boom;
      },
    };
    expect(() => strandedDecisionOf({ reason: 'tick', stranded: '頭', settingsRead })).toThrow(
      boom,
    );
    expect(() => unnominatedDecision({ reason: 'tick', settingsRead })).toThrow(boom);
  });
});
