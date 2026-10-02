import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

/**
 * **デーモンと core が stderr へ書く例外の文は `reasonOf(error)` を通す、を固定する歯**（#2512）。
 *
 * `packages/core/src/dropped-record.ts` の `reasonOf` の doc が決めている:
 * 「記録の失敗をログへ出すところは、すべてここを通すこと」。drizzle の
 * `DrizzleQueryError` は `message` の2行目に `params: <束縛パラメータ>` を置き、
 * 書こうとした値がそのまま並ぶ。stderr は器のログ（Railway 等）に残る。
 * 素の `String(error)` / `error.message` を1か所でも置くと、そこだけが無防備になる。
 *
 * ## 何を見るか
 * `apps/daemon/src` と `packages/core/src` の（テストでない）ソースで、
 * `stderr.write(...)` / `writeStderrSync(...)` の**引数の中**に、次のどれかが在れば落とす。
 * - `String(<e|err|error|cause|failure>)`
 * - `<e|err|error|cause|failure>.message`
 * - テンプレートの `${<e|err|error|cause|failure>}`
 *
 * ## 何を見ないか（取りこぼす形）
 * - 一度別の変数へ入れてから書く形（`const message = error.message; … write(message)`）
 * - 関数へ文字列を渡し、その先が stderr へ書く形（`onError(...)` / `warn(...)` / `announce(...)`）
 * - `apps/cli`（利用者自身の端末へ出す文）と `apps/runner`
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);
const SCAN_ROOTS = ['apps/daemon/src/', 'packages/core/src/'];
const ERROR_NAMES = new Set(['e', 'err', 'error', 'cause', 'failure']);

interface BareErrorHit {
  line: number;
  text: string;
}

function isStderrWrite(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'writeStderrSync';
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'write' &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'stderr'
  );
}

/** stderr への書き込みの引数の中にある、素のエラーの文字列化を返す。 */
function findBareErrorStderrWrites(source: string): BareErrorHit[] {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const hits: BareErrorHit[] = [];
  const report = (node: ts.Node): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    hits.push({ line: line + 1, text: node.getText(file) });
  };
  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      ERROR_NAMES.has(node.arguments[0].text)
    ) {
      report(node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      ts.isIdentifier(node.expression) &&
      ERROR_NAMES.has(node.expression.text)
    ) {
      report(node);
    } else if (
      ts.isTemplateSpan(node) &&
      ts.isIdentifier(node.expression) &&
      ERROR_NAMES.has(node.expression.text)
    ) {
      report(node.expression);
    }
    ts.forEachChild(node, inspect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStderrWrite(node.expression)) {
      for (const arg of node.arguments) inspect(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function isScannedSource(rel: string): boolean {
  if (!SCAN_ROOTS.some((prefix) => rel.startsWith(prefix))) return false;
  if (!rel.endsWith('.ts')) return false;
  return !/\.test(-support)?\.ts$/.test(rel) && !rel.endsWith('/testing.ts');
}

describe('findBareErrorStderrWrites（純粋関数）', () => {
  const write = 'process.stderr.write';
  it('String(error) を stderr の引数に置く形を検出する', () => {
    const src = `${write}(\`x: \${String(error)}\\n\`);`;
    expect(findBareErrorStderrWrites(src)).toHaveLength(1);
  });
  it('error.message と複数行の引数も検出する', () => {
    const src = `${write}(\n  \`a（\${error.message}）\` +\n    'b',\n);`;
    const hits = findBareErrorStderrWrites(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });
  it('変数名が違っても（e / err）、テンプレートの素の ${error} も検出する', () => {
    expect(findBareErrorStderrWrites(`${write}(\`\${String(err)}\`);`)).toHaveLength(1);
    expect(findBareErrorStderrWrites(`writeStderrSync(\`\${String(e)}\`);`)).toHaveLength(1);
    expect(findBareErrorStderrWrites(`${write}(\`\${error}\`);`)).toHaveLength(1);
  });
  it('reasonOf を通した形・固定文言・stderr 以外への書き込みは検出しない', () => {
    expect(findBareErrorStderrWrites(`${write}(\`x: \${reasonOf(error)}\`);`)).toHaveLength(0);
    expect(findBareErrorStderrWrites(`${write}('固定文言\\n');`)).toHaveLength(0);
    expect(findBareErrorStderrWrites(`process.stdout.write(\`\${String(error)}\`);`)).toHaveLength(
      0,
    );
    expect(findBareErrorStderrWrites(`const s = String(error);`)).toHaveLength(0);
  });
});

describe('デーモンと core のソースが stderr へ書く例外の文は reasonOf を通す（#2512）', () => {
  it('stderr.write / writeStderrSync の引数に素の String(error) / error.message が無い', () => {
    const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter(isScannedSource);
    // 走査が空振りして「0件で緑」にならないようにする
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((rel) =>
      findBareErrorStderrWrites(readFileSync(path.join(ROOT, rel), 'utf8')).map(
        (hit) => `${rel}:${String(hit.line)}  ${hit.text}`,
      ),
    );
    expect(
      offenders,
      '素のエラーの文字列化が stderr へ出ている。reasonOf(error)（packages/core/src/dropped-record.ts）を通すこと',
    ).toEqual([]);
  });
});
