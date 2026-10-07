import { describe, expect, it } from 'vitest';

import { InvalidCursorError, decodeCursor, encodeCursor } from './cursor.js';
import { z } from 'zod';

const shape = z.object({ id: z.string(), order: z.enum(['asc', 'desc']) });

describe('cursor（keyset paging の共通符号化。issue #432）', () => {
  it('往復（encode→decode）で元に戻る', () => {
    const payload = { id: 'ap-1', order: 'asc' as const };
    const encoded = encodeCursor(payload);
    expect(decodeCursor(encoded, shape)).toEqual(payload);
  });

  it('base64 として読めない文字列は InvalidCursorError', () => {
    expect(() => decodeCursor('!!!not-base64!!!', shape)).toThrow(InvalidCursorError);
  });

  it('base64 としては読めても JSON として読めない中身は InvalidCursorError', () => {
    const notJson = Buffer.from('これは JSON ではない', 'utf8').toString('base64url');
    expect(() => decodeCursor(notJson, shape)).toThrow(InvalidCursorError);
  });

  it('JSON としては読めても schema に合わない中身は InvalidCursorError', () => {
    const wrongShape = Buffer.from(JSON.stringify({ order: 'sideways' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(wrongShape, shape)).toThrow(InvalidCursorError);
  });

  it('encode した文字列は base64url なので +, /, = を含まない', () => {
    const payload = {
      id: '>>>???///+++===   日本語  \u0000￿'.repeat(20),
      order: 'desc' as const,
    };
    const encoded = encodeCursor(payload);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeCursor(encoded, shape)).toEqual(payload);
  });
});
