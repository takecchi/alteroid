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
  // TUI（`apps/cli/src/tui`）には hooks の規則だけを掛ける: 依存配列の取りこぼしは「古い値をつかんだまま動き続ける」形で出て目視では見つからず、Web UI の他の規則（core の値 import 禁止・層の向き）はブラウザバンドルの話なため。
  {
    files: ['apps/cli/src/tui/**/*.{ts,tsx}'],
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
  prettier,
);
