import { describe, expect, it } from 'vitest';

import { STATUS_SEARCH_PARAM } from './managers-links.js';

describe('STATUS_SEARCH_PARAM（issue #2090）', () => {
  it('クエリパラメタ名は "status"', () => {
    expect(STATUS_SEARCH_PARAM).toBe('status');
  });
});
