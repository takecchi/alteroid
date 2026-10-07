import { clearChatDrafts } from './chat-drafts.js';

// account を持つ: 許可されていないアカウントは `GET /auth/me` に届かず（403）、引き取り時以外に id を知る方法が無い。
export interface StoredAccount {
  id: string;
  displayName: string | null;
  email: string | null;
}

export interface Credential {
  token: string;
  account: StoredAccount;
  /** 引き取った時点で許可されていたか。現在の許可ではない（取り消されうる）。 */
  grantedAtClaim: boolean;
  createdAt: string;
}

// 鍵をデーモンごとに分ける: トークンは発行したデーモンでしか通らず、使い回すと接続先を変えたとき前の鍵が残る。
// Cookie は使わない: 画面とデーモンのオリジンが違う配置を前提にしており、Cookie は成立しない。
function keyFor(baseUrl: string): string {
  return `alteroid.credential:${baseUrl}`;
}

export function readCredential(baseUrl: string): Credential | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(keyFor(baseUrl));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Credential>;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    if (typeof parsed.account?.id !== 'string') return null;
    return parsed as Credential;
  } catch {
    return null;
  }
}

export function storeCredential(baseUrl: string, credential: Credential | null): void {
  if (typeof localStorage === 'undefined') return;
  if (credential === null) clearChatDrafts();
  if (credential === null) localStorage.removeItem(keyFor(baseUrl));
  else localStorage.setItem(keyFor(baseUrl), JSON.stringify(credential));
}

// `sessionStorage` に置く: `claimSecret` は引き取りの合鍵そのものなので、タブを閉じたら消える置き場に留める。
export interface PendingLogin {
  requestId: string;
  claimSecret: string;
  expiresAt: string;
  provider: string;
}

const PENDING_KEY = 'alteroid.pendingLogin';

export function readPendingLogin(): PendingLogin | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingLogin>;
    if (typeof parsed.requestId !== 'string' || typeof parsed.claimSecret !== 'string') return null;
    if (typeof parsed.expiresAt !== 'string') return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed as PendingLogin;
  } catch {
    return null;
  }
}

export function storePendingLogin(pending: PendingLogin | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (pending === null) sessionStorage.removeItem(PENDING_KEY);
  else sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

export function deviceLabel(): string {
  // `location` を直に書かない: DOM の lib を持たない側（`apps/cli`）が型検査に載せても通すため。
  const host = (globalThis as { location?: { host: string } }).location?.host ?? 'web';
  return `Web UI (${host})`.slice(0, 200);
}
