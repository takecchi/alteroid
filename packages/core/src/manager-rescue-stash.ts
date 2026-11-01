import { readAttachmentLimits, type AttachmentLimits } from './attachment.js';
import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import type { ManagerRecord } from './manager.js';
import { fetchRescueFile } from './manager-outbox-fetch.js';
import { RUNNER_CAPABILITY_RESCUE_FILES } from './runner-protocol.js';
import type { RunnerClient, RunnerEvent } from './runner-protocol.js';
import {
  RESCUE_STASH_MAX_BYTES_PER_JOB,
  RESCUE_STASH_MAX_FILES_PER_JOB,
  type JournalEntryInput,
  type RescueStashEntry,
} from './schema.js';
import type { Stores } from './store.js';

export interface ManagerRescueStashDeps {
  stores: Pick<Stores, 'attachments'>;
  attachmentLimits: AttachmentLimits | undefined;
  /** `Pool#runnerOrNull` を束ねたもの。async の皮で包まない（await の回数・順を変えない）。 */
  runnerOrNull: (runnerId: string) => Promise<RunnerClient | null>;
  runnerHasCapability: (runnerId: string, capability: string) => boolean;
  /** `Pool#sighting(runnerId).instanceId` を束ねたもの。 */
  instanceIdOf: (runnerId: string) => string | undefined;
  /** `Pool#swapNote` を束ねたもの。 */
  swapNote: (runnerId: string, before: string | undefined) => string;
  nowIso: () => string;
  /** `Pool#persist` を束ねたもの。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#journal` を束ねたもの。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
}

/**
 * 未追跡のファイルの預かり（#4863 案A）の取り込みの側。台帳（`Job.rescueStash`・`Job.lastRescue`）は `ManagerRecord` の像と台帳の両方に在り、
 * 掃除の側（`RescueSweeper`）と共有するのでここでは持たない。持つのは委譲ごとの直列の鎖と、日誌へ書いた署名だけ。
 * runner 側の選び方と読み出し（`rescue-stash.ts`）とは別のファイル。
 */
export class ManagerRescueStash {
  readonly #deps: ManagerRescueStashDeps;
  /** 未追跡のファイルの預かり（`rescue_files`）を委譲ごとに直列にする: 読み書きの間に await が挟まるため。 */
  readonly #chains = new Map<string, Promise<void>>();
  /**
   * 日誌へ書いた「預けなかった」の署名（委譲ごと）。運び直しで同じ日誌を積まない。プロセス内だけ。
   * `Pool#retire()` で消さない: 畳んだ後の運び直し（周回の掃き）で同じ署名を書き直さないため。1委譲の署名は500件で入れ替える（`#journalSkips`）。
   */
  readonly #journaled = new Map<string, Set<string>>();

  constructor(deps: ManagerRescueStashDeps) {
    this.#deps = deps;
  }

  /** 同じ委譲の預かりは直列にする（job.rescueStash の読み書きの間に await が挟まる）。取り込みの終わりまで待つ。 */
  async acceptSerially(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'rescue_files' }>,
    fromRunnerId: string,
  ): Promise<void> {
    const previous = this.#chains.get(event.managerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#accept(record, event, fromRunnerId));
    const tail = next.catch(() => undefined);
    this.#chains.set(event.managerId, tail);
    void tail.then(() => {
      if (this.#chains.get(event.managerId) === tail) {
        this.#chains.delete(event.managerId);
      }
    });
    await next;
  }

  /**
   * runner が写した退避先から取りに行き、保存の印つき（期限で消えない）で添付ストアへ入れ、
   * `job.rescueStash` に載せる。名乗らない runner からは取りに行かない。取れたかどうかに関わらず退避先は消させる
   * （取れなかった分は runner が30分ごとに運び直すので、退避先に積み残さない）。
   * 預けなかったものは、パスと理由だけを日誌へ残す（値は出さない）。
   */
  async #accept(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'rescue_files' }>,
    fromRunnerId: string,
  ): Promise<void> {
    const managerId = event.managerId;
    const skipped: { path: string; reason: string; patterns?: readonly string[] }[] = [
      ...event.skipped,
    ];
    const instanceBefore = this.#deps.instanceIdOf(fromRunnerId);
    const runner = await this.#deps.runnerOrNull(fromRunnerId);
    const named =
      runner !== null &&
      this.#deps.runnerHasCapability(fromRunnerId, RUNNER_CAPABILITY_RESCUE_FILES);
    const removeStaged = async (fileId: string): Promise<void> => {
      if (runner === null || runner.deletePickupFile === undefined) return;
      await runner
        .deletePickupFile('rescue', managerId, fileId, { signal: AbortSignal.timeout(5000) })
        .catch(() => undefined);
    };
    const limits = this.#deps.attachmentLimits ?? readAttachmentLimits().limits;
    for (const file of event.files) {
      if (!named) {
        // 名乗らない器へは取りに行かない（口を持たない）。それでも退避先は消させる（#4925）: 消さないと runner の畳みが上限まで待つ
        skipped.push({ path: file.path, reason: 'runner が rescue-files を名乗っていない' });
        await removeStaged(file.fileId);
        continue;
      }
      const stash = record.job.rescueStash ?? [];
      const existing = stash.find((e) => e.worktree === event.worktree && e.path === file.path);
      if (existing?.sha256 === file.sha256) {
        // 預けた後に添付が消えていたら、同じ中身でも取り込み直す（#4874）。読めなかった回は消えたと決めつけない
        const gone =
          (await this.#deps.stores.attachments
            .getMeta(existing.attachmentId)
            .then((meta) => meta === undefined)
            .catch(() => false)) === true;
        if (!gone) {
          await removeStaged(file.fileId);
          continue;
        }
      }
      const others = stash.filter((e) => e !== existing);
      if (
        others.length >= RESCUE_STASH_MAX_FILES_PER_JOB ||
        others.reduce((sum, e) => sum + e.size, 0) + file.size > RESCUE_STASH_MAX_BYTES_PER_JOB
      ) {
        skipped.push({ path: file.path, reason: 'job-budget' });
        await removeStaged(file.fileId);
        continue;
      }
      let outcome;
      try {
        outcome = await fetchRescueFile({
          runner: runner!,
          managerId,
          path: file.path,
          file,
          store: this.#deps.stores.attachments,
          limits,
          swapNote: () => this.#deps.swapNote(fromRunnerId, instanceBefore),
        });
      } catch (error) {
        outcome = { ok: false as const, reason: `取り出しの処理が失敗した: ${reasonOf(error)}` };
      }
      await removeStaged(file.fileId);
      if (!outcome.ok) {
        skipped.push({ path: file.path, reason: `fetch-failed: ${outcome.reason}` });
        continue;
      }
      const at = this.#deps.nowIso();
      const entry: RescueStashEntry = {
        worktree: event.worktree,
        path: file.path,
        attachmentId: outcome.ref.id,
        size: outcome.ref.size,
        sha256: outcome.ref.sha256,
        at,
      };
      const current = record.job.rescueStash ?? [];
      record.job.rescueStash = [
        ...current.filter((e) => !(e.worktree === entry.worktree && e.path === entry.path)),
        entry,
      ];
      // 猶予の起点（`lastRescue`）が無ければ空の枠を作る: 掃除が終端の印と猶予を `lastRescue` から数えるため
      const previousRescue = record.job.lastRescue;
      record.job.lastRescue =
        previousRescue === undefined ? { at, worktrees: [] } : { ...previousRescue, at };
      await this.#deps.persist(record);
      if (existing !== undefined) {
        // 新しいほうを台帳へ書いた後で古い添付を消す。消せなくても台帳は新しい中身を指している
        await this.#deps.stores.attachments
          .remove(existing.attachmentId)
          .catch((error: unknown) => {
            noteDroppedRecord('預かりの古い添付の削除', `managerId=${managerId}`, error);
          });
      }
    }
    await this.#journalSkips(managerId, event.worktree, skipped);
  }

  async #journalSkips(
    managerId: string,
    worktree: string,
    skipped: readonly { path: string; reason: string; patterns?: readonly string[] }[],
  ): Promise<void> {
    if (skipped.length === 0) return;
    let seen = this.#journaled.get(managerId);
    if (seen === undefined || seen.size > 500) {
      seen = new Set();
      this.#journaled.set(managerId, seen);
    }
    const fresh = skipped.filter((item) => {
      const key = `${worktree}\0${item.path}\0${item.reason}\0${(item.patterns ?? []).join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) return;
    const shown = fresh.slice(0, 20).map((item) => {
      const patterns =
        item.patterns === undefined || item.patterns.length === 0
          ? ''
          : `、当たった形: ${item.patterns.join(', ')}`;
      return `${item.path}（${item.reason}${patterns}）`;
    });
    await this.#deps.journal({
      type: 'decision',
      decision: `作業ツリー ${worktree} の未追跡のファイル ${String(fresh.length)} 件を、デーモンの置き場へ預けなかった。`,
      grounds:
        `${shown.join('、')}${fresh.length > shown.length ? `、ほか ${String(fresh.length - shown.length)} 件` : ''}。` +
        'パス名と理由だけを記録する（中身・鍵らしい文字列そのものは記録しない）。' +
        '`secret-like` は取り除くか伏せれば次の周期で預けられる。',
      routine: true,
    });
  }
}
