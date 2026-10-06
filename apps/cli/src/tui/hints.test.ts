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

  it('日誌の一覧のフッタは、読み直しの r と / コマンドを案内する（#3485）', () => {
    expect(HINT_JOURNAL_LIST).toContain('r 更新');
    expect(HINT_JOURNAL_LIST).toContain('/ コマンド');
  });

  it('詳細の案内は開いた元で変わる（その日の件から開いたら Esc はその日へ。未回答から開いたら今のまま）', () => {
    expect(approvalDetailHint('list')).toBe(HINT_AP_DETAIL);
    expect(HINT_AP_DETAIL).toContain('Esc 一覧へ');
    expect(approvalDetailHint('day')).toBe(HINT_AP_DETAIL_FROM_DAY);
    expect(HINT_AP_DETAIL_FROM_DAY).toContain('Esc その日へ');
    expect(HINT_AP_DETAIL_FROM_DAY).not.toContain('Esc 一覧へ');
  });
});
