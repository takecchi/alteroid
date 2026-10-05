/**
 * `@alteroid/logic` —— Web UI の純ロジック。
 *
 * **React も SWR も知らない層である。** 描画せずに試せるもの（表示の整形・
 * 接続先と資格情報の置き場・日誌の窓の計算・画面へ渡す URL の組み立て・
 * 生成 spec から導いた画面の型）だけを置く。
 *
 * ⚠️ `@alteroid/core` から**値**を import するときは、ブラウザへ出す軽い口
 * （`@alteroid/core/usage` / `@alteroid/core/journal-search` など）を使うこと。
 * 本体（`@alteroid/core`）の値はサーバ専用のドメイン層ごとバンドルへ入る
 * （`eslint.config.js` の `no-restricted-imports` が止める）。
 *
 * ⚠️ **中の相対 import には `.js` 拡張子を付けること**（#2558）。このパッケージはビルドせず
 * `.ts` をそのまま export するので、NodeNext の `apps/cli` が読むとき、拡張子の無い相対
 * import は `TS2835` で型検査を落とす（`apps/cli/src/logic-import.test.ts` が見張る）。
 */
export * from './approval-questions.js';
export * from './auth.js';
export * from './config.js';
export * from './format.js';
export * from './inbox-display.js';
export * from './journal-display.js';
export * from './journal-summary.js';
export * from './journal-window.js';
export * from './clone-provider.js';
export * from './manager-provider.js';
export * from './profile-compat.js';
export * from './managers-links.js';
export * from './redact.js';
export * from './tokens-links.js';
export * from './topology-scene.js';
export * from './types.js';
export * from './usage-links.js';
export * from './usage-view.js';
