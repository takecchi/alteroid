import {
  Activity,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';

import { Badge } from '../common';

import type { AppSidebarItem } from './app-sidebar';

/**
 * 見本帳だけが使う、整理後の行き先の並び（提案）。stories のファイルから見本以外を
 * export しないためにここへ置く。
 *
 * **機能は1つも消していない。** 22 あった行き先を、よく使う3つ＋まとまり＋設定へ
 * 畳んでいる。畳んだ先（「仕事」の中のタブ・「設定」の中の一覧）は各ページの側が持つ。
 */
export const PROPOSED_NAV_ITEMS: AppSidebarItem[] = [
  { to: '/', label: 'ホーム', icon: LayoutDashboard },
  { to: '/chat', label: '会話', icon: MessageSquare },
  { to: '/approvals', label: '承認待ち', icon: BellRing, badge: <Badge tone="warn">2</Badge> },
  // 未了の仕事・作業の進捗・評定の内訳（同じ台帳の別の切り口）を1ページのタブへ
  { to: '/commitments', label: '仕事', icon: ListChecks, section: '仕事' },
  { to: '/managers', label: 'マネージャー', icon: Users, section: '仕事' },
  // 握り潰しの跡・アーカイブは日誌の中のタブへ
  { to: '/reports', label: '日報', icon: BookText, section: '記録' },
  { to: '/journal', label: '日誌', icon: Activity, section: '記録' },
  { to: '/memory', label: '記憶とやり方', icon: Brain, section: 'クローンの中身' },
  { to: '/schedule', label: '予定と受信箱', icon: CalendarClock, section: 'クローンの中身' },
  // 利用状況・認証トークン・アクセス許可・許可（Bash）・環境変数・実行環境プロファイル・
  // MCP 連携を「設定」の中の一覧へ
  { to: '/settings', label: '設定', icon: Settings, section: '' },
];
