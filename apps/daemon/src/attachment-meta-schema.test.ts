import { describe, expect, it } from 'vitest';

import { attachmentMetaSchema } from './openapi.js';

describe('GET /attachments/:id/meta の応答の型（#3523）', () => {
  it('外部イベントへ結び付いた添付の externalEventId を、任意の欄として宣言している', () => {
    expect(Object.keys(attachmentMetaSchema.shape)).toContain('externalEventId');
    const parsed = attachmentMetaSchema.safeParse({
      id: 'a',
      name: 'n',
      mediaType: 'text/plain',
      size: 1,
      sha256: 'x',
      externalEventId: 'ev-1',
      uploadedBy: 'integration:key-1',
      createdAt: '2026-10-07T00:00:00Z',
      expiresAt: '2026-10-08T00:00:00Z',
    });
    expect(parsed.success && parsed.data.externalEventId).toBe('ev-1');
  });
});
