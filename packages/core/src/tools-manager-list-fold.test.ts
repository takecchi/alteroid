import { describe, expect, it } from 'vitest';

import { describeReportState } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import { RESTART_BEFORE_CHECK_ADVICE } from './usage-limits.js';

// manager_list の固定の説明（件数行・「…ほか N 件」）を、同じ会話の2回目から短い参照にする（DigestSessionDelta.fixedInTurn）

function pool(managers: ManagerSummary[]): ManagerPool {
  const notUsed = () => {
    throw new Error('この歯では使わない');
  };
  return {
    async list() {
      return managers.map((manager) => ({ ...manager }));
    },
    denials() {
      return [];
    },
    runnerBacklog() {
      return [];
    },
    async runners() {
      return {
        daemonRevision: { status: 'unheard' },
        unassigned: [],
        runners: [
          {
            label: 'r1',
            state: 'connected',
            runnerId: 'runner-1',
            since: '2026-10-27T00:00:00.000Z',
            managers: [],
            revision: { status: 'unheard' },
          },
        ],
      };
    },
    unpushedWork: async () => ({ kind: 'none' }),
    start: notUsed,
    send: notUsed,
    abort: notUsed,
  } as unknown as ManagerPool;
}

function summary(n: number, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: `mgr-${String(n).padStart(3, '0')}`,
    status: 'done',
    live: false,
    cwd: '/work',
    request: `依頼文 ${n}。${'依頼の説明が続く。'.repeat(30)}`,
    startedAt: new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + n * 60_000).toISOString(),
    updatedAt: '2026-10-27T01:00:00.000Z',
    waiting: [],
    lastReport: `報告 ${n}。${'報告の本文が続く。'.repeat(30)}`,
    lastReportAt: '2026-10-27T01:00:00.000Z',
    ...extra,
  };
}

// 通常時: 終端した委譲が予算（8,000字）を越えて溜まり、先頭に走行中が1本。lost・枠・runner 消失は無い
const normal = (): ManagerSummary[] => [
  summary(0, { status: 'running', live: true }),
  ...Array.from({ length: 40 }, (_, i) => summary(i + 1)),
];
// 異常時: lost・枠で止まった・runner が名簿から消えた委譲が混ざる
const abnormal = (): ManagerSummary[] => [
  ...normal(),
  summary(100, { status: 'lost' }),
  summary(101, { status: 'running', usageStoppedAt: '2026-10-27T00:30:00.000Z' }),
  summary(102, { status: 'running', runnerVanished: true }),
];

// 受信箱の滞留12件（人間起点を含む）。器の行の形は inbox-backlog.test.ts と同じ
const stuckInbox = (): unknown[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `ev${String(i)}`,
    at: new Date(Date.UTC(2026, 9, 27, 0, 0, 0) - i * 3_600_000).toISOString(),
    deliveries: i % 3,
    event:
      i % 2 === 1
        ? { type: 'human_message', text: 'x', conversationId: 'c1' }
        : { type: 'manager_message', managerId: `mgr-${String(i)}`, text: 'y' },
  }));

function harness(
  managers: () => ManagerSummary[],
  delta: DigestSessionDelta | null,
  extra: { inbox?: unknown[]; queued?: number; ledger?: string[] } = {},
) {
  const stores = createMemoryStores();
  const ledger = extra.ledger ?? [];
  if (extra.inbox !== undefined) {
    const entries = extra.inbox;
    (stores.inbox as { peekPending: () => Promise<unknown> }).peekPending = async () => ({
      entries,
      unreadable: [],
    });
  }
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(extra.queued === undefined ? {} : { queuedInMemory: () => extra.queued }),
    managers: pool(managers()),
    ...(delta === null
      ? {}
      : { foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref) }),
  });
  return async (args: Record<string, unknown> = {}, tool = 'manager_list'): Promise<string> => {
    const found = tools.find((entry) => entry.name === tool);
    if (!found) throw new Error(`${tool} が無い`);
    for (const id of ledger) {
      await stores.jobs.putJob({
        id,
        managerId: id,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        status: 'done',
        summary: '依頼',
        conversationId: `conv-${id}`,
      });
    }
    const result = await found.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe('manager_list は固定の説明を、同じ会話の2回目から短い参照にする', () => {
  it('⭐ 通常時: 2回目は件数・行・続きの取り方を毎回出し、固定の説明だけが参照になって短くなる', async () => {
    const call = harness(normal, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    expect(first).toContain('**「走行中」は「進んでいる」ではない**');
    expect(first).toContain('**省略されたのは終端したもの');
    expect(first).toContain('台帳には保持期間も掃除の機構も無い');
    expect(second).not.toContain('**「走行中」は「進んでいる」ではない**');
    expect(second).not.toContain('**省略されたのは終端したもの');
    expect(second).not.toContain('台帳には保持期間も掃除の機構も無い');
    // 参照にも要点が残る
    expect(second).toContain('動いている本数は「話しかけられる」ほうで数える');
    expect(second).toContain('省略されたのは終端したもの・より古いものの側');
    expect(second).toContain('status や q で絞れば減らせる');
    // 可変部は毎回出る
    for (const text of [first, second]) {
      expect(text).toContain('件数: 全 41 本 / 走行中 1 本（うち話しかけられる 1 本）');
      expect(text).toContain('話しかけられる委譲は全体で 1 本である。');
      expect(text).toContain('- mgr-000');
      expect(text).toMatch(
        /続きは manager_list cursor=\S+ で取れる（status と q は同じまま呼ぶこと）。/,
      );
    }
    // 実測（この fixture）: 1回目 8,009字 → 2回目 7,903字
    expect(second.length).toBeLessThan(first.length - 80);
  });

  it('⭐ 異常時（lost・枠・runner 消失）: 各ブロックが1回ずつ全文で、2回目は要点を残した参照になる', async () => {
    const call = harness(abnormal, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    for (const phrase of [
      '**「戻れなかった(lost)」は「終わった」ではない**',
      '**「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である**',
      '**「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である**',
    ]) {
      expect(first).toContain(phrase);
      expect(second).not.toContain(phrase);
    }
    // 参照に残る要点: 打つ手が変わるもの
    expect(second).toContain('status: ["lost"]');
    expect(second).toContain('status: ["running"]');
    expect(second).toContain('status: ["done"]');
    expect(second).toContain('確かめる前に manager_start で起こし直さない');
    expect(second).toContain('各行の ⚠ 枠(利用上限)で止まっている から辿る');
    expect(second).toContain('各行の ⚠ 宛先の runner が名簿から消えている から辿る');
    // 件数の内訳は毎回出る
    for (const text of [first, second]) {
      expect(text).toContain('戻れなかった(lost) 1 本');
      expect(text).toContain('枠(利用上限)で止まっている 1 本');
      expect(text).toContain('宛先の runner が名簿から消えている 1 本');
    }
    // 実測（この fixture）: 1回目 9,505字 → 2回目 9,030字
    expect(second.length).toBeLessThan(first.length - 400);
  });

  it('1回目に無かったブロックは、初めて出る回に全文で出る（出していない全文を「出した」と控えない）', async () => {
    const delta = new DigestSessionDelta();
    await harness(normal, delta)();

    const second = await harness(abnormal, delta)();

    expect(second).toContain('**「戻れなかった(lost)」は「終わった」ではない**');
    expect(second).not.toContain('**「走行中」は「進んでいる」ではない**');
  });

  it('⭐ reset（会話が変わった・要約が走りうる・失敗したターンの後）の後は全文へ戻る', async () => {
    for (const reason of ['full', 'compaction'] as const) {
      const delta = new DigestSessionDelta();
      const call = harness(abnormal, delta);
      const first = await call();
      await call();

      delta.reset(reason);
      const afterReset = await call();

      expect(afterReset).toBe(first);
    }
  });

  it('⭐ 受信箱の滞留: 2回目は固定の言い回しだけが札になり、数・時刻・内訳は毎回出る。札にも結論が残る', async () => {
    const delta = new DigestSessionDelta();
    const call = harness(normal, delta, { inbox: stuckInbox(), queued: 5 });

    const first = await call();
    const second = await call();

    for (const phrase of [
      '門が畳んだ行はターンが1度も起きないまま数だけ増える',
      'PendingInboxEvent.at の doc',
      'ストアに残っている行を見ているだけで、配達されていないとは言えない',
      '内訳を割る口は無い',
      'source/managerIdを持つ型のみ',
      '向きと理由は inboxBacklogDedupeKey の doc',
      '齢は相対値なので、この行を写すときは基準点も一緒に写すこと',
    ]) {
      expect(first).toContain(phrase);
      expect(second).not.toContain(phrase);
    }
    // 札に残る結論
    expect(second).toContain('配られた回数ではない');
    expect(second).toContain('配達されていないとは言えない');
    expect(second).toContain('足しても引いても意味が無い');
    expect(second).toContain('この数は上下どちらへもぶれる');
    // 数・時刻・内訳は毎回出る
    for (const text of [first, second]) {
      expect(text).toContain('未処理の合図が 12 件ある');
      expect(text).toContain('人間起点（human_message / human_answer）の滞留が 6 件ある');
      expect(text).toContain('メモリの配達待ち行列 5 件');
      expect(text).toContain('内訳（計 12 件）:');
      expect(text).toContain('種類: ');
      expect(text).toContain('器の入れ替え回数: 0回＝いまの器になってから積まれた');
      expect(text).toContain('齢（観測 ');
    }
    expect(second.length).toBeLessThan(first.length - 300);
  });

  it('⭐ 絞り込みの注記: 2回目は言い回しだけが札になり、絞りの値と件数は毎回出る', async () => {
    const call = harness(normal, new DigestSessionDelta());
    const args = { status: ['done'], q: 'mgr-00' };

    const first = await call(args);
    const second = await call(args);

    for (const phrase of [
      '大文字小文字と全角半角は区別しない',
      'すぐ上の件数は絞る前の全体である',
    ]) {
      expect(first).toContain(phrase);
      expect(second).not.toContain(phrase);
    }
    expect(second).toContain('件数は絞る前の全体');
    for (const text of [first, second]) {
      expect(text).toContain('絞り込み: status: done に当たるのは 40 件');
      expect(text).toContain('絞り込み: q: "mgr-00"');
      expect(text).toContain('に当たるのは 9 件（status で絞った 40 件の中）');
    }

    const empty = harness(normal, new DigestSessionDelta());
    const emptyFirst = await empty({ status: [], q: '  ' });
    const emptySecond = await empty({ status: [], q: '  ' });
    expect(emptyFirst).toContain('人間の GET /managers に揃えてある');
    expect(emptySecond).not.toContain('人間の GET /managers に揃えてある');
    // 札にも「この道具だけ [] の倒し方が逆」が残る
    expect(emptySecond).toContain('この道具だけ逆');
    expect(emptySecond).toContain('絞り込み: status に空の配列が渡ったので、絞らずに全件を出した');
  });

  it('⭐ 行の印の意味: 2回目は札になるが、失われたという意味ではない・終わったかは分からない、が残る', async () => {
    const marks = (): ManagerSummary[] => [
      summary(1, { status: 'lost' }),
      summary(2, { status: 'running', runnerLostSince: '2026-10-27T00:10:00.000Z' }),
      summary(3, { status: 'running', sessionMissingSince: '2026-10-27T00:10:00.000Z' }),
    ];
    const call = harness(marks, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    expect(first).toContain('**戻れたかどうかしか見ていない**');
    expect(first).toContain('器そのものは runner_list で見る');
    expect(second).not.toContain('**戻れたかどうかしか見ていない**');
    expect(second).not.toContain('器そのものは runner_list で見る');
    expect(second).toContain(
      '［lost］ 前のセッションへ戻れなかっただけで、**終わったかは分からない**',
    );
    expect(second).toContain(
      '［runner 消失］ 宛先の器が名乗っていない。**この委譲が失われたという意味ではない**',
    );
    expect(second).toContain(
      '［セッション無し］ runner がこの委譲のセッションを持っていなかった。**この委譲が失われたという意味ではない**',
    );
    for (const text of [first, second]) {
      expect(text).toContain('行の印の意味（同じ文を行ごとには繰り返さない）:');
      expect(text).toContain('［runner 消失］［セッション無し］ **確かめる前に');
    }
  });

  it('⭐ 件数の行の参照にも結論が残る（lost は終わったではない・走行中は進んでいるではない）', async () => {
    const call = harness(abnormal, new DigestSessionDelta());
    await call();
    const second = await call();

    expect(second).toContain('lost は「終わった」ではなく');
    expect(second).toContain('「走行中」は「進んでいる」ではない');
  });

  it('⭐ cursor は2回目も出る（畳むと続きが取れなくなる）。取れた続きの頁も数・id が出る', async () => {
    const call = harness(normal, new DigestSessionDelta(), { inbox: stuckInbox() });
    await call();
    const second = await call();
    const cursor = /manager_list cursor=(\S+)/.exec(second)?.[1];

    expect(cursor).toBeDefined();
    const next = await call({ cursor });
    expect(next).toContain('件数: 全 41 本');
    expect(next).toMatch(/- mgr-0\d\d/);
  });

  it('⭐ 返さなかった応答の手前で全文を「出した」と控えない（cursor の誤りで返したあとの最初の一覧は全文）', async () => {
    const call = harness(abnormal, new DigestSessionDelta(), { inbox: stuckInbox() });

    const bad = await call({ cursor: 'not-a-cursor' });
    const first = await call();

    expect(bad).toContain('cursor が壊れている');
    expect(first).toContain('門が畳んだ行はターンが1度も起きないまま数だけ増える');
    expect(first).toContain('**戻れたかどうかしか見ていない**');
  });

  it('⭐ RESTART_BEFORE_CHECK_ADVICE は1応答に全文で1回だけ（以降は結論を短く残して「上と同じ」）', async () => {
    const withFailure = (): ManagerSummary[] => [
      ...abnormal(),
      summary(103, {
        lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-10-27T00:20:00.000Z' },
      }),
      summary(104, { status: 'running', runnerLostSince: '2026-10-27T00:10:00.000Z' }),
    ];
    const call = harness(withFailure, null);

    const text = await call({ status: ['lost', 'running', 'done'], q: 'mgr-1' });

    expect(text.split(RESTART_BEFORE_CHECK_ADVICE).length - 1).toBe(1);
    expect(text).toContain('（上と同じ）');
    // 結論は残る: 初出より後ろの失敗の行にも「確かめる前に起こし直さない」が付く
    const failureRow = text
      .split('\n')
      .find((line) => line.includes('直近のターンは報告ではなく失敗'));
    expect(failureRow).toContain('確かめる前に起こし直さないこと');
  });

  it('⭐ runner_list の pids 注と末尾の文: 2回目は札になり、結論が残る', async () => {
    const call = harness(normal, new DigestSessionDelta());

    const first = await call({ resources: true }, 'runner_list');
    const second = await call({ resources: true }, 'runner_list');

    expect(first).toContain('vitest が1本立ち上がるだけで pids が +131 跳ねている');
    expect(first).toContain('名簿（Registry）はインメモリなので');
    expect(second).not.toContain('vitest が1本立ち上がるだけで pids が +131 跳ねている');
    expect(second).not.toContain('名簿（Registry）はインメモリなので');
    expect(second).toContain('空きは「次に何本置けるか」を意味しない');
    expect(second).toContain('デーモンの再起動で作り直される');
    expect(second).toContain('runner は1台のみ登録されている');
    expect(second.length).toBeLessThan(first.length - 150);
  });

  it('⭐ 行の中の起点の会話の使い方: 出ている行の2行目から短くなり、会話の id は毎行出る', async () => {
    const hint = '（報告を人間へ知らせるなら、この会話へ書く）';
    const rows = (): ManagerSummary[] => [summary(1), summary(2), summary(3)];
    const ledger = ['mgr-001', 'mgr-002', 'mgr-003'];
    const call = harness(rows, new DigestSessionDelta(), { ledger });

    const first = await call();
    const second = await call();

    // 1回目: 最初の行だけ全文、残りは参照。2回目: 全部参照（全文は会話の上に在る）
    expect(first.split(hint).length - 1).toBe(1);
    expect(second.split(hint).length - 1).toBe(0);
    for (const text of [first, second]) {
      for (const id of ledger) expect(text).toContain(`起点の会話: conv-${id}`);
      expect(text.split('（知らせるならこの会話へ）').length - 1).toBe(text === first ? 2 : 3);
    }
    expect(second.length).toBeLessThan(first.length);
    // 口が無い器は全行が全文
    const plain = await harness(rows, null, { ledger })();
    expect(plain.split(hint).length - 1).toBe(3);
  });

  it('⭐ 行の中の「本文は届いているが…」「本文が1文字も届いていない」: 2行目から短くなり、結論は残る', async () => {
    const delivered = '⚠ 本文は届いているが、完遂した報告とは限らない。';
    const none = '⚠ 終端までに本文が1文字も届いていない。';
    const rows = (): ManagerSummary[] => [
      summary(1, { status: 'lost' }),
      summary(2, { status: 'lost' }),
      summary(3, { status: 'lost', lastReport: undefined, lastReportAt: undefined }),
      summary(4, { status: 'lost', lastReport: undefined, lastReportAt: undefined }),
    ];
    const call = harness(rows, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    const count = (text: string, phrase: string): number => text.split(phrase).length - 1;
    expect(
      count(first, '終端の直前に「喋っただけの本文」がそのまま報告として出る経路が runner に在り'),
    ).toBe(1);
    expect(count(first, 'この委譲が何をしたかは、この一覧からは1文字も読めない')).toBe(1);
    expect(
      count(second, '終端の直前に「喋っただけの本文」がそのまま報告として出る経路が runner に在り'),
    ).toBe(0);
    expect(count(second, 'この委譲が何をしたかは、この一覧からは1文字も読めない')).toBe(0);
    // 参照にも結論が残る: 行ごとに付く（行を消さない）
    for (const text of [first, second]) {
      expect(
        count(text, delivered.slice(0, '⚠ 本文は届いているが、完遂した報告とは限らない'.length)),
      ).toBe(2);
      expect(count(text, none.slice(0, '⚠ 終端までに本文が1文字も届いていない'.length))).toBe(2);
    }
    expect(second).toContain('台帳では区別できない');
    expect(second).toContain('何をしたかはこの一覧から読めない');
    expect(second.length).toBeLessThan(first.length - 150);
  });

  it('報告の抜粋の中に同じ字面が在っても書き換えない（畳むのは manager_list が組んだ行だけ）', async () => {
    const hint = '（報告を人間へ知らせるなら、この会話へ書く）';
    const delivered = describeReportState('delivered');
    const rows = (): ManagerSummary[] => [
      summary(1, { lastReport: `引用: ${hint}` }),
      summary(2, { lastReport: `引用: ${hint}` }),
      summary(3, { lastReport: `引用: ${delivered}` }),
      summary(4, { lastReport: `引用: ${delivered}` }),
    ];
    const call = harness(rows, new DigestSessionDelta(), {
      ledger: ['mgr-001', 'mgr-002', 'mgr-003', 'mgr-004'],
    });

    await call();
    const second = await call();

    // 起点の行は参照になり、報告の抜粋の4本は全文のまま
    expect(second.split(hint).length - 1).toBe(2);
    expect(second.split(delivered).length - 1).toBe(2);
    expect(second).toContain(`直近の報告（2026-10-27T01:00:00.000Z 受信）: 引用: ${hint}`);
    expect(second).toContain(`直近の報告（2026-10-27T01:00:00.000Z 受信）: 引用: ${delivered}`);
  });

  it('口が無い器（テスト・蒸留）は何度呼んでも全文', async () => {
    const call = harness(abnormal, null);

    const first = await call();
    const second = await call();

    expect(second).toBe(first);
    expect(first).toContain('**「走行中」は「進んでいる」ではない**');
  });
});
