import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 試験の本体から移行（`migrate` / `migrateOnBoot`）を直に呼ぶなら、`it` の第3引数で期限を明示させる。
// 既定の 5 秒は、空の DB に移行を通すだけで CI の混み具合によって越える（#6164・#6165。同じパッケージの移行の試験は
// `30_000` を書いている）。補助の関数の奥で呼ぶ形は数えない: 呼び先を辿ると、移行を含まない補助まで巻き込んで縛りが曖昧になるため。

const SRC = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_NAMES = new Set(['migrate', 'migrateOnBoot']);
const TEST_NAMES = new Set(['it', 'test']);

function isTestCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return TEST_NAMES.has(callee.text);
  // `it.only` / `it.skip` / `it.concurrent` も同じ形で期限を取る
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    TEST_NAMES.has(callee.expression.text)
  );
}

function callsMigrate(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      MIGRATE_NAMES.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** 移行を直に呼ぶのに期限を明示していない試験（`<ファイル>: <試験の名前>`）。 */
function migrateCallsWithoutTimeout(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const [name, body] = node.arguments;
      if (
        body !== undefined &&
        (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
        callsMigrate(body) &&
        node.arguments.length < 3
      ) {
        hits.push(`${fileName}: ${name === undefined ? '?' : name.getText(file)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe('移行を直に呼ぶ試験は、期限を明示する', () => {
  it('縛りの形: 期限の無い it だけを拾い、期限のある it・移行を呼ばない it は拾わない', () => {
    const source = `
      it('無い', async () => { await migrate(db); });
      it('起動の経路も', async () => { await migrateOnBoot(db, () => undefined); });
      it.only('only も', async () => { await migrate(db); });
      it('有る', async () => { await migrate(db); }, 30_000);
      it('呼ばない', async () => { await db.execute(x); });
      it('名前が似ているだけ', async () => { await stores.migrate(db); });
    `;
    expect(migrateCallsWithoutTimeout('x.test.ts', source)).toEqual([
      "x.test.ts: '無い'",
      "x.test.ts: '起動の経路も'",
      "x.test.ts: 'only も'",
    ]);
  });

  it('storage-pg の試験に、期限の無いものが無い', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((name) =>
      migrateCallsWithoutTimeout(name, readFileSync(path.join(SRC, name), 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
