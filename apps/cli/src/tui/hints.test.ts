import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  HINT_AP_CONFIRM,
  HINT_AP_DATES,
  HINT_AP_DAY,
  HINT_AP_DETAIL,
  HINT_AP_DETAIL_FROM_DAY,
  approvalDetailHint,
  HINT_AP_FORM,
  HINT_AP_INPUT,
  HINT_AP_LIST,
  HINT_INPUT,
  HINT_JOURNAL_DETAIL,
  HINT_JOURNAL_FILTER,
  HINT_JOURNAL_LIST,
  HINT_MEM_DETAIL,
  HINT_MEM_LIST,
  HINT_MGR_CONFIRM,
  HINT_MGR_DETAIL,
  HINT_MGR_INPUT,
  HINT_MGR_LIST,
  HINT_NAV,
  HINT_PICKER,
  HINT_QUITTING,
} from './hints.js';

describe('フッタのキーヒント', () => {
  it('どれも 80 桁の端末で切れない（1 行で読み切れる）', () => {
    for (const hint of [
      HINT_INPUT,
      HINT_AP_CONFIRM,
      HINT_AP_DATES,
      HINT_AP_DAY,
      HINT_AP_DETAIL,
      HINT_AP_DETAIL_FROM_DAY,
      HINT_AP_FORM,
      HINT_AP_INPUT,
      HINT_AP_LIST,
      HINT_NAV,
      HINT_PICKER,
      HINT_QUITTING,
      HINT_MGR_LIST,
      HINT_MGR_DETAIL,
      HINT_MGR_INPUT,
      HINT_MGR_CONFIRM,
      HINT_JOURNAL_LIST,
      HINT_JOURNAL_DETAIL,
      HINT_JOURNAL_FILTER,
      HINT_MEM_LIST,
      HINT_MEM_DETAIL,
    ]) {
      expect(stringWidth(hint)).toBeLessThanOrEqual(80);
    }
  });

  it('一覧・詳細の案内は、どの画面からも効く Ctrl+C の「^C 中断」を載せる（#3517）', () => {
    for (const hint of [
      HINT_MGR_LIST,
      HINT_MGR_DETAIL,
      HINT_JOURNAL_LIST,
      HINT_JOURNAL_DETAIL,
      HINT_MEM_LIST,
      HINT_MEM_DETAIL,
      HINT_AP_LIST,
      HINT_AP_DATES,
      HINT_AP_DAY,
      HINT_AP_DETAIL,
      HINT_AP_DETAIL_FROM_DAY,
      HINT_AP_FORM,
    ]) {
      expect(hint).toContain('^C 中断');
    }
  });

  it('答えるフォームのフッタは、書きかけが残ることと送る前の確認の s を案内する', () => {
    // 80 桁に ^C 中断を収めるため「s 送る前の確認」を「s 確認」へ詰めた。書きかけが残る案内は外さない。
    expect(HINT_AP_FORM).toContain('書きかけは残る');
    expect(HINT_AP_FORM).toContain('s 確認');
  });

  it('日誌の一覧のフッタは、読み直しの r を案内する（#3485）', () => {
    // 80 桁に ^C 中断（#3517）を収めるため「/ コマンド」は外した。/ はどの画面でも効き、/help に載る。
    expect(HINT_JOURNAL_LIST).toContain('r 更新');
  });

  it('詳細の案内は開いた元で変わる（その日の件から開いたら Esc はその日へ。未回答から開いたら今のまま）', () => {
    expect(approvalDetailHint('list')).toBe(HINT_AP_DETAIL);
    expect(HINT_AP_DETAIL).toContain('Esc 一覧へ');
    expect(approvalDetailHint('day')).toBe(HINT_AP_DETAIL_FROM_DAY);
    expect(HINT_AP_DETAIL_FROM_DAY).toContain('Esc その日へ');
    expect(HINT_AP_DETAIL_FROM_DAY).not.toContain('Esc 一覧へ');
  });

  it('もう答えられない承認待ち（回答済み・取り下げ済み）の詳細の案内に、a 答える を出さない', () => {
    for (const from of ['list', 'day'] as const) {
      expect(approvalDetailHint(from, true)).toContain('a 答える');
      const settled = approvalDetailHint(from, false);
      expect(settled).not.toContain('a 答える');
      expect(settled).toContain('^C 中断');
      expect(settled.length).toBeLessThanOrEqual(80);
    }
    expect(approvalDetailHint('day', false)).toContain('Esc その日へ');
    expect(approvalDetailHint('list', false)).toContain('Esc 一覧へ');
  });

  it('入力欄のフッタは改行のキー（行末の \\ + Enter）を案内する', () => {
    expect(HINT_INPUT).toContain('\\+Enter 改行');
    expect(HINT_MGR_INPUT).toContain('\\+Enter 改行');
  });
});
