/**
 * 資格情報の置き場。
 *
 * ## なぜ Cookie ではないのか
 *
 * `config.ts` の冒頭に書いたとおり、画面とデーモンのオリジンが違う配置を前提に
 * しているので Cookie は成立しない。デーモン側も `credentials: false` で、
 * Cookie を運ばせる作りになっていない（`Authorization: Bearer` だけを見る）。
 *
 * ## なぜデーモンごとに分けるのか
 *
 * この画面は接続先を差し替えられる（`config.ts`）。トークンは**発行した
 * デーモンでしか通らない**ので、1つの鍵を使い回すと、接続先を変えた瞬間に
 * 前のデーモンの鍵を新しいデーモンへ提示することになる。401 になるだけとはいえ、
 * 「ログインし直したのに前の鍵が残っている」状態は人間に説明できない。
 * CLI が接続先ごとに資格情報を持つ（`apps/cli/src/credentials.ts`）のと同じ形にする。
 *
 * ## account を一緒に持つ理由
 *
 * 許可されていないアカウントは `GET /auth/me` にも届かない（門番が 403 で止める）
 * ので、**そこから自分のアカウント id を知る方法が無い**。人間に
 * `alteroid access grant <id>` と案内するには id が要るので、引き取り時に
 * 返ってきたものを控えておく。
 */

/** 引き取り（claim）時に受け取る、このデーモンでの自分。 */
export interface StoredAccount {
  id: string;
  displayName: string | null;
  email: string | null;
}

export interface Credential {
  token: string;
  account: StoredAccount;
  /** 引き取った時点で許可されていたか。**現在の許可ではない**（取り消されうる）。 */
  grantedAtClaim: boolean;
  createdAt: string;
}

function keyFor(baseUrl: string): string {
  return `alteroid.credential:${baseUrl}`;
}

export function readCredential(baseUrl: string): Credential | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(keyFor(baseUrl));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Credential>;
    // 形が違うものを握り潰して「ログイン済みのつもり」にしない。
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    if (typeof parsed.account?.id !== 'string') return null;
    return parsed as Credential;
  } catch {
    return null;
  }
}

export function storeCredential(baseUrl: string, credential: Credential | null): void {
  if (typeof localStorage === 'undefined') return;
  if (credential === null) localStorage.removeItem(keyFor(baseUrl));
  else localStorage.setItem(keyFor(baseUrl), JSON.stringify(credential));
}

/**
 * 進行中のログイン。
 *
 * `sessionStorage` に置くのは、**別タブ（ポップアップ）が塞がれて同じタブごと
 * 遷移した場合にも引き取れるようにする**ため。`claimSecret` は引き取りの合鍵
 * そのものなので、タブを閉じたら消える置き場（sessionStorage）に留める。
 */
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
    // 期限切れの引き換え券を握ったままにしない。
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

/** この端末を人間が見分けるための名前（`alteroid access list` に並ぶ）。 */
export function deviceLabel(): string {
  const host = typeof location === 'undefined' ? 'web' : location.host;
  return `Web UI (${host})`.slice(0, 200);
}
