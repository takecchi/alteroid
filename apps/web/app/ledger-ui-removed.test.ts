import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NAV_ITEMS, WORK_TABS } from '~/lib/nav';

const appPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// 台帳の撤去の段3: 台帳の画面（`/commitments`）・入口・API の呼び出しは無い。
describe('台帳の画面は無い', () => {
  it('経路にも、ナビにも、作業のタブにも /commitments が無い', () => {
    expect(readFileSync(appPath('./routes.ts'), 'utf8')).not.toContain('commitments');
    expect(NAV_ITEMS.flatMap((item) => [item.to, ...item.paths])).not.toContain('/commitments');
    expect(WORK_TABS.map((tab) => tab.to)).toEqual(['/tasks', '/progress']);
  });

  it('画面のファイルが無い', () => {
    for (const file of ['commitments.tsx', 'commitments-body.tsx', 'commitments-badges.tsx']) {
      expect(existsSync(appPath(`./routes/${file}`)), file).toBe(false);
    }
  });

  it('ナビの区分は「作業」で、待ち行列とマネージャーが並ぶ', () => {
    const work = NAV_ITEMS.filter((item) => item.section === '作業');
    expect(work.map((item) => `${item.to}:${item.label}`)).toEqual([
      '/tasks:待ち行列',
      '/managers:マネージャー',
    ]);
    expect(NAV_ITEMS.some((item) => item.section === '仕事')).toBe(false);
  });
});
