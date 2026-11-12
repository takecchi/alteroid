import {
  ATTACHMENT_FROM_CLASSES,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
  type AttachmentMeta,
  type AttachmentUsage,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  attachmentLimitsSchema,
  attachmentListQuery,
  attachmentListResponseSchema,
  attachmentMetaSchema,
} from './openapi.js';

// core の interface（AttachmentMeta / AttachmentUsage / AttachmentLimits）と daemon の zod は別々に宣言されている。
// 欄の足し忘れ・optional のずれは `.parse()` が黙って落とすので、ここで両方向の代入と欄名の集合で縛る。
// 型の向き: zod の推論 → interface が通らない = zod が足りない・型が違う / interface → zod が通らない = optional が緩い・欄が多い

type Usage = z.infer<typeof attachmentListResponseSchema>['usage'];

// コンパイルが通ること自体が検査（実行時には何もしない）
function assignable<A extends B, B>(): [A] extends [B] ? true : never {
  return true as never;
}
const TYPE_CHECKS = [
  assignable<z.infer<typeof attachmentMetaSchema>, AttachmentMeta>(),
  assignable<AttachmentMeta, z.infer<typeof attachmentMetaSchema>>(),
  assignable<Usage, AttachmentUsage>(),
  assignable<AttachmentUsage, Usage>(),
  assignable<z.infer<typeof attachmentLimitsSchema>, AttachmentLimits>(),
  assignable<AttachmentLimits, z.infer<typeof attachmentLimitsSchema>>(),
];

// 全欄を持つ見本: interface に欄が増えると `satisfies Required<...>` が落ちる
const FULL_META = {
  id: 'a',
  name: 'n',
  mediaType: 'text/plain',
  size: 1,
  sha256: 'x',
  conversationId: 'c',
  externalEventId: 'e',
  managerReportId: 'r',
  uploadedBy: 'operator',
  createdAt: '2026-10-07T00:00:00Z',
  expiresAt: '2026-10-08T00:00:00Z',
  keptAt: '2026-10-07T01:00:00Z',
  releasedAt: '2026-10-07T02:00:00Z',
} satisfies Required<AttachmentMeta>;

const REQUIRED_META_KEYS = ['id', 'name', 'mediaType', 'size', 'sha256', 'createdAt'];

describe('添付の3型の欄: core の interface と daemon の zod', () => {
  it('型の代入が両方向で通る', () => {
    expect(TYPE_CHECKS).toEqual([true, true, true, true, true, true]);
  });

  it('AttachmentMeta: 欄名が13欄そろい、必須は6欄だけで残りは optional', () => {
    const shape = attachmentMetaSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(Object.keys(FULL_META).sort());
    expect(Object.keys(shape)).toHaveLength(13);
    for (const [key, field] of Object.entries(shape)) {
      expect(field.isOptional(), key).toBe(!REQUIRED_META_KEYS.includes(key));
    }
  });

  it('AttachmentMeta: 全欄を持つ見本は1欄も落ちずに通る', () => {
    const parsed = attachmentMetaSchema.parse(FULL_META);
    expect(parsed).toEqual(FULL_META);
  });

  it('AttachmentLimits: 欄名が DEFAULT_ATTACHMENT_LIMITS の6欄とそろい、全部必須', () => {
    const shape = attachmentLimitsSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(Object.keys(DEFAULT_ATTACHMENT_LIMITS).sort());
    expect(Object.keys(shape)).toHaveLength(6);
    for (const [key, field] of Object.entries(shape)) {
      expect(field.isOptional(), key).toBe(false);
    }
    expect(attachmentLimitsSchema.parse(DEFAULT_ATTACHMENT_LIMITS)).toEqual(
      DEFAULT_ATTACHMENT_LIMITS,
    );
  });

  it('AttachmentUsage: 欄名（count / totalBytes / byFrom / byIntegrationKey）と byFrom のキーが ATTACHMENT_FROM_CLASSES と順序までそろう', () => {
    const usage = attachmentListResponseSchema.shape.usage;
    expect(Object.keys(usage.shape)).toEqual(['count', 'totalBytes', 'byFrom', 'byIntegrationKey']);
    expect(Object.keys(usage.shape.byFrom.shape)).toEqual([...ATTACHMENT_FROM_CLASSES]);
  });

  it('一覧の from の絞り込みが取れる値も ATTACHMENT_FROM_CLASSES と順序までそろう', () => {
    const from = attachmentListQuery.shape.from.unwrap();
    expect(from.options).toEqual([...ATTACHMENT_FROM_CLASSES]);
  });
});
