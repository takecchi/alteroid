import { resolveCredentialRows } from './credential-service.js';
import { ENV_FILE_OWNED_CREDENTIAL_NAMES } from './credentials.js';
import { reasonOf, writeStderrLine } from './dropped-record.js';
import { APP_ENV_VAR_DEFAULTS } from './app-env-var-defaults.js';
import type { Stores } from './store.js';

export { APP_ENV_VAR_DEFAULTS, DAEMON_RESTART_REQUIRED_ENV_NAMES } from './app-env-var-defaults.js';

export async function seedDefaultEnvVars(
  stores: Stores,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let existing: Set<string>;
  try {
    existing = new Set((await stores.credentials.list()).map((row) => row.name));
  } catch (error) {
    writeStderrLine(
      `alteroidd: 環境変数の播種のための読み出しに失敗しました: ${reasonOf(error)}\n`,
    );
    return;
  }

  const missing = APP_ENV_VAR_DEFAULTS.filter((entry) => !existing.has(entry.name));
  if (missing.length === 0) return;

  const toSeed = missing.map((entry) => {
    // 器の環境変数を優先する: 無視して既定へ倒すと、人間が既に選んだ値を黙って巻き戻すため
    const fromContainerEnv = env[entry.name];
    const value =
      typeof fromContainerEnv === 'string' && fromContainerEnv.trim().length > 0
        ? fromContainerEnv
        : entry.value;
    return { name: entry.name, value, scope: 'app' as const, secret: false as const };
  });

  try {
    await stores.credentials.put(toSeed);
  } catch (error) {
    writeStderrLine(`alteroidd: 環境変数の既定値の播種に失敗しました: ${reasonOf(error)}\n`);
  }
}

export async function applyAppScopedEnvVars(
  stores: Stores,
  target: NodeJS.ProcessEnv = process.env,
  // `target` を子プロセスへ渡す土台にしない: 正本から外した名前の古い値が、起動時の写しとして子に残るため
  alsoInto?: NodeJS.ProcessEnv,
): Promise<void> {
  let rows: Awaited<ReturnType<Stores['credentials']['list']>>;
  try {
    rows = await stores.credentials.list();
  } catch (error) {
    writeStderrLine(
      `alteroidd: 環境変数の読み出しに失敗しました（既存の process.env のまま動きます）: ${reasonOf(error)}\n`,
    );
    return;
  }
  // 配らなかった行を黙らせない: 画面には残っているのに効かない行ができ、「置いたのに効かない」としか見えないため
  const ignored = rows
    .filter((row) => ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(row.name))
    .map((row) => row.name);
  if (ignored.length > 0) {
    writeStderrLine(
      `alteroidd: 環境変数の袋に、正本が器の生の環境変数である名前の行が残っています。` +
        `**この行は誰にも配られていません**（効いているのは器の生の環境変数の値です）。` +
        `消すには alteroid credential remove <名前>、または Web UI の環境変数の画面から: ` +
        `${ignored.join(', ')}\n`,
    );
  }

  const resolved = resolveCredentialRows(rows, 'clone');
  for (const row of resolved) {
    target[row.name] = row.value;
    if (alsoInto !== undefined) alsoInto[row.name] = row.value;
  }
}
