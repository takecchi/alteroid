import { describe, expect, it } from 'vitest';

import {
  curlResolveValue,
  isBlockedAddress,
  isBlockedHostname,
  pinnedLookup,
  resolveRepoSource,
  SourceGuardError,
  type Probe,
  type Resolver,
} from './plugin-fetch-guard.js';

describe('isBlockedHostname', () => {
  const blocked = [
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    'a.b.LocalHost.',
    'postgres.railway.internal',
    'runner.railway.internal.',
    'Foo.INTERNAL',
    'printer.local',
    'printer.local.',
    'internal',
    'local',
  ];
  const allowed = [
    'github.com',
    'example.test',
    'localhost.example.com',
    'internal.example.com',
    'notlocal.com',
    'mylocalhost.com',
    'gitlab.internal-tools.dev',
  ];
  it.each(blocked)('%s は拒む', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });
  it.each(allowed)('%s は通す', (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });
});

describe('isBlockedAddress: IPv4', () => {
  const blocked = [
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.0.255',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.254',
    '255.255.255.255',
  ];
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '192.167.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '93.184.216.34',
  ];
  it.each(blocked)('%s は拒む', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it.each(allowed)('%s は通す', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
  it.each(['', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', '01.2.3.4', '0x7f.0.0.1'])(
    '読めない形（%s）は拒む',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});

describe('isBlockedAddress: IPv6', () => {
  const blocked = [
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'ff00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::ffff:169.254.169.254',
    '::ffff:192.168.1.1',
    '::ffff:0.0.0.0',
    '::ffff:255.255.255.255',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '::127.0.0.1',
    '2002:7f00:1::',
    '2002:a00:1::1',
    '[::1]',
  ];
  const allowed = [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
    'fbff::1',
    'fe7f::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ];
  it.each(blocked)('%s は拒む', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it.each(allowed)('%s は通す', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
  it.each(['::g', '1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%eth0', ':::'])(
    '読めない形（%s）は拒む',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});

describe('curlResolveValue / pinnedLookup', () => {
  it('curl の --resolve の形（IPv6 は角括弧）に、判定済みのアドレスを並べる', () => {
    expect(curlResolveValue('example.test', 443, ['93.184.216.34'])).toBe(
      'example.test:443:93.184.216.34',
    );
    expect(curlResolveValue('example.test', 8443, ['93.184.216.34', '2606:4700:4700::1111'])).toBe(
      'example.test:8443:93.184.216.34,[2606:4700:4700::1111]',
    );
  });

  it('lookup は名前解決せず、判定済みのアドレスだけを返す（all あり・なし）', async () => {
    const lookup = pinnedLookup(['93.184.216.34', '2606:4700:4700::1111']);
    const all = await new Promise<unknown>((resolve) => {
      lookup('other.example', { all: true }, (_e, result) => resolve(result));
    });
    expect(all).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const one = await new Promise<unknown[]>((resolve) => {
      lookup('other.example', {}, (_e, address, family) => resolve([address, family]));
    });
    expect(one).toEqual(['93.184.216.34', 4]);
  });
});

describe('resolveRepoSource', () => {
  function setup(
    dns: Record<string, string[]>,
    replies: Record<string, { status: number; location?: string }>,
  ) {
    const probed: string[] = [];
    const resolver: Resolver = (host) => {
      const found = dns[host];
      if (found === undefined) return Promise.reject(new Error('ENOTFOUND'));
      return Promise.resolve(found);
    };
    const probe: Probe = (target) => {
      probed.push(`${target.url.host}${target.url.pathname}${target.url.search}`);
      const reply = replies[target.url.href];
      if (reply === undefined) return Promise.reject(new Error('unexpected probe'));
      return Promise.resolve(reply);
    };
    return { probed, deps: { resolver, probe } };
  }

  const INFO = '/info/refs?service=git-upload-pack';

  async function kindOf(run: Promise<unknown>): Promise<string> {
    try {
      await run;
    } catch (error) {
      if (error instanceof SourceGuardError) return error.kind;
      throw error;
    }
    return 'ok';
  }

  it('公開のホストはそのまま通り、判定したアドレスを返す', async () => {
    const { deps, probed } = setup(
      { 'example.test': ['93.184.216.34'] },
      { [`https://example.test/a/b.git${INFO}`]: { status: 200 } },
    );
    const got = await resolveRepoSource('https://example.test/a/b.git', deps);
    expect(got).toEqual({
      repoUrl: 'https://example.test/a/b.git',
      host: 'example.test',
      port: 443,
      addresses: ['93.184.216.34'],
      literal: false,
    });
    expect(probed).toEqual([`example.test/a/b.git${INFO}`]);
  });

  it('末尾のスラッシュは畳んで info/refs を付ける', async () => {
    const { deps } = setup(
      { 'example.test': ['93.184.216.34'] },
      { [`https://example.test/a/b${INFO}`]: { status: 404 } },
    );
    const got = await resolveRepoSource('https://example.test/a/b/', deps);
    expect(got.repoUrl).toBe('https://example.test/a/b');
  });

  it.each([
    'https://localhost/a.git',
    'https://LOCALHOST./a.git',
    'https://x.localhost/a.git',
    'https://postgres.railway.internal/a.git',
    'https://runner.railway.internal./a.git',
    'https://printer.local/a.git',
    'https://10.0.0.1/a.git',
    'https://127.0.0.1/a.git',
    'https://169.254.169.254/latest',
    'https://[::1]/a.git',
    'https://[::ffff:7f00:1]/a.git',
    'https://[fd00::1]/a.git',
    'https://2130706433/a.git',
    'https://0x7f.0.0.1/a.git',
    'https://0177.0.0.1/a.git',
    'https://127.1/a.git',
  ])('%s は名前解決も通信もせず拒む', async (url) => {
    const { deps, probed } = setup({}, {});
    expect(await kindOf(resolveRepoSource(url, deps))).toBe('blocked');
    expect(probed).toEqual([]);
  });

  it('プライベートに解決される名前は、通信せず拒む', async () => {
    const { deps, probed } = setup({ 'sneaky.example.test': ['10.1.2.3'] }, {});
    expect(await kindOf(resolveRepoSource('https://sneaky.example.test/a.git', deps))).toBe(
      'blocked',
    );
    expect(probed).toEqual([]);
  });

  it('解決結果が複数あり、1つでも内部なら拒む', async () => {
    const { deps } = setup({ 'mixed.example.test': ['93.184.216.34', '127.0.0.1'] }, {});
    expect(await kindOf(resolveRepoSource('https://mixed.example.test/a.git', deps))).toBe(
      'blocked',
    );
    const second = setup({ 'mixed.example.test': ['::1', '93.184.216.34'] }, {});
    expect(await kindOf(resolveRepoSource('https://mixed.example.test/a.git', second.deps))).toBe(
      'blocked',
    );
  });

  it('解決できない・アドレスが空なら unavailable', async () => {
    expect(
      await kindOf(resolveRepoSource('https://nowhere.example.test/a.git', setup({}, {}).deps)),
    ).toBe('unavailable');
    expect(
      await kindOf(
        resolveRepoSource(
          'https://empty.example.test/a.git',
          setup({ 'empty.example.test': [] }, {}).deps,
        ),
      ),
    ).toBe('unavailable');
  });

  it('https 以外・資格・クエリ・フラグメント・読めない URL は拒む', async () => {
    for (const url of [
      'http://example.test/a.git',
      'file:///tmp/x.git',
      'ssh://example.test/a.git',
      'git@example.test:a/b.git',
      'https://user:pw@example.test/a.git',
      'https://example.test/a.git?token=fake-value',
      'https://example.test/a.git#frag',
    ]) {
      const { deps } = setup({ 'example.test': ['93.184.216.34'] }, {});
      expect(await kindOf(resolveRepoSource(url, deps)), url).toBe('invalid');
    }
  });

  it('リダイレクトを手動で辿り、最後のホストの URL とアドレスを返す', async () => {
    const { deps, probed } = setup(
      { 'example.test': ['93.184.216.34'], 'cdn.example.test': ['93.184.216.35'] },
      {
        [`https://example.test/a/b.git${INFO}`]: {
          status: 301,
          location: `https://cdn.example.test/x/y.git/info/refs?service=git-upload-pack`,
        },
        [`https://cdn.example.test/x/y.git${INFO}`]: { status: 200 },
      },
    );
    const got = await resolveRepoSource('https://example.test/a/b.git', deps);
    expect(got.repoUrl).toBe('https://cdn.example.test/x/y.git');
    expect(got.host).toBe('cdn.example.test');
    expect(got.addresses).toEqual(['93.184.216.35']);
    expect(probed).toEqual([`example.test/a/b.git${INFO}`, `cdn.example.test/x/y.git${INFO}`]);
  });

  it('相対の Location も解決する（クエリの無い info/refs も受ける）', async () => {
    const { deps } = setup(
      { 'example.test': ['93.184.216.34'] },
      {
        [`https://example.test/a/b.git${INFO}`]: { status: 302, location: '/c/d.git/info/refs' },
        [`https://example.test/c/d.git${INFO}`]: { status: 200 },
      },
    );
    const got = await resolveRepoSource('https://example.test/a/b.git', deps);
    expect(got.repoUrl).toBe('https://example.test/c/d.git');
  });

  it('公開から内部へのリダイレクトは拒む（ホスト名・解決先・IP リテラル）', async () => {
    for (const location of [
      'https://postgres.railway.internal/a.git/info/refs?service=git-upload-pack',
      'https://private.example.test/a.git/info/refs?service=git-upload-pack',
      'https://169.254.169.254/a.git/info/refs?service=git-upload-pack',
      'https://[::1]/a.git/info/refs?service=git-upload-pack',
    ]) {
      const { deps } = setup(
        { 'example.test': ['93.184.216.34'], 'private.example.test': ['192.168.1.5'] },
        { [`https://example.test/a.git${INFO}`]: { status: 307, location } },
      );
      expect(await kindOf(resolveRepoSource('https://example.test/a.git', deps)), location).toBe(
        'blocked',
      );
    }
  });

  it('https から http へのリダイレクトは拒む', async () => {
    const { deps } = setup(
      { 'example.test': ['93.184.216.34'] },
      {
        [`https://example.test/a.git${INFO}`]: {
          status: 301,
          location: 'http://example.test/a.git/info/refs?service=git-upload-pack',
        },
      },
    );
    expect(await kindOf(resolveRepoSource('https://example.test/a.git', deps))).toBe('invalid');
  });

  it('導けない・資格やクエリやフラグメントを持つ Location は拒む', async () => {
    for (const location of [
      'https://example.test/other',
      'https://example.test/a.git/info/refs?service=git-receive-pack',
      'https://example.test/a.git/info/refs?service=git-upload-pack&token=fake-value',
      'https://example.test/a.git/info/refs?service=git-upload-pack#f',
      'https://user:pw@example.test/a.git/info/refs',
      '',
    ]) {
      const { deps } = setup(
        { 'example.test': ['93.184.216.34'] },
        { [`https://example.test/a.git${INFO}`]: { status: 302, location } },
      );
      expect(await kindOf(resolveRepoSource('https://example.test/a.git', deps)), location).toBe(
        'invalid',
      );
    }
  });

  it('Location の無い 3xx は拒む', async () => {
    const { deps } = setup(
      { 'example.test': ['93.184.216.34'] },
      { [`https://example.test/a.git${INFO}`]: { status: 302 } },
    );
    expect(await kindOf(resolveRepoSource('https://example.test/a.git', deps))).toBe('invalid');
  });

  it('リダイレクトは最大 5 回。6 回目は拒む', async () => {
    const replies: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i <= 6; i += 1) {
      replies[`https://example.test/r${i}.git${INFO}`] =
        i < 6
          ? { status: 302, location: `https://example.test/r${i + 1}.git/info/refs` }
          : { status: 200 };
    }
    const five = setup({ 'example.test': ['93.184.216.34'] }, replies);
    const got = await resolveRepoSource('https://example.test/r1.git', five.deps);
    expect(got.repoUrl).toBe('https://example.test/r6.git');
    const six = setup({ 'example.test': ['93.184.216.34'] }, replies);
    expect(await kindOf(resolveRepoSource('https://example.test/r0.git', six.deps))).toBe(
      'invalid',
    );
  });

  it('通信が失敗したら unavailable', async () => {
    const resolver: Resolver = () => Promise.resolve(['93.184.216.34']);
    const probe: Probe = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await kindOf(resolveRepoSource('https://example.test/a.git', { resolver, probe }))).toBe(
      'unavailable',
    );
  });

  it('IP リテラルの公開アドレスは、名前解決せずそのアドレスで通す', async () => {
    const { deps } = setup({}, { [`https://93.184.216.34/a.git${INFO}`]: { status: 200 } });
    const got = await resolveRepoSource('https://93.184.216.34/a.git', deps);
    expect(got).toMatchObject({ addresses: ['93.184.216.34'], literal: true });
  });

  it('エラーの文言に、解決したアドレスを載せない', async () => {
    const { deps } = setup({ 'sneaky.example.test': ['10.1.2.3'] }, {});
    try {
      await resolveRepoSource('https://sneaky.example.test/a.git', deps);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('10.1.2.3');
      expect((error as Error).message).toContain('器の内側');
    }
  });
});
