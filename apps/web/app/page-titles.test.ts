import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NAV_ITEMS, SCHEDULE_TABS, SETTINGS_TABS, settingsDocumentTitle } from '~/lib/nav';

const APP = resolve(__dirname);
const read = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

const routeFiles = [
  ...read('routes.ts').matchAll(/(?:route|index|layout)\([^)]*?'(routes\/[\w.-]+\.tsx)'/g),
].map((m) => m[1]!);
const FRAME = 'routes/shell.tsx';

describe('全 route が題名を持つ', () => {
  it('routes.ts から route を拾えている（拾えなければ下の確認が空振りする）', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(25);
    expect(routeFiles).toContain('routes/not-found.tsx');
  });

  for (const file of routeFiles.filter((f) => f !== FRAME)) {
    it(`${file}: Page か DocumentTitle か ChatPane（ChatHeader）を描く`, () => {
      const src = read(file);
      expect(/<Page\b|<DocumentTitle\b|<ChatPane\b/.test(src)).toBe(true);
    });

    it(`${file}: Page の title が部品なら documentTitle を渡している`, () => {
      const src = read(file);
      let from = 0;
      for (;;) {
        const start = src.indexOf('<Page', from);
        if (start === -1) break;
        from = start + 5;
        const rest = src.slice(start);
        const titleAt = rest.search(/\btitle=/);
        if (titleAt === -1) continue;
        if (rest[titleAt + 6] === '{') {
          expect(
            rest.slice(0, titleAt),
            `${file}: title が部品の <Page> に documentTitle が無い`,
          ).toContain('documentTitle=');
        }
      }
    });
  }

  it('root の meta は固定の題名を持たない', () => {
    const meta = read('root.tsx').match(/export function meta\(\) \{[\s\S]*?\n\}/)![0];
    expect(meta).not.toMatch(/\btitle:/);
  });

  it('404 の h1 は「ページが見つかりません」', () => {
    expect(read('routes/not-found.tsx')).toContain('title="ページが見つかりません"');
  });
});

describe('設定のまとまりの題名（#2844）', () => {
  it('タブの題名は「設定 — タブの名前」で、タブの名前は SETTINGS_TABS から引く', () => {
    expect(settingsDocumentTitle('/settings')).toBe('設定 — 接続');
    expect(settingsDocumentTitle('/usage')).toBe('設定 — 利用状況');
    expect(settingsDocumentTitle('/mcp-servers')).toBe('設定 — MCP 連携');
    for (const tab of SETTINGS_TABS) {
      expect(settingsDocumentTitle(tab.to)).toBe(`設定 — ${tab.label}`);
    }
  });

  for (const tab of SETTINGS_TABS) {
    it(`${tab.to} の画面は settingsDocumentTitle で題名を渡す`, () => {
      const src = read(`routes/${tab.to.slice(1)}.tsx`);
      expect(src).toContain(`documentTitle={settingsDocumentTitle('${tab.to}')}`);
    });
  }

  it('/settings の h1 は「設定」のまま（まとまりの名前）', () => {
    expect(read('routes/settings.tsx')).toContain('title="設定"');
  });
});

describe('予定のまとまりの名前（#2844）', () => {
  it('左ナビのまとまり・タブ・h1 が「予定」の語で揃う（スケジュールの語を使わない）', () => {
    expect(SCHEDULE_TABS[0]).toEqual({ to: '/schedule', label: '予定' });
    expect(NAV_ITEMS.find((i) => i.to === '/schedule')?.label).toBe('予定と受信箱');
    expect(read('routes/schedule.tsx')).toContain('title="予定"');
    expect(read('routes/schedule.tsx')).not.toContain('title="スケジュールと外部イベント"');
  });
});
