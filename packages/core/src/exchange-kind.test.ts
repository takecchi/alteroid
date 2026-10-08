import { describe, expect, it } from 'vitest';

import {
  EXCHANGE_KIND_DECISION_PREFIX,
  EXCHANGE_KIND_FAILURE_PREFIX,
  EXCHANGE_KIND_GAUGE_PREFIX,
  EXCHANGE_KIND_PREFIXES,
  EXCHANGE_KIND_RECOVERY_PREFIX,
  EXCHANGE_KIND_REPLY_PREFIX,
  EXCHANGE_KIND_THINNING_PREFIX,
  inferExchangeKindFromText,
} from './exchange-kind.js';

describe('inferExchangeKindFromText', () => {
  it('6種類それぞれの接頭辞を、前方一致で正しい kind へ復元する', () => {
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_REPLY_PREFIX}こんにちは`)).toBe('reply');
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_DECISION_PREFIX}受理した`)).toBe('decision');
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_THINNING_PREFIX}畳んだ`)).toBe('thinning');
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_FAILURE_PREFIX}失敗した`)).toBe('failure');
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_RECOVERY_PREFIX}拾い直した`)).toBe(
      'recovery',
    );
    expect(inferExchangeKindFromText(`${EXCHANGE_KIND_GAUGE_PREFIX}枠に当たった`)).toBe('gauge');
  });

  it('EXCHANGE_KIND_PREFIXES の6組すべてを、宣言された組み合わせのとおりに復元する', () => {
    expect(EXCHANGE_KIND_PREFIXES).toHaveLength(6);
    for (const { kind, prefix } of EXCHANGE_KIND_PREFIXES) {
      expect(inferExchangeKindFromText(`${prefix}本文`)).toBe(kind);
    }
  });

  it('接頭辞が無い本文は undefined（3つ目の状態。6種類のどれかへ倒さない）', () => {
    expect(inferExchangeKindFromText('こんにちは')).toBeUndefined();
    expect(inferExchangeKindFromText('')).toBeUndefined();
  });

  it('似て非なる文字列には当たらない（前方一致のみ・かっこの有無・空白の有無・別の語）', () => {
    expect(inferExchangeKindFromText('応答 こんにちは')).toBeUndefined();
    expect(inferExchangeKindFromText('[応答]こんにちは')).toBeUndefined();
    expect(inferExchangeKindFromText(`こんにちは${EXCHANGE_KIND_REPLY_PREFIX}`)).toBeUndefined();
    expect(inferExchangeKindFromText('[警告] 整合性異常')).toBeUndefined();
    expect(inferExchangeKindFromText('[mgr-1a2b3c4d] こんにちは')).toBeUndefined();
  });

  it('with: human の行に想定している「接頭辞を付けない」形も undefined を返す（呼び出し側が別に判定する）', () => {
    expect(inferExchangeKindFromText('人間への返信そのもの')).toBeUndefined();
  });
});
