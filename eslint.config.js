import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// 切り出したパッケージも同じ規則の下に置く: どれも同じブラウザバンドルへ入るので、hooks の規則と `@alteroid/core` の値の import 禁止が守ろうとしているものは、ファイルが `apps/web` の外へ移っても変わらず、`apps/web` だけにすると移した先で同じ事故が素通りするため。
const WEB_UI_DIRS = ['apps/web', 'packages/ui', 'packages/logic', 'packages/swr'];
const WEB_UI_FILES = WEB_UI_DIRS.map((dir) => `${dir}/**/*.{ts,tsx}`);
const WEB_UI_TEST_FILES = WEB_UI_DIRS.map((dir) => `${dir}/**/*.test.{ts,tsx}`);

const CORE_VALUE_IMPORT_BAN = {
  name: '@alteroid/core',
  message:
    '@alteroid/core はサーバ専用のドメイン層を丸ごと再エクスポートしている（index.ts）。' +
    '値の import はブラウザバンドルへそれを引き込む（#294 / #306 の事故）。型なら import type、' +
    '値が要るなら @alteroid/core/usage・@alteroid/core/revision のような軽い口を使うか、' +
    'ファイル内へ値を複製すること。',
  allowTypeImports: true,
};

// `@/` を `packages/ui` の外で使わせない: 画面から `@/components/ui/button` のように書いても通ってしまい、`@alteroid/ui` の公開の口（`exports`）を素通りして中身へ手を入れる経路になるため。
const UI_ALIAS_BAN = {
  group: ['@/*'],
  message:
    '@/ は packages/ui の中だけの別名である。画面・ほかのパッケージからは @alteroid/ui（見た目の部品）か ' +
    '@alteroid/ui/shadcn（shadcn の素の部品）から import すること。',
};

// 切り出した3つのパッケージの依存の向きを決める: 逆向きの import が1本入った瞬間に、見た目の差し替えが通信の層を巻き込まない・ロジックを描画せずに試せる、が崩れ、しかも型検査もテストも緑のまま崩れるため。
const WEB_UI_LAYERS = [
  {
    dir: 'packages/logic',
    forbidden: ['react', 'react-dom', 'swr', '@alteroid/ui', '@alteroid/swr'],
    why: '@alteroid/logic は React・SWR・ほかの Web UI パッケージを知らない層である（描画せずに試せることが分けた理由）。',
    banUiAlias: true,
  },
  {
    dir: 'packages/ui',
    forbidden: ['swr', '@alteroid/swr', '@alteroid/logic', '@alteroid/api-client'],
    why: '@alteroid/ui は API を知らない見た目の層である。データは props で受け取ること。',
  },
  {
    dir: 'packages/swr',
    forbidden: ['@alteroid/ui'],
    why: '@alteroid/swr は見た目を知らない通信の層である。',
    banUiAlias: true,
  },
];

// 層の禁止をテストとそれ以外の2つの設定に分ける: flat config は同じ規則名を後の設定で書くと前の選択肢が丸ごと置き換わるため、テスト以外には `CORE_VALUE_IMPORT_BAN` を載せ直さないと、下の `WEB_UI_FILES` の禁止を黙って消す。
function layerImportRules({ dir, forbidden, why, banUiAlias = false }) {
  const layerPaths = forbidden.map((name) => ({ name, message: why }));
  const layerPatterns = [
    {
      group: forbidden.filter((name) => name.startsWith('@alteroid/')).map((name) => `${name}/*`),
      message: why,
    },
  ]
    .filter((pattern) => pattern.group.length > 0)
    .concat(banUiAlias ? [UI_ALIAS_BAN] : []);
  const rule = (paths) => ({
    '@typescript-eslint/no-restricted-imports': ['error', { paths, patterns: layerPatterns }],
  });
  return [
    {
      files: [`${dir}/**/*.{ts,tsx}`],
      ignores: [`${dir}/**/*.test.{ts,tsx}`],
      rules: rule([CORE_VALUE_IMPORT_BAN, ...layerPaths]),
    },
    {
      files: [`${dir}/**/*.test.{ts,tsx}`],
      rules: rule(layerPaths),
    },
  ];
}

// 子プロセスへ親の env を丸ごと渡さない（#1935・#1854・#1971・#2042）: 渡すと、開発者の機械の `GIT_*`・`CLAUDE_*` などが試験へ漏れて、機械ごとに結果が変わり、本物の認証情報を使う試験にもなるため。対象は試験・試験の補助・mutation-testing の `.mjs`。
const PROCESS_ENV = "MemberExpression[object.name='process'][property.name='env']";
// `process.env` を、そのまま・型アサーションで包んで（丸括弧は AST に出ない）値に置く形。
const processEnvAt = (parent) => [
  `${parent} > ${PROCESS_ENV}`,
  `${parent} > TSAsExpression > ${PROCESS_ENV}`,
];
// `env` というキー: `env:`・`'env':`・`['env']:`・`` [`env`]: ``。
const ENV_KEYS = [
  "[key.name='env'][computed=false]",
  "[key.value='env']",
  "[key.quasis.0.value.cooked='env']",
];
// env を指定しない子プロセスの呼び（options が無い・options が env もスプレッドも持たないオブジェクト）。import は追わず、素の名前と `cp.` 系の名前空間だけを見る（別名 import は見ない。`promisify` 経由は下で禁じる）。
const CP_NAMES = '/^(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/';
const CP_CALLEE = `:matches([callee.name=${CP_NAMES}], [callee.object.name=/^(cp|childProcess|child_process)$/][callee.property.name=${CP_NAMES}])`;
const ARGS_FAMILY_CALLEE =
  ':matches([callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork)$/], [callee.property.name=/^(spawn|spawnSync|execFile|execFileSync|fork)$/])';
const NO_ENV_OBJECT =
  'ObjectExpression:not(:has(> Property[key.name="env"])):not(:has(> SpreadElement))';
const ENV_PASSTHROUGH_MESSAGE =
  '子プロセスへ親の env を丸ごと渡さない。`{ PATH: process.env.PATH ?? "" }` のように要る変数だけを渡すか、`gitChildEnv()` を使うこと（#1854）。';
const ENV_MISSING_MESSAGE =
  '子プロセスの呼びに env を指定すること: 指定しないと親の env を丸ごと継ぐ。`gitChildEnv()` か、要る変数だけの env を渡すこと（#1971）。';
const ENV_PASSTHROUGH_SELECTORS = [
  ...processEnvAt('SpreadElement'),
  ...ENV_KEYS.flatMap((key) => processEnvAt(`Property${key}`)),
  `CallExpression[callee.object.name='Object'][callee.property.name='assign'] > ${PROCESS_ENV}.arguments`,
].map((selector) => ({ selector, message: ENV_PASSTHROUGH_MESSAGE }));
const ENV_MISSING_SELECTORS = [
  `CallExpression${CP_CALLEE}[arguments.length=1]`,
  `CallExpression${ARGS_FAMILY_CALLEE}[arguments.length=2][arguments.1.type='ArrayExpression']`,
  `CallExpression${CP_CALLEE}[arguments.length=2][arguments.1.type=/Function/]`,
  `CallExpression${ARGS_FAMILY_CALLEE}[arguments.length=3][arguments.1.type='ArrayExpression'][arguments.2.type=/Function/]`,
  `CallExpression${CP_CALLEE} > ${NO_ENV_OBJECT}.arguments`,
].map((selector) => ({ selector, message: ENV_MISSING_MESSAGE }));
// `promisify(execFile)` を禁じる: 別名（`run`）越しの呼びは、上の規則が env を指定したかを見られず、見逃しの口になるため。コールバックの `execFile(cmd, args, { env }, cb)` を `new Promise` で包むこと。
const PROMISIFY_CALL = ":matches([callee.name='promisify'], [callee.property.name='promisify'])";
const PROMISIFY_CHILD_PROCESS_SELECTORS = [
  `CallExpression${PROMISIFY_CALL} > Identifier.arguments[name=/^(exec|execFile)$/]`,
  `CallExpression${PROMISIFY_CALL} > MemberExpression.arguments[property.name=/^(exec|execFile)$/]`,
].map((selector) => ({
  selector,
  message:
    '`promisify(execFile)` は使わない: 別名越しの呼びは env の指定を lint が見られない（#1971）。`new Promise` で包んだ `execFile(cmd, args, { env }, callback)` を書くこと。',
}));

// 親の env を丸ごと継ぐこと自体が前提の3件だけ `off` にする。
// - `.github/scripts/update-claude-sdk.test.ts`: `gitIsolatedEnv()` は git の identity（`GIT_AUTHOR_*` / `GIT_COMMITTER_*`）の優先順位を測る歯で、identity 系の鍵だけを落として残りをそのまま通す設計（#1854 の領域 D のコメントが「直さないと決めたもの」とした）。
// - `apps/daemon/src/runner-client.test.ts`・`vitest.env-scrub.test.ts`: 別担当の領域として #1854 のコメントが触らないと決めたもの。
const ENV_PASSTHROUGH_ALLOWED_FILES = [
  '.github/scripts/update-claude-sdk.test.ts',
  'apps/daemon/src/runner-client.test.ts',
  'vitest.env-scrub.test.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/*.d.ts',
      '**/build/',
      '**/.react-router/',
      '**/storybook-static/',
      'packages/core/src/generated/',
      // `.scratch/` も外す: `.gitignore` / `.prettierignore` と揃えておかないと、`.scratch/` に `.ts` を置くと `pnpm lint` が落ちるため。
      '**/.scratch/',
      // `.gitignore` が外している共有の置き場も外す: どれも中身次第で `pnpm lint` を落とすため。
      'workspace/',
      '**/coverage/',
      '.pnpm-store/',
      '.mutation-testing/',
      '.idea/',
      '.vscode/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: WEB_UI_FILES,
    extends: [reactHooks.configs.flat.recommended],
  },
  // `@alteroid/core`（バレル export）を Web UI から値で import させない: `index.ts` がサーバ専用のドメイン層を丸ごと再エクスポートしており、値で import するとブラウザバンドルへ引き込んで本番でルートが開けなくなり、型検査は検出しないため（`import type` は build で消える）。`allowTypeImports: true` で型だけの import は通す。
  // `*.test.{ts,tsx}` は対象外: ルーティングされずブラウザバンドルに入らないため。
  {
    files: WEB_UI_FILES,
    ignores: WEB_UI_TEST_FILES,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [CORE_VALUE_IMPORT_BAN],
          patterns: [UI_ALIAS_BAN],
        },
      ],
    },
  },
  ...WEB_UI_LAYERS.flatMap(layerImportRules),
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.test-support.{ts,tsx}',
      '**/test-support.{ts,tsx}',
      '.claude/skills/mutation-testing/*.mjs',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ENV_PASSTHROUGH_SELECTORS,
        ...ENV_MISSING_SELECTORS,
        ...PROMISIFY_CHILD_PROCESS_SELECTORS,
      ],
    },
  },
  { files: ENV_PASSTHROUGH_ALLOWED_FILES, rules: { 'no-restricted-syntax': 'off' } },
  prettier,
);
