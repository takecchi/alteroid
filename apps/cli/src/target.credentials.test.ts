import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { readCredential, writeCredential } from './credentials.js';
import { resolveTarget } from './target.js';

/**
 * issue #2447 の歯。資格ファイルの「無い」「読めない（権限）」「壊れている」を、
 * `resolveTarget`（remote の経路）が区別して言うこと。
 *
 * `credentials.js` は差し替えない——一時ディレクトリの偽のファイルを本物の
 * `readCredential` が読む。`ALTEROID_HOME` を一時ディレクトリへ向ける
 * （`stateDir()` はここを読む）。トークンの値はすべて偽物。
 */

const REMOTE = 'https://remote.example.com';
const ENV = { ALTEROID_URL: REMOTE };
const FAKE_TOKEN = 'fake-secret-token-must-not-appear-9f3a';

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await makeTempDir('alteroid-cli-target-credentials-test-');
  originalHome = process.env.ALTEROID_HOME;
  process.env.ALTEROID_HOME = home;
  await mkdir(join(home, 'state'), { recursive: true });
});

afterEach(async () => {
  // 権限を戻しておく（一時ディレクトリの後始末のため）。
  await chmod(credentialsPath(), 0o600).catch(() => undefined);
  if (originalHome === undefined) delete process.env.ALTEROID_HOME;
  else process.env.ALTEROID_HOME = originalHome;
});

function credentialsPath(): string {
  return join(home, 'state', 'credentials.json');
}

describe('resolveTarget（remote）: 資格ファイルの読み取り（#2447）', () => {
  it('ファイルが無い（ENOENT）ときだけ「ログインしていません」と言う', async () => {
    const target = await resolveTarget(ENV);

    expect(target.note).toContain('ログインしていません');
    expect(target.headers).toEqual({});
  });

  it('読めたときは今までどおり Bearer を付け、note は無い（対照）', async () => {
    await writeCredential(REMOTE, {
      token: FAKE_TOKEN,
      accountId: 'acc-1',
      label: 'L',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const target = await resolveTarget(ENV);

    expect(target.note).toBeNull();
    expect(target.headers).toEqual({ authorization: `Bearer ${FAKE_TOKEN}` });
  });

  it('権限エラー（EACCES）は「ログインしていません」と言わず、code とパスと次の手を言う', async () => {
    await writeFile(credentialsPath(), JSON.stringify({ [REMOTE]: { token: FAKE_TOKEN } }), {
      mode: 0o600,
    });
    await chmod(credentialsPath(), 0o000);

    const target = await resolveTarget(ENV);

    expect(target.note).not.toBeNull();
    expect(target.note).not.toContain('ログインしていません（alteroid login）');
    expect(target.note).toContain('EACCES');
    expect(target.note).toContain(credentialsPath());
    expect(target.note).toContain('権限');
    expect(target.note).not.toContain(FAKE_TOKEN);
    expect(target.headers).toEqual({});
  });

  it('JSON の壊れは「ログインしていません」と言わず、中身（偽のトークン）を出さない', async () => {
    // 壊れているが、トークンの断片を含む。JSON.parse の例外文は入力の断片を
    // 載せることがある——それを文へ写していないこと。
    const broken = `{"${REMOTE}":{"token":"${FAKE_TOKEN}"`;
    await writeFile(credentialsPath(), broken, { mode: 0o600 });

    const target = await resolveTarget(ENV);

    expect(target.note).not.toBeNull();
    expect(target.note).not.toContain('ログインしていません（alteroid login）');
    expect(target.note).toContain('壊れて');
    expect(target.note).toContain(credentialsPath());
    expect(target.note).not.toContain(FAKE_TOKEN);
    expect(target.note).not.toContain('token');
    expect(target.headers).toEqual({});
    // 読むだけの口は、ファイルを動かさない。
    expect(await readFile(credentialsPath(), 'utf8')).toBe(broken);
  });

  it('トップレベルがオブジェクトでない JSON も「壊れ」であって「無い」ではない', async () => {
    await writeFile(credentialsPath(), '"just a string"', { mode: 0o600 });

    const target = await resolveTarget(ENV);

    expect(target.note).toContain('壊れて');
    expect(target.note).not.toContain('ログインしていません（alteroid login）');
  });

  it('readCredential は、壊れ・権限エラーでは null ではなく投げる', async () => {
    await writeFile(credentialsPath(), '{ broken', { mode: 0o600 });
    await expect(readCredential(REMOTE)).rejects.toThrow('壊れて');

    await chmod(credentialsPath(), 0o000);
    await expect(readCredential(REMOTE)).rejects.toThrow('EACCES');
  });
});
