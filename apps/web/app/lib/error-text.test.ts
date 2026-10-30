import { describe, expect, it } from 'vitest';

import { AttachmentGoneError } from '@alteroid/swr';

import { describeAttachmentFailure, errorText } from './error-text';

describe('errorText', () => {
  it('Error は message を出す', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });
  it('Error 以外は String() で文字にする', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
  });
  it('秘密は伏せる', () => {
    expect(errorText(new Error('token sk-ant-api03-abcdefghijklmnop1234 failed'))).not.toContain(
      'abcdefghijklmnop1234',
    );
  });
});

describe('describeAttachmentFailure', () => {
  it('期限切れは接頭辞を付けない固定文', () => {
    expect(describeAttachmentFailure(new AttachmentGoneError())).toBe(
      '取り出せない（期限切れの可能性）',
    );
    expect(describeAttachmentFailure(new AttachmentGoneError(), '取り出せなかった: ')).toBe(
      '取り出せない（期限切れの可能性）',
    );
  });
  it('それ以外は errorText に接頭辞を付ける（既定は付けない）', () => {
    expect(describeAttachmentFailure(new Error('boom'))).toBe('boom');
    expect(describeAttachmentFailure(new Error('boom'), '取り出せなかった: ')).toBe(
      '取り出せなかった: boom',
    );
  });
});
