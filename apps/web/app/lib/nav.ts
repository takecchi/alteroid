/**
 * サイドバーの行き先と、まとまり（タブの帯）の定義。**行き先の持ち主はここ1か所**で、
 * サイドバー（`routes/shell.tsx`）の「いま居る画面」の判定と、各ページ先頭のタブの帯
 * （`components/group-tabs.tsx`）が同じ配列から作られる——別々に持つと、ページを1つ足した
 * ときに片方だけ増えて、「サイドバーでは選ばれないページ」ができる。
 *
 * **URL は1つも消していない。** サイドバーが1行へ畳んだ先のページは、そのまとまりの
 * タブから行く。
 */

export interface NavTab {
  to: string;
  label: string;
}

/** 仕事: 未了の仕事の台帳・その集計。 */
export const WORK_TABS: readonly NavTab[] = [
  { to: '/commitments', label: '未了の仕事' },
  { to: '/progress', label: '作業の進捗' },
];

/** 日誌: 日誌本体・記録の失敗・セッション生ログの退避。 */
export const JOURNAL_TABS: readonly NavTab[] = [
  { to: '/journal', label: '日誌' },
  { to: '/dropped', label: '記録の失敗' },
  { to: '/archive', label: 'アーカイブ' },
];

/** 記憶とやり方: クローンの判断の材料。 */
export const MEMORY_TABS: readonly NavTab[] = [
  { to: '/memory', label: '記憶' },
  { to: '/practices', label: 'やり方' },
];

/** 予定と受信箱: 自律の起点と、その受け皿。 */
export const SCHEDULE_TABS: readonly NavTab[] = [
  { to: '/schedule', label: 'スケジュール' },
  { to: '/inbox', label: '受信箱' },
];

/**
 * 設定: 接続先・利用状況・認証・実行環境。**8つあるのでサイドバーには出さず、設定の
 * ページ群のタブにする。**
 */
export const SETTINGS_TABS: readonly NavTab[] = [
  { to: '/settings', label: '接続' },
  { to: '/usage', label: '利用状況' },
  { to: '/tokens', label: '認証トークン' },
  { to: '/access', label: 'アクセス許可' },
  // アクセス許可の隣。あちらは「誰が alteroid を使えるか」、こちらは
  // 「その人が Bash で何を通せるか」（issue #863）——別の許可の軸である。
  { to: '/permissions', label: '許可（Bash）' },
  { to: '/env-vars', label: '環境変数' },
  // 環境変数の隣。どちらも「器を焼き直さずに実行環境を直す」口で、こちらはシェルスクリプト
  // 1本を丸ごと置く太い口である（issue #1122）。
  { to: '/profile', label: '実行環境プロファイル' },
  // プロファイルの隣。同じく「器を焼き直さずに実行環境を直す」口で、こちらは `.mcp.json` に
  // 当たる連携の登録である（#325 段4）。
  { to: '/mcp-servers', label: 'MCP 連携' },
];

/**
 * サイドバーの1行が「いま居る画面」になる経路の集合。1行 = 1つの経路か、タブの束。
 * 詳細の経路（`/managers/:id` など）は前方一致で含まれる。
 */
function prefixesOf(...tabs: (readonly NavTab[])[]): readonly string[] {
  return tabs.flatMap((group) => group.map((tab) => tab.to));
}

export interface NavItemDef {
  to: string;
  label: string;
  /** このうちどれかの配下に居れば、この行が選択中になる。 */
  paths: readonly string[];
  /** サイドバーの見出し（`AppSidebarItem.section`）。 */
  section?: string;
}

/**
 * サイドバーの並び。**見出しは「直前の行と違う値になったところ」で出る**
 * （`AppSidebarItem.section`）ので、並びの順がそのまま見出しの順になる。
 */
export const NAV_ITEMS: readonly NavItemDef[] = [
  { to: '/', label: 'ホーム', paths: ['/'] },
  { to: '/chat', label: '会話', paths: ['/chat'] },
  { to: '/approvals', label: '承認待ち', paths: ['/approvals'] },
  { to: '/commitments', label: '仕事', paths: prefixesOf(WORK_TABS), section: '仕事' },
  { to: '/managers', label: 'マネージャー', paths: ['/managers'], section: '仕事' },
  { to: '/reports', label: '日報', paths: ['/reports'], section: '記録' },
  { to: '/journal', label: '日誌', paths: prefixesOf(JOURNAL_TABS), section: '記録' },
  {
    to: '/memory',
    label: '記憶とやり方',
    paths: prefixesOf(MEMORY_TABS),
    section: 'クローンの中身',
  },
  {
    to: '/schedule',
    label: '予定と受信箱',
    paths: prefixesOf(SCHEDULE_TABS),
    section: 'クローンの中身',
  },
  { to: '/settings', label: '設定', paths: prefixesOf(SETTINGS_TABS), section: '' },
];

/** `pathname` が `base` そのもの、またはその配下か。`/` だけは完全一致（全経路の親にしない）。 */
export function isUnder(pathname: string, base: string): boolean {
  if (base === '/') return pathname === '/';
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** サイドバーの行 `item` が、いま `pathname` に居るときの選択中か。 */
export function isNavItemActive(item: NavItemDef, pathname: string): boolean {
  return item.paths.some((base) => isUnder(pathname, base));
}
