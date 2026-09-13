import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-memory-test-'));
    const path = join(dir, 'values.md');
    await writeFile(path, '# 価値観\n\n嘘をつかない。\n', 'utf8');
    replies.push({ status: 200, body: { document: { slug: 'values', content: 'x' } } });

    try {
      await memorySetCommand('values', { file: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

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

  it('書き換えられなければ、書き換えたとは言わない', async () => {
    const read = captureStdout();
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-memory-test-'));
    const path = join(dir, 'x.md');
    await writeFile(path, 'なにか', 'utf8');
    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });

    try {
      await memorySetCommand('..', { file: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const text = read();
    expect(text).toContain('書き換えられませんでした');
    expect(text).not.toContain('次の会話から');
  });
});

describe('alteroid memory remove', () => {
  it('DELETE /memory/<slug> を打つ', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { ok: true, slug: 'values' } });

    await memoryRemoveCommand('values');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/memory/values');
    expect(read()).toContain('消しました: values');
  });

  /**
   * デーモンは「無い」（404）と「名前として成立しない」（400）を分けている。
   * **こちらで1つに潰すと、直し方が読めなくなる**（打ち間違いなのか、消えたのか）。
   */
  it('「無い」と「名前として不正」を混ぜない', async () => {
    const read = captureStdout();
    replies.push({ status: 404, body: { error: 'not found' } });
    await memoryRemoveCommand('missing');
    expect(read()).toContain('そんな記憶はありません');

    vi.restoreAllMocks();
    const read2 = captureStdout();
    replies.push({ status: 400, body: { error: '記憶のスラッグが不正' } });
    await memoryRemoveCommand('..');
    const text = read2();
    expect(text).toContain('名前として成立しません');
    expect(text).not.toContain('そんな記憶はありません');
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
            // （AGENTS.md「テストの足場・スタブ・モックは、動くのに嘘をつく」）。
            // アサーションは1文字も変えていない。
            createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
            updatedAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      },
    });

    await memoryListCommand();

    expect(read()).toContain('values  — 価値観');
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

    await memoryListCommand();

    const text = read();
    expect(text).toContain('作成: 2026-08-10T00:00:00.000Z / 更新: 2026-08-15T00:00:00.000Z');
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
