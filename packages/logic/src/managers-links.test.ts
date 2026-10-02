import { describe, expect, it } from 'vitest';

import { managersHref, STATUS_SEARCH_PARAM } from './managers-links.js';

describe('managersHref（issue #2090）', () => {
  it('status を渡すと /managers?status=<値> になる', () => {
    expect(managersHref({ status: ['running'] })).toBe('/managers?status=running');
  });

  it('複数の status はカンマ区切りで1つのクエリパラメタへ載る（順序を保つ）', () => {
    expect(managersHref({ status: ['running', 'waiting_human'] })).toBe(
      '/managers?status=running%2Cwaiting_human',
    );
  });

  it('重複した status は1つに畳む', () => {
    expect(managersHref({ status: ['running', 'running'] })).toBe('/managers?status=running');
  });

  it('何も渡さないと絞り込み無しの /managers になる', () => {
    expect(managersHref()).toBe('/managers');
    expect(managersHref({})).toBe('/managers');
  });

  it('空配列は「その欄は載せない」——絞り込みを消す形と同じ規約', () => {
    expect(managersHref({ status: [] })).toBe('/managers');
  });

  it('クエリパラメタ名は STATUS_SEARCH_PARAM（"status"）と一致する', () => {
    expect(STATUS_SEARCH_PARAM).toBe('status');
    const href = managersHref({ status: ['running'] });
    expect(href).toContain(`${STATUS_SEARCH_PARAM}=running`);
  });
});
