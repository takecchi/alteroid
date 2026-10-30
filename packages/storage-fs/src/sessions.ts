import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  addGrave,
  assertNoNul,
  forgetDistillFailureCounts,
  noteSessionMaterialUnreadable,
  parseDistillFailureCounts,
  readDistillFailureCount,
  removeGrave,
  serializeDistillFailureCounts,
  type LostSessionGrave,
  type SessionRegistry,
  type TranscriptGrave,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const stateSchema = z.object({ cloneSessionId: z.string().nullable().default(null) });
const foldStateSchema = z.object({ state: z.string() });
const graveSchema = z.object({ archiveId: z.string().min(1) });
// 墓標の列（#4884）。古い版が書いた1枠のファイル（transcript-grave.json・lost-session-grave.json）は読まない: 読めなくても失われて困らない記録として捨てる（#5869）。列のファイルが無ければ列は空として扱う。
const graveQueueSchema = z.object({ graves: z.array(graveSchema) });
const lostSessionQueueSchema = z.object({ graves: z.array(z.lazy(() => lostSessionSchema)) });
const projectKeySchema = z.object({ projectKey: z.string().min(1) });
const lostSessionSchema = z.object({
  projectKey: z.string().min(1),
  sessionId: z.string().min(1),
});

// 読めなくても投げず `null` を返し、跡だけ残す: 投げるとクローンの起動そのものが止まるため
async function readSessionMaterial<T>(
  path: string,
  what: string,
  parse: (raw: string) => T,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    noteSessionMaterialUnreadable(what, error);
    return null;
  }
  try {
    return parse(raw);
  } catch (error) {
    noteSessionMaterialUnreadable(what, error);
    return null;
  }
}

// 素の `writeFile` ではなく `writeFileAtomic` で書く: truncate してから書くので、途中で読む側が切れた JSON を見るため
// `setCloneSessionId` / `setProjectKey` を `withPathLock` で囲まない: 全置換で読んでから書く隙が無く、lock ファイルが増えるだけのため。
// 墓標の列は読み書きを同じパスのロックの中で行う: 別々だと足す回と下ろす回が互いの書き込みを消すため
export class FsSessionRegistry implements SessionRegistry {
  readonly #dir: string;
  readonly #path: string;
  // 墓標は別のファイルに置く: `setCloneSessionId(null)` が `session.json` を丸ごと消すので、同居させると墓標も消えるため
  readonly #graveQueuePath: string;
  // 別のファイルに置く: `#graveQueuePath` と同時に立ちうるうえ、`#path` と同居すると `setCloneSessionId(null)` で消えるため
  readonly #lostSessionQueuePath: string;
  readonly #projectKeyPath: string;
  // `#path` と別のファイルに置く: id の書き込み（init のたび）が控えを巻き込まず、読み戻す側が id の一致で突き合わせられるため
  readonly #foldStatePath: string;
  // 墓標の本体と別のファイルに置く: 墓標の形と `clear…If` の突き合わせに触れないため（#4752）
  readonly #distillFailuresPaths: Record<'transcript' | 'lost_session', string>;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'session.json');
    this.#graveQueuePath = join(dir, 'transcript-grave-queue.json');
    this.#lostSessionQueuePath = join(dir, 'lost-session-grave-queue.json');
    this.#projectKeyPath = join(dir, 'project-key.json');
    this.#foldStatePath = join(dir, 'fold-state.json');
    this.#distillFailuresPaths = {
      transcript: join(dir, 'transcript-grave-distill-failures.json'),
      lost_session: join(dir, 'lost-session-grave-distill-failures.json'),
    };
  }

  async getCloneSessionId(): Promise<string | null> {
    return readSessionMaterial(
      this.#path,
      'クローンのセッション id（session.json）',
      (raw) => stateSchema.parse(JSON.parse(raw)).cloneSessionId,
    );
  }

  async setCloneSessionId(sessionId: string | null): Promise<void> {
    if (sessionId !== null) assertNoNul('session.cloneSessionId', sessionId);
    if (sessionId === null) {
      // 控えを先に消す: id だけが消えて控えが残る（逆順）窓を作らないため
      await rm(this.#foldStatePath, { force: true });
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#path, `${JSON.stringify({ cloneSessionId: sessionId })}\n`);
  }

  // 中身を解釈しない（壊れていれば呼び出し側が捨てる）。ファイルの形は `{ state: string }`
  async getFoldState(): Promise<string | null> {
    return readSessionMaterial(
      this.#foldStatePath,
      '畳みの控え（fold-state.json）',
      (raw) => foldStateSchema.parse(JSON.parse(raw)).state,
    );
  }

  async setFoldState(state: string | null): Promise<void> {
    if (state === null) {
      await rm(this.#foldStatePath, { force: true });
      return;
    }
    assertNoNul('session.foldState', state);
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#foldStatePath, `${JSON.stringify({ state })}\n`);
  }

  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return withPathLock(this.#graveQueuePath, async () => {
      // 読みをロックの外へ出さない: 読み → 比較 → 書き戻しが別々だと、判定と書き込みの間に新しい墓標が立って消えるため
      const next = removeGrave(await this.#readTranscriptQueue(), (g) => g.archiveId === archiveId);
      if (!next.removed) return false;
      await this.#writeTranscriptQueue(next.queue);
      await this.#forgetDistillFailures('transcript', [archiveId]);
      return true;
    });
  }

  async #readTranscriptQueue(): Promise<TranscriptGrave[]> {
    const queued = await readSessionMaterial(
      this.#graveQueuePath,
      '生ログの墓標の列（transcript-grave-queue.json）',
      (raw) => graveQueueSchema.parse(JSON.parse(raw)),
    );
    return queued?.graves ?? [];
  }

  async #writeTranscriptQueue(queue: TranscriptGrave[]): Promise<void> {
    if (queue.length === 0) {
      await rm(this.#graveQueuePath, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#graveQueuePath, `${JSON.stringify({ graves: queue })}\n`);
  }

  async addTranscriptGrave(grave: TranscriptGrave): Promise<{ dropped: string[] }> {
    return withPathLock(this.#graveQueuePath, async () => {
      const next = addGrave(
        await this.#readTranscriptQueue(),
        grave,
        (a, b) => a.archiveId === b.archiveId,
      );
      await this.#writeTranscriptQueue(next.queue);
      await this.#forgetDistillFailures(
        'transcript',
        next.dropped.map((g) => g.archiveId),
      );
      return { dropped: next.dropped.map((g) => g.archiveId) };
    });
  }

  async listTranscriptGraves(): Promise<TranscriptGrave[]> {
    return withPathLock(this.#graveQueuePath, () => this.#readTranscriptQueue());
  }

  async #readLostQueue(): Promise<LostSessionGrave[]> {
    const queued = await readSessionMaterial(
      this.#lostSessionQueuePath,
      '再開素材を捨てた回の墓標の列（lost-session-grave-queue.json）',
      (raw) => lostSessionQueueSchema.parse(JSON.parse(raw)),
    );
    return queued?.graves ?? [];
  }

  async #writeLostQueue(queue: LostSessionGrave[]): Promise<void> {
    if (queue.length === 0) {
      await rm(this.#lostSessionQueuePath, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#lostSessionQueuePath, `${JSON.stringify({ graves: queue })}\n`);
  }

  async addLostSessionGrave(grave: LostSessionGrave): Promise<{ dropped: string[] }> {
    return withPathLock(this.#lostSessionQueuePath, async () => {
      const next = addGrave(
        await this.#readLostQueue(),
        grave,
        (a, b) => a.sessionId === b.sessionId,
      );
      await this.#writeLostQueue(next.queue);
      await this.#forgetDistillFailures(
        'lost_session',
        next.dropped.map((g) => g.sessionId),
      );
      return { dropped: next.dropped.map((g) => g.sessionId) };
    });
  }

  async listLostSessionGraves(): Promise<LostSessionGrave[]> {
    return withPathLock(this.#lostSessionQueuePath, () => this.#readLostQueue());
  }

  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return withPathLock(this.#lostSessionQueuePath, async () => {
      const next = removeGrave(await this.#readLostQueue(), (g) => g.sessionId === sessionId);
      if (!next.removed) return false;
      await this.#writeLostQueue(next.queue);
      await this.#forgetDistillFailures('lost_session', [sessionId]);
      return true;
    });
  }

  // 読めなければ `null`: 数えられないだけで起動を止める理由が無いため（`readSessionMaterial` が跡を残す）
  async #readDistillFailures(path: string) {
    return readSessionMaterial(path, '墓標の蒸留失敗回数', (raw) => {
      const counts = parseDistillFailureCounts(JSON.parse(raw));
      if (counts === null) throw new Error('JSON としては読めたが、形に合わない');
      return counts;
    });
  }

  async graveDistillFailures(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    return readDistillFailureCount(
      await this.#readDistillFailures(this.#distillFailuresPaths[kind]),
      graveId,
    );
  }

  // 墓標が下りた・上限で落ちたら、その回数も消す（#4898）。数えるのと同じロックの中で読み書きする。記録が空になったらファイルごと消す
  async #forgetDistillFailures(
    kind: 'transcript' | 'lost_session',
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const path = this.#distillFailuresPaths[kind];
    await withPathLock(path, async () => {
      const stored = await this.#readDistillFailures(path);
      if (stored === null) return;
      const next = forgetDistillFailureCounts(stored, ids);
      if (Object.keys(next).length === 0) await rm(path, { force: true });
      else if (Object.keys(next).length !== Object.keys(stored).length) {
        await writeFileAtomic(path, `${serializeDistillFailureCounts(next)}\n`);
      }
    });
  }

  // 読んでから書くまでを同じパスのロックの中に置く: 別々だと2つの数え上げが同じ値から始まり、1回ぶん落ちるため
  async noteGraveDistillFailure(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    const path = this.#distillFailuresPaths[kind];
    return withPathLock(path, async () => {
      const stored = await this.#readDistillFailures(path);
      const failures = readDistillFailureCount(stored, graveId) + 1;
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        path,
        `${serializeDistillFailureCounts({ ...stored, [graveId]: failures })}\n`,
      );
      return failures;
    });
  }

  async getProjectKey(): Promise<string | null> {
    return readSessionMaterial(
      this.#projectKeyPath,
      'SDK が生ログを預ける scope（project-key.json）',
      (raw) => projectKeySchema.parse(JSON.parse(raw)).projectKey,
    );
  }

  async setProjectKey(projectKey: string): Promise<void> {
    assertNoNul('session.projectKey', projectKey);
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#projectKeyPath, `${JSON.stringify({ projectKey })}\n`);
  }

  async clear(): Promise<number> {
    const paths = [
      this.#path,
      this.#foldStatePath,
      this.#graveQueuePath,
      this.#lostSessionQueuePath,
      this.#projectKeyPath,
      this.#distillFailuresPaths.transcript,
      this.#distillFailuresPaths.lost_session,
    ];
    let removed = 0;
    for (const path of paths) {
      try {
        await rm(path);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}
