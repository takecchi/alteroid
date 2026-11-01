import {
  attachmentBatchItemOf,
  isLargeAttachment,
  readAttachmentLimits,
  type AttachmentLimits,
} from './attachment.js';
import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import type { ManagerRecord, ManagerSendOptions, ManagerSendResult } from './manager.js';
import { loadManagerAttachments } from './manager-attachments.js';
import { fetchRescueFile } from './manager-outbox-fetch.js';
import {
  normalizeRescuePath,
  rescueStashClause,
  rescueStashKeys,
  rescueStashLocation,
} from './manager-notices.js';
import {
  RUNNER_CAPABILITY_RESCUE_FILES,
  RUNNER_CAPABILITY_RESCUE_RESTORE,
} from './runner-protocol.js';
import type { RunnerAttachment, RunnerClient, RunnerEvent } from './runner-protocol.js';
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
  records: ReadonlyMap<string, ManagerRecord>;
  /** `Pool#load` を束ねたもの。 */
  load: (managerId: string) => Promise<ManagerRecord | null>;
  /** `Pool#send` を `{ mode: 'caller' }`（クローンの `manager_send` と同じ届け方）で束ねたもの。 */
  send: (
    managerId: string,
    text: string,
    options: ManagerSendOptions,
  ) => Promise<ManagerSendResult>;
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
   * 担当の `rescue_restore` の依頼（#4863 案A その2）。対象の委譲の預かりを選び、添付つきで担当へ送る（クローンの `manager_send` と同じ経路）。
   * 断るとき・残りがあるときの理由は、同じ届け方で本文だけを送る。
   */
  async restore(
    requester: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'rescue_restore_request' }>,
  ): Promise<void> {
    const requesterId = event.managerId;
    const targetId = event.from ?? requesterId;
    const tell = async (
      text: string,
      attachments?: RunnerAttachment[],
    ): Promise<ManagerSendResult> =>
      this.#deps.send(
        requesterId,
        text,
        attachments === undefined || attachments.length === 0 ? {} : { attachments },
      );
    let target = requester;
    if (targetId !== requesterId) {
      const found = this.#deps.records.get(targetId) ?? (await this.#deps.load(targetId));
      // 後継が前任の分を取る。`supersededBy` は後継の起動の後に書かれるので、その間は後継の側の `supersedes` で確かめる
      const related =
        found !== null &&
        (found.job.supersededBy === requesterId ||
          (found.job.supersededBy === undefined && requester.job.supersedes === targetId));
      if (found === null || !related) {
        const why =
          found === null
            ? `${targetId} という委譲は居ない`
            : `${targetId} は、あなた（${requesterId}）が引き継いだ前任ではない`;
        await tell(
          `[system] rescue_restore を断った: ${why}。from に渡せるのは、自分が後継として引き継いだ前任の id だけである。` +
            '何も送っていない。',
        );
        await this.#deps.journal({
          type: 'decision',
          decision: `[${requesterId}] の rescue_restore（from=${targetId}）を断った。`,
          grounds: why,
        });
        return;
      }
      target = found;
    }

    const stash = target.job.rescueStash ?? [];
    const wanted = event.paths === undefined ? undefined : event.paths.map(normalizeRescuePath);
    const matched =
      wanted === undefined
        ? [...stash]
        : stash.filter((e) => {
            const keys = rescueStashKeys(e);
            return wanted.some((w) => keys.includes(w));
          });
    const unmatched =
      wanted === undefined
        ? []
        : wanted.filter((w) => !stash.some((e) => rescueStashKeys(e).includes(w)));
    if (matched.length === 0) {
      await tell(
        `[system] rescue_restore: ${targetId} の預かりに、依頼のファイルは無かった` +
          `（預かりは ${String(stash.length)} 件${unmatched.length > 0 ? `。合わなかった指定: ${unmatched.join(', ')}` : ''}）。` +
          '預かりは猶予（done 7日・failed/stopped 14日）を過ぎると消える。',
      );
      await this.#deps.journal({
        type: 'decision',
        decision: `[${requesterId}] の rescue_restore（対象 ${targetId}）に送るものが無かった。`,
        grounds: `預かり ${String(stash.length)} 件、合致 0 件。`,
      });
      return;
    }

    // 1通の個数と合計の上限（`readAttachmentLimits`）に収まる分だけ送り、残りは本文に出す
    const limits = this.#deps.attachmentLimits ?? readAttachmentLimits().limits;
    const chosen: { entry: RescueStashEntry; name: string }[] = [];
    const remaining: RescueStashEntry[] = [];
    const unsendable: { entry: RescueStashEntry; reason: string }[] = [];
    let total = 0;
    for (const entry of matched) {
      let meta;
      try {
        meta = await this.#deps.stores.attachments.getMeta(entry.attachmentId);
      } catch (error) {
        unsendable.push({ entry, reason: `控えを読めなかった: ${reasonOf(error)}` });
        continue;
      }
      if (meta === undefined) {
        unsendable.push({ entry, reason: '預かりの添付が消えている' });
        continue;
      }
      const large = isLargeAttachment(attachmentBatchItemOf(meta), limits);
      const added = large ? 0 : meta.size;
      if (!large && meta.size > limits.maxTotalBytes) {
        unsendable.push({
          entry,
          reason: `1通の合計の上限（${String(limits.maxTotalBytes)} バイト）を超える`,
        });
        continue;
      }
      if (chosen.length >= limits.maxPerMessage || total + added > limits.maxTotalBytes) {
        remaining.push(entry);
        continue;
      }
      total += added;
      chosen.push({ entry, name: meta.name });
    }

    const loaded = await loadManagerAttachments(
      this.#deps.stores,
      chosen.map((c) => c.entry.attachmentId),
      limits,
    );
    if (!loaded.ok) {
      await tell(`[system] rescue_restore: 預かりを読み出せなかった。${loaded.message}`);
      await this.#deps.journal({
        type: 'decision',
        decision: `[${requesterId}] の rescue_restore（対象 ${targetId}）で預かりを読み出せなかった。`,
        grounds: loaded.message,
      });
      return;
    }

    const lines = chosen.map(
      ({ entry, name }) =>
        `- ${rescueStashLocation(entry)}（添付名 ${name}・${String(entry.size)} バイト・sha256 ${entry.sha256.slice(0, 12)}・預けた時刻 ${entry.at}）`,
    );
    const body =
      `[system] rescue_restore: ${targetId} の預かり ${String(chosen.length)} 件を添付で届ける。` +
      '各ファイルの元の場所は次のとおり。元の場所に別の中身のファイルが既に在るなら、上書きする前に確かめること。\n' +
      lines.join('\n') +
      (remaining.length === 0
        ? ''
        : `\n\n1通の上限（${String(limits.maxPerMessage)} 個・合計 ${String(limits.maxTotalBytes)} バイト）に収まらなかった残り ${String(remaining.length)} 件は、まだ送っていない: ` +
          `${remaining.map(rescueStashLocation).join(', ')}。` +
          `受け取ったら、rescue_restore を paths に残りのパスを渡して呼び直すこと${targetId === requesterId ? '' : `（from: '${targetId}'）`}。`) +
      (unsendable.length === 0
        ? ''
        : `\n\n送れなかった分: ${unsendable.map((u) => `${rescueStashLocation(u.entry)}（${u.reason}）`).join(', ')}。`) +
      (unmatched.length === 0 ? '' : `\n\n預かりに無かった指定: ${unmatched.join(', ')}。`);
    const result = await tell(body, loaded.attachments);
    if (result.outcome !== 'delivered' && result.outcome !== 'answered') {
      // 添付つきの送信が通らなかったとき（添付の口を名乗らない器など）に担当が黙って待たないよう、本文だけで理由と呼び直しを知らせる（#4874）
      const reason = result.detail === '' ? '理由の記載なし' : result.detail;
      await tell(
        `[system] rescue_restore: 預かり ${String(chosen.length)} 件を送れなかった（結果: ${result.outcome}。${reason}）。` +
          '添付は何も送っていない。事情が解けたら、paths に必要なパスを渡して' +
          `rescue_restore を呼び直すこと${targetId === requesterId ? '' : `（from: '${targetId}'）`}。`,
      );
      await this.#deps.journal({
        type: 'decision',
        decision:
          `[${requesterId}] の rescue_restore（対象 ${targetId}）で、預かり ${String(chosen.length)} 件を [${requesterId}] へ送れなかった` +
          `（結果: ${result.outcome}）。`,
        grounds: `${reason}。本文だけで理由と呼び直しの案内を送った（#4874）。`,
      });
      return;
    }
    await this.#deps.journal({
      type: 'decision',
      decision:
        `[${requesterId}] の rescue_restore（対象 ${targetId}）で、預かり ${String(chosen.length)} 件を [${requesterId}] へ添付で送った` +
        `（結果: ${result.outcome}。残り ${String(remaining.length)} 件）。`,
      grounds:
        '器が入れ替わった後、担当が預かった未追跡のファイルを取り戻すため（#4863）。パスと件数だけを記録する。',
    });
  }

  /** 再開の文・後継の依頼文に足す、預かりの段落（空なら `undefined`）。`runnerId` は担当が走る器。 */
  note(
    stash: readonly RescueStashEntry[] | undefined,
    runnerId: string | undefined,
    from?: string,
  ): string | undefined {
    return rescueStashClause(stash, {
      restorable:
        runnerId !== undefined &&
        this.#deps.runnerHasCapability(runnerId, RUNNER_CAPABILITY_RESCUE_RESTORE),
      ...(from === undefined ? {} : { from }),
    });
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
