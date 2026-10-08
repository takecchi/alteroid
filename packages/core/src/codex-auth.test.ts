import { describe, expect, it } from 'vitest';

import {
  buildCodexApiKeyLoginParams,
  codexAuthModeFromAccount,
  selectCodexAuth,
} from './codex-auth.js';

const SECRET = 'sk-UNIQ-7f3a9c-secret';

describe('selectCodexAuth', () => {
  it('両方あるとき apiKey が選ばれる', () => {
    expect(selectCodexAuth({ apiKey: SECRET, chatgptLogin: true })).toEqual({
      kind: 'apiKey',
      apiKey: SECRET,
    });
  });
  it('API キーだけでも apiKey', () => {
    expect(selectCodexAuth({ apiKey: SECRET, chatgptLogin: false }).kind).toBe('apiKey');
  });
  it('前後の空白は落として渡す', () => {
    expect(selectCodexAuth({ apiKey: `  ${SECRET}\n`, chatgptLogin: false })).toEqual({
      kind: 'apiKey',
      apiKey: SECRET,
    });
  });
  it.each(['', '   ', '\n\t', null, undefined])('API キーが %j なら chatgpt に倒れる', (apiKey) => {
    expect(selectCodexAuth({ apiKey, chatgptLogin: true })).toEqual({ kind: 'chatgpt' });
  });
  it('ChatGPT ログインだけなら chatgpt', () => {
    expect(selectCodexAuth({ chatgptLogin: true })).toEqual({ kind: 'chatgpt' });
  });
  it.each(['', '  ', null, undefined])('両方無ければ none（キー %j）で理由がある', (apiKey) => {
    const r = selectCodexAuth({ apiKey, chatgptLogin: false });
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason.length).toBeGreaterThan(0);
  });
  it('none の reason に鍵の値が出ない（空白だけの鍵でも、鍵が使われた経路でも）', () => {
    const r = selectCodexAuth({ apiKey: '   ', chatgptLogin: false });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const c = selectCodexAuth({ apiKey: '', chatgptLogin: true });
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });
});

describe('buildCodexApiKeyLoginParams', () => {
  it('type と apiKey だけを持つ（ephemeral の欄は作らない）', () => {
    expect(buildCodexApiKeyLoginParams(SECRET)).toStrictEqual({ type: 'apiKey', apiKey: SECRET });
  });
});

describe('codexAuthModeFromAccount', () => {
  it('apiKey / chatgpt を写す', () => {
    expect(codexAuthModeFromAccount({ account: { type: 'apiKey' } })).toBe('apiKey');
    expect(
      codexAuthModeFromAccount({ account: { type: 'chatgpt', email: null, planType: 'plus' } }),
    ).toBe('chatgpt');
  });
  it.each([
    [{ account: { type: 'amazonBedrock' } }],
    [{ account: { type: 'ApiKey' } }],
    [{ account: { type: '' } }],
    [{ account: null }],
    [{}],
    [null],
    [undefined],
  ])('知らない値・無い値は unknown: %j', (res) => {
    expect(codexAuthModeFromAccount(res as never)).toBe('unknown');
  });
});
