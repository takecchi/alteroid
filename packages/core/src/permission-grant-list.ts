import { compareIsoInstant } from './iso-instant.js';
import { describePage, excerptLine, page, renderListing, renderListingEntry } from './excerpt.js';
import { toRowsUnreadable } from './schema.js';
import type { PermissionGrant } from './schema.js';
import type { PermissionGrantStore, Stores } from './store.js';

/**
 * `tools.ts` に置かない: `tools.test.ts` が「どのハンドラも `permissionGrants` に触れない」を
 * 字面で固定しており、その歯を緩めないため。口を `list` / `listUnreadable` に絞り、
 * `permission-grant-list.test.ts` がこのファイルが書き手の口に触れないことを固定する。
 * 取り消し・読めない行を消す口は足さない（人間の手に限る）。
 */
export type PermissionGrantReader = Pick<PermissionGrantStore, 'list' | 'listUnreadable'>;

/** `TOKEN_LIST_BUDGET` を使い回さない（値が同じでも由来が違う。許可の本文は長さの上限が無い）。 */
const PERMISSION_GRANT_LIST_BUDGET = 6_000;
const PERMISSION_GRANT_EXCERPT = 160;
const PERMISSION_GRANT_PAGE = 6_000;
const PERMISSION_GRANT_UNREADABLE_ROWS_LIMIT = 20;

export async function renderPermissionGrantList(
  stores: Pick<Stores, 'permissionGrants'>,
  args: { id?: string | undefined; from?: number | undefined; offset?: number | undefined },
): Promise<string> {
  const reader: PermissionGrantReader = {
    list: () => stores.permissionGrants.list(),
    listUnreadable: () => stores.permissionGrants.listUnreadable(),
  };
  const { id, from = 0, offset = 0 } = args;
  const grants = await reader.list();
  // 読めない行しか無いと `grants` は空で「許可が無い」に見えるので、1件でも在れば載せる。
  const unreadable = toRowsUnreadable(await reader.listUnreadable());
  const unreadableLines =
    unreadable === undefined
      ? []
      : [
          `rowsUnreadable: ${JSON.stringify({
            count: unreadable.count,
            rows: unreadable.rows.slice(0, PERMISSION_GRANT_UNREADABLE_ROWS_LIMIT),
          })}`,
          ...(unreadable.rows.length > PERMISSION_GRANT_UNREADABLE_ROWS_LIMIT
            ? [
                `（rows は先頭 ${String(PERMISSION_GRANT_UNREADABLE_ROWS_LIMIT)} 件だけ。count が全件）`,
              ]
            : []),
          '読めない行は壊れた行であって、消された許可ではない。この一覧には載っていない（許可としても使われない）。' +
            '消す口は人間の手に属する。',
        ];
  const stateOf = (grant: PermissionGrant): string =>
    grant.revokedAt === undefined ? '有効' : '取り消し済み';
  if (id !== undefined) {
    const grant = grants.find((row) => row.id === id);
    if (grant === undefined) {
      return [
        `id ${id} の許可の記録は読めない（無いか、読めない行である）。`,
        ...unreadableLines,
      ].join('\n');
    }
    const body = [
      `- ${grant.id} ${stateOf(grant)}`,
      `  承認: ${grant.grantedAt}` +
        (grant.revokedAt === undefined ? '' : ` / 取り消し: ${grant.revokedAt}`) +
        (grant.lastUsedAt === undefined ? '' : ` / 最後に使った: ${grant.lastUsedAt}`),
      `  規則: ${grant.rule}`,
      `  承認の元の要求: ${grant.approvalId} / 経路: ${grant.route.principalKind} ${grant.route.accountId}`,
      `  回答（原文）: ${grant.answer}`,
      `  allows: ${grant.allows.length === 0 ? '（なし）' : grant.allows.join(' | ')}`,
      `  denies: ${grant.denies.length === 0 ? '（なし）' : grant.denies.join(' | ')}`,
    ].join('\n');
    const part = page(body, offset, PERMISSION_GRANT_PAGE);
    const tail = part.more
      ? `\n\n…（ここで切れている。続きは permission_grant_list id=${grant.id} offset=${String(part.to)}）`
      : '';
    return `${describePage(part)}\n${part.body}${tail}`;
  }
  if (grants.length === 0) {
    return [
      ...(unreadable === undefined
        ? ['（許可の記録は無い）']
        : ['読めた許可の記録は無い。**「許可が無い」とは言えない**——読めない行が在る。']),
      ...unreadableLines,
    ].join('\n');
  }
  const view = grants.slice(from);
  if (from > 0 && view.length === 0) {
    return `（from=${String(from)} より後ろの許可の記録は無い。全 ${String(grants.length)} 件）`;
  }
  const items = view.map((grant) => {
    const updatedAt = [grant.grantedAt, grant.revokedAt, grant.lastUsedAt]
      .filter((value) => value !== undefined)
      .reduce((latest, value) => (compareIsoInstant(value, latest) > 0 ? value : latest));
    return renderListingEntry({
      id: grant.id,
      title: stateOf(grant),
      summary: excerptLine(grant.rule, PERMISSION_GRANT_EXCERPT),
      createdAt: grant.grantedAt,
      updatedAt,
      extra: [
        grant.revokedAt === undefined ? null : `  取り消し ${grant.revokedAt}`,
        grant.lastUsedAt === undefined ? null : `  最後に使った ${grant.lastUsedAt}`,
        `  回答（原文）: ${excerptLine(grant.answer, PERMISSION_GRANT_EXCERPT)}`,
        `  allows: ${excerptLine(grant.allows.join(' | ') || '（なし）', PERMISSION_GRANT_EXCERPT)}`,
        `  denies: ${excerptLine(grant.denies.join(' | ') || '（なし）', PERMISSION_GRANT_EXCERPT)}`,
      ],
    });
  });
  return [
    ...unreadableLines,
    renderListing(items, {
      budget: PERMISSION_GRANT_LIST_BUDGET,
      omitted: ({ rest, shown }) =>
        `…ほか ${String(rest)} 件は省略（許可の記録は ${String(grants.length)} 件あり、grantedAt の昇順に ${String(shown)} 件だけ出した）。` +
        `続きは permission_grant_list from=${String(from + shown)} で取れる。`,
    }),
    '（作成 = 承認した時刻 / 更新 = 承認・取り消し・最後に使った時刻のうち最新。本文は抜粋。全文は permission_grant_list id=<id> で取れる）',
  ].join('\n');
}
