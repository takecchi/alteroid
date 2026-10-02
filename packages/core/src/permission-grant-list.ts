import { compareIsoInstant } from './iso-instant.js';
import { describePage, excerptLine, page, renderListing, renderListingEntry } from './excerpt.js';
import { toRowsUnreadable } from './schema.js';
import type { PermissionGrant } from './schema.js';
import type { PermissionGrantStore, Stores } from './store.js';

/**
 * クローンの道具 `permission_grant_list`（読むだけ）の本体。
 *
 * **ここは `tools.ts` ではなくこのファイルに置いている理由。** `tools.test.ts` の歯
 * （issue #863 C 節）は「`tools.ts` のどのハンドラも `permissionGrants` に触れない」を
 * 字面で固定している——クローンが自分に許可を書けないことの歯である。**読むだけの道具を
 * 足すために、その歯を緩めない。** 代わりに、この道具が持つストアの口を型で
 * `list` / `listUnreadable` の2つに絞り（{@link PermissionGrantReader}）、このファイルが
 * 書き手の口（`put` / `revoke` / `markUsed` / `removeUnreadable`）に触れないことを
 * 別の歯（`permission-grant-list.test.ts`）で固定する。
 *
 * **取り消し・読めない行を消す口は人間の手に限る**（#2522）。足さないこと。
 */
export type PermissionGrantReader = Pick<PermissionGrantStore, 'list' | 'listUnreadable'>;

/**
 * 許可の記録の一覧の予算（`TOKEN_LIST_BUDGET` を使い回さない。値が同じでも由来が
 * 違う）。**許可の本文（`rule` / `answer` / `allows` / `denies`）は人間の回答や Bash の
 * コマンド文字列そのもので、長さの上限が無い**。件数も人間が「許可します」と答えた
 * 回数で増える。
 */
const PERMISSION_GRANT_LIST_BUDGET = 6_000;
/** 一覧で、許可の本文（規則・回答・allows / denies）1つあたりを切る長さ。全文は `id` で取る。 */
const PERMISSION_GRANT_EXCERPT = 160;
/** 詳細（`id` 指定）の1頁の文字数。 */
const PERMISSION_GRANT_PAGE = 6_000;
/** `rowsUnreadable.rows` に出す id の上限（本文は載らないが、件数で溢れないように）。 */
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
  // **読めない行は、1件でも在るときだけ `rowsUnreadable` に載せる**（HTTP の
  // `GET /permission-grants` と同じ形。0件なら鍵ごと無い）。読めない行しか無いと
  // `grants` は空で「許可が無い」に見える。本文は載らない（id と不正な欄名だけ）。
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
  // --- 全文モード（1件だけ） ---
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
  // --- 一覧モード ---
  if (grants.length === 0) {
    return [
      ...(unreadable === undefined
        ? ['（許可の記録は無い）']
        : ['読めた許可の記録は無い。**「許可が無い」とは言えない**——読めない行が在る。']),
      ...unreadableLines,
    ].join('\n');
  }
  // **並びは `grantedAt` 昇順**（`PermissionGrantStore.list()` の契約）。
  const view = grants.slice(from);
  if (from > 0 && view.length === 0) {
    return `（from=${String(from)} より後ろの許可の記録は無い。全 ${String(grants.length)} 件）`;
  }
  const items = view.map((grant) => {
    // 更新 = 最後に変わった時刻（承認・取り消し・最後に使った時刻のうち最新）。
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
