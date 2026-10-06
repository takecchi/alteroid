import { describe, expect, it } from 'vitest';

import {
  APPROVALS_TABS,
  isNavItemActive,
  isUnder,
  JOURNAL_TABS,
  MEMORY_TABS,
  NAV_ITEMS,
  SCHEDULE_TABS,
  SETTINGS_TABS,
  WORK_TABS,
} from './nav';

describe('isUnder', () => {
  it('その経路そのもの・その配下は真。単語の途中は偽', () => {
    expect(isUnder('/managers', '/managers')).toBe(true);
    expect(isUnder('/managers/abc', '/managers')).toBe(true);
    expect(isUnder('/managersx', '/managers')).toBe(false);
    expect(isUnder('/chat', '/managers')).toBe(false);
  });

  it('ホーム（/）は完全一致だけ（全経路の親にしない）', () => {
    expect(isUnder('/', '/')).toBe(true);
    expect(isUnder('/chat', '/')).toBe(false);
  });
});

describe('NAV_ITEMS', () => {
  it('行き先は重複しない', () => {
    const tos = NAV_ITEMS.map((item) => item.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('まとまりの全タブは、ちょうど1つの行に属する（サイドバーで選ばれないページも、2行が同時に選ばれるページも作らない）', () => {
    for (const tab of [
      ...APPROVALS_TABS,
      ...WORK_TABS,
      ...JOURNAL_TABS,
      ...MEMORY_TABS,
      ...SCHEDULE_TABS,
      ...SETTINGS_TABS,
    ]) {
      const owners = NAV_ITEMS.filter((item) => isNavItemActive(item, tab.to));
      expect(owners, tab.to).toHaveLength(1);
    }
  });

  it('各行の `to` はその行自身の経路に属する（押した先で自分が選ばれる）', () => {
    for (const item of NAV_ITEMS) {
      expect(isNavItemActive(item, item.to), item.to).toBe(true);
    }
  });
});
