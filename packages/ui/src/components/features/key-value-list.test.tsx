// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { KeyValueList } from './key-value-list';

afterEach(cleanup);

describe('KeyValueList', () => {
  it('先頭以外の dt に mt-3 と sm:mt-0 が在り、先頭の dt には上の余白が無い', () => {
    render(
      <KeyValueList
        items={[
          { label: 'a', value: '1' },
          { label: 'b', value: '2' },
          { label: 'c', value: '3' },
        ]}
      />,
    );
    const first = screen.getByText('a').classList;
    expect(first.contains('mt-3')).toBe(false);
    expect(first.contains('first:mt-0')).toBe(false);
    for (const label of ['b', 'c']) {
      const cls = screen.getByText(label).classList;
      expect(cls.contains('mt-3')).toBe(true);
      expect(cls.contains('sm:mt-0')).toBe(true);
    }
  });

  it('dd の折り返し: mono の行は break-all、それ以外は break-words で break-all は無い', () => {
    render(
      <KeyValueList
        items={[
          { label: 'id', value: 'abcdef', mono: true },
          { label: '時刻', value: '2026-09-30' },
        ]}
      />,
    );
    const mono = screen.getByText('abcdef').classList;
    expect(mono.contains('break-all')).toBe(true);
    const plain = screen.getByText('2026-09-30').classList;
    expect(plain.contains('break-words')).toBe(true);
    expect(plain.contains('break-all')).toBe(false);
  });
});
