import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.js';
import { ChatController } from './chat-controller.js';
import {
  fakeApi,
  gate,
  journalEntry,
  managerRow,
  memoryDoc,
  memoryRow,
  minute,
  said,
  type FakeApi,
} from './fake-api.js';
import { HeaderFeed } from './header-feed.js';
import { JournalController } from './journal-controller.js';
import { ManagersController } from './managers-controller.js';
import { MemoryController } from './memory-controller.js';
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
  journal: JournalController;
  memory: MemoryController;
  stdin: FakeStdin;
  frame: () => string;
  unmount: () => void;
  exited: () => boolean;
}

const mounted: Harness[] = [];
afterEach(() => {
  for (const h of mounted.splice(0)) {
    h.managers.dispose();
    h.journal.dispose();
    h.memory.dispose();
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
  const journal = new JournalController(api);
  journal.attach(feed);
  const memory = new MemoryController(api, { debounceMs: 10 });
  memory.attach(feed);
  feed.start();
  const { app, stdin, lastFrame } = renderFullscreen(
    createElement(App, {
      api,
      controller,
      feed,
      managers,
      journal,
      memory,
      fullscreen: size.fullscreen ?? true,
    }),
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
    journal,
    memory,
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

  it('承認待ちのタブはまだ「次の段階で実装」。Esc で入力欄を抜けて数字で移り、1 で会話へ戻る', async () => {
    const h = start();
    await waitFor(() => h.frame().includes('メッセージ'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('2');
    await waitFor(() => h.frame().includes('承認待ち: 次の段階で実装'));
    h.stdin.write('1');
    await waitFor(() => h.frame().includes('メッセージ'));
    expect(h.frame()).not.toContain('次の段階で実装');
  });

  it('入力欄の外から / を打つと会話へ戻ってコマンドを書き始められる', async () => {
    const h = start();
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('2');
    await waitFor(() => h.frame().includes('承認待ち: 次の段階で実装'));
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
    // 実時間で待たず、Ctrl+D の後ろに 1 文字打って描かれるのを待つ（#2146。上の同形のテストと同じ）。
    h.stdin.write('c');
    await waitFor(() => h.frame().includes('❯ abc'));
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('❯ abc');
  });
});

describe('日誌（ライブで流れる一覧と全文）', () => {
  const UP = '\x1b[A';
  const DOWN = '\x1b[B';
  const PGUP = '\x1b[5~';

  /** 新しい順（`n` 分目が大きいほど新しい）。 */
  const entries = (to: number, from = 1) =>
    Array.from({ length: to - from + 1 }, (_, i) => said(to - i));

  async function openJournal(h: Harness): Promise<void> {
    await type(h.stdin, '/journal');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('日誌（絞り:'));
  }

  it('/journal で直近を読み、1 件 1 行（時刻・種別・要旨）で出す。量の多い種別も Web と同じく隠さない', async () => {
    const h = start((api) => {
      api.journalEntries = [
        journalEntry('t1', 'turn_usage', minute(3), {
          layer: 'clone',
          site: 'chat',
          managerId: 'm',
          models: { opus: { costUsd: 0.5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } },
        }),
        journalEntry('d1', 'decision', minute(2), { decision: '進める', grounds: '前例がある' }),
        said(1, '最初の発言'),
      ];
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('最初の発言'));
    const frame = h.frame();
    expect(frame).toContain('[exchange] human ← 最初の発言');
    expect(frame).toContain('[decision] 進める（根拠: 前例がある）');
    expect(frame).toContain('[turn_usage]');
    expect(frame).toContain('これより古い記録は無い（全 3 件）');
    expect(h.api.journalListCalls).toEqual([{ limit: 100, types: [], q: '', horizon: true }]);
    // 古い→新しい。末尾が最新。
    expect(frame.indexOf('最初の発言')).toBeLessThan(frame.indexOf('[decision]'));
    expect(frame.indexOf('[decision]')).toBeLessThan(frame.indexOf('[turn_usage]'));
    // フッタのヒント。
    expect(frame).toContain('Enter 全文');
    expect(frame).toContain('f 種別');
  });

  it('ヘッダが張っている 1 本の SSE の新着が流れ、末尾に追従する', async () => {
    const live = gate();
    const h = start((api) => {
      api.journalEntries = entries(2);
      api.journal.push({
        events: ['open', live.wait, { type: 'exchange', entry: said(9, '流れてきた') }],
      });
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('● 末尾に追従中'));
    expect(h.frame()).not.toContain('流れてきた');
    live.open();
    await waitFor(() => h.frame().includes('流れてきた'));
    expect(h.frame()).toContain('● 末尾に追従中');
    expect(h.api.journalListCalls).toHaveLength(1); // 新着は取り直さず、SSE の本体を使う
  });

  it('上へ遡っている間は位置を止める。新着が来ても動かず、n で最新へ戻って追従する', async () => {
    const live = gate();
    const h = start(
      (api) => {
        api.journalEntries = entries(40);
        api.journal.push({
          events: ['open', live.wait, { type: 'exchange', entry: said(99, '遅れて届いた') }],
        });
      },
      { rows: 24 },
    );
    await openJournal(h);
    await waitFor(() => h.frame().includes('発言40'));
    // 可視窓だけを描く: 古い行は画面に無い。
    expect(h.frame()).not.toContain('発言1 ');
    expect(h.frame().split('\n').length).toBeLessThanOrEqual(24);

    // 半画面ずつ 2 回上がる（最新から 20 件。近いうちは窓が末尾に掛かったままなので、十分に遡る）。
    h.stdin.write(PGUP);
    h.stdin.write(PGUP);
    await waitFor(() => h.frame().includes('位置を止めている（新しい側にあと 20 件'));
    live.open();
    // 新着は届いているが、読んでいる位置は動かない。
    await waitFor(() => h.journal.store.getSnapshot().entries.length === 41);
    h.stdin.write(UP); // 後ろに 1 つ入力を送り、それが描かれるのを待つ
    await waitFor(() => h.frame().includes('位置を止めている（新しい側にあと 22 件'));
    expect(h.frame()).not.toContain('遅れて届いた');

    h.stdin.write('n');
    await waitFor(() => h.frame().includes('● 末尾に追従中'));
    expect(h.frame()).toContain('遅れて届いた');
  });

  it('先頭まで上がると古い側を自動で読み足す（until）', async () => {
    const h = start((api) => {
      api.journalEntries = entries(150);
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('古い側はまだ在る'));
    h.stdin.write(PGUP);
    // 100 件の先頭（最古）まで一気に上がる。
    for (let i = 0; i < 12; i += 1) h.stdin.write(PGUP);
    await waitFor(() => h.api.journalListCalls.length === 2);
    expect(h.api.journalListCalls[1]).toMatchObject({ until: minute(51) });
    await waitFor(() => h.journal.store.getSnapshot().entries.length === 150);
    await waitFor(() => h.frame().includes('これより古い記録は無い（全 150 件）'));
  });

  it('Enter で 1 件の全文を開き、Esc で一覧へ戻る（PgDn で読み進められる）', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `長い本文の${String(i)}行目`).join('\n');
    const h = start((api) => {
      api.journalEntries = [said(2, long), said(1, '短い発言')];
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('短い発言'));
    h.stdin.write(ENTER); // 選択は最新（長い方）
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    const detail = h.frame();
    expect(detail).toContain('[exchange] e2');
    expect(detail).toContain('長い本文の0行目'); // 頭から読む
    expect(detail).not.toContain('長い本文の59行目');
    expect(detail).toContain('↓ あと');
    for (let i = 0; i < 12; i += 1) h.stdin.write('\x1b[6~');
    await waitFor(() => h.frame().includes('長い本文の59行目'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    expect(h.frame()).toContain('短い発言');
  });

  it('f で種別を選んで絞る。サーバへ type を投げ、絞った結果の 0 件は「何も無い」と言わない', async () => {
    const h = start((api) => {
      api.journalEntries = [
        journalEntry('d1', 'decision', minute(2), { decision: '進める', grounds: 'a' }),
        said(1, '雑談'),
      ];
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('雑談'));
    h.stdin.write('f');
    await waitFor(() => h.frame().includes('種別で絞り込む'));
    expect(h.frame()).toContain('[ ] turn_usage'); // 13 種すべてが選べる
    h.stdin.write(DOWN); // decision
    h.stdin.write(' ');
    await waitFor(() => h.frame().includes('[x] decision'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('絞り: type=decision'));
    await waitFor(() => !h.frame().includes('雑談'));
    expect(h.api.journalListCalls.at(-1)).toMatchObject({ types: ['decision'] });
    expect(h.frame()).toContain('[decision] 進める');

    // tool_use に絞ると 0 件 → 絞り込みを外せば見えるかもしれないと言う。
    h.stdin.write('f');
    await waitFor(() => h.frame().includes('種別で絞り込む'));
    h.stdin.write('c'); // 全部外す（今は decision だけが選ばれている）
    await waitFor(() => !h.frame().includes('[x] decision'));
    for (let i = 0; i < 3; i += 1) h.stdin.write(DOWN); // tool_use
    h.stdin.write(' ');
    await waitFor(() => h.frame().includes('[x] tool_use'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('type=tool_use に当たる記録は無い'));
    expect(h.frame()).toContain('絞り込みを外せば見えるかもしれない');
    expect(h.frame()).not.toContain('何も記録されていない');
  });

  it('Esc で種別の選択をやめると、絞りは変わらない', async () => {
    const h = start((api) => {
      api.journalEntries = [said(1, '雑談')];
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('雑談'));
    h.stdin.write('f');
    await waitFor(() => h.frame().includes('種別で絞り込む'));
    h.stdin.write(' ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('日誌（絞り: すべて'));
    expect(h.api.journalListCalls).toHaveLength(1);
  });

  it('/journal type=… q=… [件数] は CLI /journal と同じ解き方で絞る。知らない種別は問い合わせる前に断る', async () => {
    const h = start((api) => {
      api.journalEntries = [
        journalEntry('d1', 'decision', minute(2), { decision: 'やめる', grounds: 'a' }),
        said(1, '雑談'),
      ];
    });
    await type(h.stdin, '/journal 50 type=decision,escalation q=や め');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('type=decision,escalation'));
    expect(h.api.journalListCalls).toEqual([
      { limit: 50, types: ['decision', 'escalation'], q: 'や め', horizon: true },
    ]);

    h.stdin.write(ESC); // 一覧の画面は入力欄を持たない。/ で会話へ戻ってコマンドを打つ。
    await type(h.stdin, '/');
    await type(h.stdin, 'journal type=bogus');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('type= に知らない値が入っています: bogus'));
    expect(h.api.journalListCalls).toHaveLength(1); // 撃っていない
  });

  it('取れなかったのを空と描かない', async () => {
    const h = start((api) => {
      api.journalListFails = '繋がらない';
    });
    await type(h.stdin, '/journal');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('日誌を読めなかった（空ではない）: 繋がらない'));
    expect(h.frame()).not.toContain('何も記録されていない');
  });

  it('ライブ接続が切れていれば、そう言う', async () => {
    const h = start((api) => {
      api.journalEntries = [said(1, '雑談')];
      api.journal.push({ events: ['open', new Error('切れた')] });
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('ライブ切断'));
    expect(h.frame()).toContain('ライブ切断（再接続中）');
  });

  it('日誌のタブでも Ctrl+D で終了できる', async () => {
    const h = start();
    await openJournal(h);
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
  });
});

describe('記憶（一覧と詳細。読むだけ）', () => {
  async function openMemory(h: Harness): Promise<void> {
    await type(h.stdin, '/memory');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('記憶（'));
  }

  const fixture = (api: FakeApi): void => {
    api.memoryRows = [
      memoryRow('persona', {
        title: '人となり',
        kind: 'premise',
        description: '判断の前提となる価値観',
        descriptionFreshness: {
          kind: 'stale',
          staleForMs: 3 * 86_400_000,
          drift: { kind: 'unrecorded' },
        },
      }),
      memoryRow('deploy', { title: 'デプロイの手順', description: '本番へ出す前の確認' }),
    ];
    api.memoryDocs['deploy'] = memoryDoc('deploy', '# デプロイ\n\n- 本番の前に **確認** する');
  };

  it('/memory で一覧（タイトルと要旨だけ）。本文は載せない。要旨の印は要旨の前', async () => {
    const h = start(fixture, { columns: 120 });
    await openMemory(h);
    await waitFor(() => h.frame().includes('デプロイの手順'));
    const frame = h.frame();
    expect(frame).toContain('[premise] 人となり  persona');
    expect(frame).toContain('要旨は本文より');
    expect(frame).toContain('判断の前提となる価値観');
    expect(frame).toContain('[fact] デプロイの手順  deploy');
    expect(frame).toContain('2.0 KB');
    expect(frame).not.toContain('本番の前に'); // 本文は詳細で読む
    expect(frame).toContain('読むだけ');
    expect(h.api.readMemoryCalls).toEqual([]);
  });

  it('Enter で本文（Markdown）を読み、Esc で一覧へ戻る。編集・削除の口は無い', async () => {
    const h = start(fixture);
    await openMemory(h);
    await waitFor(() => h.frame().includes('デプロイの手順'));
    h.stdin.write('\x1b[B');
    await waitFor(() =>
      h
        .frame()
        .split('\n')
        .some((l) => l.includes('❯') && l.includes('デプロイの手順')),
    );
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('本番の前に'));
    const detail = h.frame();
    expect(h.api.readMemoryCalls).toEqual(['deploy']);
    expect(detail).toContain('デプロイの手順');
    expect(detail).not.toContain('**確認**'); // Markdown として整形される
    expect(detail).toContain('Esc 一覧へ');
    expect(detail).toContain('読むだけ');

    // 編集・削除に当たるキーは何も起こさない。
    for (const key of ['e', 'd', 'x', 'i', 's']) h.stdin.write(key);
    h.stdin.write(UP_ARROW);
    await waitFor(() => h.frame().includes('本番の前に'));
    expect(h.api.readMemoryCalls).toEqual(['deploy']);

    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('記憶（2 件'));
    expect(h.frame()).toContain('人となり');
  });

  it('空の記憶、無い記憶（404）、読めなかったのを区別して言う', async () => {
    const h = start((api) => {
      api.memoryRows = [memoryRow('gone')];
    });
    await openMemory(h);
    await waitFor(() => h.frame().includes('gone のタイトル'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('この記憶は無い（404）'));
  });

  it('一覧を読めなかったのを「まだ空」と描かない', async () => {
    const h = start((api) => {
      api.memoryListFails = '繋がらない';
    });
    await type(h.stdin, '/memory');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('記憶を読めなかった（空ではない）'));
    expect(h.frame()).toContain('繋がらない');
    expect(h.frame()).not.toContain('まだ空');
  });
});

const UP_ARROW = '\x1b[A';
