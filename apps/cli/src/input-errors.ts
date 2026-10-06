import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
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

/**
 * `edit` 系（memory / practice / profile / mcp）の「エディタを閉じた後」を走らせる。
 * **失敗したら、人間が書いた内容（一時ファイル）を消さずに残す**（#3453）。
 *
 * 保存の失敗（500・接続切れ・401/403・400）も、JSON の書き損じも、空の本文の断りも、
 * 書いた側から見れば「書いたものが無くなる」理由にならない。**消すのは成功したときと
 * 「変更なし」で戻ったときだけ**。失敗したら、残した場所と続きのやり方を stderr に言い、
 * 元の例外をそのまま投げ直す（終了コードは `index.ts` が非0にする）。
 *
 * 一時ファイルの権限はここでは変えない。呼び出し側が作ったまま（profile / mcp は
 * 秘密が入りうるので 0600）残る。
 *
 * 衝突（409）のように、呼び出し側が自分で残して案内するときは `keep()` を呼ぶ。
 * その場合はここでは案内を足さない。
 *
 * @param dir 一時ディレクトリ（成功・変更なしのときだけ消す）
 * @param path 人間が書いたファイル
 * @param resume 続きのやり方（実在する打ち方。例: `alteroid memory set <slug> --file <path>`）
 */
export async function keepDraftOnFailure(
  dir: string,
  path: string,
  resume: string,
  work: (keep: () => void) => Promise<void>,
): Promise<void> {
  let kept = false;
  try {
    await work(() => {
      kept = true;
    });
  } catch (error) {
    if (!kept) {
      kept = true;
      process.stderr.write(
        [
          `あなたの編集を残してあります: ${path}`,
          `  直したら \`${resume}\` で渡し直せます。いらなければ ${dir} ごと消してください。`,
          '',
        ].join('\n'),
      );
    }
    throw error;
  } finally {
    if (!kept) await rm(dir, { recursive: true, force: true });
  }
}
