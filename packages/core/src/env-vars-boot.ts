import { resolveCredentialRows } from './credential-service.js';
import { ENV_FILE_OWNED_CREDENTIAL_NAMES } from './credentials.js';
import type { Stores } from './store.js';

/**
 * alteroid 自身の運用設定を、環境変数の袋（`stores.credentials`、旧「マネージャーへ
 * 降ろす環境変数」）へ播種・反映する口。
 *
 * ## なぜここに要るか
 *
 * これまで `TZ` / `ALTEROID_ALLOWED_ORIGINS` / 自律のスケジュール等は `.env` の
 * 生の環境変数だけで持っていた——直すたびに器（コンテナ）を焼き直す必要があり、
 * それはまさに `packages/core/src/credentials.ts` が「マネージャーへ降ろす環境変数」
 * を作った理由（AGENTS.md 地雷表「用途が増えるたびに `compose.yaml` へ環境変数を
 * 足す」）と同じデグレードである。**同じ袋に、alteroid 自身の運用設定も乗せる。**
 *
 * ## 播種（`seedDefaultEnvVars`）と反映（`applyAppScopedEnvVars`）を分けている理由
 *
 * 播種は「まだ無ければ、既定値を1回だけ書く」——**書き込み**で、記憶ストアの
 * 正本を変える。反映は「正本にある `scope: all | app` の行を、いまのプロセスの
 * `process.env` へ重ねる」——**読み出し**で、副作用は `process.env` の変更だけ
 * である。前者は起動のたびに何度呼んでも安全（無ければ足すだけ）、後者は
 * `resolveCredentialRows` を通すだけの薄い処理で、クローンの `#childEnv()` や
 * マネージャーへの配布（`credential-service.ts`）と**同じ解決を1本だけ通す**。
 */

/**
 * 初回起動時に既定値を播種する変数。**「未設定＝空」が正しい既定の変数は
 * 播種しない**（空文字は袋の中で「外す」と同じ意味になるため——播種できるのは
 * 非空の既定を持つ変数だけである）。
 *
 * **`ENV_FILE_OWNED_CREDENTIAL_NAMES`（`credentials.ts`）はこの理由では説明
 * できない一段強い対象外である。** 播種しないだけでなく、この袋（記憶ストアの
 * 正本）自体に置けない——`assertEntries` が書き込みを拒み、
 * `resolveCredentialRows` が読み出しでも落とす。正本は器の生の環境変数
 * （`.env` / Railway の Service 変数、`railway/setup.sh` や compose.yaml の
 * `x-shared-env` が渡す）だけであり、`applyAppScopedEnvVars` がこれらを
 * `process.env` へ重ねることは無い。内訳は2群——alteroid が外部と向き合う境界
 * （CORS・ログイン・公開URL。人間の決定 2026-09-14）と、層とモデル帯の対応
 * （＝人間の承認の置き場。2026-09-15）である。**どちらも走行中に画面から直せる
 * 強さにしない**、という判断である（理由の違いは `credentials.ts` の doc）。
 *
 * **それ以外（下の配列）は「非空の既定を持つ、alteroid 自身の運用設定」として
 * 播種する。** `ALTEROID_MEMORY_TIDY_AT`（既定 `03:00`）と
 * `ALTEROID_REPORT_LOOKBACK_DAYS`（既定 `3`）は、`apps/daemon/src/schedule.ts`
 * の `DEFAULT_MEMORY_TIDY_AT` / `DEFAULT_REPORT_LOOKBACK_DAYS` と同じ値で
 * ここにも並べてある（`ALTEROID_DAILY_REPORT_AT` が `DEFAULT_DAILY_REPORT_AT`
 * と並べてあるのと同じ形——コードの既定と、播種してDBへ書く既定を、あえて
 * 同じ値で二重に持つ）。
 *
 * **どれも `scope: 'app'`**（デーモン自身の運用設定であって、マネージャーの
 * Bash 環境には意味を持たない）。**どれも `secret: false`**（秘密ではなく、
 * 画面でそのまま見える／直せることに価値がある）。
 */
export const APP_ENV_VAR_DEFAULTS: readonly { name: string; value: string }[] = [
  { name: 'TZ', value: 'Asia/Tokyo' },
  { name: 'ALTEROID_DAILY_REPORT_AT', value: '22:00' },
  { name: 'ALTEROID_INITIATIVE_EVERY', value: '55' },
  { name: 'ALTEROID_ACCESS_TOKEN_TTL_DAYS', value: '30' },
  { name: 'ALTEROID_WITHHELD_REPORT_FLUSH_MS', value: '1800000' },
  { name: 'ALTEROID_MEMORY_TIDY_AT', value: '03:00' },
  { name: 'ALTEROID_REPORT_LOOKBACK_DAYS', value: '3' },
];

/**
 * `APP_ENV_VAR_DEFAULTS` のうち、**まだ同名の行が正本に無いものだけ**を書く。
 *
 * 「初回起動」という一度きりのフラグではなく、**名前ごとに「無ければ入れる」**
 * という形にしてある——将来ここへ既定値を追加しても、既存のインストールが
 * 起動するたびに新しい名前だけ追いつく（振る舞いは変わらない。人間が既に
 * 明示的に置いた値・削除した値は上書きしない）。
 *
 * 失敗しても起動は止めない——播種は「あると便利な既定」であって、無くても
 * 既存の `process.env` の値（あれば）がそのまま `resolveCredentialRows` の
 * 最後の土台として効く。
 */
export async function seedDefaultEnvVars(
  stores: Stores,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let existing: Set<string>;
  try {
    existing = new Set((await stores.credentials.list()).map((row) => row.name));
  } catch (error) {
    process.stderr.write(
      `alteroidd: 環境変数の播種のための読み出しに失敗しました: ${String(error)}\n`,
    );
    return;
  }

  const missing = APP_ENV_VAR_DEFAULTS.filter((entry) => !existing.has(entry.name));
  if (missing.length === 0) return;

  const toSeed = missing.map((entry) => {
    // **移行期の配慮。** compose.yaml / Railway の Shared Variables に、旧来の
    // 素の環境変数として既にこの名前が置かれていることがある（過去の `.env` の
    // 名残）。初回の播種でそれを無視してハードコードの既定へ倒すと、人間が
    // 既に選んだ値を黙って巻き戻すことになる——だから**器の環境変数を優先し、
    // 無ければハードコードの既定を使う**。
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
    process.stderr.write(`alteroidd: 環境変数の既定値の播種に失敗しました: ${String(error)}\n`);
  }
}

/**
 * 正本の `scope: 'all' | 'app'` の行を、いまのプロセスの `process.env`（または
 * 渡された env）へ上書きで重ねる。**呼ぶのは、これらの値を読む既存コード
 * （CORS の許可オリジン・認証の要否・自律のスケジュール等）より前**であること
 * ——`main()` の起動シーケンスの、`stores` が使えるようになった直後に置く。
 *
 * `resolveCredentialRows` をクローン・マネージャーと**同じ1本**で通す
 * （2026-09-12「梯子を1本に統一する」と同じ判断——alteroid 自身の設定読み出しの
 * ためだけの別解決を作らない）。`target: 'clone'` を渡すのは、ここが解決したい
 * 相手はデーモン自身のプロセス（＝クローンと同じプロセス）だからである。
 *
 * 失敗しても起動は止めない——読み出せなければ、これまでどおり `process.env`
 * に元から在った値（あれば）で動く。
 */
export async function applyAppScopedEnvVars(
  stores: Stores,
  target: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let rows: Awaited<ReturnType<Stores['credentials']['list']>>;
  try {
    rows = await stores.credentials.list();
  } catch (error) {
    process.stderr.write(
      `alteroidd: 環境変数の読み出しに失敗しました（既存の process.env のまま動きます）: ${String(error)}\n`,
    );
    return;
  }
  /**
   * **配らなかった行を黙らせない。** `resolveCredentialRows` は
   * `ENV_FILE_OWNED_CREDENTIAL_NAMES` の行を落とすが（あちらの doc）、落ちるのは
   * たいてい「拒むようにする前に人間が置いた行」である。⟹ 黙って落とすと
   * **画面には残っているのに効かない**行ができ、人間からは「置いたのに効かない」
   * としか見えない（AGENTS.md「静かに失敗する道具」の形そのもの）。
   *
   * **名前だけを出す。値は出さない**（この袋には秘密の行も居る）。
   */
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

  const resolved = resolveCredentialRows(rows, target, 'clone');
  for (const row of resolved) {
    target[row.name] = row.value;
  }
}
