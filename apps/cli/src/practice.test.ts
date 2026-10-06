import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { captureStderr, captureStdout } from './test-support.js';

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
// `describeAuthFailure` は本物を使う（一覧・履歴の 401/403 を例外にする歯のため。#3452）。
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
}));

const {
  practiceEditCommand,
  practiceHistoryCommand,
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
      chars: 30,
      ...over,
    },
  };
}

/** 一時ファイルを1つ作って絶対パスを返す（後始末は helper の `afterAll`）。 */
function fileWith(content: string): string {
  const dir = makeTempDirSync('alteroid-practice-test-');
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
  it('新しいやり方で --kind / --title が欠けていたら、PUT を打たずに断る（例外。#3139）', async () => {
    // ⚠️ 2026-10-06（#3139）: 以前は stdout へ書いて正常 return（終了コード 0）していた。
    // アサーションは消さず、見る先を「投げた例外の文言」へ反転した（下の #1641 と同じ理由）。
    captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    const error = await practiceSetCommand('new-one', {
      file: fileWith('本文\n'),
      kind: '調査',
    }).catch((e: unknown) => e);

    expect(String(error)).toContain('--kind と --title が両方必要です');
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  /**
   * ⚠️ 2026-09-26（#1641）: 以前はここで `stdout.write` して正常 return して
   * いた（＝終了コードは常に 0）。いまは例外を投げる——アサーションは消さず、
   * 見る先を「書いた文字列」から「投げた例外の文言」へ反転した（`memory.ts`
   * の同名テストと同じ理由）。
   */
  it('書き換えられなければ、書き換えたとは言わない（例外の文言で確かめる。#1641）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 400, body: { error: 'やり方のスラッグが不正' } });

    const error = await practiceSetCommand('..', {
      file: fileWith('本文\n'),
      kind: 'x',
      title: 'y',
    }).catch((e: unknown) => e);

    expect(String(error)).toContain('書き換えられませんでした');
    expect(String(error)).not.toContain('書き換えました: ..');
  });
});

describe('alteroid practice set の空の本文（#3456）', () => {
  it.each([
    ['空', ''],
    ['空白だけ', ' \n\t\n'],
  ])(
    '既存のやり方があるとき、本文が%sなら、上書きせずに断る（--allow-empty を案内する）',
    async (_name, body) => {
      const read = captureStdout();
      replies.push({ status: 200, body: practiceBody() });

      const error = await practiceSetCommand('review', { file: fileWith(body) }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('本文が空');
      expect((error as Error).message).toContain('--allow-empty');
      expect(sent.filter((entry) => entry.method === 'PUT')).toEqual([]);
      expect(read()).not.toContain('書き換えました');
    },
  );

  it('新しく作るときも、本文が空なら断る（profile set と同じ）', async () => {
    captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(
      practiceSetCommand('new-one', { file: fileWith(''), kind: '調査', title: '題' }),
    ).rejects.toThrow('--allow-empty');
    expect(sent.filter((entry) => entry.method === 'PUT')).toEqual([]);
  });

  it('--allow-empty を付けたときだけ、空の本文で置き換える', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 200, body: practiceBody({ content: '' }) });

    await practiceSetCommand('review', { file: fileWith(''), allowEmpty: true });

    const puts = sent.filter((entry) => entry.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]?.body ?? '{}')).toEqual({
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '',
    });
    expect(read()).toContain('書き換えました: review');
  });
});

describe('alteroid practice edit', () => {
  it('新しいやり方で --kind / --title が欠けていたら、エディタも PUT も開かず例外で断る（#3139）', async () => {
    captureStdout();
    process.env.EDITOR = 'false';
    replies.push({ status: 404, body: { error: 'not found' } });

    const error = await practiceEditCommand('new-one', { kind: '調査' }).catch((e: unknown) => e);

    expect(String(error)).toContain('--kind と --title が両方必要です');
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  it.each([
    ['全部消した', ''],
    ['空白だけにした', ' \n\t\n'],
  ])(
    '本文を%sまま閉じたら、PUT せずに set と同じ文言で断り、編集を残す（#3456）',
    async (_label, body) => {
      captureStdout();
      const err = captureStderr();
      const bodyFile = join(makeTempDirSync('alteroid-practice-empty-'), 'body.txt');
      writeFileSync(bodyFile, body);
      process.env.EDITOR = `sh -c 'cat "${bodyFile}" > "$1"' _`;
      replies.push({ status: 200, body: practiceBody() });

      const error = await practiceEditCommand('review', {}).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('本文が空');
      expect((error as Error).message).toContain('--allow-empty');
      expect(sent.map((s) => s.method)).toEqual(['GET']);
      const mine = /残してあります: (\S+)/.exec(err())?.[1];
      expect(mine).toBeDefined();
      expect(readFileSync(mine ?? '', 'utf8')).toBe(body);
      rmSync(dirname(mine ?? ''), { recursive: true, force: true });
    },
  );

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

  it('409 以外の保存の失敗（500）でも、書いた内容を残し、場所と set --file を案内して失敗する（#3453）', async () => {
    captureStdout();
    const err = captureStderr();
    process.env.EDITOR = `sh -c 'printf "編集後の本文\\n" > "$1"' _`;
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 500, body: { error: 'boom' } });

    const error = await practiceEditCommand('review', {}).catch((e: unknown) => e);

    expect(String(error)).toContain('HTTP 500');
    const mine = /残してあります: (\S+)/.exec(err())?.[1];
    expect(mine).toBeDefined();
    expect(readFileSync(mine ?? '', 'utf8')).toBe('編集後の本文\n');
    expect(err()).toContain(`alteroid practice set review --file ${mine ?? ''}`);
    rmSync(dirname(mine ?? ''), { recursive: true, force: true });
  });
});

/** Issue #2853。`practice edit` は読んだ版を `ifMatch` に付け、衝突したら人間の編集を捨てない。 */
describe('alteroid practice edit の前提版（ifMatch）', () => {
  it('読んだ版（version）を ifMatch として PUT に付ける', async () => {
    captureStdout();
    process.env.EDITOR = `sh -c 'printf "編集後の本文\\n" > "$1"' _`;
    replies.push({ status: 200, body: { ...(practiceBody() as object), version: 'v-read' } });
    replies.push({ status: 200, body: {} });

    await practiceEditCommand('review', {});

    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: 'レビュー',
      title: 'レビューの進め方',
      content: '編集後の本文\n',
      ifMatch: 'v-read',
    });
  });

  it('無いやり方を作るときは ifMatch: null（読んだ時には無かった）', async () => {
    captureStdout();
    process.env.EDITOR = `sh -c 'printf "新しい本文\\n" > "$1"' _`;
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 200, body: {} });

    await practiceEditCommand('fresh', { kind: '調査', title: '調べもの' });

    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      kind: '調査',
      title: '調べもの',
      content: '新しい本文\n',
      ifMatch: null,
    });
  });

  it('409 のとき、人間が書いた内容を消さずに残し、パスと次の手を示して失敗する', async () => {
    const out = captureStdout();
    process.env.EDITOR = `sh -c 'printf "人間の編集\\n" > "$1"' _`;
    replies.push({ status: 200, body: { ...(practiceBody() as object), version: 'v-read' } });
    replies.push({
      status: 409,
      body: {
        error: '変わっています',
        current: {
          practice: {
            slug: 'review',
            kind: 'レビュー',
            title: 'レビューの進め方',
            content: 'クローンの書き直し\n',
          },
          version: 'v-now',
        },
      },
    });

    const error = await practiceEditCommand('review', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('書き換えませんでした');
    const text = out();
    const mine = /あなたの編集（残してあります）: (\S+)/.exec(text)?.[1];
    const theirs = /いまのやり方: (\S+)/.exec(text)?.[1];
    expect(mine).toBeDefined();
    expect(theirs).toBeDefined();
    expect(readFileSync(mine ?? '', 'utf8')).toBe('人間の編集\n');
    expect(readFileSync(theirs ?? '', 'utf8')).toContain('クローンの書き直し');
    expect(text).toContain('diff -u');
    expect(text).toContain('alteroid practice edit review');
    rmSync(dirname(mine ?? ''), { recursive: true, force: true });
  });
});

describe('alteroid practice show の版と remove --if-match（#2984）', () => {
  it('show は版を stderr に1行出し、stdout は本文だけのまま（パイプを壊さない）', async () => {
    const read = captureStdout();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    replies.push({
      status: 200,
      body: { ...(practiceBody() as object), version: 'v-shown' },
    });

    await practiceShowCommand('review');

    expect(read()).toBe('# レビュー\n\n差分より先に Issue を読む。\n');
    const errText = err.mock.calls.map((c) => String(c[0])).join('');
    expect(errText).toContain('v-shown');
    expect(errText).toContain('alteroid practice remove review --if-match v-shown');
    expect(errText.trimEnd().split('\n')).toHaveLength(1);
  });

  it('古いデーモンが version を返さなければ、stderr に何も出さない', async () => {
    captureStdout();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    replies.push({ status: 200, body: practiceBody() });

    await practiceShowCommand('review');

    expect(err).not.toHaveBeenCalled();
  });

  it('show --version（過去の版の本文）は stderr に版を出さない', async () => {
    captureStdout();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    replies.push({ status: 200, body: { version: { version: 1, content: '古い\n' } } });

    await practiceShowCommand('review', { version: 1 });

    expect(err).not.toHaveBeenCalled();
  });

  it('remove --if-match <版> は、その版で DELETE を打つ（事前の GET をしない）', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { ok: true, slug: 'review' } });

    await practiceRemoveCommand('review', { ifMatch: 'v-shown' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review?ifMatch=v-shown');
    expect(read()).toContain('消しました: review');
  });

  it('show で読んだ後に別の書き手が書いたなら、remove --if-match <show の版> は消さずに失敗する（再現）', async () => {
    const read = captureStdout();
    replies.push({
      status: 409,
      body: {
        error: 'x',
        current: {
          practice: { slug: 'review', kind: 'レビュー', title: '題', content: '新' },
          version: 'v-now',
        },
      },
    });

    const error = await practiceRemoveCommand('review', { ifMatch: 'v-shown' }).catch(
      (e: unknown) => e,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review?ifMatch=v-shown');
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消しませんでした');
    expect(read()).toContain('消していません: review');
  });

  it('428 の案内は --if-match の使い方を含む', async () => {
    captureStdout();
    replies.push({ status: 200, body: { practice: { slug: 'review' } } });
    replies.push({
      status: 428,
      body: { error: '消すやり方の版（ifMatch）が無いので、消していません', current: null },
    });

    const error = await practiceRemoveCommand('review').catch((e: unknown) => e);

    expect(String(error)).toContain('alteroid practice remove review --if-match <版>');
  });
});

describe('alteroid practice remove', () => {
  const practiceBody = (version?: string) => ({
    practice: { slug: 'review', kind: 'レビュー', title: '題', content: '本文\n' },
    ...(version === undefined ? {} : { version }),
  });

  it('読んだ版を ifMatch に付けて DELETE /practices/<slug> を打つ（#2959）', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody('v-read') });
    replies.push({ status: 200, body: { ok: true, slug: 'review' } });

    await practiceRemoveCommand('review');

    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[1]?.method).toBe('DELETE');
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/practices/review?ifMatch=v-read');
    expect(read()).toContain('消しました: review');
  });

  it('古いデーモン（段階1。version を返さず、版なしの削除を通す）には版を付けずに打つ', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody() });
    replies.push({ status: 200, body: { ok: true, slug: 'review' } });

    await practiceRemoveCommand('review');

    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/practices/review');
    expect(read()).toContain('消しました: review');
  });

  it('428（版なしを断られた）なら、消していないと言い、次の手を案内して失敗する（#2959）', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody() });
    replies.push({
      status: 428,
      body: { error: '消すやり方の版（ifMatch）が無いので、消していません', current: null },
    });

    const error = await practiceRemoveCommand('review').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain('消していません');
    expect(message).toContain('428');
    expect(message).toContain('alteroid practice show review');
    expect(message).toContain('alteroid practice remove review');
    expect(read()).not.toContain('消しました');
  });

  it('読めない形で入っている行（GET が 409）は版なしで DELETE を打つ（回復手段を塞がない）', async () => {
    const read = captureStdout();
    replies.push({ status: 409, body: { error: '読めない形で入っている' } });
    replies.push({ status: 200, body: { ok: true, slug: 'review' } });

    await practiceRemoveCommand('review');

    expect(sent[1]?.method).toBe('DELETE');
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/practices/review');
    expect(read()).toContain('消しました: review');
  });

  it('409（読んだ後に変わっていた）なら、消していないと言い、いまの版と次の手を案内して失敗する', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody('v-read') });
    replies.push({
      status: 409,
      body: {
        error: 'やり方が読んだ後に変わっています（消していません）',
        current: {
          practice: {
            slug: 'review',
            kind: 'レビュー',
            title: '題',
            content: 'クローンが書いた\n',
          },
          version: 'v-now',
        },
      },
    });

    const error = await practiceRemoveCommand('review').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消しませんでした');
    const text = read();
    expect(text).toContain('消していません: review');
    expect(text).toContain('v-now');
    expect(text).toContain('alteroid practice show review');
    expect(text).toContain('alteroid practice remove review');
    expect(text).not.toContain('消しました');
  });

  it('409 で current が null（読んだ後に消されていた）なら、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: practiceBody('v') });
    replies.push({ status: 409, body: { error: 'x', current: null } });

    await practiceRemoveCommand('review').catch(() => undefined);

    expect(read()).toContain('すでに消されています');
  });

  /**
   * デーモンは「無い」（404）と「名前として成立しない」（400）を分けている。
   * **こちらで1つに潰すと、直し方が読めなくなる**（打ち間違いなのか、消えたのか）。
   *
   * ⚠️ 2026-09-26（#1641）: 以前はどちらも `stdout.write` して正常 return して
   * いた（＝終了コードは常に 0）。いまは両方とも例外を投げる——アサーションは
   * 消さず、見る先を「書いた文字列」から「投げた例外の文言」へ反転した。
   */
  it('「無い」と「名前として不正」を混ぜない（どちらも例外を投げる。#1641）', async () => {
    // 先に読む（GET）。無いものは版なしで DELETE を打ち、サーバの 404 / 400 をそのまま伝える。
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 404, body: { error: 'not found' } });
    const missing = await practiceRemoveCommand('missing').catch((e: unknown) => e);
    expect(String(missing)).toContain('そんなやり方はありません');

    replies.push({ status: 400, body: { error: 'やり方のスラッグが不正' } });
    replies.push({ status: 400, body: { error: 'やり方のスラッグが不正' } });
    const invalid = await practiceRemoveCommand('..').catch((e: unknown) => e);
    expect(String(invalid)).toContain('名前として成立しません');
    expect(String(invalid)).not.toContain('そんなやり方はありません');
  });
});

/**
 * Issue #1641 本文の再現をそのまま歯にする（`memory.test.ts` の同名 describe と
 * 対になる）。`practice set` / `practice edit` は同じ内部関数 `write()` を
 * 共有するので、`practiceSetCommand` 経由で確かめれば `practiceEditCommand`
 * の失敗経路も同じコードで守られる。
 */
describe('#1641 の再現（Issue 本文）', () => {
  it('practice set: PUT が 500 なら投げる', async () => {
    replies.push({ status: 404, body: { error: 'not found' } }); // 既存を見に行く（read）
    replies.push({ status: 500, body: { error: '内部エラー' } }); // PUT

    await expect(
      practiceSetCommand('some-slug', { file: fileWith('本文\n'), kind: 'x', title: 'y' }),
    ).rejects.toThrow('内部エラー'); // デーモンが返した理由も添える（状態コードだけを見せない）
  });

  it('practice remove: DELETE が 500 なら投げる（「そんなやり方はありません」に化けない）', async () => {
    replies.push({
      status: 200,
      body: { practice: { slug: 'some-slug', kind: 'x', title: 'y', content: 'z' }, version: 'v' },
    });
    replies.push({ status: 500, body: { error: '内部エラー' } });

    const error = await practiceRemoveCommand('some-slug').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('そんなやり方はありません');
    expect(String(error)).toContain('内部エラー');
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
    // 読む先が無いので、本文を読む一手は出さない（1件以上の枝だけが出す）。
    expect(text).not.toContain('alteroid practice show');
  });

  /**
   * issue #2346。`GET /practices` が `unreadable`（読めない行。1件でも在るときだけ載る）を
   * 返すとき、読めた行が0件でも「1件も無い」「正常」と言わない。上の対照は、`unreadable` が
   * 無ければ今までどおり言う。
   */
  it('読めない行が在り、読めた行が0件のとき、「1件も無い」「正常」と言わない（#2346）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { practices: [], unreadable: [{ slug: 'bad-practice', reason: '不正な欄: kind' }] },
    });

    await practiceListCommand();

    const text = read();
    expect(text).toContain('読めないやり方が 1 件ある');
    expect(text).toContain('bad-practice');
    expect(text).toContain('不正な欄: kind');
    expect(text).toContain('消えたのではなく、読めない形で入っている');
    expect(text).toContain('読めたやり方は無い');
    expect(text).not.toContain('まだ1件も無い');
    expect(text).not.toContain('これは正常な状態');
  });

  it('読めない行と読めた行が両方在るとき、読めた行は出し、末尾に件数を足す（#2346）', async () => {
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
            chars: 30,
          },
        ],
        unreadable: [{ reason: '不正な行' }],
      },
    });

    await practiceListCommand();

    const text = read();
    expect(text).toContain('[レビュー] review  — レビューの進め方');
    expect(text).toContain('読めないやり方が 1 件ある');
    expect(text).toContain('（slug も取れない）');
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
            chars: 30,
          },
        ],
      },
    });

    await practiceListCommand();

    const text = read();
    expect(text).toContain('[レビュー] review  — レビューの進め方');
    expect(text).toContain('作成: 2026-09-20T00:00:00.000Z / 更新: 2026-09-21T00:00:00.000Z');
    expect(text).toContain('30 文字');
    // 一覧から本文へつなぐ一手（`memory list` と同じ形）。最後の行として出る。
    expect(text.trimEnd().split('\n').at(-1)).toBe('本文を読むには: alteroid practice show <slug>');
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
            chars: 1,
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
    replies.push({ status: 404, body: { error: 'not found' } });

    // 無いやり方は例外（終了コードが 0 でなくなる。`practice remove` と同じ。#2856）。
    await expect(practiceShowCommand('missing')).rejects.toThrow(
      'そんなやり方はありません: missing',
    );
  });
});

/**
 * `alteroid practice history` / `alteroid practice show --version`（#1309）。
 *
 * **CLI 専用の HTTP 経路は無い**——`GET /practices/:slug/versions(/:version)`
 * にそのまま乗る（`practice.ts` 冒頭の doc）。ここでは実際に打たれる経路と
 * 本文の形を確かめる。
 */
describe('alteroid practice history / show --version', () => {
  it('版の一覧を出す（メタだけ）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        versions: [
          {
            slug: 'review',
            version: 1,
            kind: 'レビュー',
            title: '旧題',
            at: '2026-09-20T00:00:00.000Z',
            chars: 3,
          },
          {
            slug: 'review',
            version: 2,
            kind: 'レビュー',
            title: 'レビューの進め方',
            at: '2026-09-21T00:00:00.000Z',
            chars: 30,
          },
        ],
      },
    });

    await practiceHistoryCommand('review');

    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review/versions');
    const text = read();
    expect(text).toContain('版1 [レビュー] 旧題');
    expect(text).toContain('版2 [レビュー] レビューの進め方');
    expect(text).toContain('practice show review --version');
  });

  it('版が1つも無ければ、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { versions: [] } });

    await practiceHistoryCommand('nothing-here');

    expect(read()).toContain('nothing-here の版はまだ無い');
  });

  it('show --version は過去の版の本文を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        version: {
          slug: 'review',
          version: 1,
          kind: 'レビュー',
          title: '旧題',
          at: '2026-09-20T00:00:00.000Z',
          chars: 6,
          content: '古い本文\n',
        },
      },
    });

    await practiceShowCommand('review', { version: 1 });

    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/practices/review/versions/1');
    expect(read()).toContain('古い本文');
  });

  it('無い版番号を指定したら、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(practiceShowCommand('review', { version: 999 })).rejects.toThrow(
      'そんな版はありません: review 版999',
    );
    expect(read()).toBe('');
  });
});

/**
 * 読み出しの失敗は、固定の文言や「無い」に化けさせず、状態コードとデーモンの理由を載せる
 * （PR #2175 / PR #2256 の残り）。
 */
describe('alteroid practice の読み出しの失敗の理由', () => {
  it('list: 500 + { error } なら、状態コードと理由を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '一覧が読めない（practice のテスト用）' } });

    const error = await practiceListCommand().then(
      () => null,
      (e: unknown) => e as Error,
    );

    // 例外で通す（＝終了コードが非 0 になる。#3452）。stdout に書いて 0 で返さない。
    expect(error?.message).toContain('やり方の一覧を読めませんでした（HTTP 500）');
    expect(error?.message).toContain('一覧が読めない（practice のテスト用）');
    expect(read()).toBe('');
  });

  it('list: 401 / 403 は describeAuthFailure の文で例外にする（#3452）', async () => {
    const read = captureStdout();
    replies.push({ status: 401, body: {} });
    await expect(practiceListCommand()).rejects.toThrow('認証されませんでした');
    replies.push({ status: 403, body: {} });
    await expect(practiceListCommand()).rejects.toThrow('access grant');
    expect(read()).toBe('');
  });

  it('history: 500 + { error } なら、状態コードと理由を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '履歴が読めない（practice のテスト用）' } });

    const error = await practiceHistoryCommand('review').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toContain('版の履歴を読めませんでした（HTTP 500）');
    expect(error?.message).toContain('履歴が読めない（practice のテスト用）');
    expect(read()).toBe('');
  });

  it('history: 401 は describeAuthFailure の文で例外にする（#3452）', async () => {
    const read = captureStdout();
    replies.push({ status: 401, body: {} });
    await expect(practiceHistoryCommand('review')).rejects.toThrow('認証されませんでした');
    expect(read()).toBe('');
  });

  it('show --version: 500 を「そんな版はありません」と言わず、理由を載せる', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '版が読めない（practice のテスト用）' } });

    const error = await practiceShowCommand('review', { version: 1 }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).not.toContain('そんな版はありません');
    expect(error?.message).toContain('HTTP 500');
    expect(error?.message).toContain('版が読めない（practice のテスト用）');
    expect(read()).toBe('');
  });

  it('show --version: 400 は「版番号として成立しません」で例外にする（#3452）', async () => {
    const read = captureStdout();
    replies.push({ status: 400, body: {} });
    await expect(practiceShowCommand('review', { version: 1 })).rejects.toThrow(
      '版番号として成立しません: 1',
    );
    expect(read()).toBe('');
  });

  it('show --version: 401 は describeAuthFailure の文で例外にする（#3452）', async () => {
    const read = captureStdout();
    replies.push({ status: 401, body: {} });
    await expect(practiceShowCommand('review', { version: 1 })).rejects.toThrow(
      '認証されませんでした',
    );
    expect(read()).toBe('');
  });

  it('show: 404 は「無い」のまま', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(practiceShowCommand('nothing')).rejects.toThrow(
      'そんなやり方はありません: nothing',
    );
  });

  it('show: 500 を「そんなやり方はありません」と言わず、理由を載せて投げる', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: 'やり方が読めない（practice のテスト用）' } });

    const error = await practiceShowCommand('review').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).toContain('やり方が読めない（practice のテスト用）');
    expect(read()).not.toContain('そんなやり方はありません');
  });

  it('set: 読み出しが 500 なら、無いものとして新規に書きに行かない（PUT を打たない）', async () => {
    captureStdout();
    replies.push({ status: 500, body: { error: 'やり方が読めない（practice のテスト用）' } });

    const error = await practiceSetCommand('review', {
      file: fileWith('本文\n'),
      kind: '調査',
      title: '題',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('やり方が読めない（practice のテスト用）');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
  });
});
