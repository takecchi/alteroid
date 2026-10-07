import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { withPathLock, writeFileAtomic } from '@alteroid/storage-fs/light';

import { stateDir } from './paths.js';
import { stderr } from './terminal-out.js';

export interface StoredCredential {
  token: string;
  accountId: string;
  label: string;
  createdAt: string;
}

type CredentialFile = Record<string, StoredCredential>;

function credentialsPath(): string {
  return join(stateDir(), 'credentials.json');
}

// 「ログインしていません」と言い換えない: やり直すと壊れたファイルが退避され、ほかの接続先のログイン情報も空から始まるため
// message にトークンも `JSON.parse` の例外文も載せない: 入力の断片が載りうるため
export class CredentialsUnreadableError extends Error {
  readonly reason: 'io' | 'corrupt';

  constructor(reason: 'io' | 'corrupt', message: string) {
    super(message);
    this.name = 'CredentialsUnreadableError';
    this.reason = reason;
  }
}

// 読む口では退避しない: 読んだだけの呼び出しがディスクへ副作用を持つため
async function readAllForRead(): Promise<CredentialFile> {
  const path = credentialsPath();
  const current = await readAllStrictOrExplain();
  if (!current.ok) {
    throw new CredentialsUnreadableError(
      'corrupt',
      `資格情報のファイル（${path}）が壊れていて、JSON として読めません。` +
        'ログインしていないのではありません。ファイルの中身を確かめてください。' +
        '直さずに alteroid login をやり直すと、このファイルは退避され、' +
        'ほかの接続先のログイン情報も空から始まります。',
    );
  }
  return current.value;
}

export function credentialKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export async function readCredential(baseUrl: string): Promise<StoredCredential | null> {
  const all = await readAllForRead();
  return all[credentialKey(baseUrl)] ?? null;
}

// 権限エラーでは退避しない: 壊れているという判定が誤りうる状況で rename すると、読めないだけのファイルを動かす実害が大きいため
async function readAllStrict(): Promise<{ ok: true; value: CredentialFile } | { ok: false }> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: {} };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false };
    return { ok: true, value: parsed as CredentialFile };
  } catch {
    return { ok: false };
  }
}

async function readAllStrictOrExplain(): Promise<
  { ok: true; value: CredentialFile } | { ok: false }
> {
  try {
    return await readAllStrict();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CredentialsUnreadableError(
      'io',
      `資格情報のファイル（${credentialsPath()}）を読めませんでした（${typeof code === 'string' ? code : '原因不明'}）。` +
        'ログインしていないのではありません。ファイルの権限と所有者を確かめて、' +
        '読めるようにしてからもう一度実行してください。',
    );
  }
}

function filenameSafeIsoNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function quarantineUnreadable(): Promise<string> {
  const path = credentialsPath();
  const dest = `${path}.unreadable-${filenameSafeIsoNow()}`;
  await rename(path, dest);
  stderr.write(`alteroid: 読めない資格ファイルを退避しました: ${dest}\n`);
  return dest;
}

async function withCredentials<T>(
  mutate: (file: CredentialFile) => { next: CredentialFile | null; result: T },
  onQuarantined?: (dest: string) => void,
): Promise<T> {
  return withPathLock(credentialsPath(), async () => {
    const current = await readAllStrictOrExplain();
    const quarantined = !current.ok;
    if (quarantined) {
      const dest = await quarantineUnreadable();
      onQuarantined?.(dest);
    }
    const base = current.ok ? current.value : {};
    const { next, result } = mutate(base);
    // 退避した直後は `next` が null でも書く: 書かずに終えるとファイルが消えたままになるため
    if (next === null && !quarantined) return result;
    const toWrite = next ?? base;
    await mkdir(stateDir(), { recursive: true });
    // rename 後に絞らない: その隙間で他人が読めるため
    await writeFileAtomic(credentialsPath(), `${JSON.stringify(toWrite, null, 2)}\n`, {
      mode: 0o600,
    });
    return result;
  });
}

export async function writeCredential(
  baseUrl: string,
  credential: StoredCredential,
): Promise<void> {
  await withCredentials((all) => {
    const next = { ...all, [credentialKey(baseUrl)]: credential };
    return { next, result: undefined };
  });
}

export async function clearCredential(
  baseUrl: string,
  onQuarantined?: (dest: string) => void,
): Promise<boolean> {
  return withCredentials((all) => {
    const key = credentialKey(baseUrl);
    if (all[key] === undefined) return { next: null, result: false };
    const next = { ...all };
    delete next[key];
    return { next, result: true };
  }, onQuarantined);
}
