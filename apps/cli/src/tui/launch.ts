// 出所: takecchi/codiva（MIT）`src/index.tsx` の起動シム
// static import を書かない: 巻き上げられて本文より先に評価され、react より先に `NODE_ENV` を立てられなくなるため
// production を既定にする: dev ビルドの `react-reconciler` は描画のたびに計測エントリを積み、長く開く TUI ではヒープが単調に増える（OOM の実測）ため
// CLI 全体の `NODE_ENV` は変えない: 子プロセス（デーモン・エージェント）に継承されるため（react が評価される動的 import の間だけ立てる）
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

// stdin と stdout がともに TTY のときだけ開く: パイプ・リダイレクト・スクリプトの挙動を変えないため
export function opensTuiByDefault(
  args: readonly string[],
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
): boolean {
  return args.length === 0 && stdin.isTTY === true && stdout.isTTY === true;
}
