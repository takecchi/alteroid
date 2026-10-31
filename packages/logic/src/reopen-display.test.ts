import { describe, expect, it } from 'vitest';

import { describeReopenResult } from './reopen-display.js';

describe('describeReopenResult', () => {
  it('deferred', () => {
    expect(describeReopenResult({ outcome: 'deferred' })).toBe(
      'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
    );
  });

  it('now', () => {
    expect(describeReopenResult({ outcome: 'now' })).toBe(
      'いまはセッションが無かった。次の合図から新しいセッションで始まる。',
    );
  });

  it('unsupported は古い id もマネージャーも付けない', () => {
    expect(
      describeReopenResult({ outcome: 'unsupported', previousSessionId: 's', runningManagers: 2 }),
    ).toBe('このデーモンのクローンは、セッションを開き直す口を持っていない。');
  });

  it('古いセッション id と走っているマネージャーの行が付く（0本と null は付けない）', () => {
    expect(
      describeReopenResult({
        outcome: 'deferred',
        previousSessionId: 'sess-1',
        runningManagers: 2,
      }),
    ).toBe(
      [
        'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
        '古いセッション id: sess-1',
        '走っているマネージャーが 2 本いる。マネージャーは止めていない。その報告は新しいセッションへ届く。',
      ].join('\n'),
    );
    expect(
      describeReopenResult({ outcome: 'now', previousSessionId: null, runningManagers: 0 }),
    ).toBe('いまはセッションが無かった。次の合図から新しいセッションで始まる。');
    expect(describeReopenResult({ outcome: 'deferred' })).not.toContain('マネージャー');
  });
});
