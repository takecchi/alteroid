import { describe, expect, it } from 'vitest';

import {
  addUnreadableCounts,
  describeAccountUsage,
  describeUnmeteredUsage,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeWebSearchRequests,
  findUnrecordedManagers,
  isDelegationActorId,
  isRealUsageDate,
  USAGE_DATE_PATTERN,
  ZERO_USAGE,
  type UnrecordedManagerCandidate,
} from './usage-format.js';
import { usageDateSchema, type UsageUnmeteredRow } from './usage.js';
import { toAccountUsage, type AccountUsageState } from './usage-snapshot.js';

describe('isRealUsageDate / usageDateSchema — 暦の上に実在する日だけを通す（Issue #2156）', () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ['2026-08-01', true],
    ['2026-02-28', true],
    ['2024-02-29', true],
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2025-02-29', false],
    ['2026-02-30', false],
    ['2026-04-31', false],
    ['2026-12-31', true],
    ['2026-13-01', false],
    ['2026-00-00', false],
    ['2026-01-00', false],
    ['0001-01-01', true],
    ['9999-12-31', true],
    ['', false],
    ['not-a-date', false],
    ['2026-8-1', false],
    ['2026/08/01', false],
    ['2026-08-01T00:00:00.000Z', false],
    [' 2026-08-01', false],
    ['2026-08-01\n', false],
    ['20260801', false],
  ];
  it.each(cases)('%s → %s', (value, expected) => {
    expect(isRealUsageDate(value)).toBe(expected);
    expect(usageDateSchema.safeParse(value).success).toBe(expected);
  });

  it('形の正規表現は、実在は見ない（実在の検査は isRealUsageDate が持つ）', () => {
    expect(USAGE_DATE_PATTERN.test('2026-02-30')).toBe(true);
    expect(USAGE_DATE_PATTERN.test('2026-8-1')).toBe(false);
  });
});

describe('describeUsageDateOrder（issue #2155 / #2211）', () => {
  it('to が from より前なら注記の文字列を返す', () => {
    expect(describeUsageDateOrder('2026-09-10', '2026-09-01')).toBe(
      'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない',
    );
  });

  it('to と from が同じ日なら null（境界は「より前」だけ）', () => {
    expect(describeUsageDateOrder('2026-09-01', '2026-09-01')).toBeNull();
  });

  it('to が from より後なら null', () => {
    expect(describeUsageDateOrder('2026-09-01', '2026-09-10')).toBeNull();
  });

  it('from / to のどちらかが無ければ null（比較しようがない）', () => {
    expect(describeUsageDateOrder(undefined, '2026-09-01')).toBeNull();
    expect(describeUsageDateOrder('2026-09-01', undefined)).toBeNull();
    expect(describeUsageDateOrder(undefined, undefined)).toBeNull();
  });
});

const AT = '2026-08-14T10:00:00.000Z';


function manager(over: Partial<UnrecordedManagerCandidate> & { managerId: string }) {
  return {
    status: 'running' as const,
    startedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

describe('findUnrecordedManagers', () => {
  it('台帳に行が在る managerId を除く', () => {
    const managers = [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })];
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-b']);
  });

  it('status では絞らない（running / done / lost のどれでも、行が無ければ数える）', () => {
    const managers = [
      manager({ managerId: 'mgr-running', status: 'running' }),
      manager({ managerId: 'mgr-done', status: 'done' }),
      manager({ managerId: 'mgr-lost', status: 'lost' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-done', 'mgr-lost', 'mgr-running']);
  });

  it('since より前に createdAt を持つ委譲は数えない', () => {
    const managers = [
      manager({ managerId: 'mgr-before-ledger', startedAt: '2026-07-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-after-ledger', startedAt: '2026-08-15T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-after-ledger']);
  });

  it('startedAt が since と同じ瞬間なら数える（境界は含む）', () => {
    const managers = [
      manager({ managerId: 'mgr-on-boundary', startedAt: '2026-08-01T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-on-boundary']);
  });

  it('since が null なら誰も除外しない', () => {
    const managers = [
      manager({ managerId: 'mgr-a', startedAt: '2020-01-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-b', startedAt: '2026-08-20T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-a', 'mgr-b']);
  });

  it('recordedManagerIds に載っていれば、startedAt が最近でも除外する', () => {
    const managers = [manager({ managerId: 'mgr-a', startedAt: '2026-08-25T00:00:00.000Z' })];
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result).toEqual([]);
  });

  it('startedAt の昇順で返す', () => {
    const managers = [
      manager({ managerId: 'mgr-later', startedAt: '2026-08-20T00:00:00.000Z' }),
      manager({ managerId: 'mgr-earlier', startedAt: '2026-08-10T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId)).toEqual(['mgr-earlier', 'mgr-later']);
  });
});

describe('describeUnrecordedManagers', () => {
  it('0件のときは「0件」と明示する（黙らない）', () => {
    const lines = describeUnrecordedManagers([]);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('0件');
  });

  it('1件以上のときは managerId と status と起こした時刻を出す', () => {
    const lines = describeUnrecordedManagers([
      { managerId: 'mgr-x', status: 'running', startedAt: '2026-08-25T13:20:00.000Z' },
    ]);
    const text = lines.join('\n');

    expect(text).toContain('mgr-x');
    expect(text).toContain('running');
    expect(text).toContain('2026-08-25T13:20:00.000Z');
    expect(text).toContain('1件');
  });
});

describe('describeWebSearchRequests', () => {
  it('0 のときは空文字を返す（1文字も増やさない）', () => {
    expect(describeWebSearchRequests({ ...ZERO_USAGE, webSearchRequests: 0 })).toBe('');
  });

  it('0 より大きいときは回数を出し、費用に含まれていることを添える', () => {
    const text = describeWebSearchRequests({ ...ZERO_USAGE, webSearchRequests: 3 });

    expect(text).toContain('Web検索');
    expect(text).toContain('3');
    expect(text).toContain('含む');
  });

  it('大きい回数も桁区切りで出す（他のトークン欄と同じ整形）', () => {
    const text = describeWebSearchRequests({ ...ZERO_USAGE, webSearchRequests: 12345 });

    expect(text).toContain('12,345');
  });
});

describe('describeAccountUsage の apiKeySource 行（#681 (2)）', () => {
  function okState(over: Partial<Extract<AccountUsageState, { state: 'ok' }>['usage']>) {
    return {
      state: 'ok' as const,
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        limitsAvailable: true,
        windows: [],
        ...over,
      },
    };
  }

  it('apiKeySource が取れているとき、値をそのまま出す', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('none');
  });

  it('apiKeySource: none を「API キーを使っていない」という意味で出す', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('API キーを使っていない');
  });

  it('判定には使っていない観測であることが文言から読める', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('判定には使っていない');
  });

  it('apiKeySource が取れなかったとき、埋めずに「（取れなかった）」と言う', () => {
    const text = describeAccountUsage(okState({})).join('\n');
    expect(text).toContain('（取れなかった）');
    expect(text).not.toContain('apiKeySource. none');
  });
});

describe('describeAccountUsage の unavailable 枝の apiKeySource 行', () => {
  function unavailableState(
    apiKeySource: Extract<AccountUsageState, { state: 'unavailable' }>['apiKeySource'],
  ): AccountUsageState {
    return {
      state: 'unavailable',
      at: '2026-08-14T10:00:00.000Z',
      reason: '枠が効かない理由を言い分けられない（テスト用フィクスチャ）',
      cause: 'undetermined',
      apiKeySource,
    };
  }

  it('apiKeySource: none のとき、none と「API キーを使っていない」の注記が出る', () => {
    const text = describeAccountUsage(unavailableState('none')).join('\n');
    expect(text).toContain('none');
    expect(text).toContain('API キーを使っていない');
  });

  it('apiKeySource: undefined のとき「取れなかった」が出て、none は一切出ない', () => {
    const text = describeAccountUsage(unavailableState(undefined)).join('\n');
    expect(text).toContain('（取れなかった）');
    expect(text).not.toContain('none');
  });

  it('apiKeySource: unrecognized のとき、unrecognized と出る（生の文字列は出ない）', () => {
    const text = describeAccountUsage(unavailableState('unrecognized')).join('\n');
    expect(text).toContain('unrecognized');
  });

  it('既存の「枠が返ってこない」の行は消えない', () => {
    const text = describeAccountUsage(unavailableState('none')).join('\n');
    expect(text).toContain('枠が返ってこない');
    expect(text).toContain('枠が効かない理由を言い分けられない（テスト用フィクスチャ）');
  });
});

describe('describeAccountUsage の tokenSourcePresence 行（#706）', () => {
  function okState(
    tokenSourcePresence: Extract<
      AccountUsageState,
      { state: 'ok' }
    >['usage']['tokenSourcePresence'],
  ): AccountUsageState {
    return {
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        limitsAvailable: true,
        windows: [],
        tokenSourcePresence,
      },
    };
  }

  it('present のとき、値が届いていると言い、内容は出さない', () => {
    const text = describeAccountUsage(okState('present')).join('\n');
    expect(text).toContain('値が届いている');
  });

  it('empty のとき、欄はあるが空だと言う（not_returned とは違う文言）', () => {
    const text = describeAccountUsage(okState('empty')).join('\n');
    expect(text).toContain('欄はあるが空');
  });

  it('not_returned のとき、取得できずと言う（積極的な事実。version skew ではない）', () => {
    const text = describeAccountUsage(okState('not_returned')).join('\n');
    expect(text).toContain('取得できず');
  });

  it('欄が無い（version skew）のとき、「取得できず」とは別の文言（この版は出さない）', () => {
    const text = describeAccountUsage(okState(undefined)).join('\n');
    expect(text).toContain('この版はこの情報を出さない');
    expect(text).not.toContain('取得できず');
  });

  it('4つの状態はどの2つを取っても異なる行になる', () => {
    const lines = (['present', 'empty', 'not_returned', undefined] as const).map((presence) =>
      describeAccountUsage(okState(presence)).join('\n'),
    );

    expect(new Set(lines).size).toBe(lines.length);
  });

  it('内容（生の tokenSource）はどの状態でも出力に一切現れない', () => {
    const marker = 'zz';
    for (const presence of ['present', 'empty', 'not_returned'] as const) {
      const text = describeAccountUsage(okState(presence)).join('\n');
      expect(text).not.toContain(marker);
    }
  });
});

describe('describeAccountUsage のプラン / 組織 行（plan / organization の欄が無い vs 空）', () => {
  function okState(over: Partial<Extract<AccountUsageState, { state: 'ok' }>['usage']>) {
    return {
      state: 'ok' as const,
      usage: {
        at: AT,
        limitsAvailable: true,
        windows: [],
        ...over,
      },
    };
  }

  it('plan: undefined のとき「（取れなかった）」が出る', () => {
    const text = describeAccountUsage(okState({})).join('\n');
    expect(text).toContain('（取れなかった）');
  });

  it("plan: '' のとき「（欄はあるが空）」が出る", () => {
    const text = describeAccountUsage(okState({ plan: '' })).join('\n');
    expect(text).toContain('（欄はあるが空）');
  });

  it("plan: 'zz' のとき、そのまま 'zz' が出る", () => {
    const text = describeAccountUsage(okState({ plan: 'zz' })).join('\n');
    expect(text).toContain('zz');
  });

  it('plan の3状態はどの2つを取っても異なる行になる', () => {
    const lines = ([undefined, '', 'zz'] as const).map((plan) =>
      describeAccountUsage(okState({ plan })).join('\n'),
    );
    expect(new Set(lines).size).toBe(3);
  });

  it("organization: '' のとき「（欄はあるが空）」が出る", () => {
    const text = describeAccountUsage(okState({ organization: '' })).join('\n');
    expect(text).toContain('（欄はあるが空）');
  });

  it("organization: 'zz' のとき、そのまま 'zz' が出る", () => {
    const text = describeAccountUsage(okState({ organization: 'zz' })).join('\n');
    expect(text).toContain('zz');
  });

  it('organization: undefined のとき「組織」の語が出ない（今日の見え方を変えない）', () => {
    const text = describeAccountUsage(okState({})).join('\n');
    expect(text).not.toContain('組織');
  });

  it('organization の3状態はどの2つを取っても異なる行になる', () => {
    const lines = ([undefined, '', 'zz'] as const).map((organization) =>
      describeAccountUsage(okState({ organization })).join('\n'),
    );
    expect(new Set(lines).size).toBe(3);
  });

  it("plan が空白のみ（'   '）でも「（欄はあるが空）」が出る（空白がそのまま出て空行に見えない）", () => {
    const text = describeAccountUsage(okState({ plan: '   ' })).join('\n');
    expect(text).toContain('（欄はあるが空）');
  });

  it('欄が無い回と欄が空の回で、観測が分かれていて、かつ表示も別の文字列になる（organization）', () => {
    const absent = toAccountUsage(AT, {}, {});
    const empty = toAccountUsage(AT, {}, { organization: '' });
    expect(absent.organization).toBeUndefined();
    expect(empty.organization).toBe('');
    const rendered = [absent, empty].map((usage) =>
      describeAccountUsage({ state: 'ok', usage }).join('\n'),
    );
    expect(new Set(rendered).size).toBe(2);
  });

  it('欄が無い回と欄が空の回で、観測が分かれていて、かつ表示も別の文字列になる（plan）', () => {
    const absent = toAccountUsage(AT, {}, {});
    const empty = toAccountUsage(AT, { subscription_type: '' }, {});
    expect(absent.plan).toBeUndefined();
    expect(empty.plan).toBe('');
    const rendered = [absent, empty].map((usage) =>
      describeAccountUsage({ state: 'ok', usage }).join('\n'),
    );
    expect(new Set(rendered).size).toBe(2);
  });
});

describe('addUnreadableCounts（欄ごとの「読めなかった数」を足す。Issue #2086）', () => {
  it('両方 undefined なら undefined（値を作らない）', () => {
    expect(addUnreadableCounts(undefined, undefined)).toBeUndefined();
  });

  it('片方が undefined でも、もう片方をそのまま返す（0 として足すのではなく）', () => {
    expect(addUnreadableCounts(undefined, { inputTokens: 2 })).toEqual({ inputTokens: 2 });
    expect(addUnreadableCounts({ inputTokens: 2 }, undefined)).toEqual({ inputTokens: 2 });
  });

  it('欄ごとに足す。片方にしか無い欄はその値のまま残る', () => {
    expect(
      addUnreadableCounts({ inputTokens: 2, costUsd: 1 }, { inputTokens: 3, webSearchRequests: 5 }),
    ).toEqual({ inputTokens: 5, costUsd: 1, webSearchRequests: 5 });
  });

  it('足した結果が全欄0になるなら undefined を返す（0の欄を作らない）', () => {
    expect(addUnreadableCounts({}, {})).toBeUndefined();
  });
});

describe('isDelegationActorId（issue #2269）', () => {
  it('mgr- で始まらない委譲の id も委譲と読む', () => {
    expect(isDelegationActorId('mgr-1')).toBe(true);
    expect(isDelegationActorId('job-7f3a')).toBe(true);
  });

  it('クローンの id と空文字は委譲と読まない（空文字は、基準値の managerId を入れる前の値）', () => {
    expect(isDelegationActorId('clone')).toBe(false);
    expect(isDelegationActorId('')).toBe(false);
  });
});

describe('describeUnmeteredUsage（消費を報告しない provider のターン。Issue #486 M7）', () => {
  const row = (over: Partial<UsageUnmeteredRow>): UsageUnmeteredRow => ({
    date: '2026-10-01',
    managerId: 'clone',
    layer: 'clone',
    site: 'session',
    provider: 'codex',
    turns: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  });

  it('欄が無い・0件なら何も言わない（Claude だけの器の出力を変えない）', () => {
    expect(describeUnmeteredUsage(undefined)).toEqual([]);
    expect(describeUnmeteredUsage([])).toEqual([]);
  });

  it('provider・層ごとにターン数を言い、0 ではなく取れなかった・合計に含まれないと言う', () => {
    const lines = describeUnmeteredUsage([
      row({ turns: 2 }),
      row({ date: '2026-10-02', turns: 3 }),
      row({ layer: 'manager', managerId: 'mgr-1', turns: 4 }),
    ]);
    expect(lines).toEqual([
      '⚠ 消費を報告しない provider のターンがある（0 ではなく取れなかった。合計に含まれない: ' +
        'codex・clone層 5ターン / codex・manager層 4ターン）。',
    ]);
  });
});

describe('describeAccountUsage — 保持している ok の後に取り直しが失敗している（#2752）', () => {
  const usage = {
    at: '2026-08-14T10:00:00.000Z',
    limitsAvailable: true,
    windows: [],
  };

  it('失敗していること（いつから・理由）と、値が最後に取れたときのものであることを出す', () => {
    const text = describeAccountUsage({
      state: 'ok',
      usage,
      refreshFailure: {
        since: '2026-08-14T10:05:00.000Z',
        at: '2026-08-14T10:20:00.000Z',
        reason: '通信断',
      },
    }).join('\n');
    expect(text).toContain('最後に取れたときのもの');
    expect(text).toContain('2026-08-14T10:05:00.000Z');
    expect(text).toContain('通信断');
  });

  it('失敗していない ok には、その行が出ない（今日の見え方を変えない）', () => {
    const text = describeAccountUsage({ state: 'ok', usage }).join('\n');
    expect(text).not.toContain('最後に取れたときのもの');
  });
});
