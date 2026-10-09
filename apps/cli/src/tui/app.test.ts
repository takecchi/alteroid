import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.js';
import { NotDeliveredError } from './api.js';
import { ApprovalsController } from './approvals-controller.js';
import { ChatController } from './chat-controller.js';
import {
  fakeApi,
  approvalRow,
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
import { press, renderFullscreen, type FakeStdin, type } from './test-helpers.js';
import { waitFor } from './test-helpers.js';

const ENTER = '\r';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const ESC = '\x1b';

interface Harness {
  api: FakeApi;
  controller: ChatController;
  feed: HeaderFeed;
  approvals: ApprovalsController;
  managers: ManagersController;
  journal: JournalController;
  memory: MemoryController;
  stdin: FakeStdin;
  stdout: { rows: number; emit: (event: string) => boolean };
  frame: () => string;
  unmount: () => void;
  exited: () => boolean;
}

const mounted: Harness[] = [];
afterEach(() => {
  for (const h of mounted.splice(0)) {
    h.approvals.dispose();
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
  const approvals = new ApprovalsController(api, { debounceMs: 10 });
  approvals.attach(feed);
  const managers = new ManagersController(api, { debounceMs: 10 });
  managers.attach(feed);
  const journal = new JournalController(api);
  journal.attach(feed);
  const memory = new MemoryController(api, { debounceMs: 10 });
  memory.attach(feed);
  feed.start();
  const { app, stdin, stdout, lastFrame } = renderFullscreen(
    createElement(App, {
      api,
      controller,
      feed,
      approvals,
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
    approvals,
    managers,
    journal,
    memory,
    stdin,
    stdout: stdout as unknown as Harness['stdout'],
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
      api.counts = { pendingApprovals: 3, unreadableApprovals: 0, runningManagers: 2 };
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

  it('読めない承認待ちだけのとき、ヘッダとタブは「承認待ち 0」で済ませず読めない件数を言う（#3090）', async () => {
    const h = start((api) => {
      api.counts = { pendingApprovals: 0, unreadableApprovals: 2, runningManagers: 0 };
    });
    await waitFor(() => h.frame().includes('承認待ち 0（読めない 2）'));
    expect(h.frame()).toContain('2 承認待ち ⚠読めない 2');
  });

  it('全画面では端末の行数ぶんに収まる（はみ出さない）', async () => {
    const h = start(undefined, { rows: 20 });
    await waitFor(() => h.frame().includes('^D 終了'));
    expect(h.frame().split('\n').length).toBeLessThanOrEqual(20);
  });

  it('Esc で入力欄を抜けて数字で承認待ちのタブへ移り、1 で会話へ戻る', async () => {
    const h = start();
    await waitFor(() => h.frame().includes('メッセージ'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('2');
    await waitFor(() => h.frame().includes('承認待ちは無い。'));
    h.stdin.write('1');
    await waitFor(() => h.frame().includes('メッセージ'));
    expect(h.frame()).not.toContain('承認待ちは無い。');
  });

  it('入力欄の外から / を打つと会話へ戻ってコマンドを書き始められる', async () => {
    const h = start();
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('2');
    await waitFor(() => h.frame().includes('承認待ちは無い。'));
    h.stdin.write('/');
    await waitFor(() => h.frame().includes('❯ /'));
    await type(h.stdin, 'approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('承認待ちは無い。'));
  });

  it('会話の入力欄に書きかけがあるとき、他の画面から / を打っても「/」で置き換えて消さない（#3488）', async () => {
    const h = start();
    await type(h.stdin, '書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    h.stdin.write('/');
    await waitFor(() => h.frame().includes('メッセージ') || h.frame().includes('❯ '));
    await type(h.stdin, '続き');
    await waitFor(() => h.frame().includes('❯ 書きかけ続き'));
    expect(h.frame()).not.toContain('❯ /');
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
    expect(frame).toContain('  こんにちは。太字です');
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
    expect(h.frame()).toContain('/exti');
    h.stdin.write('\x15');
    await type(h.stdin, '//exit は終了です');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.chatCalls.length === 1);
    expect(h.api.chatCalls[0]?.text).toBe('/exit は終了です');
  });

  it('未知のコマンドとして断った文は、入力欄を空にしない（#3406）', async () => {
    const h = start();
    await type(h.stdin, '/var/log/app.log が壊れている');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('不明なコマンド: /var/log/app.log'));
    expect(h.frame()).toContain('❯ /var/log/app.log が壊れている');
    expect(h.api.chatCalls).toEqual([]);
  });

  it('受け取られなかった送信は、文を入力欄へ戻す（#3405）', async () => {
    const h = start((api) => {
      api.scripts.push([new NotDeliveredError('送信できませんでした（HTTP 503）')]);
    });
    await type(h.stdin, '大事な長い文章');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('✗ 送信できませんでした（HTTP 503）'));
    await waitFor(() => h.frame().includes('❯ 大事な長い文章'));
    expect(h.frame()).toContain('送れなかった発言');
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

  describe('kitty keyboard protocol に応じた端末の符号（CSI u）', () => {
    it('Shift+Enter（`CSI 13;2u`）と Alt+Enter（`CSI 13;3u`）は改行で送らない。素の Enter は送る', async () => {
      const h = start();
      await type(h.stdin, 'a');
      h.stdin.write('\x1b[13;2u');
      await type(h.stdin, 'b');
      h.stdin.write('\x1b[13;3u');
      await type(h.stdin, 'c');
      await waitFor(() => h.frame().includes('  c'));
      expect(h.api.chatCalls).toEqual([]);
      const lines = h.frame().split('\n');
      const first = lines.findIndex((l) => l.includes('❯ a'));
      expect(lines[first + 1]).toContain('b');
      expect(lines[first + 2]).toContain('c');
      h.stdin.write(ENTER);
      await waitFor(() => h.api.chatCalls.length === 1);
      expect(h.api.chatCalls[0]?.text).toBe('a\nb\nc');
    });

    it('従来の符号（応じない端末）でも、素の Enter は送信・行末の \\ + Enter は改行のまま', async () => {
      const h = start();
      await type(h.stdin, 'x\\');
      h.stdin.write(ENTER);
      await type(h.stdin, 'y');
      await waitFor(() => h.frame().includes('  y'));
      expect(h.api.chatCalls).toEqual([]);
      h.stdin.write(ENTER);
      await waitFor(() => h.api.chatCalls.length === 1);
      expect(h.api.chatCalls[0]?.text).toBe('x\ny');
    });

    it('Esc（`CSI 27u`）は入力欄を抜け、Tab に当たる Shift+Tab（`CSI 9;2u`）も同じ', async () => {
      const h = start();
      await type(h.stdin, 'a');
      h.stdin.write('\x1b[27u');
      await waitFor(() => h.frame().includes('1-5 画面'));
      h.stdin.write('i');
      await waitFor(() => h.frame().includes('Esc 移動'));
      h.stdin.write('\x1b[9;2u');
      await waitFor(() => h.frame().includes('1-5 画面'));
    });

    it('Ctrl+C（`CSI 99;5u`）は中断、書きかけが無いときの Ctrl+D（`CSI 100;5u`）は終了', async () => {
      const h = start();
      h.stdin.write('\x1b[99;5u');
      await waitFor(() => h.frame().includes('ターンを止めた'));
      expect(h.api.interrupts).toBe(1);
      h.stdin.write('\x1b[100;5u');
      await waitFor(() => h.exited());
    });
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
    expect(h.frame()).not.toContain('行00');
    h.stdin.write('\x1b[5~');
    await waitFor(() => h.frame().includes('あと'));
    expect(h.frame()).not.toContain('行59');
    h.stdin.write('\x1b[6~');
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

  it.each([
    ['Ctrl+C', CTRL_C],
    ['/interrupt', null],
  ] as const)(
    '順番待ちのあいだの %s は、自分の発言を対象に取り下げる（#3989）',
    async (_name, key) => {
      const g = gate();
      const h = start((api) => {
        api.interruptOutcome = 'withdrawn';
        api.scripts.push([
          { type: 'open', conversationId: 'c1' },
          { type: 'queued' },
          g.wait,
          { type: 'done' },
        ]);
      });
      await type(h.stdin, '順番待ち');
      h.stdin.write(ENTER);
      await waitFor(() => h.frame().includes('順番を待っている…'));
      if (key === null) {
        await type(h.stdin, '/interrupt');
        h.stdin.write(ENTER);
      } else {
        h.stdin.write(key);
      }
      await waitFor(() => h.frame().includes('送れなかった発言'));
      expect(h.api.interruptTargets).toEqual([
        { conversationId: 'c1', clientMessageId: h.api.chatClientMessageIds[0] },
      ]);
      expect(h.frame()).toContain('取り下げました');
      expect(h.exited()).toBe(false);
      g.open();
    },
  );

  it('会話以外の画面の Ctrl+C は、結果を最下行にも出す（成功。#3489）', async () => {
    const h = start();
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    h.stdin.write(CTRL_C);
    await waitFor(() => h.frame().includes('ターンを止めた'));
    expect(h.frame()).toContain('日誌（絞り:');
    expect(h.frame()).toContain('ターンを止めた');
    expect(h.api.interrupts).toBe(1);
    expect(h.exited()).toBe(false);
  });

  it('会話以外の画面の Ctrl+C が失敗したら、失敗を最下行に出す（成功のように見せない。#3489）', async () => {
    const h = start((api) => {
      api.interruptFails = '止められませんでした（HTTP 500）';
    });
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('5');
    await waitFor(() => h.frame().includes('記憶（'));
    expect(h.frame()).toContain('記憶（');
    h.stdin.write(CTRL_C);
    await waitFor(() => h.frame().includes('✗ 止められませんでした'));
    expect(h.frame()).toContain('✗ 止められませんでした');
    h.stdin.write('r');
    await waitFor(() => !h.frame().includes('✗ 止められませんでした'));
    expect(h.frame()).not.toContain('✗ 止められませんでした');
    expect(h.frame()).toContain('1-5 画面');
  });

  it('書きかけが在るとき、他の画面の Ctrl+D は 1 度目で案内を出し、2 度目で終了する（#3490）', async () => {
    const h = start();
    await type(h.stdin, '書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    h.stdin.write(CTRL_D);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.exited()).toBe(false);
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
  });

  it('書きかけが在っても、間に別のキーを挟めば 1 度目からやり直す（#3490）', async () => {
    const h = start();
    await type(h.stdin, '書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    h.stdin.write(CTRL_D);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    h.stdin.write('r');
    await waitFor(() => !h.frame().includes('もう一度 ^D'));
    h.stdin.write(CTRL_D);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.exited()).toBe(false);
  });

  it('入力欄に書きかけがあるときの Ctrl+D も、1 度目は案内だけで、2 度目で終了する（#3490）', async () => {
    const h = start();
    await type(h.stdin, 'ab');
    h.stdin.write(CTRL_D);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.exited()).toBe(false);
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
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
    h.stdin.write('\x1b[B');
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
    expect(list).not.toContain('古い依頼を頼む');

    h.stdin.write('\x1b[B');
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
    expect(h.api.chatCalls).toEqual([]);

    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write(ESC);
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
    h.stdin.write('\x15');
    await type(h.stdin, '//stop ではなく文');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.managerMessages.length === 1);
    expect(h.api.managerMessages[0]?.text).toBe('/stop ではなく文');
    await type(h.stdin, '/chat');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('メッセージ'));
  });

  it('委譲の詳細で、未知のコマンドとして断った文は入力欄を空にしない（#3486）', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '/var/log/app.log が壊れている');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('不明なコマンド: /var/log/app.log'));
    expect(h.frame()).toContain('❯ /var/log/app.log が壊れている');
    expect(h.api.managerMessages).toEqual([]);
  });

  it('追加指示が届いていない（session_missing）と返されたら、書いた文は入力欄に残る（#3487）', async () => {
    const h = start((api) => {
      managersFixture(api);
      api.sendManagerMessage = () =>
        Promise.resolve({ outcome: 'session_missing', detail: '届いていない' });
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '大事な指示');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('session_missing: 届いていない'));
    await type(h.stdin, '。');
    await waitFor(() => h.frame().includes('❯ 大事な指示。'));
    expect(h.frame()).toContain('❯ 大事な指示。');
  });

  it('追加指示の送信に失敗したら、書いた文は入力欄に残り、失敗を言う（#3367）', async () => {
    const h = start((api) => {
      managersFixture(api);
      api.sendManagerMessage = () => Promise.reject(new Error('送れない'));
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '大事な指示');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('✗ 送れない'));
    await type(h.stdin, '。');
    await waitFor(() => h.frame().includes('❯ 大事な指示。'));
    expect(h.frame()).toContain('❯ 大事な指示。');
  });

  it('送信中に Enter を押しても文は消えず、送信中と言う（#3367）', async () => {
    const g = gate();
    const h = start((api) => {
      managersFixture(api);
      api.sendManagerMessage = async (id, text) => {
        api.managerMessages.push({ id, text });
        await g.wait;
        return { outcome: 'delivered', detail: '届いた' };
      };
    });
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '一つ目');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.managerMessages.length === 1);
    await type(h.stdin, '二つ目');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('送信中'));
    await type(h.stdin, '。');
    await waitFor(() => h.frame().includes('❯ 二つ目。'));
    expect(h.frame()).toContain('❯ 二つ目。');
    expect(h.api.managerMessages).toHaveLength(1);
    g.open();
  });

  it('書きかけのまま Esc を二度押しても、すぐには捨てない。もう一度 Esc で捨てて戻る（#3367）', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('もう一度 Esc'));
    expect(h.frame()).toContain('もう一度 Esc');
    expect(h.frame()).not.toContain('委譲（絞り: すべて');
    expect(h.frame()).toContain('書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('委譲（絞り: すべて'));
    expect(h.frame()).toContain('委譲（絞り: すべて');
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
    h.stdin.write('f');
    await waitFor(() => h.frame().includes('絞り: 実行中'));
    expect(h.api.managerListCalls.at(-1)).toEqual({ status: ['running'], limit: 50 });
    expect(h.frame()).toContain('mgr-new');
    expect(h.frame()).not.toContain('mgr-old');
    h.stdin.write('f');
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

  it('r で取り直しても、読み足した古い側の頁と選択位置を失わない', async () => {
    const h = start((api) => {
      api.managerRows = Array.from({ length: 60 }, (_, i) =>
        managerRow(`mgr-${String(100 - i)}`, { request: `依頼${String(i)}` }),
      );
    });
    await openList(h);
    h.stdin.write('m');
    await waitFor(() => h.frame().includes('60 件読み込み済み'));
    h.stdin.write('\x1b[B'.repeat(54));
    const selectedLine = () =>
      h
        .frame()
        .split('\n')
        .some((l) => l.includes('❯') && l.includes('mgr-46'));
    await waitFor(selectedLine);
    const before = h.api.managerListCalls.length;
    h.stdin.write('r');
    await waitFor(() => h.api.managerListCalls.length > before);
    await waitFor(() => h.frame().includes('これより古い委譲は無い（全 60 件）'));
    expect(h.api.managerListCalls.at(-1)).toEqual({ limit: 60 });
    expect(selectedLine()).toBe(true);
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

  it('委譲の書きかけが在るまま日誌へ移っても、Ctrl+D は 1 度目で案内を出し、2 度目で終了する（#3490）', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    h.stdin.write(CTRL_D);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.exited()).toBe(false);
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
  });

  it('詳細の入力欄に書きかけがあるときの Ctrl+D では終了しない', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, 'ab');
    h.stdin.write(CTRL_D);
    h.stdin.write('c');
    await waitFor(() => h.frame().includes('❯ abc'));
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('❯ abc');
  });

  it('委譲の入力欄から /exit を打ったとき、会話の書きかけが在れば 1 度目は案内だけで、2 度目の /exit で終了する（#3518）', async () => {
    const h = start(managersFixture);
    await type(h.stdin, '会話の書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('3');
    await waitFor(() => h.frame().includes('委譲（絞り: すべて'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '/exit');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.frame()).toContain('もう一度 ^D');
    expect(h.exited()).toBe(false);
    await type(h.stdin, '/exit');
    h.stdin.write(ENTER);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
  });

  it('会話の入力欄から /exit を打ったとき、委譲の書きかけが在れば 1 度目は案内だけで、2 度目の Ctrl+D でも終了できる（#3518）', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '委譲の書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('1');
    await type(h.stdin, '/exit');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.frame()).toContain('もう一度 ^D');
    expect(h.exited()).toBe(false);
    h.stdin.write(CTRL_D);
    await waitFor(() => h.exited());
    expect(h.exited()).toBe(true);
  });

  it('/exit の 1 度目のあとに別のキーを挟めば、1 度目からやり直す（#3518）', async () => {
    const h = start(managersFixture);
    await openList(h);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    h.stdin.write('i');
    await type(h.stdin, '委譲の書きかけ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    h.stdin.write('1');
    await type(h.stdin, '/exit');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    h.stdin.write(ESC);
    await waitFor(() => !h.frame().includes('もう一度 ^D'));
    h.stdin.write('1');
    await type(h.stdin, '/exit');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('もう一度 ^D'));
    expect(h.frame()).toContain('もう一度 ^D');
    expect(h.exited()).toBe(false);
  });
});

describe('日誌（ライブで流れる一覧と全文）', () => {
  const UP = '\x1b[A';
  const DOWN = '\x1b[B';
  const PGUP = '\x1b[5~';

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
    expect(frame.indexOf('最初の発言')).toBeLessThan(frame.indexOf('[decision]'));
    expect(frame.indexOf('[decision]')).toBeLessThan(frame.indexOf('[turn_usage]'));
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
    expect(h.api.journalListCalls).toHaveLength(1);
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
    expect(h.frame()).not.toContain('発言1 ');
    expect(h.frame().split('\n').length).toBeLessThanOrEqual(24);

    h.stdin.write(PGUP);
    h.stdin.write(PGUP);
    await waitFor(() => h.frame().includes('位置を止めている（新しい側にあと 20 件'));
    live.open();
    await waitFor(() => h.journal.store.getSnapshot().entries.length === 41);
    h.stdin.write(UP);
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
    for (let i = 0; i < 12; i += 1) h.stdin.write(PGUP);
    await waitFor(() => h.api.journalListCalls.length === 2);
    expect(h.api.journalListCalls[1]).toMatchObject({ until: minute(51) });
    await waitFor(() => h.journal.store.getSnapshot().entries.length === 150);
    await waitFor(() =>
      h.frame().includes('古い側はまだ在る（先頭まで上がるか m で読み足す · いま 150 件）'),
    );
  });

  it('Enter で 1 件の全文を開き、Esc で一覧へ戻る（PgDn で読み進められる）', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `長い本文の${String(i)}行目`).join('\n');
    const h = start((api) => {
      api.journalEntries = [said(2, long), said(1, '短い発言')];
    });
    await openJournal(h);
    await waitFor(() => h.frame().includes('短い発言'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    const detail = h.frame();
    expect(detail).toContain('[exchange] e2');
    expect(detail).toContain('長い本文の0行目');
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
    expect(h.frame()).toContain('[ ] turn_usage');
    h.stdin.write(DOWN);
    h.stdin.write('\u3000');
    await waitFor(() => h.frame().includes('[x] decision'));
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('絞り: type=decision'));
    await waitFor(() => !h.frame().includes('雑談'));
    expect(h.api.journalListCalls.at(-1)).toMatchObject({ types: ['decision'] });
    expect(h.frame()).toContain('[decision] 進める');

    h.stdin.write('f');
    await waitFor(() => h.frame().includes('種別で絞り込む'));
    h.stdin.write('c');
    await waitFor(() => !h.frame().includes('[x] decision'));
    for (let i = 0; i < 3; i += 1) h.stdin.write(DOWN);
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

    h.stdin.write(ESC);
    await type(h.stdin, '/');
    await type(h.stdin, 'journal type=bogus');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('type= に知らない値が入っています: bogus'));
    expect(h.api.journalListCalls).toHaveLength(1);
  });

  it('初めて開く /journal の引数の誤りの断りは、読み込みの開始で消えず画面に出る（#3484）', async () => {
    const h = start((api) => {
      api.journalEntries = entries(2);
    });
    await type(h.stdin, '/journal type=bogus');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('発言2'));
    expect(h.frame()).toContain('type= に知らない値が入っています: bogus');
    expect(h.api.journalListCalls).toHaveLength(1);
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
    expect(frame).not.toContain('本番の前に');
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
    expect(detail).not.toContain('**確認**');
    expect(detail).toContain('Esc 一覧へ');
    expect(detail).toContain('読むだけ');

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

describe('承認待ち（一覧と詳細・答える）', () => {
  const DOWN = '\x1b[B';
  const SPACE = ' ';

  const deployQuestions = [
    {
      id: 'q1',
      prompt: 'デプロイ先',
      options: [
        { id: 'railway', label: 'Railway', recommended: true, description: '今の本番' },
        { id: 'fly', label: 'Fly' },
      ],
    },
    {
      id: 'q2',
      prompt: '通知先',
      multiple: true,
      options: [
        { id: 'slack', label: 'Slack' },
        { id: 'mail', label: 'Mail' },
      ],
    },
  ];

  function fixture(api: FakeApi): void {
    api.approvalRows = [
      approvalRow('ap-free', {
        createdAt: '2026-10-02T00:00:00.000Z',
        question: 'このブランチをマージしてよいですか',
      }),
      approvalRow('ap-choice', {
        createdAt: '2026-10-02T01:00:00.000Z',
        question: 'どこへデプロイしますか。\n二行目の説明',
        context: '本番の切り替えを伴う',
        jobId: 'mgr-deploy',
        questions: deployQuestions,
      }),
    ];
    api.counts = { pendingApprovals: 2, unreadableApprovals: 0, runningManagers: 0 };
  }

  async function openList(h: Harness): Promise<void> {
    await type(h.stdin, '/approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
  }

  async function openChoiceDetail(h: Harness): Promise<void> {
    await openList(h);
    await press(h.stdin, DOWN);
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('二行目の説明'));
    expect(h.frame()).toContain('Esc 一覧へ');
  }

  it('d で回答済み: 決着した日 → その日の件 → 詳細 → Esc でその日へ → Esc で日付へ → Esc で未回答へ（#3340）', async () => {
    const h = start((api) => {
      fixture(api);
      const done = approvalRow('ap-done', {
        question: '夜のリリースを待つか',
        answeredAt: '2026-09-30T10:00:00.000Z',
        answer: '待たない',
      });
      const gone = approvalRow('ap-gone', {
        question: '取り下げた確認',
        withdrawnAt: '2026-09-30T05:00:00.000Z',
        withdrawnReason: '自分で見つけた',
      });
      api.answeredDateRows = [{ date: '2026-09-30', count: 2 }];
      api.answeredOnRows = { '2026-09-30': [done, gone] };
      api.approvalRows = [...api.approvalRows, done, gone];
    });
    await openList(h);
    await press(h.stdin, 'd');
    await waitFor(() => h.frame().includes('2026-09-30  2 件'));
    expect(h.frame()).toContain('決着した日 1 日');
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('ap-gone'));
    const frame = h.frame();
    expect(frame).toContain('回答済み');
    expect(frame).toContain('回答: 待たない');
    expect(frame).toContain('取り下げた理由: 自分で見つけた');
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('[回答済み] ap-done'));
    expect(h.frame()).toContain('Esc その日へ');
    expect(h.frame()).not.toContain('a 答える');
    expect(h.frame()).not.toContain('a で答える');
    expect(h.frame()).not.toContain('Esc 一覧へ');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('2026-09-30 に決着した承認'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('2026-09-30  2 件'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
  });

  it('回答済み・取り下げ済みの詳細で a・i を押すと、答え済みか取り下げ済みかを最下行で断る（#3663）', async () => {
    const h = start((api) => {
      fixture(api);
      const done = approvalRow('ap-done', {
        question: '夜のリリースを待つか',
        answeredAt: '2026-09-30T10:00:00.000Z',
        answer: '待たない',
      });
      const gone = approvalRow('ap-gone', {
        question: '取り下げた確認',
        withdrawnAt: '2026-09-30T05:00:00.000Z',
        withdrawnReason: '自分で見つけた',
      });
      api.answeredDateRows = [{ date: '2026-09-30', count: 2 }];
      api.answeredOnRows = { '2026-09-30': [done, gone] };
      api.approvalRows = [...api.approvalRows, done, gone];
    });
    await openList(h);
    await press(h.stdin, 'd');
    await waitFor(() => h.frame().includes('2026-09-30  2 件'));
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('ap-gone'));
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('[回答済み] ap-done'));
    expect(h.frame()).not.toContain('もう答えられない:');
    await press(h.stdin, 'a');
    expect(h.frame()).toContain('もう答えられない: この承認待ちは回答済み');
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('2026-09-30 に決着した承認'));
    await press(h.stdin, DOWN);
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('ap-gone'));
    await press(h.stdin, 'i');
    expect(h.frame()).toContain('もう答えられない: この承認待ちは取り下げ済み');
  });

  it('一覧は古い順に 1 件 1 行。設問が在れば要約、無ければ質問の抜粋。全文や設問の中身は載せない', async () => {
    const h = start(fixture);
    await openList(h);
    const frame = h.frame();
    expect(h.api.approvalListCalls[0]).toEqual({ pending: true });
    const lines = frame.split('\n');
    const free = lines.findIndex((l) => l.includes('ap-free'));
    const choice = lines.findIndex((l) => l.includes('ap-choice'));
    expect(free).toBeGreaterThan(-1);
    expect(choice).toBeGreaterThan(free);
    expect(lines[free]).toContain('このブランチをマージしてよいですか');
    expect(lines[free]).toContain('[クローン]');
    expect(lines[choice]).toContain('設問 2 件（うち複数選択 1）（選択肢つき）');
    expect(lines[choice]).toContain('[mgr-deploy]');
    expect(frame).not.toContain('二行目の説明');
    expect(frame).not.toContain('Railway');
  });

  it('詳細に、質問の全文・文脈・出どころ・設問の表示（推奨・単一/複数・その他）が出る', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    const frame = h.frame();
    expect(frame).toContain('[未回答] ap-choice');
    expect(frame).toContain('どこへデプロイしますか。');
    expect(frame).toContain('二行目の説明');
    expect(frame).toContain('本番の切り替えを伴う');
    expect(frame).toContain('マネージャー mgr-deploy');
    expect(frame).toContain('Q1 [id=q1] デプロイ先（単一選択・その他を書ける）');
    expect(frame).toContain('[id=railway] Railway［推奨］ — 今の本番');
    expect(frame).toContain('Q2 [id=q2] 通知先（複数選択可・その他を書ける）');
    expect(h.api.approvalAnswers).toEqual([]);
  });

  it('設問に答える: 単一は排他・複数は複数、その他と補足を書き、畳んだ文で確認してから送る', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('設問に答える'));
    expect(h.frame()).toContain('Railway［推奨］');

    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('(●) a) Railway'));
    await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('(●) b) Fly'));
    expect(h.frame()).toContain('( ) a) Railway');

    await press(h.stdin, DOWN);
    await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('[x] b) Mail'));
    expect(h.frame()).toContain('[x] a) Slack');
    await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('Enter 確定'));
    await type(h.stdin, 'ただし来週');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('[x] その他: ただし来週'));
    await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await type(h.stdin, '金曜は避けたい');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('補足（任意）: 金曜は避けたい'));

    await press(h.stdin, 's');
    await waitFor(() => h.frame().includes('この内容で答える?'));
    const confirm = h.frame();
    expect(confirm).toContain('Q1 デプロイ先: (b) Fly');
    expect(confirm).toContain('Q2 通知先: (a) Slack / (b) Mail / その他: ただし来週');
    expect(confirm).toContain('補足: 金曜は避けたい');
    expect(confirm).toContain('y で送る');
    expect(h.api.approvalAnswers).toEqual([]);

    await press(h.stdin, 'y');
    await waitFor(() => h.api.approvalAnswers.length > 0);
    expect(h.api.approvalAnswers).toEqual([
      {
        id: 'ap-choice',
        body: {
          selections: [
            { questionId: 'q1', optionIds: ['fly'] },
            { questionId: 'q2', optionIds: ['slack', 'mail'], other: 'ただし来週' },
          ],
          answer: '金曜は避けたい',
        },
      },
    ]);
    await waitFor(() => h.frame().includes('回答した。'));
    expect(h.frame()).toContain('[回答済み] ap-choice');
    expect(h.frame()).toContain('Q1 デプロイ先: (b) Fly');
  });

  it('未回答の設問が在っても送れるが、確認の画面で「未回答」と見える。答えた設問だけを送る', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await press(h.stdin, SPACE);
    await press(h.stdin, 's');
    await waitFor(() => h.frame().includes('この内容で答える?'));
    expect(h.frame()).toContain('Q1 デプロイ先: (a) Railway［推奨］');
    expect(h.frame()).toContain('Q2 通知先: 未回答');
    expect(h.frame()).toContain('答えていない設問が 1 件ある');
    await press(h.stdin, 'y');
    await waitFor(() => h.api.approvalAnswers.length > 0);
    expect(h.api.approvalAnswers[0]?.body).toEqual({
      selections: [{ questionId: 'q1', optionIds: ['railway'] }],
    });
  });

  it('確認で y 以外を押せば送らずフォームへ戻る。何も答えていなければ確認へ進まない', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await press(h.stdin, 's');
    await waitFor(() => h.frame().includes('何も答えていない'));
    expect(h.frame()).not.toContain('この内容で答える?');

    await press(h.stdin, SPACE);
    await press(h.stdin, 's');
    await waitFor(() => h.frame().includes('この内容で答える?'));
    await press(h.stdin, 'n');
    await waitFor(() => h.frame().includes('設問に答える'));
    expect(h.frame()).toContain('(●) a) Railway');
    expect(h.api.approvalAnswers).toEqual([]);
  });

  it('400 が返ったら本文をそのまま見せる。閉じず、書いた内容も残す', async () => {
    const h = start((api) => {
      fixture(api);
      api.approvalAnswerFails =
        'selections が不正: 設問 "q1" は単一選択なので、選択肢は1つしか選べない。';
    });
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await press(h.stdin, SPACE);
    await press(h.stdin, 's');
    await waitFor(() => h.frame().includes('この内容で答える?'));
    await press(h.stdin, 'y');
    await waitFor(() => h.frame().includes('✗ 回答に失敗しました（HTTP 400）'));
    const frame = h.frame();
    expect(frame).toContain('selections が不正: 設問 "q1" は単一選択なので');
    expect(frame).toContain('設問に答える');
    expect(frame).toContain('(●) a) Railway');
    expect(frame).not.toContain('回答した。');
  });

  it('設問の無い承認待ちは自由文で答える。確認を通ってから { answer } を送る', async () => {
    const h = start(fixture);
    await openList(h);
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('[未回答] ap-free'));
    expect(h.frame()).toContain('設問は無い');
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('回答を書く'));
    await type(h.stdin, 'はい、どうぞ');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('この内容で答える?'));
    expect(h.frame()).toContain('はい、どうぞ');
    expect(h.api.approvalAnswers).toEqual([]);
    await press(h.stdin, 'y');
    await waitFor(() => h.api.approvalAnswers.length > 0);
    expect(h.api.approvalAnswers).toEqual([{ id: 'ap-free', body: { answer: 'はい、どうぞ' } }]);
    await waitFor(() => h.frame().includes('[回答済み] ap-free'));
  });

  it('空の自由文は確認へ進まない。Esc で一覧へ戻ると、答えた件は一覧から消えている', async () => {
    const h = start(fixture);
    await openList(h);
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('[未回答] ap-free'));
    await press(h.stdin, 'a');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('回答が空'));
    expect(h.frame()).not.toContain('この内容で答える?');

    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
  });

  it('設問の無い・読み込み前でない回答済みの件は答えられない（a は何もしない）', async () => {
    const h = start((api) => {
      fixture(api);
      api.approvalRows[0] = approvalRow('ap-free', {
        question: '済んだ件',
        answeredAt: '2026-10-02T02:00:00.000Z',
        answer: 'もう答えた',
      });
    });
    await type(h.stdin, '/approvals ap-free');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('[回答済み] ap-free'));
    expect(h.frame()).toContain('もう答えた');
    await press(h.stdin, 'a');
    await press(h.stdin, 'i');
    expect(h.frame()).not.toContain('回答を書く');
    expect(h.frame()).not.toContain('設問に答える');
  });

  it('詳細を読み進めたあと別のタブへ移って戻っても、読む位置は先頭へ戻らない。開き直せば先頭から読む', async () => {
    const h = start((api) => {
      api.approvalRows = [
        approvalRow('ap-long', {
          question: Array.from({ length: 80 }, (_, i) => `長い質問の${String(i)}行目`).join('\n'),
        }),
      ];
      api.counts = { pendingApprovals: 1, unreadableApprovals: 0, runningManagers: 0 };
    });
    await type(h.stdin, '/approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('承認待ち（未回答 1 件'));
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('長い質問の0行目'));
    expect(h.frame()).not.toContain('長い質問の79行目');
    for (let i = 0; i < 20; i += 1) h.stdin.write('\x1b[6~');
    await waitFor(() => h.frame().includes('長い質問の79行目'));
    expect(h.frame()).not.toContain('長い質問の0行目');
    await press(h.stdin, '4');
    await waitFor(() => h.frame().includes('日誌（絞り:'));
    await press(h.stdin, '2');
    await waitFor(() => h.frame().includes('長い質問の79行目'));
    expect(h.frame()).not.toContain('長い質問の0行目');
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 1 件'));
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('長い質問の0行目'));
  });

  it('実行許可の承認待ちは、規則と例と「許可します」の答え方を出す。自由文で答える', async () => {
    const h = start((api) => {
      api.approvalRows = [
        approvalRow('ap-perm', {
          question: 'git push を許可してよいですか',
          jobId: 'mgr-p',
          permissionRequest: {
            rule: 'Bash(git push:*)',
            allows: ['git push origin main'],
            denies: ['rm -rf /'],
          },
        }),
      ];
    });
    await type(h.stdin, '/approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('[実行許可]'));
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('規則: Bash(git push:*)'));
    expect(h.frame()).toContain('通すべき例: git push origin main');
    expect(h.frame()).toContain('拒むべき例: rm -rf /');
    expect(h.frame()).toContain('「許可します」とちょうど答える');
  });

  it('会話で ask_human が来たら、Esc のあと a でその承認待ちの詳細へ飛べる。/approvals <id> でも飛べる', async () => {
    const h = start((api) => {
      fixture(api);
      api.scripts.push([
        { type: 'open', conversationId: 'c1' },
        { type: 'ask_human', approvalId: 'ap-choice', question: 'どこへデプロイしますか' },
        { type: 'done' },
      ]);
    });
    await type(h.stdin, 'デプロイして');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('承認待ち ap-choice'));
    expect(h.frame()).toContain('Esc のあと a');
    expect(h.frame()).toContain('/approvals ap-choice');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('[未回答] ap-choice'));
    expect(h.frame()).toContain('本番の切り替えを伴う');

    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
    await press(h.stdin, '/');
    await type(h.stdin, 'approvals ap-free');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('[未回答] ap-free'));
  });

  it('答えるフォームの Ctrl+C は、書きかけを残したまま中断し、結果を最下行に出す（#3489）', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('設問に答える'));
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('(●) a) Railway'));
    h.stdin.write(CTRL_C);
    await waitFor(() => h.frame().includes('ターンを止めた'));
    expect(h.api.interrupts).toBe(1);
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('設問に答える');
    expect(h.frame()).toContain('(●) a) Railway');
  });

  it('答えるフォームの入力ゾーンの Ctrl+C も、書きかけを残したまま中断する（#3489）', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('設問に答える'));
    for (let i = 0; i < 5; i++) await press(h.stdin, DOWN);
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('Enter 確定'));
    await type(h.stdin, 'ただし来週');
    h.stdin.write(CTRL_C);
    await waitFor(() => h.frame().includes('ターンを止めた'));
    expect(h.api.interrupts).toBe(1);
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('ただし来週');
  });

  it('ask_human が来ていない会話では a は何もしない', async () => {
    const h = start(fixture);
    await waitFor(() => h.frame().includes('メッセージ'));
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    await press(h.stdin, 'a');
    await press(h.stdin, '2');
    await waitFor(() => h.frame().includes('承認待ち（未回答'));
    expect(h.frame()).not.toContain('[未回答] ap-');
  });

  it('読めなかった一覧は「無い」と描かない。読めない行は居ないと分けて言う', async () => {
    const h = start((api) => {
      api.unreadableApprovals = [{ id: 'ap-broken', reason: 'questions' }];
    });
    await type(h.stdin, '/approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('読めない承認待ちが 1 件ある'));
    expect(h.frame()).toContain('ap-broken');
    expect(h.frame()).toContain('読めた承認待ちは無い');
    expect(h.frame()).not.toContain('承認待ちは無い。');
  });

  it('一覧を読めなかったときは、空ではなく失敗を言う', async () => {
    const h = start((api) => {
      api.approvalListFails = '繋がらない';
    });
    await type(h.stdin, '/approvals');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('繋がらない'));
    expect(h.frame()).not.toContain('承認待ちは無い。');
  });

  it('答えるフォームの入力欄に書きかけがあるとき Ctrl+D では終了しない', async () => {
    const h = start(fixture);
    await openList(h);
    await press(h.stdin, ENTER);
    await waitFor(() => h.frame().includes('[未回答] ap-free'));
    await press(h.stdin, 'a');
    await type(h.stdin, '書きかけ');
    h.stdin.write(CTRL_D);
    await press(h.stdin, 'x');
    await waitFor(() => h.frame().includes('書きかけx'));
    expect(h.exited()).toBe(false);
  });

  it('答えるフォームに選んだ分が在るまま Esc で詳細を閉じても、すぐには捨てない。もう一度 Esc で捨てて一覧へ戻る', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await press(h.stdin, SPACE);
    await waitFor(() => h.frame().includes('(●) a) Railway'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('もう一度 Esc'));
    expect(h.frame()).toContain('[未回答] ap-choice');
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('(●) a) Railway'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('もう一度 Esc'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
  });

  it('選んでも書いてもいなければ、Esc 一度で一覧へ戻る', async () => {
    const h = start(fixture);
    await openChoiceDetail(h);
    await press(h.stdin, 'a');
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('Esc 一覧へ'));
    await press(h.stdin, ESC);
    await waitFor(() => h.frame().includes('承認待ち（未回答 2 件'));
  });
});

describe('履歴の選択の断り書き（#2585）', () => {
  const summary = (id: string) => ({
    conversationId: id,
    startedAt: 's',
    updatedAt: new Date().toISOString(),
    messages: 2,
    preview: `話 ${id}`,
  });
  const open = async (h: Harness): Promise<void> => {
    await type(h.stdin, '/conversations');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話の履歴（'));
  };

  it('先頭に届いていなければ、そう断る', async () => {
    const h = start((api) => {
      api.listConversations = () =>
        Promise.resolve({
          conversations: [summary('c1')],
          scanned: 2000,
          reachedStart: false,
          hiddenByLimit: 0,
        });
    });
    await open(h);
    expect(h.frame()).toContain('2000 件遡ったが、先頭には届いていない');
    expect(h.frame()).not.toContain('ほか');
  });

  it('上限で省いた会話があれば、件数を言う', async () => {
    const h = start((api) => {
      api.listConversations = () =>
        Promise.resolve({
          conversations: [summary('c1')],
          scanned: 50,
          reachedStart: true,
          hiddenByLimit: 7,
        });
    });
    await open(h);
    expect(h.frame()).toContain('…ほか 7 件は省略');
    expect(h.frame()).not.toContain('先頭には届いていない');
  });

  it('0 件でも先頭に届いていなければ「会話はまだありません」とは言わず、判定できないと言う', async () => {
    const h = start((api) => {
      api.listConversations = () =>
        Promise.resolve({
          conversations: [],
          scanned: 2000,
          reachedStart: false,
          hiddenByLimit: 0,
        });
    });
    await open(h);
    expect(h.frame()).not.toContain('会話はまだありません');
    expect(h.frame()).toContain('判定できない');
    expect(h.frame()).toContain('先頭には届いていない');
  });

  it('0 件で先頭まで届いていれば「会話はまだありません」', async () => {
    const h = start();
    await open(h);
    expect(h.frame()).toContain('会話はまだありません');
    expect(h.frame()).not.toContain('先頭には届いていない');
  });
});

describe('端末の大きさが変わったとき（#3651）', () => {
  it('全画面で起動したあと行数が閾値未満へ縮んでも、入力欄とフッタが切れない', async () => {
    const h = start(() => undefined, { rows: 24 });
    await waitFor(() => h.frame().includes('^D 終了'));
    h.stdout.rows = 6;
    h.stdout.emit('resize');
    await waitFor(() => h.frame().includes('^D 終了') && h.frame().includes('❯'));
  });
});

describe('会話の画面の a キー（#3650）', () => {
  it('履歴から開いた会話の、答え済みを飛ばして未回答の承認の詳細を開く', async () => {
    const h = start((api) => {
      api.messages.c9 = [{ id: '1', at: '2026-10-06T10:00:00.000Z', role: 'inbound', text: 'q' }];
      api.conversationApprovals.c9 = {
        approvals: [
          { id: 'ans-1', createdAt: '2026-10-06T10:01:00.000Z', question: 'x', answeredAt: 'y' },
          { id: 'open-2', createdAt: '2026-10-06T10:02:00.000Z', question: 'まだ未回答' },
        ],
        unreadable: [],
      };
      api.approvalRows = [approvalRow('open-2', { question: 'まだ未回答の質問' })];
    });
    await h.controller.openConversation('c9');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    await press(h.stdin, 'a');
    await waitFor(() => h.frame().includes('まだ未回答の質問')).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${h.frame()}`);
    });
  });

  it('答え済みだけなら、a は何も指さず画面を移さない', async () => {
    const h = start((api) => {
      api.messages.c9 = [{ id: '1', at: '2026-10-06T10:00:00.000Z', role: 'inbound', text: 'q' }];
      api.conversationApprovals.c9 = {
        approvals: [
          { id: 'ans-1', createdAt: '2026-10-06T10:01:00.000Z', question: 'x', answeredAt: 'y' },
        ],
        unreadable: [],
      };
    });
    await h.controller.openConversation('c9');
    h.stdin.write(ESC);
    await waitFor(() => h.frame().includes('1-5 画面'));
    await press(h.stdin, 'a');
    expect(h.controller.store.getSnapshot().pendingAsk).toBeNull();
    expect(h.frame()).toContain('1 会話');
    expect(h.frame()).not.toContain('承認待ちの詳細');
  });
});

describe('履歴の選択の「もっと見る」（#3643）', () => {
  const summary = (id: string) => ({
    conversationId: id,
    startedAt: 's',
    updatedAt: new Date().toISOString(),
    messages: 2,
    preview: `話 ${id}`,
  });
  const DOWN = '\x1b[B';
  const open = async (h: Harness): Promise<void> => {
    await type(h.stdin, '/history');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話の履歴（'));
  };
  const toMoreRow = async (h: Harness, rows: number): Promise<void> => {
    for (let i = 0; i < rows; i += 1) h.stdin.write(DOWN);
    await waitFor(() =>
      h
        .frame()
        .split('\n')
        .some((l) => l.includes('❯') && l.includes('もっと見る')),
    );
  };

  it('末尾の「もっと見る」を選ぶと nextCursor で次の頁が足り、最後の頁では行が消える', async () => {
    const h = start((api) => {
      api.conversationPages = [[summary('a1'), summary('a2')], [summary('b1')]];
    });
    await open(h);
    expect(h.frame()).toContain('会話の履歴（2 件）');
    expect(h.frame()).toContain('もっと見る');
    await toMoreRow(h, 2);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話の履歴（3 件）'));
    expect(h.frame()).toContain('話 b1');
    expect(h.frame()).not.toContain('もっと見る');
    expect(h.api.listCursors).toEqual([undefined, 'page-1']);
  });

  it('続きが無ければ行を出さない（nextCursor を返さない古いデーモンは従来の但し書き）', async () => {
    const h = start((api) => {
      api.listConversations = () =>
        Promise.resolve({
          conversations: [summary('c1')],
          scanned: 50,
          reachedStart: true,
          hiddenByLimit: 7,
        });
    });
    await open(h);
    expect(h.frame()).not.toContain('もっと見る');
    expect(h.frame()).toContain('…ほか 7 件は省略');
  });

  it('読み込み中に重ねて選んでも、頁は 1 回しか取らない', async () => {
    let release: () => void = () => undefined;
    const h = start((api) => {
      api.conversationPages = [[summary('a1')], [summary('b1')]];
      api.conversationPageGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await open(h);
    await toMoreRow(h, 1);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('読み込み中'));
    h.stdin.write(ENTER);
    h.stdin.write(ENTER);
    await press(h.stdin, DOWN);
    expect(h.api.listCursors).toEqual([undefined, 'page-1']);
    release();
    await waitFor(() => h.frame().includes('会話の履歴（2 件）'));
    expect(h.api.listCursors).toEqual([undefined, 'page-1']);
  });

  it('失敗しても一覧は残り、末尾に理由が出て、もう一度選べば取り直す', async () => {
    const h = start((api) => {
      api.conversationPages = [[summary('a1')], [summary('b1')]];
      api.conversationPageFails = 'デーモンに届かない';
    });
    await open(h);
    await toMoreRow(h, 1);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('続きを読めなかった'));
    expect(h.frame()).toContain('デーモンに届かない');
    expect(h.frame()).toContain('話 a1');
    expect(h.frame()).toContain('会話の履歴（1 件）');
    h.api.conversationPageFails = null;
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('会話の履歴（2 件）'));
    expect(h.frame()).not.toContain('続きを読めなかった');
    expect(h.api.listCursors).toEqual([undefined, 'page-1', 'page-1']);
  });

  it('外から来た文字列は端末に制御文字を通さない', async () => {
    const h = start((api) => {
      api.conversationPages = [[summary('a1')], [summary('b1')]];
      api.conversationPageFails = '壊れた\x1b[2Jあ';
    });
    await open(h);
    await toMoreRow(h, 1);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('続きを読めなかった'));
    expect(h.frame()).not.toContain('\x1b[2J');
  });
});

describe('/edit（#3681）', () => {
  const editSetup = (api: FakeApi) => {
    api.messages.c1 = [
      {
        id: 'm1',
        at: '2026-10-01T00:00:00Z',
        role: 'inbound',
        text: 'もとの本文',
        attachments: [{ id: 'a1', name: 'a.log', mediaType: 'text/plain', size: 3 }],
      },
    ];
  };

  const inInput = (h: Harness): boolean => h.frame().split('❯ もとの本文').length - 1 >= 2;

  it('元の本文が入力欄に入り、直して Enter で supersedes 付きで送る。添付は付いたまま', async () => {
    const h = start(editSetup);
    await h.controller.openConversation('c1');
    await type(h.stdin, '/edit 1');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('番号は上の一覧の並び'));
    await type(h.stdin, '/edit 1');
    h.stdin.write(ENTER);
    await waitFor(() => inInput(h));
    expect(h.frame()).toContain('[添付] a.log');
    h.api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    await type(h.stdin, 'を直した');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.chatCalls.length === 1);
    expect(h.api.chatCalls[0]).toEqual({
      text: 'もとの本文を直した',
      conversationId: 'c1',
      attachments: ['a1'],
      supersedes: 'm1',
    });
  });

  it('編集の途中の空の Enter は、送れない理由を出す。/edit-cancel で何も送らず終わる', async () => {
    const h = start(editSetup);
    await h.controller.openConversation('c1');
    await type(h.stdin, '/edit');
    h.stdin.write(ENTER);
    await type(h.stdin, '/edit 1');
    h.stdin.write(ENTER);
    await waitFor(() => inInput(h));
    await press(h.stdin, '\x15');
    await type(h.stdin, '/detach all');
    h.stdin.write(ENTER);
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('本文も添付も無いので送っていない'));
    await type(h.stdin, '/edit-cancel');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('編集をやめた'));
    expect(h.api.chatCalls).toEqual([]);
  });

  it('編集中に /new で移ると入力欄は空になり、戻って /edit すると書きかけが入力欄へ戻る（何も送らない）', async () => {
    const h = start(editSetup);
    await h.controller.openConversation('c1');
    await type(h.stdin, '/edit');
    h.stdin.write(ENTER);
    await type(h.stdin, '/edit 1');
    h.stdin.write(ENTER);
    await waitFor(() => inInput(h));
    await type(h.stdin, 'を直しかけ');
    await press(h.stdin, '\x15');
    await type(h.stdin, '/new');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('書きかけをしまった'));
    expect(h.frame()).not.toContain('❯ もとの本文');
    await h.controller.openConversation('c1');
    await type(h.stdin, '/edit');
    h.stdin.write(ENTER);
    await type(h.stdin, '/edit 1');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('❯ もとの本文を直しかけ'));
    expect(h.api.chatCalls).toEqual([]);
  });
});

describe('/files /keep /unkeep /rm（#4138）', () => {
  const stored = (api: FakeApi) => {
    api.storedAttachments.push({
      id: 'att-1',
      name: 'a.log',
      mediaType: 'text/plain',
      size: 3,
      uploadedBy: 'operator',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-31T00:00:00.000Z',
    });
  };

  it('入力欄から打ったコマンドが置き場の API を叩き、結果を会話の画面へ出す', async () => {
    const h = start(stored);
    await type(h.stdin, '/files');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('[1] att-1'));
    await type(h.stdin, '/keep 1');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('保存中（期限なし）'));
    await type(h.stdin, '/unkeep att-1');
    h.stdin.write(ENTER);
    await waitFor(() => h.api.storedKeepCalls.length === 2);
    await type(h.stdin, '/rm 1');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('取り消せません。消すなら /rm 1 yes'));
    expect(h.api.storedRemoveCalls).toEqual([]);
    await type(h.stdin, '/rm 1 yes');
    h.stdin.write(ENTER);
    await waitFor(() => h.frame().includes('att-1 を消した'));
    expect(h.api.storedKeepCalls).toEqual([
      { id: 'att-1', kept: true },
      { id: 'att-1', kept: false },
    ]);
    expect(h.api.storedRemoveCalls).toEqual(['att-1']);
    expect(h.api.chatCalls).toEqual([]);
  });
});
