import { readFile } from 'node:fs/promises';

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
    throw new Error(`${flag} で指したファイルを読めない（${path}: ${reason}）。${how} で渡し直す`, {
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
