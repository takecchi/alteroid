import type { Ctx } from "../ctx.js";

/**
 * outbox ジョブの種別（docs/memory-model.md §10 の `outbox.kind` 列）。
 * `observations.kind` と同様、開いた判別可能ユニオンとして扱い、CHECK 制約に
 * 相当する閉じた型を core には持たせない。
 *
 * 🔴 **この型に名前が在ることは、`runtime.tick` がそれを処理することを意味しない。**
 * 名指しの列挙は「`outbox.kind` にどんな値が入りうるか」の見取り図であって、
 * 「誰が処理するか」ではない（issue #105: `consolidate` が在るのを見て「積めば
 * `tick` が処理してくれる」と読まれた。実際に読み違えた利用者が居る）。
 *
 * **`tick` が処理する kind の唯一の出所は `TICK_SUPPORTED_JOB_KINDS`**
 * （`../runtime.js`）である。**ここでその一覧を数え直さないこと**——散文の写しは
 * kind が増えた瞬間に黙って嘘になる。`tick` に渡した kind がそこに無かったときの
 * 倒れ方（終端で失敗し、`TickResult.unsupported` に名指しで出る）は ADR 0082。
 */
export type OutboxJobKind = "extract" | "embed" | "consolidate" | "reflect" | (string & {});

export interface OutboxJob {
  id: string;
  tenantId: string;
  kind: OutboxJobKind;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

/**
 * Scheduler — interface は Phase 1、既定実装は `InlineScheduler`
 * （docs/architecture.md §5.6）。BullMQ 実装は後続フェーズ。
 *
 * 契約:
 * - `enqueue` はジョブの重複投入に対して冪等でなくてよい（重複排除は消費側/extractor の
 *   冪等制約が担う）。
 */
export interface Scheduler {
  enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}
