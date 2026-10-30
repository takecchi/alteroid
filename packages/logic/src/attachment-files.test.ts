import { classifyAttachmentFrom } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_FROM_LABELS,
  attachmentFromOf,
  attachmentSetExpiryLabel,
  describeAttachmentLifetime,
  isAttachmentFrom,
} from './attachment-files.js';

describe('attachmentFromOf', () => {
  it('core の classifyAttachmentFrom と同じ分類をする（複製のずれを落とす）', () => {
    for (const by of [
      undefined,
      'operator',
      'account:abc',
      'clone',
      'manager:m1',
      'integration:k1',
      'cloned',
      'someone',
      '',
      'account',
    ]) {
      expect(attachmentFromOf(by), String(by)).toBe(classifyAttachmentFrom(by));
    }
  });

  it('ラベルは 人間 / クローン / マネージャー / 連携 / 不明', () => {
    expect(Object.values(ATTACHMENT_FROM_LABELS)).toEqual([
      '人間',
      'クローン',
      'マネージャー',
      '連携',
      '不明',
    ]);
  });

  it('isAttachmentFrom は出所の5つだけ真', () => {
    expect(isAttachmentFrom('clone')).toBe(true);
    expect(isAttachmentFrom('robot')).toBe(false);
    expect(isAttachmentFrom(null)).toBe(false);
  });
});

describe('describeAttachmentLifetime', () => {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  it('期限なし（keptAt あり）は「期限なし」と言い、「保存中」とは言わない', () => {
    expect(
      describeAttachmentLifetime({ keptAt: '2026-10-01T00:00:00.000Z', expiresAt: undefined }, now),
    ).toEqual({ kept: true, text: '期限なし' });
  });
  it('未保存は期限を「に消える」と言う', () => {
    const life = describeAttachmentLifetime({ expiresAt: '2026-10-20T03:04:00.000Z' }, now);
    expect(life.kept).toBe(false);
    expect(life.text).toMatch(/に消える$/);
  });
  it('期限が無い未保存は期限は不明', () => {
    expect(describeAttachmentLifetime({}, now).text).toBe('期限は不明');
  });
});

describe('attachmentSetExpiryLabel', () => {
  it('保持日数が読めているときは、その日数をそのまま文字に出す（30 と 7）', () => {
    expect(attachmentSetExpiryLabel(30)).toBe('期限を付ける（30日後に消える）');
    expect(attachmentSetExpiryLabel(7)).toBe('期限を付ける（7日後に消える）');
  });
  it('読めない・正の整数でないときは数字を出さない', () => {
    for (const days of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const label = attachmentSetExpiryLabel(days);
      expect(label, String(days)).toBe('期限を付ける（保持日数が過ぎたら消える）');
      expect(label).not.toMatch(/\d/);
    }
  });
});
