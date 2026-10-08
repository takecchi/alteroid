// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AwaitingApprovalRow } from './home/awaiting-you';
import { Stat } from './stat';

afterEach(() => {
  cleanup();
});

describe('Stat の数字の書体', () => {
  it('数字は font-display にならず、桁の揃う tabular-nums で出る', () => {
    const { container } = render(<Stat label="件数" value="100" unit="件" />);
    const value = container.querySelector('[data-numeric]');
    expect(value?.textContent).toBe('100');
    const tokens = (value?.className ?? '').split(/\s+/);
    expect(tokens).not.toContain('font-display');
    expect(tokens).toContain('tabular-nums');
  });
});

describe('区切りの無い長い文字列（#4077）', () => {
  it('Stat のラベルは折り返す（break-words）', () => {
    const label = `${'a'.repeat(80)} 開いている Issue`;
    const { getByText } = render(<Stat label={label} value="1" />);
    expect(getByText(label).className.split(/\s+/)).toContain('break-words');
  });

  it('ホームの承認待ちの質問文は折り返す（break-words）', () => {
    const question = 'b'.repeat(120);
    const { getByText } = render(
      <ul>
        <AwaitingApprovalRow
          question={question}
          meta="たった今"
          renderLink={({ className, children }) => (
            <a href="#" className={className}>
              {children}
            </a>
          )}
        />
      </ul>,
    );
    expect(getByText(question).className.split(/\s+/)).toContain('break-words');
  });
});
