import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { describeAuthFailure, resolveTarget, type Target } from './target.js';

/**
 * `alteroid token` — 認証トークンのプール（Issue #393「PR1 プールの器」）。
 *
 * **回さない。** ここにあるのは器を覗く・並べる・外す口だけで、枠に当たった
 * ときの検知・切替（後続の PR）はここには無い。
 *
 * `add` / `remove` / `disable` / `enable` はどれも「`GET /tokens` で現在の
 * 一覧を取り、加工して `PUT /tokens` へ戻す」形にしてある。`PUT /tokens` の
 * 入力（`agentTokenInputSchema`）は `value` を省略できるので、並べ替えや
 * 他の行の操作のたびに、触っていない行の秘密を貼り直す必要が無い
 * （`packages/core/src/token-pool.ts` の doc）。
 */

interface AgentTokenView {
  id: string;
  label: string;
  order: number;
  sha256: string;
  disabledAt?: string;
  cooldownUntil?: number;
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
}

interface TokenRotationSettings {
  rotateOn: 'free_exhausted' | 'overage_exhausted' | 'off';
  cooldownMs: number;
  updatedAt?: string;
}

interface TokensView {
  tokens: AgentTokenView[];
  settings: TokenRotationSettings;
}

interface AgentTokenInput {
  id?: string;
  label: string;
  value?: string;
  order?: number;
  disabled?: boolean;
}

export async function tokenListCommand(): Promise<void> {
  const target = await resolveTarget();
  const view = (await request(target, '/tokens')) as TokensView;

  stdout.write(
    `回す契機: ${view.settings.rotateOn}（resetsAt が取れないときの冷却の既定 ${String(view.settings.cooldownMs)}ms）\n`,
  );

  if (view.tokens.length === 0) {
    stdout.write('トークンは登録されていません（器の環境変数1本だけの既定の構成）。\n');
    stdout.write('登録するには: alteroid token add --label <名前> --file <path>\n');
    return;
  }

  const now = Date.now();
  stdout.write('\n');
  for (const token of [...view.tokens].sort((a, b) => a.order - b.order)) {
    stdout.write(
      `${String(token.order)}. ${token.label}  id=${token.id}  sha256=${token.sha256}\n`,
    );
    const status = describeStatus(token, now);
    if (status !== null) stdout.write(`   ${status}\n`);
  }
}

/** 値は一切扱わない——見せるのは label・指紋・状態だけ。 */
function describeStatus(token: AgentTokenView, now: number): string | null {
  const parts: string[] = [];
  if (token.disabledAt !== undefined) {
    parts.push(`外されている（人間が明示的に。${token.disabledAt}）`);
  }
  if (token.invalidatedAt !== undefined) {
    parts.push(`失効: ${token.invalidatedReason ?? '理由不明'}（${token.invalidatedAt}）`);
  }
  if (token.cooldownUntil !== undefined && token.cooldownUntil > now) {
    const remainingMinutes = Math.ceil((token.cooldownUntil - now) / 60_000);
    parts.push(
      `冷却中（あと約 ${String(remainingMinutes)} 分。resetsAt 由来か既定のフォールバック）`,
    );
  }
  if (token.lastRejectedReason !== undefined) {
    parts.push(`最後の拒否: ${token.lastRejectedReason}（${token.lastRejectedAt ?? '?'}）`);
  }
  return parts.length === 0 ? null : parts.join(' / ');
}

/**
 * トークンを1本足す。
 *
 * **値はファイルか標準入力からだけ受ける——コマンドライン引数では受け取らない。**
 * `argv` は同じ器の他のプロセスから見える（`ps` 等）ので、秘密をそこへ置かない。
 */
export async function tokenAddCommand(options: { label: string; file?: string }): Promise<void> {
  const raw =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error('値が空である（ファイルか標準入力から、空でない値を渡す）');
  }

  const target = await resolveTarget();
  const current = (await request(target, '/tokens')) as TokensView;
  const inputs: AgentTokenInput[] = [
    ...current.tokens.map(toInput),
    { label: options.label, value },
  ];
  await putTokens(target, inputs);
  stdout.write(`トークン「${options.label}」を追加しました。\n`);
}

export async function tokenRemoveCommand(id: string): Promise<void> {
  const target = await resolveTarget();
  const current = (await request(target, '/tokens')) as TokensView;
  if (!current.tokens.some((token) => token.id === id)) {
    stdout.write(`id ${id} のトークンは見つかりません。\n`);
    return;
  }
  const inputs = current.tokens.filter((token) => token.id !== id).map(toInput);
  await putTokens(target, inputs);
  stdout.write(`トークン（id ${id}）を削除しました。\n`);
}

export async function tokenDisableCommand(id: string): Promise<void> {
  await setDisabled(id, true);
}

export async function tokenEnableCommand(id: string): Promise<void> {
  await setDisabled(id, false);
}

async function setDisabled(id: string, disabled: boolean): Promise<void> {
  const target = await resolveTarget();
  const current = (await request(target, '/tokens')) as TokensView;
  if (!current.tokens.some((token) => token.id === id)) {
    stdout.write(`id ${id} のトークンは見つかりません。\n`);
    return;
  }
  const inputs = current.tokens.map((token) =>
    token.id === id ? { ...toInput(token), disabled } : toInput(token),
  );
  await putTokens(target, inputs);
  stdout.write(`トークン（id ${id}）を${disabled ? '外しました' : '戻しました'}。\n`);
}

/**
 * 回す契機・冷却の既定を見る／変える。引数を1つも渡さなければいまの設定を出す。
 */
export async function tokenPolicyCommand(
  value: string | undefined,
  options: { cooldownMs?: string } = {},
): Promise<void> {
  const target = await resolveTarget();

  if (value === undefined && options.cooldownMs === undefined) {
    const current = (await request(target, '/tokens')) as TokensView;
    printSettings(current.settings);
    return;
  }

  const patch: { rotateOn?: string; cooldownMs?: number } = {};
  if (value !== undefined) patch.rotateOn = value;
  if (options.cooldownMs !== undefined) {
    const parsed = Number(options.cooldownMs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('--cooldown-ms は正の整数（ミリ秒）で指定する');
    }
    patch.cooldownMs = parsed;
  }

  const settings = (await request(target, '/tokens/policy', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })) as TokenRotationSettings;
  printSettings(settings);
}

function printSettings(settings: TokenRotationSettings): void {
  stdout.write(`回す契機: ${settings.rotateOn}\n`);
  stdout.write(
    `冷却の既定（resetsAt が取れないときのフォールバック）: ${String(settings.cooldownMs)}ms\n`,
  );
}

/** 外向きの顔（値を持たない）を、次の `PUT /tokens` の入力へ変換する。 */
function toInput(token: AgentTokenView): AgentTokenInput {
  return { id: token.id, label: token.label, order: token.order };
}

async function putTokens(target: Target, tokens: AgentTokenInput[]): Promise<TokensView> {
  return (await request(target, '/tokens', {
    method: 'PUT',
    body: JSON.stringify({ tokens }),
  })) as TokensView;
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // **`/tokens` は実行環境の持ち主だけ**（`/profile` / `/access` と同じ強さ）。
    // 課金の主体を決める操作なので、`access grant` を通しただけのアカウントには
    // 開けない——同じ 403 でも `access` とは意味が違うので、専用の文言にする。
    if (response.status === 403) {
      throw new Error(
        '認証トークンのプールを触れるのは、その実行環境の持ち主だけです。\n' +
          'デーモンが動いているのと同じ環境で実行してください:\n' +
          '  docker compose exec app alteroid token list\n',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(body.error);
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
