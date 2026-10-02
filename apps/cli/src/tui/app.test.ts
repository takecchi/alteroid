import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.js';
import { ChatController } from './chat-controller.js';
import { fakeApi, gate, type FakeApi } from './fake-api.js';
import { HeaderFeed } from './header-feed.js';
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
  stdin: FakeStdin;
  frame: () => string;
  unmount: () => void;
  exited: () => boolean;
}

const mounted: Harness[] = [];
afterEach(() => {
  for (const h of mounted.splice(0)) {
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
  feed.start();
  const { app, stdin, lastFrame } = renderFullscreen(
    createElement(App, { api, controller, feed, fullscreen: size.fullscreen ?? true }),
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

  it('2〜5 のタブは「次の段階で実装」。Esc で入力欄を抜けて数字で移り、1 で会話へ戻る', async () => {
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
    h.stdin.write('3');
    await waitFor(() => h.frame().includes('委譲: 次の段階で実装'));
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
    await new Promise((r) => setTimeout(r, 150));
    expect(h.exited()).toBe(false);
    expect(h.frame()).toContain('❯ ab');
  });
});
