import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない検査スクリプト）を読む
import {
  collectMarkedQuotes,
  EXCLUDED_PREFIXES,
  findQuoteDefects,
  listScannableFiles,
  MARKER,
  resolveSdkTypes,
  SCANNED_EXTENSIONS,
} from './check-sdk-quotes-core.mjs';

/**
 * `check-sdk-quotes` の歯。
 *
 * **2段構えである**（`check-web-css-comment-classnames.test.ts` と同じ形）。
 *
 * 1. **判定ロジックの単体テスト** — 合成した文字列で当たり判定だけを確かめる
 * 2. **実物に対する検査そのもの**（下の `describe('実物の検査')`）—
 *    **この歯はワークフローを変更せずに CI へ足す**ため、`pnpm test`（vitest）が
 *    実行するこの test ファイル自身の中で、インストール済みの `sdk.d.ts` を読んで
 *    repo 全体の印を当てる。**`sdk.d.ts` が見つからないときは黙ってスキップせず
 *    投げる** — スキップすると「引用が0件だった」と「検査が走らなかった」が
 *    区別できなくなる（`AGENTS.md`「静かに失敗する道具」）。
 *
 * **この test ファイルと `check-sdk-quotes*.mjs` は走査対象から外してある**
 * （`EXCLUDED_PREFIXES`）。外さないと、下の合成フィクスチャに書いた印を
 * 実物の引用として当てにいって落ちる。
 */

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
    expect(quotes[0].symbol).toBe('SDKBackgroundTasksChangedMessage.ambient');
    expect(quotes[0].quote).toBe(
      'True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.',
    );
  });

  it('同じ行の鉤括弧（日本語の文中に埋め込んだ形）を拾う', () => {
    const content =
      '// `ambient` の欄も逐語で引く: 「True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.」 [sdk-verbatim ambient]';
    const quotes = collectMarkedQuotes([{ path: 'a.ts', content }]) as Quote[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].quote?.startsWith('True for tasks that are not activity')).toBe(true);
    expect(quotes[0].quote?.endsWith('activity indicators.')).toBe(true);
  });

  it('⚠️ シンボルを書き忘れた印は、読み飛ばさずに欠陥として返す', () => {
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim]\n// > True for tasks that are not activity` },
    ]) as (Quote & { defect: string })[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].defect).toBe('missing-symbol');
  });

  it('⚠️ 印の後ろに中身が無ければ、読み飛ばさずに欠陥として返す', () => {
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim Options.env]\n\n\n` },
    ]) as (Quote & { defect: string })[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].defect).toBe('empty-quote');
  });

  it('⚠️ 引用を書き忘れて次がコードなら、その行を引用として取る（＝ 当たらないので落ちる）', () => {
    // **「引用らしさ」で選り分けない。** 選り分けると、選り分けの網から漏れた印が
    // 静かに検査されなくなる。**取ったうえで当たらないほうが、赤くなるだけ良い。**
    const quotes = collectMarkedQuotes([
      { path: 'a.ts', content: `// [sdk-verbatim Options.env]\nconst a = 1;` },
    ]) as Quote[];
    expect(quotes[0].quote).toBe('const a = 1;');
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
    // 0.3.259 の文言。0.3.261 では消えている。
    const quotes = quoteOf(
      [
        `// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]`,
        '// > True for housekeeping tasks the CLI does not surface as user work (every skip_transcript task, plus auto-started live-update watchers); hosts should exclude them from activity indicators.',
      ].join('\n'),
    );
    const defects = findQuoteDefects(quotes, FAKE_SDK) as Defect[];
    expect(defects).toHaveLength(1);
    expect(defects[0].reason).toContain('当たらない');
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
    expect(quotes[0].quote).toBe(
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
    expect(defects[0].reason).toContain('sdk.d.ts に無い');
  });

  it('シンボルを書き忘れた印・引用の取れない印も落ちる', () => {
    expect(findQuoteDefects(quoteOf(`// [sdk-verbatim]`), FAKE_SDK)).toHaveLength(1);
    expect(findQuoteDefects(quoteOf(`// [sdk-verbatim Options.env]\n\n\n`), FAKE_SDK)).toHaveLength(
      1,
    );
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
    expect(quotes[0].quote?.startsWith('True for tasks that are not activity')).toBe(true);
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
    expect(quotes[0].defect).toBe('empty-quote');
  });
});

describe('check-sdk-quotes: listScannableFiles', () => {
  // `git ls-files -sz` の出力の形（`<mode> <sha> <stage>\t<path>\0`）を模す。
  const lsFiles = (entries: string[]) => () => entries.join('\0') + '\0';

  it('⚠️ symlink を外す（`CLAUDE.md` → `AGENTS.md` を2度数えない）', () => {
    const listed = lsFiles([
      '100644 aaaaaaa 0\tAGENTS.md',
      '120000 bbbbbbb 0\tCLAUDE.md',
      '100644 ccccccc 0\tpackages/core/src/a.ts',
    ]);
    const files = listScannableFiles('/repo', listed, () => 'content') as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md', 'packages/core/src/a.ts']);
  });

  it('走査しない拡張子と、この検査自身は外す', () => {
    const listed = lsFiles([
      '100644 aaaaaaa 0\tpnpm-lock.yaml',
      '100644 bbbbbbb 0\tscripts/check-sdk-quotes-core.mjs',
      '100644 ccccccc 0\tscripts/check-sdk-quotes.test.ts',
      '100644 ddddddd 0\tscripts/verify-core.mjs',
    ]);
    const files = listScannableFiles('/repo', listed, () => 'content') as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['scripts/verify-core.mjs']);
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
  /**
   * **⚠️ ここを実物（本物の `createRequire`）で測ってはいけない。**
   *
   * 変異試験で分かったこと（2026-09-05 実測）: `anchors` を存在しないパスへ差し替える
   * 変異を当てても、**vitest の中では `createRequire(...).resolve()` が成功してしまう**
   * （vitest は自前のモジュール解決を差し込むので、素の node で
   * `MODULE_NOT_FOUND` になる引き方でも解決が通る）。素の node で走る CLI
   * （`pnpm check:sdk-quotes`）では同じ変異が exit 1 になるのに、**vitest 側では
   * 緑のまま通る** — つまり「実物で当てる」だけでは、この分岐は測れない。
   *
   * **だから依存を注入して測る。** `resolveSdkTypes` が `createRequire` /
   * `existsSync` / `readFileSync` を引数で受けているのは、この分岐を器に
   * 依存せず固定するためである。**引数を減らして `import` に戻さないこと。**
   */
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
    // **見つからなければ投げる。**スキップすると「0件」と「走らなかった」が混ざる。
    const sdk = resolveSdkTypes(REPO_ROOT, createRequire, existsSync, readFileSync) as {
      typesPath: string;
      version: string;
      text: string;
    };
    expect(sdk.text.length).toBeGreaterThan(1000);

    const files = listScannableFiles(REPO_ROOT, execFileSync, readFileSync) as { path: string }[];
    // **走査そのものが空振りしていないことを先に確かめる**（glob を壊した回に緑で通らない）。
    expect(files.length).toBeGreaterThan(100);

    const quotes = collectMarkedQuotes(files) as Quote[];
    // **印が1つも無ければ、それは「腐らない」ではなく「見ていない」である。**
    // 引用を本当に全部消したのなら、この行を意図して直すこと。
    expect(quotes.length).toBeGreaterThan(0);

    const defects = findQuoteDefects(quotes, sdk.text) as Defect[];
    expect(
      defects.map((d) => `${d.path}:${d.line} ${d.reason}\n    ${d.quote ?? ''}`),
      `SDK ${sdk.version}（${sdk.typesPath}）と食い違う ${MARKER} が在る`,
    ).toEqual([]);
  });
});
