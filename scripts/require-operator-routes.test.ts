import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **`requireOperator` が配線されている経路の集合を、決め打ちのリテラル一覧と
 * 突き合わせる歯。**
 *
 * `apps/daemon/src/app.ts` の入口の門は2段ある——`authenticate`（ログイン済みで
 * あれば通す）と `requireOperator`（実行環境の持ち主だけに絞る、より強い門）。
 * どの経路が後者を通るかは配線（`.get(...)` / `.put(...)` の引数）そのものに
 * しか正本が無いので、**配線を直接読んで、期待と食い違ったら落ちる**歯を置く。
 *
 * ## なぜ正規表現ではなく TypeScript の AST を読むか
 *
 * **この歯は、この repo で最初に構文木を読む歯である**（実測 2026-09-07:
 * `grep -rln "from 'typescript'" scripts/ apps/ packages/` の一致はこの
 * ファイル1本だけだった）。既存の走査系の歯は生テキストを読む形で済ませて
 * いるので、**倣わなかった理由をここに残す。**
 *
 * **実測（2026-09-07）**: `apps/daemon/src/app.ts` に `requireOperator` という
 * 語が現れる行は **20行**。そのうち実際にコードなのは **3行だけ**
 * （`const requireOperator = createMiddleware(...)` の宣言1行 + `.get('/profile', ...)`
 * / `.put('/profile', ...)` の配線2行）で、**残り17行はすべてコメントの散文**
 * ——「2026-09-06 のオーナー決定で `/tokens` `/access/*` は `requireOperator` を
 * 外れた」「資格は `authenticate` だけ（`requireOperator` は付けない）」等、
 * *外した*ことを説明する文が大半を占める。
 *
 * ⟹ 生テキストへの正規表現（「この行に `requireOperator` が現れるか」）は、
 * この散文を配線と読み違える**誤陽性の工場**になる。しかも誤って通る方向
 * （実際には配線されていない経路を「配線されている」と誤検出する）ではなく、
 * 誤って落ちる方向（無関係な散文の増減にテストが反応する）にも壊れうる——
 * どちらの向きに壊れても、次にこの歯を読んだ人は「歯を直す」のではなく
 * 「歯を弱める」（緩い正規表現に変える・該当行を除外リストへ足す）方向へ誘導
 * される。**弱められた歯は、次に本当に配線が変わったときに鳴らない。**
 * だから最初から、散文と構文を取り違えようのない道具（構文木）を選ぶ。
 *
 * **なぜ独立 CLI（`*-core.mjs` への切り出し）にしないか。** この repo で3分割
 * している検査は、`package.json` に `check:*` を持ち **CI から vitest とは別に
 * 直接叩かれる**もの（`check:sdk-quotes` / `check:web-bundle-node-traces` /
 * `check:web-bundle-size` / `check:web-css-comment-classnames` の4本）に限られて
 * いる。この歯は vitest 専用の突き合わせで、他から叩く理由が無いので
 * `.test.ts` 内に直書きする
 * （`journal-store-with-contract-registry.test.ts` / `conversation-window-single-source.test.ts`
 * と同じ形）。
 *
 * ## 抽出漏れを塞ぐ検算（このテストの中でいちばん壊れやすい前提）
 *
 * **抽出が新しい配線の書き方を拾い損ねると、この歯は黙って緑のままになる。**
 * 拾えなかった配線は抽出結果に現れず、リテラル一覧も更新されないので、両者は
 * 「一致」し続ける——*測っていないことが、測って合格したことと同じ見た目に
 * なる*。これがいちばん危険な
 * 壊れ方なので、`apps/daemon/src/app.ts` の AST に現れる `requireOperator`
 * という Identifier の参照数（宣言そのものを除く）を別ルートで数え、
 * **経路へ紐付けられた数と一致することを検算する**（下の
 * 「`requireOperator` の参照数と一致する」テスト）。ここが割れたら、
 * 「配線が増えた」のではなく「抽出の定義が現物に追いついていない」と
 * 読むこと。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_TS_PATH = path.join(ROOT, 'apps/daemon/src/app.ts');

/** `requireOperator` の実際の名前。テスト内で1箇所にしておく（typo で歯自体が死ぬのを防ぐ）。 */
const OPERATOR_MIDDLEWARE_NAME = 'requireOperator';

/** Hono のチェーンとして経路の宣言とみなす、プロパティ名の集合。 */
const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch']);

export interface RouteDeclaration {
  /** `` `${METHOD} ${path}` ``（例 `GET /profile`）。 */
  route: string;
  /** 引数のいずれかが `requireOperator` という名前の Identifier だったか。 */
  wired: boolean;
}

/**
 * TypeScript のソースを AST に起こす。`setParentNodes: true` が要る
 * ——下の `countRequireOperatorReferences` が `node.parent` を読むため
 * （これを渡さないと `parent` が `undefined` のままで判定できない）。
 */
function parseSource(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * 経路の宣言とみなす CallExpression を AST 全体から拾う。
 *
 * 条件（依頼の定義そのまま）:
 * - 呼び出し先が PropertyAccessExpression で、プロパティ名が
 *   `get` / `post` / `put` / `delete` / `patch` のいずれか
 * - 第1引数が文字列リテラルで、`/` から始まる
 *
 * その CallExpression の引数のいずれかが `requireOperator` という名前の
 * Identifier であれば `wired: true`。
 */
export function findRouteDeclarations(sourceText: string, fileName = 'app.ts'): RouteDeclaration[] {
  const sourceFile = parseSource(sourceText, fileName);
  const routes: RouteDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHOD_NAMES.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      const firstArg = node.arguments[0];
      if (firstArg !== undefined && ts.isStringLiteral(firstArg) && firstArg.text.startsWith('/')) {
        const wired = node.arguments.some(
          (arg) => ts.isIdentifier(arg) && arg.text === OPERATOR_MIDDLEWARE_NAME,
        );
        routes.push({ route: `${method.toUpperCase()} ${firstArg.text}`, wired });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

/** `findRouteDeclarations` のうち `requireOperator` が配線されているものだけ。 */
export function findOperatorWiredRoutes(sourceText: string, fileName = 'app.ts'): string[] {
  return findRouteDeclarations(sourceText, fileName)
    .filter((entry) => entry.wired)
    .map((entry) => entry.route);
}

/**
 * `requireOperator` という名前の Identifier のうち、**宣言（`const requireOperator = …`
 * の変数名そのもの）を除いた参照の総数**を数える。
 *
 * コメント中の `requireOperator` は TypeScript のパーサではトリビア（構文木の
 * ノードにならない）なので、ここには一切数えられない——これが AST を選んだ
 * 理由そのものを裏から支える性質である（fixture の「コメントの中の
 * `requireOperator` を拾わない」テストがこれを直接確かめる）。
 */
export function countRequireOperatorReferences(sourceText: string, fileName = 'app.ts'): number {
  const sourceFile = parseSource(sourceText, fileName);
  let count = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === OPERATOR_MIDDLEWARE_NAME) {
      const isDeclarationName = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!isDeclarationName) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

/**
 * `requireOperator` が配線されている経路のリテラル一覧。
 *
 * **この一覧を変えたら、`docs/architecture.md` の「通る資格は2種類ある」の表も
 * 直す必要がある。**
 *
 * **⚠️ この歯は doc を検査していない。** doc が古びたことは、この歯では
 * *分からない*。できるのは「配線が変わった」と知らせることだけである。
 *
 * **⚠️ そして `docs/` は正典で、AI が単独で書き換えない**
 * （`grep -Fn -- '`docs/` は正典。**AI が単独で書き換えない。**' AGENTS.md`）。
 * **人間へ上げること。**
 */
const EXPECTED_OPERATOR_ROUTES = ['GET /profile', 'PUT /profile'];

/** 比較を配線順（AST の訪問順）に依存させないための整列。 */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// --- 合成 fixture -----------------------------------------------------------
//
// 本物の `apps/daemon/src/app.ts` を壊さずに「この歯が本当に反応するか」を
// 示すための、Hono の実配線の形だけを写した最小のソース。

const FIXTURE_TWO_ROUTES = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  );
`;

/** `FIXTURE_TWO_ROUTES` に `DELETE /profile` の配線を1本足したもの。 */
const FIXTURE_THREE_ROUTES = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .delete(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  );
`;

/** `FIXTURE_TWO_ROUTES` から `PUT /profile` の `requireOperator` 配線を外したもの。 */
const FIXTURE_ONE_ROUTE = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    (c) => c.json({}),
  );
`;

/**
 * `requireOperator` がどの経路にも配線されておらず、**コメントの散文にだけ
 * 名前が現れる**ソース。実際の `app.ts` に在るのと同じ形の散文
 * （「資格は `authenticate` だけ（`requireOperator` は付けない）。」）を
 * 埋め込んである——正規表現ならここで誤検出する。
 */
const FIXTURE_COMMENT_ONLY = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });

/**
 * 実行環境の持ち主だけに絞る門（本物の app.ts には実在するが、この fixture では
 * どの経路にも配線しない——コメントに名前だけ現れる状態を再現する）。
 */
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  /**
   * 資格は authenticate だけ（requireOperator は付けない）。
   */
  .get(
    '/tokens',
    authenticate,
    (c) => c.json({}),
  );
`;

describe('requireOperator が配線されている経路が、決め打ちの一覧と一致する', () => {
  const appTsSource = readFileSync(APP_TS_PATH, 'utf8');

  it('前提: apps/daemon/src/app.ts が読める', () => {
    expect(appTsSource.length).toBeGreaterThan(0);
  });

  it('本物: 抽出した集合がリテラル一覧と一致する（ズレたら app.ts かこのテストのどちらかを直す）', () => {
    const extracted = sorted(findOperatorWiredRoutes(appTsSource));
    const expected = sorted(EXPECTED_OPERATOR_ROUTES);

    const missing = expected.filter((route) => !extracted.includes(route));
    const extra = extracted.filter((route) => !expected.includes(route));

    expect(
      { extracted, missing, extra },
      missing.length === 0 && extra.length === 0
        ? ''
        : [
            missing.length > 0
              ? `リテラル一覧に在るが配線から消えた経路: ${missing.join(', ')}`
              : '',
            extra.length > 0
              ? `配線に新しく現れたがリテラル一覧に無い経路: ${extra.join(', ')}`
              : '',
            'app.ts の requireOperator の配線が変わったなら、このファイルの ' +
              'EXPECTED_OPERATOR_ROUTES を直し、docs/architecture.md の「通る資格は2種類ある」の ' +
              '表も直す必要がないか人間へ確認すること（この歯は doc を検査していない）。',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
    ).toEqual({ extracted: expected, missing: [], extra: [] });
  });

  it('本物: requireOperator の参照数（宣言を除く）が、経路へ紐付けられた数と一致する（抽出漏れの検算）', () => {
    const wiredCount = findOperatorWiredRoutes(appTsSource).length;
    const referenceCount = countRequireOperatorReferences(appTsSource);

    expect(
      referenceCount,
      referenceCount === wiredCount
        ? ''
        : `requireOperator の参照数（${referenceCount}）と、経路として拾えた数（${wiredCount}）が ` +
            '一致しない。配線が在るのに経路として拾えていない可能性が高い —— ' +
            '「配線が増えた」ではなく「抽出の定義が現物に追いついていない」と読むこと ' +
            '（findRouteDeclarations の CallExpression の条件を app.ts の現物と見比べること）。',
    ).toBe(wiredCount);
  });

  it('合成 fixture: 経路を1本足すと抽出結果も1本増える', () => {
    const before = sorted(findOperatorWiredRoutes(FIXTURE_TWO_ROUTES));
    const after = sorted(findOperatorWiredRoutes(FIXTURE_THREE_ROUTES));

    expect(before).toEqual(['GET /profile', 'PUT /profile']);
    expect(after).toEqual(['DELETE /profile', 'GET /profile', 'PUT /profile']);
  });

  it('合成 fixture: 経路を1本消すと抽出結果も1本減る', () => {
    const before = sorted(findOperatorWiredRoutes(FIXTURE_TWO_ROUTES));
    const after = sorted(findOperatorWiredRoutes(FIXTURE_ONE_ROUTE));

    expect(before).toEqual(['GET /profile', 'PUT /profile']);
    expect(after).toEqual(['GET /profile']);
  });

  it('合成 fixture: コメントの中の requireOperator を配線と読み違えない（AST を採った理由そのものの検証）', () => {
    expect(findOperatorWiredRoutes(FIXTURE_COMMENT_ONLY)).toEqual([]);
    // 宣言1つだけが存在し、配線としての参照はゼロ——正規表現ならコメント中の
    // 出現を拾って `wiredCount` と食い違いかねないところを、AST は数えない。
    expect(countRequireOperatorReferences(FIXTURE_COMMENT_ONLY)).toBe(0);
  });
});
