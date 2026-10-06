import { stderr, stdout } from 'node:process';

import { createClient } from './client.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { describeUnreadableRowsList, errorReason, withErrorReason } from './format.js';
import { redactError } from './redact.js';

/**
 * `alteroid integration` — 連携の鍵（外のサービスへ渡す、固定の1つの `source` で外部イベントを
 * 送る鍵。#3113 段2）を一覧・発行・失効する。Web UI の `/integrations` と対になる。
 *
 * 打つ口は `GET /integration-keys` / `POST /integration-keys` / `POST /integration-keys/:id/revoke` と、
 * 読めない行を消す `POST /integration-keys/unreadable/remove`（#3216。`access remove-unreadable` と同じ形）。
 *
 * ## 値の扱い
 *
 * 鍵の値（`altk_...`）は発行の応答でだけ返り、デーモンは sha256 しか持たない。**`create` が
 * 値を書くのは1か所（「この値は二度と表示されない」の直下）だけ**で、送り方の例には値の代わりに
 * 環境変数名を置く（値が2回出ると、端末のログから拾える場所が増える）。値以外の出力・エラーには
 * 値を出さない（`redactError` を通す。失敗時は値がそもそも手元に無い）。
 *
 * 特定のサービスの名前・分岐は持たない（`source` は呼び出し側が決める文字列）。
 */

interface IntegrationKeyView {
  id: string;
  name: string;
  source: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  limits: { maxBodyBytes: number; ratePerMinute: number };
}

/** 読めない行（`GET /integration-keys` の `rowsUnreadable`。#3216）。id と不正な欄名だけで、名前などは無い。 */
interface RowsUnreadable {
  count: number;
  rows: { id: string; reason: string }[];
}

export type IntegrationKeyStatus = 'active' | 'revoked' | 'expired';

/** 失効が先、次に期限切れ（判定できない期限は「使えない」側へ倒す。デーモンの `isIntegrationKeyUsable` と同じ向き）。 */
export function integrationKeyStatus(
  key: Pick<IntegrationKeyView, 'revokedAt' | 'expiresAt'>,
  now: number,
): IntegrationKeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt === null) return 'active';
  const expires = Date.parse(key.expiresAt);
  return expires > now ? 'active' : 'expired';
}

const STATUS_LABEL: Record<IntegrationKeyStatus, string> = {
  active: '有効',
  revoked: '失効',
  expired: '期限切れ',
};

const SOURCE_PATTERN = /^[a-z0-9._-]{1,64}$/;

const DURATION_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * `--expires` を ISO 日時（オフセット付き）にする。**日時**（`2027-01-01T00:00:00Z` /
 * `2027-01-01`）か、**期間**（`30m` `12h` `90d` `4w`。いまからの長さ）を受ける。
 * 読めなければ何も作らずに断る。
 */
export function parseExpires(text: string, now: number): string {
  const trimmed = text.trim();
  const duration = /^(\d+)([mhdw])$/.exec(trimmed);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const ms = amount * (DURATION_UNIT_MS[duration[2] ?? ''] ?? 0);
    if (amount <= 0 || !Number.isSafeInteger(ms) || Number.isNaN(new Date(now + ms).getTime())) {
      throw new Error(`--expires の期間が不正です: ${trimmed}（何も発行していません）`);
    }
    return new Date(now + ms).toISOString();
  }
  const dateLike = /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed);
  const parsed = dateLike ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new Error(
      `--expires を読めませんでした: ${trimmed}\n` +
        '日時（例: 2027-01-01T00:00:00Z）か、いまからの期間（例: 30d / 12h / 90m / 4w）で指定してください（何も発行していません）。',
    );
  }
  return new Date(parsed).toISOString();
}

function parsePositiveInt(flag: string, text: string): number {
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
    throw new Error(`${flag} は 1 以上の整数で指定してください: ${text}（何も発行していません）`);
  }
  const value = Number(text);
  if (value > 2_147_483_647) {
    throw new Error(`${flag} が大きすぎます（2147483647 以下）: ${text}（何も発行していません）`);
  }
  return value;
}

export async function integrationListCommand(now: number = Date.now()): Promise<void> {
  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['integration-keys'].$get();
  if (!response.ok) await fail(response, target, '/integration-keys');
  const { keys, rowsUnreadable } = (await response.json()) as {
    keys: IntegrationKeyView[];
    rowsUnreadable?: RowsUnreadable;
  };
  stdout.write(renderIntegrationList(keys, now, rowsUnreadable));
}

/** 一覧。値は元から返ってこない（指紋＝sha256 の先頭12桁だけ）。 */
export function renderIntegrationList(
  keys: IntegrationKeyView[],
  now: number,
  rowsUnreadable?: RowsUnreadable,
): string {
  // **読めない行は一覧の前に言う**（0件なら何も出ない。`access list` と同じ文言の型）。
  const unreadableNote = describeUnreadableRowsList({
    noun: '連携の鍵',
    removeCommand: 'alteroid integration remove-unreadable',
    file: 'integration-keys.json',
    rowsUnreadable,
  });
  if (keys.length === 0) {
    // 読めない行が在るので「鍵がまだ無い」とは言えない。
    if (rowsUnreadable !== undefined) {
      return `${unreadableNote}読めた連携の鍵は無い（連携の鍵がまだ無い、とは言えない）。\n`;
    }
    return (
      '連携の鍵はありません。\n' +
      '発行するには: alteroid integration create --name <名前> --source <source>\n'
    );
  }
  const lines = [`連携の鍵: ${String(keys.length)} 件`];
  for (const key of keys) {
    lines.push(
      `[${STATUS_LABEL[integrationKeyStatus(key, now)]}] ${key.name}  source=${key.source}`,
      `  id: ${key.id}`,
      `  指紋: ${key.fingerprint}`,
      `  作成: ${key.createdAt}（${key.createdBy}）`,
      `  最終使用: ${key.lastUsedAt ?? '（まだ使われていない）'}`,
      `  期限: ${key.expiresAt ?? '（無期限）'}`,
    );
    if (key.revokedAt !== null) lines.push(`  失効: ${key.revokedAt}`);
    lines.push(
      `  上限: 本文 ${String(key.limits.maxBodyBytes)} バイト・${String(key.limits.ratePerMinute)} 回/分`,
    );
  }
  return `${unreadableNote}${lines.join('\n')}\n`;
}

export interface IntegrationCreateOptions {
  name: string;
  source: string;
  expires?: string;
  maxBodyBytes?: string;
  ratePerMinute?: string;
  /** デーモンの応答（`{ key, value }`）をそのまま JSON で標準出力へ出す。警告は標準エラーへ（#3220）。 */
  json?: boolean;
}

export async function integrationCreateCommand(
  options: IntegrationCreateOptions,
  now: number = Date.now(),
): Promise<void> {
  // 入力の誤りはデーモンへ行く前に止める（何も作らない）。
  const name = options.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new Error('--name は 1〜200 文字で指定してください（何も発行していません）');
  }
  if (!SOURCE_PATTERN.test(options.source)) {
    throw new Error(
      `--source は英小文字・数字・. _ - の 1〜64 文字（^[a-z0-9._-]{1,64}$）で指定してください: ${options.source}（何も発行していません）`,
    );
  }
  const json: {
    name: string;
    source: string;
    expiresAt?: string;
    maxBodyBytes?: number;
    ratePerMinute?: number;
  } = { name, source: options.source };
  if (options.expires !== undefined) json.expiresAt = parseExpires(options.expires, now);
  if (options.maxBodyBytes !== undefined) {
    json.maxBodyBytes = parsePositiveInt('--max-body-bytes', options.maxBodyBytes);
  }
  if (options.ratePerMinute !== undefined) {
    json.ratePerMinute = parsePositiveInt('--rate-per-minute', options.ratePerMinute);
  }

  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['integration-keys'].$post({ json });
  if (!response.ok) await fail(response, target, '/integration-keys');
  const created = (await response.json()) as { key: IntegrationKeyView; value: string };
  if (options.json === true) {
    // --json のとき標準出力は JSON だけ（他コマンドの --json と同じ整形）。値は JSON の
    // `value` にだけ入り、警告は標準エラーへ出す（`KEY=$(... --json | jq -r .value)` で受けても
    // 警告は混ざらない）。値を標準出力へ出す以上、呼び出し側のログ・CI の出力に残らないよう案内する。
    stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    stderr.write(
      'この値は二度と表示されません（alteroid は sha256 しか保存していません）。標準出力の JSON の value に入っています。\n' +
        '値をログに残さないでください（CI のログ・シェルの履歴・出力の保存先に注意。変数や秘密の保管先へ直接受けてください）。\n',
    );
    return;
  }
  stdout.write(renderIntegrationCreated(created.key, created.value, target.baseUrl));
}

/** 発行の結果。**値を書くのはここの1か所だけ**（送り方の例は環境変数名で書く）。 */
export function renderIntegrationCreated(
  key: IntegrationKeyView,
  value: string,
  baseUrl: string,
): string {
  const lines = [
    `連携の鍵を発行しました: ${key.name}（source=${key.source}）`,
    `  id: ${key.id}`,
    `  指紋: ${key.fingerprint}`,
    `  期限: ${key.expiresAt ?? '（無期限）'}`,
    `  上限: 本文 ${String(key.limits.maxBodyBytes)} バイト・${String(key.limits.ratePerMinute)} 回/分`,
    '',
    'この値は二度と表示されません（alteroid は sha256 しか保存していません）。いま控えてください:',
    `  ${value}`,
    '',
    '送り方の例（JSON を POST。本文がそのまま payload になる）:',
    `  export ALTEROID_INTEGRATION_KEY=<上の値>`,
    `  curl -X POST ${baseUrl}/events/${key.source} \\`,
    `    -H "Authorization: Bearer $ALTEROID_INTEGRATION_KEY" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"message":"hello"}'`,
    `  （${baseUrl} は、この端末から見える接続先です。外のサービスから届く値とは限らないので、渡す先の設定には自分の公開 URL に置き換えてください）`,
    '',
    `失効するには: alteroid integration revoke ${key.id}`,
  ];
  return `${lines.join('\n')}\n`;
}

export interface IntegrationRevokeOptions {
  yes?: boolean;
  /** 確認の口。既定は端末。テストが差し替える（`confirm.ts` の `ConfirmIo`）。 */
  io?: ConfirmIo;
}

/**
 * 失効。**取り消せない操作なので、他の戻せない操作と同じ `confirmIrreversible`
 * （`confirm.ts`）を通す**（#3141 / #3200 / #3211）。端末なら `yes` の全文を要求し、
 * `--yes` で省略でき、端末でなく `--yes` も無ければ実行せずに断る（例外＝終了コード非 0）。
 * 失効は即座に効き、元には戻せない。
 *
 * **順序は resolveTarget → 一覧で確認 → 確認 → POST。** 存在と失効済みの確認
 * （`GET /integration-keys`）は `--yes` のときも行う——無い id は断り、失効済みなら
 * 「すでに失効しています」と言って POST しない（失効は何度叩いても同じ状態になるので成功の 0。
 * `permission revoke` の「取り消し済みなら重ねて叩いても失敗しません」・`credential remove` の
 * 「正本に置かれていません」と同じ扱い。**無い id** は非 0）。
 */
export async function integrationRevokeCommand(
  id: string,
  options: IntegrationRevokeOptions = {},
): Promise<void> {
  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const listed = await client['integration-keys'].$get();
  if (!listed.ok) await fail(listed, target, '/integration-keys');
  const { keys, rowsUnreadable } = (await listed.json()) as {
    keys: IntegrationKeyView[];
    rowsUnreadable?: RowsUnreadable;
  };
  const key = keys.find((row) => row.id === id);
  if (key === undefined) {
    // 読めない形で入っている行は「無い」と言い分ける（失効はできない。消すなら remove-unreadable）。
    if (rowsUnreadable?.rows.some((row) => row.id === id) === true) {
      throw new Error(
        '連携の鍵の行が読めない形で入っているので、失効できません（何も失効していません）。' +
          '消すには: alteroid integration remove-unreadable <id>',
      );
    }
    throw new Error('該当する連携の鍵がありません（何も失効していません）');
  }
  if (key.revokedAt !== null) {
    stdout.write(`すでに失効しています: ${key.name}（失効 ${key.revokedAt}）\n`);
    return;
  }
  const confirmed = await confirmIrreversible(
    `連携の鍵「${key.name}」（source=${key.source}）を失効させます。\n` +
      '以後この鍵で送ってくる外のサービスは 401 になります。',
    { yes: options.yes },
    options.io,
  );
  if (!confirmed) return;
  const response = await client['integration-keys'][':id'].revoke.$post({ param: { id } });
  if (!response.ok) await fail(response, target, `/integration-keys/${id}/revoke`);
  const { key: revoked } = (await response.json()) as { key: IntegrationKeyView };
  stdout.write(
    `連携の鍵を失効させました: ${revoked.name}（source=${revoked.source}、失効 ${revoked.revokedAt ?? '?'}）\n`,
  );
}

/**
 * 読めない連携の鍵の行を、id を指して消す（`POST /integration-keys/unreadable/remove`。#3216）。
 * 読めない行（版ずれ・手編集）は `integration revoke` が触らないので、片付ける口はこれだけ。
 * **id は `integration list` が読めない行として出す**（`GET /integration-keys` の
 * `rowsUnreadable.rows[].id`）。**id が取れない行はこの口では消せない**（`integration-keys.json` を
 * 手で直す）。指した id が1つでも読めない行に無ければ、デーモンが何も消さずに断る。
 * **行の中身は出さない**（id と件数だけ）。
 */
export async function integrationRemoveUnreadableCommand(
  ids: readonly string[],
  options: { yes?: boolean; io?: ConfirmIo } = {},
): Promise<void> {
  const target = await resolveTarget();
  // 未ログインなら確認を出す前に断る（Issue #3214）。
  if (target.note !== null) throw new Error(target.note);
  // 戻せない操作なので確認する（#3141。`confirm.ts`）。壊れた行は中身を出さずに消すので、消すと残らない。
  const confirmed = await confirmIrreversible(
    `読めない連携の鍵の行（id: ${ids.join(', ')}）を消します。壊れた行は消すと残りません。`,
    { yes: options.yes },
    options.io,
  );
  if (!confirmed) return;
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['integration-keys'].unreadable.remove.$post({
    json: { ids: [...ids] },
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        '指した id が、読めない連携の鍵の行にありません（何も消していません。' +
          'id は alteroid integration list の「読めない連携の鍵の行」で確かめます。' +
          'id が取れない行はこの口では消せません）',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `読めない連携の鍵の行を消せませんでした（${response.status}）`,
        response,
      ),
    );
  }
  const result = (await response.json()) as { removedIds: string[] };
  stdout.write(
    `読めない連携の鍵の行を ${String(result.removedIds.length)} 行消しました（id: ${result.removedIds.join(', ')}）\n`,
  );
}

/** 失敗を次にやることの分かる文言にして投げる。値はここに来ない（失敗した応答に値は無い）。 */
async function fail(
  response: { status: number; json(): Promise<unknown> },
  target: Target,
  path: string,
): Promise<never> {
  const described = describeAuthFailure(response.status, target);
  if (described !== null) throw new Error(described);
  if (response.status === 404) throw new Error('該当する連携の鍵がありません');
  const reason = await errorReason(response);
  if (response.status === 400) {
    // デーモンの文がすでに括弧（「…（何も作っていない）」）で終わっていれば、重ねない。
    const text = reason ?? '入力が不正です';
    throw new Error(/[）)]$/.test(text) ? text : `${text}（何も変更していません）`);
  }
  throw new Error(
    reason === null
      ? `${path} が失敗しました (${String(response.status)})`
      : `${path} が失敗しました (${String(response.status)}): ${redactError(reason)}`,
  );
}
