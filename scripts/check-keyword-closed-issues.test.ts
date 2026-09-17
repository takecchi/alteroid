import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLD_SECONDS,
  findKeywordClosedCandidates,
  formatReport,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-keyword-closed-issues-core.mjs';

/** `findKeywordClosedCandidates` が返す候補の形（core の doc コメントから）。 */
type Candidate = {
  issueNumber: number;
  closedAt: string;
  prNumber: number | null;
  mergedAt: string | null;
  secondsAfterMerge: number | null;
  matchedVia: 'commit-id' | 'timing';
  actor: string | null;
};

/**
 * `check-keyword-closed-issues` の歯（Issue #1128）。
 *
 * 本物の `gh` は叩かない —— 合成したマージ済み PR・closed イベントで判定だけを
 * 確かめる（`check-pr-green.test.ts` / `check-pr-closing-keywords.test.ts` と
 * 同じ理由）。
 *
 * **下の「実測を写した固定値」は本物の観測である。** `gh api
 * repos/takecchi/alteroid/issues/<N>/timeline` と `gh pr view <N> --json
 * mergedAt,mergeCommit` を実行して得た値をそのまま使う（観測 2026-09-17。
 * 生の出力は PR 本文に貼った）。
 */

describe('findKeywordClosedCandidates — Issue #1128 が挙げた既知の5件（+ #993 の2回目）', () => {
  // 実測（2026-09-17、`gh api repos/takecchi/alteroid/issues/<N>/timeline` と
  // `gh pr view <N> --json mergedAt,mergeCommit` を実行して検算した値）。
  const mergedPRs = [
    {
      number: 912,
      mergedAt: '2026-09-13T01:03:46Z',
      mergeCommitOid: '5acf817fe6d0a274dd4f750053619991add70960',
    },
    {
      number: 1095,
      mergedAt: '2026-09-16T12:11:28Z',
      mergeCommitOid: '5edc44c892704ed59be0ac4fb99568b3eedf75b3',
    },
    {
      number: 1107,
      mergedAt: '2026-09-16T16:46:17Z',
      mergeCommitOid: 'f942230870358b137499f7a52613cd0f4cdfb0a0',
    },
    {
      number: 868,
      mergedAt: '2026-09-12T02:12:10Z',
      mergeCommitOid: 'e24e363a90efb89ddaa711be048d2b9485210253',
    },
    {
      number: 915,
      mergedAt: '2026-09-12T20:41:02Z',
      mergeCommitOid: '1a2d8bbf9ab240a6a01a8697dd41d49d65560db0',
    },
    {
      number: 1112,
      mergedAt: '2026-09-16T19:32:08Z',
      mergeCommitOid: '8ff27bbdd270895bd5b7c26592a569fb9f28ea01',
    },
  ];

  const closeEvents = [
    // #910 → PR #912。マージ 01:03:46Z → closed 01:03:47Z（1秒後）。commit_id=null。
    // reopen されておらず、いまも CLOSED（#1128 本文の逐語）。
    { issueNumber: 910, closedAt: '2026-09-13T01:03:47Z', commitId: null, actor: 'takecchi' },
    // #993 の1回目 → PR #1095（段1のマージ）。12:11:28Z → 12:11:30Z（2秒後）。commit_id=null。
    { issueNumber: 993, closedAt: '2026-09-16T12:11:30Z', commitId: null, actor: 'takecchi' },
    // #993 の2回目 → PR #1107。16:46:17Z → 16:46:19Z（2秒後）。commit_id はこの PR の
    // マージコミットそのもの——commit-id 一致の実例。
    {
      issueNumber: 993,
      closedAt: '2026-09-16T16:46:19Z',
      commitId: 'f942230870358b137499f7a52613cd0f4cdfb0a0',
      actor: 'takecchi',
    },
    // #866 → PR #868。02:12:10Z → 02:12:11Z（1秒後）。commit_id=null。
    { issueNumber: 866, closedAt: '2026-09-12T02:12:11Z', commitId: null, actor: 'takecchi' },
    // #913 → PR #915。20:41:02Z → 20:41:03Z（1秒後）。commit_id=null。
    { issueNumber: 913, closedAt: '2026-09-12T20:41:03Z', commitId: null, actor: 'takecchi' },
    // #1041 → PR #1112。19:32:08Z → 19:32:10Z（2秒後）。commit_id=null。
    // Issue #1128 の表いわく「意図どおりの閉じ方」——それでもこの道具は区別せず拾う。
    { issueNumber: 1041, closedAt: '2026-09-16T19:32:10Z', commitId: null, actor: 'takecchi' },
  ];

  it('6件すべてが候補に出る（#993 は2回とも別々の候補として）', () => {
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    const issueNumbers = result.map((c) => c.issueNumber).sort((a, b) => a - b);
    expect(issueNumbers).toEqual([866, 910, 913, 993, 993, 1041]);
    expect(result).toHaveLength(6);
  });

  it('#910 は timing 一致で、PR #912・1秒後と分かる', () => {
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    const c = result.find((r) => r.issueNumber === 910)!;
    expect(c.matchedVia).toBe('timing');
    expect(c.prNumber).toBe(912);
    expect(c.secondsAfterMerge).toBe(1);
  });

  it('#993 の2回目は commit-id 一致で、PR #1107 と分かる（時間差も一致する）', () => {
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    const matches = result.filter((r) => r.issueNumber === 993);
    expect(matches).toHaveLength(2);
    const commitMatch = matches.find((m) => m.matchedVia === 'commit-id')!;
    expect(commitMatch.prNumber).toBe(1107);
    expect(commitMatch.secondsAfterMerge).toBe(2);
    const timingMatch = matches.find((m) => m.matchedVia === 'timing')!;
    expect(timingMatch.prNumber).toBe(1095);
    expect(timingMatch.secondsAfterMerge).toBe(2);
  });

  it('#1041（意図どおりの閉じ方とされる例）も、区別されずに同じ形で拾われる', () => {
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    const c = result.find((r) => r.issueNumber === 1041)!;
    expect(c.matchedVia).toBe('timing');
    expect(c.prNumber).toBe(1112);
    expect(c.secondsAfterMerge).toBe(2);
    // 「意図どおり」というラベルはどこにも無い —— candidate のキーを全部見ても
    // 意図か事故かを表すフィールドは存在しない。
    expect(Object.keys(c).sort()).toEqual(
      [
        'actor',
        'closedAt',
        'issueNumber',
        'matchedVia',
        'mergedAt',
        'prNumber',
        'secondsAfterMerge',
      ].sort(),
    );
  });
});

describe('findKeywordClosedCandidates — 偽陽性を作らない側（実測で確認した非該当）', () => {
  it('マージと無関係に閉じた Issue（実測: PR #367 → #204、21秒後）は候補に出ない', () => {
    // PR #367 の本文は `Fixes #254` / `Fixes #362` とだけ書き、#204 は「関連」として
    // 番号だけ挙げていた（閉じるキーワードの対象ではない）。#204 の timeline は
    // close の直前に commented → renamed が在り、人が手で閉じた形だった。
    const mergedPRs = [
      { number: 367, mergedAt: '2026-08-23T21:32:11Z', mergeCommitOid: 'e24e363a' },
    ];
    const closeEvents = [
      { issueNumber: 204, closedAt: '2026-08-23T21:32:32Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toEqual([]);
  });

  it('同じ実測の#234（35秒後）も候補に出ない', () => {
    const mergedPRs = [
      { number: 367, mergedAt: '2026-08-23T21:32:11Z', mergeCommitOid: 'e24e363a' },
    ];
    const closeEvents = [
      { issueNumber: 234, closedAt: '2026-08-23T21:32:46Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toEqual([]);
  });

  it('本文に言及すら無い実測（PR #1136 → #1087、51秒後の偶然）も候補に出ない', () => {
    const mergedPRs = [{ number: 1136, mergedAt: '2026-09-17T01:59:07Z', mergeCommitOid: 'aaa' }];
    const closeEvents = [
      { issueNumber: 1087, closedAt: '2026-09-17T01:59:58Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toEqual([]);
  });

  it('直前にマージが1件も無ければ候補に出ない', () => {
    const mergedPRs: never[] = [];
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T00:00:01Z', commitId: null, actor: 'takecchi' },
    ];
    expect(findKeywordClosedCandidates({ mergedPRs, closeEvents })).toEqual([]);
  });

  it('closedAt がマージより前（あり得ない順序）なら、そのマージは候補にしない', () => {
    const mergedPRs = [{ number: 1, mergedAt: '2026-09-17T00:00:10Z', mergeCommitOid: 'aaa' }];
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T00:00:00Z', commitId: null, actor: 'takecchi' },
    ];
    expect(findKeywordClosedCandidates({ mergedPRs, closeEvents })).toEqual([]);
  });

  it('数時間〜数日後に手で閉じた通常の Issue は候補に出ない（60分後の例）', () => {
    const mergedPRs = [{ number: 1, mergedAt: '2026-09-17T00:00:00Z', mergeCommitOid: 'aaa' }];
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T01:00:00Z', commitId: null, actor: 'takecchi' },
    ];
    expect(findKeywordClosedCandidates({ mergedPRs, closeEvents })).toEqual([]);
  });
});

describe('findKeywordClosedCandidates — commit_id がマージコミットの場合（タイミング非依存）', () => {
  it('時間差が閾値を大きく超えていても、commit_id が一致していれば拾う', () => {
    // commit_id 一致は状況証拠ではなく確定的な証拠なので、閾値の対象外
    // （core の doc: 「一致そのものが証拠である」）。
    const mergedPRs = [{ number: 5, mergedAt: '2026-09-17T00:00:00Z', mergeCommitOid: 'deadbeef' }];
    const closeEvents = [
      {
        issueNumber: 42,
        closedAt: '2026-09-17T00:05:00Z',
        commitId: 'deadbeef',
        actor: 'takecchi',
      },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      prNumber: 5,
      matchedVia: 'commit-id',
      secondsAfterMerge: 300,
    });
  });

  it('commit_id が既知のどの merged PR の mergeCommitOid とも一致しなければ、PR番号は不明のまま候補に残す（握り潰さない）', () => {
    const mergedPRs = [{ number: 5, mergedAt: '2026-09-17T00:00:00Z', mergeCommitOid: 'deadbeef' }];
    const closeEvents = [
      {
        issueNumber: 42,
        closedAt: '2026-09-17T00:05:00Z',
        commitId: 'unknown-sha',
        actor: 'takecchi',
      },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: null, matchedVia: 'commit-id' });
  });
});

describe('findKeywordClosedCandidates — 境界（閾値のちょうど上と下）', () => {
  const mergedPRs = [{ number: 1, mergedAt: '2026-09-17T00:00:00Z', mergeCommitOid: 'aaa' }];

  it('閾値ちょうど（既定10秒）は候補に含む', () => {
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T00:00:10Z', commitId: null, actor: null },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]!.secondsAfterMerge).toBe(10);
  });

  it('閾値+1秒は候補から外れる', () => {
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T00:00:11Z', commitId: null, actor: null },
    ];
    expect(findKeywordClosedCandidates({ mergedPRs, closeEvents })).toEqual([]);
  });

  it('カスタム閾値を渡せば境界が動く（thresholdSeconds=60 なら45秒後も拾う）', () => {
    const closeEvents = [
      { issueNumber: 1, closedAt: '2026-09-17T00:00:45Z', commitId: null, actor: null },
    ];
    const result = findKeywordClosedCandidates({
      mergedPRs,
      closeEvents,
      thresholdSeconds: 60,
    }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]!.secondsAfterMerge).toBe(45);
  });

  it('DEFAULT_THRESHOLD_SECONDS は実測の根拠（9秒の真陽性/21秒の偽陽性の間）と整合する10である', () => {
    expect(DEFAULT_THRESHOLD_SECONDS).toBe(10);
  });
});

describe('findKeywordClosedCandidates — 複数の merged PR から正しく最寄りを選ぶ', () => {
  it('直前の2本のうち、より近いほうを選ぶ', () => {
    const mergedPRs = [
      { number: 1, mergedAt: '2026-09-17T00:00:00Z', mergeCommitOid: 'aaa' },
      { number: 2, mergedAt: '2026-09-17T00:00:08Z', mergeCommitOid: 'bbb' },
    ];
    const closeEvents = [
      { issueNumber: 9, closedAt: '2026-09-17T00:00:09Z', commitId: null, actor: null },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: 2, secondsAfterMerge: 1 });
  });
});

describe('formatReport', () => {
  it('0件なら「候補は0件」と名乗る', () => {
    const text = formatReport([]);
    expect(text).toContain('候補は0件');
  });

  it('候補が在れば件数と、各候補の出所・秒数を出し、判定できないことを自ら明示する', () => {
    const text = formatReport([
      {
        issueNumber: 910,
        closedAt: '2026-09-13T01:03:47Z',
        prNumber: 912,
        mergedAt: '2026-09-13T01:03:46Z',
        secondsAfterMerge: 1,
        matchedVia: 'timing',
        actor: 'takecchi',
      },
    ]);
    expect(text).toContain('1件の候補');
    expect(text).toContain('#910');
    expect(text).toContain('PR #912');
    expect(text).toContain('1秒後');
    expect(text).toContain('判定ではない');
  });

  it('閾値を明示する（呼び出しごとに変わりうる値なので、出力から読めること）', () => {
    const text = formatReport([], 42);
    expect(text).toContain('42秒');
  });
});
