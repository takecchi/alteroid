import { describe, expect, it } from 'vitest';

import { renderManagerList } from './chat.js';

type ManagerListItem = Parameters<typeof renderManagerList>[0][number];

function manager(over: Partial<ManagerListItem> = {}): ManagerListItem {
  return {
    managerId: 'mgr-1',
    status: 'running',
    live: true,
    cwd: '/workspace/alteroid',
    request: '一覧に拒否件数を出す',
    startedAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:05:00.000Z',
    waiting: [],
    ...over,
  };
}

describe('renderManagerList', () => {
  it('確認へ上がらず止められた件数を、道具ごとに出す', () => {
    const text = renderManagerList([manager({ denials: [{ tool: 'Bash', count: 3 }] })]);

    expect(text).toContain('確認へ上がらず止められた道具');
    expect(text).toContain('Bash 3件');
    // 数えているのは拒否であって、それで止まったかは見ていない。断定しない。
    expect(text).toContain('可能性があります');
  });

  it('拒否があっても [running] の札を置き換えない（状態に添えるだけ）', () => {
    const text = renderManagerList([
      manager({ status: 'running', denials: [{ tool: 'Bash', count: 1 }] }),
    ]);

    expect(text).toContain('[running]');
    expect(text).toContain('確認へ上がらず止められた道具');
  });

  it('拒否の行は状態の下に来る（拾い読みで状態と結びつく位置）', () => {
    const text = renderManagerList([
      manager({
        denials: [{ tool: 'Bash', count: 1 }],
        waiting: [{ requestId: 'req-1', summary: 'これを消してよいか' }],
      }),
    ]);

    const header = text.indexOf('[running]');
    const denial = text.indexOf('確認へ上がらず止められた道具');
    const waiting = text.indexOf('返事待ち');
    expect(header).toBeLessThan(denial);
    expect(denial).toBeLessThan(waiting);
  });

  it('拒否がゼロなら何も足さない（0 件だったとは言わない）', () => {
    const withoutKey = renderManagerList([manager()]);
    const withEmpty = renderManagerList([manager({ denials: [] })]);

    for (const text of [withoutKey, withEmpty]) {
      expect(text).not.toContain('確認へ上がらず止められた');
      expect(text).not.toContain('⚠');
      expect(text).toContain('[running]');
    }
  });

  it('多いときは新しい側から3種だけ出し、切った分は種類数と総件数で言う', () => {
    const text = renderManagerList([
      manager({
        denials: [
          { tool: 'Oldest', count: 1 },
          { tool: 'Second', count: 2 },
          { tool: 'Third', count: 4 },
          { tool: 'Fourth', count: 8 },
          { tool: 'Newest', count: 16 },
        ],
      }),
    ]);

    // デーモンは古い順で返す。読む側が知りたいのはいま何で止まっているか。
    expect(text).toContain('Newest 16件');
    expect(text).toContain('Fourth 8件');
    expect(text).toContain('Third 4件');
    expect(text).not.toContain('Oldest');
    expect(text).not.toContain('Second 2件');
    // 黙って落とさない。落とした分は種類数と、全体の件数で言う。
    expect(text).toContain('ほか 2 種');
    expect(text).toContain('全 31 件');
  });

  it('マネージャーごとに数え、他の行の拒否を混ぜない', () => {
    const text = renderManagerList([
      manager({ managerId: 'mgr-denied', denials: [{ tool: 'Bash', count: 2 }] }),
      manager({ managerId: 'mgr-clean' }),
    ]);

    const lines = text.split('\n');
    const denied = lines.findIndex((line) => line.includes('確認へ上がらず止められた'));
    const clean = lines.findIndex((line) => line.includes('mgr-clean'));
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(denied).toBeLessThan(clean);
    expect(lines.filter((line) => line.includes('確認へ上がらず止められた'))).toHaveLength(1);
  });
});
