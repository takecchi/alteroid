// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

afterEach(() => {
  cleanup();
});

describe('shadcn 由来の閉じるボタンは日本語で引ける', () => {
  it('ダイアログの右上の閉じるボタンは「閉じる」', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>題</DialogTitle>
          <DialogDescription>説明</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('ダイアログのフッターの閉じるボタンは「閉じる」', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>題</DialogTitle>
          <DialogDescription>説明</DialogDescription>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('シートの閉じるボタンは「閉じる」', () => {
    render(
      <Sheet open>
        <SheetContent side="left">
          <SheetTitle>題</SheetTitle>
          <SheetDescription>説明</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
