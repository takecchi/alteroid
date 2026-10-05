import { compareIsoInstant } from './iso-instant.js';
import { describePage, page, renderListing, renderListingEntry } from './excerpt.js';
import { toRowsUnreadable } from './schema.js';
import type { AuthAccount, AuthStore } from './auth.js';
import type { Stores } from './store.js';

/**
 * クローンの道具 `account_list`（読むだけ）の本体。
 *
 * **ここは `tools.ts` ではなくこのファイルに置いている**（`permission-grant-list.ts` と
 * 同じ理由）。この道具が持つストアの口は型で `listAccounts` / `listUnreadableAccounts`
 * の2つに絞り（{@link AccountReader}）、書き手の口（付与・取り消し・owner の宣言・
 * `removeUnreadable` ほか）に触れないことは `account-list.test.ts` の歯が固定する。
 *
 * **⛔ 載せるのは id・許可の状態・時刻・`rowsUnreadable` だけである。**
 * `email` と `displayName`（個人の情報）、identity、アクセストークンは載せない
 * （オーナー代理＝クローンの決定）。人間の入口（`GET /access`）には email が並ぶが、
 * それをクローンへ見せるかは別の判断で、オーナーの判断待ちである（#2645）。
 * **人間が決めたら変わりうる**——ここで `email` を足す前に #2645 を読むこと。
 * 歯は `account-list.test.ts` と `tools.test.ts` が持つ。
 *
 * **許可の付与・取り消し・読めない行を消す口は人間の手に限る**（#2522）。足さないこと。
 */
export type AccountReader = Pick<AuthStore, 'listAccounts' | 'listUnreadableAccounts'>;

/** アカウントの一覧の予算（他の一覧の定数を使い回さない。値が同じでも由来が違う）。 */
const ACCOUNT_LIST_BUDGET = 6_000;
/** 詳細（`id` 指定）の1頁の文字数。 */
const ACCOUNT_PAGE = 6_000;
/** `rowsUnreadable.rows` に出す id の上限（件数で溢れないように）。 */
const ACCOUNT_UNREADABLE_ROWS_LIMIT = 20;

/** 個人の情報を含まない、アカウントの見え方。**ここに足す欄は #2645 の決定に従う。** */
function viewOf(account: AuthAccount) {
  return {
    id: account.id,
    granted: account.grantedAt !== null,
    grantedAt: account.grantedAt,
    grantedBy: account.grantedBy,
    // 注記: 宣言は資格の判断には使っていない（2026-10-05 オーナーの判断：ログインできる人＝持ち主。#2862）。表示だけ残してある。
    ownerDeclaredAt: account.ownerDeclaredAt,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
  };
}

export async function renderAccountList(
  stores: Pick<Stores, 'auth'>,
  args: { id?: string | undefined; from?: number | undefined; offset?: number | undefined },
): Promise<string> {
  const reader: AccountReader = {
    listAccounts: () => stores.auth.listAccounts(),
    listUnreadableAccounts: () => stores.auth.listUnreadableAccounts(),
  };
  const { id, from = 0, offset = 0 } = args;
  const accounts = (await reader.listAccounts()).map(viewOf);
  // **読めない行は、1件でも在るときだけ `rowsUnreadable` に載せる**（HTTP の
  // `GET /access` と同じ形。0件なら鍵ごと無い）。読めない行しか無いと `accounts` は
  // 空で「アカウントが無い」に見える。中身は載らない（id と不正な欄名だけ）。
  const unreadable = toRowsUnreadable(await reader.listUnreadableAccounts());
  const unreadableLines =
    unreadable === undefined
      ? []
      : [
          `rowsUnreadable: ${JSON.stringify({
            count: unreadable.count,
            rows: unreadable.rows.slice(0, ACCOUNT_UNREADABLE_ROWS_LIMIT),
          })}`,
          ...(unreadable.rows.length > ACCOUNT_UNREADABLE_ROWS_LIMIT
            ? [`（rows は先頭 ${String(ACCOUNT_UNREADABLE_ROWS_LIMIT)} 件だけ。count が全件）`]
            : []),
          '読めない行は壊れた行であって、消されたアカウントではない。この一覧には載っていない（認可にも使われない）。' +
            '消す口は人間の手に属する。',
        ];
  const stateOf = (account: ReturnType<typeof viewOf>): string =>
    account.granted ? '許可済み' : '未許可';
  const detailLines = (account: ReturnType<typeof viewOf>): string[] => [
    `  作成: ${account.createdAt} / 最後のログイン: ${account.lastLoginAt ?? '（なし）'}`,
    `  許可: ${account.grantedAt ?? '（未許可）'} / 許可した者: ${account.grantedBy ?? '（なし）'}`,
    `  持ち主の宣言: ${account.ownerDeclaredAt ?? '（なし）'}`,
  ];
  // --- 全文モード（1件だけ） ---
  if (id !== undefined) {
    const account = accounts.find((row) => row.id === id);
    if (account === undefined) {
      return [
        `id ${id} のアカウントは読めない（無いか、読めない行である）。`,
        ...unreadableLines,
      ].join('\n');
    }
    const body = [`- ${account.id} ${stateOf(account)}`, ...detailLines(account)].join('\n');
    const part = page(body, offset, ACCOUNT_PAGE);
    const tail = part.more
      ? `\n\n…（ここで切れている。続きは account_list id=${account.id} offset=${String(part.to)}）`
      : '';
    return `${describePage(part)}\n${part.body}${tail}`;
  }
  // --- 一覧モード ---
  if (accounts.length === 0) {
    return [
      ...(unreadable === undefined
        ? ['（アカウントは無い）']
        : ['読めたアカウントは無い。**「アカウントが無い」とは言えない**——読めない行が在る。']),
      ...unreadableLines,
    ].join('\n');
  }
  // **並びは `createdAt` 昇順**（`AuthStore.listAccounts()` の契約）。
  const view = accounts.slice(from);
  if (from > 0 && view.length === 0) {
    return `（from=${String(from)} より後ろのアカウントは無い。全 ${String(accounts.length)} 件）`;
  }
  const items = view.map((account) => {
    // 更新 = 最後に変わった時刻（作成・許可・持ち主の宣言・最後のログインのうち最新）。
    const updatedAt = [
      account.createdAt,
      account.grantedAt,
      account.ownerDeclaredAt,
      account.lastLoginAt,
    ]
      .filter((value) => value !== null)
      .reduce((latest, value) => (compareIsoInstant(value, latest) > 0 ? value : latest));
    return renderListingEntry({
      id: account.id,
      title: stateOf(account),
      summary: `最後のログイン: ${account.lastLoginAt ?? '（なし）'}`,
      createdAt: account.createdAt,
      updatedAt,
      extra: [
        `  許可: ${account.grantedAt ?? '（未許可）'} / 許可した者: ${account.grantedBy ?? '（なし）'}`,
        `  持ち主の宣言: ${account.ownerDeclaredAt ?? '（なし）'}`,
      ],
    });
  });
  return [
    ...unreadableLines,
    renderListing(items, {
      budget: ACCOUNT_LIST_BUDGET,
      omitted: ({ rest, shown }) =>
        `…ほか ${String(rest)} 件は省略（アカウントは ${String(accounts.length)} 件あり、createdAt の昇順に ${String(shown)} 件だけ出した）。` +
        `続きは account_list from=${String(from + shown)} で取れる。`,
    }),
    '（作成 = アカウントができた時刻 / 更新 = 作成・許可・持ち主の宣言・最後のログインのうち最新。email・表示名などの個人の情報は出さない。1件は account_list id=<id> で取れる）',
  ].join('\n');
}
