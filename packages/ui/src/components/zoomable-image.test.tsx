// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ZoomableImage } from './zoomable-image';

afterEach(() => {
  cleanup();
});

describe('ZoomableImage（#4043 読み込み失敗）', () => {
  it('読み込めた画像は button で包まれ、押すと窓が開く', async () => {
    render(<ZoomableImage src="https://example.com/a.png" alt="図" />);

    fireEvent.click(screen.getByRole('button', { name: '図' }));

    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('読み込みに失敗したら button をやめ、alt の文字・リンク・読めなかった旨になる', () => {
    render(<ZoomableImage src="https://example.com/a.png" alt="図" />);

    fireEvent.error(screen.getByRole('img', { name: '図' }));

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    const link = screen.getByRole('link', { name: '図' });
    expect(link.getAttribute('href')).toBe('https://example.com/a.png');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/画像を読み込めなかった/)).toBeTruthy();
  });

  it('alt が空なら「画像」と書く', () => {
    render(<ZoomableImage src="https://example.com/a.png" alt="" />);

    fireEvent.error(document.querySelector('img') as HTMLImageElement);

    expect(screen.getByRole('link', { name: '画像' })).toBeTruthy();
  });

  it('src が空なら、リンクにせず文字だけにする', () => {
    render(<ZoomableImage src="" alt="図" />);

    fireEvent.error(document.querySelector('img') as HTMLImageElement);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('図')).toBeTruthy();
    expect(screen.getByText(/画像を読み込めなかった/)).toBeTruthy();
  });

  it('失敗の後で src が変わったら、また画像として出る', () => {
    const { rerender } = render(<ZoomableImage src="blob:one" alt="図" />);
    fireEvent.error(screen.getByRole('img', { name: '図' }));
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<ZoomableImage src="blob:two" alt="図" />);

    expect(screen.getByRole('button', { name: '図' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '図' }).getAttribute('src')).toBe('blob:two');
    expect(screen.queryByText(/画像を読み込めなかった/)).toBeNull();
  });
});
