// @vitest-environment jsdom
// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので、route(url, init) に method が渡らないため
// ファイルは Node の File（node:buffer）で作る: jsdom の File は Node の Request の本文として読めないため
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Files from './files';

type Item = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt?: string;
  keptAt?: string;
  uploadedBy?: string;
  conversationId?: string;
};

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    name: `${id}.txt`,
    mediaType: 'text/plain',
    size: 2048,
    sha256: 'x',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    uploadedBy: 'operator',
    ...extra,
  };
}

const ZERO = { count: 0, totalBytes: 0 };

interface Server {
  items: Item[];
  /** 一覧の取得の失敗を作る回数 */
  failList: number;
  /** 行ごとの PATCH / DELETE / 中身の取得への応答の差し替え */
  override: (method: string, id: string) => Response | undefined;
  pageSize: number;
  log: { method: string; url: URL; body?: unknown }[];
}

let server: Server;
let originalFetch: typeof fetch;

function usageOf(items: Item[]) {
  return {
    count: items.length,
    totalBytes: items.reduce((sum, i) => sum + i.size, 0),
    byFrom: {
      human: { count: items.filter((i) => i.uploadedBy === 'operator').length, totalBytes: 0 },
      clone: { count: items.filter((i) => i.uploadedBy === 'clone').length, totalBytes: 0 },
      manager: ZERO,
      integration: ZERO,
      unknown: ZERO,
    },
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  server = { items: [], failList: 0, override: () => undefined, pageSize: 50, log: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? (typeof input === 'string' ? input : String(input)));
    const method = request?.method ?? init?.method ?? 'GET';
    const entry: Server['log'][number] = { method, url };
    server.log.push(entry);
    if (url.pathname === '/attachments/limits') return json({ error: 'none' }, 404);
    if (url.pathname === '/attachments' && method === 'GET') {
      if (server.failList > 0) {
        server.failList -= 1;
        return json({ error: 'boom' }, 500);
      }
      const q = url.searchParams.get('q')?.toLowerCase();
      const kept = url.searchParams.get('kept');
      const from = url.searchParams.get('from');
      const conversationId = url.searchParams.get('conversationId');
      const matched = server.items.filter(
        (i) =>
          (q === undefined || i.name.toLowerCase().includes(q ?? '')) &&
          (kept === null || (i.keptAt !== undefined) === (kept === '1')) &&
          (from === null ||
            (from === 'clone' ? i.uploadedBy === 'clone' : i.uploadedBy === 'operator')) &&
          (conversationId === null || i.conversationId === conversationId),
      );
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const slice = matched.slice(start, start + server.pageSize);
      const next = start + server.pageSize;
      return json({
        items: slice,
        ...(next < matched.length ? { nextCursor: String(next) } : {}),
        usage: usageOf(server.items),
      });
    }
    if (url.pathname === '/attachments' && method === 'POST') {
      entry.body = request === null ? undefined : (await request.arrayBuffer()).byteLength;
      const created = item(`up-${server.items.length}`, {
        name: url.searchParams.get('name') ?? 'x',
        keptAt: url.searchParams.get('keep') === '1' ? '2026-10-02T00:00:00.000Z' : undefined,
      });
      server.items = [created, ...server.items];
      return json(created);
    }
    const match = /^\/attachments\/([^/]+)$/.exec(url.pathname);
    if (match !== null) {
      const id = decodeURIComponent(match[1]!);
      const overridden = server.override(method, id);
      if (overridden !== undefined) return overridden;
      const target = server.items.find((i) => i.id === id);
      if (target === undefined) return json({ error: 'not found' }, 404);
      if (method === 'PATCH') {
        const body = (await request!.json()) as { kept: boolean };
        entry.body = body;
        const updated: Item = { ...target };
        if (body.kept) {
          updated.keptAt = '2026-10-03T00:00:00.000Z';
          delete updated.expiresAt;
        } else {
          delete updated.keptAt;
          updated.expiresAt = '2026-11-02T00:00:00.000Z';
        }
        server.items = server.items.map((i) => (i.id === id ? updated : i));
        return json(updated);
      }
      if (method === 'DELETE') {
        server.items = server.items.filter((i) => i.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') return new Response(new Uint8Array([1, 2, 3]));
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderFiles(initial = '/files') {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[initial]}>
        <Where />
        <Routes>
          <Route path="/files" element={<Files />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

const listCalls = () =>
  server.log.filter((c) => c.method === 'GET' && c.url.pathname === '/attachments');
const rowOf = (name: string) => screen.getByText(name).closest('li')!;

describe('ファイル画面: 一覧と使用量', () => {
  it('行に名前・種類・大きさ・出所・保存中か消える日・作成日時を出し、使用量を上に出す', async () => {
    server.items = [
      item('a', {
        name: 'report.pdf',
        mediaType: 'application/pdf',
        keptAt: '2026-10-02T00:00:00.000Z',
        expiresAt: undefined,
      }),
      item('b', { name: 'note.txt', uploadedBy: 'clone' }),
      item('c', { name: 'mystery.bin', uploadedBy: undefined }),
    ];
    renderFiles();
    await screen.findByText('report.pdf');

    const kept = rowOf('report.pdf');
    expect(within(kept).getByText('保存中')).toBeTruthy();
    expect(kept.textContent).toContain('application/pdf');
    expect(kept.textContent).toContain('2.0 KB');
    expect(kept.textContent).toContain('出所: 人間');
    const expiring = rowOf('note.txt');
    expect(expiring.textContent).toContain('出所: クローン');
    expect(expiring.textContent).toMatch(/に消える/);
    expect(expiring.textContent).not.toContain('保存中');
    expect(rowOf('mystery.bin').textContent).toContain('出所: 不明');

    // 使用量: 合計と出所ごと
    const usageCard = screen.getByTestId('usage');
    expect(usageCard.textContent).toContain('合計');
    expect(usageCard.textContent).toContain('3');
    for (const label of ['人間', 'クローン', 'マネージャー', '連携', '不明']) {
      expect(within(usageCard).getByText(label)).toBeTruthy();
    }
  });

  it('空のときは「ファイルはまだありません」', async () => {
    renderFiles();
    expect(await screen.findByText('ファイルはまだありません')).toBeTruthy();
  });

  it('取得に失敗したら失敗を出し、もう一度試すと読み込めたら一覧になる', async () => {
    server.items = [item('a', { name: 'ok.txt' })];
    server.failList = 1;
    renderFiles();
    await screen.findByText('ファイルの一覧を読み込めませんでした');
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    await screen.findByText('ok.txt');
    expect(screen.queryByText('ファイルの一覧を読み込めませんでした')).toBeNull();
  });

  it('「もっと見る」で nextCursor を辿って続きを足す', async () => {
    server.pageSize = 2;
    server.items = ['a', 'b', 'c'].map((id) => item(id, { name: `${id}.txt` }));
    renderFiles();
    await screen.findByText('b.txt');
    expect(screen.queryByText('c.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }));
    await screen.findByText('c.txt');
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'もっと見る' })).toBeNull();
    expect(listCalls().some((c) => c.url.searchParams.get('cursor') === '2')).toBe(true);
  });
});

describe('ファイル画面: 絞り込み', () => {
  it('保存の有無・出所・会話（URL）・名前（debounce）がクエリに載り、URL にも残る', async () => {
    server.items = [
      item('a', {
        name: 'a.txt',
        keptAt: '2026-10-02T00:00:00.000Z',
        uploadedBy: 'clone',
        conversationId: 'c-1',
      }),
      item('b', { name: 'b.txt' }),
    ];
    renderFiles('/files?conversation=c-1');
    await screen.findByText('a.txt');
    expect(screen.queryByText('b.txt')).toBeNull();
    expect(listCalls().at(-1)!.url.searchParams.get('conversationId')).toBe('c-1');

    fireEvent.change(screen.getByLabelText('保存の有無で絞り込む'), { target: { value: '1' } });
    await waitFor(() => {
      expect(listCalls().at(-1)!.url.searchParams.get('kept')).toBe('1');
    });
    fireEvent.change(screen.getByLabelText('出所で絞り込む'), { target: { value: 'clone' } });
    await waitFor(() => {
      expect(listCalls().at(-1)!.url.searchParams.get('from')).toBe('clone');
    });

    fireEvent.change(screen.getByLabelText('ファイルを名前で探す'), { target: { value: 'a.t' } });
    // debounce の間はまだ載らない
    expect(listCalls().some((c) => c.url.searchParams.get('q') === 'a.t')).toBe(false);
    await waitFor(() => {
      expect(listCalls().at(-1)!.url.searchParams.get('q')).toBe('a.t');
    });
    const where = screen.getByTestId('where').textContent!;
    expect(where).toContain('kept=1');
    expect(where).toContain('from=clone');
    expect(where).toContain('q=a.t');
    expect(where).toContain('conversation=c-1');

    fireEvent.click(screen.getByRole('button', { name: '会話の絞り込みを解除' }));
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).not.toContain('conversation');
    });
  });

  it('条件に合うものが無いときは空と分けて言う', async () => {
    server.items = [item('a')];
    renderFiles('/files?q=zzz');
    expect(await screen.findByText('条件に合うファイルはありません')).toBeTruthy();
  });
});

describe('ファイル画面: 操作', () => {
  it('保存する／外すは PATCH し、応答で行を差し替える（一覧は取り直さない）', async () => {
    server.items = [item('a', { name: 'a.txt' })];
    renderFiles();
    await screen.findByText('a.txt');
    const before = listCalls().length;

    fireEvent.click(screen.getByRole('button', { name: 'a.txt の保存をする' }));
    await within(rowOf('a.txt')).findByText('保存中');
    expect(server.log.find((c) => c.method === 'PATCH')!.body).toEqual({ kept: true });
    expect(listCalls()).toHaveLength(before);

    fireEvent.click(screen.getByRole('button', { name: 'a.txt の保存を外す' }));
    await waitFor(() => {
      expect(rowOf('a.txt').textContent).toMatch(/に消える/);
    });
    expect(server.log.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ kept: false });
  });

  it('削除は確認を挟む。やめれば消さず、削除すれば消えて使用量も取り直す', async () => {
    server.items = [item('a', { name: 'a.txt' }), item('b', { name: 'b.txt' })];
    renderFiles();
    await screen.findByText('a.txt');

    fireEvent.click(screen.getByRole('button', { name: 'a.txt を削除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('取り消せません');
    expect(dialog.textContent).toContain('保存中のものでも消えます');
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(server.log.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByText('a.txt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'a.txt を削除' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除する' }),
    );
    await waitFor(() => {
      expect(screen.queryByText('a.txt')).toBeNull();
    });
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(server.log.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('期限切れで先に消えていた行（404）は、案内を出して一覧から外す', async () => {
    server.items = [item('a', { name: 'a.txt' })];
    renderFiles();
    await screen.findByText('a.txt');
    // 取得のあとで期限切れになった（サーバにはもう無い）
    server.items = [];

    fireEvent.click(screen.getByRole('button', { name: 'a.txt を削除' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除する' }),
    );
    await screen.findByText(/「a.txt」は期限切れで、すでに消えていました/);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'a.txt を削除' })).toBeNull();
    });
  });

  it('ダウンロードは Bearer 付きの取得で中身を取り、保存する', async () => {
    server.items = [item('a', { name: 'a.txt' })];
    const created = vi.fn(() => 'blob:dl');
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderFiles();
    await screen.findByText('a.txt');
    fireEvent.click(screen.getByRole('button', { name: 'a.txt をダウンロード' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });
    expect(server.log.some((c) => c.method === 'GET' && c.url.pathname === '/attachments/a')).toBe(
      true,
    );
    expect(created).toHaveBeenCalled();
  });

  it('ダウンロードが 404 なら期限切れの案内を出す', async () => {
    server.items = [item('a', { name: 'a.txt' })];
    renderFiles();
    await screen.findByText('a.txt');
    server.override = (method) => (method === 'GET' ? json({ error: 'gone' }, 404) : undefined);
    server.items = [];
    fireEvent.click(screen.getByRole('button', { name: 'a.txt をダウンロード' }));
    await screen.findByText(/「a.txt」は期限切れで、すでに消えていました/);
  });
});

describe('ファイル画面: アップロード', () => {
  it('選んだファイルを keep=1 で上げ、一覧に出る。0 バイトは上げずに断る', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');

    const input = screen.getByLabelText('アップロードするファイル');
    const good = new NodeFile(['hello'], 'hello.txt', { type: 'text/plain' }) as unknown as File;
    const empty = new NodeFile([], 'empty.txt', { type: 'text/plain' }) as unknown as File;
    fireEvent.change(input, { target: { files: [good, empty] } });

    await screen.findByText('hello.txt');
    const posts = server.log.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.searchParams.get('keep')).toBe('1');
    expect(posts[0]!.url.searchParams.get('name')).toBe('hello.txt');
    expect(await screen.findByText('empty.txt: 空のファイルは添えられない')).toBeTruthy();
    expect(screen.getByText('1 件を上げました（保存中）')).toBeTruthy();
    expect(within(rowOf('hello.txt')).getByText('保存中')).toBeTruthy();
  });

  it('ドロップでも上げる', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    const file = new NodeFile(['x'], 'dropped.txt', { type: 'text/plain' }) as unknown as File;
    fireEvent.drop(screen.getByTestId('file-drop'), {
      dataTransfer: { types: ['Files'], files: [file] },
    });
    await screen.findByText('dropped.txt');
    expect(server.log.filter((c) => c.method === 'POST')[0]!.url.searchParams.get('keep')).toBe(
      '1',
    );
  });

  it('上限を超えるものは上げる前に断る', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    const big = { name: 'big.bin', size: 26 * 1024 * 1024, type: '' } as unknown as File;
    fireEvent.change(screen.getByLabelText('アップロードするファイル'), {
      target: { files: [big] },
    });
    expect(await screen.findByText(/big.bin: ファイルは 1 つ 25.0 MB まで/)).toBeTruthy();
    expect(server.log.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('ファイル画面: サムネ', () => {
  it('画像は見えている行だけ中身を取り、画面から外れたら blob: URL を解放する', async () => {
    const observed = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
    class FakeObserver {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(element: Element) {
        observed.set(element, this.callback);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:thumb-${++n}`);
    const revoked: string[] = [];
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    server.items = [
      item('p1', { name: 'one.png', mediaType: 'image/png' }),
      item('p2', { name: 'two.png', mediaType: 'image/png' }),
    ];
    const { unmount } = renderFiles();
    await screen.findByText('one.png');
    expect(server.log.some((c) => c.url.pathname.startsWith('/attachments/p'))).toBe(false);

    const box = rowOf('one.png').querySelector('span.size-14')!;
    observed.get(box)!([{ isIntersecting: true }]);
    await waitFor(() => {
      expect(screen.getByAltText('one.png')).toBeTruthy();
    });
    const fetched = server.log.filter((c) => c.url.pathname.startsWith('/attachments/p'));
    expect(fetched.map((c) => c.url.pathname)).toEqual(['/attachments/p1']);

    unmount();
    expect(revoked).toEqual(['blob:thumb-1']);
  });
});
