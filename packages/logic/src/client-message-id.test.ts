import { describe, expect, it } from 'vitest';

import { newClientMessageId } from './client-message-id.js';

describe('newClientMessageId', () => {
  it('デーモンが受ける形（英数字・_ - の1〜128字）で、呼ぶたびに違う', () => {
    const ids = Array.from({ length: 200 }, () => newClientMessageId());
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
