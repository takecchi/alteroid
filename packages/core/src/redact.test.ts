import { describe, expect, it } from 'vitest';

import {
  REDACTED_EXCERPT_READ_LIMIT,
  redactSecretsInBody,
  redactSecretsInText,
  redactedExcerpt,
} from './redact.js';

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
    const text = `${'x '.repeat(10)}${FAKE_GHP}`;
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

describe('redactSecretsInBody（issue #2600。本文に掛ける狭い網）', () => {
  const SECRETS: ReadonlyArray<readonly [string, string, string]> = [
    ['GitHub の旧形式のトークン', `見て ${FAKE_GHP} ね`, FAKE_GHP],
    ['GitHub の新形式のトークン', `pat github_pat_${'A1b2C3d4E5'.repeat(3)} を`, 'github_pat_'],
    ['Anthropic の API 鍵', `鍵は sk-ant-api03-${'Zz9'.repeat(8)} だ`, 'sk-ant-'],
    ['AWS のアクセスキー id', 'id は AKIAABCDEFGHIJ012345 だ', 'AKIAABCDEFGHIJ012345'],
    ['Bearer', 'Authorization: Bearer abcdEFGH1234.xyz', 'abcdEFGH1234'],
    ['URL の資格', 'postgres://user:FAKEPASS@db.example.com/x', 'FAKEPASS'],
    ['scheme の無い URL の資格', 'user:FAKEPASS2@db.example.com', 'FAKEPASS2'],
    ['代入', 'export GH_TOKEN=FAKEVALUE を足した', 'FAKEVALUE'],
    ['JSON の代入', '{"API_KEY":"FAKEJSONVALUE"}', 'FAKEJSONVALUE'],
  ];

  for (const [name, text, secret] of SECRETS) {
    it(`${name}を伏せる`, () => {
      const out = redactSecretsInBody(text, undefined);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
    });
  }

  it('env を渡すと、秘密らしい名前の環境変数の値も伏せる', () => {
    const out = redactSecretsInBody('値は plainvalue-only-letters です', {
      MY_SECRET: 'plainvalue-only-letters',
    });
    expect(out).toBe('値は [REDACTED] です');
  });

  const IDENTIFIERS: ReadonlyArray<readonly [string, string]> = [
    ['40桁のコミット sha', 'commit 3b29eb9233915c325d60abff85909847ec43dc53 を見た'],
    ['短い sha', 'sha 3b29eb92 と d65c91ee'],
    ['UUID', 'id 0f8c2a1e-4b3d-4c5e-9f00-123456789abc の委譲'],
    ['長い枝名', '枝 fix/2621-redaction-gate-alias へ push した'],
    ['会話のログのファイル名', 'sess-1-2026-08-20T00-00-00-000Z.jsonl を読んだ'],
    ['PR 番号と時刻', 'PR #2627 を 2026-10-02T15:49:33Z に開いた'],
  ];

  for (const [name, text] of IDENTIFIERS) {
    it(`${name}はそのまま残す`, () => {
      expect(redactSecretsInBody(text, undefined)).toBe(text);
    });
  }

  it('対照: redactSecretsInText は 40桁の sha・UUID・長い枝名を伏せる（だから本文には使わない）', () => {
    for (const [, text] of IDENTIFIERS.slice(0, 1).concat(IDENTIFIERS.slice(2, 4))) {
      expect(redactSecretsInText(text, undefined)).toContain('[REDACTED]');
    }
  });
});
