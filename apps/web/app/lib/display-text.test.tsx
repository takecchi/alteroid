// @vitest-environment jsdom
import { ErrorNote } from '@alteroid/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WebDisplayTextProvider } from './display-text';

afterEach(cleanup);

describe('ErrorNote（WebDisplayTextProvider 越し）', () => {
  it.each([
    'Failed to fetch',
    'TypeError: Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Load failed',
    'Network request failed',
  ])('ブラウザの素の英語「%s」は、接続先に届かなかった文で出る', (raw) => {
    render(<ErrorNote error={new TypeError(raw)} />, { wrapper: WebDisplayTextProvider });
    expect(screen.getByText('接続先のサーバに届かなかった')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
  });

  it('ほかの文は変えない（文の途中に出る場合も含む）', () => {
    render(<ErrorNote error="保存していない: Failed to fetch の後に" />, {
      wrapper: WebDisplayTextProvider,
    });
    expect(screen.getByText('保存していない: Failed to fetch の後に')).toBeTruthy();
  });
});
