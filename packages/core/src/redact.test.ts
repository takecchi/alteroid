import { describe, expect, it } from 'vitest';

import { REDACTED_EXCERPT_READ_LIMIT, redactedExcerpt } from './redact.js';

// 偽の値だけを使う（本物の鍵は使わない）。
const FAKE_GHP = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

describe('redactedExcerpt（issue #2418。伏せてから切る）', () => {
  it('値を含まない短い文は、そのまま返す（対照）', () => {
    expect(redactedExcerpt('普通のエラー: 見つからない', 100, undefined)).toBe(
      '普通のエラー: 見つからない',
    );
  });

  it('既知の形・URL の資格・params: 以降を伏せる', () => {
    const out = redactedExcerpt(
      `x ${FAKE_GHP} postgres://u:FAKE@h/db\nparams: FAKE`,
      1000,
      undefined,
    );
    expect(out).not.toContain(FAKE_GHP);
    expect(out).not.toContain(':FAKE@');
    expect(out).not.toMatch(/params: FAKE/);
  });

  it('切り口で割れたトークンの断片を残さない（伏せてから切る）', () => {
    // トークンが上限をまたぐ位置に置く。先に切ると断片が残る。
    const text = `${'x '.repeat(10)}${FAKE_GHP}`;
    // 先に 35 字で切ると `ghp_` + 15 字が残る（20 字未満なので規則に合わない）。
    const out = redactedExcerpt(text, 35, undefined);
    expect(out).not.toContain('ghp_');
    expect(out).toContain('[REDACTED]');
  });

  it('長い本文は limit 字で切り、切ったことを … で示す', () => {
    const out = redactedExcerpt('あ'.repeat(REDACTED_EXCERPT_READ_LIMIT * 2), 50, undefined);
    expect(out).toBe(`${'あ'.repeat(50)}…`);
  });

  it('env を渡すと、秘密らしい名前の環境変数の値も伏せる', () => {
    const out = redactedExcerpt('boom FAKE_SECRET_VALUE_2418 end', 100, {
      GH_TOKEN: 'FAKE_SECRET_VALUE_2418',
    });
    expect(out).not.toContain('FAKE_SECRET_VALUE_2418');
  });
});
