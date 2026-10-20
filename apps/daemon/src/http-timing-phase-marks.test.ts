import type { CloneHost, JournalEntry } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

// ループの停止の見張りの印だけを差し替えて読む（見張りの本体は使わない）
const phases = vi.hoisted(() => [] as string[]);
vi.mock('@alteroid/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/core')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { createApp } = await import('./app.js');

const authed = { authorization: 'Bearer test-token' };

// 本番の loop-stall（2026-10-20）で「直前の印: runner-event-settled:tool_use・窓の中に印なし」の 1.0〜1.4 秒の停止が続いた。
// HTTP の口の処理には印が無く、口の中の同期の処理が止めても別の出来事の印に見えていた（#4485）
describe('HTTP の口の出入りと整形に印を打つ（#4485）', () => {
  it('⭐ 口に入った・整形の前後・口を出た、の順に経路の型で印を打ち、値の入ったパスは載せない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    const app = createApp({
      clone: {} as unknown as CloneHost,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: { subscribe: () => () => undefined },
    });
    const listed = await app.request('/journal', { headers: authed });
    const id = ((await listed.json()) as { entries: JournalEntry[] }).entries[0]?.id ?? '';

    phases.length = 0;
    const response = await app.request(`/journal/${id}`, { headers: authed });
    const text = await response.text();

    const ours = phases.filter((label) => label.startsWith('http'));
    expect(ours).toEqual([
      'http:GET /journal/:id',
      'http-json:GET /journal/:id',
      `http-json-done:${String(text.length)}ch`,
      'http-done:GET /journal/:id',
    ]);
    expect(phases.join('\n')).not.toContain(id);
  });
});
