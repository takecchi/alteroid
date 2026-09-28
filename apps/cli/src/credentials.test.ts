import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { clearCredential, readCredential, writeCredential } from './credentials.js';

/**
 * issue #1992 の歯。`apps/cli/src/credentials.ts` の書き込みの口
 * （`writeCredential` / `clearCredential`）は「全体を読む → 自分のキーだけ
 * 変える → 全体を書き戻す」で、読んでから書くまでの間に排他が無かった。
 * 同じホストで2つの `alteroid login` が重なると、後から書いた側が相手の
 * 変更を持たない古い全体を書き戻し、先に成功したログインの資格が消える。
 *
 * `ALTEROID_HOME` をテストごとに一意な一時ディレクトリへ差し替える
 * （`stateDir()` はここを読む——`paths.ts`）。値はすべて偽のもの。
 */

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await makeTempDir('alteroid-cli-credentials-test-');
  originalHome = process.env.ALTEROID_HOME;
  process.env.ALTEROID_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ALTEROID_HOME;
  else process.env.ALTEROID_HOME = originalHome;
});

function credentialsPath(): string {
  return join(home, 'state', 'credentials.json');
}

describe('writeCredential の並行呼び出し（#1992）', () => {
  it('Promise.all で2つの接続先へ並行して書いても、両方が読める', async () => {
    await Promise.all([
      writeCredential('http://a.example', {
        token: 'fake-token-a',
        accountId: 'acc-a',
        label: 'A',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      writeCredential('http://b.example', {
        token: 'fake-token-b',
        accountId: 'acc-b',
        label: 'B',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);

    const a = await readCredential('http://a.example');
    const b = await readCredential('http://b.example');
    expect(a?.token).toBe('fake-token-a');
    expect(b?.token).toBe('fake-token-b');
  });

  it('writeCredential と clearCredential を並行しても、対象外の資格は残る', async () => {
    await writeCredential('http://a.example', {
      token: 'fake-token-a',
      accountId: 'acc-a',
      label: 'A',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await writeCredential('http://b.example', {
      token: 'fake-token-b',
      accountId: 'acc-b',
      label: 'B',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await Promise.all([
      clearCredential('http://a.example'),
      writeCredential('http://c.example', {
        token: 'fake-token-c',
        accountId: 'acc-c',
        label: 'C',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);

    expect(await readCredential('http://a.example')).toBeNull();
    expect((await readCredential('http://b.example'))?.token).toBe('fake-token-b');
    expect((await readCredential('http://c.example'))?.token).toBe('fake-token-c');
  });
});

describe('壊れた資格ファイル（#1992）', () => {
  it('writeCredential すると、壊れたファイルは退避され、元の中身のまま残る', async () => {
    const dir = join(home, 'state');
    await mkdir(dir, { recursive: true });
    const broken = 'not valid json {{{';
    await writeFile(credentialsPath(), broken, 'utf8');

    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await writeCredential('http://a.example', {
        token: 'fake-token-a',
        accountId: 'acc-a',
        label: 'A',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const names = await readdir(dir);
    const quarantined = names.filter((name) => name.startsWith('credentials.json.unreadable-'));
    expect(quarantined).toHaveLength(1);

    const quarantinedContent = await readFile(join(dir, quarantined[0] as string), 'utf8');
    expect(quarantinedContent).toBe(broken);

    // stderr にはパスだけが出て、壊れたファイルの中身は出ない。
    const stderrText = chunks.join('');
    expect(stderrText).toContain(quarantined[0] as string);
    expect(stderrText).not.toContain(broken);

    // そのうえで新しいファイルに書かれている。
    const a = await readCredential('http://a.example');
    expect(a?.token).toBe('fake-token-a');
  });
});

describe('資格ファイルのモード（#1992）', () => {
  it('書いたファイルは 0600 である', async () => {
    await writeCredential('http://a.example', {
      token: 'fake-token-a',
      accountId: 'acc-a',
      label: 'A',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const info = await stat(credentialsPath());
    expect(info.mode & 0o777).toBe(0o600);
  });
});
