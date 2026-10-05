import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * 入力の誤りを、利用者が打ったオプション名・引数名と、次の一手で言うための部品（#2867）。
 *
 * API の欄名（`rotateOn` / `windowHours`）や Node の素の `ENOENT: ...`、シェルの
 * 「vi が異常終了しました (127)」をそのまま出さない。終了コードは変えない（投げた
 * `Error` は `index.ts` の `parseAsync(...).catch(...)` が非0で終える）。
 */

/**
 * 利用者が指したファイルを読む。読めなければ、何が読めないかと次の手を日本語で言う。
 *
 * @param flag 利用者が打った名前（`--file` / `<file>` など）
 * @param how 渡し直すときの案内（例: `--file <path>、または標準入力（-）`）
 */
export async function readInputFile(path: string, flag: string, how: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'そのファイルは無い'
        : code === 'EISDIR'
          ? 'ディレクトリであってファイルではない'
          : code === 'EACCES' || code === 'EPERM'
            ? '読む権限が無い'
            : '読めなかった';
    throw new Error(`${flag} で指したファイルを読めない（${path}: ${reason}）。${how}で渡し直す`, {
      cause: error,
    });
  }
}

/**
 * `$EDITOR` の起動・終了の失敗を、日本語の次の一手にする。
 *
 * @param alternative エディタを使わずに同じことをする打ち方
 */
export function describeEditorFailure(
  editor: string,
  result: { code: number | null; signal?: NodeJS.Signals | null } | { error: Error },
  alternative: string,
): Error {
  const setup = '環境変数 VISUAL か EDITOR に、使うエディタのコマンドを設定する';
  if ('error' in result || ('code' in result && result.code === 127)) {
    return new Error(
      `エディタ「${editor}」を起動できない（見つからない）。${setup}か、エディタを使わずに ${alternative} で渡す`,
    );
  }
  if (result.code === null) {
    return new Error(
      `エディタ「${editor}」が途中で打ち切られた（${result.signal ?? 'シグナル'}）。反映していない`,
    );
  }
  return new Error(
    `エディタ「${editor}」が終了コード ${String(result.code)} で終わったので、反映していない。` +
      `使うエディタは ${setup}。エディタを使わないなら ${alternative}`,
  );
}

/**
 * `$VISUAL` / `$EDITOR`（無ければ `vi`）でファイルを開き、閉じるまで待つ。
 *
 * **起こす前に、エディタのコマンドが在るかを見る。** `shell: true` で起こすので、
 * 無いエディタを起こすとシェル自身の `/bin/sh: 1: vi: not found` が stderr に
 * 先に出て、こちらの案内より前に読まれる（#2867 の残り）。在ると言い切れない形
 * （シェルの構文を含む・Windows）は確かめずに起こし、127 を同じ案内で言う。
 *
 * @param alternative エディタを使わずに同じことをする打ち方
 */
export async function openEditor(path: string, alternative: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  if ((await editorCommandExists(editor)) === false) {
    throw describeEditorFailure(editor, { code: 127 }, alternative);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', (error) => reject(describeEditorFailure(editor, { error }, alternative)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(describeEditorFailure(editor, { code, signal }, alternative));
    });
  });
}

/**
 * エディタの指定の先頭の語が、実行できるファイルとして在るか。
 *
 * @returns 在れば true、無ければ false、確かめられない形なら undefined
 */
export async function editorCommandExists(
  editor: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | undefined> {
  if (platform === 'win32') return undefined;
  const pathEnv = env.PATH;
  const command = editor.trim().split(/\s+/)[0] ?? '';
  // 引用符・変数・代入（`FOO=1 vim`）などシェルが解く形は、ここで解き直さない
  if (command === '' || /[^\w./+@%,:-]/.test(command) || command.includes('=')) return undefined;
  // PATH が無いときにシェルが引く既定の道は、ここでは分からない
  if (!command.includes('/') && pathEnv === undefined) return undefined;
  const candidates = command.includes('/')
    ? [command]
    : (pathEnv ?? '')
        .split(delimiter)
        // 空の要素はシェルと同じく今のディレクトリとして読む
        .map((dir) => join(dir === '' ? '.' : dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // 次の候補へ
    }
  }
  return false;
}
