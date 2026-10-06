import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalsController } from './approvals-controller.js';
import { approvalSummary } from './approvals-view.js';
import { approvalRow, fakeApi, type FakeApi } from './fake-api.js';
import type { HeaderFeed } from './header-feed.js';
import { waitFor } from './test-helpers.js';

const questions = [
  {
    id: 'q1',
    prompt: 'デプロイ先',
    options: [
      { id: 'a', label: 'Railway' },
      { id: 'b', label: 'Fly' },
    ],
  },
];

function setup(configure: (api: FakeApi) => void = () => undefined) {
  const api = fakeApi();
  configure(api);
  const controller = new ApprovalsController(api, { debounceMs: 700 });
  let fire: (type: string) => void = () => undefined;
  const refetch = vi.fn(() => Promise.resolve());
  const feed = {
    onEvent: (listener: (type: string) => void) => {
      fire = listener;
      return () => undefined;
    },
    refetch,
  } as unknown as HeaderFeed;
  controller.attach(feed);
  const state = () => controller.store.getSnapshot();
  return { api, controller, state, refetch, fire: (t = 'escalation') => fire(t) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('一覧', () => {
  it('開くまでは読まない。journal の出来事は 1 回にまとめて取り直す（偽の時計）', async () => {
    vi.useFakeTimers();
    const { api, controller, state, fire } = setup((a) => {
      a.approvalRows = [approvalRow('a'), approvalRow('b')];
    });
    fire();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.approvalListCalls).toHaveLength(0); // 一度も開いていない

    controller.enter();
    await vi.advanceTimersByTimeAsync(0);
    controller.enter(); // 二度目は読まない
    await vi.advanceTimersByTimeAsync(0);
    expect(api.approvalListCalls).toEqual([{ pending: true }]);
    expect(state().list.items.map((a) => a.id)).toEqual(['a', 'b']);

    api.approvalRows = [approvalRow('c'), ...api.approvalRows];
    fire();
    fire();
    fire(); // 続けて届いても 1 回
    await vi.advanceTimersByTimeAsync(700);
    expect(api.approvalListCalls).toHaveLength(2);
    expect(state().list.items.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('取り直しても選択は id で保つ。失敗しても前の一覧を残して理由を出す', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('a'), approvalRow('b')];
    });
    controller.enter();
    await waitFor(() => state().list.status === 'ready');
    controller.moveSelection(1);
    api.approvalRows = [approvalRow('z'), ...api.approvalRows];
    await controller.reload();
    expect(state().list.items[state().list.selected]?.id).toBe('b');

    api.approvalListFails = '繋がらない';
    await controller.reload();
    expect(state().list.status).toBe('ready');
    expect(state().list.items).toHaveLength(3);
    expect(state().list.error).toBe('繋がらない');
  });

  it('最初の読み込みが失敗したら ready ではなく error（空の一覧と描かない）', async () => {
    const { controller, state } = setup((a) => {
      a.approvalListFails = '繋がらない';
    });
    controller.enter();
    await waitFor(() => state().list.status === 'error');
    expect(state().list.items).toEqual([]);
    expect(state().list.error).toBe('繋がらない');
  });
});

describe('詳細を開く', () => {
  it('一覧に無い id（回答済み・取り下げ済み）は全件から探す。どこにも無ければ missing', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalRows = [
        approvalRow('open'),
        approvalRow('done', { answeredAt: '2026-10-02T01:00:00.000Z', answer: '済み' }),
      ];
    });
    await controller.open('done');
    expect(api.approvalListCalls).toEqual([{ pending: true }, { pending: false }]);
    expect(state().detail?.approval?.answer).toBe('済み');
    expect(state().detail?.missing).toBe(false);

    await controller.open('nowhere');
    expect(state().detail?.approval).toBeNull();
    expect(state().detail?.missing).toBe(true);
  });

  it('未回答の一覧に在れば、全件は読まない', async () => {
    const { api, controller } = setup((a) => {
      a.approvalRows = [approvalRow('open')];
    });
    await controller.open('open');
    expect(api.approvalListCalls).toEqual([{ pending: true }]);
  });
});

describe('答える', () => {
  it('答えられないもの（回答済み・取り下げ済み・読み込み前）ではフォームを開かない', async () => {
    const { controller, state } = setup((a) => {
      a.approvalRows = [
        approvalRow('done', { answeredAt: '2026-10-02T01:00:00.000Z' }),
        approvalRow('gone', { withdrawnAt: '2026-10-02T01:00:00.000Z', withdrawnReason: '不要' }),
      ];
    });
    expect(controller.startAnswer()).toBeNull(); // 詳細が無い
    await controller.open('done');
    expect(controller.startAnswer()).toBeNull();
    await controller.open('gone');
    expect(controller.startAnswer()).toBeNull();
    expect(state().detail?.mode).toBe('read');
    expect(state().detail?.form).toBeNull();
  });

  it('設問の無い承認待ちは文字欄だけ（edit）。設問つきは選択肢から始まる（form）', async () => {
    const { controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('free'), approvalRow('choice', { questions })];
    });
    await controller.open('free');
    expect(controller.startAnswer()).toBe('edit');
    await controller.open('choice');
    expect(controller.startAnswer()).toBe('form');
    expect(controller.activate()).toBe('toggled');
    expect(state().detail?.form?.picks['q1']).toEqual(['a']);
  });

  it('送る: 確認を通ってから 1 回だけ送る。送ったあと一覧から消え、ヘッダの件数も取り直す', async () => {
    const { api, controller, state, refetch } = setup((a) => {
      a.approvalRows = [approvalRow('choice', { questions }), approvalRow('other')];
    });
    controller.enter();
    await waitFor(() => state().list.status === 'ready');
    await controller.open('choice');
    controller.startAnswer();
    controller.moveCursor(1);
    controller.activate(); // Fly
    // 確認の前は送れない。
    expect(await controller.confirmSend()).toBe(false);
    expect(api.approvalAnswers).toEqual([]);
    controller.askConfirm();
    expect(state().detail?.mode).toBe('confirm');
    expect(state().detail?.confirm?.preview).toBe('Q1 デプロイ先: (b) Fly');

    const first = controller.confirmSend();
    const second = controller.confirmSend(); // 二重に押しても送るのは 1 回
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(api.approvalAnswers).toEqual([
      { id: 'choice', body: { selections: [{ questionId: 'q1', optionIds: ['b'] }] } },
    ]);
    expect(state().detail?.mode).toBe('read');
    expect(state().detail?.form).toBeNull();
    expect(state().detail?.approval?.answer).toBe('Q1 デプロイ先: (b) Fly');
    expect(state().list.items.map((a) => a.id)).toEqual(['other']);
    expect(refetch).toHaveBeenCalled();
  });

  it('400 の本文はそのまま notice に入る。フォームは閉じず、書いた内容も残る', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('choice', { questions })];
      a.approvalAnswerFails = 'selections が不正: 知らない設問 id "q9" がある。';
    });
    await controller.open('choice');
    controller.startAnswer();
    controller.activate();
    controller.askConfirm();
    expect(await controller.confirmSend()).toBe(false);
    const detail = state().detail;
    expect(detail?.notice).toBe(
      '✗ 回答に失敗しました（HTTP 400）: selections が不正: 知らない設問 id "q9" がある。',
    );
    expect(detail?.noticeTone).toBe('warn');
    expect(detail?.mode).toBe('form');
    expect(detail?.form?.picks['q1']).toEqual(['a']);
    expect(detail?.busy).toBe(false);
    // 直せば同じフォームからまた送れる。
    api.approvalAnswerFails = null;
    controller.askConfirm();
    expect(await controller.confirmSend()).toBe(true);
  });

  it('別の入口で先に回答された: 取り直しで読む画面へ戻し、答えを送っていないと言う。409 の本文も残す', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('free')];
    });
    await controller.open('free');
    controller.startAnswer();
    controller.submitField('はい');
    expect(state().detail?.mode).toBe('confirm');

    // 確認を眺めているあいだに、Web で答えられた。
    const row = api.approvalRows[0];
    if (row === undefined) throw new Error('fixture');
    row.answeredAt = '2026-10-02T03:00:00.000Z';
    row.answer = 'Web から';

    expect(await controller.confirmSend()).toBe(false);
    const detail = state().detail;
    expect(detail?.mode).toBe('read');
    expect(detail?.form).toBeNull();
    expect(detail?.approval?.answer).toBe('Web から');
    expect(detail?.notice).toContain('HTTP 409');
    expect(detail?.notice).toContain('already answered');
    expect(detail?.notice).toContain('他の入口で回答済みになった');
  });

  it('応答が無いまま送信が失敗し、取り直すと回答済み: 「送っていない」と言い切らず、送れたか分からないと言う', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('free')];
    });
    await controller.open('free');
    controller.startAnswer();
    controller.submitField('はい');
    // デーモンは答えを受けたが、応答を受け取る前に接続が切れた（HTTP の応答が無い失敗）。
    const original = api.answerApproval.bind(api);
    api.answerApproval = async (id, body) => {
      await original(id, body);
      throw new Error('fetch failed');
    };

    expect(await controller.confirmSend()).toBe(false);
    const detail = state().detail;
    expect(detail?.mode).toBe('read');
    expect(detail?.approval?.answer).toBe('はい');
    expect(detail?.notice).toContain('fetch failed');
    expect(detail?.notice).toContain('送れたかは分からない');
    expect(detail?.notice).not.toContain('答えは送っていない');
  });

  it('journal の合図で取り直したとき、書いている最中に答えられていたら、フォームを閉じて言う', async () => {
    vi.useFakeTimers();
    const { api, controller, state, fire } = setup((a) => {
      a.approvalRows = [approvalRow('free')];
    });
    await controller.open('free');
    controller.startAnswer();
    const row = api.approvalRows[0];
    if (row === undefined) throw new Error('fixture');
    row.withdrawnAt = '2026-10-02T03:00:00.000Z';
    fire();
    await vi.advanceTimersByTimeAsync(700);
    expect(state().detail?.mode).toBe('read');
    expect(state().detail?.notice).toContain('取り下げられた');
  });

  it('文字欄: 「その他」と補足に書いた文は、カーソルの指す欄へ入る', async () => {
    const { controller, state } = setup((a) => {
      a.approvalRows = [approvalRow('choice', { questions })];
    });
    await controller.open('choice');
    controller.startAnswer();
    controller.moveCursor(2); // Q1 その他
    expect(controller.activate()).toBe('edit');
    controller.setFieldText('別の所');
    expect(controller.fieldText()).toBe('別の所');
    controller.moveCursor(1); // 補足
    expect(controller.activate()).toBe('edit');
    expect(controller.fieldText()).toBe('');
    controller.submitField('ついでに'); // 設問つきは確認へ進まない
    expect(state().detail?.mode).toBe('form');
    expect(state().detail?.form?.text).toBe('ついでに');
    expect(state().detail?.form?.others['q1']).toBe('別の所');
  });
});

describe('切り詰めはサロゲートペアを割らない（#2592）', () => {
  it('一覧の質問の要約', () => {
    const out = approvalSummary(approvalRow('a', { question: `a${'😀'.repeat(400)}` }));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('enter（#2599）', () => {
  it('初回の読み込みが失敗した後、タブへ戻ると読み直す', async () => {
    const { api, controller, state } = setup((a) => {
      a.approvalListFails = '繋がらない';
    });
    controller.enter();
    await waitFor(() => state().list.status === 'error');
    api.approvalListFails = null;
    api.approvalRows = [approvalRow('a')];
    controller.enter();
    await waitFor(() => state().list.status === 'ready');
    expect(state().list.items.map((a) => a.id)).toEqual(['a']);
  });
});

describe('回答済みを決着した日ごとに辿る（#3340）', () => {
  const answered = approvalRow('ap-a', {
    question: '夜のリリースを待つか',
    answeredAt: '2026-09-30T10:00:00.000Z',
    answer: '待たない',
  });
  const withdrawn = approvalRow('ap-w', {
    question: '取り下げた確認',
    withdrawnAt: '2026-09-30T05:00:00.000Z',
    withdrawnReason: '自分で答えを見つけた',
  });

  function fixture(api: FakeApi): void {
    api.answeredDateRows = [
      { date: '2026-09-30', count: 2 },
      { date: '2026-09-29', count: 1 },
    ];
    api.answeredOnRows = { '2026-09-30': [answered, withdrawn] };
    api.approvalRows = [answered, withdrawn];
  }

  it('決着した日を新しい日が上の順に読み、日を選ぶとその日の件（決着の新しい順）を読む', async () => {
    const { controller, state, api } = setup(fixture);
    controller.openDates();
    await waitFor(() => state().dates.status === 'ready');

    expect(state().view).toBe('dates');
    expect(state().dates.items.map((d) => `${d.date}:${d.count}`)).toEqual([
      '2026-09-30:2',
      '2026-09-29:1',
    ]);
    expect(api.answeredDateCalls[0]).toEqual({ limit: 30 });

    controller.openDay();
    await waitFor(() => state().day.status === 'ready');
    expect(state().view).toBe('day');
    expect(api.answeredOnCalls).toEqual(['2026-09-30']);
    // 画面で並べ直さない（デーモンが返した順のまま）。取り下げ済みも出る。
    expect(state().day.items.map((r) => r.id)).toEqual(['ap-a', 'ap-w']);
  });

  it('その日の件から既存の詳細を開け、Esc 相当（back）でその日へ戻る。日付から未回答の一覧へも戻れる', async () => {
    const { controller, state } = setup(fixture);
    controller.openDates();
    await waitFor(() => state().dates.status === 'ready');
    controller.openDay();
    await waitFor(() => state().day.status === 'ready');
    controller.moveDaySelection(1);
    controller.openDayItem();
    await waitFor(() => state().view === 'detail');
    expect(state().detail?.id).toBe('ap-w');
    expect(state().detail?.approval?.withdrawnReason).toBe('自分で答えを見つけた');

    controller.back();
    expect(state().view).toBe('day');
    expect(state().detail).toBeNull();
    // 選んでいた行は保たれる
    await waitFor(() => state().day.status === 'ready');
    expect(state().day.selected).toBe(1);

    controller.leaveDay();
    expect(state().view).toBe('dates');
    controller.leaveDates();
    expect(state().view).toBe('list');
  });

  it('未回答の一覧から開いた詳細は、今までどおり未回答の一覧へ戻る（既存の挙動を変えない）', async () => {
    const { controller, state } = setup((api) => {
      api.approvalRows = [approvalRow('ap-open')];
    });
    controller.enter();
    await waitFor(() => state().list.status === 'ready');
    controller.openSelected();
    await waitFor(() => state().view === 'detail');
    controller.back();
    expect(state().view).toBe('list');
  });

  it('日付の一覧がちょうど limit（30）件なら続きがあるかもしれないと持ち、loadMoreDates で古い側を足す', async () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 35 - i)).toISOString().slice(0, 10),
      count: 1,
    }));
    const { controller, state, api } = setup((a) => {
      a.answeredDateRows = rows;
    });
    controller.openDates();
    await waitFor(() => state().dates.status === 'ready');
    expect(state().dates.items).toHaveLength(30);
    expect(state().dates.maybeMore).toBe(true);

    await controller.loadMoreDates();
    expect(api.answeredDateCalls[1]).toEqual({ limit: 30, beforeDate: rows[29]!.date });
    expect(state().dates.items).toHaveLength(35);
    expect(state().dates.maybeMore).toBe(false);
    // 続きが無ければもう取りに行かない
    await controller.loadMoreDates();
    expect(api.answeredDateCalls).toHaveLength(2);
  });

  it('30 件に満たなければ続きは無いとする', async () => {
    const { controller, state } = setup(fixture);
    controller.openDates();
    await waitFor(() => state().dates.status === 'ready');
    expect(state().dates.maybeMore).toBe(false);
  });

  it('取得に失敗したのを 0 件にしない（初回は error・前の一覧は残す）', async () => {
    const { controller, state, api } = setup((a) => {
      a.answeredDatesFail = '接続できない';
    });
    controller.openDates();
    await waitFor(() => state().dates.status === 'error');
    expect(state().dates.items).toEqual([]);
    expect(state().dates.error).toContain('接続できない');

    api.answeredDatesFail = null;
    api.answeredDateRows = [{ date: '2026-09-30', count: 1 }];
    await controller.loadDates();
    expect(state().dates.status).toBe('ready');
    api.answeredDatesFail = '一瞬切れた';
    await controller.loadDates();
    // 再読み込みの失敗では、読めていた一覧を消さずに失敗を言う
    expect(state().dates.status).toBe('ready');
    expect(state().dates.items).toHaveLength(1);
    expect(state().dates.error).toContain('一瞬切れた');
  });

  it('その日の件の取得失敗も 0 件にしない（日付の形が不正な 400 の理由もそのまま）', async () => {
    const { controller, state } = setup((a) => {
      a.answeredDateRows = [{ date: '2026-09-30', count: 1 }];
      a.answeredOnFail = 'answeredOn は YYYY-MM-DD で指定する';
    });
    controller.openDates();
    await waitFor(() => state().dates.status === 'ready');
    controller.openDay();
    await waitFor(() => state().day.status === 'error');
    expect(state().day.items).toEqual([]);
    expect(state().day.error).toContain('YYYY-MM-DD');
  });
});
