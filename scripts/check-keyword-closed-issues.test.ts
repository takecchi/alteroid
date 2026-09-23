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

describe('findKeywordClosedCandidates — Alteroid-Issue-Done trailer で閉じた分は候補から外す（#1195 の実測、#1128 コメント2026-09-23）', () => {
  // 実測（2026-09-23、gh pr view <N> --json body / gh api .../issues/<N>/timeline）。
  // PR #1247 は本文の trailer が #1123 だけを名乗る（#1195/#1198 は名乗っていない）のに、
  // 「最寄りのマージ」としては #1195 のクローズに最も近い（10秒前）——旧アルゴリズムは
  // ここを誤って結びつけていた。実際に#1195/#1198を閉じたのはPR #1199（trailerが
  // 「1195, 1198」を名乗る。マージは#1247より14秒早い）で、actorはどちらも
  // github-actions[bot]（issue-done-trailer workflow が閉じた証拠）。
  const mergedPRs = [
    {
      number: 1247,
      mergedAt: '2026-09-19T22:02:23Z',
      mergeCommitOid: '3e3f9e0d8975f901f6e517f24f662d9f99dfcc6a',
      body: 'ある改修の本文。\n\nAlteroid-Issue-Done: 1123\n',
    },
    {
      number: 1199,
      mergedAt: '2026-09-19T22:02:09Z',
      mergeCommitOid: '666af95c1709fa05ef4363dc271af4560bbc19fd',
      body: '別の改修の本文。\n\nAlteroid-Issue-Done: 1195, 1198\n',
    },
  ];

  it('#1195・#1198 とも候補から消える（trailer で閉じたと判定する）', () => {
    const closeEvents = [
      {
        issueNumber: 1195,
        closedAt: '2026-09-19T22:02:33Z',
        commitId: null,
        actor: 'github-actions[bot]',
      },
      {
        issueNumber: 1198,
        closedAt: '2026-09-19T22:02:35Z',
        commitId: null,
        actor: 'github-actions[bot]',
      },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toEqual([]);
  });

  it('同じタイミング・同じ trailer でも actor が人間なら trailer close とは判定せず、候補に残る（フォールバックで最寄りの#1247に結びつく）', () => {
    // trailer の名乗りだけでは閉じたと判定しない——issue-done-trailer.yml が
    // 常に github-actions[bot] として閉じることを実測で確認した（本文のコメント参照）。
    // actor が human ならこの経路ではないので、通常の候補判定へ倒す。
    const closeEvents = [
      { issueNumber: 1195, closedAt: '2026-09-19T22:02:33Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    // #1247 は #1195 を名乗っていない（trailer は #1123 だけ）ので keyword-naming 経路にも
    // 乗らず、フォールバックの「最寄りのマージ」に落ちる。
    expect(result[0]).toMatchObject({ prNumber: 1247, matchedVia: 'timing' });
  });
});

describe('findKeywordClosedCandidates — 名乗った PR があれば、そちらへ結びつける（最寄りのマージではない）', () => {
  it('nearest merge (#100) は Issue を名乗っていない。keyword で名乗った #99 のほうへ結びつく', () => {
    const mergedPRs = [
      {
        number: 100,
        mergedAt: '2026-09-01T00:00:05Z',
        mergeCommitOid: 'nope-a',
        body: '無関係な変更。Issue の言及なし。',
      },
      {
        number: 99,
        mergedAt: '2026-09-01T00:00:00Z',
        mergeCommitOid: 'nope-b',
        body: 'Closes #42',
      },
    ];
    const closeEvents = [
      { issueNumber: 42, closedAt: '2026-09-01T00:00:06Z', commitId: null, actor: 'takecchi' },
    ];
    // 「最寄りのマージ」だけを見れば #100（1秒前）が選ばれてしまう。
    // 名乗った PR（#99、6秒前。閾値10秒以内）を優先しなければならない。
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: 99, secondsAfterMerge: 6, matchedVia: 'timing' });
  });
});

describe('findKeywordClosedCandidates — 陽性対照: 名乗る PR が無ければ、従来どおり最寄りのマージへ結びつく（#1003/#1050 の実測、#1128 コメント2026-09-23）', () => {
  // 実測（2026-09-23）: PR #1126 / #1143 の本文・タイトルには #1003 / #1050 への
  // 言及が1文字も無い（`/1003/.test(body)` / `/1050/.test(body)` がともに false）。
  // ⟹ 手で閉じたのがマージと偶然重なった偽陽性——道具はこれを直さず、そのまま拾い続ける。
  it('#1003 ← PR #1126（本文に言及なし）は候補に残り、#1126 へ結びつく', () => {
    const mergedPRs = [
      {
        number: 1126,
        mergedAt: '2026-09-16T21:37:09Z',
        mergeCommitOid: 'da85c8923c4a6052e6f94df67f02e3048f68406f',
        body: '## 変異試験（Issue #1022 の測定を再実施）\n\nRefs #1022\n',
      },
    ];
    const closeEvents = [
      { issueNumber: 1003, closedAt: '2026-09-16T21:37:13Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: 1126, secondsAfterMerge: 4, matchedVia: 'timing' });
  });

  it('#1050 ← PR #1143（本文に言及なし）は候補に残り、#1143 へ結びつく', () => {
    const mergedPRs = [
      {
        number: 1143,
        mergedAt: '2026-09-17T02:22:35Z',
        mergeCommitOid: '9348bd09c9d3d84759446b415fa8ddf8d3bb8b35',
        body: '受信箱の合図から器が自動で台帳を開いた経路の話。',
      },
    ];
    const closeEvents = [
      { issueNumber: 1050, closedAt: '2026-09-17T02:22:36Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: 1143, secondsAfterMerge: 1, matchedVia: 'timing' });
  });
});

describe('findKeywordClosedCandidates — やりすぎを落とす歯: 過去に trailer で名乗られたことがあるだけでは外さない（合成、reopen 後に別 PR のキーワードで閉じた形）', () => {
  it('1回目（trailer close、bot、excluded）と2回目（reopen 後、keyword close、human、候補に残る）が両方正しく扱われる', () => {
    const mergedPRs = [
      {
        number: 500,
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommitOid: 'x1',
        body: 'Alteroid-Issue-Done: 700',
      },
      {
        number: 510,
        mergedAt: '2026-02-01T00:00:00Z',
        mergeCommitOid: 'x2',
        body: 'Closes #700',
      },
    ];
    const closeEvents = [
      // 1回目: trailer で閉じた（issue-done-trailer workflow、actor=bot）。除外される。
      // ⚠️ 5秒後という値は合成——実測の trailer 遅延（19〜47秒、後述の定数の doc）より
      // 短いが、意図的にこの値を選んでいる: 5秒は「名乗る PR を見ずに actor も見ない」
      // 旧実装でも「最寄りのマージ」として拾ってしまう距離（閾値10秒以内）なので、
      // ここを訂正できていることが red→green の変化として見える。
      {
        issueNumber: 700,
        closedAt: '2026-01-01T00:00:05Z',
        commitId: null,
        actor: 'github-actions[bot]',
      },
      // reopen された後、2回目: 別の PR がキーワードで閉じた（人間のトークン）。候補に残るべき。
      { issueNumber: 700, closedAt: '2026-02-01T00:00:02Z', commitId: null, actor: 'takecchi' },
    ];
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    // ⚠️ 「#700 はかつて trailer で名乗られたことがある」を理由に無条件で外すと、
    // 2回目まで消えて0件になる。正しい実装は時刻の相関（と actor）で1件ずつ判定するので、
    // 1回目だけが消えて2回目だけが残る。
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      issueNumber: 700,
      prNumber: 510,
      secondsAfterMerge: 2,
      matchedVia: 'timing',
      actor: 'takecchi',
    });
  });
});

describe('findKeywordClosedCandidates — Alteroid-Issue-Done: none とフェンス内の trailer は名乗りとして数えない', () => {
  it('フェンスの中の trailer 行と、実体の none 行を持つ PR は、その Issue 番号を名乗ったことにならない（fallback で通常どおり候補に出る）', () => {
    const mergedPRs = [
      {
        number: 600,
        mergedAt: '2026-03-01T00:00:00Z',
        mergeCommitOid: 'y1',
        body: '```\nAlteroid-Issue-Done: 800\n```\n\nAlteroid-Issue-Done: none\n',
      },
    ];
    const closeEvents = [
      { issueNumber: 800, closedAt: '2026-03-01T00:00:05Z', commitId: null, actor: 'takecchi' },
    ];
    // #800 は「名乗られて」いない（フェンスの中は見ない。実体の行は none）ので、
    // trailer 除外にも keyword 優先にも乗らない。それでも5秒後・閾値内なので
    // フォールバックの「最寄りのマージ」で候補に出る——名乗りが無いことと
    // 候補から消えることは別である。
    const result = findKeywordClosedCandidates({ mergedPRs, closeEvents }) as Candidate[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prNumber: 600, secondsAfterMerge: 5, matchedVia: 'timing' });
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
