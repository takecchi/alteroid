import { describe, expect, it } from 'vitest';
import {
  describeUnreadableApprovals,
  describeUnreadableInboxEvents,
  describeUnreadableJobs,
  describeUnreadablePractices,
  describeUnreadableSchedules,
  describeUnreadableTokens,
} from './store.js';

// 「読めない行」の1文の組み立て（件数・上限で切る・キーが取れない行）を固定する。
const reason = 'broken';
const range = (n: number) => Array.from({ length: n }, (_, i) => `k${i + 1}`);

describe('describeUnreadableApprovals', () => {
  it('0 件は null', () => {
    expect(describeUnreadableApprovals([])).toBeNull();
  });
  it('1 件', () => {
    expect(describeUnreadableApprovals([{ id: 'a1', reason }])).toMatchInlineSnapshot(
      `"読めない承認待ちが 1 件ある（id: a1）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。"`,
    );
  });
  it('id が全部取れない', () => {
    expect(describeUnreadableApprovals([{ reason }, { reason }])).toMatchInlineSnapshot(
      `"読めない承認待ちが 2 件ある（id も取れない）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。"`,
    );
  });
  it('一部の id が取れない', () => {
    expect(describeUnreadableApprovals([{ id: 'a1', reason }, { reason }])).toMatchInlineSnapshot(
      `"読めない承認待ちが 2 件ある（id: a1。id が取れない行が 1 件）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。"`,
    );
  });
  it('ちょうど 10 件', () => {
    expect(
      describeUnreadableApprovals(range(10).map((id) => ({ id, reason }))),
    ).toMatchInlineSnapshot(
      `"読めない承認待ちが 10 件ある（id: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。"`,
    );
  });
  it('上限を超える + id が取れない行', () => {
    expect(
      describeUnreadableApprovals([...range(12).map((id) => ({ id, reason })), { reason }]),
    ).toMatchInlineSnapshot(
      `"読めない承認待ちが 13 件ある（id: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 ほか 2 件。id が取れない行が 1 件）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。"`,
    );
  });
});

describe('describeUnreadableJobs', () => {
  it('0 件は null', () => {
    expect(describeUnreadableJobs([])).toBeNull();
  });
  it('1 件', () => {
    expect(describeUnreadableJobs([{ id: 'j1', reason }])).toMatchInlineSnapshot(
      `"読めない委譲が 1 件ある（id: j1）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。"`,
    );
  });
  it('id が全部取れない', () => {
    expect(describeUnreadableJobs([{ reason }])).toMatchInlineSnapshot(
      `"読めない委譲が 1 件ある（id も取れない）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。"`,
    );
  });
  it('上限を超える + id が取れない行', () => {
    expect(
      describeUnreadableJobs([...range(11).map((id) => ({ id, reason })), { reason }]),
    ).toMatchInlineSnapshot(
      `"読めない委譲が 12 件ある（id: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 ほか 1 件。id が取れない行が 1 件）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。"`,
    );
  });
});

describe('describeUnreadableSchedules', () => {
  it('0 件は null', () => {
    expect(describeUnreadableSchedules([])).toBeNull();
  });
  it('1 件（kind が分かる: 末尾の案内が付く）', () => {
    expect(describeUnreadableSchedules([{ kind: 'daily', reason }])).toMatchInlineSnapshot(
      `"読めない継続中の依頼が 1 件ある（kind: daily）。壊れた行であって、消された依頼ではない。この一覧には載っていない。kind が分かるものは schedule_remove kind=<kind> で外せる。"`,
    );
  });
  it('kind が全部取れない（案内は付かない）', () => {
    expect(describeUnreadableSchedules([{ reason }])).toMatchInlineSnapshot(
      `"読めない継続中の依頼が 1 件ある（kind も取れない）。壊れた行であって、消された依頼ではない。この一覧には載っていない。"`,
    );
  });
  it('上限を超える + kind が取れない行', () => {
    expect(
      describeUnreadableSchedules([...range(12).map((kind) => ({ kind, reason })), { reason }]),
    ).toMatchInlineSnapshot(
      `"読めない継続中の依頼が 13 件ある（kind: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 ほか 2 件。kind が取れない行が 1 件）。壊れた行であって、消された依頼ではない。この一覧には載っていない。kind が分かるものは schedule_remove kind=<kind> で外せる。"`,
    );
  });
});

describe('describeUnreadableInboxEvents', () => {
  it('0 件は null', () => {
    expect(describeUnreadableInboxEvents([])).toBeNull();
  });
  it('1 件', () => {
    expect(describeUnreadableInboxEvents([{ id: 'e1', reason }])).toMatchInlineSnapshot(
      `"読めない合図が 1 件ある（id: e1）。壊れた行であって、処理済みで消えたのではない。この内訳には載っていない。配られてもいない。"`,
    );
  });
  it('id が全部取れない', () => {
    expect(describeUnreadableInboxEvents([{ reason }])).toMatchInlineSnapshot(
      `"読めない合図が 1 件ある（id も取れない）。壊れた行であって、処理済みで消えたのではない。この内訳には載っていない。配られてもいない。"`,
    );
  });
  it('上限を超える + id が取れない行', () => {
    expect(
      describeUnreadableInboxEvents([...range(12).map((id) => ({ id, reason })), { reason }]),
    ).toMatchInlineSnapshot(
      `"読めない合図が 13 件ある（id: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 ほか 2 件。id が取れない行が 1 件）。壊れた行であって、処理済みで消えたのではない。この内訳には載っていない。配られてもいない。"`,
    );
  });
});

describe('describeUnreadablePractices', () => {
  it('0 件は null', () => {
    expect(describeUnreadablePractices([])).toBeNull();
  });
  it('1 件', () => {
    expect(describeUnreadablePractices([{ slug: 'p1', reason }])).toMatchInlineSnapshot(
      `"読めないやり方が 1 件ある（slug: p1）。壊れた行であって、消されたやり方ではない。この一覧には載っていない。"`,
    );
  });
  it('slug が全部取れない', () => {
    expect(describeUnreadablePractices([{ reason }])).toMatchInlineSnapshot(
      `"読めないやり方が 1 件ある（slug も取れない）。壊れた行であって、消されたやり方ではない。この一覧には載っていない。"`,
    );
  });
  it('一部の slug が取れない', () => {
    expect(describeUnreadablePractices([{ slug: 'p1', reason }, { reason }])).toMatchInlineSnapshot(
      `"読めないやり方が 2 件ある（slug: p1。slug が取れない行が 1 件）。壊れた行であって、消されたやり方ではない。この一覧には載っていない。"`,
    );
  });
  it('ちょうど 10 件', () => {
    expect(
      describeUnreadablePractices(range(10).map((slug) => ({ slug, reason }))),
    ).toMatchInlineSnapshot(
      `"読めないやり方が 10 件ある（slug: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10）。壊れた行であって、消されたやり方ではない。この一覧には載っていない。"`,
    );
  });
  it('上限を超える + slug が取れない行', () => {
    expect(
      describeUnreadablePractices([...range(12).map((slug) => ({ slug, reason })), { reason }]),
    ).toMatchInlineSnapshot(
      `"読めないやり方が 13 件ある（slug: k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 ほか 2 件。slug が取れない行が 1 件）。壊れた行であって、消されたやり方ではない。この一覧には載っていない。"`,
    );
  });
});

describe('describeUnreadableTokens', () => {
  it('0 件は null', () => {
    expect(describeUnreadableTokens([])).toBeNull();
  });
  it('id とラベルの両方', () => {
    expect(describeUnreadableTokens([{ id: 't1', label: 'main', reason }])).toMatchInlineSnapshot(
      `"読めないトークンの行が 1 件ある（id t1 / ラベル main）。壊れた行であって、消されたトークンではない。この一覧には載っていない。プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。alteroid token remove-unreadable <id>）を使う。"`,
    );
  });
  it('id だけ・ラベルだけ', () => {
    expect(
      describeUnreadableTokens([
        { id: 't1', reason },
        { label: 'sub', reason },
      ]),
    ).toMatchInlineSnapshot(
      `"読めないトークンの行が 2 件ある（id t1, ラベル sub）。壊れた行であって、消されたトークンではない。この一覧には載っていない。プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。alteroid token remove-unreadable <id>）を使う（id が取れない行は、その口では消せない）。"`,
    );
  });
  it('全部取れない', () => {
    expect(describeUnreadableTokens([{ reason }])).toMatchInlineSnapshot(
      `"読めないトークンの行が 1 件ある（id もラベルも取れない）。壊れた行であって、消されたトークンではない。この一覧には載っていない。プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。alteroid token remove-unreadable <id>）を使う（id が取れない行は、その口では消せない）。"`,
    );
  });
  it('id が取れない行が混じる（案内に注記が付く）', () => {
    expect(describeUnreadableTokens([{ id: 't1', reason }, { reason }])).toMatchInlineSnapshot(
      `"読めないトークンの行が 2 件ある（id t1。id もラベルも取れない行が 1 件）。壊れた行であって、消されたトークンではない。この一覧には載っていない。プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。alteroid token remove-unreadable <id>）を使う（id が取れない行は、その口では消せない）。"`,
    );
  });
  it('上限を超える', () => {
    expect(
      describeUnreadableTokens([
        ...range(12).map((id) => ({ id, label: `L${id}`, reason })),
        { reason },
      ]),
    ).toMatchInlineSnapshot(
      `"読めないトークンの行が 13 件ある（id k1 / ラベル Lk1, id k2 / ラベル Lk2, id k3 / ラベル Lk3, id k4 / ラベル Lk4, id k5 / ラベル Lk5, id k6 / ラベル Lk6, id k7 / ラベル Lk7, id k8 / ラベル Lk8, id k9 / ラベル Lk9, id k10 / ラベル Lk10 ほか 2 件。id もラベルも取れない行が 1 件）。壊れた行であって、消されたトークンではない。この一覧には載っていない。プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。alteroid token remove-unreadable <id>）を使う（id が取れない行は、その口では消せない）。"`,
    );
  });
});
