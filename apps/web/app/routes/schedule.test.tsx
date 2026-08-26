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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 * 編集の対象になる、周期（`spec`）も持つ継続中の依頼（#496）。
 *
 * `REQUEST_ENTRY` はわざと `spec` を持たない——「古いデーモン（#496 より前）と
 * 話している」場合の歯に使う。
 */
const SPEC_ENTRY = {
  kind: 'morning-issues',
  description: '毎日 09:00（ローカル時刻）: 朝いちで issue を見て、進められるものを進めておいて',
  nextAt: '2026-08-21T09:00:00.000Z',
  request: '朝いちで issue を見て、進められるものを進めておいて',
  spec: { type: 'daily', at: '09:00' },
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

/**
 * 横並びの積み替え（本4-B）。
 *
 * 一覧の行（`li`）は「本文＋kind」「次回時刻＋バッジ（shrink-0）」「今すぐ
 * 回す/外すボタン」の3〜4要素が横に並ぶが、`flex-wrap` が無かった。本3 で
 * `Button` が狭い画面で `h-11`（44px）になった分、以前より横幅を食う。
 *
 * 併せて `entry.kind` は `scheduleKindSchema`（`min(1).max(64)`、
 * `[a-z0-9._-]` のみ）——空白を持たない最大64字の機械可読トークンなので、
 * `min-w-0 flex-1` の中でもテキスト自体がはみ出しうる。`break-words` を足した。
 *
 * **⚠️ これは「折り返した」「積み替わった」ことの試験ではない。** jsdom は
 * レイアウトを持たない（`offsetWidth` / `scrollWidth` /
 * `getBoundingClientRect()` はすべて 0）ので、`flex-wrap` / `break-words` が
 * 実際に効いているかはここでは1つも観測できない。固定できるのは
 * 「そのクラス名が書かれていること」までである。
 */
describe('横並びの積み替え（本4-B）: flex-wrap と break-words', () => {
  it('一覧の行（li）に flex-wrap が付いている', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    const description = await screen.findByText('毎日 22:00 に日報');
    const li = description.closest('li');
    expect(li).not.toBeNull();
    const tokens = li!.className.split(/\s+/);
    expect(tokens).toContain('flex-wrap');
  });

  it('kind の表示に break-words が付いている', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    const kind = await screen.findByText('daily_report');
    const tokens = kind.className.split(/\s+/);
    expect(tokens).toContain('break-words');
  });
});

/**
 * 仕込まれた依頼の周期・本文を画面から直せること（#496）。
 *
 * `POST /schedule` は upsert なので新しい HTTP verb は無い——`useCreateSchedule`
 * をそのまま使う。守るのは3つ: (1) 仕込まれた依頼だけに「編集」が出る (2) 開くと
 * いまの周期・本文が入っている (3) 保存すると同じ kind へ直した値が飛ぶ。
 */
describe('仕込まれた依頼を編集できる（#496）', () => {
  it('仕込まれた依頼には「編集」が在り、既定の日報・発意には無い', async () => {
    stubSchedule([DEFAULT_ENTRY, SPEC_ENTRY]);
    renderSchedule();

    // 仕込まれた依頼（SPEC_ENTRY）の行にだけ「編集」が出る。
    await screen.findByText('daily_report');
    expect(screen.getAllByRole('button', { name: '編集' })).toHaveLength(1);
  });

  it('開くと、いまの周期（時刻）と本文が入っている', async () => {
    stubSchedule([SPEC_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));

    const panel = await screen.findByRole('group', { name: `${SPEC_ENTRY.kind} を編集` });

    // 周期: daily の時刻欄に、仕込まれた spec（09:00）が入っている。
    const at = within(panel).getByLabelText('時刻') as HTMLInputElement;
    expect(at.value).toBe('09:00');

    // 本文: 既存の依頼なのでプレビューが既定（下のテストで別途確認）。
    // ここでは「編集」タブへ切り替えて textarea の値そのものを見る。
    fireEvent.mouseDown(within(panel).getByRole('tab', { name: '編集' }));
    const textarea = (await within(panel).findByPlaceholderText(
      /依頼の本文/,
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe(SPEC_ENTRY.request);
  });

  it('本文のタブは、既存の依頼を編集するときはプレビューが既定である', async () => {
    stubSchedule([SPEC_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    const panel = await screen.findByRole('group', { name: `${SPEC_ENTRY.kind} を編集` });

    // プレビューが Markdown として本文を描いている（編集タブの textarea は
    // 非活性なので、まだマウントされていない）。
    await within(panel).findByText(SPEC_ENTRY.request);
    expect(within(panel).queryByPlaceholderText(/依頼の本文/)).toBeNull();
  });

  it('保存すると、同じ kind と直した周期・本文が POST /schedule へ飛ぶ', async () => {
    stubSchedule([SPEC_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    const panel = await screen.findByRole('group', { name: `${SPEC_ENTRY.kind} を編集` });

    // 周期を直す（09:00 → 18:30）。
    fireEvent.change(within(panel).getByLabelText('時刻'), { target: { value: '18:30' } });

    // 本文を直す（編集タブへ切り替えてから書き換える）。
    fireEvent.mouseDown(within(panel).getByRole('tab', { name: '編集' }));
    const textarea = await within(panel).findByPlaceholderText(/依頼の本文/);
    fireEvent.change(textarea, { target: { value: '直した本文' } });

    fireEvent.click(within(panel).getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toContain('/schedule');
    await expect(sent[0]?.read()).resolves.toEqual({
      kind: SPEC_ENTRY.kind,
      request: '直した本文',
      spec: { type: 'daily', at: '18:30' },
    });
  });

  /**
   * **`entry.spec` が無ければ、既定の周期を勝手に埋めて送らない。** この画面より
   * 古いデーモンと話しているとき、`POST /schedule` は upsert なので、読めない
   * 周期を推測で埋めて送ると本文だけ直したつもりの保存が周期を黙って書き換える
   * （`ScheduleEditForm` の doc）。
   */
  it('entry.spec が無いときは、既定の周期で POST しない（保存自体を止める）', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    const panel = await screen.findByRole('group', { name: `${REQUEST_ENTRY.kind} を編集` });

    // 周期の入力欄そのものが出ない（読めないことを画面に書き、推測で埋めない）。
    expect(within(panel).queryByLabelText('時刻')).toBeNull();
    expect(within(panel).queryByLabelText('周期')).toBeNull();

    const save = within(panel).getByRole('button', { name: '保存する' });
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.click(save);
    expect(sent).toEqual([]);
  });
});
