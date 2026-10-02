import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.js';
import { ChatController } from './chat-controller.js';
import { fakeApi, gate, managerRow, type FakeApi } from './fake-api.js';
import { HeaderFeed } from './header-feed.js';
import { ManagersController } from './managers-controller.js';
import { renderFullscreen, type FakeStdin, type } from './test-helpers.js';
import { waitFor } from './test-helpers.js';

/**
 * 画面の試験。Ink 本体に寸法固定の偽の stdout / stdin を渡して、起動 → 入力 → 送信 →
 * 応答の描画までを通す。API は偽物（`fake-api.ts`）— デーモンには繋がない。
 */
const ENTER = '\r';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const ESC = '\x1b';

interface Harness {
  api: FakeApi;
  controller: ChatController;
  feed: HeaderFeed;
  managers: ManagersController;
  stdin: FakeStdin;
  frame: () => string;
  unmount: () => void;
  exited: () => boolean;
}

const mounted: Harness[] = [];
afterEach(() => {
  for (const h of mounted.splice(0)) {
    h.managers.dispose();
    h.feed.stop();
    h.unmount();
  }
});

function start(
  setup: (api: FakeApi) => void = () => undefined,
  size: { rows?: number; columns?: number; fullscreen?: boolean } = {},
): Harness {
  const api = fakeApi();
  setup(api);
  const controller = new ChatController(api);
  const feed = new HeaderFeed(api, { retryBaseMs: 1_000_000 });
  const managers = new ManagersController(api, { debounceMs: 10 });
  managers.attach(feed);
  feed.start();
  const { app, stdin, lastFrame } = renderFullscreen(
    createElement(App, { api, controller, feed, managers, fullscreen: size.fullscreen ?? true }),
    size.rows ?? 24,
    size.columns ?? 80,
  );
  let exited = false;
  void app.waitUntilExit().then(() => {
    exited = true;
  });
  const harness: Harness = {
    api,
    controller,
    feed,
    managers,
    stdin,
    frame: lastFrame,
    unmount: () => app.unmount(),
    exited: () => exited,
  };
  mounted.push(harness);
  return harness;
}

describe('画面の骨組み', () => {
  it('ヘッダ（接続先・承認待ち・実行中の委譲）、タブ、フッタが出る', async () => {
    const h = start((api) => {
      api.counts = { pendingApprovals: 3, runningManagers: 2 };
    });
    await waitFor(() => h.frame().includes('承認待ち 3'));
    const frame = h.frame();
    expect(frame).toContain('http://127.0.0.1:4517');
    expect(frame).toContain('承認待ち 3');
    expect(frame).toContain('実行中の委譲 2');
    for (const label of ['1 会話', '2 承認待ち', '3 委譲', '4 日誌', '5 記憶']) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain('^D 終了');
  });

  it('全画面では端末の行数ぶんに収まる（はみ出さない）', async () => {
    const h = start(undefined, { rows: 20 });
    await waitFor(() => h.frame().includes('Ctrl+D'));
    expect(h.frame().split('\n').length).toBeLessThanOrEqual(20);
  });

  it('承認待ち・日誌・記憶のタブは「次の段階で実装」。Esc で入力欄を抜けて数字で移り、1 で会話へ戻る', async () => {
    const h = start();
    await waitFor(() => h.frame().includes('メッセージ'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('2');
    await waitFor(() => h.frame().includes('承認待ち: 次の段階で実装'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌: 次の段階で実装'));
    h.stdin.write('1');
    await waitFor(() => h.frame().includes('メッセージ'));
    expect(h.frame()).not.toContain('次の段階で実装');
  });

  it('入力欄の外から / を打つと会話へ戻ってコマンドを書き始められる', async () => {
    const h = start();
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌: 次の段階で実装'));
    h.stdin.write('/');
    await waitFor(() => h.frame().includes('❯ /'));
    await type(h.stdin, 'approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('承認待ち: 次の段階で実装'));
  });
});

describe('会話', () => {
  it('入力 → 送信 → 応答（Markdown 整形）が描かれる。会話 id を引き継ぐ', async () => {
    const h = start((api) => {
      api.scripts.push([
        { type: 'open', conversationId: 'c1' },
        { type: 'thinking' },
        { type: 'text', text: 'こんにちは。**太字**です' },
        { type: 'done' },
      ]);
    });
    await waitFor(() => h.frame().includes('メッセージ'));
    await type(h.stdin, 'やあ');
    await waitFor(() => h.frame().includes('❯ やあ'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('こんにちは。太字です'));
    const frame = h.frame();
    expect(frame).toContain('❯ やあ');
    expect(frame).toContain('  こんにちは。太字です'); // ** が整形されて消えている
    expect(frame).not.toContain('**');
    expect(h.api.chatCalls).toEqual([{ text: 'やあ' }]);
    await waitFor(() => h.controller.store.getSnapshot().conversationId === 'c1');
    expect(h.controller.store.getSnapshot().busy).toBe(false);
  });

  it('応答を待っているあいだ「考えている…」を出す', async () => {
    const g = gate();
    const h = start((api) => {
      api.scripts.push([{ type: 'open', conversationId: 'c1' }, g.wait, { type: 'done' }]);
    });
    await type(h.stdin, 'x');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('考えている…'));
    expect(h.frame()).toContain('応答中…');
    g.open();
    await waitFor(() => !h.frame().includes('考えている…'));
  });

  it('ask_human は会話の中に目立つ形で出て、承認待ちの id・質問・答え方を示す', async () => {
    const h = start((api) => {
      api.scripts.push([
        { type: 'open', conversationId: 'c1' },
        { type: 'ask_human', approvalId: 'ap-42', question: 'デプロイしてよいですか' },
        { type: 'done' },
      ]);
    });
    await type(h.stdin, 'デプロイして');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('ap-42'));
    const frame = h.frame();
    expect(frame).toContain('? 確認したいことがある（承認待ち ap-42）');
    expect(frame).toContain('デプロイしてよいですか');
    expect(frame).toContain('/answer ap-42');
  });

  it('エラーは ✗ の行として残る', async () => {
    const h = start((api) => {
      api.scripts.push([
        { type: 'open', conversationId: 'c1' },
        { type: 'error', message: '失敗した' },
      ]);
    });
    await type(h.stdin, 'x');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('✗ 失敗した'));
  });

  it('未知のコマンドはクローンへ送らず案内を出す。// で始めれば / 付きの文を送れる', async () => {
    const h = start((api) => {
      api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    });
    await type(h.stdin, '/exti');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('不明なコマンド: /exti'));
    expect(h.api.chatCalls).toEqual([]);
    await type(h.stdin, '//exit は終了です');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.chatCalls.length === 1);
    expect(h.api.chatCalls[0]?.text).toBe('/exit は終了です');
  });

  it('Shift+Enter（modifyOtherKeys）と行末の \\ で改行でき、送らない', async () => {
    const h = start();
    await type(h.stdin, 'a');
    h.stdin.write('\x1b[27;2;13~');
    await type(h.stdin, 'b\\');
    h.stdin.write(ENTER);
    await type(h.stdin, 'c');
    await waitFor(() => h.frame().includes('  c'));
    expect(h.api.chatCalls).toEqual([]);
    const lines = h.frame().split('\n');
    const first = lines.findIndex((l) => l.includes('❯ a'));
    expect(lines[first + 1]).toContain('b');
    expect(lines[first + 2]).toContain('c');
  });

  it('全角スペースも文字として入る', async () => {
    const h = start();
    await type(h.stdin, 'あ');
    h.stdin.write('　');
    await type(h.stdin, 'い');
    await waitFor(() => h.frame().includes('あ　い'));
  });

  it('長い日本語は入力欄で折り返される（見えなくならない）', async () => {
    const h = start(undefined, { columns: 40 });
    await type(h.stdin, 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ');
    await waitFor(() => h.frame().includes('ほ'));
    const rows = h
      .frame()
      .split('\n')
      .filter((l) => /[あ-ん]/.test(l));
    expect(rows.length).toBeGreaterThan(1);
  });

  it('長い応答は可視窓だけを描き、PgUp で遡ると「あと N 行」が出て、PgDn で追従に戻る', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `行${String(i).padStart(2, '0')}`).join(
      '\n\n',
    );
    const h = start(
      (api) => {
        api.scripts.push([
          { type: 'open', conversationId: 'c1' },
          { type: 'text', text: lines },
          { type: 'done' },
        ]);
      },
      { rows: 24 },
    );
    await type(h.stdin, 'x');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('行59'));
    expect(h.frame()).not.toContain('行00'); // 先頭は窓の外（全部は描かない）
    h.stdin.write('\x1b[5~'); // PageUp
    await waitFor(() => h.frame().includes('あと'));
    expect(h.frame()).not.toContain('行59');
    h.stdin.write('\x1b[6~'); // PageDown ×（戻りきるまで）
    h.stdin.write('\x1b[6~');
    h.stdin.write('\x1b[6~');
    h.stdin.write('\x1b[6~');
    await waitFor(() => h.frame().includes('行59'));
    expect(h.frame()).not.toContain('あと');
  });
});

describe('中断・履歴・終了', () => {
  it('Ctrl+C は終了ではなく中断（POST /clone/interrupt）で、結果が会話に出る', async () => {
    const h = start();
    h.stdin.write(CTRL_C);
    await waitFor(() => h.frame().includes('ターンを止めた'));
    expect(h.api.interrupts).toBe(1);
    expect(h.exited()).toBe(false);
  });

  it('/conversations で履歴を選び、開き直した会話から続けて話せる', async () => {
    const h = start((api) => {
      api.conversations = [
        {
          conversationId: 'c-new',
          startedAt: 's',
          updatedAt: new Date().toISOString(),
          messages: 4,
          preview: '新しい方の話',
        },
        {
          conversationId: 'c-old',
          startedAt: 's',
          updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
          messages: 2,
          preview: '古い方の話',
        },
      ];
      api.messages['c-old'] = [
        { id: '1', at: 't', role: 'inbound', text: '昔の質問' },
        { id: '2', at: 't', role: 'outbound', text: '昔の答え' },
      ];
      api.scripts.push([{ type: 'open', conversationId: 'c-old' }, { type: 'done' }]);
    });
    await type(h.stdin, '/conversations');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話の履歴（2 件）'));
    expect(h.frame()).toContain('新しい方の話');
    expect(h.frame()).toContain('古い方の話');
    h.stdin.write('\x1b[B'); // ↓
    await waitFor(
      () =>
        h.frame().includes('❯') &&
        h
          .frame()
          .split('\n')
          .some((l) => l.includes('❯') && l.includes('古い方の話')),
    );
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('昔の答え'));
    expect(h.frame()).toContain('❯ 昔の質問');
    await type(h.stdin, '続き');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.chatCalls.length === 1);
    expect(h.api.chatCalls[0]).toEqual({ text: '続き', conversationId: 'c-old' });
  });

  it('履歴の選択は Esc で閉じる', async () => {
    const h = start((api) => {
      api.conversations = [];
    });
    await type(h.stdin, '/history');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話はまだありません'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('メッセージ'));
  });

  it('/end で会話を終える（POST /chat/{id}/end）', async () => {
    const h = start((api) => {
      api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    });
    await type(h.stdin, 'x');
    h.stdin.write(ENTER);
    await waitFor(() => h.controller.store.getSnapshot().conversationId === 'c1');
    await type(h.stdin, '/end');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話を終えた'));
    expect(h.api.ended).toEqual(['c1']);
  });

  it('/exit と、入力欄が空のときの Ctrl+D で終了する。会話があれば終える', async () => {
    const h = start((api) => {
      api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    });
    await type(h.stdin, 'x');
    h.stdin.write(ENTER);
    await waitFor(() => h.controller.store.getSnapshot().conversationId === 'c1');
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
    expect(h.api.ended).toEqual(['c1']);

    const h2 = start();
    await type(h2.stdin, '/exit');
    h2.stdin.write(ENTER);
    await waitFor(() => h2.exited());
    expect(h2.exited()).toBe(true);
  });

  it('入力欄に書きかけがあるときの Ctrl+D では終了しない（書きかけを捨てない）', async () => {
    const h = start();
    await type(h.stdin, 'ab');
    h.stdin.write(CTRL_D);
    // 実時間で待たずに（#2146）、Ctrl+D の後ろに 1 文字打って、それが描かれるのを待つ。
    // キーは届いた順に処理されるので、Ctrl+D で終了していればこの 1 文字は描かれない。
    h.stdin.write('c');
    await waitFor(() => h.frame().includes('❯ abc'));
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('❯ abc');
  });
});

describe('委譲（マネージャーの一覧と詳細）', () => {
  const jsonl = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n');
  const assistant = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  function managersFixture(api: FakeApi): void {
    api.managerRows = [
      managerRow('mgr-new', {
        request: '新しい方の依頼',
        startedAt: '2026-10-02T02:00:00.000Z',
        updatedAt: new Date().toISOString(),
        waiting: [{ requestId: 'r1', summary: 'デプロイしてよいか', kind: 'question' }],
      }),
      managerRow('mgr-old', {
        status: 'done',
        request: '古い方の依頼',
        startedAt: '2026-10-02T01:00:00.000Z',
        updatedAt: new Date().toISOString(),
      }),
    ];
    api.transcripts['mgr-old'] = jsonl(
      { type: 'user', message: { role: 'user', content: '古い依頼を頼む' } },
      assistant('古い方の作業を終えた'),
    );
  }

  async function openList(h: Harness): Promise<void> {
    await type(h.stdin, '/managers');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('委譲（絞り: すべて'));
  }

  it('一覧（1 件 1 行）→ 選んで詳細（生ログ）→ 追加指示を送る → Esc で一覧へ戻る', async () => {
    const h = start(managersFixture);
    await openList(h);
    const list = h.frame();
    expect(list).toContain('[running] mgr-new');
    expect(list).toContain('⏸確認待ち1');
    expect(list).toContain('新しい方の依頼');
    expect(list).toContain('[done] mgr-old');
    expect(list).toContain('これより古い委譲は無い（全 2 件）');
    expect(list).not.toContain('古い依頼を頼む'); // 一覧に中身は載せない

    h.stdin.write('\x1b[B'); // ↓
    await waitFor(() =>
      h
        .frame()
        .split('\n')
        .some((l) => l.includes('❯') && l.includes('mgr-old')),
    );
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('古い方の作業を終えた'));
    const detail = h.frame();
    expect(detail).toContain('[done] mgr-old');
    expect(detail).toContain('依頼: 古い方の依頼');
    expect(detail).toContain('❯ 古い依頼を頼む');

    h.stdin.write('i');
    await type(h.stdin, '続きをお願い');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('delivered: 追加指示として届けた。'));
    expect(h.api.managerMessages).toEqual([{ id: 'mgr-old', text: '続きをお願い' }]);
    expect(h.api.chatCalls).toEqual([]); // クローンへは送らない

    h.stdin.write(ESC); // 入力欄を抜ける
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write(ESC); // 一覧へ
    await waitFor(() => h.frame().includes('委譲（絞り: すべて'));
    expect(h.frame()).toContain('新しい方の依頼');
  });

  it('詳細の入力欄でもスラッシュコマンドが効く。// で始めれば / 付きの追加指示を送れる', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '/exti');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('不明なコマンド: /exti'));
    expect(h.api.managerMessages).toEqual([]);
    await type(h.stdin, '//stop ではなく文');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.managerMessages.length === 1);
    expect(h.api.managerMessages[0]?.text).toBe('/stop ではなく文');
    await type(h.stdin, '/chat');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('メッセージ'));
  });

  it('止めるには確認を挟む。y 以外では止めない', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('s');
    await waitFor(() => h.frame().includes('このマネージャーを止める?'));
    h.stdin.write('n');
    await waitFor(() => !h.frame().includes('このマネージャーを止める?'));
    expect(h.api.stoppedManagers).toEqual([]);

    h.stdin.write('s');
    await waitFor(() => h.frame().includes('y で止める'));
    h.stdin.write('y');
    await waitFor(() => h.frame().includes('stopped: 止まったと確かめた。'));
    expect(h.api.stoppedManagers).toEqual(['mgr-new']);
  });

  it('止める結果は読み替えない（not_stopped を「止めた」と言わない）', async () => {
    const h = start((api) => {
      managersFixture(api);
      api.stopResult = { outcome: 'not_stopped', detail: 'セッションがまだ在る。' };
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('s');
    h.stdin.write('y');
    await waitFor(() => h.frame().includes('not_stopped: セッションがまだ在る。'));
    expect(h.frame()).toContain('not_stopped: セッションがまだ在る。');
    expect(h.frame()).not.toContain('stopped: 止まった');
  });

  it('f で状態を絞り、絞った 0 件は「居ない」ではなく絞りの案内になる', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write('f'); // 実行中
    await waitFor(() => h.frame().includes('絞り: 実行中'));
    expect(h.api.managerListCalls.at(-1)).toEqual({ status: ['running'], limit: 50 });
    expect(h.frame()).toContain('mgr-new');
    expect(h.frame()).not.toContain('mgr-old');
    h.stdin.write('f'); // 人間待ち（0 件）
    await waitFor(() => h.frame().includes('絞り: 人間待ち'));
    await waitFor(() => h.frame().includes('この状態のマネージャーは無い'));
    expect(h.frame()).toContain('この状態のマネージャーは無い');
    expect(h.frame()).not.toContain('まだ1体も起きていない');
  });

  it('50 件の頁を超える一覧は m で古い側を読み足す。読めない行は「居ない」と分けて言う', async () => {
    const h = start((api) => {
      api.managerRows = Array.from({ length: 60 }, (_, i) =>
        managerRow(`mgr-${String(100 - i)}`, { request: `依頼${String(i)}` }),
      );
      api.unreadableManagers = [{ id: 'mgr-broken', reason: 'status' }];
    });
    await openList(h);
    expect(h.frame()).toContain('50 件読み込み済み');
    expect(h.frame()).toContain('m で古い側をもっと見る（いま 50 件）');
    expect(h.frame()).toContain('読めない委譲が 1 件ある');
    h.stdin.write('m');
    await waitFor(() => h.frame().includes('60 件読み込み済み'));
    expect(h.api.managerListCalls.at(-1)?.after).toEqual({
      managerId: 'mgr-51',
      startedAt: '2026-10-02T00:00:00.000Z',
    });
    h.stdin.write('\x1b[B'.repeat(59));
    await waitFor(() => h.frame().includes('これより古い委譲は無い（全 60 件）'));
    expect(h.frame()).toContain('これより古い委譲は無い（全 60 件）');
  });

  it('長い生ログは可視窓だけを描き、PgUp で遡り、PgDn で末尾追従に戻る', async () => {
    const h = start((api) => {
      api.managerRows = [managerRow('mgr-long')];
      api.transcripts['mgr-long'] = jsonl(
        ...Array.from({ length: 200 }, (_, i) => assistant(`発言${String(i).padStart(3, '0')}`)),
      );
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('発言199'));
    expect(h.frame()).not.toContain('発言000');
    h.stdin.write('\x1b[5~');
    await waitFor(() => h.frame().includes('あと'));
    expect(h.frame()).not.toContain('発言199');
    for (let i = 0; i < 40; i += 1) h.stdin.write('\x1b[6~');
    await waitFor(() => h.frame().includes('発言199'));
    expect(h.frame()).not.toContain('↓ あと');
  });

  it('生ログがまだ無い委譲は、空とは言わず「まだ無い」と出す', async () => {
    const h = start((api) => {
      api.managerRows = [managerRow('mgr-fresh')];
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('生ログはまだ無い'));
    expect(h.frame()).toContain('生ログはまだ無い');
  });

  it('詳細の入力欄に書きかけがあるときの Ctrl+D では終了しない', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, 'ab');
    h.stdin.write(CTRL_D);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('❯ ab');
  });
});
