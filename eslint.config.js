import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/*.d.ts',
      // apps/web の生成物。`build/` は react-router の出力、`.react-router/` は typegen。
      '**/build/',
      '**/.react-router/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * hooks の規則は apps/web だけに掛ける。
   *
   * **これは様式の統一ではなくバグ検出である** — 依存配列の取りこぼしは
   * 「古い値をつかんだまま動き続ける」形で出るので、目視では見つからない。
   * 日誌の SSE 購読（`use-journal-live.ts`）のように張りっぱなしにするものが
   * あるほど効く。
   */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  prettier,
);
