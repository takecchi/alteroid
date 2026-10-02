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
