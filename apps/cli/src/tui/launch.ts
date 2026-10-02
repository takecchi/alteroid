/**
 * TUI の起動シム（`alteroid tui` / 引数なし起動の入口）。
 * 出所: takecchi/codiva（MIT）`src/index.tsx` の起動シム。
 *
 * **このファイルに static import を書かないこと**（書いた瞬間に意味が消える）。ESM の
 * static import は巻き上げられて本文より先に評価されるので、react / react-reconciler より
 * 先に `NODE_ENV` を立てる方法は「動的 import の手前の文で代入する」しかない。
 *
 * なぜ production を既定にするか: `react-reconciler` は dev ビルドのモジュール評価時に
 * `performance.measure` を積む作りを確定し、以後描画のたびに計測エントリを積む。
 * Node の user timing は自動では捨てられないので、長く開いておく TUI ではヒープが
 * 単調に増える（codiva で OOM の実測がある）。production ビルドなら確保そのものが無い。
 *
 * **CLI 全体の NODE_ENV は変えない。** `alteroid` は子プロセス（デーモン・エージェント）を
 * 起こすので、`process.env` への代入はそれらに継承される（`npm install` が `--omit=dev`
 * 扱いになる類の事故）。react が評価される動的 import の間だけ立て、評価が終わったら
 * 元に戻す（元が未設定なら消す）。react / react-reconciler がビルドを選ぶのはモジュール
 * 評価時なので、戻したあとに production ビルドから dev ビルドへ戻ることは無い。
 * 既に値が入っているときは尊重する。
 */
export async function launchTui(): Promise<void> {
  const hadNodeEnv = Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV ??= 'production';
  let main: typeof import('./main.js');
  try {
    main = await import('./main.js');
  } finally {
    if (hadNodeEnv) process.env.NODE_ENV = previous;
    else delete process.env.NODE_ENV;
  }
  await main.runTui();
}

/**
 * `alteroid` を引数なしで起動したとき、TUI を開くか（それ以外は従来どおり help）。
 * **stdin と stdout がともに TTY のときだけ**である — パイプ・リダイレクト・スクリプトの
 * 挙動は変えない。
 */
export function opensTuiByDefault(
  args: readonly string[],
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
): boolean {
  return args.length === 0 && stdin.isTTY === true && stdout.isTTY === true;
}
