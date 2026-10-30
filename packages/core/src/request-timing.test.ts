import { describe, expect, it } from 'vitest';

import { RequestTiming } from './request-timing.js';

describe('RequestTiming: SQL の頭', () => {
  it('長い SQL は120字で「…」を付けて切る', () => {
    const timing = new RequestTiming(() => 0);
    timing.queryStarted(`select ${'x'.repeat(200)}`)();
    expect(timing.db.slowestSql).toBe(`${`select ${'x'.repeat(200)}`.slice(0, 120)}…`);
  });

  it('切り口に絵文字がかかっても、孤立したサロゲートが残らない（#5973）', () => {
    const timing = new RequestTiming(() => 0);
    timing.queryStarted(`${'x'.repeat(119)}😀${'x'.repeat(50)}`)();
    expect(timing.db.slowestSql).toBe(`${'x'.repeat(119)}…`);
    expect(timing.db.slowestSql).not.toMatch(/\p{Surrogate}/u);
  });
});
