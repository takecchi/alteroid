import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid practice` — **人間が仕事のやり方を CLI から読んで書き換えられること**
 * （#1055 段3③ の3つ目の入口）。
 *
 * 段3 の受け入れ基準は「人間がやり方を読んで書き換えられる（3入口すべて）」で、
 * `docs/PRD.md` の3入口は CLI / HTTP API / Web UI である。#1316 で HTTP と画面が
 * 通ったので、ここが最後の1つになる。
 *
 * **`memory.test.ts` と同じく `fetch` を差し替えて、本物の型付きクライアント
 * （`hono/client`）を通す。** 手書きのスタブを client の位置に置くと、経路名や
 * 本文の形が実物と一致していることを1つも確かめられない。ここで見たいのは
 * **`PUT /practices/<slug>` が `{kind,title,content}` の形で実際に組み立てられるか**
 * なので、差し替えるのはもっと外側（`fetch`）にする。
 */
vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
  describeAuthFailure: () => null,
}));

const {
  practiceEditCommand,
  practiceListCommand,
  practiceRemoveCommand,
  practiceSetCommand,
  practiceShowCommand,
} = await import('./practice.js');

interface Sent {
  url: string;
  method: string;
  body: string | undefined;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;

/** 次の応答を積む。**空なら 200 の空 JSON**（積み忘れを黙って通さないため、URL は必ず記録する）。 */
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({
      url,
      method: init?.method ?? request.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

/** `GET /practices/:slug` が返す形（`practiceReadResponseSchema`）。 */
function practiceBody(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    practice: {
      slug: 'review',
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '# レビュー\n\n差分より先に Issue を読む。\n',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      bytes: 30,
      ...over,
    },
  };
}

/** 一時ファイルを1つ作って絶対パスを返す（後始末は `afterEach`）。 */
let tempDirs: string[] = [];
function fileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'alteroid-practice-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'body.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  globalThis.fetch = originalFetch;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  vi.restoreAllMocks();
});

describe('alteroid practice set', () => {
  it('標準入力の内容を PUT /practices/<slug> へ kind・title ごと全文置換で送る', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } }); // 既存を見に行く
    replies.push({ status: 200, body: practiceBody({ slug: 'daily' }) });

    await practiceSetCommand('daily', {
      file: fileWith('# 日報\n\n昨日の委譲を数える。\n'),
      kind: '日報',
      title: '日報の書き方',
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.method).toBe('PUT');
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/practices/daily');
    // **本文の形も見る。** `{kind,title,content}` は `practiceBody`（デーモン側）の形。
    // `content` だけの部分更新は `PracticeStore.write` に無い。
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: '日報',
      title: '日報の書き方',
      content: '# 日報\n\n昨日の委譲を数える。\n',
    });
    expect(read()).toContain('書き換えました: daily');
  });

  /**
   * **`--kind` / `--title` を省いたら、いま在る値を引き継ぐ。**
   * `PUT` は全文置換なので、引き継がないと「本文だけ直したい」人が
   * 種類と題を黙って失う（`memory` の `PUT` が `{content}` だけで足りるのとの違い）。
   */
  it('既存のやり方では --kind / --title を省くと現在の値を引き継ぐ', async () => {
    captureStdout();
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 200, body: practiceBody() });

    await practiceSetCommand('review', { file: fileWith('新しい本文\n') });

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '新しい本文\n',
    });
  });

  /**
   * **新しいやり方では両方とも必須。** `practiceKindSchema` が `kind` に
   * `min(1)` を課すので、空で押し込むとデーモンに弾かれる——弾かれる前に
   * 人間へ分かる形で言う。**そして PUT を1本も打たない**（打つと、弾かれた
   * のか書けたのかが出力から読めない）。
   */
  it('新しいやり方で --kind / --title が欠けていたら、PUT を打たずに断る', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await practiceSetCommand('new-one', { file: fileWith('本文\n'), kind: '調査' });

    const text = read();
    expect(text).toContain('--kind と --title が両方必要です');
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  it('書き換えられなければ、書き換えたとは言わない', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 400, body: { error: 'やり方のスラッグが不正' } });

    await practiceSetCommand('..', { file: fileWith('本文\n'), kind: 'x', title: 'y' });

    const text = read();
    expect(text).toContain('書き換えられませんでした');
    expect(text).not.toContain('書き換えました: ..');
  });
});

describe('alteroid practice edit', () => {
  it('$EDITOR が本文を変えたら PUT する（種類と題は引き継ぐ）', async () => {
    captureStdout();
    process.env.EDITOR = `sh -c 'printf "編集後の本文\\n" > "$1"' _`;
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 200, body: practiceBody() });

    await practiceEditCommand('review', {});

    expect(sent).toHaveLength(2);
    expect(sent[1]?.method).toBe('PUT');
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '編集後の本文\n',
    });
  });

  /**
   * **何も変えずに閉じたら書き込まない。** 同じ内容でも `PUT` は日誌へ
   * `decision` を積むので、押し戻すたびに「人間が書き換えた」という跡が
   * 実際には無かった変更ぶん増える。
   */
  it('$EDITOR が何も変えなければ PUT を打たない', async () => {
    const read = captureStdout();
    process.env.EDITOR = 'true';
    replies.push({ status: 200, body: practiceBody() });

    await practiceEditCommand('review', {});

    expect(read()).toContain('変更はありません');
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  /**
   * **本文が同じでも、`--kind` / `--title` だけを変えたいことがある。**
   * 「本文が同じなら書かない」を本文だけで判定すると、種類と題の変更が
   * 黙って捨てられる（3つとも全文置換の対象である）。
   */
  it('本文が同じでも --title だけ変わっていれば PUT する', async () => {
    captureStdout();
    process.env.EDITOR = 'true';
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 200, body: practiceBody() });

    await practiceEditCommand('review', { title: '別の題' });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.method).toBe('PUT');
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: 'レビュー',
      title: '別の題',
      content: '# レビュー\n\n差分より先に Issue を読む。\n',
    });
  });

  /**
   * **雛形に「何をしてよいかの表」を書かせない**（AGENTS.md 地雷表3行目）。
   * そして**やり方が実行される定義ではないこと**を雛形自身が言う
   * （`PracticeStore` の doc と同じ線）。
   */
  it('無い slug でも開ける。雛形は「実行される定義ではない」と言い、許可の一覧を作らない', async () => {
    captureStdout();
    process.env.EDITOR = `sh -c 'cat "$1" > "$1.seen"' _`;
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 200, body: practiceBody({ slug: 'fresh' }) });

    await practiceEditCommand('fresh', { kind: '調査', title: '調べ方' });

    expect(sent).toHaveLength(2);
    const content = JSON.parse(sent[1]?.body ?? '{}') as { content: string };
    expect(content.content).toContain('実行される定義ではなく');
    expect(content.content).not.toContain('permissions');
  });
});

describe('alteroid practice remove', () => {
  it('DELETE /practices/<slug> を打つ', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { ok: true, slug: 'review' } });

    await practiceRemoveCommand('review');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review');
    expect(read()).toContain('消しました: review');
  });

  /**
   * デーモンは「無い」（404）と「名前として成立しない」（400）を分けている。
   * **こちらで1つに潰すと、直し方が読めなくなる**（打ち間違いなのか、消えたのか）。
   */
  it('「無い」と「名前として不正」を混ぜない', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });
    await practiceRemoveCommand('missing');
    expect(read()).toContain('そんなやり方はありません');

    vi.restoreAllMocks();
    const read2 = captureStdout();
    replies.push({ status: 400, body: { error: 'やり方のスラッグが不正' } });
    await practiceRemoveCommand('..');
    const text = read2();
    expect(text).toContain('名前として成立しません');
    expect(text).not.toContain('そんなやり方はありません');
  });
});

describe('alteroid practice list / show', () => {
  /**
   * ⭐ **空は正常である。** クローンの `practice_list` が逐語でそう言っている
   * （「やり方が1件も無いのは正常な状態である」）。**入口が違うと同じ状態の
   * 意味が変わる、を作らない。**
   */
  it('空なら「0 件」で終わらせず、それが正常な状態だと言って次の一手を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { practices: [] } });

    await practiceListCommand();

    const text = read();
    expect(text).toContain('これは正常な状態');
    expect(text).toContain('alteroid practice edit');
  });

  it('一覧は種類・slug・題・作成・更新・文字数を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        practices: [
          {
            slug: 'review',
            kind: 'レビュー',
            title: 'レビューの進め方',
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
            bytes: 30,
          },
        ],
      },
    });

    await practiceListCommand();

    const text = read();
    expect(text).toContain('[レビュー] review  — レビューの進め方');
    expect(text).toContain('作成: 2026-09-20T00:00:00.000Z / 更新: 2026-09-21T00:00:00.000Z');
    expect(text).toContain('30 文字');
  });

  /**
   * **`kind` は自由文字列である**（`practiceKindSchema` の doc「⛔ ここを
   * `z.enum` にしないこと」）。CLI が知らない種類を弾いたり隠したりすると、
   * クローンが `practice_write` で書いたやり方が人間の入口から消える。
   */
  it('知らない種類でもそのまま出す（列挙で弾かない）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        practices: [
          {
            slug: 'x',
            kind: '週末の棚卸し 🧹',
            title: 'x',
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
            bytes: 1,
          },
        ],
      },
    });

    await practiceListCommand();

    expect(read()).toContain('[週末の棚卸し 🧹] x');
  });

  it('本文を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody() });

    await practiceShowCommand('review');

    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review');
    expect(read()).toContain('差分より先に Issue を読む。');
  });

  it('無いやり方を読もうとしたら、そう言う（空の本文と区別する）', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await practiceShowCommand('missing');

    expect(read()).toContain('そんなやり方はありません: missing');
  });
});
