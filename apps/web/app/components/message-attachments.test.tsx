// @vitest-environment jsdom
// 実ブラウザの保存開始前に URL が失効しないことは保証しない: jsdom はダウンロードを持たず、固定できるのは revoke の順序までのため
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageAttachment } from '@alteroid/logic';

import { holdRequests, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import MessageAttachments from './message-attachments';

const ATTACHMENT: MessageAttachment = {
  id: 'att-1',
  name: 'report.pdf',
  mediaType: 'application/pdf',
  size: 3,
  sha256: 'x',
};

let originalFetch: typeof fetch;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  localStorage.clear();
  storeTestBaseUrl();
  createObjectURL = vi.fn(() => 'blob:test-url');
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clickSpy.mockRestore();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = originalRevoke as typeof URL.revokeObjectURL;
});

async function clickDownload() {
  const view = render(
    <Providers>
      <MessageAttachments attachments={[ATTACHMENT]} />
    </Providers>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'report.pdf をダウンロード' }));
  await act(async () => {
    await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });
  return view;
}

describe('ダウンロードの失敗の文', () => {
  async function downloadAndReadAlert() {
    render(
      <Providers>
        <MessageAttachments attachments={[ATTACHMENT]} />
      </Providers>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf をダウンロード' }));
    return (await screen.findByRole('alert')).textContent;
  }

  it('404 は接頭辞なしの固定文で出す', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    expect(await downloadAndReadAlert()).toBe('取り出せない（期限切れの可能性）');
  });

  it('それ以外の失敗は「取り出せなかった: 」を付けて、サーバの文を出す', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await downloadAndReadAlert()).toBe('取り出せなかった: boom');
  });
});

describe('画像の添付のプレビュー', () => {
  const IMAGE: MessageAttachment = {
    id: 'img-1',
    name: 'shot.png',
    mediaType: 'image/png',
    size: 3,
    sha256: 'y',
  };

  function renderImage() {
    return render(
      <Providers>
        <MessageAttachments attachments={[IMAGE]} />
      </Providers>,
    );
  }

  it('取り出した中身を blob: URL にして出し、画面から外れたら解放する', async () => {
    const view = renderImage();
    const image = await screen.findByAltText('shot.png');
    expect(image.getAttribute('src')).toBe('blob:test-url');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });

  it('取り出せなかったら、失敗の文を出し、URL は作らない', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    renderImage();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'shot.png: 取り出せない（期限切れの可能性）',
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('外れたあとに届いた中身では URL を作らない（作ると誰も解放しない）', async () => {
    const hold = holdRequests(({ url }) => url.includes('/attachments/img-1'));
    const view = renderImage();
    await act(async () => {
      await vi.waitFor(() => expect(hold.held()).toBe(1));
    });

    view.unmount();
    await act(async () => {
      hold.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe('ダウンロードの URL の取り消し', () => {
  it('click の時点では取り消さず、猶予のあとに取り消す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clickDownload();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });

  it('画面から外れても、猶予のあとに取り消す（漏らさない）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const view = await clickDownload();

    view.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });
});
