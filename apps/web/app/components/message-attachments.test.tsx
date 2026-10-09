// @vitest-environment jsdom
// 実ブラウザの保存開始前に URL が失効しないことは保証しない: jsdom はダウンロードを持たず、固定できるのは revoke の順序までのため
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageAttachment } from '@alteroid/logic';

import { Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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
