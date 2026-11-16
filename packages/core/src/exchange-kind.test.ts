import { describe, expect, it } from 'vitest';

import {
  EXCHANGE_KIND_PREFIXES,
  EXCHANGE_KIND_REPLY_PREFIX,
  exchangeKindOf,
  exchangeSenderOf,
} from './exchange-kind.js';

describe('exchangeKindOf', () => {
  it('EXCHANGE_KIND_PREFIXES のどの接頭辞からも、対応する種類を導く', () => {
    for (const { kind, prefix } of EXCHANGE_KIND_PREFIXES) {
      expect(exchangeKindOf(`${prefix}本文`)).toBe(kind);
    }
  });

  it('接頭辞が無い本文や、頭以外に接頭辞がある本文は null', () => {
    expect(exchangeKindOf('ただの本文')).toBeNull();
    expect(exchangeKindOf('前置き [応答] 本文')).toBeNull();
  });
});

describe('exchangeSenderOf', () => {
  const managerId = 'mgr-x';

  it('outbound で `[応答] [managerId] [system] ` で始まれば system（rescue_restore の応答）', () => {
    expect(
      exchangeSenderOf({
        role: 'outbound',
        managerId,
        text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] [system] rescue_restore: 預かりを読み出せなかった。`,
      }),
    ).toBe('system');
  });

  it('通常の manager_send 由来の outbound は clone', () => {
    expect(
      exchangeSenderOf({
        role: 'outbound',
        managerId,
        text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] 続きをお願いします`,
      }),
    ).toBe('clone');
  });

  it('本文の途中に [system] があるだけの outbound は clone（頭だけを見る）', () => {
    expect(
      exchangeSenderOf({
        role: 'outbound',
        managerId,
        text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] 直前の [system] 通知について`,
      }),
    ).toBe('clone');
  });

  it('別の managerId の [system] は、この行の managerId と合わなければ clone に倒す', () => {
    expect(
      exchangeSenderOf({
        role: 'outbound',
        managerId,
        text: `${EXCHANGE_KIND_REPLY_PREFIX}[mgr-other] [system] x`,
      }),
    ).toBe('clone');
  });

  it('managerId の欄が無くても `[<id>] [system] ` の頭は system、他は clone', () => {
    expect(exchangeSenderOf({ role: 'outbound', text: '[応答] [mgr-y] [system] 通知' })).toBe(
      'system',
    );
    expect(exchangeSenderOf({ role: 'outbound', text: '[応答] [mgr-y] 依頼' })).toBe('clone');
  });

  it('接頭辞の無い outbound でも、頭が `[managerId] [system] ` なら system', () => {
    expect(
      exchangeSenderOf({ role: 'outbound', managerId, text: `[${managerId}] [system] x` }),
    ).toBe('system');
  });

  it('inbound は本文が何であっても manager', () => {
    expect(
      exchangeSenderOf({
        role: 'inbound',
        managerId,
        text: `[判断] [${managerId}] [system] x`,
      }),
    ).toBe('manager');
  });
});
