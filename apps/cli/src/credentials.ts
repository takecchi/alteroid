import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stateDir } from './paths.js';

/**
 * `alteroid login` で受け取ったアクセストークンの保管先
 * （`~/.alteroid/state/credentials.json`、0600）。
 *
 * **`daemon.json` とは別ファイルにしてある。** あちらは起動のたびに書き直される
 * デーモンの生存情報で、ログインの寿命（既定30日）とは寿命がまるで違う。
 * 混ぜると、デーモンを再起動しただけでログインが消える。
 *
 * 接続先ごとに分けて持つ。手元のデーモンとクラウドのデーモンでは別のトークンに
 * なるので、1本しか持てないと「常にどちらかに入り直す」ことになる。
 */
export interface StoredCredential {
  token: string;
  accountId: string;
  /** 人間が `whoami` で見るための表示名（メール等）。秘密ではない。 */
  label: string;
  createdAt: string;
}

type CredentialFile = Record<string, StoredCredential>;

function credentialsPath(): string {
  return join(stateDir(), 'credentials.json');
}

async function readAll(): Promise<CredentialFile> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CredentialFile) : {};
  } catch {
    return {};
  }
}

/** 末尾のスラッシュ違いで別の接続先として溜まらないようにする。 */
export function credentialKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export async function readCredential(baseUrl: string): Promise<StoredCredential | null> {
  const all = await readAll();
  return all[credentialKey(baseUrl)] ?? null;
}

export async function writeCredential(
  baseUrl: string,
  credential: StoredCredential,
): Promise<void> {
  const all = await readAll();
  all[credentialKey(baseUrl)] = credential;
  await persist(all);
}

export async function clearCredential(baseUrl: string): Promise<boolean> {
  const all = await readAll();
  const key = credentialKey(baseUrl);
  if (all[key] === undefined) return false;
  delete all[key];
  await persist(all);
  return true;
}

async function persist(all: CredentialFile): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  // 一時ファイルの時点で 0600。rename 後に絞ると、その隙間で他人が読める。
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
