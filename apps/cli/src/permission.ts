import { stdout } from 'node:process';

import {
  assessPermissionGrantStaleness,
  describePermissionRuleBreadth,
  PERMISSION_GRANT_STALE_DAYS,
} from '@alteroid/core/cli-light';
import type { PermissionGrant } from '@alteroid/core';

import { createClient } from './client.js';
import { describeUnreadableRowsList, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';

/**
 * `alteroid permission` — 人間が承認した Bash 許可（Issue #863「許可をコードでは
 * なくデータにする」）を、CLI から棚卸しする。
 *
 * **入口の等価性**（PRD「インターフェース」——CLI・HTTP API・Web UI の3つで同じ
 * ことができる）を埋める側の1本。`GET /permission-grants` /
 * `POST /permission-grants/:id/revoke`（`apps/daemon/src/app.ts`）は PR #1491
 * で足されたが、人間が読む面（CLI・Web UI）からの入口が無かった——#863 が
 * #193 から引き継いだ残項目の1つ（「CLI / Web UI（入口の等価性）」）。
 *
 * **`request_permission` / 許可を記録する側はここに無い。** あちらはクローンの
 * 道具（`packages/core/src/tools.ts`）と人間の承認（`answerApproval`）が持ち、
 * ここは記録された後の一覧・取り消しだけを持つ——Issue #863 C 節「クローンが
 * 許可の DB へ直接書けてはいけない」の境界の外側（人間が読む面）である。
 *
 * **規則の広さの段階表示**（#193 から畳んだ残項目のもう1つ）。`Bash(gh pr
 * merge:*)` と `Bash(gh:*)` は同じ「前方一致」という書式でも、実際に通す範囲は
 * 桁違いに違う——見分けられないと、棚卸しをしても「広すぎる許可」に気づけない。
 * 判定は `describePermissionRuleBreadth`（`@alteroid/core`。純関数、
 * `permission-rule.test.ts` で照合器と同じ意味論であることを固定してある）に
 * 寄せ、ここでは日本語の文言へ変換するだけ——`access.ts` の `describeGrantedBy`
 * と同じ役割分担（判定は共有、文言は入口ごと）。
 */

export interface PermissionListOptions {
  /** 取り消し済みも含めて全部見る。既定は有効な（`revokedAt` の無い）ものだけ。 */
  all?: boolean;
  /** 「長く使われていない」の起点になる現在時刻。テストが時計を注入する。既定は今。 */
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
    stdout.write(
      `${described ?? (await withErrorReason(`許可の一覧を読めませんでした（${response.status}）`, response))}\n`,
    );
    return;
  }
  const { grants, rowsUnreadable } = (await response.json()) as {
    grants: PermissionGrant[];
    /** 読めない行（1件でも在るときだけ載る。issue #2536）。id と不正な欄名だけで、本文は無い。 */
    rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
  };
  // **読めない行は一覧の前に言う**（0件なら何も出ない）。読めない行しか無いのに「許可は無い」と
  // 言わないために、下の「無い」の文言もこれで言い分ける。
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
      // 読めない行が在るので「許可は無い」とは言えない（issue #2536）。
      stdout.write('読めた許可は無い（許可が無い、とは言えない）。\n');
      return;
    }
    // Web（`apps/web/app/routes/permissions.tsx` の `PermissionsBody`）と同じ
    // 条件・文言。`--all` を付けても取り消し済みが1件も無ければ増える見込みが
    // 無いので、案内は「取り消し済みが在るとき」だけに絞る（#1541）。
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
  // 長く使われていない許可の要約（Issue #1804）。目立たせるだけで、取り消しは人が決める。
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

export async function permissionRevokeCommand(id: string): Promise<void> {
  const target = await resolveTarget();
  // 未ログインの note も例外にする（#2456、クローン teto の判断 2026-09-30）。
  // 何もせず 0 で返すと「取り消した」と誤読される。読み取り系（一覧）は今のまま。
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['permission-grants'][':id'].revoke.$post({ param: { id } });
  // **失敗を握り潰さない。** 取り消しは安全側への操作なので「取り消せたか」を
  // 終了コードで確実に区別する（`access.ts` の revoke / `inbox.ts` の remove と
  // 同じ判断——`grep -Fn -- '消えたのか消えなかったのか' apps/cli/src/inbox.ts`）。
  if (!response.ok) {
    if (response.status === 404) throw new Error(`該当する許可がありません: ${id}`);
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`許可を取り消せませんでした（${response.status}）`, response),
    );
  }
  stdout.write(`許可を取り消しました: ${id}\n`);
  // **即座に効く。** `#onPreToolUse` は毎回ストアを引き直すので、キャッシュされた
  // 古い許可が生き残ることはない（`clone.ts` の doc）。
  stdout.write('（次の Bash 呼び出しから効きます。取り消し済みなら重ねて叩いても失敗しません）\n');
}

/**
 * 読めない許可の行を、id を指して消す（`POST /permission-grants/unreadable/remove`。
 * issue #2440）。読めない行（版ずれ・手編集）は `permission revoke` が 409 で触らないので、
 * 片付ける口はこれだけ。**id は `permission list` が読めない行として出す**
 * （`GET /permission-grants` の `rowsUnreadable.rows[].id`。issue #2536）。**id が取れない行は
 * この口では消せない**（`permission-grants.json` を手で直す）。指した id が1つでも読めない行に
 * 無ければ、デーモンが何も消さずに断る。**行の中身は出さない**（id と件数だけ）。
 */
export async function permissionRemoveUnreadableCommand(ids: readonly string[]): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
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

/** 規則の広さを日本語の文言へ（判定は `describePermissionRuleBreadth` に寄せる）。 */
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
