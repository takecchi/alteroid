import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  addGrave,
  assertNoNul,
  listGraves,
  noteSessionMaterialUnreadable,
  removeGrave,
  type LostSessionGrave,
  type SessionRegistry,
  type TranscriptGrave,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const stateSchema = z.object({ cloneSessionId: z.string().nullable().default(null) });
const graveSchema = z.object({ archiveId: z.string().min(1) });
// 枠の後ろの順番待ち（#4884）。枠のファイルの形は変えない: 古い版が書いた1枠のファイルをそのまま読め、列のファイルが無ければ列は空として扱う。
const graveQueueSchema = z.object({ graves: z.array(graveSchema) });
const lostSessionQueueSchema = z.object({ graves: z.array(z.lazy(() => lostSessionSchema)) });
const distillFailuresSchema = z.object({
  graveId: z.string().min(1),
  failures: z.number().int().nonnegative(),
});
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
// 墓標2つの set だけはロックの中で書く: `clear…If` が同じパスのロックの中で読んで消すので、判定と `rm` の間に新しい墓標が消えるため
export class FsSessionRegistry implements SessionRegistry {
  readonly #dir: string;
  readonly #path: string;
  // 墓標は別のファイルに置く: `setCloneSessionId(null)` が `session.json` を丸ごと消すので、同居させると墓標も消えるため
  readonly #gravePath: string;
  // 別のファイルに置く: `#gravePath` と同時に立ちうるうえ、`#path` と同居すると `setCloneSessionId(null)` で消えるため
  readonly #lostSessionPath: string;
  readonly #graveQueuePath: string;
  readonly #lostSessionQueuePath: string;
  readonly #projectKeyPath: string;
  // 墓標の本体と別のファイルに置く: 墓標の形と `clear…If` の突き合わせに触れないため（#4752）
  readonly #distillFailuresPaths: Record<'transcript' | 'lost_session', string>;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'session.json');
    this.#gravePath = join(dir, 'transcript-grave.json');
    this.#lostSessionPath = join(dir, 'lost-session-grave.json');
    this.#graveQueuePath = join(dir, 'transcript-grave-queue.json');
    this.#lostSessionQueuePath = join(dir, 'lost-session-grave-queue.json');
    this.#projectKeyPath = join(dir, 'project-key.json');
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
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#path, `${JSON.stringify({ cloneSessionId: sessionId })}\n`);
  }

  async getTranscriptGrave(): Promise<TranscriptGrave | null> {
    return readSessionMaterial(this.#gravePath, '生ログの墓標（transcript-grave.json）', (raw) =>
      graveSchema.parse(JSON.parse(raw)),
    );
  }

  /** `clearTranscriptGraveIf` と同じロックの中で書く（理由はそちらの doc）。 */
  async setTranscriptGrave(grave: TranscriptGrave | null): Promise<void> {
    await withPathLock(this.#gravePath, async () => {
      if (grave === null) {
        await rm(this.#gravePath, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#gravePath, `${JSON.stringify(grave)}\n`);
    });
  }

  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return withPathLock(this.#gravePath, async () => {
      // 読みをロックの外へ出さない: `get` → 比較 → `set` と同じになり、判定と書き込みの間に割り込まれるため
      const state = await this.#readTranscriptState();
      const next = removeGrave(state, (g) => g.archiveId === archiveId);
      if (!next.removed) return false;
      await this.#writeTranscriptState(next);
      return true;
    });
  }

  // 枠と列は同じパスのロックの中で読み書きする: 別々だと足す回と下ろす回が互いの書き込みを消す
  async #readTranscriptState() {
    const primary = await readSessionMaterial(
      this.#gravePath,
      '生ログの墓標（transcript-grave.json）',
      (raw) => graveSchema.parse(JSON.parse(raw)),
    );
    const queued = await readSessionMaterial(
      this.#graveQueuePath,
      '生ログの墓標の順番待ち（transcript-grave-queue.json）',
      (raw) => graveQueueSchema.parse(JSON.parse(raw)),
    );
    return { primary, queue: queued?.graves ?? [] };
  }

  async #writeTranscriptState(state: {
    primary: TranscriptGrave | null;
    queue: TranscriptGrave[];
  }): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    if (state.primary === null) await rm(this.#gravePath, { force: true });
    else await writeFileAtomic(this.#gravePath, `${JSON.stringify(state.primary)}\n`);
    if (state.queue.length === 0) await rm(this.#graveQueuePath, { force: true });
    else {
      await writeFileAtomic(this.#graveQueuePath, `${JSON.stringify({ graves: state.queue })}\n`);
    }
  }

  async addTranscriptGrave(grave: TranscriptGrave): Promise<{ dropped: string[] }> {
    return withPathLock(this.#gravePath, async () => {
      const next = addGrave(
        await this.#readTranscriptState(),
        grave,
        (a, b) => a.archiveId === b.archiveId,
      );
      await this.#writeTranscriptState(next);
      return { dropped: next.dropped.map((g) => g.archiveId) };
    });
  }

  async listTranscriptGraves(): Promise<TranscriptGrave[]> {
    return withPathLock(this.#gravePath, async () => listGraves(await this.#readTranscriptState()));
  }

  async #readLostState() {
    const primary = await readSessionMaterial(
      this.#lostSessionPath,
      '再開素材を捨てた回の墓標（lost-session-grave.json）',
      (raw) => lostSessionSchema.parse(JSON.parse(raw)),
    );
    const queued = await readSessionMaterial(
      this.#lostSessionQueuePath,
      '再開素材を捨てた回の墓標の順番待ち（lost-session-grave-queue.json）',
      (raw) => lostSessionQueueSchema.parse(JSON.parse(raw)),
    );
    return { primary, queue: queued?.graves ?? [] };
  }

  async #writeLostState(state: {
    primary: LostSessionGrave | null;
    queue: LostSessionGrave[];
  }): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    if (state.primary === null) await rm(this.#lostSessionPath, { force: true });
    else await writeFileAtomic(this.#lostSessionPath, `${JSON.stringify(state.primary)}\n`);
    if (state.queue.length === 0) await rm(this.#lostSessionQueuePath, { force: true });
    else {
      await writeFileAtomic(
        this.#lostSessionQueuePath,
        `${JSON.stringify({ graves: state.queue })}\n`,
      );
    }
  }

  async addLostSessionGrave(grave: LostSessionGrave): Promise<{ dropped: string[] }> {
    return withPathLock(this.#lostSessionPath, async () => {
      const next = addGrave(
        await this.#readLostState(),
        grave,
        (a, b) => a.sessionId === b.sessionId,
      );
      await this.#writeLostState(next);
      return { dropped: next.dropped.map((g) => g.sessionId) };
    });
  }

  async listLostSessionGraves(): Promise<LostSessionGrave[]> {
    return withPathLock(this.#lostSessionPath, async () => listGraves(await this.#readLostState()));
  }

  async getLostSessionGrave(): Promise<LostSessionGrave | null> {
    return readSessionMaterial(
      this.#lostSessionPath,
      '再開素材を捨てた回の墓標（lost-session-grave.json）',
      (raw) => lostSessionSchema.parse(JSON.parse(raw)),
    );
  }

  /** `clearLostSessionGraveIf` と同じロックの中で書く。 */
  async setLostSessionGrave(grave: LostSessionGrave | null): Promise<void> {
    await withPathLock(this.#lostSessionPath, async () => {
      if (grave === null) {
        await rm(this.#lostSessionPath, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#lostSessionPath, `${JSON.stringify(grave)}\n`);
    });
  }

  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return withPathLock(this.#lostSessionPath, async () => {
      const next = removeGrave(await this.#readLostState(), (g) => g.sessionId === sessionId);
      if (!next.removed) return false;
      await this.#writeLostState(next);
      return true;
    });
  }

  // 読めなければ `null`: 数えられないだけで起動を止める理由が無いため（`readSessionMaterial` が跡を残す）
  async #readDistillFailures(path: string) {
    return readSessionMaterial(path, '墓標の蒸留失敗回数', (raw) =>
      distillFailuresSchema.parse(JSON.parse(raw)),
    );
  }

  async graveDistillFailures(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    const stored = await this.#readDistillFailures(this.#distillFailuresPaths[kind]);
    return stored?.graveId === graveId ? stored.failures : 0;
  }

  // 読んでから書くまでを同じパスのロックの中に置く: 別々だと2つの数え上げが同じ値から始まり、1回ぶん落ちるため
  async noteGraveDistillFailure(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    const path = this.#distillFailuresPaths[kind];
    return withPathLock(path, async () => {
      const stored = await this.#readDistillFailures(path);
      const failures = stored?.graveId === graveId ? stored.failures + 1 : 1;
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(path, `${JSON.stringify({ graveId, failures })}\n`);
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
      this.#gravePath,
      this.#lostSessionPath,
      this.#graveQueuePath,
      this.#lostSessionQueuePath,
      this.#projectKeyPath,
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
