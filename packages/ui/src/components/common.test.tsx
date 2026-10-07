// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Badge, Button, Empty, FieldHint, Input } from './common';

afterEach(() => {
  cleanup();
});

describe('Button のタップ標的（狭い画面で44px）', () => {
  it('size="sm" は基準の高さを持ち、md: で元の高さへ戻す', () => {
    render(<Button size="sm">送信</Button>);

    const button = screen.getByRole('button', { name: '送信' });
    const tokens = button.className.split(/\s+/);

    expect(tokens).toContain('h-11');
    expect(tokens).toContain('md:h-7');
    expect(tokens).toContain('md:px-2');
    expect(tokens).not.toContain('h-7');
  });

  it('size="md"（既定）も同じ形で44pxへ持ち上げてある', () => {
    render(<Button>送信</Button>);

    const button = screen.getByRole('button', { name: '送信' });
    const tokens = button.className.split(/\s+/);

    expect(tokens).toContain('h-11');
    expect(tokens).toContain('md:h-9');
    expect(tokens).not.toContain('h-9');
  });
});

describe('Badge の潰れ（flex 行の中で縮まない）', () => {
  it('flex 行の中で縮まないが、折り返し禁止は付けていない', () => {
    render(<Badge>状態</Badge>);

    const badge = screen.getByText('状態');
    const tokens = badge.className.split(/\s+/);

    expect(tokens).toContain('shrink-0');
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});

describe('FieldHint（入力欄の補足文）', () => {
  it('id で欄の aria-describedby と結べ、折り返せる（nowrap・truncate を持たない）', () => {
    render(
      <>
        <Input aria-label="欄" aria-describedby="h1" />
        <FieldHint id="h1">書式の説明</FieldHint>
      </>,
    );
    const input = screen.getByLabelText('欄');
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('書式の説明');
    const tokens = (hint as HTMLElement).className.split(/\s+/);
    expect(tokens).toContain('break-words');
    expect(tokens).not.toContain('truncate');
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});

describe('Empty の余白', () => {
  const tokens = (el: HTMLElement) => el.className.split(/\s+/);

  it('省略時は従来どおり p-6（既存の呼び出しを変えない）', () => {
    render(<Empty>空</Empty>);
    expect(tokens(screen.getByText('空'))).toContain('p-6');
  });

  it("inset='card' は見出しと同じ左端（px-4）で、上下を詰める（p-6 を持たない）", () => {
    render(<Empty inset="card">空</Empty>);
    const t = tokens(screen.getByText('空'));
    expect(t).toContain('px-4');
    expect(t).toContain('py-3');
    expect(t).not.toContain('p-6');
  });

  it("inset='none' は余白を持たない", () => {
    render(<Empty inset="none">空</Empty>);
    const t = tokens(screen.getByText('空'));
    expect(t.filter((c) => /^p[xy]?-/.test(c))).toEqual([]);
  });
});
