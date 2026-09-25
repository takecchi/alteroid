import { stdout } from 'node:process';

import { describePermissionRuleBreadth, type PermissionGrant } from '@alteroid/core';

import { createClient } from './client.js';
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
}

export async function permissionListCommand(options: PermissionListOptions = {}): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['permission-grants'].$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    stdout.write(`${described ?? `許可の一覧を読めませんでした（${response.status}）`}\n`);
    return;
  }
  const { grants } = (await response.json()) as { grants: PermissionGrant[] };
  const shown =
    options.all === true ? grants : grants.filter((grant) => grant.revokedAt === undefined);

  if (shown.length === 0) {
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

  stdout.write(shown.map(renderGrant).join('\n'));

  const active = grants.filter((grant) => grant.revokedAt === undefined).length;
  const revoked = grants.length - active;
  stdout.write(`\n計 ${grants.length} 件（有効 ${active} 件・取り消し済み ${revoked} 件）`);
  if (options.all !== true && revoked > 0) {
    stdout.write('。--all で取り消し済みも見られます');
  }
  stdout.write('\n');
}

export async function permissionRevokeCommand(id: string): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['permission-grants'][':id'].revoke.$post({ param: { id } });
  // **失敗を握り潰さない。** 取り消しは安全側への操作なので「取り消せたか」を
  // 終了コードで確実に区別する（`access.ts` の revoke / `inbox.ts` の remove と
  // 同じ判断——`grep -Fn -- '消えたのか消えなかったのか' apps/cli/src/inbox.ts`）。
  if (!response.ok) {
    if (response.status === 404) throw new Error(`該当する許可がありません: ${id}`);
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(`許可を取り消せませんでした（${response.status}）`);
  }
  stdout.write(`許可を取り消しました: ${id}\n`);
  // **即座に効く。** `#onPreToolUse` は毎回ストアを引き直すので、キャッシュされた
  // 古い許可が生き残ることはない（`clone.ts` の doc）。
  stdout.write('（次の Bash 呼び出しから効きます。取り消し済みなら重ねて叩いても失敗しません）\n');
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

function renderGrant(grant: PermissionGrant): string {
  const lines: string[] = [];
  lines.push(`${grant.revokedAt === undefined ? '[有効]' : '[取り消し済み]'} ${grant.rule}`);
  lines.push(`  id: ${grant.id}`);
  lines.push(`  広さ: ${describeBreadth(grant.rule)}`);
  lines.push(`  承認: ${grant.grantedAt}（${grant.route.accountId}・"${grant.answer}"）`);
  lines.push(
    `  最終使用: ${grant.lastUsedAt === undefined ? '（まだ使われていません）' : grant.lastUsedAt}`,
  );
  if (grant.revokedAt !== undefined) lines.push(`  取り消し: ${grant.revokedAt}`);
  lines.push('');
  return lines.join('\n');
}
