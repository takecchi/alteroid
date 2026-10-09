import { stdout } from './terminal-out.js';

import {
  assessPermissionGrantStaleness,
  describePermissionRuleBreadth,
  PERMISSION_GRANT_STALE_DAYS,
} from '@alteroid/core/cli-light';
import type { PermissionGrant } from '@alteroid/core';

import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { createClient } from './client.js';
import { describeUnreadableRowsList, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';

export interface PermissionListOptions {
  all?: boolean;
  now?: Date;
}

export async function permissionListCommand(options: PermissionListOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['permission-grants'].$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`許可の一覧を読めませんでした（${response.status}）`, response),
    );
  }
  const { grants, rowsUnreadable } = (await response.json()) as {
    grants: PermissionGrant[];
    rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
  };
  stdout.write(
    describeUnreadableRowsList({
      noun: '許可',
      removeCommand: 'alteroid permission remove-unreadable',
      file: 'permission-grants.json',
      rowsUnreadable,
    }),
  );
  const shown =
    options.all === true ? grants : grants.filter((grant) => grant.revokedAt === undefined);

  if (shown.length === 0) {
    if (rowsUnreadable !== undefined && grants.length === 0) {
      stdout.write('読めた許可は無い（許可が無い、とは言えない）。\n');
      return;
    }
    if (options.all === true) {
      stdout.write('許可はまだ1件もありません。\n');
    } else if (grants.length > 0) {
      stdout.write('有効な許可はありません（--all を付けると取り消し済みも含めて見られます）。\n');
    } else {
      stdout.write('有効な許可はありません。\n');
    }
    return;
  }

  stdout.write(shown.map((grant) => renderGrant(grant, now)).join('\n'));

  const active = grants.filter((grant) => grant.revokedAt === undefined).length;
  const revoked = grants.length - active;
  const staleCount = shown.filter(
    (grant) => assessPermissionGrantStaleness(grant, now).stale,
  ).length;
  if (staleCount > 0) {
    stdout.write(
      `\n長く使われていない許可: ${staleCount} 件（${PERMISSION_GRANT_STALE_DAYS} 日以上）`,
    );
  }
  stdout.write(`\n計 ${grants.length} 件（有効 ${active} 件・取り消し済み ${revoked} 件）`);
  if (options.all !== true && revoked > 0) {
    stdout.write('。--all で取り消し済みも見られます');
  }
  stdout.write('\n');
}

export async function permissionRevokeCommand(
  id: string,
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const target = await resolveTarget();
  // 未ログインの note も例外にする: 何もせず 0 で返すと「取り消した」と誤読される。
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  // 読めない行（`rowsUnreadable`）に在る id は「無い」と言わない: 確認へ進み、POST の 409 の案内（持ち主はデーモン）に任せる。
  const listing = await client['permission-grants'].$get();
  if (!listing.ok) {
    const described = describeAuthFailure(listing.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`許可の一覧を読めませんでした（${listing.status}）`, listing),
    );
  }
  const { grants, rowsUnreadable } = (await listing.json()) as {
    grants: PermissionGrant[];
    rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
  };
  const exists =
    grants.some((grant) => grant.id === id) ||
    (rowsUnreadable?.rows.some((row) => row.id === id) ?? false);
  if (!exists) throw new Error(`該当する許可がありません: ${id}`);
  await confirmIrreversible(
    `許可 ${id} を取り消します。元に戻す口は無く、同じ許可は、クローンに頼み直して承認し直すまで戻りません。`,
    options,
    io,
  );
  const response = await client['permission-grants'][':id'].revoke.$post({ param: { id } });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`該当する許可がありません: ${id}`);
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`許可を取り消せませんでした（${response.status}）`, response),
    );
  }
  stdout.write(`許可を取り消しました: ${id}\n`);
  stdout.write('（次の Bash 呼び出しから効きます。取り消し済みなら重ねて叩いても失敗しません）\n');
}

/** 行の中身は出さない（id と件数だけ）。id が取れない行はこの口では消せない（`permission-grants.json` を手で直す）。 */
export async function permissionRemoveUnreadableCommand(
  ids: readonly string[],
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(
    `読めない許可の行（id: ${ids.join(', ')}）を消します。壊れた行は消すと残りません。`,
    options,
  );
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['permission-grants'].unreadable.remove.$post({
    json: { ids: [...ids] },
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        '指した id が、読めない許可の行にありません（何も消していません。' +
          'id は alteroid permission list の「読めない許可の行」で確かめます。' +
          'id が取れない行はこの口では消せません）',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`読めない許可の行を消せませんでした（${response.status}）`, response),
    );
  }
  const result = (await response.json()) as { removedIds: string[] };
  stdout.write(
    `読めない許可の行を ${String(result.removedIds.length)} 行消しました（id: ${result.removedIds.join(', ')}）\n`,
  );
}

function describeBreadth(rule: string): string {
  const breadth = describePermissionRuleBreadth(rule);
  switch (breadth.level) {
    case 'exact':
      return '完全一致（最も狭い。この文字列にしか一致しない）';
    case 'narrow':
      return `前方一致・狭い（固定 ${breadth.prefixWordCount} 語まで一致）`;
    case 'medium':
      return `前方一致・中間（固定 ${breadth.prefixWordCount} 語まで一致）`;
    case 'broad':
      return `前方一致・広い（固定 ${breadth.prefixWordCount} 語のみ——この語で始まるコマンドなら何でも通る）`;
    case 'invalid':
      return '⚠️ 規則が不正（照合されない。壊れている可能性がある）';
  }
}

function renderGrant(grant: PermissionGrant, now: Date): string {
  const staleness = assessPermissionGrantStaleness(grant, now);
  const lines: string[] = [];
  lines.push(
    `${grant.revokedAt === undefined ? '[有効]' : '[取り消し済み]'}${staleness.stale ? ' ⚠️ [長期未使用]' : ''} ${grant.rule}`,
  );
  lines.push(`  id: ${grant.id}`);
  lines.push(`  広さ: ${describeBreadth(grant.rule)}`);
  lines.push(`  承認: ${grant.grantedAt}（${grant.route.accountId}・"${grant.answer}"）`);
  lines.push(
    `  最終使用: ${grant.lastUsedAt === undefined ? '（まだ使われていません）' : grant.lastUsedAt}`,
  );
  if (staleness.stale) {
    lines.push(
      `  ⚠️ ${staleness.idleDays} 日使われていません（起点: ${staleness.basis === 'lastUsedAt' ? '最終使用' : '付与'}）。取り消すなら \`alteroid permission revoke ${grant.id}\``,
    );
  }
  if (grant.revokedAt !== undefined) lines.push(`  取り消し: ${grant.revokedAt}`);
  lines.push('');
  return lines.join('\n');
}
