import { open } from 'node:fs/promises';

// 環境変数で渡せるのはパスだけ: 値を環境変数で渡すと `ps` や子プロセスへ漏れるため
export const TOKEN_FILE_ENV = 'ALTEROID_TOKEN_FILE';

// アクセストークンは数百字。これを超えるのは別のファイルを指している（誤指定）と読む
export const TOKEN_FILE_MAX_BYTES = 4096;

// message に載せるのはパスと理由だけ。トークンの値・値の断片・読み込みの例外文は載せない
export class TokenFileError extends Error {
  constructor(path: string, reason: string) {
    super(`--token-file / ${TOKEN_FILE_ENV} のファイル（${path}）を使えません: ${reason}`);
    this.name = 'TokenFileError';
  }
}

// 秘密鍵ファイルの作法（ssh）: group/other に読み書きの許可があれば断る。mode が意味を持たない Windows では見ない
function hasLooseMode(mode: number): boolean {
  return process.platform !== 'win32' && (mode & 0o077) !== 0;
}

export async function readTokenFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new TokenFileError(
      path,
      code === 'ENOENT'
        ? 'ファイルがありません'
        : `開けません（${typeof code === 'string' ? code : '原因不明'}）`,
    );
  }
  try {
    // open した後の fd で検査する: 検査と読みの間にファイルが差し替わっても、検査したものを読む
    const info = await handle.stat();
    if (!info.isFile()) throw new TokenFileError(path, '通常のファイルではありません');
    if (hasLooseMode(info.mode)) {
      throw new TokenFileError(
        path,
        `所有者以外が読める許可（mode ${(info.mode & 0o777).toString(8).padStart(3, '0')}）が付いています。` +
          `chmod 600 ${path} で絞ってください`,
      );
    }
    if (info.size > TOKEN_FILE_MAX_BYTES) {
      throw new TokenFileError(path, `大きすぎます（${String(TOKEN_FILE_MAX_BYTES)} バイトまで）`);
    }
    const buffer = Buffer.alloc(TOKEN_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > TOKEN_FILE_MAX_BYTES) {
      throw new TokenFileError(path, `大きすぎます（${String(TOKEN_FILE_MAX_BYTES)} バイトまで）`);
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (text === '') throw new TokenFileError(path, '空です');
    if (/[\r\n]/.test(text)) throw new TokenFileError(path, '複数行です（トークンは1行だけ）');
    // ヘッダに載せられない文字は、fetch が値を含む例外を投げうる: 先に理由だけで断る
    if (/[^\x21-\x7e]/.test(text)) {
      throw new TokenFileError(path, '空白・制御文字・ASCII 以外の文字を含みます');
    }
    return text;
  } catch (error) {
    if (error instanceof TokenFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new TokenFileError(path, `読めません（${typeof code === 'string' ? code : '原因不明'}）`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
