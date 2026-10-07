import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible } from './confirm.js';
import { redactError } from './redact.js';
import { readInputFile } from './input-errors.js';

interface AgentTokenView {
  id: string;
  label: string;
  order: number;
  sha256?: string;
  source?: 'stored';
  disabledAt?: string;
  cooldownUntil?: number;
  cooldownSource?: 'quota_reset' | 'overage_reset' | 'notice_text' | 'default';
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
  createdAt?: string;
  updatedAt?: string;
  recovery?: 'time' | 'action' | 'unknown';
}

interface TokenRotationSettings {
  rotateOn: 'free_exhausted' | 'overage_exhausted' | 'off';
  cooldownMs: number;
  updatedAt?: string;
}

interface TokensView {
  tokens: AgentTokenView[];
  settings?: TokenRotationSettings;
  settingsUnreadable?: { reason: string };
  rowsUnreadable?: {
    count: number;
    rows: { id?: string; label?: string; reason: string }[];
    carriedOver?: true;
  };
}

interface AgentTokenInput {
  id?: string;
  label: string;
  value?: string;
  order?: number;
  disabled?: boolean;
}

// 直し方は両方を渡す形だけを案内する: 読めない現在値は、両方揃った入力でしか上書きできないため
export const SETTINGS_UNREADABLE_FIX_COMMAND =
  'alteroid token policy <free_exhausted|overage_exhausted|off> --cooldown-ms <ミリ秒>';

export function describeSettingsUnreadable(reason: string | undefined): string {
  return (
    `回転の設定は読めない（消えたのではなく、読めない形で入っている）: ${reason ?? '理由不明'}\n` +
    `直すには、回す契機と冷却の既定の両方を指定して保存し直す（片方だけでは保存できない）:\n` +
    `  ${SETTINGS_UNREADABLE_FIX_COMMAND}\n`
  );
}

export function describeRowsUnreadable(
  unreadable: TokensView['rowsUnreadable'] | undefined,
): string {
  if (unreadable === undefined || unreadable.count === 0) return '';
  const lines = unreadable.rows.map((row) => {
    const identity =
      [
        row.id === undefined ? null : `id=${row.id}`,
        row.label === undefined ? null : `label=${row.label}`,
      ]
        .filter((part) => part !== null)
        .join(' ') || '（id もラベルも取れない）';
    return `  ${identity}  ${row.reason}\n`;
  });
  return (
    `読めないトークンの行が ${String(unreadable.count)} 件ある（消えたのではなく、読めない形で入っている）。` +
    'この一覧には載っていない:\n' +
    lines.join('') +
    'プールを書き換える操作（token add / remove / disable / enable）は、この行を捨てずに持ち越す。\n' +
    '消すには、id を指す: alteroid token remove-unreadable <id>' +
    (unreadable.rows.some((row) => row.id === undefined)
      ? '（id が取れない行は、この口では消せない）'
      : '') +
    '\n'
  );
}

export function describeCarriedOver(view: PutTokensView): string {
  // 件数を言わない: 読み直しに失敗しており、「持ち越した行は無い」と読めてしまうため
  if (view.viewUnavailable !== undefined) {
    return (
      '保存した。ただし、保存後のプールを読み直せなかった（今の姿は分からない。' +
      '撃ち直さず、alteroid token list で確かめる）。\n'
    );
  }
  const unreadable = view.rowsUnreadable;
  if (unreadable === undefined || unreadable.count === 0) return '';
  return (
    `読めないトークンの行 ${String(unreadable.count)} 行は、捨てずに持ち越した` +
    '（消すには alteroid token remove-unreadable <id>。id は token list で見る）。\n'
  );
}

export async function tokenRemoveUnreadableCommand(
  ids: readonly string[],
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(
    `読めないトークンの行（id: ${ids.join(', ')}）を消します。壊れた行は消すと残りません。`,
    options,
  );
  const result = (await request(target, '/tokens/unreadable/remove', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })) as Partial<TokensView> & {
    removedIds: string[];
    viewUnavailable?: { reason: string };
  };
  stdout.write(
    `読めないトークンの行を ${String(result.removedIds.length)} 行消した（id: ${result.removedIds.join(', ')}）。\n`,
  );
  // 残りの件数を言わない: 読み直しに失敗しており、「読めない行は無い」と読めてしまうため
  if (result.viewUnavailable !== undefined) {
    stdout.write(
      '消した後のプールを読み直せなかった（残りの読めない行は分からない。' +
        'alteroid token list で確かめる）。\n',
    );
    return;
  }
  const left = result.rowsUnreadable;
  if (left !== undefined) {
    stdout.write(
      `読めない行は、まだ ${String(left.count)} 行ある（alteroid token list で見る）。\n`,
    );
  }
}

export async function tokenListCommand(): Promise<void> {
  const target = await resolveTarget();
  const view = (await request(target, '/tokens')) as TokensView;

  // 既定値で埋めない: 空欄と壊れた値を混同すると、設定したことが無いと誤読するため
  if (view.settings === undefined) {
    stdout.write(describeSettingsUnreadable(view.settingsUnreadable?.reason));
  } else {
    stdout.write(
      `回す契機: ${view.settings.rotateOn}（resetsAt が取れないときの冷却の既定 ${String(view.settings.cooldownMs)}ms）\n`,
    );
  }

  stdout.write(describeRowsUnreadable(view.rowsUnreadable));

  if (view.tokens.length === 0 && view.rowsUnreadable !== undefined) {
    // 「登録されていません」と言わない: 読めない行が使えるかどうかは、ここからは分からないため
    stdout.write('読めたトークンの行は無い（登録されていない、とは言えない）。\n');
    stdout.write('読めない行が使えるかどうかは分からないので、自動切替が効かないとも言えない。\n');
    return;
  }

  if (view.tokens.length === 0) {
    stdout.write('トークンは登録されていません。\n');
    stdout.write(
      '**この状態では、認証は器の環境変数（CLAUDE_CODE_OAUTH_TOKEN）に頼るしかなく、' +
        '枠に当たっても記録が残りません。** トークンプールは100% DB 駆動である——' +
        '登録するまで、プール側の自動切替は一切効きません。\n',
    );
    stdout.write('登録するには: alteroid token add --label <名前> --file <path>\n');
    return;
  }

  const now = Date.now();
  stdout.write('\n');
  for (const token of [...view.tokens].sort((a, b) => a.order - b.order)) {
    const identity = `sha256=${token.sha256 ?? '（指紋が取れていない）'}`;
    stdout.write(`${String(token.order)}. ${token.label}  id=${token.id}  ${identity}\n`);
    const stamps = describeStamps(token);
    if (stamps !== null) stdout.write(`   ${stamps}\n`);
    const status = describeStatus(token, now);
    if (status !== null) stdout.write(`   ${status}\n`);
  }
}

// 無い時刻を「不明」と書かず、その行だけ出さない: 取れなかったことを埋めないため
function describeStamps(token: AgentTokenView): string | null {
  const parts: string[] = [];
  if (token.createdAt !== undefined) parts.push(`置いた ${token.createdAt}`);
  if (token.updatedAt !== undefined) parts.push(`最後の更新 ${token.updatedAt}`);
  return parts.length === 0 ? null : parts.join(' / ');
}

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
    parts.push(`冷却中（あと約 ${String(remainingMinutes)} 分。${describeCooldownSource(token)}）`);
  }
  if (token.lastRejectedReason !== undefined) {
    parts.push(`最後の拒否: ${token.lastRejectedReason}（${token.lastRejectedAt ?? '?'}）`);
  }
  // 断りを同じ行に置く: 実測の隣に判定を並べると、行ごと実測として読まれるため
  if (token.recovery !== undefined) {
    parts.push(`見込み: ${describeRecovery(token.recovery)}（文言からの分類。実測ではない）`);
  }
  return parts.length === 0 ? null : parts.join(' / ');
}

// 権威ある値のときも出所を言う: 何も書かないと「推測ではない」と「まだ対応していない版」の両方を意味してしまうため
function describeCooldownSource(token: AgentTokenView): string {
  switch (token.cooldownSource) {
    case 'quota_reset':
      return '出所は枠の resetsAt（権威ある値）';
    case 'overage_reset':
      return '出所は課金枠の overageResetsAt（権威ある値。枠そのものではない）';
    case 'notice_text':
      return '出所は上限の文言に書かれていた時刻（推測。ただし既定よりは良い）';
    case 'default':
      return '出所は設定の既定（ただの推測である）';
    // 型で塞いだ分岐にも倒れ先を持つ: CLI とデーモンは別に配られ、知らない語が来うるため
    default:
      return '出所は記録されていない';
  }
}

function describeRecovery(recovery: 'time' | 'action' | 'unknown'): string {
  return recovery === 'time'
    ? '時間で戻る'
    : recovery === 'action'
      ? '人間が動かないと戻らない（入金・管理者・座席種別）'
      : '分からない';
}

// 値をコマンドライン引数で受けない: `argv` は同じ器の他のプロセスから見えるため
export async function tokenAddCommand(options: { label: string; file?: string }): Promise<void> {
  const raw =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
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
  const view = await putTokens(target, inputs);
  stdout.write(`トークン「${options.label}」を追加しました。\n`);
  stdout.write(describeCarriedOver(view));
}

export async function tokenRemoveCommand(
  id: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  const current = (await request(target, '/tokens')) as TokensView;
  if (!current.tokens.some((token) => token.id === id)) {
    throw new Error(
      `id ${id} のトークンは見つかりません（alteroid token list で id を確かめてください）`,
    );
  }
  await confirmIrreversible(
    `トークン（id ${id}）を削除します。値は読み出せないので、登録し直すには元の値が要ります（値を残したまま外すなら alteroid token disable ${id}）。`,
    options,
  );
  const inputs = current.tokens.filter((token) => token.id !== id).map(toInput);
  const view = await putTokens(target, inputs);
  stdout.write(`トークン（id ${id}）を削除しました。\n`);
  stdout.write(describeCarriedOver(view));
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
    throw new Error(
      `id ${id} のトークンは見つかりません（alteroid token list で id を確かめてください）`,
    );
  }
  const inputs = current.tokens.map((token) =>
    token.id === id ? { ...toInput(token), disabled } : toInput(token),
  );
  const view = await putTokens(target, inputs);
  stdout.write(`トークン（id ${id}）を${disabled ? '外しました' : '戻しました'}。\n`);
  stdout.write(describeCarriedOver(view));
}

const ROTATE_ON_VALUES: readonly string[] = ['free_exhausted', 'overage_exhausted', 'off'];

export async function tokenPolicyCommand(
  value: string | undefined,
  options: { cooldownMs?: string } = {},
): Promise<void> {
  const patch: { rotateOn?: string; cooldownMs?: number } = {};
  if (value !== undefined) {
    if (!ROTATE_ON_VALUES.includes(value)) {
      throw new Error(
        `token policy の第1引数は ${ROTATE_ON_VALUES.join(' / ')} のいずれか（渡されたのは ${value}）。` +
          'free_exhausted は無料枠が尽きたら回す、overage_exhausted は課金枠まで閉じてから回す、' +
          'off は回さない（記録だけする）',
      );
    }
    patch.rotateOn = value;
  }
  if (options.cooldownMs !== undefined) {
    const parsed = Number(options.cooldownMs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `--cooldown-ms は正の数（ミリ秒）で指定する（渡されたのは ${options.cooldownMs}）`,
      );
    }
    patch.cooldownMs = parsed;
  }

  const target = await resolveTarget();

  if (value === undefined && options.cooldownMs === undefined) {
    const current = (await request(target, '/tokens')) as TokensView;
    if (current.settings === undefined) {
      stdout.write(describeSettingsUnreadable(current.settingsUnreadable?.reason));
      return;
    }
    printSettings(current.settings);
    return;
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

function toInput(token: AgentTokenView): AgentTokenInput {
  return { id: token.id, label: token.label, order: token.order };
}

type PutTokensView = Partial<TokensView> & { viewUnavailable?: { reason: string } };

async function putTokens(target: Target, tokens: AgentTokenInput[]): Promise<PutTokensView> {
  return (await request(target, '/tokens', {
    method: 'PUT',
    body: JSON.stringify({ tokens }),
  })) as PutTokensView;
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
    // `not_operator` の枝を消さない: デーモン側で門が戻ったとき `unknown` へ落ちて案内が消えるため
    // 403 の本文を見ずに固定の文言を出さない: 未 grant の人に直らない手順を勧めてしまうため
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_operator') {
        throw new Error(
          '認証トークンのプールを触れるのは、その実行環境の持ち主だけです。\n' +
            'デーモンが動いているのと同じ環境で実行してください:\n' +
            '  docker compose exec app alteroid token list\n',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // `unknown` では解決策を書かない: どちらかを当てずっぽうで出せば半分の状況で嘘になるため
      throw new Error(
        '認証トークンのプールへのアクセスが拒否されました（403）。理由を判別できな' +
          'かったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    if (response.status === 500 && body.code === 'journal_write_failed') {
      throw new Error(
        '記録（日誌）が書けなかったので、変更していません。\n' +
          'デーモンの記憶ディレクトリ（日誌の置き場所）に書けるか確かめてから、もう一度実行してください。',
      );
    }
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    if (response.status >= 500 && init.method === 'PUT') {
      throw new Error(
        `デーモンが失敗を返しました（${String(response.status)}、${path}）。変更されたかどうかは分かりません。\n` +
          'alteroid token list で今の姿を確かめてください（デーモンの標準エラーに理由の跡があります）。',
      );
    }
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
