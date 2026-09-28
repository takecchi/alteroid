import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { withPathLock, writeFileAtomic } from '@alteroid/storage-fs';

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
 *
 * ## 排他（issue #1992）
 *
 * 以前は `writeCredential` / `clearCredential` のどちらも「全体を読む → 自分の
 * キーだけ変える → 全体を書き戻す」で、読んでから書くまでの間に排他が無かった。
 * 同じホストで2つの `alteroid login` / `logout` が重なると、後から書いた側が
 * 相手の変更を持たない古い全体を書き戻し、先に成功したログインの資格が例外
 * なしに消えていた。tmp 名も `${path}.tmp` 固定だったので、2つの書き手の
 * `rename` が競合すると片方が ENOENT で落ちることもあった。
 *
 * `packages/storage-fs` は同じ形の穴を #1050 / #1113 で `withPathLock`
 * （プロセス内・プロセス間の advisory ロック）と `writeFileAtomic`（呼び出し
 * ごとに一意な tmp 名 + `mode` 指定）で塞いでいる。ここではロジックを複製せず、
 * `@alteroid/storage-fs` の入口からその2つをそのまま使う——`apps/cli` は既に
 * `@alteroid/storage-fs` に依存している。
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

/**
 * 読むだけの口が使う、寛容な読み方。JSON として読めない・トップレベルが
 * オブジェクトでない・ファイルが無い、のどれでも黙って空へ倒す。
 *
 * **退避はしない。** 退避（壊れたファイルを動かして跡を残す）は書く口
 * （`#withCredentials`）だけの仕事——読むだけの `readCredential` がファイルを
 * 動かすと、読んだだけのつもりの呼び出しがディスクへ副作用を持つことになる。
 */
async function readAllLenient(): Promise<CredentialFile> {
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
  const all = await readAllLenient();
  return all[credentialKey(baseUrl)] ?? null;
}

/**
 * 書く口が使う、厳格な読み方。
 *
 * - ファイルが無ければ（`ENOENT`）空から始める——いままでどおり。
 * - JSON として読めない、またはトップレベルがオブジェクトでなければ
 *   `{ ok: false }`。**中身は返さない**——呼び出し側（`#withCredentials`）が
 *   退避してから空で始める。
 * - それ以外の読み取りエラー（権限など）は投げる。壊れているという判定が
 *   誤りうる状況で退避（`rename`）まで行うと、実害（読めないだけのファイルを
 *   動かす）のほうが大きい。
 */
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

/** ファイル名に使える形の、いまの時刻（ISO 8601 の `:` と `.` を `-` に置き換える）。 */
function filenameSafeIsoNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 壊れて読めない資格ファイルを、黙って上書きしない。`credentials.json.
 * unreadable-<ISO時刻>` へ `rename` して退避する——`rename` は中身もモードも
 * 動かさない。stderr にはパスだけを1行出す（**中身は出さない**）。
 */
async function quarantineUnreadable(): Promise<void> {
  const path = credentialsPath();
  const dest = `${path}.unreadable-${filenameSafeIsoNow()}`;
  await rename(path, dest);
  process.stderr.write(`alteroid: 読めない資格ファイルを退避しました: ${dest}\n`);
}

/**
 * 読む → 変える → 書く、の全体を `withPathLock`（`@alteroid/storage-fs`）の
 * 1区間へ収める（issue #1992）。`mutate` が `next: null` を返せば書かない
 * （`clearCredential` が対象のキーを持たない場合の既存の「書かない」動作を
 * 保つ）——ただし、壊れたファイルを退避した直後は `next` が `null` でも新しい
 * （空の）ファイルを書く。壊れたファイルを退避したのに何も書かずに終えると、
 * 「退避した」という事実だけが残ってファイルが消えたままになる。
 */
async function withCredentials<T>(
  mutate: (file: CredentialFile) => { next: CredentialFile | null; result: T },
): Promise<T> {
  return withPathLock(credentialsPath(), async () => {
    const current = await readAllStrict();
    const quarantined = !current.ok;
    if (quarantined) await quarantineUnreadable();
    const base = current.ok ? current.value : {};
    const { next, result } = mutate(base);
    if (next === null && !quarantined) return result;
    const toWrite = next ?? base;
    await mkdir(stateDir(), { recursive: true });
    // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
    // 絞ると、その隙間で他人が読める。
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

export async function clearCredential(baseUrl: string): Promise<boolean> {
  return withCredentials((all) => {
    const key = credentialKey(baseUrl);
    if (all[key] === undefined) return { next: null, result: false };
    const next = { ...all };
    delete next[key];
    return { next, result: true };
  });
}
