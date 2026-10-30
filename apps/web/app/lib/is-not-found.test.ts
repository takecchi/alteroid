import { describe, expect, it } from 'vitest';

import { ApiError } from '@alteroid/swr';

import { isNotFound } from './is-not-found';

describe('isNotFound', () => {
  it('404 の ApiError だけを真とする', () => {
    expect(isNotFound(new ApiError(404, 'not found'))).toBe(true);
    expect(isNotFound(new ApiError(409, 'conflict'))).toBe(false);
    expect(isNotFound(new ApiError(500, 'boom'))).toBe(false);
  });
  it('ApiError でない値は、status が 404 でも偽', () => {
    expect(isNotFound({ status: 404 })).toBe(false);
    expect(isNotFound(new Error('not found'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
