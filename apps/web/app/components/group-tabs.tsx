import { NavLink } from 'react-router';

import { SectionTabs } from '@alteroid/ui';

import {
  JOURNAL_TABS,
  MEMORY_TABS,
  SCHEDULE_TABS,
  SETTINGS_TABS,
  WORK_TABS,
  type NavTab,
} from '~/lib/nav';

/**
 * サイドバーの1行へ畳んだ「まとまり」の中を行き来するタブの帯。各ページの
 * `<Page tabs={…}>` へ渡す。タブの定義は `~/lib/nav`（サイドバーの選択中の判定と同じ配列）。
 *
 * 現在地は `NavLink`（前方一致）で決める——`/memory/:slug` の詳細でも「記憶」が選ばれる。
 */
export function GroupTabs({ label, tabs }: { label: string; tabs: readonly NavTab[] }) {
  return (
    <SectionTabs
      label={label}
      tabs={tabs}
      renderLink={(tab, slot) => (
        <NavLink to={tab.to} className={({ isActive }) => slot.className(isActive)}>
          {slot.children}
        </NavLink>
      )}
    />
  );
}

/** 仕事（未了の仕事・作業の進捗）。 */
export const WorkTabs = () => <GroupTabs label="仕事のページ" tabs={WORK_TABS} />;
/** 日誌（日誌・握り潰しの跡・アーカイブ）。 */
export const JournalTabs = () => <GroupTabs label="日誌のページ" tabs={JOURNAL_TABS} />;
/** 記憶とやり方。 */
export const MemoryTabs = () => <GroupTabs label="記憶とやり方のページ" tabs={MEMORY_TABS} />;
/** 予定と受信箱。 */
export const ScheduleTabs = () => <GroupTabs label="予定と受信箱のページ" tabs={SCHEDULE_TABS} />;
/** 設定（接続・利用状況・認証・実行環境）。 */
export const SettingsTabs = () => <GroupTabs label="設定のページ" tabs={SETTINGS_TABS} />;
