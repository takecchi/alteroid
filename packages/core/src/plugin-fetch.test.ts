import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createPluginFetcher, PluginFetchError } from './plugin-fetch.js';

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

  it('打ち切るときは git の子（孫）も含めたプロセスグループへ kill を送る', async () => {
    const dir = await makeTempDir('alteroid-fetch-group-');
    const fake = join(dir, 'fake-git');
    const pidFile = join(dir, 'grandchild.pid');
    await writeFile(fake, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
    await chmod(fake, 0o755);
    const repo = await makeRepo(BASIC);
    await expect(
      fetcher({ gitPath: fake, timeoutMs: 500 }).fetch({
        kind: 'url',
        url: repo.url,
        sha: repo.sha,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5000, interval: 50 });
  });

  it('取得物のサイズが上限を超えたら打ち切る', async () => {
    const repo = await makeRepo([{ path: 'big.bin', text: randomBytes(100_000).toString('hex') }]);
    await expect(
      fetcher({ maxFetchBytes: 1000 }).fetch({ kind: 'url', url: repo.url, sha: repo.sha }),
    ).rejects.toBeInstanceOf(PluginFetchError);
  });

  it('fetch に自動の保守（maintenance --auto --detach）を起こさせない（作業場の後片づけと競合する。#4099）', async () => {
    const dir = await makeTempDir('alteroid-fetch-trace-');
    const wrapper = join(dir, 'git-trace');
    const trace = join(dir, 'trace.log');
    await writeFile(wrapper, `#!/bin/sh\nGIT_TRACE='${trace}' exec git "$@"\n`);
    await chmod(wrapper, 0o755);
    const repo = await makeRepo(BASIC);
    await fetcher({ gitPath: wrapper }).fetch({ kind: 'url', url: repo.url, sha: repo.sha });
    const log = await readFile(trace, 'utf8');
    expect(log).toContain('built-in: git');
    expect(log).toMatch(/fetch -q --depth 1/);
    expect(log).not.toContain('maintenance run');
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

  it('索引の URL にクエリ・フラグメントがあれば取りに行かずに拒む（資格を日誌・DB に残さない）', async () => {
    const target = await makeRepo(BASIC);
    for (const url of [`${target.url}?token=fake-value-for-test`, `${target.url}#frag`]) {
      const repo = await marketplace([
        { name: 'remote-one', source: { source: 'url', url, sha: target.sha } },
      ]);
      await expect(
        fetcher({ marketplaceUrl: repo.url }).fetch({ kind: 'marketplace', plugin: 'remote-one' }),
      ).rejects.toMatchObject({ kind: 'invalid' });
    }
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

  it('索引が指す実体が器の内側（内部ホスト名・プライベート IP）なら取りに行かずに拒む', async () => {
    for (const url of [
      'https://postgres.railway.internal/x.git',
      'https://10.0.0.1/x.git',
      'https://[::1]/x.git',
    ]) {
      for (const source of [
        { source: 'url', url },
        { source: 'git-subdir', url, path: 'p' },
      ]) {
        const repo = await marketplace([{ name: 'inner', source }]);
        await expect(
          fetcher({ marketplaceUrl: repo.url }).fetch({ kind: 'marketplace', plugin: 'inner' }),
        ).rejects.toMatchObject({ kind: 'invalid' });
      }
    }
  });
});

describe('createPluginFetcher: 器の内側へ取りに行かない', () => {
  const INFO = '/info/refs?service=git-upload-pack';
  const SHA = 'a'.repeat(40);

  async function gitSpy(): Promise<{
    gitPath: string;
    argsOf: () => Promise<string[]>;
    envOf: () => Promise<string>;
  }> {
    const dir = await makeTempDir('alteroid-fetch-spy-');
    const gitPath = join(dir, 'git-spy');
    const argsLog = join(dir, 'args.log');
    const envLog = join(dir, 'env.log');
    await writeFile(
      gitPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${argsLog}'`,
        `env >> '${envLog}'`,
        'for a in "$@"; do',
        '  case "$a" in fetch|ls-remote) exit 1;; esac',
        'done',
        'exec git "$@"',
        '',
      ].join('\n'),
    );
    await chmod(gitPath, 0o755);
    return {
      gitPath,
      argsOf: async () =>
        (await readFile(argsLog, 'utf8').catch(() => '')).split('\n').filter((l) => l !== ''),
      envOf: async () => await readFile(envLog, 'utf8').catch(() => ''),
    };
  }

  const resolverOf =
    (dns: Record<string, string[]>) =>
    (host: string): Promise<string[]> =>
      dns[host] === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(dns[host]);

  function probeOf(replies: Record<string, { status: number; location?: string }>) {
    const calls: string[] = [];
    const probe = (target: { url: URL; addresses: string[] }) => {
      calls.push(target.url.href);
      const reply = replies[target.url.href];
      return reply === undefined
        ? Promise.reject(new Error('unexpected probe'))
        : Promise.resolve(reply);
    };
    return { calls, probe };
  }

  const PUBLIC = { 'example.test': ['93.184.216.34'] };

  it('内部ホスト名・内部へ解決される名前・複数の解決結果に内部が混じる名前を、git を起こす前に拒む', async () => {
    const spy = await gitSpy();
    const { probe, calls } = probeOf({});
    const resolver = resolverOf({
      'private.example.test': ['10.0.0.9'],
      'mixed.example.test': ['93.184.216.34', '192.168.0.2'],
    });
    for (const url of [
      'https://localhost/x.git',
      'https://postgres.railway.internal/x.git',
      'https://runner.railway.internal/x.git',
      'https://private.example.test/x.git',
      'https://mixed.example.test/x.git',
      'https://10.0.0.1/x.git',
      'https://[::1]/x.git',
      'https://2130706433/x.git',
    ]) {
      await expect(
        createPluginFetcher({ gitPath: spy.gitPath, resolver, probe }).fetch({
          kind: 'url',
          url,
          sha: SHA,
        }),
        url,
      ).rejects.toMatchObject({ name: 'PluginFetchError', kind: 'invalid' });
    }
    expect(calls).toEqual([]);
    expect(await spy.argsOf()).toEqual([]);
  });

  it('拒否の文言に、解決したアドレスを載せない', async () => {
    const spy = await gitSpy();
    const { probe } = probeOf({});
    const error = await createPluginFetcher({
      gitPath: spy.gitPath,
      resolver: resolverOf({ 'private.example.test': ['10.0.0.9'] }),
      probe,
    })
      .fetch({ kind: 'url', url: 'https://private.example.test/x.git', sha: SHA })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(PluginFetchError);
    expect((error as Error).message).not.toContain('10.0.0.9');
  });

  it('公開から内部へのリダイレクト・https から http へのリダイレクトを拒む', async () => {
    for (const location of [
      'https://postgres.railway.internal/x.git/info/refs',
      'https://private.example.test/x.git/info/refs',
      'http://example.test/x.git/info/refs',
    ]) {
      const spy = await gitSpy();
      const { probe } = probeOf({
        [`https://example.test/x.git${INFO}`]: { status: 302, location },
      });
      await expect(
        createPluginFetcher({
          gitPath: spy.gitPath,
          resolver: resolverOf({ ...PUBLIC, 'private.example.test': ['172.16.0.4'] }),
          probe,
        }).fetch({ kind: 'url', url: 'https://example.test/x.git', sha: SHA }),
        location,
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(await spy.argsOf()).toEqual([]);
    }
  });

  it('通るときは、判定済みのアドレスを curloptResolve で固定し、git にリダイレクトを辿らせない', async () => {
    const spy = await gitSpy();
    const { probe } = probeOf({
      [`https://example.test/x.git${INFO}`]: { status: 200 },
    });
    await expect(
      createPluginFetcher({
        gitPath: spy.gitPath,
        resolver: resolverOf({ 'example.test': ['93.184.216.34', '2606:4700:4700::1111'] }),
        probe,
      }).fetch({ kind: 'url', url: 'https://example.test/x.git', sha: SHA }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const network = (await spy.argsOf()).filter((l) => / fetch /.test(` ${l} `));
    expect(network).toHaveLength(1);
    expect(network[0]).toContain('-c http.followRedirects=false');
    expect(network[0]).toContain(
      '-c http.curloptResolve=example.test:443:93.184.216.34,[2606:4700:4700::1111]',
    );
    expect(network[0]).toContain('https://example.test/x.git');
  });

  it('リダイレクトの先で取る。固定するのは最後のホストのアドレス', async () => {
    const spy = await gitSpy();
    const { probe } = probeOf({
      [`https://example.test/x.git${INFO}`]: {
        status: 301,
        location: 'https://cdn.example.test/y/z.git/info/refs?service=git-upload-pack',
      },
      [`https://cdn.example.test/y/z.git${INFO}`]: { status: 200 },
    });
    await expect(
      createPluginFetcher({
        gitPath: spy.gitPath,
        resolver: resolverOf({ ...PUBLIC, 'cdn.example.test': ['93.184.216.35'] }),
        probe,
      }).fetch({ kind: 'url', url: 'https://example.test/x.git', sha: SHA }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const network = (await spy.argsOf()).filter((l) => / fetch /.test(` ${l} `));
    expect(network[0]).toContain('http.curloptResolve=cdn.example.test:443:93.184.216.35');
    expect(network[0]).not.toContain('example.test:443:93.184.216.34');
    expect(network[0]).toContain('https://cdn.example.test/y/z.git');
  });

  it('SHA を省くときの ls-remote にも同じ固定を渡す', async () => {
    const spy = await gitSpy();
    const { probe } = probeOf({ [`https://example.test/x.git${INFO}`]: { status: 200 } });
    await createPluginFetcher({
      gitPath: spy.gitPath,
      resolver: resolverOf(PUBLIC),
      probe,
    })
      .fetch({ kind: 'url', url: 'https://example.test/x.git' })
      .catch(() => undefined);
    const remote = (await spy.argsOf()).filter((l) => l.includes('ls-remote'));
    expect(remote).toHaveLength(1);
    expect(remote[0]).toContain('-c http.followRedirects=false');
    expect(remote[0]).toContain('-c http.curloptResolve=example.test:443:93.184.216.34');
  });

  it('公式 marketplace の既定 URL も同じ判定を通る', async () => {
    const spy = await gitSpy();
    const { probe, calls } = probeOf({});
    await expect(
      createPluginFetcher({
        gitPath: spy.gitPath,
        resolver: resolverOf({ 'registry.railway.internal': ['10.0.0.3'] }),
        probe,
        marketplaceUrl: 'https://registry.railway.internal/m.git',
      }).fetch({ kind: 'marketplace', plugin: 'x' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls).toEqual([]);
    expect(await spy.argsOf()).toEqual([]);
  });

  it('プロキシの環境変数を git に渡さない', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:3128');
    vi.stubEnv('https_proxy', 'http://proxy.invalid:3128');
    vi.stubEnv('ALL_PROXY', 'http://proxy.invalid:3128');
    try {
      const spy = await gitSpy();
      const { probe } = probeOf({ [`https://example.test/x.git${INFO}`]: { status: 200 } });
      await createPluginFetcher({ gitPath: spy.gitPath, resolver: resolverOf(PUBLIC), probe })
        .fetch({ kind: 'url', url: 'https://example.test/x.git', sha: SHA })
        .catch(() => undefined);
      const env = await spy.envOf();
      expect(env).not.toMatch(/proxy/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
