import { stdout } from 'node:process';

import { createClient } from './client.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { errorReason } from './format.js';
import { redactError } from './redact.js';

/**
 * `alteroid integration` — 連携の鍵（外のサービスへ渡す、固定の1つの `source` で外部イベントを
 * 送る鍵。#3113 段2）を一覧・発行・失効する。Web UI の `/integrations` と対になる。
 *
 * **新しいデーモンの経路は足していない。** `GET /integration-keys` / `POST /integration-keys` /
 * `POST /integration-keys/:id/revoke` の3本だけを打つ。
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
  const { keys } = (await response.json()) as { keys: IntegrationKeyView[] };
  stdout.write(renderIntegrationList(keys, now));
}

/** 一覧。値は元から返ってこない（指紋＝sha256 の先頭12桁だけ）。 */
export function renderIntegrationList(keys: IntegrationKeyView[], now: number): string {
  if (keys.length === 0) {
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
  return `${lines.join('\n')}\n`;
}

export interface IntegrationCreateOptions {
  name: string;
  source: string;
  expires?: string;
  maxBodyBytes?: string;
  ratePerMinute?: string;
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
  const { keys } = (await listed.json()) as { keys: IntegrationKeyView[] };
  const key = keys.find((row) => row.id === id);
  if (key === undefined) throw new Error('該当する連携の鍵がありません（何も失効していません）');
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
