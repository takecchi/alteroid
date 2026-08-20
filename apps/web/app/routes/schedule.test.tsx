// @vitest-environment jsdom
/**
 * 継続する依頼を、**画面から仕込めて外せる**こと。
 *
 * PRD「インターフェース」は3面（CLI・HTTP API・Web UI）で同じことができると書いて
 * おり、起こせることの列挙に「定期ジョブ」がある。CLI は `/schedule <kind> <周期>
 * <依頼>` と `/unschedule <kind>` を持っていたのに、画面は「今すぐ回す」だけだった。
 *
 * 一覧の側も見る。`request` と `lastRunAt` は CLI には出ていて画面に無かったもので、
 * **これが無いと「仕込んだのに一度も動いていない」ことに気づけない**（#96 が直した
 * 位相の消失がまさにその形で出る）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Schedule from './schedule';

interface Sent {
  url: string;
  method: string;
  /** 本文は読むのが非同期なので、掴んでおいて照合の側で開ける。 */
  read: () => Promise<unknown>;
}

let originalFetch: typeof fetch;
let sent: Sent[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sent = [];
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** 既定の仕込み（本文も周期も持たない）。 */
const DEFAULT_ENTRY = {
  kind: 'daily_report',
  description: '毎日 22:00 に日報',
  nextAt: '2026-08-20T22:00:00.000Z',
};

/** 人間かクローンが仕込んだ継続中の依頼。 */
const REQUEST_ENTRY = {
  kind: 'morning-issues',
  description: '毎日 09:00',
  nextAt: '2026-08-21T09:00:00.000Z',
  request: '朝いちで issue を見て、進められるものを進めておいて',
};

/**
 * `fetch` を自分で差し替える。
 *
 * **共有の `stubFetch` は使えない。** あちらが route へ渡すのは URL と `init` だけ
 * だが、`openapi-fetch` は `fetch(new Request(...))` の形で呼ぶので `init` が
 * `undefined` になり、**method も本文も落ちる**（それで「何も送っていない」と
 * 同じ見え方になった）。何を送ったかを見ないと、経路が合っているだけのテストになる。
 */
function stubSchedule(entries: unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/schedule')) {
      // 知らない URL は「繋がらない」（経路の書き忘れを空の応答で通さない）。
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'GET') return Promise.resolve(json({ entries }));

    sent.push({
      url,
      method,
      read: async () => {
        if (request !== null) return (await request.json()) as unknown;
        return typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
      },
    });
    return Promise.resolve(json({ ok: true }));
  }) as typeof fetch;
}

function renderSchedule(): void {
  render(
    <Providers>
      <Schedule />
    </Providers>,
  );
}

describe('継続する依頼を仕込む', () => {
  async function fill(kind: string, request: string): Promise<void> {
    const kindBox = await screen.findByPlaceholderText(/kind/);
    fireEvent.change(kindBox, { target: { value: kind } });
    const requestBox = screen.getByPlaceholderText(/依頼の本文/);
    fireEvent.change(requestBox, { target: { value: request } });
  }

  it('毎日この時刻（daily）で仕込める', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await fill('morning-issues', '朝いちで issue を見ておいて');
    fireEvent.click(screen.getByRole('button', { name: '仕込む' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toContain('/schedule');
    await expect(sent[0]?.read()).resolves.toEqual({
      kind: 'morning-issues',
      request: '朝いちで issue を見ておいて',
      spec: { type: 'daily', at: '09:00' },
    });
  });

  /**
   * **cron を画面から落とさない。** 曜日や月の指定は cron でしか書けず、
   * 「毎日起きて曜日を見て何もしない」で代用すると7回に6回はターンを空焼きする。
   */
  it('cron 式でも仕込める（曜日の指定が画面からできる）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await fill('weekly-review', '週明けに設計を見直して');
    fireEvent.change(screen.getByLabelText('周期'), { target: { value: 'cron' } });
    fireEvent.change(screen.getByLabelText('cron 式'), { target: { value: '0 10 * * 1' } });
    fireEvent.click(screen.getByRole('button', { name: '仕込む' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await expect(sent[0]?.read()).resolves.toEqual({
      kind: 'weekly-review',
      request: '週明けに設計を見直して',
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
  });

  it('分ごと（every）は数値として送る（文字列にしない）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await fill('poll', 'Slack を見てきて');
    fireEvent.change(screen.getByLabelText('周期'), { target: { value: 'every' } });
    fireEvent.change(screen.getByLabelText('分'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: '仕込む' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await expect(sent[0]?.read()).resolves.toEqual({
      kind: 'poll',
      request: 'Slack を見てきて',
      spec: { type: 'every', minutes: 45 },
    });
  });

  it('kind か本文が空なら送らない（空の依頼を仕込めない）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    const button = await screen.findByRole('button', { name: '仕込む' });
    fireEvent.click(button);

    expect(sent).toEqual([]);
    // 押せないことは見た目でも分かる（黙って無反応にしない）。
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});

describe('継続中の依頼を外す', () => {
  it('依頼には「外す」があり、DELETE を打つ', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: '外す' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toContain('/schedule/morning-issues');
  });

  /**
   * 既定の仕込み（日報・発意 tick）はデーモンが名前を守っているので外せない。
   * **ボタンだけ消すと、押せない理由が画面から消える**ので、代わりに書く。
   */
  it('既定の仕込みには「外す」を出さず、外せない理由を書く', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    expect(await screen.findByText('既定（外せない）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '外す' })).toBeNull();
  });
});

describe('一覧が依頼の本文と前回の発火を出す', () => {
  it('継続中の依頼は本文と前回時刻を出す', async () => {
    stubSchedule([{ ...REQUEST_ENTRY, lastRunAt: '2026-08-20T09:00:00.000Z' }]);
    renderSchedule();

    expect(await screen.findByText(/朝いちで issue を見て/)).toBeTruthy();
    expect(screen.getByText(/前回:/)).toBeTruthy();
  });

  /**
   * **「まだ一度も動いていない」を空欄にしない。** 次回時刻だけを見せると、
   * 一度も発火していない仕込みが「これから動く」と同じ顔で並ぶ。
   */
  it('一度も動いていなければ、そう書く', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    expect(await screen.findByText(/まだ一度も動いていない/)).toBeTruthy();
  });

  it('既定の仕込みには本文も前回も出さない（持っていないものを描かない）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await screen.findByText('既定（外せない）');
    expect(screen.queryByText(/前回:/)).toBeNull();
  });
});
