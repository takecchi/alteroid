import { describe, expect, it } from 'vitest';

import { createSecretValueRedactor } from './secret-value-redaction.js';

// ダミーの値（本物の鍵ではない）
const DUMMY_GH = 'dummy-gh-value-0123456789abcdef';
const DUMMY_VAULT = 'dummy-vault-value-ABCDEFGHIJ';
const QUOTED = 'dummy"quoted\\value-0123456789';

describe('createSecretValueRedactor: 子が持つ秘密の値を生ログから伏せる（#6864）', () => {
  const redactor = createSecretValueRedactor({
    env: {
      GH_TOKEN: DUMMY_GH,
      PATH: '/usr/local/bin:/usr/bin:/bin:/opt/very/long/path',
      SHORT_TOKEN: 'short',
      ODD_SECRET: QUOTED,
    },
    alwaysSecret: { DB_PASS_WORD_X: DUMMY_VAULT },
  });

  it('Bash の出力に載った値を、名前つきの印に置き換える', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: `HOME=/home/x\nGH_TOKEN=${DUMMY_GH}\n` }],
      },
    };
    const [out] = redactor.redactEntries([entry]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(DUMMY_GH);
    expect(text).toContain('GH_TOKEN=[redacted:env:GH_TOKEN]');
  });

  it('資格の正本の値は名前によらず伏せる', () => {
    expect(redactor.redactText(`x ${DUMMY_VAULT} y`)).toBe('x [redacted:env:DB_PASS_WORD_X] y');
  });

  it('秘密でない名前の値・短い値は触らない', () => {
    const text = 'PATH=/usr/local/bin:/usr/bin:/bin:/opt/very/long/path SHORT=short';
    expect(redactor.redactText(text)).toBe(text);
  });

  it('JSONL の本文では、JSON の文字列として逃がされた形も伏せる', () => {
    const line = JSON.stringify({ text: `v=${QUOTED}` });
    const out = redactor.redactText(line);
    expect(out).not.toContain(JSON.stringify(QUOTED).slice(1, -1));
    expect(out).toContain('[redacted:env:ODD_SECRET]');
    expect(JSON.parse(out)).toEqual({ text: 'v=[redacted:env:ODD_SECRET]' });
  });

  it('触らない行は同じ参照で返す（アーカイブの連続性の判定がバイト比較のため）', () => {
    const untouched = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    const touched = { type: 'user', message: { content: `t=${DUMMY_GH}` } };
    const out = redactor.redactEntries([untouched, touched]);
    expect(out[0]).toBe(untouched);
    expect(out[1]).not.toBe(touched);
    expect(touched.message.content).toContain(DUMMY_GH);
  });

  it('名前が秘密に見えなくても、値がパスワード入りの URL なら伏せる（#6866）', () => {
    const url = 'postgres://alteroid:dummy-pass-6866@db.example.invalid:5432/alteroid';
    const r = createSecretValueRedactor({
      env: { STORE_URL: url, PLAIN_URL: 'https://example.invalid/some/long/path/here' },
    });
    expect(r.redactText(`x=${url}`)).toBe('x=[redacted:env:STORE_URL]');
    expect(r.redactText('https://example.invalid/some/long/path/here')).toBe(
      'https://example.invalid/some/long/path/here',
    );
  });

  it('伏せる値が無ければ本文をそのまま返す', () => {
    const none = createSecretValueRedactor({ env: { PATH: '/usr/bin' } });
    expect(none.redactText(`GH_TOKEN=${DUMMY_GH}`)).toBe(`GH_TOKEN=${DUMMY_GH}`);
  });

  it('`__proto__` という名前のキーをプロトタイプの書き換えに化けさせない', () => {
    const entry = JSON.parse(`{"__proto__": {"x": "${DUMMY_GH}"}}`) as Record<string, unknown>;
    const [out] = redactor.redactEntries([entry]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toContain('[redacted:env:GH_TOKEN]');
  });
});
