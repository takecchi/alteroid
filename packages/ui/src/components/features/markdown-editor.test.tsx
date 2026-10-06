// @vitest-environment jsdom
/**
 * `MarkdownEditor` の省略可能な口（`modes` / `saveHint` / `emptyPreview` / `placeholder`）。
 *
 * 画面が今の表示をそのまま出せるように足した口で、**渡さなければ既定の振る舞いは
 * 変わらない**。だから各口について「渡さないとき」と「渡したとき」を両方置く。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownEditor } from './markdown-editor';

// 幅は `matchMedia` ではなくフックごと差し替える（jsdom に `matchMedia` が無いため。
// 画面側のテストは `apps/web/app/test-support.tsx` の足場を使う）。
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.mobile }));

beforeEach(() => {
  viewport.mobile = false;
});
afterEach(cleanup);

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

describe('modes', () => {
  it('既定: 編集・プレビュー・並べての順に出る', () => {
    render(<MarkdownEditor value="a" onChange={() => undefined} />);
    expect(tabNames()).toEqual(['編集', 'プレビュー', '並べて']);
  });

  it('既定: 狭い画面では並べてが出ない', () => {
    viewport.mobile = true;
    render(<MarkdownEditor value="a" onChange={() => undefined} />);
    expect(tabNames()).toEqual(['編集', 'プレビュー']);
  });

  it('渡した並びのとおりに出る（プレビュー → 編集）。渡していないタブは出ない', () => {
    render(<MarkdownEditor value="a" onChange={() => undefined} modes={['preview', 'edit']} />);
    expect(tabNames()).toEqual(['プレビュー', '編集']);
  });

  it('並べてが選ばれていても、modes に無ければ編集へ倒れる', () => {
    render(
      <MarkdownEditor
        value="a"
        onChange={() => undefined}
        modes={['preview', 'edit']}
        defaultMode="split"
      />,
    );
    expect(screen.getByRole('tab', { name: '編集' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('defaultMode が渡してあれば、中身が空でも空でなくてもそれで開く', () => {
    const { rerender } = render(
      <MarkdownEditor value="" onChange={() => undefined} defaultMode="preview" />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<MarkdownEditor value="中身" onChange={() => undefined} defaultMode="edit" />);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('saveHint', () => {
  it('既定: onSave があると「⌘/Ctrl + S で保存」が出る（onSave が無ければ出ない）', () => {
    const { rerender } = render(
      <MarkdownEditor value="" onChange={() => undefined} onSave={vi.fn()} />,
    );
    expect(screen.getByText('⌘/Ctrl + S で保存')).toBeTruthy();
    rerender(<MarkdownEditor value="" onChange={() => undefined} />);
    expect(screen.queryByText('⌘/Ctrl + S で保存')).toBeNull();
  });

  it('null を渡すと出ない。保存のキーは効いたまま', () => {
    const onSave = vi.fn();
    render(<MarkdownEditor value="" onChange={() => undefined} onSave={onSave} saveHint={null} />);
    expect(screen.queryByText('⌘/Ctrl + S で保存')).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('saveDisabled', () => {
  it('⌘/Ctrl + S も ⌘/Ctrl + Enter も、saveDisabled のあいだは onSave を呼ばない（#3300）', () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <MarkdownEditor value="" onChange={() => undefined} onSave={onSave} saveDisabled />,
    );
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 's', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    rerender(<MarkdownEditor value="" onChange={() => undefined} onSave={onSave} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('emptyPreview', () => {
  it('既定: 空のプレビューは「まだ何も書いていない」と言う', () => {
    render(<MarkdownEditor value="" onChange={() => undefined} defaultMode="preview" />);
    expect(screen.getByText('まだ何も書いていない。「編集」で書く。')).toBeTruthy();
  });

  it('null を渡すと一言を出さない（空の Markdown を描く）。中身があれば変わらない', () => {
    const { rerender } = render(
      <MarkdownEditor
        value=""
        onChange={() => undefined}
        defaultMode="preview"
        emptyPreview={null}
      />,
    );
    expect(screen.queryByText('まだ何も書いていない。「編集」で書く。')).toBeNull();
    expect(screen.queryByRole('paragraph')).toBeNull();
    rerender(
      <MarkdownEditor
        value="# 見出し"
        onChange={() => undefined}
        defaultMode="preview"
        emptyPreview={null}
      />,
    );
    expect(screen.getByRole('heading', { name: '見出し' })).toBeTruthy();
  });
});

describe('placeholder', () => {
  it('既定は「Markdown で書く」。空文字を渡すと何も出さない', () => {
    const { rerender } = render(<MarkdownEditor value="" onChange={() => undefined} />);
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Markdown で書く');
    rerender(<MarkdownEditor value="" onChange={() => undefined} placeholder="" />);
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('');
  });
});
