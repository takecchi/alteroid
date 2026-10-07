import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createPluginFetcher, PluginFetchError } from './plugin-fetch.js';

/**
 * ネットワークを使わない。ローカルの bare リポジトリを `git init` で作り、`file://` で取る
 * （本番の許可は https だけなので、テストだけが `allowedProtocols: 'file'` を渡す）。
 */

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

interface Entry {
  path: string;
  text?: string;
  executable?: boolean;
  symlinkTo?: string;
}

/** 作業ツリーに書いて commit し、bare へ push する。bare の file:// URL と commit SHA を返す。 */
async function makeRepo(
  entries: Entry[],
): Promise<{ url: string; sha: string; work: string; bare: string }> {
  const root = await makeTempDir('alteroid-fetch-repo-');
  const work = join(root, 'work');
  const bare = join(root, 'bare.git');
  await mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  await commitEntries(work, entries, 'first');
  git(root, 'clone', '-q', '--bare', work, bare);
  return { url: pathToFileURL(bare).href, sha: git(work, 'rev-parse', 'HEAD'), work, bare };
}

async function commitEntries(work: string, entries: Entry[], message: string): Promise<string> {
  for (const entry of entries) {
    const target = join(work, entry.path);
    await mkdir(dirname(target), { recursive: true });
    if (entry.symlinkTo !== undefined) {
      await symlink(entry.symlinkTo, target);
    } else {
      await writeFile(target, entry.text ?? '');
      if (entry.executable === true) await chmod(target, 0o755);
    }
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

const MANIFEST = JSON.stringify({ name: 'demo', version: '1.2.3', description: 'デモ plugin' });

const BASIC: Entry[] = [
  { path: '.claude-plugin/plugin.json', text: MANIFEST },
  { path: 'skills/hello/SKILL.md', text: '---\nname: hello\n---\nこんにちは\n' },
  { path: 'bin/run.sh', text: '#!/bin/sh\n', executable: true },
];

const fetcher = (extra: Record<string, unknown> = {}) =>
  createPluginFetcher({ allowedProtocols: 'file', ...extra });

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('createPluginFetcher: 任意の URL', () => {
  it('SHA を指定して取り、files・名前・取り元を返す（実行ビットも残る）', async () => {
    const repo = await makeRepo(BASIC);
    const got = await fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha });
    expect(got.name).toBe('demo');
    expect(got.description).toBe('デモ plugin');
    expect(got.source).toEqual({ kind: 'url', url: repo.url, sha: repo.sha, version: '1.2.3' });
    const byPath = new Map(got.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      '.claude-plugin/plugin.json',
      'bin/run.sh',
      'skills/hello/SKILL.md',
    ]);
    expect(byPath.get('bin/run.sh')?.executable).toBe(true);
    expect(byPath.get('skills/hello/SKILL.md')?.executable).toBe(false);
    expect(textOf(byPath.get('skills/hello/SKILL.md')?.content ?? new Uint8Array())).toContain(
      'こんにちは',
    );
  });

  it('SHA を省くと HEAD を一度だけ SHA に解決して固定する', async () => {
    const repo = await makeRepo(BASIC);
    const got = await fetcher().fetch({ kind: 'url', url: repo.url });
    expect(got.source.sha).toBe(repo.sha);
    expect(got.source.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ブランチ名・タグ名（ref）を SHA に解決する。解決後に動いても固定したまま', async () => {
    const repo = await makeRepo(BASIC);
    git(repo.work, 'tag', 'v1');
    git(repo.work, 'push', '-q', repo.bare, 'v1');
    const second = await commitEntries(
      repo.work,
      [{ path: 'skills/hello/SKILL.md', text: '二版\n' }],
      'second',
    );
    git(repo.work, 'push', '-q', repo.bare, 'main');

    const viaTag = await fetcher().fetch({ kind: 'url', url: repo.url, ref: 'v1' });
    expect(viaTag.source.sha).toBe(repo.sha);
    const viaBranch = await fetcher().fetch({ kind: 'url', url: repo.url, ref: 'main' });
    expect(viaBranch.source.sha).toBe(second);
    expect(
      textOf(
        viaTag.files.find((f) => f.path === 'skills/hello/SKILL.md')?.content ?? new Uint8Array(),
      ),
    ).toContain('こんにちは');
  });

  it('SHA 指定なら、後から HEAD が進んでも指定の版を取る', async () => {
    const repo = await makeRepo(BASIC);
    await commitEntries(repo.work, [{ path: 'extra.txt', text: 'x' }], 'second');
    git(repo.work, 'push', '-q', repo.bare, 'main');
    const got = await fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha });
    expect(got.files.map((f) => f.path)).not.toContain('extra.txt');
  });

  it('path でリポジトリ内の plugin の場所を指す。files はその下の相対 path', async () => {
    const repo = await makeRepo([
      { path: 'README.md', text: 'root' },
      { path: 'plugins/inner/.claude-plugin/plugin.json', text: JSON.stringify({ name: 'inner' }) },
      { path: 'plugins/inner/skills/a/SKILL.md', text: 'a' },
    ]);
    const got = await fetcher().fetch({ kind: 'url', url: repo.url, path: 'plugins/inner' });
    expect(got.name).toBe('inner');
    expect(got.source).toMatchObject({ kind: 'url', path: 'plugins/inner', sha: repo.sha });
    expect(got.files.map((f) => f.path).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'skills/a/SKILL.md',
    ]);
  });

  it('manifest に name が無ければ path の末尾（無ければリポジトリ名）を名前にする', async () => {
    const repo = await makeRepo([{ path: 'plugins/solo/skills/a/SKILL.md', text: 'a' }]);
    const got = await fetcher().fetch({ kind: 'url', url: repo.url, path: 'plugins/solo' });
    expect(got.name).toBe('solo');
  });

  it('symlink は辿らず、含めない。取らなかったものを skipped に出す', async () => {
    const repo = await makeRepo([
      ...BASIC,
      { path: 'skills/link.md', symlinkTo: '/etc/passwd' },
      { path: 'skills/dirlink', symlinkTo: '../bin' },
    ]);
    const got = await fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha });
    expect(got.files.map((f) => f.path)).not.toContain('skills/link.md');
    expect(got.files.some((f) => f.path.startsWith('skills/dirlink'))).toBe(false);
    expect(got.skipped).toEqual(
      expect.arrayContaining([
        { path: 'skills/dirlink', reason: 'symlink' },
        { path: 'skills/link.md', reason: 'symlink' },
      ]),
    );
  });

  it('path が symlink 経由でも辿らず、拒む', async () => {
    const repo = await makeRepo([...BASIC, { path: 'alias', symlinkTo: 'skills' }]);
    await expect(
      fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha, path: 'alias' }),
    ).rejects.toMatchObject({ name: 'PluginFetchError', kind: 'invalid' });
  });

  it('存在しない path・存在しない SHA・存在しない ref は拒む', async () => {
    const repo = await makeRepo(BASIC);
    await expect(
      fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha, path: 'nope' }),
    ).rejects.toBeInstanceOf(PluginFetchError);
    await expect(
      fetcher().fetch({ kind: 'url', url: repo.url, sha: 'f'.repeat(40) }),
    ).rejects.toBeInstanceOf(PluginFetchError);
    await expect(
      fetcher().fetch({ kind: 'url', url: repo.url, ref: 'no-such-branch' }),
    ).rejects.toBeInstanceOf(PluginFetchError);
  });

  it('不正な path（..・絶対）は git を呼ぶ前に拒む', async () => {
    const repo = await makeRepo(BASIC);
    for (const path of ['../x', '/etc', 'a//b', 'a/./b']) {
      await expect(
        fetcher().fetch({ kind: 'url', url: repo.url, sha: repo.sha, path }),
      ).rejects.toMatchObject({ kind: 'invalid' });
    }
  });

  it('既定の許可は https だけ。file:// は取らない', async () => {
    const repo = await makeRepo(BASIC);
    await expect(
      createPluginFetcher({}).fetch({ kind: 'url', url: repo.url, sha: repo.sha }),
    ).rejects.toBeInstanceOf(PluginFetchError);
  });

  it('PLUGIN_LIMITS を超えたら拒む（ファイル数・1ファイル・合計）', async () => {
    const repo = await makeRepo([
      { path: 'a.txt', text: 'a'.repeat(100) },
      { path: 'b.txt', text: 'b'.repeat(100) },
      { path: 'c.txt', text: 'c' },
    ]);
    const base = { kind: 'url' as const, url: repo.url, sha: repo.sha };
    await expect(fetcher({ limits: { maxFiles: 2 } }).fetch(base)).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(fetcher({ limits: { maxFileBytes: 50 } }).fetch(base)).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(fetcher({ limits: { maxTotalBytes: 150 } }).fetch(base)).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(fetcher().fetch(base)).resolves.toMatchObject({ files: expect.any(Array) });
  });

  it('時間の上限を超えたら打ち切る', async () => {
    const dir = await makeTempDir('alteroid-fetch-slow-');
    const slow = join(dir, 'slow-git');
    await writeFile(slow, '#!/bin/sh\nexec sleep 30\n');
    await chmod(slow, 0o755);
    const repo = await makeRepo(BASIC);
    const started = Date.now();
    await expect(
      fetcher({ gitPath: slow, timeoutMs: 300 }).fetch({
        kind: 'url',
        url: repo.url,
        sha: repo.sha,
      }),
    ).rejects.toMatchObject({ name: 'PluginFetchError', kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('取得物のサイズが上限を超えたら打ち切る', async () => {
    const repo = await makeRepo([{ path: 'big.bin', text: randomBytes(100_000).toString('hex') }]);
    await expect(
      fetcher({ maxFetchBytes: 1000 }).fetch({ kind: 'url', url: repo.url, sha: repo.sha }),
    ).rejects.toBeInstanceOf(PluginFetchError);
  });
});

describe('createPluginFetcher: marketplace', () => {
  async function marketplace(plugins: unknown[], extra: Entry[] = []) {
    return makeRepo([
      { path: '.claude-plugin/marketplace.json', text: JSON.stringify({ name: 'm', plugins }) },
      ...extra,
    ]);
  }

  it('索引から、同じリポジトリの相対 path の plugin を解決する', async () => {
    const repo = await marketplace(
      [{ name: 'local-one', description: '索引の説明', source: './plugins/local-one' }],
      [
        {
          path: 'plugins/local-one/.claude-plugin/plugin.json',
          text: JSON.stringify({ name: 'local-one', version: '0.1.0' }),
        },
        { path: 'plugins/local-one/skills/x/SKILL.md', text: 'x' },
      ],
    );
    const got = await fetcher({ marketplaceUrl: repo.url }).fetch({
      kind: 'marketplace',
      plugin: 'local-one',
    });
    expect(got.name).toBe('local-one');
    expect(got.source).toEqual({
      kind: 'marketplace',
      marketplace: 'claude-plugins-official',
      plugin: 'local-one',
      url: repo.url,
      path: 'plugins/local-one',
      sha: repo.sha,
      version: '0.1.0',
    });
  });

  it('索引が別リポジトリ（url + sha）を指すときは、その実体の URL・SHA を固定する', async () => {
    const target = await makeRepo(BASIC);
    const repo = await marketplace([
      { name: 'remote-one', source: { source: 'url', url: target.url, sha: target.sha } },
    ]);
    const got = await fetcher({ marketplaceUrl: repo.url }).fetch({
      kind: 'marketplace',
      plugin: 'remote-one',
    });
    expect(got.source).toMatchObject({
      kind: 'marketplace',
      plugin: 'remote-one',
      url: target.url,
      sha: target.sha,
    });
    expect(got.files.map((f) => f.path)).toContain('skills/hello/SKILL.md');
  });

  it('git-subdir（url + path）と、sha が無いときの ref の解決', async () => {
    const target = await makeRepo([
      { path: 'sub/.claude-plugin/plugin.json', text: JSON.stringify({ name: 'sub-one' }) },
      { path: 'sub/skills/a/SKILL.md', text: 'a' },
    ]);
    const repo = await marketplace([
      { name: 'sub-one', source: { source: 'git-subdir', url: target.url, path: 'sub' } },
    ]);
    const got = await fetcher({ marketplaceUrl: repo.url }).fetch({
      kind: 'marketplace',
      plugin: 'sub-one',
    });
    expect(got.source).toMatchObject({ url: target.url, path: 'sub', sha: target.sha });
  });

  it('実物の索引の形（metadata なし・owner あり・3種類の source が混在）を3種類とも解決する', async () => {
    const urlTarget = await makeRepo(BASIC);
    const subTarget = await makeRepo([
      { path: 'plugins/deep/.claude-plugin/plugin.json', text: JSON.stringify({ name: 'deep' }) },
      { path: 'plugins/deep/skills/a/SKILL.md', text: 'a' },
    ]);
    const repo = await makeRepo([
      {
        path: '.claude-plugin/marketplace.json',
        text: JSON.stringify({
          name: 'claude-plugins-official',
          owner: { name: 'Anthropic', email: 'support@anthropic.com' },
          plugins: [
            { name: 'by-path', description: 'd', source: './plugins/by-path', category: 'x' },
            {
              name: 'by-url',
              description: 'd',
              source: { source: 'url', url: urlTarget.url, sha: urlTarget.sha },
              homepage: 'https://example.invalid',
            },
            {
              name: 'by-subdir',
              description: 'd',
              source: {
                source: 'git-subdir',
                url: subTarget.url,
                path: 'plugins/deep',
                ref: 'main',
                sha: subTarget.sha,
              },
            },
          ],
        }),
      },
      {
        path: 'plugins/by-path/.claude-plugin/plugin.json',
        text: JSON.stringify({ name: 'by-path' }),
      },
      { path: 'plugins/by-path/skills/a/SKILL.md', text: 'a' },
    ]);
    const f = fetcher({ marketplaceUrl: repo.url });

    const byPath = await f.fetch({ kind: 'marketplace', plugin: 'by-path' });
    expect(byPath.source).toMatchObject({ url: repo.url, path: 'plugins/by-path', sha: repo.sha });

    const byUrl = await f.fetch({ kind: 'marketplace', plugin: 'by-url' });
    expect(byUrl.source).toMatchObject({ url: urlTarget.url, sha: urlTarget.sha });
    expect(byUrl.source).not.toHaveProperty('path');

    const bySubdir = await f.fetch({ kind: 'marketplace', plugin: 'by-subdir' });
    expect(bySubdir.name).toBe('by-subdir');
    expect(bySubdir.source).toMatchObject({
      url: subTarget.url,
      path: 'plugins/deep',
      sha: subTarget.sha,
    });
    expect(bySubdir.files.map((x) => x.path)).toContain('skills/a/SKILL.md');
  });

  it('marketplace の URL が未設定なら unconfigured', async () => {
    await expect(
      createPluginFetcher({}).fetch({ kind: 'marketplace', plugin: 'x' }),
    ).rejects.toMatchObject({ name: 'PluginFetchError', kind: 'unconfigured' });
  });

  it('索引に無い名前・読めない形の source は拒む', async () => {
    const repo = await marketplace([{ name: 'weird', source: { source: 'npm', package: 'x' } }]);
    const f = fetcher({ marketplaceUrl: repo.url });
    await expect(f.fetch({ kind: 'marketplace', plugin: 'absent' })).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(f.fetch({ kind: 'marketplace', plugin: 'weird' })).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('索引の相対 path が .. を含むなら拒む', async () => {
    const repo = await marketplace([{ name: 'esc', source: './../outside' }]);
    await expect(
      fetcher({ marketplaceUrl: repo.url }).fetch({ kind: 'marketplace', plugin: 'esc' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});
