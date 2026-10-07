import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { withPathLock, writeFileAtomic } from '@alteroid/storage-fs/light';

import { stateDir } from './paths.js';
import { stderr } from './terminal-out.js';

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
 * 資格ファイルが在るのに読めなかった（issue #2447）。**「ログインしていない」
 * ではない。** 呼び手はこれを「ログインしていません」と言い換えてはいけない
 * ——人が `alteroid login` をやり直すと、壊れたファイルは退避され、ほかの
 * 接続先のログイン情報も空から始まってしまう。
 *
 * `message` は人が次に何をすればよいかまで含む。**含めてよいのはファイルの
 * 場所（パス）と `error.code` まで**——資格情報の値（トークン）も、
 * `JSON.parse` の例外のメッセージ（入力の断片を載せることがある）も載せない。
 */
export class CredentialsUnreadableError extends Error {
  readonly reason: 'io' | 'corrupt';

  constructor(reason: 'io' | 'corrupt', message: string) {
    super(message);
    this.name = 'CredentialsUnreadableError';
    this.reason = reason;
  }
}

/**
 * 読むだけの口が使う読み方。書く口（{@link readAllStrict}）と同じ3つに分ける。
 *
 * - ファイルが無い（`ENOENT`）だけが「無い」——空を返す（ログインしていない）。
 * - 読めたが JSON でない・トップレベルがオブジェクトでない——壊れている。
 * - それ以外の読み取りエラー（権限 `EACCES` など）——読めなかった。
 *
 * 後ろの2つは {@link CredentialsUnreadableError} を投げる。
 *
 * **退避はしない。** 退避（壊れたファイルを動かして跡を残す）は書く口
 * （`#withCredentials`）だけの仕事——読むだけの `readCredential` がファイルを
 * 動かすと、読んだだけのつもりの呼び出しがディスクへ副作用を持つことになる。
 */
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

/** 末尾のスラッシュ違いで別の接続先として溜まらないようにする。 */
export function credentialKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 無ければ `null`（`ENOENT` だけ）。在るのに読めなければ
 * {@link CredentialsUnreadableError} を投げる。
 */
export async function readCredential(baseUrl: string): Promise<StoredCredential | null> {
  const all = await readAllForRead();
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

/**
 * {@link readAllStrict} の、読み取りエラー（権限 `EACCES` など）を人向けの案内
 * （{@link CredentialsUnreadableError}）へ直す版。読む口（`readAllForRead`）と
 * 書く口（`withCredentials`）が同じ案内で止まる——#3819 で `logout --local-only`
 * が読む口を通らなくなっても、権限エラーの案内は変わらない。
 */
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

/** ファイル名に使える形の、いまの時刻（ISO 8601 の `:` と `.` を `-` に置き換える）。 */
function filenameSafeIsoNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 壊れて読めない資格ファイルを、黙って上書きしない。`credentials.json.
 * unreadable-<ISO時刻>` へ `rename` して退避する——`rename` は中身もモードも
 * 動かさない。stderr にはパスだけを1行出す（**中身は出さない**）。
 */
async function quarantineUnreadable(): Promise<string> {
  const path = credentialsPath();
  const dest = `${path}.unreadable-${filenameSafeIsoNow()}`;
  await rename(path, dest);
  stderr.write(`alteroid: 読めない資格ファイルを退避しました: ${dest}\n`);
  return dest;
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
  onQuarantined?: (dest: string) => void,
): Promise<T> {
  return withPathLock(credentialsPath(), async () => {
    const current = await readAllStrictOrExplain();
    const quarantined = !current.ok;
    if (quarantined) {
      // 退避は呼び手がコールバックを持つかに関わらず必ず行う。
      const dest = await quarantineUnreadable();
      onQuarantined?.(dest);
    }
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

/**
 * `onQuarantined` は、壊れたファイルを退避したときだけ、退避先のパスを受けて
 * 呼ばれる（#3819。呼び手が「ほかの接続先も空になった」と言うため）。
 */
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
