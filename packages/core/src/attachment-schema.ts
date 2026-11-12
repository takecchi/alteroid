import { z } from 'zod';

// 添付の 3 型（meta・usage・limits）の zod の正本。core の型（`attachment.ts`）は `Readonly<z.infer<…>>` でここから導き、
// daemon の OpenAPI（`openapi.ts`）と storage-fs の meta.json の読み口もここを使う: 宣言が 3 か所に分かれて欄がずれるのを防ぐため。
// `package.json` の `exports` には出さない（zod を引かない軽い口 `attachment-wording` / `attachment-usage-keys` から切り離す）。
// `size` などの `.int()` は OpenAPI の出力（`openapi.json` の `integer` と min/max）を決める: `.nonnegative()` を足すと `minimum: 0` が出て spec が変わる。
// `.readonly()` も使わない（OpenAPI に `readOnly: true` が出る）。

export const attachmentMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  conversationId: z.string().optional(),
  externalEventId: z.string().optional(),
  /** 結び付け先は会話・外部イベント・報告のどれか1つ。 */
  managerReportId: z.string().optional(),
  /** 中身ではなく識別子だけを持つ（認証済みの主体を表す）。 */
  uploadedBy: z.string().optional(),
  createdAt: z.string(),
  /** 保存中（`keptAt` がある間）は持たない。 */
  expiresAt: z.string().optional(),
  /** 保存の印を付けた時刻。在る間は期限（`expiresAt`）でも未結び付け1時間の掃除でも消えない。外すと無くなる。 */
  keptAt: z.string().optional(),
  /** 在るものには未結び付け1時間の掃除を掛けない: 一度保存されたものは「上げただけで使わなかった残骸」ではないため。 */
  releasedAt: z.string().optional(),
});

export const attachmentUsageBucketSchema = z.object({
  count: z.number().int(),
  totalBytes: z.number().int(),
});

// `byFrom` は 5 キーの手書き（`ATTACHMENT_FROM_CLASSES` と同じ値）: `z.record(enum, …)` にすると zod 4 では JSON Schema の形が変わるため。一致は試験が縛る
export const attachmentUsageSchema = attachmentUsageBucketSchema.extend({
  byFrom: z.object({
    human: attachmentUsageBucketSchema,
    clone: attachmentUsageBucketSchema,
    manager: attachmentUsageBucketSchema,
    integration: attachmentUsageBucketSchema,
    unknown: attachmentUsageBucketSchema,
  }),
  /**
   * 連携の鍵ごとの内訳（鍵の id → 期限内の件数と合計）。上げたことの無い鍵は載らない。
   * 出所の区分（`byFrom.integration`）だけだと、どの鍵が増やしているかが見えず、枠を置くかを決め直せないため（#4005）。
   */
  byIntegrationKey: z.record(z.string(), attachmentUsageBucketSchema),
});

export const attachmentLimitsSchema = z.object({
  maxImageBytes: z.number().int(),
  maxFileBytes: z.number().int(),
  /** 外部ストレージが有効なときだけ効く別枠。0 は枠なし。 */
  maxLargeFileBytes: z.number().int(),
  maxPerMessage: z.number().int(),
  maxTotalBytes: z.number().int(),
  retentionDays: z.number().int(),
});
