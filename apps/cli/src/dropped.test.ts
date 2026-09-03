import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid dropped` の**文言**と、口ごとに違う書き方をしていないかを測る。
 *
 * ここで固定したいのは「無い」の3種類を混ぜないこと ——
 *
 * 1. **取りに行けなかった**（404 = この口を持たない古いデーモン／接続失敗）
 * 2. **取りに行けたが0件**（`describeDroppedTraceEmpty()` の文言）
 * 3. **runner の跡はここには出ない**（`describeDroppedTraceOrigin` の文言。
 *    0件でも件数があっても常に出す）
 *
 * `renderDropped`（純粋関数）だけでなく、実際に端末へ書く `droppedCommand`
 * （書く側）も測る。理由は `runners.test.ts` の冒頭 doc と同じ（#361）。
 */
vi.mock('./target.js', () => ({
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const { renderDropped, droppedCommand } = await import('./dropped.js');
const target = await import('./target.js');

interface Sent {
  url: string;
  method: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];
let rejectNext = false;

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (rejectNext) {
      rejectNext = false;
      return Promise.reject(new TypeError('fetch failed（接続できない）'));
    }
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({ url, method: init?.method ?? request.method ?? 'GET' });
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
  rejectNext = false;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const EMPTY_VIEW = {
  origin: 'daemon' as const,
  since: '2026-09-01T00:00:00.000Z',
  limit: 200,
  total: 0,
  traces: [] as string[],
};

const VIEW_WITH_TRACES = {
  origin: 'daemon' as const,
  since: '2026-09-01T00:00:00.000Z',
  limit: 200,
  total: 2,
  traces: [
    'alteroid: 2026-09-01T00:00:01.000Z 記録できませんでした: Error: 古い方',
    'alteroid: 2026-09-01T00:00:02.000Z 記録できませんでした: Error: 新しい方',
  ],
};

describe('renderDropped', () => {
  it('0件でも、何の跡かを常に出す（runner はここに出ないこと）', () => {
    const text = renderDropped(EMPTY_VIEW);
    expect(text).toContain('別プロセスの runner が残した跡はここには出ない');
    expect(text).toContain('このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない');
  });

  it('件数があっても、何の跡かを出す（3を混ぜない）', () => {
    const text = renderDropped(VIEW_WITH_TRACES);
    expect(text).toContain('別プロセスの runner が残した跡はここには出ない');
  });

  it('件数があるとき、跡を古い順（末尾が最新）に全件出す', () => {
    const text = renderDropped(VIEW_WITH_TRACES);
    const [older, newer] = VIEW_WITH_TRACES.traces;
    expect(text).toContain(older);
    expect(text).toContain(newer);
    expect(text.indexOf(older!)).toBeLessThan(text.indexOf(newer!));
  });

  it('保持のしかた（limit）と数え始めた時刻を出す', () => {
    const text = renderDropped(VIEW_WITH_TRACES);
    expect(text).toContain('帳面が数え始めた時刻: 2026-09-01T00:00:00.000Z');
    expect(text).toContain('直近 200 件までしか持たず');
  });
});

describe('droppedCommand', () => {
  it('0件なら空の帳面の文言を書く（GET /dropped を叩く）', async () => {
    replies.push({ status: 200, body: EMPTY_VIEW });
    const read = captureStdout();

    await droppedCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/dropped');
    expect(sent[0]?.method).toBe('GET');
    expect(read()).toBe(`${renderDropped(EMPTY_VIEW)}\n`);
  });

  it('件数があれば跡を書く', async () => {
    replies.push({ status: 200, body: VIEW_WITH_TRACES });
    const read = captureStdout();

    await droppedCommand();

    expect(read()).toBe(`${renderDropped(VIEW_WITH_TRACES)}\n`);
  });

  /**
   * **404 は「この口を持たない古いデーモン」であって、「跡が無い」ではない。**
   * 0件の文言（`describeDroppedTraceEmpty` を含む文）とは別の文字列にする —
   * 同じ文言だと、人間は「握り潰しは起きていない」と読み、実際には「そもそも
   * この版のデーモンに聞けていない」ことに気づけない。
   */
  it('404（この口を持たない古いデーモン）は、0件と違う文言を書く', async () => {
    replies.push({ status: 404, body: {} });
    const read = captureStdout();

    await droppedCommand();

    const text = read();
    expect(text).not.toContain(
      'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない',
    );
    expect(text).toContain('版が古い可能性がある');
  });

  it('応答が失敗（404 以外の ok でない）なら、読めなかったと書く', async () => {
    replies.push({ status: 500, body: {} });
    const read = captureStdout();

    await droppedCommand();

    expect(read()).toBe('握り潰しの跡を読めませんでした\n');
  });

  /**
   * **接続失敗（デーモンに繋がらない）は握り潰さない。** ここで catch して
   * 別の文言に変えることはせず、他の読み取り専用コマンド（`runners.ts` /
   * `usage.ts` / `conversations.ts`）と同じく例外をそのまま呼び出し元へ通す
   * （`index.ts` の `program.parseAsync(...).catch(...)` が最終的に受ける）。
   */
  it('接続に失敗したら例外がそのまま伝わる（握り潰さない）', async () => {
    rejectNext = true;

    await expect(droppedCommand()).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('ログインしていなければ note をそのまま書き、dropped を叩かない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await droppedCommand();

    expect(sent).toHaveLength(0);
    expect(read()).toBe('https://runner.example.com にログインしていません（alteroid login）\n');
  });
});
