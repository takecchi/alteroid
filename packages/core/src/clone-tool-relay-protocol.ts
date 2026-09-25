/**
 * クローンの道具の中継（`clone-tool-relay-host.ts` ⇄ `clone-tool-relay-child.ts`。
 * Issue #486 48(a) 案D）が、ソケットの所在と合鍵 token を子プロセスへ渡すのに
 * 使う環境変数の名前2本。
 *
 * ## なぜ `clone-tool-relay-child.ts` の中に置かないか（Issue #486 48(a) PR2）
 *
 * `clone-tool-relay-child.ts` は「実行された入口そのものか」を
 * `import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`
 * で比べ（`invokedDirectly()`）、真なら中継を起動する——**トップレベルの
 * 副作用**である。
 *
 * この2つの定数を `clone.ts`（`dist/index.js` 側）からも import すると、
 * `clone-tool-relay-child.ts` というモジュール全体が2つの入口
 * （`src/index.ts` と `src/clone-tool-relay-child.ts`）の両方から参照される
 * ことになる。**tsup（esbuild）はそのとき、モジュールの中身を共有チャンクへ
 * 括り出す**——実測（`packages/core/tsup.config.ts` でビルドし、
 * `dist/clone-tool-relay-child.js` の中身を見た）:
 *
 * ```
 * import { ... } from "./chunk-6QGB3VON.js";  // ← 中身は空の再 export だけ
 * ```
 *
 * `invokedDirectly()` の比較はその共有チャンク（`chunk-6QGB3VON.js`）の中で
 * 実行されるので、そこでの `import.meta.url` は**チャンク自身のファイル**を
 * 指す——`process.argv[1]`（`dist/clone-tool-relay-child.js`）とは永久に
 * 一致しない。**⟹ 子プロセスとして spawn しても、中継が一切起動しない。**
 * `agent-session-options.test.ts` が実際に子プロセスを spawn して確かめる
 * テストで、`Connection closed`（何もしないまま即終了）として見つかった。
 *
 * ## だからここへ切り出す
 *
 * `clone.ts` がこの2つの名前**だけ**を必要としているので、名前だけを持つ
 * 副作用の無いこのファイルを間に挟む。`clone.ts` はここを import し、
 * `clone-tool-relay-child.ts` 自身には触れない——**そのモジュール全体を参照する
 * 経路が `src/clone-tool-relay-child.ts`（自分自身の入口）1つだけに戻る**ので、
 * トップレベルの副作用は共有チャンクへ括り出されず、`dist/clone-tool-relay-child.js`
 * 自身の中に留まる（tsup は「1つの入口からしか参照されないモジュール」を
 * その入口へインライン化する——PR1 の最初のビルドで実際にそうなっていた）。
 *
 * `clone-tool-relay-child.ts` は既存のテスト2本
 * （`clone-tool-relay-host.test.ts` / `clone-tool-relay-integration.test.ts`）の
 * import 元を変えずに済むよう、同じ名前をここから re-export する。
 */
export const CLONE_TOOL_RELAY_SOCKET_ENV = 'ALTEROID_CLONE_TOOL_RELAY_SOCKET';
export const CLONE_TOOL_RELAY_TOKEN_ENV = 'ALTEROID_CLONE_TOOL_RELAY_TOKEN';
