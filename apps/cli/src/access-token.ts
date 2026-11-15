import { stderr, stdout } from './terminal-out.js';
import type { InferResponseType } from 'hono/client';

import { createClient, type DaemonClient } from './client.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { errorReason } from './format.js';
import { integrationKeyStatus, parseExpires } from './integration.js';
import { redactError } from './redact.js';

// デーモンの応答の型から導く（`integration.ts` と同じ）: 手で写さない
type AccessTokensView = InferResponseType<DaemonClient['access-tokens']['$get'], 200>;
type AccessTokenView = AccessTokensView['tokens'][number];

// `alteroid token` は認証トークンのプール（Claude の鍵）の口で、ここは別物。種類は決まった2つだけ（`scopes` のような選べる一覧は足さない）
const KINDS = ['read', 'full'] as const;
type AccessTokenKind = (typeof KINDS)[number];

const STATUS_LABEL = { active: '有効', revoked: '失効', expired: '期限切れ' } as const;

const KIND_GUIDE: Record<AccessTokenKind, string> = {
  read: '種類 read: 読むだけ。通るのは記憶・日誌・利用・/self/prompt の読み取りと /mcp です。',
  full: '種類 full: ログインのトークンと同じ強さです（発行トークンからは新しいトークンを発行できません）。',
};

const ISSUED_FORBIDDEN_MESSAGE =
  '発行したアクセストークンからは、アクセストークンの発行・一覧・失効は使えません。' +
  'alteroid login した人か、実行環境の持ち主の資格で行ってください（自分自身の失効は alteroid logout）。';

const ACCOUNT_REQUIRED_HINT =
  '--account <アカウント id> を付けてください（実行環境の持ち主の資格では対象のアカウントが要る。id は alteroid access list で見る）';

function accountQuery(account: string | undefined): { accountId?: string } {
  return account === undefined ? {} : { accountId: account };
}

function checkAccount(account: string | undefined, nothingDone: string): void {
  if (account !== undefined && account.trim().length === 0) {
    throw new Error(`--account は空にできません（${nothingDone}）`);
  }
}

// 出す側が値を足す: 値を持つのはここの1か所の組み立てだけ（人向けも --json もこれを使う）
export function mcpServerConfig(baseUrl: string, value: string) {
  return {
    // キー名を alteroid にしない: 別の alteroid の「設定 — MCP サーバ」では alteroid が予約名で、貼ると断られるため
    'alteroid-remote': {
      type: 'http',
      url: `${new URL(baseUrl).origin}/mcp`,
      headers: { Authorization: `Bearer ${value}` },
    },
  };
}

export async function accessTokenListCommand(
  options: { account?: string } = {},
  now: number = Date.now(),
): Promise<void> {
  checkAccount(options.account, '何も読んでいません');
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['access-tokens'].$get({ query: accountQuery(options.account) });
  if (!response.ok) return fail(response, target, '/access-tokens');
  const { tokens } = await response.json();
  stdout.write(renderList(tokens, now));
}

function originLabel(token: AccessTokenView): string {
  return token.origin === 'login' ? 'ログイン' : `発行（${token.issuedBy ?? '不明'}）`;
}

function renderList(tokens: AccessTokenView[], now: number): string {
  if (tokens.length === 0) {
    return (
      'アクセストークンはありません。\n' +
      '発行するには: alteroid access-token create --name <名前> [--kind read|full]\n'
    );
  }
  const lines = [`アクセストークン: ${String(tokens.length)} 件`];
  for (const token of tokens) {
    lines.push(
      `[${STATUS_LABEL[integrationKeyStatus(token, now)]}] ${token.name}  種類=${token.kind}  発行元=${originLabel(token)}`,
      `  id: ${token.id}`,
      `  指紋: ${token.fingerprint.slice(0, 12)}`,
      `  作成: ${token.createdAt}`,
      `  最終使用: ${token.lastUsedAt ?? '（まだ使われていない）'}`,
      `  期限: ${token.expiresAt ?? '（無期限）'}`,
    );
    if (token.revokedAt !== null) lines.push(`  失効: ${token.revokedAt}`);
  }
  return `${lines.join('\n')}\n`;
}

interface AccessTokenCreateOptions {
  name: string;
  kind?: string;
  expires?: string;
  account?: string;
  json?: boolean;
}

function parseKind(text: string | undefined): AccessTokenKind {
  if (text === undefined) return 'read';
  const found = KINDS.find((kind) => kind === text);
  if (found === undefined) {
    throw new Error(`--kind は read か full で指定してください: ${text}（何も発行していません）`);
  }
  return found;
}

export async function accessTokenCreateCommand(
  options: AccessTokenCreateOptions,
  now: number = Date.now(),
): Promise<void> {
  const name = options.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new Error('--name は 1〜200 文字で指定してください（何も発行していません）');
  }
  const kind = parseKind(options.kind);
  checkAccount(options.account, '何も発行していません');
  const json: {
    name: string;
    kind: AccessTokenKind;
    expiresAt?: string | null;
    accountId?: string;
  } = { name, kind };
  // 省略はサーバの既定（30 日）。無期限は never と明示したときだけ null を送る
  if (options.expires !== undefined) {
    json.expiresAt = options.expires.trim() === 'never' ? null : parseExpires(options.expires, now);
  }
  if (options.account !== undefined) json.accountId = options.account.trim();

  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['access-tokens'].$post({ json });
  if (!response.ok) return fail(response, target, '/access-tokens');
  const created = await response.json();
  const mcp = mcpServerConfig(target.baseUrl, created.value);
  if (options.json === true) {
    // 警告を標準出力へ出さない: `... --json | jq -r .value` で受けても混ざらないように
    stdout.writeRaw(`${JSON.stringify({ ...created, mcp }, null, 2)}\n`);
    stderr.write(
      'この値は二度と表示されません（alteroid は sha256 しか保存していません）。標準出力の JSON の value に入っています。\n' +
        '値をログに残さないでください（CI のログ・シェルの履歴・出力の保存先に注意。変数や秘密の保管先へ直接受けてください）。\n',
    );
    return;
  }
  stdout.write(renderCreated(created.token, created.value, mcp));
}

// 値を書くのは「値」の1行と、そのまま貼れる MCP の JSON の2か所だけ: 保存も再表示もしない
function renderCreated(
  token: AccessTokenView,
  value: string,
  mcp: ReturnType<typeof mcpServerConfig>,
): string {
  const lines = [
    `アクセストークンを発行しました: ${token.name}`,
    `  id: ${token.id}`,
    `  種類: ${token.kind}`,
    `  指紋: ${token.fingerprint.slice(0, 12)}`,
    `  期限: ${token.expiresAt ?? '（無期限）'}`,
    '',
    'この値は二度と表示されません（alteroid は sha256 しか保存していません）。いま控えてください:',
    `  ${value}`,
    '',
    KIND_GUIDE[token.kind],
    '',
    'MCP サーバの登録に使う JSON（.mcp.json などの mcpServers に入れる。名前を alteroid-remote にしてあるのは、別の alteroid の「設定 — MCP サーバ」では alteroid が予約名で断られるため）:',
    ...JSON.stringify(mcp, null, 2)
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    `失効するには: alteroid access-token revoke ${token.id}`,
  ];
  return `${lines.join('\n')}\n`;
}

interface AccessTokenRevokeOptions {
  account?: string;
  yes?: boolean;
  io?: ConfirmIo;
}

export async function accessTokenRevokeCommand(
  id: string,
  options: AccessTokenRevokeOptions = {},
): Promise<void> {
  checkAccount(options.account, '何も失効していません');
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  const query = accountQuery(options.account);
  const listed = await client['access-tokens'].$get({ query });
  if (!listed.ok) return fail(listed, target, '/access-tokens');
  const { tokens } = await listed.json();
  const token = tokens.find((row) => row.id === id);
  if (token === undefined)
    throw new Error('該当するアクセストークンがありません（何も失効していません）');
  if (token.revokedAt !== null) {
    stdout.write(`すでに失効しています: ${token.name}（失効 ${token.revokedAt}）\n`);
    return;
  }
  await confirmIrreversible(
    `アクセストークン「${token.name}」（種類=${token.kind}）を失効させます。\n` +
      '以後このトークンを使っている相手は 401 になります。',
    { yes: options.yes },
    options.io,
  );
  const response = await client['access-tokens'][':id'].revoke.$post({ param: { id }, query });
  if (!response.ok) return fail(response, target, `/access-tokens/${id}/revoke`);
  const { token: revoked } = await response.json();
  stdout.write(
    `アクセストークンを失効させました: ${revoked.name}（失効 ${revoked.revokedAt ?? '?'}）\n`,
  );
}

async function fail(
  response: { status: number; json(): Promise<unknown> },
  target: Target,
  path: string,
): Promise<never> {
  const reason = await errorReason(response);
  if (response.status === 403 && reason !== null && reason.includes('発行したアクセストークン')) {
    throw new Error(ISSUED_FORBIDDEN_MESSAGE);
  }
  if (response.status === 403 && reason !== null && reason.includes('自分のアカウント')) {
    throw new Error(`${reason}（何も変更していません）`);
  }
  const described = describeAuthFailure(response.status, target);
  if (described !== null) throw new Error(described);
  if (response.status === 404)
    throw new Error('該当するアカウントまたはアクセストークンがありません');
  if (response.status === 400) {
    const text = reason ?? '入力が不正です';
    const hint = text.includes('accountId') ? `。${ACCOUNT_REQUIRED_HINT}` : '';
    const body = `${text}${hint}`;
    throw new Error(/[）)]$/.test(body) ? body : `${body}（何も変更していません）`);
  }
  throw new Error(
    reason === null
      ? `${path} が失敗しました (${String(response.status)})`
      : `${path} が失敗しました (${String(response.status)}): ${redactError(reason)}`,
  );
}
