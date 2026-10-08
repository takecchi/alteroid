// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatWithdrawnMessage, WITHDRAWN_MESSAGE_LABEL } from './withdrawn-message';

afterEach(cleanup);

describe('ChatWithdrawnMessage', () => {
  it('「（取り下げた発言）」と分かる見出しで、本文は畳んで出す（普通の吹き出しではない）', () => {
    render(<ChatWithdrawnMessage text="取り下げた本文" />);
    expect(screen.getByText(WITHDRAWN_MESSAGE_LABEL)).toBeTruthy();
    const details = screen.getByText(WITHDRAWN_MESSAGE_LABEL).closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('取り下げた本文');
    expect(document.querySelector('[data-withdrawn-message]')).not.toBeNull();
    // ChatMessage の編集の入口（鉛筆）を持たない
    expect(screen.queryByRole('button')).toBeNull();
  });
});
