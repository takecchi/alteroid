import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readCredential,
  readPendingLogin,
  storeCredential,
  storePendingLogin,
  type Credential,
} from './auth.js';

/** ブラウザの外で回すので、必要な分だけの置き場を用意する。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

const CREDENTIAL: Credential = {
  token: 'alt_one',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
});

afterEach(() => {
  // @ts-expect-error 後片付け: 実行環境には無い前提の口なので、次のテストへ漏らさない
  delete globalThis.localStorage;
  // @ts-expect-error 後片付け: 同上
  delete globalThis.sessionStorage;
});

describe('資格情報', () => {
  it('接続先ごとに分けて持つ', () => {
    // **1つを使い回さない。** トークンは発行したデーモンでしか通らないので、
    // 接続先を変えた瞬間に前の鍵を新しい相手へ提示することになる。
    storeCredential('https://a.example.com', CREDENTIAL);
    storeCredential('https://b.example.com', { ...CREDENTIAL, token: 'alt_two' });

    expect(readCredential('https://a.example.com')?.token).toBe('alt_one');
    expect(readCredential('https://b.example.com')?.token).toBe('alt_two');
    expect(readCredential('https://c.example.com')).toBeNull();
  });

  it('null で消える（ログアウト）', () => {
    storeCredential('/api', CREDENTIAL);
    storeCredential('/api', null);
    expect(readCredential('/api')).toBeNull();
  });

  it('壊れた値を「ログイン済み」と見なさない', () => {
    // 握り潰して通すと、鍵が無いのに入れたつもりで全経路が 401 になる。
    localStorage.setItem('alteroid.credential:/api', 'not json');
    expect(readCredential('/api')).toBeNull();

    localStorage.setItem('alteroid.credential:/api', JSON.stringify({ token: '' }));
    expect(readCredential('/api')).toBeNull();

    localStorage.setItem('alteroid.credential:/api', JSON.stringify({ token: 'alt_x' }));
    expect(readCredential('/api')).toBeNull();
  });
});

describe('進行中のログイン', () => {
  const pending = {
    requestId: 'req-1',
    claimSecret: 'shhh',
    provider: 'google',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it('往復のあいだ引き換え券を預かる', () => {
    storePendingLogin(pending);
    expect(readPendingLogin()).toEqual(pending);
  });

  it('期限切れの引き換え券は返さない', () => {
    storePendingLogin({ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(readPendingLogin()).toBeNull();
  });

  it('合鍵はタブを閉じたら消える置き場に留める', () => {
    storePendingLogin(pending);
    // localStorage ではなく sessionStorage であること（claimSecret は引き取りの合鍵そのもの）。
    expect(sessionStorage.getItem('alteroid.pendingLogin')).not.toBeNull();
    expect(localStorage.getItem('alteroid.pendingLogin')).toBeNull();
  });
});
