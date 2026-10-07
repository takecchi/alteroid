import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  collectMarkedQuotes,
  EXCLUDED_PREFIXES,
  findQuoteDefects,
  listScannableFiles,
  MARKER,
  resolveSdkTypes,
  SCANNED_EXTENSIONS,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない検査スクリプト）を読む
} from './check-sdk-quotes-core.mjs';

type Quote = { path: string; line: number; symbol: string | null; quote: string | null };
type Defect = Quote & { reason: string };

const FAKE_SDK = [
  'export declare type SDKBackgroundTasksChangedMessage = {',
  '    /**',
  '     * True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
  '     */',
  '    ambient?: boolean;',
  '};',
].join('\n');

describe('check-sdk-quotes: collectMarkedQuotes', () => {
  it('印が無ければ0件（＝走査はしたが引用が無い、を返せる）', () => {
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: '// ただのコメント\nconst a = 1;' },
    ]);
    expect(quotes).toEqual([]);
  });

  it('次の行のブロック引用（JSDoc の `> `）を拾う', () => {
    const content = [
      '/**',
      ` * [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
      ' * > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
      ' */',
    ].join('\n');
    const quotes = collectMarkedQuotes([{ path: 'a.ts', content }]) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.symbol).toBe('SDKBackgroundTasksChangedMessage.ambient');
    expect(quotes[0]!.quote).toBe(
      'True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
    );
  });

  it('同じ行の鉤括弧（日本語の文中に埋め込んだ形）を拾う', () => {
    const content =
      '// `ambient` の欄も逐語で引く: 「True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.」 [sdk-verbatim ambient]';
    const quotes = collectMarkedQuotes([{ path: 'a.ts', content }]) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.quote?.startsWith('True for tasks that are not activity')).toBe(true);
    expect(quotes[0]!.quote?.endsWith('activity indicators.')).toBe(true);
  });

  it('⚠️ シンボルを書き忘れた印は、読み飛ばさずに欠陥として返す', () => {
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim]\n// > True for tasks that are not activity` },
    ]) as (Quote & { defect: string })[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.defect).toBe('missing-symbol');
  });

  it('⚠️ 印の後ろに中身が無ければ、読み飛ばさずに欠陥として返す', () => {
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim Options.env]\n\n\n` },
    ]) as (Quote & { defect: string })[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.defect).toBe('empty-quote');
  });

  it('⚠️ 引用を書き忘れて次がコードなら、その行を引用として取る（＝ 当たらないので落ちる）', () => {
    // 「引用らしさ」で選り分けない: 網から漏れた印が静かに検査されなくなるため。
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim Options.env]\nconst a = 1;` },
    ]) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.quote).toBe('const a = 1;');
    expect(findQuoteDefects(quotes, FAKE_SDK)).toHaveLength(1);
  });
});

describe('check-sdk-quotes: findQuoteDefects', () => {
  const quoteOf = (content: string) => collectMarkedQuotes([{ path: 'a.ts', content }]);

  it('当たる引用は欠陥にならない', () => {
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
        '// > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
      ].join('\n'),
    );
    expect(findQuoteDefects(quotes, FAKE_SDK)).toEqual([]);
  });

  it('⚠️ これが本題: 版が上がって文言が変わった引用を落とす（#639 で実際に起きた形）', () => {
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
        '// > True for housekeeping tasks the CLI does not surface as user work (every skip_transcript task, plus auto-started live-update watchers); hosts should exclude them from activity indicators.',
      ].join('\n'),
    );
    const defects = findQuoteDefects(quotes, FAKE_SDK) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0]!.reason).toContain('当たらない');
  });

  it('⚠️ 引用に取るのは印の次の1行だけ（折り返した2行目は見ない ＝ 引用は1行に収めること）', () => {
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
        '// > True for tasks that are not activity (every skip_transcript task, plus every',
        '// > live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
      ].join('\n'),
    ) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.quote).toBe(
      'True for tasks that are not activity (every skip_transcript task, plus every',
    );
  });

  it('⚠️ 折り返しで文が繋ぎ変わった引用は落ちる（当たらない引用は、無い引用より悪い）', () => {
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
        '// > True for tasks that are not activity (every skip_transcript task, plus auto-started live-update watchers); hosts should exclude them from activity indicators.',
      ].join('\n'),
    );
    expect(findQuoteDefects(quotes, FAKE_SDK)).toHaveLength(1);
  });

  it('文言は生きていても、シンボルが消えていれば落とす', () => {
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKRenamedAwayMessage]`,
        '// > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
      ].join('\n'),
    );
    const defects = findQuoteDefects(quotes, FAKE_SDK) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0]!.reason).toContain('sdk.d.ts に無い');
  });

  it('シンボルを書き忘れた印・引用の取れない印も落ちる', () => {
    expect(findQuoteDefects(quoteOf(`// [sdk-verbatim]`), FAKE_SDK)).toHaveLength(1);
    expect(findQuoteDefects(quoteOf(`// [sdk-verbatim Options.env]\n\n\n`), FAKE_SDK)).toHaveLength(
      1,
    );
  });

  it('union 末尾に値が足されたら検出する（#793: 直す前は見逃していた欠陥）', () => {
    const quotes = quoteOf([`// [sdk-verbatim FakeUnion]`, `// > 'a' | 'b' | 'c'`].join('\n'));
    const newDeclaration = "export declare type FakeUnion = 'a' | 'b' | 'c' | 'd';";
    const defects = findQuoteDefects(quotes, newDeclaration) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0]!.reason).toContain('#793');
  });

  it('union 先頭が削られても検出する（#793 の対称形: 隣接する `|` は前後どちらも見る）', () => {
    const quotes = quoteOf([`// [sdk-verbatim FakeUnion]`, `// > 'a' | 'b' | 'c'`].join('\n'));
    const newDeclaration = "export declare type FakeUnion = 'z' | 'a' | 'b' | 'c';";
    const defects = findQuoteDefects(quotes, newDeclaration) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0]!.reason).toContain('#793');
  });

  it('union として閉じた引用（前後が `|` に接続しない）は依然として欠陥にならない', () => {
    const quotes = quoteOf([`// [sdk-verbatim FakeUnion]`, `// > 'a' | 'b' | 'c'`].join('\n'));
    const newDeclaration = "export declare type FakeUnion = 'a' | 'b' | 'c';";
    expect(findQuoteDefects(quotes, newDeclaration)).toEqual([]);
  });

  it('同じ文字列が複数箇所に出ても、1箇所でも `|` に接続しなければ欠陥にならない（誤検出を避ける）', () => {
    const quotes = quoteOf([`// [sdk-verbatim FakeUnion]`, `// > 'a' | 'b' | 'c'`].join('\n'));
    const sdkTypesText = [
      "export declare type StaleCopy = 'a' | 'b' | 'c' | 'd';",
      "export declare type FakeUnion = 'a' | 'b' | 'c';",
    ].join('\n');
    expect(findQuoteDefects(quotes, sdkTypesText)).toEqual([]);
  });

  it.each([
    ['先頭', "'a'"],
    ['中間', "'c'"],
    ['末尾', "'e'"],
  ])(
    '単一値の引用（union の%s の値）は union が伸びても欠陥にならない（#995）',
    (_label, quote) => {
      const quotes = quoteOf([`// [sdk-verbatim FakeUnion5]`, `// > ${quote}`].join('\n'));
      const base = "export declare type FakeUnion5 = 'a' | 'b' | 'c' | 'd' | 'e';";

      expect(findQuoteDefects(quotes, base)).toEqual([]);
      expect(findQuoteDefects(quotes, base.replace(';', " | 'f';"))).toEqual([]);
      expect(findQuoteDefects(quotes, base.replace("'a'", "'z' | 'a'"))).toEqual([]);
    },
  );

  it('⚠️ ただし引用した値そのものが消えれば、単一値の引用でも欠陥になる（#995: 部分文字列一致がそのまま拾う）', () => {
    const quotes = quoteOf([`// [sdk-verbatim FakeUnion5]`, `// > 'c'`].join('\n'));
    const withoutC = "export declare type FakeUnion5 = 'a' | 'b' | 'd' | 'e';";
    const defects = findQuoteDefects(quotes, withoutC) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0]!.reason).toContain('当たらない');
  });
});

describe('check-sdk-quotes: 引用行の探し方（空行を跨ぐ）', () => {
  it('印と引用のあいだの空行を跨いで拾う（Markdown はブロック引用の前に空行が要る）', () => {
    const content = [
      '  > [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]',
      '',
      '  > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
    ].join('\n');
    const quotes = collectMarkedQuotes([{ path: 'AGENTS.md', content }]) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.quote?.startsWith('True for tasks that are not activity')).toBe(true);
  });

  it('⚠️ 跨ぐ幅は狭い — 遠くの英文を拾って「たまたま当たる」ことがない', () => {
    const content = [
      '// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]',
      '',
      '',
      '',
      '// > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
    ].join('\n');
    const quotes = collectMarkedQuotes([{ path: 'a.ts', content }]) as (Quote & {
      defect: string;
    })[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.defect).toBe('empty-quote');
  });
});

describe('check-sdk-quotes: listScannableFiles（Issue #1817: 未追跡ファイルも見る）', () => {
  async function initRepo(): Promise<string> {
    const dir = await makeTempDir('check-sdk-quotes-1817-');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    return dir;
  }

  function git(dir: string, ...args: string[]) {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
  }

  it('走査しない拡張子と、この検査自身は外す（未追跡ファイルにも同じ絞り込みが掛かる）', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lock\n');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'check-sdk-quotes-core.mjs'), 'ignored\n');
    await writeFile(join(dir, 'scripts', 'check-sdk-quotes.test.ts'), 'ignored\n');
    await writeFile(join(dir, 'scripts', 'verify-core.mjs'), 'kept\n');
    const files = listScannableFiles(dir) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['scripts/verify-core.mjs']);
  });

  it('🔴（直す前の形）: 素の `git ls-files -z`（追跡済みのみ）は未追跡ファイルを見落とす', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'tracked.ts'), '// [sdk-verbatim Foo]\n// > old quote\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    await writeFile(join(dir, 'new-untracked.ts'), '// [sdk-verbatim Foo]\n// > this is wrong\n');

    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');

    const oldFiles = oldForm
      .filter((p) => p.endsWith('.ts'))
      .map((p) => ({ path: p, content: readFileSync(join(dir, p), 'utf8') }));
    const oldQuotes = collectMarkedQuotes(oldFiles);
    const oldDefects = findQuoteDefects(
      oldQuotes,
      'export declare type Foo = string; // old quote',
    );
    expect(oldDefects).toEqual([]);
  });

  it('🟢（直した後）: listScannableFiles は同じ新規ファイルを対象に入れ、違反を検出する', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'tracked.ts'), '// [sdk-verbatim Foo]\n// > old quote\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    await writeFile(join(dir, 'new-untracked.ts'), '// [sdk-verbatim Foo]\n// > this is wrong\n');

    const files = listScannableFiles(dir) as { path: string }[];
    expect(files.map((f) => f.path)).toContain('new-untracked.ts');

    const quotes = collectMarkedQuotes(files);
    const defects = findQuoteDefects(quotes, 'export declare type Foo = string; // old quote') as {
      path: string;
    }[];
    expect(defects.map((d) => d.path)).toContain('new-untracked.ts');
  });

  it('⚠️ symlink を外す（未追跡の symlink + 実体の両方があっても1回だけ数える）', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'real.ts'), 'export const a = 1;\n');
    symlinkSync('real.ts', join(dir, 'link.ts'));

    const files = listScannableFiles(dir) as { path: string }[];
    const paths = files.map((f) => f.path);
    expect(paths).toContain('real.ts');
    expect(paths).not.toContain('link.ts');
    expect(paths.filter((p) => p === 'real.ts')).toHaveLength(1);
  });

  it('追跡済みの symlink でも、今までどおり重複を除く（`git add` 後）', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'real.ts'), 'export const a = 1;\n');
    symlinkSync('real.ts', join(dir, 'link.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init: real + symlink');

    const files = listScannableFiles(dir) as { path: string }[];
    const paths = files.map((f) => f.path);
    expect(paths).toContain('real.ts');
    expect(paths).not.toContain('link.ts');
  });

  it('作業ツリーに無い追跡済みファイル（削除したが commit していない）は、落とさずに飛ばす', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'gone.ts'), '// [sdk-verbatim Foo]\n// > old quote\n');
    await writeFile(join(dir, 'stays.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    await rm(join(dir, 'gone.ts'));

    let files: { path: string }[] = [];
    expect(() => {
      files = listScannableFiles(dir) as { path: string }[];
    }).not.toThrow();
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('gone.ts');
    expect(paths).toContain('stays.ts');
  });
});

describe('check-sdk-quotes: 走査範囲', () => {
  it('この検査自身だけを除外している（除外を広げたらここが落ちる）', () => {
    expect(EXCLUDED_PREFIXES).toEqual(['scripts/check-sdk-quotes']);
  });

  it('ソースと文書の両方を見る', () => {
    expect(SCANNED_EXTENSIONS).toContain('.ts');
    expect(SCANNED_EXTENSIONS).toContain('.md');
  });
});

describe('check-sdk-quotes: resolveSdkTypes — 「見つからない」を緑にしない', () => {
  // 実物（本物の `createRequire`）で測らず依存を注入する: vitest は自前のモジュール解決を差し込み、素の node なら `MODULE_NOT_FOUND` になる引き方でも解決が通ってしまうため。
  const throwingRequire = () => ({
    resolve() {
      const error = new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'") as Error & {
        code?: string;
      };
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    },
  });

  it('⚠️ SDK を解決できなければ投げる（黙って空の結果を返さない）', () => {
    expect(() =>
      resolveSdkTypes(
        '/repo',
        throwingRequire,
        () => true,
        () => '',
      ),
    ).toThrow(/見つからない/);
  });

  it('投げる例外は「どこを試したか」を持つ（次に来た人が直せる形で落ちる）', () => {
    let message = '';
    try {
      resolveSdkTypes(
        '/repo',
        throwingRequire,
        () => true,
        () => '',
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('packages/core');
    expect(message).toContain('apps/daemon');
    expect(message).toContain('apps/runner');
    expect(message).toContain('MODULE_NOT_FOUND');
  });

  it('⚠️ 解決はできても型定義のファイルが無ければ投げる（sdk-tools.d.ts が片方欠けても）', () => {
    const require = () => ({ resolve: () => '/x/node_modules/@anthropic-ai/sdk/sdk.mjs' });
    const onlySdkDts = (path: string) => path.endsWith('/sdk.d.ts');
    expect(() => resolveSdkTypes('/repo', require, onlySdkDts, () => '')).toThrow(
      /sdk-tools\.d\.ts/,
    );
  });

  it('2枚とも在れば、両方の中身を連結して返す（片方だけ読むと誤判定になる）', () => {
    const require = () => ({ resolve: () => '/x/node_modules/@anthropic-ai/sdk/sdk.mjs' });
    const read = (path: string) => {
      if (path.endsWith('package.json')) return '{"version":"9.9.9"}';
      if (path.endsWith('sdk-tools.d.ts')) return 'TOOLS_TEXT';
      return 'SDK_TEXT';
    };
    const sdk = resolveSdkTypes('/repo', require, () => true, read) as {
      version: string;
      text: string;
      typesPath: string;
    };
    expect(sdk.version).toBe('9.9.9');
    expect(sdk.text).toContain('SDK_TEXT');
    expect(sdk.text).toContain('TOOLS_TEXT');
    expect(sdk.typesPath).toContain('sdk-tools.d.ts');
  });
});

describe('実物の検査（インストール済みの sdk.d.ts に当てる）', () => {
  const REPO_ROOT = join(import.meta.dirname, '..');

  it('印の付いた逐語がすべて、いまの SDK の sdk.d.ts に当たる', () => {
    // 見つからなければ投げる: スキップすると「0件」と「走らなかった」が混ざるため。
    const sdk = resolveSdkTypes(REPO_ROOT, createRequire, existsSync, readFileSync) as {
      typesPath: string;
      version: string;
      text: string;
    };
    expect(sdk.text.length).toBeGreaterThan(1000);

    const files = listScannableFiles(REPO_ROOT) as { path: string }[];
    expect(files.length).toBeGreaterThan(100);

    const quotes = collectMarkedQuotes(files) as Quote[];
    expect(quotes.length).toBeGreaterThan(0);

    const defects = findQuoteDefects(quotes, sdk.text) as Defect[];
    expect(
      defects.map((d) => `${d.path}:${d.line} ${d.reason}\n    ${d.quote ?? ''}`),
      `SDK ${sdk.version}（${sdk.typesPath}）と食い違う ${MARKER} が在る`,
    ).toEqual([]);
  });
});
