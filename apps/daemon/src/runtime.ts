import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `~/.alteroid/state/daemon.json`。CLI が接続先と生死を知るためだけの情報。
 *
 * `token` は起動ごとに作り直す本人確認用の値。**⚠️ 訂正: `/health` はこの値を
 * 返さない**（このコメントは長らく「同じものが返る」と書いていたが、実装済みの
 * 挙動と食い違っていた——`healthResponseSchema.operator` は真偽値だけを返す。
 * 返さなくなったのは 2026-08-13、#26、`cd8bb73`「ログインと、使う許可を人間が
 * 与える仕組みを入れる」で、この値が `access grant` を実行できる資格そのものに
 * なったため（`apps/daemon/src/openapi.ts` の `healthResponseSchema.operator` の
 * doc）。CLI は「自分の持っているトークンを提示して `operator: true` が返るか」
 * で本人確認する——PID の再利用検知としても同じ強さがある）。
 * PID だけを信じると、デーモンが異常終了してファイルが残った後に OS が同じ PID を
 * 別プロセスへ割り当てたとき、`alteroid daemon stop` が無関係なプロセスを殺しうる。
 */
export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
}

export function runtimeFilePath(stateDir: string): string {
  return join(stateDir, 'daemon.json');
}

/**
 * **`token` は operator の資格そのもの**（提示できれば `requireOperator` /
 * `requireOwner` の両方を無条件に通す。`auth.ts` の `isOperator` の doc）。
 * `~/.alteroid/state/credentials.json`（`apps/cli/src/credentials.ts`）と
 * 同格かそれ以上に守るべき秘密なので、あちらと同じ形でパーミッションを絞る
 * （issue #1871）。**あちらは issue #1992 以降 `@alteroid/storage-fs` の
 * `writeFileAtomic` を経由するようになったが、tmp へ 0600 で書いてから
 * `rename` する形そのものは変わっていない**——同じ理由がここにも要る。
 *
 * **`writeFile` の `mode` オプションだけでは足りない。** POSIX の `open()` は
 * 新規作成のときだけ `mode` を適用し、既に在るファイルには適用しない——
 * 過去の版（この直し以前）が作った group/other から読める `daemon.json` を
 * 次の起動が書き直しても、`mode` 指定だけではパーミッションが変わらずに
 * 残ってしまう。
 *
 * **既存ファイルを直接 `writeFile` で上書きしてから `chmod` する形も採らない。**
 * その2手の間に、`token` を含む新しい中身が書き上がっているのに古い（緩い）
 * パーミッションのままの窓ができる——`writeFile` は `O_TRUNC` で既存ファイルの
 * 中身を新しい JSON に置き換えるが、ファイル自体のモードは変えないので、直後の
 * `chmod` が効くまでの間、group/other から読める状態で新しい token が乗る。
 * `credentials.ts` の書き込みが一時ファイル＋`rename` にしているのと同じ
 * 理由で、ここも一時ファイルへ 0600 で書いてから `rename` する——`rename` は
 * 同じディレクトリ内なら、参照を古い内容から新しい内容へ一手で切り替えるので、
 * 緩いパーミッションのまま新しい token が見える窓が無い。
 *
 * `stateDir` 自体は 0700 にはしない——`credentials.json` も含め他のファイルが
 * 同じディレクトリに並ぶ場所で、ディレクトリの権限を個別のファイル1つの
 * 都合で絞ると影響がここより広がる。守るのはファイル単位に留める
 * （`credentials.ts` の書き込みも同様に `stateDir` 自体は絞っていない）。
 */
export async function writeRuntimeInfo(stateDir: string, info: DaemonRuntimeInfo): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = runtimeFilePath(stateDir);
  const tmp = `${path}.tmp`;
  // 一時ファイルの時点で 0600。rename 後に絞ると、その隙間で他人が読める。
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function clearRuntimeInfo(stateDir: string): Promise<void> {
  await rm(runtimeFilePath(stateDir), { force: true });
}

export async function readRuntimeInfo(stateDir: string): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFilePath(stateDir), 'utf8');
    return parseRuntimeInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseRuntimeInfo(value: unknown): DaemonRuntimeInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<DaemonRuntimeInfo>;
  if (typeof candidate.pid !== 'number' || typeof candidate.port !== 'number') return null;
  // token を持たない古い状態ファイルは本人確認できないので stale として扱う
  if (typeof candidate.token !== 'string' || candidate.token.length === 0) return null;
  return {
    pid: candidate.pid,
    port: candidate.port,
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
    token: candidate.token,
  };
}
