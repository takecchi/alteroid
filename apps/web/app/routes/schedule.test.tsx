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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
function stubSchedule(entries: unknown[], unreadable?: unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/schedule')) {
      // 知らない URL は「繋がらない」（経路の書き忘れを空の応答で通さない）。
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'GET') {
      // `unreadable` は渡さなければ鍵ごと無い（0件と同じ。#2343）。
      return Promise.resolve(
        json({ entries, ...(unreadable === undefined ? {} : { unreadable }) }),
      );
    }

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
      <MemoryRouter>
        <Schedule />
      </MemoryRouter>
    </Providers>,
  );
}

describe('継続する依頼を仕込む', () => {
  async function fill(kind: string, request: string): Promise<void> {
    const kindBox = await screen.findByLabelText(/依頼の名前/);
    fireEvent.change(kindBox, { target: { value: kind } });
    const requestBox = screen.getByLabelText('依頼の本文');
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

  it('依頼の本文で Ctrl + Enter（⌘ + Enter でも）なら「仕込む」と同じに送る。Enter だけでは送らない', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await fill('morning-issues', '朝いちで issue を見ておいて');
    const requestBox = screen.getByLabelText('依頼の本文');
    fireEvent.keyDown(requestBox, { key: 'Enter' });
    expect(sent).toEqual([]);
    fireEvent.keyDown(requestBox, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await expect(sent[0]?.read()).resolves.toMatchObject({
      kind: 'morning-issues',
      request: '朝いちで issue を見ておいて',
    });
  });

  it('kind が空のままなら、ショートカットでも送らない（ボタンの disabled と同じ条件）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await screen.findByLabelText(/依頼の名前/);
    const requestBox = screen.getByLabelText('依頼の本文');
    fireEvent.change(requestBox, { target: { value: '本文だけ' } });
    fireEvent.keyDown(requestBox, { key: 'Enter', ctrlKey: true });
    expect(sent).toEqual([]);
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

/**
 * 「今すぐ回す」を押したら、起こした旨を短く出す（issue #3075）。直す前は成功しても何も変わらず、
 * 押せたのか・もう一度押すべきかが分からなかった。デーモンはターンの結果を待たないので、
 * 「終わった」とは書かない。
 */
describe('「今すぐ回す」の表示', () => {
  const OTHER_ENTRY = { ...REQUEST_ENTRY, kind: 'other', description: '毎日 10:00' };

  it('押すと、その行だけに「起こした」を出し、「終わった」とは言わない', async () => {
    stubSchedule([DEFAULT_ENTRY, OTHER_ENTRY]);
    renderSchedule();

    const buttons = await screen.findAllByRole('button', { name: / を今すぐ回す$/ });
    expect(screen.queryByText(/^起こした/)).toBeNull();
    fireEvent.click(buttons[0]!);

    const note = await screen.findByText(/^起こした/);
    expect(sent[0]?.url).toMatch(/\/schedule\/daily_report\/run$/);
    expect(note.textContent).not.toMatch(/終わ|完了|成功/);
    expect(screen.getAllByText(/^起こした/)).toHaveLength(1);
    expect(note.closest('li')?.textContent).toContain('毎日 22:00 に日報');

    // 別の行を押すと、表示はそちらへ移る（前の行には残らない）。
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByText(/^起こした/).closest('li')?.textContent).toContain('毎日 10:00'),
    );
    expect(screen.getAllByText(/^起こした/)).toHaveLength(1);
  });

  it('失敗したときは「起こした」を出さない（失敗は ErrorNote が言う）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    const ok = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const method = request?.method ?? init?.method ?? 'GET';
      return method === 'POST'
        ? Promise.resolve(json({ error: 'not found' }, 404))
        : ok(input, init);
    }) as typeof fetch;
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: / を今すぐ回す$/ }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/^起こした/)).toBeNull();
  });
});

/**
 * 「今すぐ回す」を続けて押せない（issue #3079）。直す前は、ボタンを押せなくするのが `running` の
 * 描き直しの後だけで、同じ描画の間に届く2回目のクリックが `POST /schedule/:kind/run` をもう一度
 * 送り、ターンを2回起こしえた。時間では止めない — 応答が返るまで、その kind のボタンだけを押せなくする。
 * 応答は保留の Promise で止め、解くことで進める（実時間は待たない）。
 */
describe('「今すぐ回す」を、応答が返るまで続けて押せない', () => {
  const OTHER_ENTRY = { ...REQUEST_ENTRY, kind: 'other', description: '毎日 10:00' };

  /** 起こす要求（POST）の応答を、テストが解くまで保留にする。 */
  function holdRuns(): { resolveNext: (res: Response) => void; posts: () => number } {
    const pending: ((res: Response) => void)[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      if (method !== 'POST') return inner(input, init);
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        method,
        read: () => Promise.resolve(undefined),
      });
      return new Promise<Response>((resolve) => pending.push(resolve));
    }) as typeof fetch;
    return {
      resolveNext: (res) => {
        const next = pending.shift();
        if (next === undefined) throw new Error('保留中の要求が無い');
        next(res);
      },
      posts: () => sent.filter((s) => s.method === 'POST').length,
    };
  }

  it('同じ描画の間に2回クリックしても、POST は1回しか送られない', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    const held = holdRuns();
    renderSchedule();

    const button = await screen.findByRole('button', { name: / を今すぐ回す$/ });
    // `fireEvent` は1回ごとに act で描き直しを済ませるので、2回を1つの act に入れて、
    // 「描き直しの前に2回目が届く」同じ描画の間を作る。
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(held.posts()).toBe(1);
    held.resolveNext(json({ ok: true }));
    await screen.findByText(/^起こした/);
    expect(held.posts()).toBe(1);
  });

  it('応答が返るまで押せず、成功で返った後はまた押せて、2回目の POST が送れる', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    const held = holdRuns();
    renderSchedule();

    const button = await screen.findByRole('button', { name: / を今すぐ回す$/ });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));

    held.resolveNext(json({ ok: true }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(held.posts()).toBe(2);
    held.resolveNext(json({ ok: true }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it('失敗で返った後もまた押せて、2回目の POST が送れる', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    const held = holdRuns();
    renderSchedule();

    const button = await screen.findByRole('button', { name: / を今すぐ回す$/ });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));

    held.resolveNext(json({ error: 'boom' }, 500));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(held.posts()).toBe(2);
    held.resolveNext(json({ ok: true }));
    await screen.findByText(/^起こした/);
  });

  it('別の行のボタンは、片方の応答待ちの間も押せる', async () => {
    stubSchedule([DEFAULT_ENTRY, OTHER_ENTRY]);
    const held = holdRuns();
    renderSchedule();

    const buttons = await screen.findAllByRole('button', { name: / を今すぐ回す$/ });
    act(() => {
      fireEvent.click(buttons[0]!);
      fireEvent.click(buttons[1]!);
      fireEvent.click(buttons[0]!);
    });

    expect(held.posts()).toBe(2);
    held.resolveNext(json({ ok: true }));
    held.resolveNext(json({ ok: true }));
    await waitFor(() => expect((buttons[0] as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('継続中の依頼を外す', () => {
  it('「外す」を押しただけでは外さず、確認を出す。やめれば外さない（#2781）', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: / を外す$/ }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('予定「morning-issues」を外しますか')).toBeTruthy();
    expect(sent).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).toHaveLength(0);
  });

  it('依頼には「外す」があり、確認で外すと DELETE を打つ', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: / を外す$/ }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '外す' }),
    );

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url).toContain('/schedule/morning-issues');
  });

  /**
   * 既定の仕込み（`RESERVED_SCHEDULE_KINDS`。packages/core/src/schedule.ts）は
   * デーモンが名前を守っているので外せない。
   * **ボタンだけ消すと、押せない理由が画面から消える**ので、代わりに書く。
   */
  it('既定の仕込みには「外す」を出さず、外せない理由を書く', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    expect(await screen.findByText('既定（外せない）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: / を外す$/ })).toBeNull();
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

  it('利用者が付けた名前の表示に break-words が付いている', async () => {
    stubSchedule([REQUEST_ENTRY]);
    renderSchedule();

    const kind = await screen.findByText('morning-issues');
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
  it('仕込まれた依頼には「編集」が在り、既定の仕込み（RESERVED_SCHEDULE_KINDS）には無い', async () => {
    stubSchedule([DEFAULT_ENTRY, SPEC_ENTRY]);
    renderSchedule();

    // 仕込まれた依頼（SPEC_ENTRY）の行にだけ「編集」が出る。
    await screen.findByText('毎日 22:00 に日報');
    expect(screen.queryByText('daily_report')).toBeNull();
    expect(screen.getAllByRole('button', { name: / を編集$/ })).toHaveLength(1);
    // どの行のボタンかが名前で分かる（#3213）。既定の行にも「今すぐ回す」は在る。
    expect(screen.getByRole('button', { name: `${SPEC_ENTRY.kind} を編集` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${SPEC_ENTRY.kind} を外す` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${SPEC_ENTRY.kind} を今すぐ回す` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${DEFAULT_ENTRY.kind} を今すぐ回す` })).toBeTruthy();
  });

  it('開くと、いまの周期（時刻）と本文が入っている', async () => {
    stubSchedule([SPEC_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: / を編集$/ }));

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

    fireEvent.click(await screen.findByRole('button', { name: / を編集$/ }));
    const panel = await screen.findByRole('group', { name: `${SPEC_ENTRY.kind} を編集` });

    // プレビューが Markdown として本文を描いている（編集タブの textarea は
    // 非活性なので、まだマウントされていない）。
    await within(panel).findByText(SPEC_ENTRY.request);
    expect(within(panel).queryByPlaceholderText(/依頼の本文/)).toBeNull();
  });

  it('保存すると、同じ kind と直した周期・本文が POST /schedule へ飛ぶ', async () => {
    stubSchedule([SPEC_ENTRY]);
    renderSchedule();

    fireEvent.click(await screen.findByRole('button', { name: / を編集$/ }));
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

    fireEvent.click(await screen.findByRole('button', { name: / を編集$/ }));
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

/**
 * 読めない継続中の依頼の行（#2343）。一覧が読めない行を黙って飛ばすと、人間には
 * 「登録された定期ジョブが無い」と見える。件数と kind を、一覧の上で断る。
 */
describe('/schedule 画面: 読めない継続中の依頼の断り', () => {
  it('読めない行が在るとき、件数・kind・「消された依頼ではない」を出す。読めた行はそのまま出る', async () => {
    stubSchedule(
      [DEFAULT_ENTRY],
      [{ kind: 'broken-1', reason: '不正な欄: spec' }, { reason: '不正な行' }],
    );
    renderSchedule();

    expect(await screen.findByText(DEFAULT_ENTRY.description)).toBeTruthy();
    const note = await screen.findByText(/読めない継続中の依頼が 2 件ある/);
    expect(note.textContent).toContain('kind: broken-1');
    expect(note.textContent).toContain('壊れた行であって、消された依頼ではない');
  });

  it('読めた行が0件でも「登録された定期ジョブが無い」と言い切らない', async () => {
    stubSchedule([], [{ kind: 'broken-1', reason: '不正な欄: spec' }]);
    renderSchedule();

    expect(await screen.findByText(/読めない継続中の依頼が 1 件ある/)).toBeTruthy();
    expect(screen.queryByText(/登録された定期ジョブが無い（/)).toBeNull();
    expect(screen.getByText(/読めた範囲では、登録された定期ジョブが無い/)).toBeTruthy();
  });

  it('0件のとき（鍵が無い）は何も出さない。本当に0件なら「無い」と言う', async () => {
    stubSchedule([]);
    renderSchedule();

    expect(await screen.findByText(/登録された定期ジョブが無い（/)).toBeTruthy();
    expect(screen.queryByText(/読めない/)).toBeNull();
  });
});

describe('定期ジョブの行の説明文の列（#2755）', () => {
  it('説明文の列は最小幅を持つ（flex-basis 0 のまま 46px に潰れない）', async () => {
    // jsdom はレイアウトを持たず折り返しを測れない（390px で説明文の列が約46px、
    // 1行2〜3文字に潰れた実寸はブラウザで測った）。潰れを防ぐ指定そのもの＝
    // 最小幅を持つこと、`min-w-0`（最小幅を0にする指定）に戻らないことを固定する。
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    const column = (await screen.findByText(DEFAULT_ENTRY.description)).parentElement;
    expect(column?.className).toContain('min-w-[min(14rem,100%)]');
    expect(column?.className).not.toMatch(/(^|\s)min-w-0(\s|$)/);
  });
});

/**
 * 入力欄の名前は、入力するとプレースホルダが消えても残らなければならない（#2787）。
 * `getByLabelText` で引けることは、`<label>` か `aria-label` が在ることの証拠である。
 */
describe('入力欄にラベルが在る（#2787）', () => {
  it('依頼の名前・依頼の本文・送り元・知らせの内容が、ラベルで引ける', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    const kind = await screen.findByLabelText(/依頼の名前/);
    fireEvent.change(kind, { target: { value: 'x' } });
    // 入力してもラベルは残る（プレースホルダは消える）。
    expect(screen.getByLabelText(/依頼の名前/)).toBe(kind);
    expect(screen.getByLabelText('依頼の本文')).toBeTruthy();
    expect(screen.getByLabelText('送り元の名前')).toBeTruthy();
    expect(screen.getByLabelText('知らせの内容')).toBeTruthy();
  });

  it('既定の仕込みの内部の名前（kind）を利用者に見せない（#2782）', async () => {
    stubSchedule([DEFAULT_ENTRY]);
    renderSchedule();

    await screen.findByText('毎日 22:00 に日報');
    expect(screen.queryByText('daily_report')).toBeNull();
  });
});
