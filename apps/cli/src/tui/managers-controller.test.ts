import { describe, expect, it } from 'vitest';

import { fakeApi, gate, managerRow } from './fake-api.js';
import type { HeaderFeed } from './header-feed.js';
import { MANAGERS_PAGE, ManagersController } from './managers-controller.js';
import {
  detailStatusText,
  managerListLine,
  managerListTitle,
  managerNotes,
} from './managers-view.js';
import { waitFor } from './test-helpers.js';

function setup(configure: (api: ReturnType<typeof fakeApi>) => void = () => undefined) {
  const api = fakeApi();
  configure(api);
  const controller = new ManagersController(api, { debounceMs: 5 });
  let fire: (type: string) => void = () => undefined;
  const feed = {
    onEvent: (listener: (type: string) => void) => {
      fire = listener;
      return () => undefined;
    },
  } as unknown as HeaderFeed;
  controller.attach(feed);
  const state = () => controller.store.getSnapshot();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return { api, controller, state, fire: (t = 'exchange') => fire(t), sleep };
}

describe('一覧', () => {
  it('開いた時に 1 度だけ読み、以後は journal の出来事を合図に先頭から取り直す', async () => {
    const { api, controller, state, fire, sleep } = setup((a) => {
      a.managerRows = [managerRow('a'), managerRow('b')];
    });
    // 一度も開いていないあいだは、出来事が来ても読まない。
    fire();
    await sleep(30);
    expect(api.managerListCalls).toHaveLength(0);

    controller.enter();
    await sleep(10);
    controller.enter();
    expect(api.managerListCalls).toHaveLength(1);
    expect(state().list.items.map((m) => m.managerId)).toEqual(['a', 'b']);

    api.managerRows = [managerRow('c'), ...api.managerRows];
    fire();
    fire(); // 続けて届いても 1 回にまとまる
    await sleep(40);
    expect(api.managerListCalls).toHaveLength(2);
    expect(state().list.items.map((m) => m.managerId)).toEqual(['c', 'a', 'b']);
  });

  it('取り直しても選択は id で保つ。失敗しても前の一覧を残して理由を出す', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = [managerRow('a'), managerRow('b')];
    });
    controller.enter();
    await waitFor(() => state().list.status === 'ready');
    controller.moveSelection(1);
    api.managerRows = [managerRow('z'), ...api.managerRows];
    await controller.refreshList();
    expect(state().list.items[state().list.selected]?.managerId).toBe('b');

    api.managerListFails = '繋がらない';
    await controller.refreshList();
    expect(state().list.items).toHaveLength(3);
    expect(state().list.error).toBe('繋がらない');
    expect(state().list.status).toBe('ready');
  });

  it('頁がちょうどいっぱいなら続きが在りうる。読み足しの失敗は終端に見せず blocked にする', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = Array.from({ length: MANAGERS_PAGE }, (_, i) => managerRow(`m${String(i)}`));
    });
    await controller.loadList();
    expect(state().list.older).toBe('progress');
    api.managerListFails = '錨が見当たらない';
    await controller.loadOlder();
    expect(state().list.older).toBe('blocked');
    expect(state().list.items).toHaveLength(MANAGERS_PAGE);
    api.managerListFails = null;
    await controller.loadOlder();
    expect(state().list.older).toBe('end');
  });

  it('絞りを変えたあとに古い応答が戻っても反映しない', async () => {
    const { api, controller, state } = setup();
    const slow = gate();
    const original = api.listManagers.bind(api);
    let calls = 0;
    api.listManagers = async (query) => {
      calls += 1;
      if (calls === 1) await slow.wait;
      return original(query);
    };
    api.managerRows = [managerRow('r', { status: 'running' }), managerRow('d', { status: 'done' })];
    const first = controller.loadList(); // 絞りなし（遅い）
    controller.cycleFilter(); // running（速い）
    await waitFor(() => state().list.status === 'ready');
    slow.open();
    await first;
    expect(state().list.filter).toBe('running');
    expect(state().list.items.map((m) => m.managerId)).toEqual(['r']);
  });

  it('古い側を読んでいる最中に取り直しが走っても、読み込み中のまま止まらない', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = Array.from({ length: 60 }, (_, i) => managerRow(`m${String(100 - i)}`));
    });
    await controller.loadList();
    expect(state().list.older).toBe('progress');
    const slow = gate();
    const original = api.listManagers.bind(api);
    let first = true;
    api.listManagers = async (query) => {
      if (query.after !== undefined && first) {
        first = false;
        await slow.wait;
      }
      return original(query);
    };
    const pending = controller.loadOlder();
    await controller.refreshList(); // 読み足しの応答待ちの間に、journal の合図で取り直しが済む
    slow.open();
    await pending;
    expect(state().list.olderLoading).toBe(false);
    // 立ったままだと、ここでの読み足しが即 return して一覧が増えない。
    await controller.loadOlder();
    expect(state().list.items.length).toBeGreaterThan(MANAGERS_PAGE);
  });
});

describe('一覧の見出し', () => {
  it('初回の読み込みが失敗したときは、0 件と言わず「空ではない」と言う', async () => {
    const { api, controller, state } = setup();
    api.managerListFails = '繋がらない';
    await controller.loadList();
    expect(state().list.status).toBe('error');
    const title = managerListTitle(state().list);
    expect(title).toContain('空ではない');
    expect(title).not.toContain('0 件');
    api.managerListFails = null;
    await controller.loadList();
    expect(managerListTitle(state().list)).toContain('0 件読み込み済み');
  });
});

describe('詳細', () => {
  it('開くと状態と生ログを読む。journal の出来事で生ログを取り直し、戻ると詳細を捨てる', async () => {
    const { api, controller, state, fire, sleep } = setup((a) => {
      a.managerRows = [managerRow('a')];
      a.transcripts['a'] = JSON.stringify({ type: 'assistant', message: { content: 'ひとつめ' } });
    });
    controller.enter();
    await sleep(10);
    await controller.open('a');
    expect(state().view).toBe('detail');
    expect(state().detail?.transcript.map((e) => e.text)).toEqual(['ひとつめ']);

    api.transcripts['a'] +=
      `\n${JSON.stringify({ type: 'assistant', message: { content: 'ふたつめ' } })}`;
    fire();
    await sleep(40);
    expect(state().detail?.transcript.map((e) => e.text)).toEqual(['ひとつめ', 'ふたつめ']);

    controller.back();
    expect(state().view).toBe('list');
    expect(state().detail).toBeNull();
  });

  it('生ログが無い（404）なら none、取れなかったら error（空とは言わない）', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = [managerRow('a')];
    });
    await controller.open('a');
    expect(state().detail?.transcriptStatus).toBe('none');
    api.readManagerTranscript = () => Promise.reject(new Error('壊れている'));
    await controller.refreshDetail();
    expect(state().detail?.transcriptStatus).toBe('error');
    expect(state().detail?.error).toContain('壊れている');
  });

  it('居ない id は missing', async () => {
    const { controller, state } = setup();
    await controller.open('nope');
    expect(state().detail?.missing).toBe(true);
  });

  it('追加指示は宛先と本文だけを送り、結果をそのまま出す。失敗は ✗ で出す', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = [managerRow('a')];
    });
    await controller.open('a');
    await controller.sendMessage('やって');
    expect(api.managerMessages).toEqual([{ id: 'a', text: 'やって' }]);
    expect(state().detail?.notice).toBe('delivered: 追加指示として届けた。');
    api.sendManagerMessage = () => Promise.reject(new Error('送れない'));
    await controller.sendMessage('もう一度');
    expect(state().detail?.notice).toBe('✗ 送れない');
  });

  it('停止は askStop → confirmStop の順でしか呼ばれない', async () => {
    const { api, controller, state } = setup((a) => {
      a.managerRows = [managerRow('a')];
    });
    await controller.open('a');
    await controller.confirmStop(); // 確認なしでは何も起きない
    expect(api.stoppedManagers).toEqual([]);
    controller.askStop();
    controller.cancelStop();
    await controller.confirmStop();
    expect(api.stoppedManagers).toEqual([]);
    controller.askStop();
    await controller.confirmStop();
    expect(api.stoppedManagers).toEqual(['a']);
    expect(state().detail?.confirmStop).toBe(false);
  });
});

describe('表示の文言', () => {
  it('一覧の 1 行は依頼を抜粋にし、状態は core の字面（接続の有無まで）を使う', () => {
    const line = managerListLine(
      managerRow('mgr-1234567890abcdef', { live: false, request: `長い\n依頼${'あ'.repeat(300)}` }),
      Date.now(),
    );
    expect(line).toContain('[running/セッション切断]');
    expect(line).toContain('mgr-12345678…');
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(200);
  });

  it('注記は観測した分だけ言い、lost を失敗と断定しない', () => {
    const notes = managerNotes(
      managerRow('a', {
        status: 'lost',
        waiting: [{ requestId: 'r', summary: '許可して', kind: 'permission' }],
      }),
    );
    expect(notes[0]).toContain('返事待ち 1 件');
    expect(notes.join(' ')).toContain('成果がリモートまで届いていることがある');
  });

  it('最下行の優先順は 確認 > 操作結果 > 失敗 > 窓の外', () => {
    const base = {
      id: 'a',
      manager: null,
      missing: false,
      transcript: [],
      transcriptStatus: 'ready' as const,
      error: null,
      busy: false,
      notice: null,
      confirmStop: false,
      loadedAt: 0,
    };
    expect(detailStatusText({ ...base, confirmStop: true, notice: 'n' }, 3).text).toContain(
      '止める?',
    );
    expect(detailStatusText({ ...base, notice: 'n', error: 'e' }, 3).text).toBe('n');
    expect(detailStatusText({ ...base, error: 'e' }, 3).text).toContain('e');
    expect(detailStatusText(base, 3).text).toContain('あと 3 行');
    expect(detailStatusText(base, 0).text).toBe(' ');
  });
});

describe('切り詰めはサロゲートペアを割らない（#2592）', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

  it('一覧の依頼と、注記の返事待ちの要約', () => {
    const emoji = `a${'😀'.repeat(400)}`;
    expect(managerListLine(managerRow('a', { request: emoji }), Date.now())).not.toMatch(lone);
    const notes = managerNotes(
      managerRow('a', { waiting: [{ requestId: 'r', summary: emoji, kind: 'permission' }] }),
    );
    expect(notes.join(' ')).not.toMatch(lone);
  });
});
