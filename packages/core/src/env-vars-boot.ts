import { resolveCredentialRows } from './credential-service.js';
import {
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  POOL_OWNED_CREDENTIAL_NAMES,
  ROTATABLE_CREDENTIAL_KEYS,
} from './credentials.js';
import { reasonOf } from './dropped-record.js';
import type { Stores } from './store.js';

// 「未設定＝空」が正しい既定の変数は播種しない: 空文字は袋の中で「外す」と同じ意味になるため
export const APP_ENV_VAR_DEFAULTS: readonly { name: string; value: string }[] = [
  { name: 'TZ', value: 'Asia/Tokyo' },
  { name: 'ALTEROID_DAILY_REPORT_AT', value: '22:00' },
  { name: 'ALTEROID_INITIATIVE_EVERY', value: '55' },
  { name: 'ALTEROID_ACCESS_TOKEN_TTL_DAYS', value: '30' },
  { name: 'ALTEROID_WITHHELD_REPORT_FLUSH_MS', value: '1800000' },
  { name: 'ALTEROID_MEMORY_TIDY_AT', value: '03:00' },
  { name: 'ALTEROID_REPORT_LOOKBACK_DAYS', value: '3' },
];

export async function seedDefaultEnvVars(
  stores: Stores,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let existing: Set<string>;
  try {
    existing = new Set((await stores.credentials.list()).map((row) => row.name));
  } catch (error) {
    process.stderr.write(
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
    process.stderr.write(`alteroidd: 環境変数の既定値の播種に失敗しました: ${reasonOf(error)}\n`);
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
    process.stderr.write(
      `alteroidd: 環境変数の読み出しに失敗しました（既存の process.env のまま動きます）: ${reasonOf(error)}\n`,
    );
    return;
  }
  // 配らなかった行を黙らせない: 画面には残っているのに効かない行ができ、「置いたのに効かない」としか見えないため
  const ignored = rows
    .filter((row) => ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(row.name))
    .map((row) => row.name);
  if (ignored.length > 0) {
    process.stderr.write(
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

// 印の名前を変えない: 変えると全器で移行がもう1度走るため
export const ENV_BASE_MIGRATION_MARKER = 'env_base_credentials_v1';

export async function migrateEnvBaseCredentialsOnce(
  stores: Stores,
  snapshotEnv: NodeJS.ProcessEnv,
): Promise<string[]> {
  // 書き写した後の `process.env` から読まない: 正本から消した値が、書き写しの残骸として蘇るため
  // 書いても書かなくても印を立てる: 立てないと、画面で消した後の再起動で器の env から値が蘇るため
  const candidates = ROTATABLE_CREDENTIAL_KEYS.filter(
    (name) => !POOL_OWNED_CREDENTIAL_NAMES.includes(name),
  ).flatMap((name) => {
    const value = snapshotEnv[name];
    return value === undefined || value.length === 0
      ? []
      : [{ name, value, scope: 'all' as const, secret: true }];
  });
  let written: string[];
  try {
    written = await stores.credentials.seedOnce(ENV_BASE_MIGRATION_MARKER, candidates);
  } catch (error) {
    process.stderr.write(
      `alteroidd: 器の環境変数の鍵を正本へ移せませんでした（このまま起動します。` +
        `正本に無い名前は配られません）: ${reasonOf(error)}\n`,
    );
    return [];
  }
  if (written.length === 0) return [];
  process.stderr.write(
    `alteroidd: 器の環境変数にだけ在った鍵を、正本（環境変数の袋）へ1度だけ移しました` +
      `（scope: all・secret）。以後は正本が唯一の出所で、画面・CLI で消せば消えます。名前: ${written.join(', ')}\n`,
  );
  try {
    await stores.journal.append({
      type: 'decision',
      decision: `器の環境変数にだけ在った鍵を、正本へ1度だけ移した（名前: ${written.join(', ')}）`,
      grounds:
        '2026-10-06 のオーナー決定（GH_TOKEN・CODEX_API_KEY も普通の名前と同じ扱い）。' +
        '器の環境変数を最後の土台にする経路を撤去したため、既存の器を黙って壊さないための1回きりの移行。' +
        '値は書かない。',
    });
  } catch (error) {
    process.stderr.write(`alteroidd: 鍵の移行の日誌を書けませんでした: ${reasonOf(error)}\n`);
  }
  return written;
}
