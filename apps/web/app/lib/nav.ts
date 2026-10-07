// 行き先をサイドバーとタブの帯で別々に持たない: ページを1つ足したとき片方だけ増えて、サイドバーでは選ばれないページができるため

export interface NavTab {
  to: string;
  label: string;
  // 前方一致にしない: 別のタブの経路が配下に入るとき（/approvals と /approvals/answered）、2つのタブが同時に選ばれるため
  end?: boolean;
}

export const APPROVALS_TABS: readonly NavTab[] = [
  { to: '/approvals', label: '未回答', end: true },
  { to: '/approvals/answered', label: '回答済み' },
];

export const WORK_TABS: readonly NavTab[] = [
  { to: '/commitments', label: '未了の仕事' },
  { to: '/progress', label: '作業の進捗' },
];

export const JOURNAL_TABS: readonly NavTab[] = [
  { to: '/journal', label: '日誌' },
  { to: '/dropped', label: '記録の失敗' },
  { to: '/archive', label: 'アーカイブ' },
];

export const MEMORY_TABS: readonly NavTab[] = [
  { to: '/memory', label: '記憶' },
  { to: '/practices', label: 'やり方' },
];

export const SCHEDULE_TABS: readonly NavTab[] = [
  { to: '/schedule', label: '予定' },
  { to: '/inbox', label: '受信箱' },
];

export const SETTINGS_TABS: readonly NavTab[] = [
  { to: '/settings', label: '接続' },
  { to: '/usage', label: '利用状況' },
  { to: '/tokens', label: '認証トークン' },
  { to: '/access', label: 'アクセス許可' },
  { to: '/permissions', label: '許可（Bash）' },
  { to: '/env-vars', label: '環境変数' },
  { to: '/profile', label: '実行環境プロファイル' },
  { to: '/mcp-servers', label: 'MCP 連携' },
  { to: '/integrations', label: '連携' },
];

function prefixesOf(...tabs: (readonly NavTab[])[]): readonly string[] {
  return tabs.flatMap((group) => group.map((tab) => tab.to));
}

export interface NavItemDef {
  to: string;
  label: string;
  paths: readonly string[];
  section?: string;
}

export const NAV_ITEMS: readonly NavItemDef[] = [
  { to: '/', label: 'ホーム', paths: ['/'] },
  { to: '/chat', label: '会話', paths: ['/chat'] },
  { to: '/approvals', label: '承認待ち', paths: prefixesOf(APPROVALS_TABS) },
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

export function isUnder(pathname: string, base: string): boolean {
  if (base === '/') return pathname === '/';
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isNavItemActive(item: NavItemDef, pathname: string): boolean {
  return item.paths.some((base) => isUnder(pathname, base));
}

export const SETTINGS_GROUP_LABEL = '設定';

export function settingsDocumentTitle(to: string): string {
  const tab = SETTINGS_TABS.find((t) => t.to === to);
  if (tab === undefined) throw new Error(`設定のタブに無い経路: ${to}`);
  return `${SETTINGS_GROUP_LABEL} — ${tab.label}`;
}
