import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { writeCredential } from './credentials.js';
import { remoteTarget, resolveTarget } from './target.js';
import {
  readTokenFile,
  TOKEN_FILE_ENV,
  TOKEN_FILE_MAX_BYTES,
  TokenFileError,
} from './token-file.js';

const REMOTE = 'https://remote.example.com';
// ダミー。どこの資格でもない
const FILE_TOKEN = 'dummy-file-token-must-not-leak-71aa';
const CRED_TOKEN = 'dummy-credentials-token-must-not-leak-02bb';

let dir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-cli-token-file-test-');
  originalHome = process.env.ALTEROID_HOME;
  process.env.ALTEROID_HOME = join(dir, 'home');
  await mkdir(join(dir, 'home', 'state'), { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ALTEROID_HOME;
  else process.env.ALTEROID_HOME = originalHome;
});

async function tokenFile(content: string, mode = 0o600, name = 'token'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

async function errorOf(promise: Promise<unknown>): Promise<TokenFileError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TokenFileError);
    return error as TokenFileError;
  }
  throw new Error('reject するはずが resolve した');
}

describe('readTokenFile', () => {
  it('0600 のファイルは読め、前後の空白と改行を除く', async () => {
    expect(await readTokenFile(await tokenFile(`  ${FILE_TOKEN}\r\n\n`))).toBe(FILE_TOKEN);
  });

  it('symlink は辿り、辿った先が通常のファイルなら読める', async () => {
    const real = await tokenFile(`${FILE_TOKEN}\n`, 0o600, 'real');
    const link = join(dir, 'link');
    await symlink(real, link);
    expect(await readTokenFile(link)).toBe(FILE_TOKEN);
  });

  it('symlink の先が通常のファイルでなければ断る', async () => {
    const link = join(dir, 'dirlink');
    await symlink(dir, link);
    const error = await errorOf(readTokenFile(link));
    expect(error.message).toContain(link);
  });

  it.each([0o644, 0o640, 0o604, 0o660])(
    '所有者以外に許可がある mode %o は断り、chmod 600 を案内し、値を出さない',
    async (mode) => {
      const path = await tokenFile(`${FILE_TOKEN}\n`, mode);
      const error = await errorOf(readTokenFile(path));
      expect(error.message).toContain('chmod 600');
      expect(error.message).toContain(path);
      expect(error.message).not.toContain(FILE_TOKEN);
    },
  );

  it('空・空白だけは断る', async () => {
    expect((await errorOf(readTokenFile(await tokenFile('')))).message).toContain('空');
    expect((await errorOf(readTokenFile(await tokenFile(' \n\n', 0o600, 't2')))).message).toContain(
      '空',
    );
  });

  it('複数行は断り、値を出さない', async () => {
    const error = await errorOf(readTokenFile(await tokenFile(`${FILE_TOKEN}\nsecond-line\n`)));
    expect(error.message).toContain('複数行');
    expect(error.message).not.toContain(FILE_TOKEN);
  });

  it('大きすぎるファイルは断る', async () => {
    const path = await tokenFile('a'.repeat(TOKEN_FILE_MAX_BYTES + 1));
    expect((await errorOf(readTokenFile(path))).message).toContain('大きすぎ');
  });

  it('ヘッダに載せられない文字を含むものは、値を出さずに断る', async () => {
    const error = await errorOf(readTokenFile(await tokenFile(`${FILE_TOKEN} と空白`)));
    expect(error.message).not.toContain(FILE_TOKEN);
  });

  it('存在しないパスは、パスと理由だけを言う', async () => {
    const path = join(dir, 'nope');
    const error = await errorOf(readTokenFile(path));
    expect(error.message).toContain(path);
    expect(error.message).toContain('ありません');
  });

  it('ディレクトリは断る', async () => {
    expect((await errorOf(readTokenFile(dir))).message).toContain('通常のファイルではありません');
  });
});

describe('remoteTarget の資格の優先順位（--token-file > ALTEROID_TOKEN_FILE > credentials.json）', () => {
  beforeEach(async () => {
    await writeCredential(REMOTE, {
      token: CRED_TOKEN,
      accountId: 'acc-1',
      label: 'L',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('どちらも無ければ credentials.json（従来どおり）', async () => {
    const target = await remoteTarget(REMOTE, { env: {} });
    expect(target.headers).toEqual({ authorization: `Bearer ${CRED_TOKEN}` });
  });

  it('ALTEROID_TOKEN_FILE は credentials.json より優先し、credentials.json を読まない', async () => {
    const path = await tokenFile(`${FILE_TOKEN}\n`);
    const target = await remoteTarget(REMOTE, { env: { [TOKEN_FILE_ENV]: path } });
    expect(target.note).toBeNull();
    expect(target.headers).toEqual({ authorization: `Bearer ${FILE_TOKEN}` });
  });

  it('--token-file は ALTEROID_TOKEN_FILE より優先する', async () => {
    const fromFlag = await tokenFile('dummy-flag-token-aaaa\n', 0o600, 'flag');
    const fromEnv = await tokenFile('dummy-env-token-bbbb\n', 0o600, 'env');
    const target = await remoteTarget(REMOTE, {
      tokenFile: fromFlag,
      env: { [TOKEN_FILE_ENV]: fromEnv },
    });
    expect(target.headers).toEqual({ authorization: 'Bearer dummy-flag-token-aaaa' });
  });

  it('トークンファイルを使うときは credentials.json を読まない（壊れていても影響しない）', async () => {
    await writeFile(join(process.env.ALTEROID_HOME ?? '', 'state', 'credentials.json'), '{壊れた');
    const path = await tokenFile(`${FILE_TOKEN}\n`);
    const target = await remoteTarget(REMOTE, { tokenFile: path, env: {} });
    expect(target.note).toBeNull();
    expect(target.headers).toEqual({ authorization: `Bearer ${FILE_TOKEN}` });
  });

  it('指定したのに読めないときは、credentials.json へ落ちずに理由を言う（値を出さない）', async () => {
    const path = await tokenFile(`${FILE_TOKEN}\n`, 0o644);
    const target = await remoteTarget(REMOTE, { tokenFile: path, env: {} });
    expect(target.headers).toEqual({});
    expect(target.note).toContain(path);
    expect(target.note).toContain('chmod 600');
    expect(JSON.stringify(target)).not.toContain(CRED_TOKEN);
    expect(JSON.stringify(target)).not.toContain(FILE_TOKEN);
  });

  it('ALTEROID_TOKEN_FILE のパスが存在しないときも credentials.json へ落ちない', async () => {
    const target = await remoteTarget(REMOTE, { env: { [TOKEN_FILE_ENV]: join(dir, 'nope') } });
    expect(target.headers).toEqual({});
    expect(target.note).toContain('ありません');
  });

  it('resolveTarget も ALTEROID_TOKEN_FILE を使う（usage --json / diagnostics export がリモートで使える）', async () => {
    const path = await tokenFile(`${FILE_TOKEN}\n`);
    const target = await resolveTarget({ ALTEROID_URL: REMOTE, [TOKEN_FILE_ENV]: path });
    expect(target.remote).toBe(true);
    expect(target.headers).toEqual({ authorization: `Bearer ${FILE_TOKEN}` });
  });
});
