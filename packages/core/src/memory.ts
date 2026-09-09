import { z } from "zod";
import type { MemoryId, ObservationId } from "./ids.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";

export type MemoryStatus = "active" | "superseded" | "contested" | "archived" | "forgotten";

export const MemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "contested",
  "archived",
  "forgotten",
]) satisfies z.ZodType<MemoryStatus>;

/**
 * `Memory.strength` の上限（ADR 0078）。
 *
 * `strength` は `total = similarity × decay × tagMatch × freshness × strength`
 * （docs/recall.md §7）に掛かる係数であり、**1 は「素通り」を意味する唯一の値**である。
 * 上限が無いと、値を1つ大きく書いた Memory がそのテナントの想起を支配する——
 * [ADR 0036](../../../docs/decisions/0036-clamp-freshness-at-one.md) が `freshness` で
 * 塞いだのと同じ穴である。
 *
 * `MAX_FRESHNESS`（`strategies/scoring.ts`）と同じ理由で export する:
 * 呼び出し側が**上限の存在と値を読める**形にしておく。
 */
export const MAX_STRENGTH = 1;

/**
 * `Memory.strength` の値域は **`(0, MAX_STRENGTH]`**（ADR 0078）。
 *
 * **0 を含めないのは、`strength = 0` が `total` を恒久的に 0 にする＝「二度と引かれない」
 * という意味になり、それは `status: 'forgotten'` が既に表しているからである。**
 * 同じことを言う道が2つ在ると、どちらで表されているかを読む側が両方見る必要が出る。
 *
 * 🔴 **`NaN` と `Infinity` を弾いているのは、この比較の「向き」である。**
 * `NaN` との比較は全部 false になるので `NaN > 0` が false になって落ちる。
 * `Infinity` は `Infinity <= 1` が false で落ちる。
 * **⚠ だから `value <= 0 || value > MAX_STRENGTH` のように否定で書き直してはならない**
 * ——その形にすると `NaN` は「範囲外ではない」と判定されて素通りする。
 *
 * ⚠ **最初は `Number.isFinite(value) &&` を先頭に置いていたが、変異試験で外した。**
 * それを落としても適合スイートは赤くならなかった——上のとおり冗長だからである。
 * **歯の当たらない防御を「守っている」の顔で残すと、後から比較の向きを変える人が
 * 「`isFinite` が見ているから大丈夫」と読む。**それがいちばん危ない。
 * 経緯は ADR 0078 の「変異試験で分かったこと」に書いてある。
 */
export function isStrengthInRange(value: number): boolean {
  return value > 0 && value <= MAX_STRENGTH;
}

export type EmbeddingStatus = "pending" | "ready" | "failed" | "skipped";

export const EmbeddingStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "skipped",
]) satisfies z.ZodType<EmbeddingStatus>;

export type DigestSource = "llm" | "fallback";

export const DigestSourceSchema = z.enum(["llm", "fallback"]) satisfies z.ZodType<DigestSource>;

/**
 * 解釈済みの記憶単位（docs/memory-model.md §1・§10）。
 *
 * `contentHash` について（D16）: content の SHA-256 の hex 文字列とする規約。
 * **core はこの値を計算しない**（Node の `crypto` に依存させないため、
 * docs/architecture.md §3.6 の「core は zod 以外の実行時依存を持たない」を守る）。
 * 呼び出し側・adapter が `crypto.createHash('sha256').update(content).digest('hex')`
 * （またはそれと同値の実装）で計算し、`NewMemory.contentHash` に渡すこと。
 */
export interface Memory {
  id: MemoryId;
  tenantId: string;
  subjectId?: string | null;

  sourceObservationId?: ObservationId | null;
  extractorVersion?: string | null;

  content: string;
  contentHash: string;
  digest: string;
  digestSource: DigestSource;

  provenance: Provenance;

  status: MemoryStatus;
  supersededById?: MemoryId | null;
  contestedWithId?: MemoryId | null;

  tags: string[];

  occurredAt?: Date | null;
  recordedAt: Date;
  lastReinforcedAt?: Date | null;

  strength: number;
  halfLifeHours: number;
  decayFloorAt: Date;

  embeddingStatus: EmbeddingStatus;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * `createMemory` への入力。`id` / `createdAt` / `updatedAt` は store が採番する。
 *
 * `contentHash` と `decayFloorAt` は呼び出し側（runtime/adapter）が計算して渡す。
 * `decayFloorAt` は `defaultDecayStrategy.floorAt(...)` を書き込み時に一度だけ呼んで
 * 得た値を渡すこと（docs/memory-model.md §7・ADR 0010）。
 */
export type NewMemory = Omit<
  Memory,
  "id" | "createdAt" | "updatedAt" | "status" | "supersededById" | "contestedWithId"
> &
  Partial<Pick<Memory, "status" | "supersededById" | "contestedWithId">>;

export const MemorySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),

  sourceObservationId: z.string().min(1).nullable().optional(),
  extractorVersion: z.string().min(1).nullable().optional(),

  content: z.string(),
  contentHash: z.string().min(1),
  digest: z.string().min(1),
  digestSource: DigestSourceSchema,

  provenance: ProvenanceSchema,

  status: MemoryStatusSchema,
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),

  tags: z.array(z.string()),

  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  lastReinforcedAt: z.date().nullable().optional(),

  // ADR 0078: 値域は `(0, MAX_STRENGTH]`。
  // ⚠ **この schema は書き込み経路では走らない**——`MemorySchema` / `NewMemorySchema` を
  // `.parse()` している箇所はリポジトリに0件であり、型の導出元として使われている。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、
  // in-memory 実装の検査）である。ここを締めるのは**公開された型の契約**としてであって、
  // これが防波堤なのではない。
  strength: z.number().gt(0).max(MAX_STRENGTH),
  halfLifeHours: z.number().positive(),
  decayFloorAt: z.date(),

  embeddingStatus: EmbeddingStatusSchema,

  createdAt: z.date(),
  updatedAt: z.date(),
}) satisfies z.ZodType<Memory>;

export const NewMemorySchema = MemorySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  supersededById: true,
  contestedWithId: true,
}).extend({
  status: MemoryStatusSchema.optional(),
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),
}) satisfies z.ZodType<NewMemory>;
