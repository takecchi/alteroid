import { describe, expect, it } from 'vitest';

import {
  computePluginContentSha256,
  normalizePluginDescription,
  parsePluginInput,
  parseStoredPlugin,
  pluginDirName,
  pluginSummaryOf,
  pluginsFingerprintOf,
  validatePluginFilePath,
  OFFICIAL_MARKETPLACE_URL,
  resolveMarketplaceUrl,
  type PluginInput,
} from './plugins.js';
import { verifyPluginStoreContract } from './plugin-store-contract.js';
import { createMemoryStores } from './testing.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('resolveMarketplaceUrl', () => {
  it('未設定・空白だけは公式の既定、設定があればそれを使う', () => {
    expect(OFFICIAL_MARKETPLACE_URL).toBe('https://github.com/anthropics/claude-plugins-official');
    expect(resolveMarketplaceUrl(undefined)).toBe(OFFICIAL_MARKETPLACE_URL);
    expect(resolveMarketplaceUrl('  ')).toBe(OFFICIAL_MARKETPLACE_URL);
    expect(resolveMarketplaceUrl(' https://example.invalid/m.git ')).toBe(
      'https://example.invalid/m.git',
    );
  });
});

const bytes = (...values: number[]) => new Uint8Array(values);

function validInput(overrides: Record<string, unknown> = {}): PluginInput {
  return {
    name: 'frontend-design',
    source: { kind: 'url', url: 'https://github.com/example/plugins', path: 'plugins/x', sha: SHA },
    files: [
      { path: '.claude-plugin/plugin.json', executable: false, content: bytes(123, 125) },
      { path: 'skills/x/SKILL.md', executable: false, content: bytes(35, 32, 120) },
      { path: 'scripts/run.sh', executable: true, content: bytes(0, 1, 2, 255) },
    ],
    installedAt: '2026-10-07T01:02:03.000Z',
    installedBy: 'account-1',
    ...overrides,
  } as PluginInput;
}

function rejection(input: unknown): string {
  try {
    parsePluginInput(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('拒まなかった');
}

describe('plugin の保存の形', () => {
  it('器の契約（インメモリ。3実装で同じことを測る）', async () => {
    await verifyPluginStoreContract(createMemoryStores().plugins);
  });

  describe('既定値', () => {
    it('scope は all、hooks と .mcp.json は既定で無効', () => {
      const stored = parsePluginInput(validInput());
      expect(stored.scope).toBe('all');
      expect(stored.enableHooks).toBe(false);
      expect(stored.enableMcp).toBe(false);
    });

    it('scope は実行環境プロファイルと同じ3値（all / app / runner）だけ', () => {
      for (const scope of ['all', 'app', 'runner'] as const) {
        expect(parsePluginInput(validInput({ scope })).scope).toBe(scope);
      }
      expect(() => parsePluginInput(validInput({ scope: 'clone' }))).toThrow();
      expect(() => parsePluginInput(validInput({ scope: 'manager' }))).toThrow();
      // 旧案の撒く先の形は受けない
      expect(() =>
        parsePluginInput(validInput({ targets: { clone: true, manager: true, worker: true } })),
      ).toThrow();
    });

    it('enableHooks / enableMcp は真偽値だけ', () => {
      expect(parsePluginInput(validInput({ enableHooks: true, enableMcp: true })).enableHooks).toBe(
        true,
      );
      expect(() => parsePluginInput(validInput({ enableHooks: 'yes' }))).toThrow();
      expect(() => parsePluginInput(validInput({ enableMcp: 1 }))).toThrow();
    });
  });

  describe('name', () => {
    it('^[A-Za-z0-9_-]{1,64}$ だけ', () => {
      for (const ok of ['a', 'A_b-9', 'x'.repeat(64)]) {
        expect(() => parsePluginInput(validInput({ name: ok }))).not.toThrow();
      }
      for (const bad of ['', 'x'.repeat(65), 'a b', 'a.b', 'a/b', '../x', 'a\u0000', 'あ', 'a@b']) {
        expect(() => parsePluginInput(validInput({ name: bad }))).toThrow();
      }
    });
  });

  describe('source', () => {
    it('kind: url は https の URL と 40桁の小文字16進の sha', () => {
      const stored = parsePluginInput(
        validInput({ source: { kind: 'url', url: 'https://example.com/a/b.git', sha: SHA } }),
      );
      expect(stored.source).toEqual({ kind: 'url', url: 'https://example.com/a/b.git', sha: SHA });
    });

    it('kind: marketplace は公式 marketplace だけで、解決した実体の url と sha を持つ', () => {
      const source = {
        kind: 'marketplace',
        marketplace: 'claude-plugins-official',
        plugin: 'frontend-design',
        url: 'https://github.com/anthropics/claude-plugins-official',
        path: 'plugins/frontend-design',
        sha: SHA,
        version: '1.2.3',
      };
      expect(parsePluginInput(validInput({ source })).source).toEqual(source);
      expect(() =>
        parsePluginInput(validInput({ source: { ...source, marketplace: 'x' } })),
      ).toThrow();
      expect(() =>
        parsePluginInput(validInput({ source: { ...source, plugin: 'a b' } })),
      ).toThrow();
      const withoutUrl = Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== 'url'),
      );
      expect(() => parsePluginInput(validInput({ source: withoutUrl }))).toThrow();
    });

    it('version は任意の文字列（固定の根拠は sha）', () => {
      const withVersion = parsePluginInput(
        validInput({
          source: { kind: 'url', url: 'https://example.com/a', sha: SHA, version: '2' },
        }),
      );
      expect(withVersion.source.version).toBe('2');
      expect(() =>
        parsePluginInput(
          validInput({
            source: { kind: 'url', url: 'https://example.com/a', sha: SHA, version: '' },
          }),
        ),
      ).toThrow();
    });

    it('github の kind は作らない（GitHub も kind: url で表す）', () => {
      expect(() =>
        parsePluginInput(
          validInput({ source: { kind: 'github', owner: 'a', repo: 'b', sha: SHA } }),
        ),
      ).toThrow();
    });

    it('https 以外・資格つき・壊れた URL は拒む', () => {
      for (const url of [
        'http://example.com/a',
        'git@github.com:a/b.git',
        'ssh://git@example.com/a',
        'file:///etc/passwd',
        'https://user:fake-value-for-test@example.com/a',
        'https://user@example.com/a',
        'https://',
        'example.com/a',
        '',
        'https://example.com/a\u0000',
        `https://example.com/${'a'.repeat(3000)}`,
        // 資格がクエリやフラグメントに載っても、日誌・DB に残さない。
        'https://example.com/a?token=fake-value-for-test',
        'https://example.com/a?',
        'https://example.com/a#fragment',
        'https://example.com/a#',
      ]) {
        expect(() =>
          parsePluginInput(validInput({ source: { kind: 'url', url, sha: SHA } })),
        ).toThrow();
      }
    });

    it('sha は小文字40桁16進だけ', () => {
      for (const sha of [
        SHA.toUpperCase(),
        SHA.slice(1),
        `${SHA}0`,
        'main',
        'v1.0.0',
        `${SHA.slice(0, 39)}g`,
        ` ${SHA}`,
        `${SHA}\n`,
        '',
      ]) {
        expect(() =>
          parsePluginInput(
            validInput({ source: { kind: 'url', url: 'https://example.com/a', sha } }),
          ),
        ).toThrow();
      }
    });

    it('source.path は plugin のディレクトリ（files の path と同じ厳しさ）', () => {
      for (const path of ['', '/abs', '../x', 'a/../b', 'a//b', 'a/', 'a\\b', './a', 'a/./b']) {
        expect(() =>
          parsePluginInput(
            validInput({ source: { kind: 'url', url: 'https://example.com/a', path, sha: SHA } }),
          ),
        ).toThrow();
      }
    });

    it('未知の欄は黙って捨てずに拒む（strictObject）', () => {
      expect(() =>
        parsePluginInput(
          validInput({
            source: { kind: 'url', url: 'https://example.com/a', sha: SHA, ref: 'main' },
          }),
        ),
      ).toThrow();
      expect(() => parsePluginInput(validInput({ autoUpdate: true }))).toThrow();
      expect(() =>
        parsePluginInput(
          validInput({
            files: [{ path: 'a', executable: false, content: bytes(1), mode: 0o777 }],
          }),
        ),
      ).toThrow();
    });
  });

  describe('files の path', () => {
    const bad: [string, string][] = [
      ['絶対パス', '/etc/passwd'],
      ['絶対パス（先頭が /）', '/skills/x/SKILL.md'],
      ['ドライブ文字つき', 'C:/x'],
      ['.. セグメント', 'skills/../../etc/passwd'],
      ['先頭の ..', '../x'],
      ['末尾の ..', 'a/..'],
      ['. セグメント', 'a/./b'],
      ['空セグメント（//）', 'a//b'],
      ['末尾の /', 'a/'],
      ['空文字', ''],
      ['バックスラッシュ', 'a\\b'],
      ['バックスラッシュで .. を隠す', '..\\x'],
      ['NUL', 'a\u0000b'],
      ['末尾の NUL', 'a\u0000'],
      ['改行などの制御文字', 'a\nb'],
      ['長すぎる path', `${'a'.repeat(600)}`],
    ];
    for (const [label, path] of bad) {
      it(`${label}は拒む`, () => {
        expect(validatePluginFilePath(path)).not.toBeNull();
        expect(() =>
          parsePluginInput(validInput({ files: [{ path, executable: false, content: bytes(1) }] })),
        ).toThrow();
      });
    }

    it('相対パスは通る（先頭が . の名前や ..a のような名前も通る）', () => {
      for (const ok of ['a', 'a/b/c.md', '.claude-plugin/plugin.json', '..a/b', 'a/..b', 'a b/c']) {
        expect(validatePluginFilePath(ok)).toBeNull();
      }
    });

    it('重複した path は拒む', () => {
      expect(
        rejection(
          validInput({
            files: [
              { path: 'a/b', executable: false, content: bytes(1) },
              { path: 'a/b', executable: true, content: bytes(2) },
            ],
          }),
        ),
      ).toContain('重複');
    });

    it('ファイルとディレクトリが同じ path になる組は拒む（展開できない）', () => {
      expect(() =>
        parsePluginInput(
          validInput({
            files: [
              { path: 'a', executable: false, content: bytes(1) },
              { path: 'a/b', executable: false, content: bytes(2) },
            ],
          }),
        ),
      ).toThrow();
    });

    it('拒む文言に path の中身を載せない（どの欄・何番目かだけ）', () => {
      const message = rejection(
        validInput({
          files: [{ path: '../SECRET-NAME', executable: false, content: bytes(1) }],
        }),
      );
      expect(message).not.toContain('SECRET-NAME');
      expect(message).toContain('files');
    });

    it('files は空でもよい（skill 単体を包むときも plugin.json は要るので、数は問わない）が、配列でなければ拒む', () => {
      expect(parsePluginInput(validInput({ files: [] })).files).toEqual([]);
      expect(() => parsePluginInput(validInput({ files: 'x' }))).toThrow();
    });

    it('content は Uint8Array だけ（文字列は拒む）', () => {
      expect(() =>
        parsePluginInput(
          validInput({ files: [{ path: 'a', executable: false, content: 'text' }] }),
        ),
      ).toThrow();
    });

    it('executable は必須の真偽値', () => {
      expect(() =>
        parsePluginInput(validInput({ files: [{ path: 'a', content: bytes(1) }] })),
      ).toThrow();
    });
  });

  describe('contentSha256', () => {
    const base = [
      { path: 'a', executable: false, content: bytes(1, 2, 3) },
      { path: 'b/c', executable: true, content: bytes(4) },
    ];

    it('64桁の小文字16進で、files の並びに依らない', () => {
      const forward = computePluginContentSha256(base);
      expect(forward).toMatch(/^[0-9a-f]{64}$/);
      expect(computePluginContentSha256([...base].reverse())).toBe(forward);
    });

    it('path・内容・executable のどれが違っても変わる', () => {
      const original = computePluginContentSha256(base);
      const first = base[0]!;
      const second = base[1]!;
      expect(computePluginContentSha256([{ ...first, path: 'a2' }, second])).not.toBe(original);
      expect(computePluginContentSha256([{ ...first, content: bytes(1, 2, 4) }, second])).not.toBe(
        original,
      );
      expect(computePluginContentSha256([{ ...first, executable: true }, second])).not.toBe(
        original,
      );
      expect(computePluginContentSha256([first])).not.toBe(original);
    });

    it('path と内容の境目を取り違えない（"a"+"bc" と "ab"+"c" は別）', () => {
      const x = computePluginContentSha256([
        { path: 'a', executable: false, content: bytes(98, 99) },
      ]);
      const y = computePluginContentSha256([{ path: 'ab', executable: false, content: bytes(99) }]);
      expect(x).not.toBe(y);
    });

    it('取り込むとき計算して入れ、読むときに突き合わせる', () => {
      const stored = parsePluginInput(validInput());
      expect(stored.contentSha256).toBe(computePluginContentSha256(stored.files));
      expect(() => parseStoredPlugin(stored)).not.toThrow();
      expect(() =>
        parseStoredPlugin({
          ...stored,
          files: [{ path: 'a', executable: false, content: bytes(9) }],
        }),
      ).toThrow();
    });

    it('呼び手が contentSha256 を渡しても、食い違っていれば拒む', () => {
      expect(() => parsePluginInput(validInput({ contentSha256: '0'.repeat(64) }))).toThrow();
    });
  });

  describe('installedAt / installedBy', () => {
    it('installedAt は ISO の日時、installedBy は空でない文字列', () => {
      expect(() => parsePluginInput(validInput({ installedAt: 'yesterday' }))).toThrow();
      expect(() => parsePluginInput(validInput({ installedAt: '' }))).toThrow();
      expect(() => parsePluginInput(validInput({ installedBy: '' }))).toThrow();
      expect(() => parsePluginInput(validInput({ installedBy: 'a\u0000b' }))).toThrow();
      expect(() => parsePluginInput(validInput({ installedBy: 7 }))).toThrow();
    });
  });

  describe('description', () => {
    it('任意。無ければ欄ごと無い（undefined の欄も作らない）', () => {
      const stored = parsePluginInput(validInput());
      expect('description' in stored).toBe(false);
      expect('description' in pluginSummaryOf(stored)).toBe(false);
    });

    it('あれば保存と要約に載る。上限は1024文字', () => {
      const stored = parsePluginInput(validInput({ description: 'a'.repeat(1024) }));
      expect(pluginSummaryOf(stored).description).toBe('a'.repeat(1024));
      expect(() => parsePluginInput(validInput({ description: 'a'.repeat(1025) }))).toThrow();
    });

    it('空・制御文字（改行・タブ・NUL・DEL）・文字列でないものは拒む', () => {
      for (const bad of ['', 'a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 7, null]) {
        expect(() => parsePluginInput(validInput({ description: bad as string }))).toThrow(
          /description/,
        );
      }
    });

    it('拒む文言に値を載せない', () => {
      let message = '';
      try {
        parsePluginInput(validInput({ description: 'NOTAKEY-VALUE\n' }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/description/);
      expect(message).not.toContain('NOTAKEY-VALUE');
    });

    it('読み出しでも同じ検査（SQL や手で書き換えられても長すぎる説明は通さない）', () => {
      const stored = parsePluginInput(validInput({ description: 'ok' }));
      expect(parseStoredPlugin(stored).description).toBe('ok');
      expect(() => parseStoredPlugin({ ...stored, description: 'a'.repeat(1025) })).toThrow();
    });
  });

  describe('normalizePluginDescription（外の文字列を保存できる形にする）', () => {
    it('制御文字の並びを空白1つにし、前後を削る', () => {
      expect(normalizePluginDescription('  a\r\n\tb\u0000c  ')).toBe('a b c');
    });

    it('空・空白だけ・文字列でないものは undefined', () => {
      expect(normalizePluginDescription('')).toBeUndefined();
      expect(normalizePluginDescription(' \n\t ')).toBeUndefined();
      expect(normalizePluginDescription(undefined)).toBeUndefined();
      expect(normalizePluginDescription(5)).toBeUndefined();
    });

    it('1024文字を超えたら切る。サロゲートペアを割らない。結果は保存の検査を通る', () => {
      const out = normalizePluginDescription(`${'a'.repeat(1023)}😀tail`);
      expect(out).toBe('a'.repeat(1023));
      expect(normalizePluginDescription('b'.repeat(5000))?.length).toBe(1024);
      expect(() => parsePluginInput(validInput({ description: out }))).not.toThrow();
    });

    it('HTML らしい文字列はそのまま（エスケープは描く側の仕事）', () => {
      expect(normalizePluginDescription('<img src=x onerror=alert(1)>')).toBe(
        '<img src=x onerror=alert(1)>',
      );
    });
  });

  describe('要約と展開先の名前', () => {
    it('要約は files を含まず、数とバイト数を持つ', () => {
      const stored = parsePluginInput(validInput());
      const summary = pluginSummaryOf(stored);
      expect('files' in summary).toBe(false);
      expect(summary.fileCount).toBe(3);
      expect(summary.totalBytes).toBe(2 + 3 + 4);
      expect(summary.contentSha256).toBe(stored.contentSha256);
      expect(summary.name).toBe('frontend-design');
    });

    it('展開先のディレクトリ名は ${name}@${sha}', () => {
      expect(pluginDirName('frontend-design', SHA)).toBe(`frontend-design@${SHA}`);
      expect(() => pluginDirName('../x', SHA)).toThrow();
      expect(() => pluginDirName('a', 'main')).toThrow();
    });
  });

  describe('pluginsFingerprintOf', () => {
    const base = {
      name: 'a',
      sha: SHA,
      contentSha256: 'c'.repeat(64),
      enableHooks: false,
      enableMcp: false,
    };

    it('同じ sha・同じ中身でも、フラグが違えば指紋が変わる', () => {
      const plain = pluginsFingerprintOf([base]);
      expect(pluginsFingerprintOf([{ ...base, enableMcp: true }])).not.toBe(plain);
      expect(pluginsFingerprintOf([{ ...base, enableHooks: true }])).not.toBe(plain);
      expect(pluginsFingerprintOf([{ ...base }])).toBe(plain);
    });
  });
});
