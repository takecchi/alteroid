import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout } from './test-support.js';

/**
 * `alteroid memory` — 記憶を人間が CLI から直せること。
 *
 * **`fetch` を差し替えて、本物の型付きクライアント（`hono/client`）を通す。**
 * 手書きのスタブを client の位置に置くと、経路名や本文の形が実物と一致している
 * ことを1つも確かめられない（`chat.test.ts` の `stubClient` がまさにその形で、
 * あちらは「どの経路へどんな引数で行くか」だけを見ると自分で断っている）。
 * ここで見たいのは **`PUT /memory/<slug>` が実際に組み立てられるか**なので、
 * 差し替えるのはもっと外側（`fetch`）にする。
 */
vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
  describeAuthFailure: () => null,
}));

const {
  freshnessMarker,
  memoryEditCommand,
  memoryListCommand,
  memoryRemoveCommand,
  memorySetCommand,
  memoryShowCommand,
} = await import('./memory.js');

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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid memory set', () => {
  it('ファイルの内容を PUT /memory/<slug> へ全文置換で送る', async () => {
    const read = captureStdout();
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'values.md');
    await writeFile(path, '# 価値観\n\n嘘をつかない。\n', 'utf8');
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });

    await memorySetCommand('values', { file: path });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/memory/values');
    // **本文の形も見る。** `{ content }` は `memoryBody`（デーモン側）の形である。
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      content: '# 価値観\n\n嘘をつかない。\n',
    });
    // どこに効くかを言う（言わないと、書けたのに反映を待つ人が出る）。
    expect(read()).toContain('次の会話からクローンの判断に入ります');
  });

  /**
   * ⚠️ 2026-09-26（#1641）: 「書き換えたとは言わない」の確かめ方を、stdout の
   * 文言から**例外**へ移した。以前はここで `stdout.write` して正常 return して
   * いたため、終了コードは常に 0 だった——`reset.ts` / `access.ts` / `token.ts` /
   * `alteroid interrupt`（#1621）と同じ形に揃え、失敗を例外で上へ通す（＝
   * 終了コードが 0 でなくなる）ようにした。アサーションは消さず、見る先を
   * 「書いた文字列」から「投げた例外の文言」へ反転しただけである——保証して
   * いること（「書き換えられませんでした」を言う／「次の会話から」を言わない）
   * は変わらない。
   */
  it('書き換えられなければ、書き換えたとは言わない（例外の文言で確かめる。#1641）', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });

    const error = await memorySetCommand('..', { file: path }).catch((e: unknown) => e);

    expect(String(error)).toContain('書き換えられませんでした');
    expect(String(error)).not.toContain('次の会話から');
  });
});

describe('alteroid memory remove', () => {
  it('読んだ版を ifMatch に付けて DELETE /memory/<slug> を打つ（#2881）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });

    await memoryRemoveCommand('values');

    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[1]?.method).toBe('DELETE');
    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values?ifMatch=v-read');
    expect(read()).toContain('消しました: values');
  });

  it('古いデーモン（version を返さない）には版を付けずに打ち、返ってきた警告を見せる', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });
    replies.push({
      status: 200,
      body: { ok: true, slug: 'values', warning: '版の照合なしで消しました' },
    });

    await memoryRemoveCommand('values');

    expect(sent[1]?.url).toBe('http://127.0.0.1:4517/memory/values');
    expect(read()).toContain('注意: 版の照合なしで消しました');
  });

  it('409（読んだ後に変わっていた）なら、消していないと言い、いまの版と次の手を案内して失敗する（#2881）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
    });
    replies.push({
      status: 409,
      body: {
        error: '記憶が読んだ後に変わっています（消していません）',
        current: {
          document: { slug: 'values', content: '# 価値観\n\nクローンが蒸留\n' },
          version: 'v-now',
        },
      },
    });

    const error = await memoryRemoveCommand('values').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('消しませんでした');
    const text = read();
    expect(text).toContain('消していません: values');
    expect(text).toContain('v-now');
    expect(text).toContain('alteroid memory show values');
    expect(text).toContain('alteroid memory remove values');
    expect(text).not.toContain('消しました');
  });

  it('409 で current が null（読んだ後に消されていた）なら、そう言う', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: { document: { slug: 'values', content: 'x' }, version: 'v' },
    });
    replies.push({ status: 409, body: { error: 'x', current: null } });

    await memoryRemoveCommand('values').catch(() => undefined);

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
    // 先に読む（GET。無ければ null）。無いものは版なしで DELETE を打ち、サーバの 404 / 400 をそのまま伝える。
    replies.push({ status: 404, body: { error: 'not found' } });
    replies.push({ status: 404, body: { error: 'not found' } });
    const missing = await memoryRemoveCommand('missing').catch((e: unknown) => e);
    expect(String(missing)).toContain('そんな記憶はありません');

    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });
    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });
    const invalid = await memoryRemoveCommand('..').catch((e: unknown) => e);
    expect(String(invalid)).toContain('名前として成立しません');
    expect(String(invalid)).not.toContain('そんな記憶はありません');
  });
});

/**
 * Issue #1641 本文の再現をそのまま歯にする。
 *
 * 本文はこう言っていた——「401（認証切れ）でも 500 でも『名前が不正』と案内
 * する」「500 でも『無い』と言う」。ここではその2つの取り違えが**もう起きない
 * こと**（401/500 は 400/404 の案内に化けず、例外として上へ通ること）を確かめる。
 */
describe('#1641 の再現（Issue 本文）', () => {
  it('memory set: PUT が 500 なら投げる', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 500, body: { error: '内部エラー' } });

    // デーモンが返した理由も添える（状態コードだけを見せない）。
    await expect(memorySetCommand('some-slug', { file: path })).rejects.toThrow('内部エラー');
  });

  it('memory set: PUT が 401 なら投げる（名前が不正、と案内しない）', async () => {
    const dir = await makeTempDir('alteroid-memory-test-');
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 401, body: {} });

    const error = await memorySetCommand('some-slug', { file: path }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('名前が不正');
  });

  it('memory remove: DELETE が 500 なら投げる（「そんな記憶はありません」に化けない）', async () => {
    replies.push({
      status: 200,
      body: { document: { slug: 'some-slug', content: 'x' }, version: 'v' },
    });
    replies.push({ status: 500, body: { error: '内部エラー' } });

    const error = await memoryRemoveCommand('some-slug').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('そんな記憶はありません');
    // デーモンが返した理由も添える（状態コードだけを見せない）。
    expect(String(error)).toContain('内部エラー');
  });
});

describe('alteroid memory list / show', () => {
  it('空なら「0 件」で終わらせず、次の一手を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { documents: [] } });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('記憶はまだ空です');
    expect(text).toContain('alteroid memory edit');
    // 読む先が無いので、本文を読む一手は出さない（1件以上の枝だけが出す）。
    expect(text).not.toContain('alteroid memory show');
  });

  it('一覧は slug と題を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'values',
            title: '価値観',
            kind: 'premise',
            descriptionFreshness: { kind: 'absent' },
            // `GET /memory` はこの2つを**必須**で返す（`createdAt` は #220 から）。
            // **足場が返さないのは、足場が契約に追いついていないということである**
            // （`.claude/agents-md-records/delegation.md` の「テストの足場・スタブ・
            // モックは、動くのに嘘をつく」——この項は #1758 で AGENTS.md「作業者へ
            // 切り出す」から移った）。
            // アサーションは1文字も変えていない。
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('values  — 価値観');
    // 一覧から本文へつなぐ一手（`conversations list` の「中身を読むには」と同じ形）。
    // 一覧の行より後、最後の行として出る。
    expect(text.trimEnd().split('\n').at(-1)).toBe('本文を読むには: alteroid memory show <slug>');
  });

  it('区分と要旨・鮮度の印を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'runbook',
            title: '定点観測',
            kind: 'fact',
            description: '費用の推移',
            descriptionFreshness: {
              kind: 'stale',
              staleForMs: 60 * 60 * 1000,
              drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
            },
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('[fact] runbook');
    // #821 — 「⚠」ではなく、どれだけ古いかを数で言う（語ではなく数で測る）。
    // #913 — 期間に加えて、本文の変化量も数で言う（期間フレーズは置き換えない）。
    expect(text).toContain(
      '要旨は本文より1時間古い（本文は+200バイト（+40%）変わった）: 費用の推移',
    );
  });

  it('無い記憶を読もうとしたら、そう言う（空の本文と区別する）', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await memoryShowCommand('missing');

    expect(read()).toContain('そんな記憶はありません: missing');
  });

  /**
   * `createdAt` は `{kind:'known',at}` / `{kind:'unknown'}` の2状態（#220）。
   * **`unknown` は「不明」と明言する**——クローンの `memory_list`
   * （`formatMemoryCreatedAt`）と同じ言葉。片方だけ空欄にすると、人間とクローンが
   * 同じ記憶を見て違う判断をする。**1つの一覧に両方並べる**——1種類だけだと
   * 写像が定数（常に同じ文字列を返す）でも通ってしまう。
   */
  it('作成時刻は known なら ISO、unknown なら「不明」を出す（1つの一覧に両方並べる）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        documents: [
          {
            slug: 'values',
            title: '価値観',
            kind: 'premise',
            descriptionFreshness: { kind: 'absent' },
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
          {
            slug: 'runbook',
            title: '定点観測',
            kind: 'fact',
            descriptionFreshness: { kind: 'absent' },
            createdAt: { kind: 'unknown' },
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      },
    });

    // **`now` を固定する**（issue #2141 段1で「作成」の横に経過を添えるように
    // なった——器の実行時刻に依存させないため、ここで明示的に渡す）。
    await memoryListCommand(new Date('2026-08-11T00:00:00.000Z').getTime());

    const text = read();
    expect(text).toContain(
      '作成: 2026-08-10T00:00:00.000Z（1日前） / 更新: 2026-08-15T00:00:00.000Z',
    );
    // **`unknown` の倒れ先は「不明」のまま**——経過を添えない（読めないのに
    // `0分前` のような値を作らない）。
    expect(text).toContain('作成: 不明 / 更新: 2026-08-12T00:00:00.000Z');
  });
});

/**
 * #821 — CLI 側の印（`freshnessMarker`）も core と同じ理由で直す
 * （常に鳴る ⚠ は他の ⚠ への感度も下げる、というクローンの理由は表示面を
 * 問わない）。core 側（`memory.test.ts`）と同じ観点をここでも撃つ——
 * 語ではなく数で測ること（条件2）、取れなかったのと0を区別すること（条件1）。
 */
describe('freshnessMarker（CLI 側の印。core と別実装だが同じ理由で直す、#821）', () => {
  it('stale の印は差の大きさで文字列が変わる（1時間差と30日差）', () => {
    const oneHour = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });
    const thirtyDays = freshnessMarker({
      kind: 'stale',
      staleForMs: 30 * 24 * 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });

    expect(oneHour).toContain('1時間');
    expect(thirtyDays).toContain('30日');
    expect(oneHour).not.toBe(thirtyDays);
  });

  it('unknown（記録なし）と fresh（正直なゼロ）は別の言葉で出る', () => {
    const unknown = freshnessMarker({ kind: 'unknown' });
    const fresh = freshnessMarker({ kind: 'fresh' });

    expect(unknown).not.toBe(fresh);
    expect(unknown).toContain('記録されていない');
    expect(unknown).not.toMatch(/\d+(秒|分|時間|日)/);
    expect(fresh).toContain('本文は動いていない');
  });

  it('absent は何も出さない', () => {
    expect(freshnessMarker({ kind: 'absent' })).toBe('');
  });

  /**
   * #821 残課題: `at-least`（基準点はあるが要旨を書いた時点のものではない）
   * を `measured`（% つき）とも `unrecorded` とも別の言葉で出す。下限を
   * 確定値に見せる変異——`at-least` を `measured` と同じ形式で言わせる——を
   * ここで検出する。`baselineAt` も刷らない。
   */
  it('at-least は measured（%つき）とも unrecorded とも別の言葉で出る。baselineAt は刷らない（#821 残課題）', () => {
    const atLeast = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: {
        kind: 'at-least',
        baselineBytes: 1000,
        baselineAt: '2026-08-20T12:00:00Z',
        currentBytes: 1200,
        deltaBytes: 200,
      },
    });
    const measured = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
    });
    const unrecorded = freshnessMarker({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });

    expect(atLeast).not.toBe(measured);
    expect(atLeast).not.toBe(unrecorded);
    expect(atLeast).toContain('以上変わった');
    expect(atLeast).not.toContain('%');
    expect(measured).toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
  });
});

/**
 * 読み出しの失敗は、固定の文言や「無い」に化けさせず、状態コードとデーモンの理由を載せる
 * （PR #2175 / PR #2256 の残り）。
 */
describe('alteroid memory の読み出しの失敗の理由', () => {
  it('list: 500 + { error } なら、状態コードと理由を出す', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '一覧が読めない（memory のテスト用）' } });

    await memoryListCommand();

    const text = read();
    expect(text).toContain('記憶の一覧を読めませんでした（HTTP 500）');
    expect(text).toContain('一覧が読めない（memory のテスト用）');
  });

  it('show: 404 は「無い」のまま', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });

    await memoryShowCommand('nothing');

    expect(read()).toContain('そんな記憶はありません: nothing');
  });

  it('show: 500 を「そんな記憶はありません」と言わず、理由を載せて投げる', async () => {
    const read = captureStdout();
    replies.push({ status: 500, body: { error: '記憶が読めない（memory のテスト用）' } });

    const error = await memoryShowCommand('values').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).toContain('記憶が読めない（memory のテスト用）');
    expect(read()).not.toContain('そんな記憶はありません');
  });

  it('edit: 読み出しが 500 なら、あるはずの記憶を無いものとして空のひな形でエディタを開かない', async () => {
    captureStdout();
    const savedEditor = process.env.EDITOR;
    // 開いてしまえば、保存して PUT（上書き）へ進む。開かなければ GET の1本で止まる。
    process.env.EDITOR = `sh -c 'printf "空のひな形で上書き\\n" > "$1"' _`;
    replies.push({ status: 500, body: { error: '記憶が読めない（memory のテスト用）' } });

    try {
      const error = await memoryEditCommand('values').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('記憶が読めない（memory のテスト用）');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe('GET');
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
    }
  });

  /** Issue #2743: 読んだ版を持ち回り、エディタを開いている間の別の書き手を黙って消さない。 */
  describe('edit の前提の版（Issue #2743）', () => {
    let savedEditor: string | undefined;
    beforeEach(() => {
      savedEditor = process.env.EDITOR;
      // 保存して閉じる、を模す（人間が1行足した）。
      process.env.EDITOR = `sh -c 'printf "人間の編集\\n" > "$1"' _`;
    });
    afterEach(() => {
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
    });

    it('GET で読んだ version を、PUT の ifMatch に載せる', async () => {
      captureStdout();
      replies.push({
        status: 200,
        body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
      });
      replies.push({ status: 200, body: {} });

      await memoryEditCommand('values');

      expect(sent[1]?.method).toBe('PUT');
      expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
        content: '人間の編集\n',
        ifMatch: 'v-read',
      });
    });

    it('無い記憶を作るときは ifMatch: null（読んだ時には無かった）', async () => {
      captureStdout();
      replies.push({ status: 404, body: { error: 'not found' } });
      replies.push({ status: 200, body: {} });

      await memoryEditCommand('values');

      expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ content: '人間の編集\n', ifMatch: null });
    });

    it('409 のとき、人間が書いた内容を消さずに残し、パスと次の手を示して失敗する', async () => {
      const out = captureStdout();
      replies.push({
        status: 200,
        body: { document: { slug: 'values', content: '# 価値観\n' }, version: 'v-read' },
      });
      replies.push({
        status: 409,
        body: {
          error: '変わっています',
          current: {
            document: { slug: 'values', content: '# 価値観\n\nクローンの判断\n' },
            version: 'v-now',
          },
        },
      });

      const error = await memoryEditCommand('values').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('書き換えませんでした');
      const text = out();
      const mine = /あなたの編集（残してあります）: (\S+)/.exec(text)?.[1];
      const theirs = /いまの記憶: (\S+)/.exec(text)?.[1];
      expect(mine).toBeDefined();
      expect(theirs).toBeDefined();
      // 人間が書いた内容も、いまの版も、読める形で残っている。
      expect(await readFile(mine ?? '', 'utf8')).toBe('人間の編集\n');
      expect(await readFile(theirs ?? '', 'utf8')).toContain('クローンの判断');
      expect(text).toContain('diff -u');
      expect(text).toContain('alteroid memory edit values');
      await rm(dirname(mine ?? ''), { recursive: true, force: true });
    });
  });
});
