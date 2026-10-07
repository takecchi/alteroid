import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

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

// 引用符で包む: `shell: true` は引数を引用符なしで連結するので、パスに空白・記号が入るとエディタが別のファイルを開くため
export function quoteForShell(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${path}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

// 起こす前にコマンドの有無を見る: 無いエディタを起こすとシェル自身の `not found` が先に stderr に出るため
export async function openEditor(path: string, alternative: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  if ((await editorCommandExists(editor)) === false) {
    throw describeEditorFailure(editor, { code: 127 }, alternative);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [quoteForShell(path)], { stdio: 'inherit', shell: true });
    child.on('error', (error) => reject(describeEditorFailure(editor, { error }, alternative)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(describeEditorFailure(editor, { code, signal }, alternative));
    });
  });
}

export async function editorCommandExists(
  editor: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | undefined> {
  if (platform === 'win32') return undefined;
  const pathEnv = env.PATH;
  const command = editor.trim().split(/\s+/)[0] ?? '';
  if (command === '' || /[^\w./+@%,:-]/.test(command) || command.includes('=')) return undefined;
  if (!command.includes('/') && pathEnv === undefined) return undefined;
  const candidates = command.includes('/')
    ? [command]
    : (pathEnv ?? '')
        .split(delimiter)
        // 空の要素は今のディレクトリとして読む: シェルと同じ解釈にするため
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

// 失敗したら一時ファイルを消さずに残す: 保存の失敗で人間が書いた内容を失わせないため
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
