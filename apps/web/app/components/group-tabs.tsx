import { NavLink } from 'react-router';

import { SectionTabs } from '@alteroid/ui';

import {
  APPROVALS_TABS,
  JOURNAL_TABS,
  MEMORY_TABS,
  SCHEDULE_TABS,
  SETTINGS_TABS,
  WORK_TABS,
  type NavTab,
} from '~/lib/nav';

export function GroupTabs({ label, tabs }: { label: string; tabs: readonly NavTab[] }) {
  return (
    <SectionTabs
      label={label}
      tabs={tabs}
      renderLink={(tab, slot) => (
        <NavLink
          to={tab.to}
          end={'end' in tab ? tab.end === true : false}
          className={({ isActive }) => slot.className(isActive)}
        >
          {slot.children}
        </NavLink>
      )}
    />
  );
}

export const ApprovalsTabs = () => <GroupTabs label="承認のページ" tabs={APPROVALS_TABS} />;
export const WorkTabs = () => <GroupTabs label="仕事のページ" tabs={WORK_TABS} />;
export const JournalTabs = () => <GroupTabs label="日誌のページ" tabs={JOURNAL_TABS} />;
export const MemoryTabs = () => <GroupTabs label="記憶とやり方のページ" tabs={MEMORY_TABS} />;
export const ScheduleTabs = () => <GroupTabs label="予定と受信箱のページ" tabs={SCHEDULE_TABS} />;
export const SettingsTabs = () => <GroupTabs label="設定のページ" tabs={SETTINGS_TABS} />;
