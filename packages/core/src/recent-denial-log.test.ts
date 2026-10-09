import { describe, expect, it } from 'vitest';

import { RecentDenialLog } from './denial-shape.js';

describe('RecentDenialLog（issue #1802）', () => {
  const FAKE_SECRET = 'ghp_FAKE1234FAKE5678FAKE9012';

  it('拒否を控え、先頭の語は安全な形のときだけ持ち、コマンドの値は持たない', () => {
    const log = new RecentDenialLog(32);
    log.remember('tu-1', '2026-09-27T10:00:00.000Z', 'Bash', {
      input: { command: `gh auth login --with-token ${FAKE_SECRET}` },
      reasonType: '[CI Bypass]',
      reason: 'Blocked by classifier',
      message: 'denied',
    });
    expect(log.list()).toEqual([
      {
        at: '2026-09-27T10:00:00.000Z',
        tool: 'Bash',
        headWord: 'gh',
        reasonType: '[CI Bypass]',
        reason: 'Blocked by classifier',
        message: 'denied',
      },
    ]);
    expect(JSON.stringify(log.list())).not.toContain(FAKE_SECRET);
  });

  it('先頭の語が鍵らしい形なら、先頭の語も持たない', () => {
    const log = new RecentDenialLog(32);
    log.remember('tu-1', '2026-09-27T10:00:00.000Z', 'Bash', {
      input: { command: `${FAKE_SECRET} --flag` },
    });
    expect(log.list()[0]?.headWord).toBeUndefined();
    expect(JSON.stringify(log.list())).not.toContain(FAKE_SECRET);
  });

  it('上限を越えたら、古いものから落ちる', () => {
    const log = new RecentDenialLog(2);
    for (const n of [1, 2, 3]) {
      log.remember(`tu-${n}`, `2026-09-27T10:00:0${n}.000Z`, 'Bash', { reason: `r${n}` });
    }
    expect(log.list().map((it) => it.reason)).toEqual(['r2', 'r3']);
  });

  it('入力なしで控えた1件に、後から届いた入力で先頭の語を埋める（既に在れば触らない）', () => {
    const log = new RecentDenialLog(32);
    log.remember('tu-1', '2026-09-27T10:00:00.000Z', 'Bash', { reason: 'r' });
    expect(log.list()[0]?.headWord).toBeUndefined();
    log.fillHeadWord('tu-1', { command: 'gh release edit v1' });
    expect(log.list()[0]?.headWord).toBe('gh');
    log.fillHeadWord('tu-1', { command: 'curl https://example.test' });
    expect(log.list()[0]?.headWord).toBe('gh');
    log.fillHeadWord('tu-none', { command: 'gh x' });
    expect(log.list()).toHaveLength(1);
  });
});
