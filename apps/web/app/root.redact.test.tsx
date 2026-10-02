// @vitest-environment jsdom
/**
 * ErrorBoundary が出す例外の文とスタックに伏せ字を掛ける（issue #2600）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorBoundary } from './root';

afterEach(cleanup);

/** 偽のトークン（本物ではない）。 */
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

describe('ErrorBoundary の伏せ字', () => {
  it('Error（stack）・それ以外（String）のどちらからもトークンが消える', () => {
    const error = new Error(`boom ${TOKEN}`);
    const first = render(<ErrorBoundary error={error} />);
    expect(first.container.textContent).toContain('boom');
    expect(first.container.textContent).not.toContain(TOKEN);
    first.unmount();

    const second = render(<ErrorBoundary error={`plain ${TOKEN}`} />);
    expect(second.container.textContent).toContain('plain');
    expect(second.container.textContent).not.toContain(TOKEN);
  });
});
