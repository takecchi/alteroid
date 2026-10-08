// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Settings, { describeReopenResult } from './settings';

const REOPEN_PATH = '/clone/session/reopen';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderSettings(reopen: () => Response) {
  const stub = stubFetch((url) => {
    if (url.endsWith(REOPEN_PATH)) return reopen();
    if (url.includes('/runners')) {
      return json({ runners: [], daemonRevision: { status: 'unknown' } });
    }
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

function reopenCalls(stub: ReturnType<typeof stubFetch>) {
  return stub.entries.filter((entry) => entry.url.endsWith(REOPEN_PATH));
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: '開き直す' }));
  return screen.findByRole('button', { name: '本当に開き直す' });
}

describe('describeReopenResult（CLI の describeReopenResult と文言を揃える単体試験）', () => {
  it('deferred', () => {
    expect(describeReopenResult({ outcome: 'deferred' })).toBe(
      'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
    );
  });

  it('now', () => {
    expect(describeReopenResult({ outcome: 'now' })).toBe(
      'いまはセッションが無かった。次の合図から新しいセッションで始まる。',
    );
  });

  it('unsupported は古い id もマネージャーも付けない', () => {
    expect(
      describeReopenResult({ outcome: 'unsupported', previousSessionId: 's', runningManagers: 2 }),
    ).toBe('このデーモンのクローンは、セッションを開き直す口を持っていない。');
  });

  it('古いセッション id と走っているマネージャーの行が付く（0本と null は付けない）', () => {
    expect(
      describeReopenResult({
        outcome: 'deferred',
        previousSessionId: 'sess-1',
        runningManagers: 2,
      }),
    ).toBe(
      [
        'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
        '古いセッション id: sess-1',
        '走っているマネージャーが 2 本いる。マネージャーは止めていない。その報告は新しいセッションへ届く。',
      ].join('\n'),
    );
    expect(
      describeReopenResult({ outcome: 'now', previousSessionId: null, runningManagers: 0 }),
    ).toBe('いまはセッションが無かった。次の合図から新しいセッションで始まる。');
  });
});

describe('クローンのセッションを開き直す（設定画面）', () => {
  it('確認を経るまで POST しない。確定で confirm: true・distill: false を送り、空の理由は送らない', async () => {
    const stub = renderSettings(() => json({ outcome: 'deferred' }));

    const confirm = await openDialog();
    expect(reopenCalls(stub)).toHaveLength(0);

    fireEvent.click(confirm);
    await screen.findByText(/いまのターンが終わった境界で/);

    const calls = reopenCalls(stub);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request?.method).toBe('POST');
    expect(await calls[0]?.request?.clone().json()).toEqual({ confirm: true, distill: false });
  });

  it('やめるを押すと POST しない', async () => {
    const stub = renderSettings(() => json({ outcome: 'deferred' }));

    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

    expect(reopenCalls(stub)).toHaveLength(0);
  });

  it('理由と蒸留のチェックは本文へ載る（理由の前後の空白は落とす）', async () => {
    const stub = renderSettings(() => json({ outcome: 'deferred' }));

    const checkbox = (await screen.findByRole('checkbox', {
      name: /古いセッションの末尾を記憶へ蒸留する/,
    })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByPlaceholderText(/安全分類器に弾かれ続けている/), {
      target: { value: '  弾かれ続ける  ' },
    });
    fireEvent.click(await openDialog());
    await screen.findByText(/いまのターンが終わった境界で/);

    expect(await reopenCalls(stub)[0]?.request?.clone().json()).toEqual({
      confirm: true,
      distill: true,
      reason: '弾かれ続ける',
    });
  });

  it('空白だけの理由は送らない', async () => {
    const stub = renderSettings(() => json({ outcome: 'now' }));

    fireEvent.change(await screen.findByPlaceholderText(/安全分類器に弾かれ続けている/), {
      target: { value: '   ' },
    });
    fireEvent.click(await openDialog());
    await screen.findByText('いまはセッションが無かった。次の合図から新しいセッションで始まる。');

    expect(await reopenCalls(stub)[0]?.request?.clone().json()).toEqual({
      confirm: true,
      distill: false,
    });
  });

  it('古いセッション id とマネージャーの行も出る', async () => {
    renderSettings(() =>
      json({ outcome: 'deferred', previousSessionId: 'sess-old', runningManagers: 3 }),
    );

    fireEvent.click(await openDialog());

    expect(await screen.findByText('古いセッション id: sess-old')).toBeTruthy();
    expect(
      screen.getByText(
        '走っているマネージャーが 3 本いる。マネージャーは止めていない。その報告は新しいセッションへ届く。',
      ),
    ).toBeTruthy();
  });

  it('unsupported の文言が出る', async () => {
    renderSettings(() => json({ outcome: 'unsupported' }));

    fireEvent.click(await openDialog());

    expect(
      await screen.findByText('このデーモンのクローンは、セッションを開き直す口を持っていない。'),
    ).toBeTruthy();
    expect(screen.queryByText(/いまのターンが終わった境界で/)).toBeNull();
  });

  it('403 は結果ではなく ErrorNote に出る。3値のどの文言も出ない', async () => {
    renderSettings(() => json({ error: '許可が無い' }, 403));

    fireEvent.click(await openDialog());

    await waitFor(() => {
      expect(
        screen.getAllByRole('alert').some((el) => el.textContent?.includes('許可が無い')),
      ).toBe(true);
    });
    expect(screen.queryByText(/いまのターンが終わった境界で/)).toBeNull();
    expect(screen.queryByText(/いまはセッションが無かった/)).toBeNull();
    expect(screen.queryByText(/口を持っていない/)).toBeNull();
  });
});
