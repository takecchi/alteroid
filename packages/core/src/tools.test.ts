import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  clearRecentTracesForTesting,
  journalEntryShape,
  noteDroppedRecord,
  noteManagerIdCollision,
  recentDroppedTraces,
  setStderrSinkForTesting,
} from './dropped-record.js';
import type {
  ManagerDenial,
  ManagerPool,
  ManagerSendResult,
  ManagerSummary,
  ManagerUnpushedWork,
  RunnerBacklogSnapshot,
  RunnerFleetOverview,
} from './manager.js';
import { commitmentFor } from './clone.js';
import { encodeRunnerCursor } from './runner-cursor.js';
import { runnerLivenessSchema, type PidsSaturation } from './runner-protocol.js';
import { encodeUsageCursor } from './usage-cursor.js';
import { CLONE_ACTOR_ID } from './usage.js';
import { STALE_TOKEN_RECOVERY_CAVEAT } from './usage-limits.js';
import { measureMemoryFloor, renderMemoryDocuments, scanMemorySections } from './memory.js';
import { createProfileService } from './profile-service.js';
import { createProfileApplier, createProfileVessel } from './profile.js';
import type { ProfileApplier } from './profile.js';
import { heuristicChars, type HeuristicChars } from './quantity.js';
import {
  journalEntrySchema,
  PERMISSION_GRANT_CONSENT_PHRASE,
  type ChatStreamEvent,
  type InboxEvent,
  type JobStatus,
} from './schema.js';
import type { ScheduleStatus } from './schedule.js';
import { CLONE_RUNTIME_ITEM_LABELS, describeCloneRuntime, type CloneRuntimeFacts } from './self.js';
import { memoryVersion, practiceVersion, UnreadableApprovalError } from './store.js';
import type { Stores } from './store.js';
import {
  UnreadableActiveTokenError,
  UnreadableCommitmentError,
  UnreadableScheduleError,
  UnreadableTokenSettingsError,
} from './store.js';
import { captureStderr, createMemoryStores, failingJournalAppend } from './testing.js';
import { buildCloneSystemPrompt } from './prompt.js';
import {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  createCloneTools,
  cloneToolCarriesSecrets,
  cloneToolJournalsItself,
  detectMcpInputValidationFailure,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
  qualifiedToolName,
  SELF_JOURNALING_CLONE_TOOLS,
  TRACELESS_CLONE_TOOLS,
  type ToolContext,
} from './tools.js';
import type { RecentDenial } from './denial-shape.js';
import type { AccountUsageState } from './usage-snapshot.js';
import { usageDate } from './usage.js';

interface Harness {
  stores: Stores;
  recentDenials: RecentDenial[];
  managers: ManagerPool;
  emitted: ChatStreamEvent[];
  posted: { conversationId: string; text: string }[];
  sent: { managerId: string; message: string; decision?: string; requestId?: string }[];
  started: { request: string; cwd?: string; runnerId?: string; conversationId?: string }[];
  aborted: { managerId: string; reason?: string }[];
  abortDetails: string[];
  distributed: string[];
  running: ManagerSummary[];
  denied: Map<string, ManagerDenial[]>;
  setAbortOutcome(outcome: 'stopped' | 'not_stopped' | 'unknown', sessionGone?: boolean): void;
  setAutoRunnerId(runnerId: string | undefined): void;
  setPidsSaturation(runnerId: string, saturation: PidsSaturation | undefined): void;
  setSendResult(result: ManagerSendResult): void;
  setRunnersOverview(overview: RunnerFleetOverview): void;
  setRunnerBacklog(snapshots: RunnerBacklogSnapshot[]): void;
  setTranscript(managerId: string, body: string | null, archiveId?: string): void;
  setTranscriptFailure(managerId: string, message: string): void;
  setTranscriptRemoved(
    managerId: string,
    detail: { archiveId: string; removedAt: string; bytes: number },
  ): void;
  setRunningManagerOwning(archiveId: string, managerId: string | undefined): void;
  transcriptCalls: string[];
  setUnpushedWork(managerId: string, value: ManagerUnpushedWork): void;
  setUnpushedWorkThrows(managerId: string, message: string): void;
  setListFailures(calls: number[], message: string): void;
  unpushedWorkCalls: { managerId: string; hasSignal: boolean }[];
  runnersCalls: { fingerprints?: boolean; resources?: boolean }[];
  setMemoryCause(cause: 'distill' | 'clone'): void;
  setConversationId(id: string | undefined): void;
  setQueuedInMemory(value: number | undefined): void;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

async function writeBased(h: Harness, args: Record<string, unknown>): Promise<string> {
  const current = await h.stores.persona.read(String(args.slug));
  return h.call('memory_write', {
    ...args,
    ...(current !== null && args.base_version === undefined
      ? { base_version: memoryVersion(current.content) }
      : {}),
  });
}

async function fmBased(h: Harness, args: Record<string, unknown>): Promise<string> {
  const current = await h.stores.persona.read(String(args.slug));
  return h.call('memory_frontmatter_set', {
    ...args,
    ...(current !== null && args.base_version === undefined
      ? { base_version: memoryVersion(current.content) }
      : {}),
  });
}

async function delBased(h: Harness, args: Record<string, unknown>): Promise<string> {
  const current = await h.stores.persona.read(String(args.slug));
  return h.call('memory_delete', {
    ...args,
    ...(current !== null && args.base_version === undefined
      ? { base_version: memoryVersion(current.content) }
      : {}),
  });
}

function harness(runtime?: () => CloneRuntimeFacts, scheduler?: () => ScheduleStatus[]): Harness {
  const stores = createMemoryStores();
  const emitted: ChatStreamEvent[] = [];
  const posted: { conversationId: string; text: string }[] = [];
  const sent: { managerId: string; message: string; decision?: string; requestId?: string }[] = [];
  const started: { request: string; cwd?: string; runnerId?: string; conversationId?: string }[] =
    [];
  const aborted: { managerId: string; reason?: string }[] = [];
  const abortDetails: string[] = [];
  const running: ManagerSummary[] = [];
  const denied = new Map<string, ManagerDenial[]>();
  let abortOutcome: 'stopped' | 'not_stopped' | 'unknown' = 'stopped';
  const recentDenials: RecentDenial[] = [];
  let abortSessionGone: boolean | undefined = true;
  let autoRunnerId: string | undefined = 'runner-test';
  const pidsSaturations = new Map<string, PidsSaturation>();
  let sendResult: ManagerSendResult = { outcome: 'answered', detail: '回答した。' };
  let runnersOverview: RunnerFleetOverview = {
    runners: [],
    unassigned: [],
    daemonRevision: { status: 'unknown' },
  };
  const runnersCalls: { fingerprints?: boolean; resources?: boolean }[] = [];
  let runnerBacklog: RunnerBacklogSnapshot[] = [];
  type TranscriptState =
    | { kind: 'body'; body: string; archiveId?: string }
    | { kind: 'removed'; archiveId: string; removedAt: string; bytes: number };
  const transcripts = new Map<string, TranscriptState>();
  const transcriptErrors = new Map<string, string>();
  const transcriptCalls: string[] = [];
  const unpushedWorkResults = new Map<string, ManagerUnpushedWork>();
  const unpushedWorkErrors = new Map<string, string>();
  const unpushedWorkCalls: { managerId: string; hasSignal: boolean }[] = [];
  let listCallCount = 0;
  let listFailure: { calls: number[]; message: string } = { calls: [], message: '' };
  const runningOwners = new Map<string, string>();
  let memoryCause: 'distill' | 'clone' = 'clone';
  let conversationId: string | undefined;
  let queuedInMemory: number | undefined;

  const managers: ManagerPool = {
    async start(input) {
      started.push(input);
      const summary: ManagerSummary = {
        managerId: `mgr-${started.length}`,
        status: 'running',
        live: true,
        cwd: input.cwd ?? '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
        ...((input.runnerId ?? autoRunnerId) === undefined
          ? {}
          : { runnerId: input.runnerId ?? autoRunnerId }),
      };
      running.push(summary);
      return summary;
    },
    async send(managerId, message, options = {}) {
      sent.push({ managerId, message, ...options });
      return sendResult;
    },
    async list() {
      listCallCount += 1;
      if (listFailure.calls.includes(listCallCount)) throw new Error(listFailure.message);
      return running.map((manager) => ({ ...manager }));
    },
    denials(managerId: string) {
      return denied.get(managerId) ?? [];
    },
    pushHealthOf() {
      return undefined;
    },
    async transcript(managerId: string) {
      transcriptCalls.push(managerId);
      const failure = transcriptErrors.get(managerId);
      if (failure !== undefined) throw new Error(failure);
      return transcripts.get(managerId) ?? { kind: 'missing' as const };
    },
    async unpushedWork(managerId: string, options?: { signal?: AbortSignal }) {
      unpushedWorkCalls.push({ managerId, hasSignal: options?.signal !== undefined });
      const failure = unpushedWorkErrors.get(managerId);
      if (failure !== undefined) throw new Error(failure);
      return (
        unpushedWorkResults.get(managerId) ?? {
          kind: 'unavailable' as const,
          reason: '(テストの既定: 未設定)',
        }
      );
    },
    runningManagerOwning(archiveId: string) {
      return runningOwners.get(archiveId);
    },
    async restore() {
      return [];
    },
    async resumeStoppedByUsage() {
      return [];
    },
    async reattachRunner() {},
    relocateFrom() {},
    async vacate() {
      return {};
    },
    async abort(managerId: string, reason?: string) {
      aborted.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      const found = running.find((manager) => manager.managerId === managerId);
      if (!found) {
        const detail = `${managerId} というマネージャーは居ない。`;
        abortDetails.push(detail);
        return { outcome: 'absent' as const, detail };
      }
      if (abortOutcome === 'stopped') {
        found.status = 'stopped';
        found.live = false;
      }
      const detail =
        abortOutcome === 'stopped'
          ? '止めた'
          : abortOutcome === 'not_stopped'
            ? 'まだ止まっていない'
            : '止まったかは未確認';
      abortDetails.push(detail);
      return {
        outcome: abortOutcome,
        detail,
        ...(abortSessionGone === undefined ? {} : { sessionGone: abortSessionGone }),
      };
    },
    async runners(options = {}) {
      runnersCalls.push(options);
      return runnersOverview;
    },
    runnerBacklog() {
      return runnerBacklog;
    },
    runnerPidsSaturation(runnerId: string) {
      return pidsSaturations.get(runnerId);
    },
    async runnerIdOf(managerId: string) {
      return running.find((manager) => manager.managerId === managerId)?.runnerId;
    },
    async probeTurnEnds() {},
    async flushWithheldReports() {},
    async settleStalledUsageWakes() {
      return [];
    },
    async renotifyStalledDenials() {},
    async stop() {},
  };

  const distributed: string[] = [];
  const runners = {
    async list() {
      return [
        {
          runnerId: 'runner-test',
          async setProfile(script: string) {
            distributed.push(script);
            return { ok: true as const };
          },
        },
      ];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;

  const tools = createCloneTools({
    stores,
    emit: (event) => emitted.push(event),
    managers,
    profile: createProfileService({ stores, runners }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(scheduler === undefined ? {} : { scheduler }),
    memoryCause: () => memoryCause,
    conversationId: () => conversationId,
    queuedInMemory: () => queuedInMemory,
    postToConversation: (id, body) => posted.push({ conversationId: id, text: body }),
    recentDenials: () => recentDenials,
  });

  return {
    stores,
    recentDenials,
    managers,
    emitted,
    posted,
    sent,
    started,
    aborted,
    abortDetails,
    distributed,
    running,
    denied,
    setMemoryCause(cause) {
      memoryCause = cause;
    },
    setConversationId(id) {
      conversationId = id;
    },
    setQueuedInMemory(value) {
      queuedInMemory = value;
    },
    setAbortOutcome(outcome, sessionGone) {
      abortOutcome = outcome;
      abortSessionGone =
        sessionGone ??
        (outcome === 'stopped' ? true : outcome === 'not_stopped' ? false : undefined);
    },
    setAutoRunnerId(runnerId) {
      autoRunnerId = runnerId;
    },
    setPidsSaturation(runnerId, saturation) {
      if (saturation === undefined) pidsSaturations.delete(runnerId);
      else pidsSaturations.set(runnerId, saturation);
    },
    setSendResult(result) {
      sendResult = result;
    },
    setRunnersOverview(overview) {
      runnersOverview = overview;
    },
    setRunnerBacklog(snapshots) {
      runnerBacklog = snapshots;
    },
    setTranscript(managerId, body, archiveId) {
      if (body === null) transcripts.delete(managerId);
      else
        transcripts.set(managerId, {
          kind: 'body',
          body,
          ...(archiveId === undefined ? {} : { archiveId }),
        });
    },
    setTranscriptFailure(managerId, message) {
      transcriptErrors.set(managerId, message);
    },
    setTranscriptRemoved(managerId, detail) {
      transcripts.set(managerId, { kind: 'removed', ...detail });
    },
    setRunningManagerOwning(archiveId, managerId) {
      if (managerId === undefined) runningOwners.delete(archiveId);
      else runningOwners.set(archiveId, managerId);
    },
    setUnpushedWork(managerId, value) {
      unpushedWorkResults.set(managerId, value);
    },
    setUnpushedWorkThrows(managerId, message) {
      unpushedWorkErrors.set(managerId, message);
    },
    setListFailures(calls, message) {
      listCallCount = 0;
      listFailure = { calls, message };
    },
    unpushedWorkCalls,
    transcriptCalls,
    runnersCalls,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('クローンの道具', () => {
  it('モデルから見える名前は mcp__alteroid__* である', () => {
    expect(qualifiedToolName('ask_human')).toBe('mcp__alteroid__ask_human');
    expect(CLONE_ALLOWED_TOOLS).toContain('mcp__alteroid__memory_write');
  });

  it('memory_write は本文の数字・識別子の増減を応答に添え、増減が無ければ何も足さない（#1306）', async () => {
    const h = harness();
    await writeBased(h, {
      slug: 'ops',
      content: '# 運用\n\n必須チェックは 4本: `ci` / `pr-title-type`\n',
      summary: '初版',
    });

    const changed = await writeBased(h, {
      slug: 'ops',
      content: '# 運用\n\n必須チェックは 3本: `ci`\n',
      summary: '門を1本外した',
    });
    expect(changed).toContain('本文の数字・識別子の増減（#1306）');
    expect(changed).toContain('`pr-title-type`');

    const same = await writeBased(h, {
      slug: 'ops',
      content: '# 運用\n\n必須チェックは 3本: `ci`（書き直した）\n',
      summary: '言い回しだけ',
    });
    expect(same).not.toContain('本文の数字・識別子の増減');
  });

  it('memory_write は記憶を更新し、日誌に memory_update を残す', async () => {
    const h = harness();

    await writeBased(h, {
      slug: 'values',
      content: '# 価値観\n\n速さより正しさ\n',
      summary: '価値観を書いた',
    });

    expect((await h.stores.persona.read('values'))?.content).toContain('速さより正しさ');
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', cause: 'clone' });
  });

  it('memory_write の日誌には action: "write" が構造として載る（文言だけに頼らない）', async () => {
    const h = harness();

    await writeBased(h, { slug: 'values', content: '本文', summary: '書いた' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'write' });
  });

  it('memory_write の日誌には bytesBefore / bytesAfter が数として記録される', async () => {
    const h = harness();
    await writeBased(h, { slug: 'values', content: '12345', summary: '最初' });
    await writeBased(h, { slug: 'values', content: '1234567890', summary: '書き換え' });

    const [second, first] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(first).toMatchObject({ bytesBefore: 0, bytesAfter: 6 });
    expect(second).toMatchObject({ bytesBefore: 6, bytesAfter: 11 });
  });

  describe('memory_write / memory_append の応答（差分の要約、#318 案 (d)）', () => {
    it('新規作成のときは「前」が無いので、増減ではなく新規作成と分かる形で返す', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'new-doc',
        content: '12345',
        summary: '新規',
      });

      expect(reply).toContain('新規作成');
      expect(reply).toContain('6 文字');
      expect(reply).not.toContain('→');
    });

    it('書き換えでは前後の文字数と増減が文字単位で出る（Issue #318 の例と同じ桁）', async () => {
      const h = harness();
      await writeBased(h, { slug: 'values', content: 'a'.repeat(12345), summary: '最初' });

      const reply = await writeBased(h, {
        slug: 'values',
        content: 'b'.repeat(4567),
        summary: '書き換え',
      });

      expect(reply).toContain('12,346 → 4,568 文字（-7,778）');
    });

    it('全角文字では文字数とバイト数が一致しない。応答は文字数（バイトではない）', async () => {
      const h = harness();
      await writeBased(h, { slug: 'values', content: '', summary: '空' });

      const reply = await writeBased(h, {
        slug: 'values',
        content: '価値観です',
        summary: '書いた',
      });

      expect(reply).toContain('1 → 6 文字（+5）');
      expect(reply).not.toContain('15');
    });

    it('増える書き換えは + 付きで出る', async () => {
      const h = harness();
      await writeBased(h, { slug: 'values', content: '12345', summary: '最初' });

      const reply = await writeBased(h, {
        slug: 'values',
        content: '1234567890',
        summary: '増やした',
      });

      expect(reply).toContain('6 → 11 文字（+5）');
    });

    it('消えた見出しを名指しで列挙する', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n本文\n\n## 旧仕様\n\n消える節\n\n## 現行仕様\n\n残る節\n',
        summary: '最初',
      });

      const reply = await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n本文\n\n## 現行仕様\n\n残る節\n',
        summary: '旧仕様を削除',
      });

      expect(reply).toContain('## 旧仕様');
      expect(reply).not.toContain('## 現行仕様');
    });

    it('見出しがまったく消えていないときは「なし」と分かる形で返す', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n本文\n',
        summary: '最初',
      });

      const reply = await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n書き足した本文\n',
        summary: '本文だけ変えた',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
    });

    it('見出しの抽出は行頭の # に限る。行の途中の # は見出しとして数えない', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n価格は $100 くらい # メモ\n',
        summary: '最初',
      });

      const reply = await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n',
        summary: '本文行を削った',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
    });

    it('末尾の行が見出しの文書へ追記しても、その見出しは消えた見出しに出ない（説明文の「常に0件」の根拠）', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n\n本文\n\n## 最後の節',
        summary: '最初',
      });

      const reply = await h.call('memory_append', {
        slug: 'doc',
        content: '追記した1行',
        summary: '追記',
      });

      expect(reply).toContain('消えた見出し: なし。');
      const stored = (await h.stores.persona.read('doc'))?.content ?? '';
      expect(stored.split('\n')).toContain('## 最後の節');
    });

    it('同じ見出しが他所に残っていれば節を丸ごと消しても名指しされない（集合で比べる設計。文字数の減少だけが手がかりになる）', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'doc',
        content: '# 私について\n### だから\n本文A\n## 経歴\n### だから\n本文B\n',
        summary: '最初',
      });

      const reply = await writeBased(h, {
        slug: 'doc',
        content: '# 私について\n### だから\n本文A\n## 経歴\n',
        summary: '節を1つ落とした',
      });

      expect(reply).toContain('消えた見出し: なし。');
      expect(reply).toContain('（-12）');
    });

    it('消えた見出しが多いときは文字数の予算で締め、切ったと分かる形で言う', async () => {
      const h = harness();
      const headings = Array.from({ length: 80 }, (_, i) => `## 見出し番号${i}`);
      await writeBased(h, {
        slug: 'doc',
        content: headings.join('\n\n'),
        summary: '最初',
      });

      const reply = await writeBased(h, {
        slug: 'doc',
        content: '# 総論だけ残す\n',
        summary: '全部消した',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('80 件');
      expect(reply).toContain('省略');
      expect(reply).not.toContain('## 見出し番号79');
      expect(reply).toContain('残りを見る手はここに無い');
    });

    it('memory_append の応答にも同じ要約が付く（新規作成の形）', async () => {
      const h = harness();

      const reply = await h.call('memory_append', {
        slug: 'notes',
        content: '最初の1行',
        summary: '新規',
      });

      expect(reply).toContain('新規作成');
    });

    it('memory_append は既存を消さないので、消えた見出しは常に0件のはず（0でないなら異常）', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'notes',
        content: '# 総論\n\n## 節1\n\n本文\n',
        summary: '最初',
      });

      const reply = await h.call('memory_append', {
        slug: 'notes',
        content: '## 追記した節\n\n追記した本文',
        summary: '追記',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
      expect((await h.stores.persona.read('notes'))?.content).toContain('## 節1');
    });
  });

  describe('書く4口の応答に足す「毎ターンの床」（describeMemoryFloor、記憶の肥大への恒久対策）', () => {
    it('⭐ premise を新規作成すると、区分・床の遷移（文字）・「毎ターン要旨＋節の目次が焼かれる」の3つが出る', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'about-me-core',
        content: '# 私の芯\n\n'.concat('大事にしていること。'.repeat(50)),
        summary: '新しい芯を作った',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('毎ターンの床');
      expect(reply).toContain('「要旨＋節の目次」がクローンの文脈へ焼かれる');
      expect(reply).toContain('本文は載らない');
      expect(reply).toContain('memory_section_read');
      expect(reply).toMatch(/0 文字から [\d,]+ 文字へ/);
      expect(reply).toContain('いま読み直した値');
    });

    it('⭐ premise を新規作成すると、いま最大の premise の名指しと、縮める3手順の道具名が出る', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'small-premise',
        content: '# 小さい前提\n短い',
        summary: '先に小さい premise を作る',
      });

      const reply = await writeBased(h, {
        slug: 'about-me-core',
        content: '# 私の芯\n\n'.concat('大事にしていること。'.repeat(50)),
        summary: '新しい芯を作った',
      });

      expect(reply).toContain('いま最も大きい premise: about-me-core');
      expect(reply).toContain('memory_outline');
      expect(reply).toContain('memory_section_move');
      expect(reply).toContain('memory_frontmatter_set');
    });

    it('fact を新規作成しても「要旨＋節の目次が焼かれる」の1行は出ない', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'fact-doc',
        content: '---\ntype: fact\ndescription: 事実\n---\n# 事実\n本文',
        summary: '新規',
      });

      expect(reply).toContain('fact');
      expect(reply).toContain('毎ターンの床');
      expect(reply).not.toContain('「要旨＋節の目次」がクローンの文脈へ焼かれる');
      expect(reply).not.toContain('いま最も大きい premise');
      expect(reply).not.toContain('memory_outline');
      expect(reply).not.toContain('memory_section_move');
      expect(reply).not.toContain('memory_frontmatter_set');
    });

    it('memory_append の新規作成でも同じ3要素が出る（premise）', async () => {
      const h = harness();

      const reply = await h.call('memory_append', {
        slug: 'appended-premise',
        content: '最初の1行',
        summary: '新規',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('毎ターンの床');
      expect(reply).toContain('「要旨＋節の目次」がクローンの文脈へ焼かれる');
      expect(reply).toContain('memory_section_read');
    });

    it('memory_frontmatter_set（既存文書の更新）では「要旨＋節の目次が焼かれる」は出ない（新規作成ではないため）', async () => {
      const h = harness();
      await h.stores.persona.write('values', '---\ntype: premise\n---\n# 価値観\n本文');

      const reply = await fmBased(h, {
        slug: 'values',
        description: '要旨を足した',
        summary: '要旨だけ',
      });

      expect(reply).toContain('毎ターンの床');
      expect(reply).not.toContain('「要旨＋節の目次」がクローンの文脈へ焼かれる');
      expect(reply).not.toContain('いま最も大きい premise');
      expect(reply).not.toContain('memory_outline');
      expect(reply).not.toContain('memory_section_move');
    });

    it('単位は文字である（bytes を出していない）', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'zenkaku',
        content: '価値観です',
        summary: '全角',
      });

      expect(reply).toContain('毎ターンの床');
      const floorLine = (reply.split('\n').find((line) => line.includes('毎ターンの床')) ??
        '') as string;
      expect(floorLine).not.toContain('bytes');
      expect(floorLine).toContain('文字');
    });

    it('⭐ 床を測る経路は persona.write / append / remove を呼ばない（読み直すだけ）', async () => {
      const h = harness();
      await h.stores.persona.write('doc', '# 総論\n本文');

      const writeSpy = vi.spyOn(h.stores.persona, 'write');
      const appendSpy = vi.spyOn(h.stores.persona, 'append');
      const removeSpy = vi.spyOn(h.stores.persona, 'remove');

      await writeBased(h, {
        slug: 'doc',
        content: '# 総論\n本文を増やした',
        summary: 'x',
      });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  describe('書く4口の応答に足す「次のターンの会話へ載る見込み」（describeMemoryReinjectionEstimate、P2）', () => {
    it('⭐ memory_write（premise）は、renderMemoryDocuments([書いた後の文書]) と一致する文字数を返す', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'about-me-core',
        content: '# 私の芯\n\n'.concat('大事にしていること。'.repeat(50)),
        summary: '新しい芯を作った',
      });

      const written = await h.stores.persona.read('about-me-core');
      const expectedChars = renderMemoryDocuments([written as never]).length;

      expect(reply).toContain('次のターンの会話へ載る見込み');
      expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
      expect(reply).toContain('premise・カード（要旨＋節の目次）');
    });

    it('⭐ memory_write（fact）は、目次1行ぶんの小さい文字数を返す（premise とは桁が違う）', async () => {
      const h = harness();

      const bigBody = '事実の記録。'.repeat(2000);
      const reply = await writeBased(h, {
        slug: 'fact-doc',
        content: `---\ntype: fact\ndescription: 事実\n---\n# 事実\n${bigBody}`,
        summary: '新規',
      });

      expect(reply).toContain('fact・目次1行');
      const line = (reply.split('\n').find((row) => row.includes('次のターンの会話へ載る見込み')) ??
        '') as string;
      const match = /: ([\d,]+) 文字/.exec(line);
      expect(match).not.toBeNull();
      expect(Number(((match as RegExpExecArray)[1] ?? '').replace(/,/g, ''))).toBeLessThan(200);
    });

    it('memory_append にも同じ行が出る', async () => {
      const h = harness();

      const reply = await h.call('memory_append', {
        slug: 'appended-premise',
        content: '最初の1行',
        summary: '新規',
      });

      expect(reply).toContain('次のターンの会話へ載る見込み');
      expect(reply).toContain('premise・カード（要旨＋節の目次）');
    });

    it('memory_frontmatter_set にも同じ行が出て、type を fact に変えると数値が小さくなる', async () => {
      const h = harness();
      await h.stores.persona.write('values', `# 価値観\n${'大事にしていること。'.repeat(50)}`);
      const beforeReply = await fmBased(h, {
        slug: 'values',
        description: '要旨だけ足す',
        summary: '要旨だけ',
      });
      expect(beforeReply).toContain('次のターンの会話へ載る見込み');
      expect(beforeReply).toContain('premise・カードの変わった範囲だけ');

      const afterReply = await fmBased(h, {
        slug: 'values',
        type: 'fact',
        summary: '区分を変えた',
      });
      expect(afterReply).toContain('fact・目次1行');

      const extractChars = (reply: string): number => {
        const line = (reply
          .split('\n')
          .find((row) => row.includes('次のターンの会話へ載る見込み')) ?? '') as string;
        const match = /: ([\d,]+) 文字/.exec(line);
        return Number(((match as RegExpExecArray)[1] ?? '').replace(/,/g, ''));
      };
      expect(extractChars(afterReply)).toBeLessThan(extractChars(beforeReply));
    });

    it('⭐ memory_section_move は、移動元・移動先の両方ぶんの合計を1つの数で返す', async () => {
      const h = harness();
      const fromBefore = ['# 私について', '本文', '', '## 事例', '事例の本文'].join('\n');
      await h.stores.persona.write('about-me', fromBefore);

      const outline = await h.call('memory_outline', { slug: 'about-me' });
      const idMatch = /\[([0-9a-f]{8}-[0-9a-f]{8})\] ## 事例 — /.exec(outline);
      expect(idMatch).not.toBeNull();
      const id = (idMatch as RegExpExecArray)[1];

      const reply = await h.call('memory_section_move', {
        fromSlug: 'about-me',
        sections: [id],
        toSlug: 'about-me-appendix',
        summary: '事例を付録へ移した',
      });

      expect(reply).toContain('次のターンの会話へ載る見込み');
      expect(reply).toContain('about-me-appendix と about-me の合計');
      expect(reply).toContain('移動元と移動先の両方');

      const from = await h.stores.persona.read('about-me');
      const to = await h.stores.persona.read('about-me-appendix');
      const expectedChars = renderMemoryDocuments([to as never, from as never], {
        seenContent: new Map([['about-me', fromBefore]]),
      }).length;
      const line = (reply.split('\n').find((row) => row.includes('次のターンの会話へ載る見込み')) ??
        '') as string;
      expect(line).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    });

    it('単一文書への書き込みでは「移動元と移動先の両方」の注記は出ない', async () => {
      const h = harness();
      const reply = await writeBased(h, {
        slug: 'solo',
        content: '# 独立\n本文',
        summary: '単独',
      });

      expect(reply).not.toContain('移動元と移動先の両方');
    });
  });

  describe('書く4口の応答に足す「セッション構築時点からの増分」と「premise の順位」（P3）', () => {
    const RUNTIME_BASE: CloneRuntimeFacts = {
      revision: { commit: null, short: null, source: null },
      buildTime: { builtAt: null },
      declaredModel: 'fable',
      modelOverridden: false,
      modelEnvKey: 'ALTEROID_CLONE_MODEL',
      sdkModel: null,
      effort: null,
      requestedEffort: null,
      claudeCodeVersion: null,
      apiKeySource: null,
      permissionMode: null,
      requestedPermissionMode: 'auto',
      mcpServers: [],
      sessionId: null,
      resumedFrom: null,
      injectedMemoryChars: heuristicChars(0),
      systemPromptChars: heuristicChars(0),
      lastContextUsage: null,
    };

    it('⭐ runtime が在れば、セッション構築時点との差（文字と割合）が出る', async () => {
      const h = harness(() => ({ ...RUNTIME_BASE, injectedMemoryChars: heuristicChars(100) }));

      const reply = await writeBased(h, {
        slug: 'about-me-core',
        content: '# 私の芯\n\n'.concat('大事にしていること。'.repeat(50)),
        summary: '新しい芯を作った',
      });

      const docs = await h.stores.persona.documents();
      const afterChars = measureMemoryFloor(docs).totalChars;

      expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
      expect(reply).toContain(`セッション構築時点 ${(100).toLocaleString('en-US')} 文字`);
      expect(reply).toContain(`いま ${afterChars.toLocaleString('en-US')} 文字`);
      expect(reply).toContain('増える見込み');
    });

    it('⭐⭐ 増分が0のとき（何も変わっていないとき）に、増えたかのような文言を出さない', async () => {
      let injected: HeuristicChars = heuristicChars(0);
      const h = harness(() => ({ ...RUNTIME_BASE, injectedMemoryChars: injected }));

      await writeBased(h, { slug: 'stable', content: '固定の本文', summary: '初回' });
      const docs = await h.stores.persona.documents();
      injected = measureMemoryFloor(docs).totalChars;

      const reply = await writeBased(h, {
        slug: 'stable',
        content: '固定の本文',
        summary: '同じ内容で書き直した',
      });

      expect(reply).toContain('変わっていない');
      expect(reply).not.toMatch(/増え/);
      expect(reply).not.toMatch(/減っ/);
    });

    it('runtime を渡していない場面（既定の harness）では、現在値であることを明記して現在値を出す', async () => {
      const h = harness();

      const reply = await writeBased(h, {
        slug: 'about-me-core',
        content: '# 私の芯\n本文',
        summary: '新規',
      });

      expect(reply).toContain('現在値である');
      expect(reply).not.toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
    });

    it('⭐ premise が複数あれば、大きい順に順位が出る', async () => {
      const h = harness(() => RUNTIME_BASE);
      await writeBased(h, { slug: 'doc-small', content: '# 小\n短い', summary: 's' });
      await writeBased(h, {
        slug: 'doc-large',
        content: '# 大\n'.concat('長い本文。'.repeat(100)),
        summary: 's',
      });

      const reply = await writeBased(h, {
        slug: 'doc-medium',
        content: '# 中\n'.concat('本文。'.repeat(10)),
        summary: 's',
      });

      expect(reply).toContain('premise の大きさの順位');
      const idxLarge = reply.indexOf('doc-large:');
      const idxMedium = reply.indexOf('doc-medium:');
      const idxSmall = reply.indexOf('doc-small:');
      expect(idxLarge).toBeGreaterThan(-1);
      expect(idxLarge).toBeLessThan(idxMedium);
      expect(idxMedium).toBeLessThan(idxSmall);
    });

    it('premise がまだ無ければ、順位ではなくその旨を出す', async () => {
      const h = harness(() => RUNTIME_BASE);
      const reply = await writeBased(h, {
        slug: 'fact-only',
        content: '---\ntype: fact\ndescription: 事実\n---\n# 事実\n本文',
        summary: '新規',
      });

      expect(reply).toContain('premise の大きさの順位');
      expect(reply).toContain('premise はまだ無い');
    });

    it('⭐ premise が多いと、順位は文字数の予算で切り、省いた件数を言う', async () => {
      const h = harness(() => RUNTIME_BASE);
      for (let i = 0; i < 300; i += 1) {
        await h.stores.persona.write(`p${i.toString().padStart(3, '0')}`, `# 前提${i}\n本文`);
      }

      const reply = await writeBased(h, {
        slug: 'latest',
        content: '# 最新\n本文',
        summary: '最後の1件',
      });

      expect(reply).toMatch(/…ほか \d+ 件は省略/);
      expect(reply).toContain('全 301 件');
    });

    it('memory_append にも同じ2行が出る', async () => {
      const h = harness(() => RUNTIME_BASE);
      const reply = await h.call('memory_append', {
        slug: 'x',
        content: '本文',
        summary: 's',
      });

      expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
      expect(reply).toContain('premise の大きさの順位');
    });

    it('memory_frontmatter_set にも同じ2行が出る', async () => {
      const h = harness(() => RUNTIME_BASE);
      await h.stores.persona.write('values', '# 価値観\n本文');

      const reply = await fmBased(h, {
        slug: 'values',
        description: '要旨',
        summary: 's',
      });

      expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
      expect(reply).toContain('premise の大きさの順位');
    });

    it('memory_section_move にも同じ2行が出る', async () => {
      const h = harness(() => RUNTIME_BASE);
      await h.stores.persona.write(
        'about-me',
        ['# 私について', '本文', '', '## 事例', '事例の本文'].join('\n'),
      );
      const outline = await h.call('memory_outline', { slug: 'about-me' });
      const idMatch = /\[([0-9a-f]{8}-[0-9a-f]{8})\] ## 事例 — /.exec(outline);
      expect(idMatch).not.toBeNull();
      const id = (idMatch as RegExpExecArray)[1];

      const reply = await h.call('memory_section_move', {
        fromSlug: 'about-me',
        sections: [id],
        toSlug: 'about-me-appendix',
        summary: '事例を付録へ移した',
      });

      expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
      expect(reply).toContain('premise の大きさの順位');
    });

    it('⭐ 既存の2行を置き換えていない——4つの数がそれぞれ別の文言で区別できる', async () => {
      const h = harness(() => RUNTIME_BASE);
      const reply = await writeBased(h, {
        slug: 'x',
        content: '# 見出し\n本文',
        summary: 's',
      });

      expect(reply).toContain('毎ターンの床');
      expect(reply).toContain('次のターンの会話へ載る見込み');
      expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
      expect(reply).toContain('premise の大きさの順位');
    });
  });

  describe('memory_list（要旨・鮮度・区分・階層を出す）', () => {
    it('区分と要旨が出る', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'runbook',
        content: '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
        summary: '定点観測を書いた',
      });

      const reply = await h.call('memory_list', {});

      expect(reply).toContain('[fact] runbook');
      expect(reply).toContain('費用の推移');
    });

    it('premise（既定）の文書も一覧には出る', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'about-me',
        content: '# 私\n\n前提の本文\n',
        summary: '前提を書いた',
      });

      const reply = await h.call('memory_list', {});

      expect(reply).toContain('[premise] about-me');
    });

    it('階層は parent から組み立てて、インデントで表す', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'parent-doc',
        content: '---\ndescription: 親\ntype: fact\n---\n# 親\n本文\n',
        summary: '親を書いた',
      });
      await writeBased(h, {
        slug: 'child-doc',
        content: '---\ndescription: 子\ntype: fact\nparent: parent-doc\n---\n# 子\n本文\n',
        summary: '子を書いた',
      });

      const reply = await h.call('memory_list', {});
      const lines = reply.split('\n');
      const parentLine = lines.find((line) => line.includes('parent-doc:'));
      const childLine = lines.find((line) => line.includes('child-doc:'));
      const indent = (line: string) => line.length - line.trimStart().length;
      expect(parentLine).toBeDefined();
      expect(childLine).toBeDefined();
      expect(indent(childLine ?? '')).toBeGreaterThan(indent(parentLine ?? ''));
    });

    it('記憶が空なら「空」と言う（0 件で終わらせない）', async () => {
      const h = harness();
      expect(await h.call('memory_list', {})).toContain('空');
    });

    it('説明文は「premise は全文が焼き込まれる」と言わず、要旨＋節の目次と開く口（memory_section_read）を言う', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'memory_list')?.description ?? '';

      expect(description).not.toContain('premise はプロンプトへ全文が焼き込まれている');
      expect(description).toContain('memory_section_read');
      expect(description).toMatch(/premise.{0,40}要旨.{0,10}節の目次/);
    });

    it('実装の値（本文が焼かれるか）と説明文の主張を、それぞれ現在の正しい値へ釘で留める', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'memory_list')?.description ?? '';

      const marker = 'MARKER-BODY-7f3a2c';
      const renderedByDefault = renderMemoryDocuments([
        { slug: 'probe-default', content: `# 見出し\n${marker}\n` },
      ]);
      const renderedExplicit = renderMemoryDocuments([
        {
          slug: 'probe-explicit',
          content: `---\ntype: premise\n---\n# 見出し\n${marker}\n`,
        },
      ]);
      const bodyIsBaked = renderedByDefault.includes(marker);
      expect(renderedExplicit.includes(marker)).toBe(bodyIsBaked);

      const claimsBodyBaked = /premise[^。]*全文|全文[^。]*premise/.test(description);

      expect(bodyIsBaked).toBe(false);
      expect(claimsBodyBaked).toBe(false);
      expect(bodyIsBaked).toBe(claimsBodyBaked);
    });
  });

  it('profile_write は保存し、runner へも降ろす', async () => {
    const h = harness();

    const result = await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=abc123',
      summary: '人間から渡されたトークンを実行環境へ移した',
    });

    expect(result).toContain('更新した');
    expect((await h.stores.profile.list())[0]?.script).toContain('SOME_API_TOKEN');
    expect(h.distributed).toHaveLength(1);
    expect(h.distributed[0]).toContain('SOME_API_TOKEN');
  });

  it('配布先が大量でも、配った先／配れなかった先は抜粋の合図で締まる', async () => {
    const h = harness();
    const count = 200;
    const runners = {
      async list() {
        return Array.from({ length: count }, (_, index) => ({
          runnerId: `runner-${index}`,
          async setProfile() {
            return index % 2 === 0
              ? { ok: true as const }
              : { ok: false as const, error: `runner-${index} は届かなかった（詳しい理由の本文）` };
          },
        }));
      },
      async get() {
        return null;
      },
      async select() {
        throw new Error('この検証では使わない');
      },
    } as never;
    const tools = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores: h.stores,
      emit: () => undefined,
      profile: createProfileService({ stores: h.stores, runners }),
    });
    const write = tools.find((entry) => entry.name === 'profile_write');
    const result = await write?.handler({ script: 'export A=1', summary: 'x' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    const delivered = body.split('\n').find((line) => line.startsWith('配った先:'));
    const failed = body.split('\n').find((line) => line.startsWith('配れなかった先:'));
    expect(delivered).toBeDefined();
    expect(failed).toBeDefined();
    expect(delivered!.length).toBeLessThan(1_000);
    expect(failed!.length).toBeLessThan(1_000);
    expect(delivered).toMatch(/省略/);
    expect(failed).toMatch(/省略/);
  });

  it('profile_read name=<名前> で今の本文を取れる（足すだけの更新ができる）', async () => {
    const h = harness();
    await h.call('profile_write', { script: 'export A=1', summary: 'A' });

    const body = await h.call('profile_read', { name: 'default' });

    expect(body).toContain('export A=1');
  });

  it('profile_read は名前を省くと行の一覧を返す（名前・撒く先・バイト数・更新。本文は載らない）', async () => {
    const h = harness();
    await h.call('profile_write', {
      name: 'rust',
      script: 'export SECRET_RUST=1',
      summary: 'r',
      scope: 'runner',
    });
    await h.call('profile_write', { name: 'alpha', script: 'export SECRET_ALPHA=1', summary: 'a' });

    const listing = await h.call('profile_read', {});

    expect(listing).toContain('- alpha / 撒く先 all /');
    expect(listing).toContain('- rust / 撒く先 runner /');
    expect(listing.indexOf('- alpha')).toBeLessThan(listing.indexOf('- rust'));
    expect(listing).not.toContain('SECRET_');
    expect(listing).toContain('profile_read name=<名前>');
  });

  it('profile_read name=<無い名前> は無いと言い、一覧の取り方を案内する', async () => {
    const h = harness();
    await h.call('profile_write', { script: 'export A=1', summary: 'A' });

    expect(await h.call('profile_read', { name: 'nope' })).toContain('行 nope は無い');
  });

  it('profile_read の一覧は件数が多くても予算で切り、省略の合図と続きの取り方を出す', async () => {
    const h = harness();
    for (let i = 0; i < 120; i += 1) {
      await h.stores.profile.set(
        `row-${String(i).padStart(3, '0')}-${'x'.repeat(50)}`,
        'export A=1\n',
        'all',
      );
    }

    const listing = await h.call('profile_read', {});

    expect(listing.length).toBeLessThan(8_000);
    expect(listing).toMatch(/ほか \d+ 件は省略/);
  });

  it('profile_write の scope=runner: 正本は行を持ち、runner には合成が降り、profile_read に撒く先が出る', async () => {
    const h = harness();

    const written = await h.call('profile_write', {
      name: 'rust',
      script: 'export ONLY_RUNNER=1',
      summary: 'runner だけに要る',
      scope: 'runner',
    });

    expect(written).toContain('撒く先 runner');
    expect(await h.stores.profile.list()).toMatchObject([{ name: 'rust', scope: 'runner' }]);
    expect(h.distributed).toHaveLength(1);
    expect(h.distributed[0]).toContain('ONLY_RUNNER');
    const body = await h.call('profile_read', { name: 'rust' });
    expect(body).toContain('撒く先 runner');
    expect(body).toContain('export ONLY_RUNNER=1');
  });

  it('profile_write の scope=app: runner へは空が降りる', async () => {
    const h = harness();

    await h.call('profile_write', {
      script: 'export ONLY_APP=1',
      summary: 'クローンだけ',
      scope: 'app',
    });

    expect(h.distributed).toEqual(['']);
  });

  it('profile_write は scope を省くと既存の行の撒く先を保つ（新しい行なら all）', async () => {
    const h = harness();
    await h.call('profile_write', { script: 'export A=1', summary: 'A' });
    expect((await h.stores.profile.list())[0]?.scope).toBe('all');

    await h.call('profile_write', { script: 'export A=1', summary: 'A', scope: 'runner' });
    await h.call('profile_write', { script: 'export A=2', summary: 'A2' });

    expect((await h.stores.profile.list())[0]?.scope).toBe('runner');
  });

  it('profile_write は名前の形が不正・本文が空なら何も変えない（日誌も書かない）', async () => {
    const h = harness();

    expect(
      await h.call('profile_write', { name: '../x', script: 'export A=1', summary: 's' }),
    ).toContain('名前の形が不正');
    expect(await h.call('profile_write', { script: '  \n', summary: 's' })).toContain(
      '本文が空では行を置けない',
    );

    expect(await h.stores.profile.list()).toEqual([]);
    expect(await h.stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('profile_remove は1行だけを外し、他の行はそのまま。無い名前は何も変えない', async () => {
    const h = harness();
    await h.call('profile_write', { name: 'a', script: 'export A=1', summary: 'a' });
    await h.call('profile_write', { name: 'b', script: 'export B=1', summary: 'b' });

    const removed = await h.call('profile_remove', { name: 'a', summary: 'a を外す' });
    expect(removed).toContain('行 a を外した');
    expect((await h.stores.profile.list()).map((row) => row.name)).toEqual(['b']);

    expect(await h.call('profile_remove', { name: 'zzz', summary: 'x' })).toContain(
      '行 zzz は無い',
    );
    expect((await h.stores.profile.list()).map((row) => row.name)).toEqual(['b']);
  });

  describe('評価の失敗の戻りに、シェルの stderr の鍵の値を載せない（issue #2429）', () => {
    const FAKE = 'FAKE_SECRET_VALUE_2429';

    function writeToolWith(applier: ProfileApplier, stores: Stores) {
      const tools = createCloneTools({
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        stores,
        emit: () => undefined,
        profile: createProfileService({ stores, applier }),
      });
      const write = tools.find((entry) => entry.name === 'profile_write');
      return async (script: string) => {
        const result = await write?.handler({ script, summary: '2429' } as never, {});
        return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      };
    }

    function realApplier(): ProfileApplier {
      const path = join(makeTempDirSync('alteroid-profile-2429-'), 'profile.sh');
      return createProfileApplier({
        vessel: createProfileVessel({ path }),
        baseEnv: () => ({ PATH: process.env.PATH }),
      });
    }

    it('実物のシェル: 構文エラーの引用の値は出ず、診断の文は残る', async () => {
      const call = writeToolWith(realApplier(), createMemoryStores());

      const body = await call(`export OK=1\nexport GH_TOKEN=${FAKE} )\n`);

      expect(body).toContain('実行環境プロファイルを置けなかった');
      expect(body).not.toContain(FAKE);
      expect(body).toMatch(/syntax error|unexpected/i);
    });

    it('実物のシェル: set -x の "+ export NAME=値" の値は出ない', async () => {
      const call = writeToolWith(realApplier(), createMemoryStores());

      const body = await call(`set -x\nexport GH_TOKEN=${FAKE}\nexit 3\n`);

      expect(body).toContain('実行環境プロファイルを置けなかった');
      expect(body).not.toContain(FAKE);
      expect(body).toContain('export GH_TOKEN=');
    });

    it('出口: 器が伏せずに返した文でも、環境変数の網で伏せ、長さを切る', async () => {
      vi.stubEnv('DEPLOY_API_TOKEN', FAKE);
      try {
        const applier: ProfileApplier = {
          vessel: {} as never,
          fingerprint: () => undefined,
          env: () => ({}),
          async apply() {
            throw new Error('この検証では使わない');
          },
          async prepare() {
            return {
              ok: false,
              error: '評価が失敗した',
              output: `${'x'.repeat(10)} ${FAKE} ${'y'.repeat(3_987)}`,
              commit: async () => undefined,
              discard: async () => undefined,
            };
          },
        };
        const call = writeToolWith(applier, createMemoryStores());

        const body = await call('export A=1');

        expect(body).not.toContain(FAKE);
        expect(body).not.toContain('_2429');
        expect(body.length).toBeLessThan(4_200);
        expect(body).toContain('評価が失敗した');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('対照: 成功したときは今までどおり「更新した」を返す', async () => {
      const stores = createMemoryStores();
      const call = writeToolWith(realApplier(), stores);

      const body = await call('export OK_2429=1\n');

      expect(body).toContain('更新した');
      expect((await stores.profile.list())[0]?.script).toContain('OK_2429');
    });
  });

  it('読めなかった（評価で断った）ときも、差し替えようとした行と打ち消しの行が残る（値そのものは書かない）', async () => {
    const h = harness();
    const tools = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores: h.stores,
      emit: () => undefined,
      profile: createProfileService({
        stores: h.stores,
        applier: {
          vessel: {} as never,
          fingerprint: () => undefined,
          env: () => ({}),
          async apply() {
            return { ok: false, error: '構文が壊れている' };
          },
          async prepare() {
            return {
              ok: false,
              error: '構文が壊れている',
              commit: async () => undefined,
              discard: async () => undefined,
            };
          },
        },
      }),
    });
    const write = tools.find((entry) => entry.name === 'profile_write');
    const result = await write?.handler(
      { script: 'if [ ; then', summary: '構文が壊れたスクリプト' } as never,
      {},
    );
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('置けなかった');
    expect(body).toContain('構文が壊れている');
    expect(await h.stores.profile.list()).toEqual([]);

    const decisions = (await h.stores.journal.list({ types: ['decision'], order: 'asc' })).flatMap(
      (entry) => (entry.type === 'decision' ? [entry.decision] : []),
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toBe(
      '実行環境プロファイルを差し替えようとしている: 構文が壊れたスクリプト',
    );
    expect(decisions[1]).toBe(
      '実行環境プロファイルを差し替えられなかった（読めなかった）: 構文が壊れたスクリプト',
    );
    expect(JSON.stringify(decisions)).not.toContain('if [ ; then');
  });

  it('日誌に残すのは何を変えたかであって、値ではない', async () => {
    const h = harness();

    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret',
      summary: 'Slack の鍵を置いた',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(entry)).not.toContain('super-secret');
    expect(JSON.stringify(entry)).toContain('Slack の鍵を置いた');
  });

  it('schedule_create は継続中の依頼として残り、schedule_list で読める', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'issue-round',
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      dailyAt: '09:00',
    });
    expect(created).toContain('毎日 09:00');

    const plans = (await h.stores.schedules.list()).entries;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
    });
    expect(await h.call('schedule_list', {})).toContain('open issue');

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
  });

  it('schedule_list の一覧は作成時刻と更新時刻を出す', async () => {
    const h = harness();
    await h.stores.schedules.put({
      kind: 'watch',
      spec: { type: 'daily', at: '09:00' },
      request: 'いつもの見回り',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
    });

    const reply = await h.call('schedule_list', {});

    expect(reply).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(reply).toContain('更新: 2026-03-04T05:06:07.000Z');
  });

  it('schedule_list（一覧モード）は ToolContext.scheduler から次に動く時刻を出す', async () => {
    const h = harness(undefined, () => [
      {
        kind: 'watch',
        description: '毎日 09:00（ローカル時刻）',
        nextAt: '2026-04-05T00:00:00.000Z',
      },
    ]);
    await h.stores.schedules.put({
      kind: 'watch',
      spec: { type: 'daily', at: '09:00' },
      request: 'いつもの見回り',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
    });

    const reply = await h.call('schedule_list', {});

    expect(reply).toContain('次に動く時刻: 2026-04-05T00:00:00.000Z');
  });

  it('schedule_list kind=<kind>（全文モード）も同じ次に動く時刻を出す', async () => {
    const h = harness(undefined, () => [
      {
        kind: 'watch',
        description: '毎日 09:00（ローカル時刻）',
        nextAt: '2026-04-05T00:00:00.000Z',
      },
    ]);
    await h.stores.schedules.put({
      kind: 'watch',
      spec: { type: 'daily', at: '09:00' },
      request: 'いつもの見回り',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
    });

    const reply = await h.call('schedule_list', { kind: 'watch' });

    expect(reply).toContain('次に動く時刻: 2026-04-05T00:00:00.000Z');
  });

  it('ToolContext.scheduler が渡っていないときは、黙って行を消さず取れない理由を出す', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });

    const reply = await h.call('schedule_list', {});

    expect(reply).toContain('次に動く時刻: （取れない — scheduler が渡っていない）');
  });

  it('scheduler は渡っているが、この kind をまだ仕込みへ反映していないときは反映待ちと言う', async () => {
    const h = harness(undefined, () => []);
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });

    const reply = await h.call('schedule_list', {});

    expect(reply).toContain('次に動く時刻: （まだ計算されていない。少し待って呼び直すこと）');
  });

  describe('schedule_list の一覧モードに継続点（cursor）を足す（#662 段1）', () => {
    function extractCursor(reply: string): string {
      const match = /cursor=([A-Za-z0-9\-_]+)/.exec(reply);
      if (!match) throw new Error(`cursor が案内に無い: ${reply}`);
      return match[1]!;
    }

    async function seedSchedules(h: Harness, count: number): Promise<string[]> {
      const long = 'あ'.repeat(500);
      const kinds: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const kind = `watch-${String(index).padStart(3, '0')}`;
        kinds.push(kind);
        await h.call('schedule_create', {
          kind,
          request: `見回り${String(index).padStart(3, '0')}: ${long}`,
          everyMinutes: 60,
        });
      }
      return kinds;
    }

    it('予算で切れたら、断り書きが cursor= を案内する', async () => {
      const h = harness();
      await seedSchedules(h, 25);

      const reply = await h.call('schedule_list', {});

      expect(reply).toMatch(/…ほか \d+ 件は省略/);
      expect(reply).toContain('cursor=');
      expect(reply).toMatch(/続きは schedule_list cursor=[A-Za-z0-9\-_]+ で取れる/);
    });

    it('cursor で呼び直すと、1頁目に出た kind は2頁目には出ない（重複しない）', async () => {
      const h = harness();
      const kinds = await seedSchedules(h, 25);

      const first = await h.call('schedule_list', {});
      expect(first).toMatch(/…ほか \d+ 件は省略/);
      const cursor = extractCursor(first);

      const second = await h.call('schedule_list', { cursor });

      const firstPageKinds = kinds.filter((kind) => first.includes(kind));
      expect(firstPageKinds.length).toBeGreaterThan(0);
      for (const kind of firstPageKinds) {
        expect(second, `${kind} が2頁目にも重複して出た`).not.toContain(kind);
      }
    });

    it('頁を辿り切ると、全 kind に到達できる（Issue の主題そのもの）', async () => {
      const h = harness();
      const kinds = await seedSchedules(h, 25);

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let guard = 0; guard < kinds.length + 1; guard += 1) {
        const reply: string = await h.call('schedule_list', cursor === undefined ? {} : { cursor });
        for (const kind of kinds) {
          if (reply.includes(kind)) seen.add(kind);
        }
        if (!reply.includes('cursor=')) break;
        cursor = extractCursor(reply);
      }

      for (const kind of kinds) {
        expect(seen, `${kind} に到達できなかった（窓から落ちたまま迷子）`).toContain(kind);
      }
    });

    it('壊れた cursor は明示のエラーで、黙って先頭からへ倒さない', async () => {
      const h = harness();
      await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });

      const reply = await h.call('schedule_list', { cursor: 'this-is-not-a-real-cursor' });

      expect(reply).toContain('cursor が壊れている');
      expect(reply).not.toContain('watch');
    });

    it('母数（total）は頁をまたいでも変わらない', async () => {
      const h = harness();
      await seedSchedules(h, 25);

      const first = await h.call('schedule_list', {});
      const cursor = extractCursor(first);
      const second = await h.call('schedule_list', { cursor });

      expect(first).toContain('継続中の依頼は 25 件あり');
      if (second.includes('…ほか')) {
        expect(second).toContain('継続中の依頼は 25 件あり');
      }
    });
  });

  it('同じ kind で仕込み直すと置き換わる（前回動いた時刻は保つ）', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });
    const first = await h.stores.schedules.get('watch');
    await h.stores.schedules.claimRun(
      'watch',
      first?.updatedAt ?? '',
      '2026-08-12T00:00:00.000Z',
      'schedule',
    );
    await h.stores.schedules.completeRun('watch', '2026-08-12T00:00:00.000Z', 'schedule');

    await h.call('schedule_create', { kind: 'watch', request: '直した依頼', everyMinutes: 10 });

    const plans = (await h.stores.schedules.list()).entries;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      request: '直した依頼',
      spec: { type: 'every', minutes: 10 },
      lastRunAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('claimRun が成立した直後に本文だけ直しても、pendingRun / lastRunAt は消えない（Issue #1654）', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });
    const first = await h.stores.schedules.get('watch');
    const claimed = await h.stores.schedules.claimRun(
      'watch',
      first?.updatedAt ?? '',
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );
    expect(claimed).not.toBeNull();

    await h.call('schedule_create', { kind: 'watch', request: '直した依頼', everyMinutes: 10 });

    const afterEdit = await h.stores.schedules.get('watch');
    expect(afterEdit).toMatchObject({
      request: '直した依頼',
      spec: { type: 'every', minutes: 10 },
      lastRunAt: '2026-08-13T00:00:00.000Z',
      pendingRun: { at: '2026-08-13T00:00:00.000Z', cause: 'schedule' },
    });

    await h.stores.schedules.completeRun('watch', '2026-08-13T00:00:00.000Z', 'schedule');
    const afterComplete = await h.stores.schedules.get('watch');
    expect(afterComplete?.pendingRun).toBeUndefined();
    expect(afterComplete?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('cron 式でも仕込める（曜日の指定が要る依頼のため）', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: '週次で先週の日報を読み直して、抜けている決めごとを拾う',
      cron: '0 10 * * 1',
    });
    expect(created).toContain('cron: 0 10 * * 1');

    expect((await h.stores.schedules.list()).entries[0]).toMatchObject({
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
  });

  it('読めない cron 式は仕込まない', async () => {
    const h = harness();

    const result = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: 'x',
      cron: 'まいしゅう げつようび',
    });

    expect(result).toContain('cron 式として読めない');
    expect((await h.stores.schedules.list()).entries).toEqual([]);
  });

  it('周期の指定は1つだけ。読めない指定は仕込まない', async () => {
    const h = harness();

    expect(await h.call('schedule_create', { kind: 'a', request: 'x' })).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        everyMinutes: 30,
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        cron: '0 10 * * 1',
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', { kind: 'a', request: 'x', dailyAt: '25:00' }),
    ).toContain('読めない');
    expect(
      await h.call('schedule_create', { kind: 'ダメな名前', request: 'x', dailyAt: '09:00' }),
    ).toContain('使えない');
    expect((await h.stores.schedules.list()).entries).toEqual([]);
  });

  it('既定の定期ジョブの名前は奪えない（日報を潰せない）', async () => {
    const h = harness();
    const result = await h.call('schedule_create', {
      kind: 'daily_report',
      request: '日報を潰す',
      everyMinutes: 1,
    });
    expect(result).toContain('既定の定期ジョブ');
    expect((await h.stores.schedules.list()).entries).toEqual([]);
  });

  it('schedule_remove は依頼を片付ける。無い依頼なら何もしない', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '見張る', everyMinutes: 30 });

    expect(await h.call('schedule_remove', { kind: 'しらない' })).toContain('無い');
    expect((await h.stores.schedules.list()).entries).toHaveLength(1);

    expect(await h.call('schedule_remove', { kind: 'watch' })).toContain('外した');
    expect((await h.stores.schedules.list()).entries).toEqual([]);
  });

  it('schedule_remove は読めない形で入っていた依頼も外せる（issue #1982）', async () => {
    const h = harness();
    const real = h.stores.schedules;
    let brokenPresent = true;
    h.stores.schedules = {
      ...real,
      async get(kind) {
        if (kind === 'broken' && brokenPresent) {
          throw new Error(
            '継続中の依頼 broken が読めない形で入っている（消されたのではない）: 実測用のダミー',
          );
        }
        return real.get(kind);
      },
      async removeIfPresent(kind) {
        if (kind === 'broken') {
          if (!brokenPresent) return null;
          brokenPresent = false;
          return 'unreadable';
        }
        return real.removeIfPresent(kind);
      },
    };

    const reply = await h.call('schedule_remove', { kind: 'broken' });
    expect(reply).toContain('外した');

    await expect(h.stores.schedules.get('broken')).resolves.toBeNull();

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ decision: expect.stringContaining('読めない形で入っていた') });
  });

  it('schedule_list kind=<kind> は読めない形で入っていた依頼を isError にならず名乗る（issue #2177）', async () => {
    const h = harness();
    const real = h.stores.schedules;
    h.stores.schedules = {
      ...real,
      async get(kind) {
        if (kind === 'broken') {
          throw new UnreadableScheduleError(
            '継続中の依頼 broken が読めない形で入っている（消されたのではない）: 実測用のダミー',
            { kind },
          );
        }
        return real.get(kind);
      },
    };

    const reply = await h.call('schedule_list', { kind: 'broken' });
    expect(reply).toContain('継続中の依頼 broken は読めない形で入っている（消されたのではない）');
    expect(reply).toContain('schedule_remove kind=broken');

    expect(await h.call('schedule_list', { kind: 'しらない' })).toContain('無い');
  });

  it('schedule_list kind=<kind> は UnreadableScheduleError 以外の例外を投げ直す（issue #2177）', async () => {
    const h = harness();
    const real = h.stores.schedules;
    h.stores.schedules = {
      ...real,
      async get(kind) {
        if (kind === 'broken-other') throw new Error('実測用のダミー（器そのものの障害を模す）');
        return real.get(kind);
      },
    };

    await expect(h.call('schedule_list', { kind: 'broken-other' })).rejects.toThrow(
      '実測用のダミー',
    );
  });

  describe('読めない継続中の依頼の行が在る一覧（#2343）: 一覧から消さず、件数と kind で言う', () => {
    function listWithUnreadable(unreadable: { kind?: string; reason: string }[]) {
      const h = harness();
      const original = h.stores.schedules.list.bind(h.stores.schedules);
      h.stores.schedules.list = async () => ({ ...(await original()), unreadable });
      return h;
    }

    it('読めた行は今までどおり並べ、末尾に「読めない継続中の依頼が N 件ある」を kind つきで出す', async () => {
      const h = listWithUnreadable([
        { kind: 'broken-1', reason: '不正な欄: spec' },
        { reason: '不正な行' },
      ]);
      await h.call('schedule_create', { kind: 'watch', request: '読める依頼', everyMinutes: 30 });
      const reply = await h.call('schedule_list', {});
      expect(reply).toContain('読める依頼');
      expect(reply).toContain('読めない継続中の依頼が 2 件ある');
      expect(reply).toContain('broken-1');
      expect(reply).toContain('kind が取れない行が 1 件');
      expect(reply).toContain('消された依頼ではない');
    });

    it('読めた行が0件でも「継続中の依頼は無い」とだけ言わない', async () => {
      const h = listWithUnreadable([{ kind: 'broken-1', reason: '不正な欄: spec' }]);
      const reply = await h.call('schedule_list', {});
      expect(reply).toContain('読めない継続中の依頼が 1 件ある');
      expect(reply).toContain('broken-1');
      expect(reply).not.toContain('（継続中の依頼は無い）');
    });

    it('0件のときは何も出さない（0 の行を作らない）。本当に0件なら「無い」と言う', async () => {
      const h = listWithUnreadable([]);
      await h.call('schedule_create', { kind: 'watch', request: '読める依頼', everyMinutes: 30 });
      expect(await h.call('schedule_list', {})).not.toContain('読めない');
      const empty = listWithUnreadable([]);
      expect(await empty.call('schedule_list', {})).toBe('（継続中の依頼は無い）');
    });
  });

  it('memory_append は既存の記述を消さない（人間の手書きを守る）', async () => {
    const h = harness();
    await h.stores.persona.write('values', '# 価値観\n\n人間が手で書いた\n');

    await h.call('memory_append', {
      slug: 'values',
      content: '- クローンが足した学び',
      summary: '学びを追記',
    });

    const content = (await h.stores.persona.read('values'))?.content ?? '';
    expect(content).toContain('人間が手で書いた');
    expect(content).toContain('クローンが足した学び');
  });

  it('memory_append の日誌には action: "append" が構造として載る', async () => {
    const h = harness();

    await h.call('memory_append', { slug: 'values', content: '追記', summary: '追記した' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'append' });
  });

  it('memory_append の日誌には bytesBefore / bytesAfter が数として記録される', async () => {
    const h = harness();
    await writeBased(h, { slug: 'values', content: '12345', summary: '最初' });
    await h.call('memory_append', { slug: 'values', content: '67890', summary: '追記' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'], limit: 1 });
    expect(entry).toMatchObject({ action: 'append', bytesBefore: 6, bytesAfter: 13 });
  });

  describe('memory_delete（記憶の文書を消す）', () => {
    it('文書ごと消える（memory_list から消える。本文が空になるだけではない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '# 一時的なメモ\n\n本文');

      await delBased(h, { slug: 'temp-note', summary: 'もう要らない' });

      expect(await h.stores.persona.read('temp-note')).toBeNull();
      const list = await h.stores.persona.list();
      expect(list.some((doc) => doc.slug === 'temp-note')).toBe(false);
    });

    it('存在しないスラッグは黙って成功しない', async () => {
      const h = harness();

      const reply = await h.call('memory_delete', { slug: 'nope', summary: '消したつもり' });

      expect(reply).toContain('存在しない');
      expect(reply).toMatch(/消えない|変わっていない/);
    });

    it('削除が日誌に残る（slug と消す直前の文字数）', async () => {
      const h = harness();
      const body = '# メモ\n\n' + 'あ'.repeat(42) + '\n';
      await h.stores.persona.write('temp-note', body);

      await delBased(h, { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ type: 'memory_update', slug: 'temp-note' });
      expect((entry as { summary: string }).summary).toContain(String(body.length));
    });

    it('削除の日誌には bytesBefore / bytesAfter が数として記録される（bytesAfter は常に0）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '12345');

      await delBased(h, { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ bytesBefore: 6, bytesAfter: 0 });
    });

    it('削除の日誌に本文が写っていない', async () => {
      const h = harness();
      const secretBody = '# メモ\n\n他人に見せたくない値: SECRET-XYZ-999';
      await h.stores.persona.write('temp-note', secretBody);

      await delBased(h, { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect((entry as { summary: string }).summary).not.toContain('SECRET-XYZ-999');
    });

    it('action: "remove" が構造として載る（文言だけに頼らない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '本文');

      await delBased(h, { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ action: 'remove' });
    });
  });

  describe('memory_frontmatter_set（frontmatter だけを直す。本文には触れない）', () => {
    async function markHuman(h: Harness, slug: string, content: string): Promise<void> {
      await h.stores.persona.write(slug, content);
      await h.stores.persona.markHumanTouched(slug, new Date().toISOString());
    }

    const longBody =
      [
        '# 価値観',
        '',
        '## 判断の基準',
        '',
        '本文1行目。',
        '本文2行目。',
        '',
        '## 好み',
        '',
        '- 箇条書き1',
        '- 箇条書き2',
        '',
        '### 細目',
        '',
        '最後の段落。',
      ].join('\n') + '\n';

    it('存在しない slug には断り、作られていない', async () => {
      const h = harness();

      const reply = await fmBased(h, {
        slug: 'nope',
        description: '要旨',
        summary: '直したつもり',
      });

      expect(reply).toContain('存在しない');
      expect(await h.stores.persona.read('nope')).toBeNull();
    });

    it('キーを1つも渡さなければ断る（何も変わらない）', async () => {
      const h = harness();
      const original = `---\ndescription: 元の要旨\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      const reply = await fmBased(h, { slug: 'values', summary: '直す' });

      expect(reply).toMatch(/断|少なくとも1つ/);
      expect((await h.stores.persona.read('values'))?.content).toBe(original);
    });

    it('frontmatter が無い（none）文書に足せる。本文は無傷で、type を渡さなければ区分は premise のまま', async () => {
      const h = harness();
      await h.stores.persona.write('values', longBody);

      await fmBased(h, {
        slug: 'values',
        description: '新しい要旨',
        summary: '要旨を足した',
      });

      const doc = await h.stores.persona.read('values');
      expect(doc?.content.endsWith(longBody)).toBe(true);
      expect(doc?.content).toContain('description: 新しい要旨');
      expect(doc?.kind).toBe('premise');
    });

    it('本文は1バイトも変わらない（見出しを複数持つ長い本文で確かめる）', async () => {
      const h = harness();
      const original = `---\ndescription: 古い要旨\ntype: premise\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      await fmBased(h, {
        slug: 'values',
        type: 'fact',
        summary: '区分を変えた',
      });

      const content = (await h.stores.persona.read('values'))?.content ?? '';
      const bodyAfter = content.split('\n').slice(4).join('\n');
      expect(bodyAfter).toBe(longBody);
    });

    it('本文が空（frontmatter だけ）の文書でも、閉じの --- の後ろの改行が落ちない', async () => {
      const h = harness();
      await h.stores.persona.write('values', '---\ndescription: 元の要旨\n---\n');

      await fmBased(h, {
        slug: 'values',
        type: 'fact',
        summary: '区分を付けた',
      });

      const content = (await h.stores.persona.read('values'))?.content ?? '';
      expect(content).toBe('---\ndescription: 元の要旨\ntype: fact\n---\n');
      expect(content.endsWith('---\n')).toBe(true);
    });

    it('渡さなかったキーは既存の値のまま残る', async () => {
      const h = harness();
      const original = `---\ndescription: 元の要旨\ntype: fact\nparent: root\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      await fmBased(h, {
        slug: 'values',
        description: '新しい要旨',
        summary: '要旨だけ直した',
      });

      const doc = await h.stores.persona.read('values');
      expect(doc?.description).toBe('新しい要旨');
      expect(doc?.kind).toBe('fact');
      expect(doc?.parent).toBe('root');
    });

    it('description を変えると memory_list の「要旨は本文より…古い」が消える（describedAt が進む）', async () => {
      vi.useFakeTimers();
      try {
        const h = harness();
        await h.stores.persona.write('values', `---\ndescription: 古い要旨\n---\n${longBody}`);
        vi.advanceTimersByTime(1000);
        await h.stores.persona.write(
          'values',
          `---\ndescription: 古い要旨\n---\n${longBody}\n\n追加の1文。`,
        );
        vi.advanceTimersByTime(1000);

        const staleListing = await h.call('memory_list', {});
        expect(staleListing).toContain('要旨は本文より1秒古い');

        await fmBased(h, {
          slug: 'values',
          description: '本文に合わせた新しい要旨',
          summary: '要旨を直した',
        });

        const freshListing = await h.call('memory_list', {});
        expect(freshListing).not.toContain('要旨は本文より');
        expect(freshListing).toContain('要旨の後に本文は動いていない');
        expect(freshListing).toContain('本文に合わせた新しい要旨');
      } finally {
        vi.useRealTimers();
      }
    });

    it('type を変えたら、載り方が変わったことが応答に出る（premise → fact）', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ntype: premise\n---\n${longBody}`);

      const reply = await fmBased(h, {
        slug: 'values',
        type: 'fact',
        summary: '区分を下げた',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('fact');
      expect(reply).toMatch(/目次の1行|全文には載らない/);
    });

    it('type を変えなければ、区分が変わったという文言は出ない', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ntype: premise\n---\n${longBody}`);

      const reply = await fmBased(h, {
        slug: 'values',
        description: '要旨だけ',
        summary: '要旨だけ',
      });

      expect(reply).not.toContain('区分が変わった');
    });

    it('不正な type（綴り違い等）には断り、frontmatter が1文字も変わっていない', async () => {
      const h = harness();
      const original = `---\ndescription: 旧\ntype: premise\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      const reply = await fmBased(h, {
        slug: 'values',
        type: 'Fact',
        summary: '区分を変えたつもり',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('fact');
      expect(reply).toMatch(/断|何も変わっていない/);
      expect((await h.stores.persona.read('values'))?.content).toBe(original);
    });

    describe('改行を含む値は断る（description / type / parent に文字列が混ざるのを防ぐ）', () => {
      it('description に \\n を含む値は断り、frontmatter も本文も1文字も変わっていない', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await fmBased(h, {
          slug: 'values',
          description: 'a\n---\nb',
          type: 'fact',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('description');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('description に単独の \\r を含む値も断る（\\r\\n だけでなく）', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await fmBased(h, {
          slug: 'values',
          description: 'a\rb',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('description');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('description の断りには、全文字数・改行の位置・前後の抜粋（証拠）が出る（#1213）', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const before = 'あ'.repeat(10);
        const after = 'い'.repeat(10);
        const value = `${before}\n${after}`;

        const reply = await fmBased(h, {
          slug: 'values',
          description: value,
          summary: '混ぜようとした',
        });

        expect(reply).toContain('description');
        expect(reply).toContain(`${value.length}`);
        expect(reply).toContain('21');
        expect(reply).toContain('11');
        expect(reply).toContain(`${before}\\n${after}`);
        expect(reply).not.toMatch(/[\r\n]/);
      });

      it('parent に改行を含む値も断る（frontmatter も本文も1文字も変わっていない）', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\nparent: root\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await fmBased(h, {
          slug: 'values',
          parent: 'root\ndescription: hijacked',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('parent');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('改行が無ければ通る（--- を含む1行の値そのものは問題ない）', async () => {
        const h = harness();
        await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

        const reply = await fmBased(h, {
          slug: 'values',
          description: 'a---b（1行のまま）',
          summary: '1行のまま直した',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('values'))?.description).toBe('a---b（1行のまま）');
      });

      it('改行を1文字も含まない長い description（約400文字）は断られず、応答に「改行」という語も出ない（#1213）', async () => {
        const h = harness();
        await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

        const longDescription = '⭐ ⚠ ⟹ ／ 〜 長い要旨のための繰り返し文である。'.repeat(20);
        expect(longDescription.length).toBeGreaterThan(400);
        expect(longDescription).not.toMatch(/[\r\n]/);

        const reply = await fmBased(h, {
          slug: 'values',
          description: longDescription,
          summary: '長い要旨に差し替えた',
        });

        expect(reply).toContain('更新した');
        expect(reply).not.toContain('改行');
        expect((await h.stores.persona.read('values'))?.description).toBe(longDescription);
      });
    });

    it('malformed な frontmatter には断り、何も変わっていない', async () => {
      const h = harness();
      const malformed = '---\nno colon here\n---\n本文\n';
      await h.stores.persona.write('values', malformed);

      const reply = await fmBased(h, {
        slug: 'values',
        description: '直したい',
        summary: '直したつもり',
      });

      expect(reply).toContain('malformed');
      expect((await h.stores.persona.read('values'))?.content).toBe(malformed);
    });

    it('差分の要約（describeMemoryWriteDiff）が応答に付き、消えた見出しは無い', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

      const reply = await fmBased(h, {
        slug: 'values',
        description: '新',
        summary: '要旨を直した',
      });

      expect(reply).toContain('消えた見出し: なし。');
    });

    it('日誌には action: "describe" が構造として載る（bytesBefore/After も数として残る）', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

      await fmBased(h, {
        slug: 'values',
        description: '新しい要旨（長め）',
        summary: '要旨を直した',
      });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', action: 'describe' });
      const withBytes = entry as { bytesBefore: number; bytesAfter: number };
      expect(typeof withBytes.bytesBefore).toBe('number');
      expect(typeof withBytes.bytesAfter).toBe('number');
    });

    describe('human guard — guardFullReplace をそのまま通す', () => {
      it('⚠️ 蒸留の走行からは human 文書を書き換えられない。断り文だけでなく frontmatter が1文字も変わっていないことも確かめる', async () => {
        const h = harness();
        const original = `---\ndescription: 人間が書いた要旨\ntype: premise\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const reply = await fmBased(h, {
          slug: 'values',
          description: '蒸留が書き換えたい要旨',
          summary: '直したつもり',
        });

        expect(reply).toContain('断った');
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      // `unknown` は試さない: インメモリの器は書き込み済みの文書を `unknown` にできないため

      it('断りの応答は4要素を持つ。ただし4つ目は memory_append を勧めない（要旨を直したい人には無意味）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const reply = await fmBased(h, {
          slug: 'values',
          description: '書き換えたい',
          summary: '直したつもり',
        });

        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).toContain('ask_human');
        expect(reply).toContain('values');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect(reply).toContain('memory_append');
        expect(reply).toContain('代わりにならない');
      });

      it('clone の書き込みは通る（能力を消していない）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('clone');

        const reply = await fmBased(h, {
          slug: 'values',
          description: '会話の中で直した要旨',
          summary: '直した',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('values'))?.description).toBe('会話の中で直した要旨');
      });

      it('対照 — clone-only の文書には distill からも通る（検出器が非0を出せること）', async () => {
        const h = harness();
        await writeBased(h, { slug: 'notes', content: longBody, summary: '作成' });
        expect(await h.stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

        h.setMemoryCause('distill');
        const reply = await fmBased(h, {
          slug: 'notes',
          description: '蒸留が付けた要旨',
          summary: '蒸留で要旨を付けた',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('notes'))?.description).toBe('蒸留が付けた要旨');
      });

      it('トグルを off にすると断らない（能力を消していない）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const before = process.env.ALTEROID_MEMORY_GUARD;
        process.env.ALTEROID_MEMORY_GUARD = 'off';
        try {
          const reply = await fmBased(h, {
            slug: 'values',
            description: 'off にしたので通る',
            summary: '直した',
          });
          expect(reply).toContain('更新した');
        } finally {
          if (before === undefined) delete process.env.ALTEROID_MEMORY_GUARD;
          else process.env.ALTEROID_MEMORY_GUARD = before;
        }
      });
    });
  });

  describe('memory_outline / memory_section_move（本文を出さずに節を移す。#318 案 (b)）', () => {
    async function markHuman(h: Harness, slug: string, content: string): Promise<void> {
      await h.stores.persona.write(slug, content);
      await h.stores.persona.markHumanTouched(slug, new Date().toISOString());
    }

    const SECRET = 'SECRET-XYZ-999';

    const source = [
      '---',
      'description: 私について',
      'type: premise',
      '---',
      '# 私について',
      '芯である。',
      '',
      '## 事例',
      `${SECRET} を含む事例の本文である。`,
      '',
      '### だから',
      '子の節である。',
      '',
      '## 次',
      '残る節である。',
      '',
    ].join('\n');

    const multi = [
      '---',
      'description: 複数節',
      'type: premise',
      '---',
      '# 表紙',
      '芯である。',
      '',
      '## 節A',
      `${SECRET}-A を含む節Aの本文である。`,
      '',
      '## 節B',
      `${SECRET}-B を含む節Bの本文である。`,
      '',
      '## 節C',
      `${SECRET}-C を含む節Cの本文である。`,
      '',
    ].join('\n');

    async function outlineOf(
      h: Harness,
      slug: string,
      side?: 'head' | 'tail',
    ): Promise<{ outline: string; entries: { id: string; heading: string }[] }> {
      const outline = await h.call(
        'memory_outline',
        side === undefined ? { slug } : { slug, side },
      );
      const entries = outline.split('\n').flatMap((line) => {
        const match = /^\s*\[([0-9a-f]{8}-[0-9a-f]{8})\] (.+?) — /.exec(line);
        return match === null ? [] : [{ id: match[1] as string, heading: match[2] as string }];
      });
      return { outline, entries };
    }

    async function outlineId(h: Harness, slug: string, heading: string): Promise<string> {
      const { outline, entries } = await outlineOf(h, slug);
      const hit = entries.find((entry) => entry.heading === heading);
      if (hit === undefined) throw new Error(`節 ${heading} が目次に無い:\n${outline}`);
      return hit.id;
    }

    async function seed(h: Harness, slug = 'about-me', content = source): Promise<void> {
      await writeBased(h, { slug, content, summary: '作成' });
    }

    describe('memory_outline（読むだけ）', () => {
      it('本文を1文字も返さない／frontmatter の行を1つも出さない', async () => {
        const h = harness();
        await seed(h);

        const outline = await h.call('memory_outline', { slug: 'about-me' });

        expect(outline).not.toContain(SECRET);
        expect(outline).not.toContain('芯である');
        expect(outline).not.toContain('description:');
        expect(outline).not.toContain('type: premise');
        expect(outline).toContain('# 私について');
        expect(outline).toContain('## 事例');
        expect(outline).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\]/);
        expect(outline).toMatch(/— \d+ 文字/);
      });

      it('存在しない slug には、そう返す（黙って空の目次を返さない）', async () => {
        const h = harness();

        expect(await h.call('memory_outline', { slug: 'nope' })).toContain('存在しない');
      });

      it('⭐ side=tail で取った節id は、そのまま memory_section_move へ渡せる（既定の目次には出てこない節）', async () => {
        const h = harness();
        const last = `# 節0239: ${'み'.repeat(40)}`;
        const body = Array.from({ length: 240 }, (_, index) => {
          const pad = String(index).padStart(4, '0');
          return `# 節${pad}: ${'み'.repeat(40)}\n\n本文${pad}\n`;
        }).join('\n');
        await seed(h, 'big', `---\ndescription: 節の多い文書\ntype: premise\n---\n${body}`);

        const head = await outlineOf(h, 'big');
        expect(head.entries.map((entry) => entry.heading)).not.toContain(last);
        expect(head.outline).toMatch(/…末尾 \d+ 節は省略/);
        expect(head.outline).toContain('side=tail');

        const tail = await outlineOf(h, 'big', 'tail');
        const hit = tail.entries.filter((entry) => entry.heading === last);
        expect(hit).toHaveLength(1);

        const reply = await h.call('memory_section_move', {
          fromSlug: 'big',
          sections: [hit[0]!.id],
          toSlug: 'big-appendix',
          summary: '末尾の節を付録へ移した',
        });

        expect(reply).toContain('移した');
        expect((await h.stores.persona.read('big-appendix'))?.content).toContain(last);
        expect((await h.stores.persona.read('big'))?.content).not.toContain(last);
      });

      it('malformed な文書でも目次は返すが、移動は断られると書く（能力を消さず、理由を見せる）', async () => {
        const h = harness();
        await seed(h, 'broken', '---\ndescription: 閉じが無い\n# 見出し\n本文\n');

        const outline = await h.call('memory_outline', { slug: 'broken' });

        expect(outline).toContain('malformed');
        expect(outline).toContain('memory_section_move');
      });
    });

    describe('移せたとき', () => {
      it('節が移し先の末尾へ足され、出どころから消える。移し先が無ければ作る', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '事例を付録へ移した',
        });

        const from = await h.stores.persona.read('about-me');
        const to = await h.stores.persona.read('about-me-appendix');
        expect(from?.content).not.toContain(SECRET);
        expect(from?.content).not.toContain('## 事例');
        expect(to?.content).toContain('## 事例');
        expect(to?.content).toContain(SECRET);
        expect(from?.content).not.toContain('### だから');
        expect(to?.content).toContain('### だから');
        expect(from?.content).toContain('## 次');
        expect(reply).toContain('移した');
      });

      it('⚠ 移した節の子孫に階層飛び（### を挟まず ## → ####）が在ると、応答に警告が付く。移動は拒否されない', async () => {
        const h = harness();
        const jumpy = [
          '---',
          'description: 階層が飛んでいる文書',
          'type: premise',
          '---',
          '# 表紙',
          '芯である。',
          '',
          '## 親の話題',
          '親の本文である。',
          '',
          `#### ${SECRET} を含む無関係な規則（### を挟んでいない）`,
          '無関係な本文である。',
          '',
          '## 次',
          '残る節である。',
          '',
        ].join('\n');
        await seed(h, 'jumpy', jumpy);
        const id = await outlineId(h, 'jumpy', '## 親の話題');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'jumpy',
          sections: [id],
          toSlug: 'jumpy-appendix',
          summary: '親の話題を付録へ移した',
        });

        expect(reply).toContain('移した');
        const from = await h.stores.persona.read('jumpy');
        const to = await h.stores.persona.read('jumpy-appendix');
        expect(from?.content).not.toContain('## 親の話題');
        expect(to?.content).toContain('## 親の話題');
        expect(to?.content).toContain(SECRET);

        expect(reply).toContain('階層');
        expect(reply).toContain('子孫 1 件のうち 1 件');
        expect(reply).not.toContain('何も変わっていない');
      });

      it('通常の1段ずつの入れ子を移しても、階層飛びの警告は出ない（当てすぎない）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '事例を付録へ移した',
        });

        expect(reply).toContain('移した');
        expect(reply).not.toContain('階層');
      });

      it('省略の断り書きが total/shown を名乗り、移った先の見出しは memory_outline slug=<toSlug> で確かめられる', async () => {
        const h = harness();
        const sectionCount = 30;
        const body = Array.from({ length: sectionCount }, (_, index) => {
          const pad = String(index).padStart(2, '0');
          return `# 節${pad}: ${'み'.repeat(60)}\n\n本文${pad}: ${'あ'.repeat(120)}\n`;
        }).join('\n');
        await seed(h, 'many-sections', `---\ndescription: 節の多い文書\ntype: fact\n---\n${body}`);
        const { entries } = await outlineOf(h, 'many-sections');
        expect(entries).toHaveLength(sectionCount);

        const reply = await h.call('memory_section_move', {
          fromSlug: 'many-sections',
          sections: entries.map((entry) => entry.id),
          toSlug: 'many-sections-appendix',
          summary: '節をまとめて付録へ移した',
        });

        expect(reply).toMatch(/…ほか \d+ 節は一覧から省略/);
        expect(reply).toMatch(/移した 30 節のうち \d+ 節だけ出した/);

        const outline = await h.call('memory_outline', { slug: 'many-sections-appendix' });
        expect(outline).toContain('記憶 many-sections-appendix の目次');
        expect(outline).toContain('節29');
      });

      it('⭐ premise から既存の fact へ節を移すと、毎ターンの床は減ると応答が言う', async () => {
        const h = harness();
        await seed(h);
        await h.stores.persona.write(
          'about-me-appendix',
          '---\ntype: fact\ndescription: 付録\n---\n# 付録\n既存の本文\n',
        );
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '事例を付録へ移した',
        });

        expect(reply).toContain('毎ターンの床');
        expect(reply).toContain('fact');
        expect(reply).toMatch(
          /毎ターンの床（焼き込み全体。いま読み直した値）: [\d,]+ 文字から [\d,]+ 文字へ（-[\d,]+）/,
        );
      });

      it('⭐ 目次の予算に張り付いた premise から大量の節を fact へ移しても、毎ターンの床は移した本文の量に比例して減らない（そしてそれは欠陥ではなく設計である）', async () => {
        const h = harness();
        const sectionCount = 400;
        const moveCount = 300;
        const bigTocBody = Array.from({ length: sectionCount }, (_, index) => {
          const pad = String(index).padStart(4, '0');
          return `# 節${pad}: ${'み'.repeat(40)}\n\n本文${pad}: ${'あ'.repeat(60)}\n`;
        }).join('\n');
        await seed(
          h,
          'big-toc',
          `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${bigTocBody}`,
        );
        await h.stores.persona.write(
          'big-toc-appendix',
          '---\ntype: fact\ndescription: 大量移動の受け皿\n---\n# 付録\n既存の本文\n',
        );

        const before = await h.stores.persona.documents();
        expect(renderMemoryDocuments(before)).toContain('目次から省略');

        const doc = await h.stores.persona.read('big-toc');
        if (doc === null) throw new Error('big-toc が見つからない（seed に失敗した）');
        const { sections } = scanMemorySections(doc.content);
        expect(sections).toHaveLength(sectionCount);
        const moved = sections.slice(0, moveCount);

        const reply = await h.call('memory_section_move', {
          fromSlug: 'big-toc',
          sections: moved.map((section) => section.id),
          toSlug: 'big-toc-appendix',
          summary: '張り付いた目次から先頭寄りの節をまとめて付録へ移した',
        });

        const after = await h.stores.persona.documents();
        expect(renderMemoryDocuments(after)).toContain('目次から省略');

        const movedMatch = /合計 ([\d,]+) 文字）を big-toc-appendix の末尾へ移した/.exec(reply);
        if (movedMatch === null) throw new Error(`応答から移した文字数を読めない:\n${reply}`);
        const movedChars = Number(movedMatch[1]!.replace(/,/g, ''));
        expect(movedChars).toBeGreaterThanOrEqual(10_000);

        const floorMatch =
          /毎ターンの床（焼き込み全体。いま読み直した値）: [\d,]+ 文字から [\d,]+ 文字へ（([+-][\d,]+)）/.exec(
            reply,
          );
        if (floorMatch === null) throw new Error(`応答から毎ターンの床の遷移を読めない:\n${reply}`);
        const delta = Math.abs(Number(floorMatch[1]!.replace(/,/g, '')));

        // 上界の 500 は実装の定数から導かない: 「本文の量に比例しない」ことを示すための恣意的な小ささのため
        expect(delta).toBeLessThan(500);
        expect(movedChars).toBeGreaterThan(Math.max(delta, 1) * 20);

        expect(reply).toContain('張り付いている');
        expect(reply).toContain('big-toc の節の目次は1文書あたりの予算');
        expect(reply).not.toContain('big-toc-appendix の節の目次');
      });

      it('出どころの frontmatter がバイト同一である（キーの順序・空白も含めて）', async () => {
        const h = harness();
        const odd = [
          '---',
          'type:  premise',
          'description:   私について',
          '---',
          '# A',
          '本文',
          '',
          '# B',
          '本文',
          '',
        ].join('\n');
        await seed(h, 'odd', odd);
        const header = odd.slice(0, odd.indexOf('# A'));
        const id = await outlineId(h, 'odd', '# A');

        await h.call('memory_section_move', {
          fromSlug: 'odd',
          sections: [id],
          toSlug: 'odd-appendix',
          summary: '移した',
        });

        const from = await h.stores.persona.read('odd');
        expect(from?.content.slice(0, header.length)).toBe(header);
      });

      it('コードフェンスの中の見出しを境界にしないので、移した後もフェンスの開閉が揃う', async () => {
        const h = harness();
        const fenced = [
          '# ログ',
          '',
          '## 例',
          '```sh',
          '## これは見出しではない',
          'echo hi',
          '```',
          '本文E',
          '',
          '## 次',
          '本文F',
          '',
        ].join('\n');
        await seed(h, 'log', fenced);
        const id = await outlineId(h, 'log', '## 例');

        await h.call('memory_section_move', {
          fromSlug: 'log',
          sections: [id],
          toSlug: 'log-appendix',
          summary: '移した',
        });

        const from = await h.stores.persona.read('log');
        const to = await h.stores.persona.read('log-appendix');
        expect((from?.content.match(/^```/gm) ?? []).length).toBe(0);
        expect((to?.content.match(/^```/gm) ?? []).length).toBe(2);
        expect(from?.content).toContain('## 次');
      });

      it('⭐ 応答に古い本文が1文字も出ない（名指しするのは見出しと節id だけ）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).not.toContain(SECRET);
        expect(reply).not.toContain('子の節である');
        expect(reply).toContain('## 事例');
        expect(reply).toContain(id);
      });

      it('両方の文書について差分の要約が出る', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した先 about-me-appendix');
        expect(reply).toContain('新規作成');
        expect(reply).toContain('出どころ about-me');
        expect(reply).toMatch(/→ [\d,]+ 文字（-[\d,]+）/);
      });

      it('日誌に move_in / move_out が2件、bytesBefore / bytesAfter つきで載る', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');
        const before = (await h.stores.persona.read('about-me'))?.content as string;

        await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '事例を付録へ移した',
        });

        const entries = await h.stores.journal.list({ types: ['memory_update'] });
        const moveOut = entries.find((entry) => 'action' in entry && entry.action === 'move_out');
        const moveIn = entries.find((entry) => 'action' in entry && entry.action === 'move_in');
        expect(moveOut).toMatchObject({
          slug: 'about-me',
          cause: 'clone',
          bytesBefore: Buffer.byteLength(before, 'utf8'),
        });
        expect(moveIn).toMatchObject({ slug: 'about-me-appendix', cause: 'clone', bytesBefore: 0 });
        expect((moveOut as { bytesAfter: number }).bytesAfter).toBeLessThan(
          Buffer.byteLength(before, 'utf8'),
        );
        expect((moveIn as { bytesAfter: number }).bytesAfter).toBeGreaterThan(0);
        for (const entry of entries) expect(JSON.stringify(entry)).not.toContain(SECRET);
      });

      it('⭐ 複数の節を1回で移せる。移し先には文書に現れる順で並ぶ', async () => {
        const h = harness();
        await seed(h, 'multi', multi);
        const idA = await outlineId(h, 'multi', '## 節A');
        const idC = await outlineId(h, 'multi', '## 節C');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'multi',
          sections: [idC, idA],
          toSlug: 'multi-appendix',
          summary: '節A・節Cを付録へ移した',
        });

        const to = (await h.stores.persona.read('multi-appendix'))?.content as string;
        const from = (await h.stores.persona.read('multi'))?.content as string;
        expect(to).toContain('## 節A');
        expect(to).toContain('## 節C');
        expect(to.indexOf('## 節A')).toBeLessThan(to.indexOf('## 節C'));
        expect(from).toContain('## 節B');
        expect(reply).toContain('移した');
      });

      it('複数節でも日誌は move_in / move_out の2件のまま（節数に比例しない）', async () => {
        const h = harness();
        await seed(h, 'multi', multi);
        const idA = await outlineId(h, 'multi', '## 節A');
        const idB = await outlineId(h, 'multi', '## 節B');
        const idC = await outlineId(h, 'multi', '## 節C');

        await h.call('memory_section_move', {
          fromSlug: 'multi',
          sections: [idA, idB, idC],
          toSlug: 'multi-appendix',
          summary: '3節まとめて付録へ移した',
        });

        const entries = await h.stores.journal.list({ types: ['memory_update'] });
        const moveOuts = entries.filter(
          (entry) => 'action' in entry && entry.action === 'move_out',
        );
        const moveIns = entries.filter((entry) => 'action' in entry && entry.action === 'move_in');
        expect(moveOuts).toHaveLength(1);
        expect(moveIns).toHaveLength(1);
      });

      it('⭐ 複数節でも応答に古い本文が1文字も出ない', async () => {
        const h = harness();
        await seed(h, 'multi', multi);
        const idA = await outlineId(h, 'multi', '## 節A');
        const idB = await outlineId(h, 'multi', '## 節B');
        const idC = await outlineId(h, 'multi', '## 節C');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'multi',
          sections: [idA, idB, idC],
          toSlug: 'multi-appendix',
          summary: '3節まとめて付録へ移した',
        });

        expect(reply).not.toContain(`${SECRET}-A`);
        expect(reply).not.toContain(`${SECRET}-B`);
        expect(reply).not.toContain(`${SECRET}-C`);
        expect(reply).toContain('## 節A');
        expect(reply).toContain('## 節B');
        expect(reply).toContain('## 節C');
        expect(reply).toContain(idA);
        expect(reply).toContain(idB);
        expect(reply).toContain(idC);
      });
    });

    describe('断るとき（どの断りでも、from も to も1文字も変わらない）', () => {
      it('from と to が同じ slug なら断る', async () => {
        const h = harness();
        await seed(h);
        const original = (await h.stores.persona.read('about-me'))?.content as string;
        const id = await outlineId(h, 'about-me', '## 事例');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me',
          summary: '移した',
        });

        expect(reply).toContain('同じ文書');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
      });

      it('存在しない文書には断る（何も作らない）', async () => {
        const h = harness();

        const reply = await h.call('memory_section_move', {
          fromSlug: 'nope',
          sections: ['deadbeef-cafebabe'],
          toSlug: 'somewhere',
          summary: '移した',
        });

        expect(reply).toContain('存在しない');
        expect(await h.stores.persona.read('somewhere')).toBeNull();
      });

      it('frontmatter が malformed なら断る（本文の始まりが決まらないので運べない）', async () => {
        const h = harness();
        const broken = '---\ndescription: 閉じが無い\n# 見出し\n本文\n';
        await seed(h, 'broken', broken);
        const original = (await h.stores.persona.read('broken'))?.content as string;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'broken',
          sections: ['deadbeef-cafebabe'],
          toSlug: 'elsewhere',
          summary: '移した',
        });

        expect(reply).toContain('malformed');
        expect((await h.stores.persona.read('broken'))?.content).toBe(original);
        expect(await h.stores.persona.read('elsewhere')).toBeNull();
      });

      it('⭐ 対象の節を外から書き換えてから同じ節id で呼ぶと、断られて1文字も変わらない', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        await h.stores.persona.write(
          'about-me',
          source.replace('事例の本文である', '事例の本文を直した'),
        );
        const original = (await h.stores.persona.read('about-me'))?.content as string;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('古い');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
        expect(await h.stores.persona.read('about-me-appendix')).toBeNull();
      });

      it('⭐ 別の節を外から書き換えてから同じ節id で呼ぶと、通る（無関係な変更で断らない）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        await h.stores.persona.write('about-me', source.replace('残る節である', '残る節を直した'));

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した');
        expect((await h.stores.persona.read('about-me-appendix'))?.content).toContain(SECRET);
      });

      it('⭐ 「そんな id は無い」と「その id は古い」で文言が違う', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');
        const staleId = `${id.split('-')[0]}-00000000`;
        const original = (await h.stores.persona.read('about-me'))?.content as string;

        const absent = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: ['deadbeef-cafebabe'],
          toSlug: 'appendix',
          summary: '移した',
        });
        const stale = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [staleId],
          toSlug: 'appendix',
          summary: '移した',
        });

        expect(absent).not.toBe(stale);
        expect(absent).toContain('打ち間違い');
        expect(absent).not.toContain('書き換えている');
        expect(stale).toContain('古い');
        expect(stale).toContain('書き換えている');
        expect(stale).toContain('memory_outline');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
        expect(await h.stores.persona.read('appendix')).toBeNull();
      });

      it('⭐ 中身まで同一の節が2つある文書では、その節id を断る（1文字も変わらない）', async () => {
        const h = harness();
        const dup = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';
        await seed(h, 'dup', dup);
        const outline = await h.call('memory_outline', { slug: 'dup' });
        const id = (
          /\[([0-9a-f]{8}-[0-9a-f]{8})\] # A/.exec(outline) as RegExpExecArray
        )[1] as string;
        const original = (await h.stores.persona.read('dup'))?.content as string;

        expect(outline).toContain('この id では動かせない');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'dup',
          sections: [id],
          toSlug: 'dup-appendix',
          summary: '移した',
        });

        expect(reply).toContain('2 箇所');
        expect(reply).toContain('選ばずに断る');
        expect((await h.stores.persona.read('dup'))?.content).toBe(original);
        expect(await h.stores.persona.read('dup-appendix')).toBeNull();
      });

      it('⭐ 1つでも古い節id が混ざっていたら、1節も動かさない', async () => {
        const h = harness();
        await seed(h, 'multi', multi);
        const idA = await outlineId(h, 'multi', '## 節A');
        const idB = await outlineId(h, 'multi', '## 節B');
        await seed(h, 'multi-appendix', '# 付録\n既存の本文\n');
        const toBefore = (await h.stores.persona.read('multi-appendix'))?.content as string;

        const edited = multi.replace('節Bの本文である', '節Bの本文を書き換えた');
        await h.stores.persona.write('multi', edited);

        const reply = await h.call('memory_section_move', {
          fromSlug: 'multi',
          sections: [idA, idB],
          toSlug: 'multi-appendix',
          summary: '移した',
        });

        expect(reply).toContain('古い');
        expect((await h.stores.persona.read('multi'))?.content).toBe(edited);
        expect((await h.stores.persona.read('multi-appendix'))?.content).toBe(toBefore);
      });

      it('⭐ 親と子を同時に指したら断る（from も to も1バイトも変わらない）', async () => {
        const h = harness();
        await seed(h);
        const parentId = await outlineId(h, 'about-me', '## 事例');
        const childId = await outlineId(h, 'about-me', '### だから');
        const original = (await h.stores.persona.read('about-me'))?.content as string;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [parentId, childId],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('重なっている');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
        expect(await h.stores.persona.read('about-me-appendix')).toBeNull();
      });

      it('⭐ 同じ節id を2回渡したら断る（from も to も1バイトも変わらない）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');
        const original = (await h.stores.persona.read('about-me'))?.content as string;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id, id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('重なっている');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
        expect(await h.stores.persona.read('about-me-appendix')).toBeNull();
      });

      it('隣り合う兄弟の節は重なりではないので、2つまとめて移せる', async () => {
        const h = harness();
        await seed(h);
        const eventId = await outlineId(h, 'about-me', '## 事例');
        const nextId = await outlineId(h, 'about-me', '## 次');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [eventId, nextId],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した');
        const to = (await h.stores.persona.read('about-me-appendix'))?.content as string;
        expect(to).toContain('## 事例');
        expect(to).toContain('## 次');
      });

      it('解決できなかった節が2件以上あるとき、1件目は今までと同じ文言で、残りは件数で数え上げる（id を全部並べない）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');
        const staleId = `${id.split('-')[0]}-00000000`;
        const secondAbsentId = 'baadf00d-01234567';
        const original = (await h.stores.persona.read('about-me'))?.content as string;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: ['deadbeef-cafebabe', staleId, secondAbsentId],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('打ち間違い');
        expect(reply).not.toContain(staleId);
        expect(reply).not.toContain(secondAbsentId);
        expect(reply).toContain(
          'ほかにも解決できなかった節id が 2 件ある（無い 1 件・古い 1 件・曖昧 0 件）。',
        );
        expect(reply).toContain('今回指定した他の 2 節も含めて1節も移していない。');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
        expect(await h.stores.persona.read('about-me-appendix')).toBeNull();
      });

      it('1節だけ渡して解決に失敗したときの応答は、複数節対応の前と同じ文言のまま（追加の行が出ない）', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');
        const staleId = `${id.split('-')[0]}-00000000`;

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [staleId],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('古い');
        expect(reply).not.toContain('ほかにも解決できなかった');
        expect(reply).not.toContain('この口は全件が見つかったときしか動かさない');
      });
    });

    describe('human guard — 節の移動だけは通す（失われない操作だから。2026-09-08 に反転）', () => {
      it('⭐ 蒸留の走行から human 文書の節を移せる。抜けた節は必ず移し先に在る（失われない）', async () => {
        const h = harness();
        await markHuman(h, 'about-me', source);
        const id = await outlineId(h, 'about-me', '## 事例');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).not.toContain('断った');
        expect(reply).toContain('移した');
        const from = (await h.stores.persona.read('about-me'))?.content ?? '';
        const to = (await h.stores.persona.read('about-me-appendix'))?.content ?? '';
        expect(from).not.toBe(source);
        expect(from).not.toContain('## 事例');
        expect(to).toContain('## 事例');
        expect(to).toContain(SECRET);
        expect(from).not.toContain(SECRET);
      });

      it('⭐ 蒸留の走行から、人間が書いた文書の複数節もまとめて移せる（どれも失われない）', async () => {
        const h = harness();
        await markHuman(h, 'about-me', source);
        const eventId = await outlineId(h, 'about-me', '## 事例');
        const nextId = await outlineId(h, 'about-me', '## 次');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [eventId, nextId],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).not.toContain('断った');
        const from = (await h.stores.persona.read('about-me'))?.content ?? '';
        const to = (await h.stores.persona.read('about-me-appendix'))?.content ?? '';
        expect(from).not.toContain('## 事例');
        expect(from).not.toContain('## 次');
        expect(to).toContain('## 事例');
        expect(to).toContain('## 次');
      });

      it('断る口（全文置換）の応答は4つのことを言う — なぜ／どうすれば通るか／失われていない／代わり', async () => {
        const h = harness();
        await markHuman(h, 'about-me', source);
        h.setMemoryCause('distill');

        const reply = await writeBased(h, {
          slug: 'about-me',
          content: '# 私について\n書き換えたつもり',
          summary: '書き換えたつもり',
        });

        expect(reply).toContain('断った');
        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).toContain('ask_human');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect(reply).toContain('memory_append');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(source);
      });

      it('対照 — clone-only の文書なら distill からも通る（検出器が非0を出せること）', async () => {
        const h = harness();
        await seed(h);
        expect(await h.stores.persona.protectionStatus('about-me')).toEqual({ kind: 'clone-only' });
        const id = await outlineId(h, 'about-me', '## 事例');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した');
      });

      it('対照 — 会話の中（clone）なら human 印の文書でも通る（能力を消していない）', async () => {
        const h = harness();
        await markHuman(h, 'about-me', source);
        const id = await outlineId(h, 'about-me', '## 事例');
        h.setMemoryCause('clone');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した');
        expect((await h.stores.persona.read('about-me-appendix'))?.content).toContain('## 事例');
      });

      const GUARD_EXEMPTIONS = [
        {
          label: 'clone × 全文置換',
          cause: 'clone' as const,
          action: '全文置換' as const,
          allowed: true,
          isolates: "会話の中の書き手を通す免除（`cause !== 'distill'`）",
        },
        {
          label: 'distill × 節の移動',
          cause: 'distill' as const,
          action: '節の移動' as const,
          allowed: true,
          isolates: "失わない操作を通す免除（`action === '節の移動'`）",
        },
        {
          label: 'distill × 全文置換',
          cause: 'distill' as const,
          action: '全文置換' as const,
          allowed: false,
          isolates: '（どの免除も効かない ＝ 歯が本当に弾いている側）',
        },
        {
          label: 'clone × 節の移動',
          cause: 'clone' as const,
          action: '節の移動' as const,
          allowed: true,
          isolates: '⛔ 2本の免除が両方とも通すので、このセルでは免除を特定できない',
        },
      ];

      it.each(GUARD_EXEMPTIONS)(
        '$label — 免除の切り分け（$isolates）',
        async ({ cause, action, allowed, isolates }) => {
          const h = harness();
          await markHuman(h, 'about-me', source);
          h.setMemoryCause(cause);

          const reply =
            action === '全文置換'
              ? await writeBased(h, {
                  slug: 'about-me',
                  content: '# 私について\n書き換えたつもり',
                  summary: '書き換えたつもり',
                })
              : await h.call('memory_section_move', {
                  fromSlug: 'about-me',
                  sections: [await outlineId(h, 'about-me', '## 事例')],
                  toSlug: 'about-me-appendix',
                  summary: '移した',
                });

          expect(
            reply.includes('断った'),
            allowed
              ? `**通るはずの組み合わせが断られた。** ${isolates} が消えたか、判定の向きが反転している。` +
                  'この赤の意味は「能力の削除」——記憶を整理する道が、通ってよい書き手からも塞がった。'
              : '**弾くはずの組み合わせが通った。** この赤の意味は「歯そのものが外れた」——' +
                  '人間が書いた文書が、人間の居ない走行から全文置換で失われうる。',
          ).toBe(!allowed);

          const after = (await h.stores.persona.read('about-me'))?.content;
          if (allowed) {
            expect(after, '通ったと言いながら、出どころの文書が1文字も変わっていない').not.toBe(
              source,
            );
          } else {
            expect(after, '断ったと言いながら、出どころの文書が書き換わっている').toBe(source);
          }
        },
      );

      it('移し先が human 印でも、蒸留の走行から足せる（歯は出どころにだけ掛かる）', async () => {
        const h = harness();
        await seed(h);
        await markHuman(h, 'appendix', '# 付録\n人間が書いた\n');
        const id = await outlineId(h, 'about-me', '## 事例');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'appendix',
          summary: '移した',
        });

        expect(reply).toContain('移した');
        expect((await h.stores.persona.read('appendix'))?.content).toContain('人間が書いた');
        expect((await h.stores.persona.read('appendix'))?.content).toContain('## 事例');
      });

      it('説明文は「distill からは節を移せない」と言わず、「この口だけは distill からも通る」と言う', () => {
        const stores = createMemoryStores();
        const tools = createCloneTools({
          stores,
          emit: () => undefined,
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        const description =
          tools.find((entry) => entry.name === 'memory_section_move')?.description ?? '';

        expect(description).not.toContain(
          '統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書からは節を移せない',
        );
        expect(description).toMatch(/統合の走行（distill）からでも[^。]*通る/);
        expect(description).toContain('全文置換・削除・frontmatter の更新はいまも断る');
      });

      it('実装の値（保護状態がいちばん堅い側でも節が移るか）と説明文の主張を、それぞれ現在の正しい値へ釘で留める', async () => {
        const h = harness();
        await seed(h);
        const id = await outlineId(h, 'about-me', '## 事例');

        h.stores.persona.protectionStatus = async () => ({ kind: 'unknown' as const });
        h.setMemoryCause('distill');

        const denied = await writeBased(h, {
          slug: 'about-me',
          content: '# 私について\n書き換えたつもり',
          summary: '書き換えたつもり',
        });
        expect(denied).toContain('断った');
        expect((await h.stores.persona.read('about-me'))?.content).toBe(source);

        const reply = await h.call('memory_section_move', {
          fromSlug: 'about-me',
          sections: [id],
          toSlug: 'about-me-appendix',
          summary: '移した',
        });
        const movePasses =
          !reply.includes('断った') &&
          ((await h.stores.persona.read('about-me-appendix'))?.content ?? '').includes(SECRET);

        const tools = createCloneTools({
          stores: createMemoryStores(),
          emit: () => undefined,
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        const description =
          tools.find((entry) => entry.name === 'memory_section_move')?.description ?? '';
        const claimsMoveDenied = /distill[^。]*移せない|移せない[^。]*distill/.test(description);

        expect(movePasses).toBe(true);
        expect(claimsMoveDenied).toBe(false);
        expect(movePasses).toBe(!claimsMoveDenied);
      });
    });

    it('⭐ 移し先への追記が済んだ後に出どころの書き込みが落ちても、重複が残るだけで失われない', async () => {
      const h = harness();
      await seed(h);
      const id = await outlineId(h, 'about-me', '## 事例');
      const original = (await h.stores.persona.read('about-me'))?.content as string;

      const realWrite = h.stores.persona.write.bind(h.stores.persona);
      h.stores.persona.write = async (slug: string, content: string) => {
        if (slug === 'about-me') throw new Error('ストアが落ちた');
        return realWrite(slug, content);
      };

      const reply = await h.call('memory_section_move', {
        fromSlug: 'about-me',
        sections: [id],
        toSlug: 'about-me-appendix',
        summary: '移した',
      });

      expect((await h.stores.persona.read('about-me'))?.content).toBe(original);
      expect((await h.stores.persona.read('about-me-appendix'))?.content).toContain('## 事例');
      expect(reply).toContain('重複');
      expect(reply).toContain('失われてはいない');
    });
  });

  describe('memory_section_read（節id で本文を開く。読むだけ）', () => {
    const MARK = 'MARK-SECTION-READ-777';

    const doc = [
      '---',
      'description: 節を開く',
      'type: premise',
      '---',
      '# 表紙',
      '前書きである。',
      '',
      '## 節A',
      `${MARK}-A を含む節Aの本文である。`,
      '',
      '### 節Aの子',
      `${MARK}-KO を含む子の本文である。`,
      '',
      '## 節B',
      `${MARK}-B を含む節Bの本文である。`,
      '',
      '## 節C',
      `${MARK}-C を含む節Cの本文である。`,
      '',
    ].join('\n');

    async function seed(h: Harness, slug = 'about-me', content = doc): Promise<void> {
      await writeBased(h, { slug, content, summary: '作成' });
    }

    async function sectionId(h: Harness, slug: string, heading: string): Promise<string> {
      const outline = await h.call('memory_outline', { slug });
      const hit = outline.split('\n').flatMap((line) => {
        const match = /^\s*\[([0-9a-f]{8}-[0-9a-f]{8})\] (.+?) — /.exec(line);
        return match !== null && match[2] === heading ? [match[1] as string] : [];
      });
      if (hit.length !== 1) throw new Error(`節 ${heading} が目次に1つだけ在るはず:\n${outline}`);
      return hit[0] as string;
    }

    function refusalFor(reply: string, id: string): string {
      return reply.split('\n').find((line) => line.startsWith(`- ${id}:`)) ?? '';
    }

    it('節id を渡すと、その節の本文が返る', async () => {
      const h = harness();
      await seed(h);
      const id = await sectionId(h, 'about-me', '## 節A');

      const reply = await h.call('memory_section_read', { slug: 'about-me', sections: [id] });

      expect(reply).toContain(`${MARK}-A`);
      expect(reply).toContain('## 節A');
      expect(reply).toContain(`[${id}]`);
      expect(reply).not.toContain(`${MARK}-B`);
      expect(reply).not.toContain(`${MARK}-C`);
      expect(reply).toContain('1 件開いた');
    });

    it('⭐ 複数の節id を1回で渡せる。返る順序は渡した順ではなく文書に現れる順である', async () => {
      const h = harness();
      await seed(h);
      const idA = await sectionId(h, 'about-me', '## 節A');
      const idB = await sectionId(h, 'about-me', '## 節B');
      const idC = await sectionId(h, 'about-me', '## 節C');

      const reply = await h.call('memory_section_read', {
        slug: 'about-me',
        sections: [idC, idB, idA],
      });

      expect(reply).toContain(`${MARK}-A`);
      expect(reply).toContain(`${MARK}-B`);
      expect(reply).toContain(`${MARK}-C`);
      expect(reply).toContain('3 件開いた');
      expect(reply.indexOf(`${MARK}-A`)).toBeLessThan(reply.indexOf(`${MARK}-B`));
      expect(reply.indexOf(`${MARK}-B`)).toBeLessThan(reply.indexOf(`${MARK}-C`));
    });

    it('入れ子の子は親に含まれる（親の節id を渡すと子の本文も出る）', async () => {
      const h = harness();
      await seed(h);
      const idA = await sectionId(h, 'about-me', '## 節A');

      const reply = await h.call('memory_section_read', { slug: 'about-me', sections: [idA] });

      expect(reply).toContain(`${MARK}-A`);
      expect(reply).toContain(`${MARK}-KO`);
      expect(reply).toContain('### 節Aの子');
      expect(reply).not.toContain(`${MARK}-B`);
    });

    it('⭐ 読めなかった節id は理由ごとに分けて返る（古い / 1つに決まらない / 無い）', async () => {
      const h = harness();
      await seed(h);
      const idA = await sectionId(h, 'about-me', '## 節A');
      const staleId = `${idA.split('-')[0]}-00000000`;
      const absentId = 'deadbeef-cafebabe';

      const reply = await h.call('memory_section_read', {
        slug: 'about-me',
        sections: [staleId, absentId],
      });

      expect(reply).toContain('読めなかった節');
      const stale = refusalFor(reply, staleId);
      const absent = refusalFor(reply, absentId);
      expect(stale).not.toBe('');
      expect(absent).not.toBe('');
      expect(stale).not.toBe(absent);
      expect(stale).toContain('古い');
      expect(stale).toContain('memory_outline');
      expect(absent).not.toContain('古い');
      expect(absent).toContain('この文書に無い');
      expect(absent).toContain('打ち間違い');

      await seed(h, 'dup', '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n');
      const outline = await h.call('memory_outline', { slug: 'dup' });
      const dupId = (
        /\[([0-9a-f]{8}-[0-9a-f]{8})\] # A/.exec(outline) as RegExpExecArray
      )[1] as string;

      const dupReply = await h.call('memory_section_read', { slug: 'dup', sections: [dupId] });
      const ambiguous = refusalFor(dupReply, dupId);

      expect(ambiguous).toContain('1つに決まらない');
      expect(ambiguous).toContain('2 箇所');
      expect(ambiguous).not.toContain('古い');
      expect(ambiguous).not.toContain('打ち間違い');
      expect(dupReply).toContain('0 件開いた');
    });

    it('⭐ 1つが読めなくても、読めた節は返る（全部を断らない）', async () => {
      const h = harness();
      await seed(h);
      const idA = await sectionId(h, 'about-me', '## 節A');
      const idB = await sectionId(h, 'about-me', '## 節B');

      const reply = await h.call('memory_section_read', {
        slug: 'about-me',
        sections: [idB, 'deadbeef-cafebabe', idA],
      });

      expect(reply).toContain(`${MARK}-A`);
      expect(reply).toContain(`${MARK}-B`);
      expect(reply).toContain('2 件開いた');
      expect(refusalFor(reply, 'deadbeef-cafebabe')).toContain('この文書に無い');
    });

    it('存在しない slug には、そう返す（黙って空の結果を返さない）', async () => {
      const h = harness();

      const reply = await h.call('memory_section_read', {
        slug: 'nope',
        sections: ['deadbeef-cafebabe'],
      });

      expect(reply).toContain('存在しない');
      expect(reply).not.toContain('0 件開いた');
    });

    it('⭐ 何も書き換えない（呼び出しの前後で本文が1バイトも変わらない）', async () => {
      const h = harness();
      await seed(h);
      const idA = await sectionId(h, 'about-me', '## 節A');
      const before = (await h.stores.persona.read('about-me'))?.content as string;

      const writeSpy = vi.spyOn(h.stores.persona, 'write');
      const appendSpy = vi.spyOn(h.stores.persona, 'append');
      const removeSpy = vi.spyOn(h.stores.persona, 'remove');

      await h.call('memory_section_read', { slug: 'about-me', sections: [idA] });
      await h.call('memory_section_read', {
        slug: 'about-me',
        sections: ['deadbeef-cafebabe'],
      });

      expect((await h.stores.persona.read('about-me'))?.content).toBe(before);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(appendSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  describe('ToolContext.memoryCause は必須（配線を忘れた口が守りを素通りしない）', () => {
    const wiringForgotten = () =>
      ({ stores: createMemoryStores(), emit: () => undefined }) as unknown as ToolContext;

    it('⭐ 型の抜け道から memoryCause を省いて渡すと、既定へ倒さずに落ちる', () => {
      expect(() => createCloneTools(wiringForgotten())).toThrow();
    });

    it('落ちるときのメッセージが、何を配線し忘れたかを名指しする', () => {
      expect(() => createCloneTools(wiringForgotten())).toThrow(/memoryCause/);
      expect(() => createCloneTools(wiringForgotten())).toThrow(/ToolContext/);
    });

    it('⭐ 型の側: memoryCause を省いた ToolContext は、そもそも型として組めない', () => {
      const wontTypeCheck = () =>
        // @ts-expect-error memoryCause は必須。省いた形は型として組めない。
        createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
      expect(typeof wontTypeCheck).toBe('function');
    });

    it('対照: memoryCause を明示すれば、従来どおり道具が組める', () => {
      const tools = createCloneTools({
        stores: createMemoryStores(),
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('ToolContext.conversationId は必須（配線を忘れた口が守りを素通りしない）', () => {
    const wiringForgotten = () =>
      ({
        stores: createMemoryStores(),
        emit: () => undefined,
        memoryCause: () => 'clone',
      }) as unknown as ToolContext;

    it('⭐ 型の抜け道から conversationId を省いて渡すと、既定へ倒さずに落ちる', () => {
      expect(() => createCloneTools(wiringForgotten())).toThrow();
    });

    it('落ちるときのメッセージが、何を配線し忘れたかを名指しする', () => {
      expect(() => createCloneTools(wiringForgotten())).toThrow(/conversationId/);
      expect(() => createCloneTools(wiringForgotten())).toThrow(/ToolContext/);
    });

    it('⭐ 型の側: conversationId を省いた ToolContext は、そもそも型として組めない', () => {
      const wontTypeCheck = () =>
        // @ts-expect-error conversationId は必須。省いた形は型として組めない。
        createCloneTools({
          stores: createMemoryStores(),
          emit: () => undefined,
          memoryCause: () => 'clone',
        });
      expect(typeof wontTypeCheck).toBe('function');
    });

    it('対照: conversationId を明示すれば、従来どおり道具が組める', () => {
      const tools = createCloneTools({
        stores: createMemoryStores(),
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      expect(tools.length).toBeGreaterThan(0);
    });

    it('対照: conversationId が undefined を返しても、能力は削れていない（内部ターン扱い）', async () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const askHuman = tools.find((t) => t.name === 'ask_human');
      expect(askHuman).toBeDefined();
      await askHuman?.handler({ question: '質問' } as never, {});
      const [pending] = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
      expect(pending?.conversationId).toBeUndefined();
    });
  });

  describe('記憶の human guard（人間が書いた記憶を distill が壊せない）', () => {
    async function markHuman(h: Harness, slug: string, content: string): Promise<void> {
      await h.stores.persona.write(slug, content);
      await h.stores.persona.markHumanTouched(slug, new Date().toISOString());
    }

    it('印は降りない — 人間が書いた後にクローンが何度書いても human のまま', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
      expect(await h.stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });

      h.setMemoryCause('clone');
      await writeBased(h, {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた1',
        summary: '1',
      });
      await writeBased(h, {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた2',
        summary: '2',
      });
      await writeBased(h, {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた3',
        summary: '3',
      });

      expect(await h.stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('unknown は守る側 — 履歴が無い文書に対して distill の memory_write が断られる', async () => {
      const h = harness();
      h.setMemoryCause('distill');

      const reply = await writeBased(h, {
        slug: 'fresh-doc',
        content: '# 新規\n\n本文',
        summary: '新規に書く',
      });

      expect(reply).toContain('断った');
      expect(await h.stores.persona.read('fresh-doc')).toBeNull();
    });

    describe('断りの応答が次の手を示す', () => {
      it('unknown を理由に断るときは、その理由（履歴が確認できない）を言う', async () => {
        const h = harness();
        h.setMemoryCause('distill');

        const reply = await writeBased(h, {
          slug: 'fresh-doc',
          content: '# 新規\n\n本文',
          summary: '新規に書く',
        });

        expect(reply).toContain('unknown');
        expect(reply).not.toContain('human）');
        expect(reply).toContain('ask_human');
        expect(reply).toContain('fresh-doc');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect(reply).toContain('memory_append');
      });

      it('human を理由に断るときは、その理由（人間の書き込みの履歴が在る）を言う', async () => {
        const h = harness();
        await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
        h.setMemoryCause('distill');

        const reply = await writeBased(h, {
          slug: 'values',
          content: '# 価値観\n\ndistill が上書き',
          summary: '畳んだ',
        });

        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).not.toContain('履歴が確認できない');
        expect(reply).toContain('ask_human');
        expect(reply).toContain('values');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect((await h.stores.persona.read('values'))?.content).toContain('人間が書いた');
        expect(reply).toContain('memory_append');
      });

      it('memory_delete の断りにも同じ4要素が出る', async () => {
        const h = harness();
        await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_delete', { slug: 'values', summary: '整理' });

        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).toContain('ask_human');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect(reply).toContain('memory_append');
      });
    });

    it('clone の書き込みは通る — 同じ文書に cause: clone で書けば通る（能力を消していない）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('clone');
      const reply = await writeBased(h, {
        slug: 'values',
        content: '# 価値観\n\n会話の中で書き換えた',
        summary: '書き換え',
      });

      expect(reply).toContain('更新した');
      expect((await h.stores.persona.read('values'))?.content).toContain('会話の中で書き換えた');
    });

    it('memory_append は断られない（human 対象・distill でも）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('distill');
      const reply = await h.call('memory_append', {
        slug: 'values',
        content: '- 追記',
        summary: '追記した',
      });

      expect(reply).toContain('追記した');
      expect((await h.stores.persona.read('values'))?.content).toContain('追記');
    });

    it('distill の memory_delete も human 対象なら断られる', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('distill');
      const reply = await h.call('memory_delete', { slug: 'values', summary: '整理' });

      expect(reply).toContain('断った');
      expect(await h.stores.persona.read('values')).not.toBeNull();
    });

    it('clone-only の文書には distill の全文置換・削除が通る（対照 — 検出器が非0を出せること）', async () => {
      const h = harness();
      await writeBased(h, {
        slug: 'notes',
        content: '# ノート\n\n最初の版',
        summary: '1',
      });
      expect(await h.stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

      h.setMemoryCause('distill');
      const reply = await writeBased(h, {
        slug: 'notes',
        content: '# ノート\n\n畳んだ版',
        summary: '畳んだ',
      });

      expect(reply).toContain('更新した');
      expect((await h.stores.persona.read('notes'))?.content).toContain('畳んだ版');
    });

    it('トグルを off にすると断らない（能力を消していない）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
      h.setMemoryCause('distill');

      const before = process.env.ALTEROID_MEMORY_GUARD;
      process.env.ALTEROID_MEMORY_GUARD = 'off';
      try {
        const reply = await writeBased(h, {
          slug: 'values',
          content: '# 価値観\n\ndistill が上書き',
          summary: '畳んだ',
        });
        expect(reply).toContain('更新した');
      } finally {
        if (before === undefined) delete process.env.ALTEROID_MEMORY_GUARD;
        else process.env.ALTEROID_MEMORY_GUARD = before;
      }
    });
  });

  it('journal_write は判断を日誌に残す（聞かずに実行した判断の記録）', async () => {
    const h = harness();

    await h.call('journal_write', {
      decision: '人間に聞かずに設定を変えた',
      grounds: 'about-me.md に「設定変更は任せる」とある',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision', grounds: expect.stringContaining('about-me') });
  });

  it('ask_human は承認待ちに積み、日誌に残し、chat へ通知する（応答は待たない）', async () => {
    const h = harness();

    const reply = await h.call('ask_human', { question: 'これを送ってよいか' });

    const pending = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toBe('これを送ってよいか');

    const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
    expect(escalation).toMatchObject({ type: 'escalation', question: 'これを送ってよいか' });

    expect(h.emitted).toEqual([
      { type: 'ask_human', approvalId: pending[0]?.id, question: 'これを送ってよいか' },
    ]);
    expect(reply).toContain('承認待ちキューに積んだ');
  });

  it('ask_human は manager_id を添えれば、どの仕事が止まっているか辿れる', async () => {
    const h = harness();

    await h.call('ask_human', { question: '本番に出してよいか', managerId: 'mgr-1' });

    const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(pending?.jobId).toBe('mgr-1');
  });

  describe('request_permission（issue #863「許可をコードではなくデータにする」）', () => {
    it('⭐⭐ tools.ts のどのハンドラも stores.permissionGrants に触れない（issue #863 C節、歯で固定）', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
      expect(source).not.toContain('permissionGrants');
    });

    it('request_permission を呼んでも stores.permissionGrants は空のまま（上のソース検査の実行時の裏取り）', async () => {
      const h = harness();
      await h.call('request_permission', {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit'],
        denies: ['gh release edit; rm -rf /'],
        reason: '理由',
      });
      expect(await h.stores.permissionGrants.list()).toEqual([]);
    });

    it('正常な要求は承認待ちに permissionRequest 付きで積み、日誌に残し、chat へ通知する', async () => {
      const h = harness();

      const reply = await h.call('request_permission', {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit --draft', 'gh release edit'],
        denies: ['gh release edit; rm -rf /'],
        reason: 'リリースノートを直すたびに聞かれるのを減らしたい',
      });

      const pending = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      expect(pending).toHaveLength(1);
      expect(pending[0]?.permissionRequest).toEqual({
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit --draft', 'gh release edit'],
        denies: ['gh release edit; rm -rf /'],
      });
      expect(pending[0]?.question).toContain(`「${PERMISSION_GRANT_CONSENT_PHRASE}」とだけ答える`);

      const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
      expect(escalation).toMatchObject({ type: 'escalation', approvalId: pending[0]?.id });

      expect(h.emitted).toEqual([
        { type: 'ask_human', approvalId: pending[0]?.id, question: expect.any(String) },
      ]);
      expect(reply).toContain('承認待ちキューに積んだ');
    });

    it('denies が空なら、キューに積まずに拒否する', async () => {
      const h = harness();

      const reply = await h.call('request_permission', {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit'],
        denies: [],
        reason: '理由',
      });

      expect(reply).toContain('拒否した');
      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    });

    it('allows が規則に一致しない例を含むなら、キューに積まずに拒否する', async () => {
      const h = harness();

      const reply = await h.call('request_permission', {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh issue edit'],
        denies: ['gh release edit; rm -rf /'],
        reason: '理由',
      });

      expect(reply).toContain('拒否した');
      expect(reply).toContain('gh issue edit');
      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    });

    it('denies が規則に一致してしまう例を含むなら、キューに積まずに拒否する', async () => {
      const h = harness();

      const reply = await h.call('request_permission', {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit'],
        denies: ['gh release edit --draft'],
        reason: '理由',
      });

      expect(reply).toContain('拒否した');
      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    });

    it('規則の書式が不正なら、キューに積まずに拒否する', async () => {
      const h = harness();

      const reply = await h.call('request_permission', {
        rule: 'gh release edit',
        allows: ['gh release edit'],
        denies: ['rm -rf /'],
        reason: '理由',
      });

      expect(reply).toContain('拒否した');
      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    });

    describe('直前の拒否の証拠（issue #1802）', () => {
      const FAKE_SECRET = 'ghp_FAKE1234FAKE5678FAKE9012';
      const request = {
        rule: 'Bash(gh release edit --repo x/y --draft=false:*)',
        allows: ['gh release edit --repo x/y --draft=false v1'],
        denies: ['gh release delete v1'],
        reason: '公開したい',
      };
      async function pendingQuestion(h: Harness): Promise<string> {
        await h.call('request_permission', request);
        const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
        return pending?.question ?? '';
      }

      it('同じ道具・同じ先頭の語の拒否があれば、理由の原文・時刻・先頭の語が載り、コマンドの値は載らない', async () => {
        const h = harness();
        h.recentDenials.push({
          at: '2026-09-27T10:00:00.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reasonType: '[CI Bypass]',
          reason: 'Blocked by classifier',
          message: `Permission for this action was denied (${'x'.repeat(3)})`,
        });
        const question = await pendingQuestion(h);
        expect(question).toContain('直前の拒否（器が返した原文。クローンの要約ではない');
        expect(question).toContain('時刻 2026-09-27T10:00:00.000Z');
        expect(question).toContain('先頭の語 gh');
        expect(question).toContain('分類 [CI Bypass]');
        expect(question).toContain('理由 Blocked by classifier');
        expect(question).not.toContain(FAKE_SECRET);
      });

      it('先頭の語が違う拒否しか無ければ、照合できる拒否が無いと明記する（黙って省かない）', async () => {
        const h = harness();
        h.recentDenials.push({
          at: '2026-09-27T10:00:00.000Z',
          tool: 'Bash',
          headWord: 'curl',
          reason: 'x',
        });
        const question = await pendingQuestion(h);
        expect(question).toContain(
          'この規則と照合できる直前の拒否（Bash / 先頭の語 gh）は、このセッションの記録に無い',
        );
      });

      it('同じ先頭の語の拒否が2件あれば、新しいほうが載る', async () => {
        const h = harness();
        h.recentDenials.push({
          at: '2026-09-27T10:00:00.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reason: '古い理由',
        });
        h.recentDenials.push({
          at: '2026-09-27T11:00:00.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reason: '新しい理由',
        });
        const question = await pendingQuestion(h);
        expect(question).toContain('理由 新しい理由');
        expect(question).not.toContain('古い理由');
      });

      it('読む口が渡されていない層では、照合していないことを明記する', async () => {
        const { describePermissionEvidence } = await import('./tools.js');
        expect(describePermissionEvidence(request.rule, undefined)).toBe(
          '直前の拒否: この層は拒否の記録を読む口を持たない（照合していない）。',
        );
      });
    });
  });

  it('approvals_list で、人間の回答待ちを自分で見られる（溜まった保留の運用）', async () => {
    const h = harness();
    expect(await h.call('approvals_list', {})).toContain('回答待ちは無い');

    await h.call('ask_human', {
      question: '本番に出してよいか',
      managerId: 'mgr-1',
      requestId: 'req-9',
    });
    await h.stores.jobs.putApproval({
      id: 'ap-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '済んだ質問',
      answeredAt: '2026-01-01T01:00:00.000Z',
      answer: 'よい',
    });

    const reply = await h.call('approvals_list', {});
    expect(reply).toContain('本番に出してよいか');
    expect(reply).toContain('req-9');
    expect(reply).not.toContain('済んだ質問');
  });

  describe('ask_human の questions（選択肢つきの設問。issue #2525）', () => {
    const questions = [
      {
        id: 'target',
        prompt: 'デプロイ先',
        options: [
          { id: 'railway', label: 'Railway', recommended: true, description: '既存の基盤' },
          { id: 'fly', label: 'Fly.io' },
        ],
      },
      {
        id: 'notify',
        prompt: '通知先',
        multiple: true,
        allowOther: false,
        options: [
          { id: 'slack', label: 'Slack' },
          { id: 'mail', label: 'メール' },
        ],
      },
    ];

    it('questions を承認待ちへ積む。question は必須のまま、無ければ questions の欄も付かない', async () => {
      const h = harness();
      await h.call('ask_human', { question: '決めたい', questions });
      await h.call('ask_human', { question: '自由文だけ' });
      const entries = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      expect(entries.find((e) => e.question === '決めたい')?.questions).toEqual(questions);
      expect(entries.find((e) => e.question === '自由文だけ')).not.toHaveProperty('questions');
    });

    it('設問 id の重複・設問の中の選択肢 id の重複は、何も積まずに断る', async () => {
      const h = harness();
      const dupQuestion = await h.call('ask_human', {
        question: '決めたい',
        questions: [questions[0], { ...questions[1], id: 'target' }],
      });
      expect(dupQuestion).toContain('重複');
      const dupOption = await h.call('ask_human', {
        question: '決めたい',
        questions: [
          {
            id: 'q',
            prompt: 'p',
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      });
      expect(dupOption).toContain('重複');
      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toEqual([]);
    });

    it('request_permission の承認待ちには questions を付けない', async () => {
      const h = harness();
      await h.call('request_permission', {
        rule: 'Bash(ls:*)',
        allows: ['ls -la'],
        denies: ['rm -rf /'],
        reason: '一覧を見たい',
      });
      const entries = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toHaveProperty('questions');
    });

    it('一覧は件数だけ（設問の本文を出さない）、id で開くと設問と選択肢が全部読める', async () => {
      const h = harness();
      await h.call('ask_human', { question: '決めたい', questions });
      const list = await h.call('approvals_list', {});
      expect(list).toContain('設問 2 件');
      expect(list).not.toContain('Railway');

      const [approval] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const detail = await h.call('approvals_list', { id: approval?.id });
      expect(detail).toContain('[id=target] デプロイ先（単一選択・その他を書ける）');
      expect(detail).toContain('Railway［推奨］ — 既存の基盤');
      expect(detail).toContain('[id=notify] 通知先（複数選択可・その他は書けない）');
    });

    it('道具の説明に questions の書き方・例・(a)(b)(c) より questions を使うこと、が書いてある', () => {
      const tools = createCloneTools({
        stores: createMemoryStores(),
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((t) => t.name === 'ask_human')?.description ?? '';
      expect(description).toContain('questions');
      expect(description).toContain('(a)(b)(c)');
      expect(description).toContain('recommended');
      expect(description).toContain('multiple');
      expect(description).toContain('allowOther');
      expect(description).toContain('例:');
    });
  });

  describe('読めない承認の行（#2279）: 「無い（id が違う）」と言わず、在るが読めないと言う', () => {
    function unreadableHarness() {
      const h = harness();
      const originalUpdate = h.stores.jobs.updateApproval.bind(h.stores.jobs);
      h.stores.jobs.getApproval = async (id) => {
        if (id === 'ap-bad') throw new UnreadableApprovalError({ id });
        return null;
      };
      h.stores.jobs.updateApproval = async (id, mutate) => {
        if (id === 'ap-bad') throw new UnreadableApprovalError({ id });
        return originalUpdate(id, mutate);
      };
      return h;
    }

    it('approval_withdraw は「無い（id が違う）」と言わず、在るが読めないと言う。何も書かない', async () => {
      const h = unreadableHarness();
      const reply = await h.call('approval_withdraw', { id: 'ap-bad', reason: '理由' });
      expect(reply).toContain('承認待ち ap-bad は在るが読めない');
      expect(reply).not.toContain('id が違う');
      expect(await h.stores.journal.list({ types: ['escalation'] })).toHaveLength(0);
    });

    it('approval_withdraw: getApproval の後に行が読めなくなっても（updateApproval が投げても）同じ', async () => {
      const h = harness();
      await h.call('ask_human', { question: '質問' });
      const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const id = pending?.id as string;
      h.stores.jobs.updateApproval = async () => {
        throw new UnreadableApprovalError({ id });
      };
      const reply = await h.call('approval_withdraw', { id, reason: '理由' });
      expect(reply).toContain(`承認待ち ${id} は在るが読めない`);
      expect(reply).not.toContain('取り下げた。');
      expect(reply).not.toContain('id が違う');
    });

    it('approvals_list id=... と approval_trace も「無い」と言わない', async () => {
      const h = unreadableHarness();
      const full = await h.call('approvals_list', { id: 'ap-bad' });
      expect(full).toContain('承認待ち ap-bad は在るが読めない');
      expect(full).not.toContain('id が違う');
      const trace = await h.call('approval_trace', { id: 'ap-bad' });
      expect(trace).toContain('承認待ち ap-bad は在るが読めない');
      expect(trace).not.toContain('id が違う');
    });

    it('本当に無い id は従来どおり「無い（id が違う）」', async () => {
      const h = unreadableHarness();
      expect(await h.call('approval_withdraw', { id: 'ap-nowhere', reason: '理由' })).toContain(
        'id が違う',
      );
    });
  });

  describe('読めない承認の行が在る一覧（#2298）: 一覧から消さず、件数と id で言う', () => {
    function listWithUnreadable(unreadable: { id?: string; reason: string }[]) {
      const h = harness();
      const original = h.stores.jobs.listApprovals.bind(h.stores.jobs);
      h.stores.jobs.listApprovals = async (options) => ({
        ...(await original(options)),
        unreadable,
      });
      return h;
    }

    it('読めた行は今までどおり並べ、末尾に「読めない承認待ちが N 件ある」を id つきで出す', async () => {
      const h = listWithUnreadable([
        { id: 'ap-bad-1', reason: '不正な欄: createdAt' },
        { reason: '不正な欄: (root)' },
      ]);
      await h.call('ask_human', { question: '本番に出してよいか' });
      const reply = await h.call('approvals_list', {});
      expect(reply).toContain('本番に出してよいか');
      expect(reply).toContain('読めない承認待ちが 2 件ある');
      expect(reply).toContain('ap-bad-1');
      expect(reply).toContain('id が取れない行が 1 件');
      expect(reply).toContain('回答済み・取り下げ済みではない');
    });

    it('読めた行が0件でも「回答待ちは無い」とだけ言わない', async () => {
      const h = listWithUnreadable([{ id: 'ap-bad-1', reason: '不正な欄: createdAt' }]);
      const reply = await h.call('approvals_list', {});
      expect(reply).toContain('読めない承認待ちが 1 件ある');
      expect(reply).toContain('ap-bad-1');
      expect(reply).not.toContain('（人間の回答待ちは無い）');
    });

    it('0件のときは何も出さない（0 の行を作らない）', async () => {
      const h = listWithUnreadable([]);
      await h.call('ask_human', { question: '本番に出してよいか' });
      expect(await h.call('approvals_list', {})).not.toContain('読めない');
      const empty = listWithUnreadable([]);
      expect(await empty.call('approvals_list', {})).toBe('（人間の回答待ちは無い）');
    });
  });

  describe('approval_withdraw（issue #963）', () => {
    it('未回答の承認待ちを理由付きで取り下げ、一覧から消え、id で理由ごと読み戻せる', async () => {
      const h = harness();
      await h.call('ask_human', { question: '本番に出してよいか' });
      const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const id = pending?.id;
      expect(id).toBeDefined();

      const reply = await h.call('approval_withdraw', {
        id,
        reason: '自分で答えを見つけた',
      });
      expect(reply).toContain('取り下げた');

      expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
      expect(await h.call('approvals_list', {})).toContain('回答待ちは無い');

      const full = await h.call('approvals_list', { id });
      expect(full).toContain('取り下げ');
      expect(full).toContain('自分で答えを見つけた');

      const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
      expect(escalation).toMatchObject({
        type: 'escalation',
        approvalId: id,
        withdrawnReason: '自分で答えを見つけた',
      });
      expect((escalation as { withdrawnAt?: string }).withdrawnAt).toBeDefined();
    });

    it('id が無ければ断る', async () => {
      const h = harness();
      const reply = await h.call('approval_withdraw', { id: 'no-such-id', reason: '理由' });
      expect(reply).toContain('無い');
    });

    it('回答済みの件は取り下げられない', async () => {
      const h = harness();
      await h.stores.jobs.putApproval({
        id: 'ap-answered',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: '済んだ質問',
        answeredAt: '2026-01-01T01:00:00.000Z',
        answer: 'よい',
      });

      const reply = await h.call('approval_withdraw', { id: 'ap-answered', reason: '理由' });
      expect(reply).toContain('回答済み');
      expect(reply).not.toContain('取り下げた。');

      const after = await h.stores.jobs.getApproval('ap-answered');
      expect(after?.withdrawnAt).toBeUndefined();
    });

    it('取り下げが読んでから書くまでの間に回答が入ったら、取り下げは断られ、回答が残る', async () => {
      const h = harness();
      await h.stores.jobs.putApproval({
        id: 'ap-race',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: '同時に答えられる質問',
      });
      const original = h.stores.jobs.getApproval.bind(h.stores.jobs);
      let interleaved = false;
      h.stores.jobs.getApproval = async (id) => {
        const snapshot = await original(id);
        if (!interleaved && snapshot !== null && id === 'ap-race') {
          interleaved = true;
          await h.stores.jobs.putApproval({
            ...snapshot,
            answeredAt: '2026-01-01T01:00:00.000Z',
            answer: '同時に届いた回答',
          });
        }
        return snapshot;
      };

      const reply = await h.call('approval_withdraw', { id: 'ap-race', reason: '理由' });

      expect(interleaved).toBe(true);
      expect(reply).toContain('回答済み');
      expect(reply).not.toContain('取り下げた。');
      const after = await original('ap-race');
      expect(after?.answer).toBe('同時に届いた回答');
      expect(after?.withdrawnAt).toBeUndefined();
    });

    it('既に取り下げ済みの件を二重に取り下げようとしても断る（新しい行を積まない）', async () => {
      const h = harness();
      await h.call('ask_human', { question: '質問' });
      const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const id = pending?.id as string;

      await h.call('approval_withdraw', { id, reason: '最初の理由' });
      const reply = await h.call('approval_withdraw', { id, reason: '二度目の理由' });
      expect(reply).toContain('取り下げ済み');

      const after = await h.stores.jobs.getApproval(id);
      expect(after?.withdrawnReason).toBe('最初の理由');
    });

    it('jobId/requestId 付きの件を取り下げても、マネージャーは自動では解放されない（応答が manager_send を促す）', async () => {
      const h = harness();
      await h.call('ask_human', {
        question: '本番に出してよいか',
        managerId: 'mgr-1',
        requestId: 'req-9',
      });
      const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const id = pending?.id as string;

      const reply = await h.call('approval_withdraw', { id, reason: '前提が消えた' });
      expect(reply).toContain('取り下げた');
      expect(reply).toContain('mgr-1');
      expect(reply).toContain('req-9');
      expect(reply).toContain('manager_send');
    });

    it('jobId が無い件を取り下げても、マネージャー宛の案内は出ない', async () => {
      const h = harness();
      await h.call('ask_human', { question: '質問' });
      const [pending] = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
      const id = pending?.id as string;

      const reply = await h.call('approval_withdraw', { id, reason: '理由' });
      expect(reply).not.toContain('マネージャー');
      expect(reply).not.toContain('manager_send');
    });

    it('ask_human の説明文が取り下げられることに触れる', () => {
      const tools = createCloneTools({
        stores: createMemoryStores(),
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((t) => t.name === 'ask_human')?.description ?? '';
      expect(description).toContain('approval_withdraw');
    });
  });

  it('daily_report_write は指定された日付で日報を残す', async () => {
    const h = harness();

    await h.call('daily_report_write', { date: '2026-08-11', body: '# 日報\n\n直した' });

    const [entry] = await h.stores.journal.list({ types: ['daily_report'] });
    expect(entry).toMatchObject({ type: 'daily_report', date: '2026-08-11' });
  });

  it('日付が無い・壊れている・存在しない日なら今日として残す（読めない日報を作らない）', async () => {
    const h = harness();
    const today = new Date();
    const expected = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;

    await h.call('daily_report_write', { body: '本文' });
    await h.call('daily_report_write', { date: 'きのう', body: '本文' });
    await h.call('daily_report_write', { date: '2026-02-31', body: '本文' });

    const entries = (await h.stores.journal.list({ types: ['daily_report'] })) as {
      date: string;
    }[];
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry.date).toBe(expected);
  });

  it('self_read は正典を全文返す（クローンが自分の要件を読める）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'north_star' });

    expect(body).toContain('docs/north_star.md');
    expect(body).toContain('デグレード禁止');
    expect(body).toContain('追加制限禁止');
  });

  it('self_read は無い名前に、読める名前を添えて答える（黙って空を返さない）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'agents' });

    expect(body).toContain('north_star');
    expect(body).toContain('architecture');
  });

  it('self_read は委譲できない場面でも使える', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'self_read');

    const result = await found?.handler({ document: 'architecture' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('docs/architecture.md');
  });

  it('manager_start は起こして即返り、委譲の判断が日誌に残る', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'ログイン周りを直して',
      cwd: '/work/x',
    });

    expect(h.started).toEqual([{ request: 'ログイン周りを直して', cwd: '/work/x' }]);
    expect(reply).toContain('mgr-1');

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ decision: expect.stringContaining('mgr-1') });
  });

  it('manager_start は ToolContext.conversationId() の値を自動で ManagerPool.start へ渡す', async () => {
    const h = harness();
    h.setConversationId('conv-9');

    await h.call('manager_start', { request: '会話の続きで頼む' });

    expect(h.started).toEqual([{ request: '会話の続きで頼む', conversationId: 'conv-9' }]);
  });

  it('会話に紐づかないターン（内部ターン）では conversationId を渡さない（既定）', async () => {
    const h = harness();

    await h.call('manager_start', { request: '内部ターンから' });

    expect(h.started).toEqual([{ request: '内部ターンから' }]);
    expect(h.started[0]).not.toHaveProperty('conversationId');
  });

  it('manager_start に runnerId を渡すと、そのまま ManagerPool.start へ指名として届く', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'この器で頼む',
      runnerId: 'runner-b',
    });

    expect(h.started).toEqual([{ request: 'この器で頼む', runnerId: 'runner-b' }]);
    expect(reply).toContain('runner-b');
  });

  it('manager_start は runnerId を指名しなくても、実際に走った runner を返す', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-auto-placed');

    const reply = await h.call('manager_start', { request: '自動配置に任せる' });

    expect(reply).toContain('runner-auto-placed');
  });

  it('置き先が pids 飽和と判定されていれば、断らずに起こし、材料つきの行を付ける（#2626）', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-burning');
    h.setPidsSaturation('runner-burning', {
      basis: [{ kind: 'eagain', count: 2 }],
      windowMs: 5 * 60_000,
    });

    const reply = await h.call('manager_start', { request: '飽和した器でも断らない' });

    expect(reply).toContain('マネージャー');
    expect(reply).toContain('pids 飽和');
    expect(reply).toContain('EAGAIN で失敗 2 回');
  });

  it('飽和の材料が無い置き先には、飽和の行を出さない（「飽和ではない」とも言わない）（#2626）', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-fine');

    const reply = await h.call('manager_start', { request: '普通の器' });

    expect(reply).not.toContain('飽和');
  });

  it('runnerId が取れないときは空欄にせず「未記録」と言う', async () => {
    const h = harness();
    h.setAutoRunnerId(undefined);

    const reply = await h.call('manager_start', { request: '記録が無い場合' });

    expect(reply).toContain('未記録');
  });

  it('manager_send の delivered は、保証の範囲と「同じ本文で立て直さない」を言う', async () => {
    const h = harness();
    h.setSendResult({ outcome: 'delivered', detail: '追加指示として届けた。' });

    const reply = await h.call('manager_send', { managerId: 'mgr-1', message: '続けて' });

    expect(reply).toContain('追加指示として届けた。');
    expect(reply).toContain('「読んで動いた」ではない');
    expect(reply).toContain('読んだかは1度も見ていない');
    expect(reply).toContain('「届かなかった」の証拠にはならない');
    expect(reply).toContain('同じ本文で新しい委譲を立てないこと');
    expect(reply).toContain('manager_report');
    expect(reply).not.toContain('届かない');
  });

  it('manager_send は decision と requestId を添えて、宛先を指して答えられる', async () => {
    const h = harness();

    await h.call('manager_send', {
      managerId: 'mgr-1',
      message: 'よい',
      decision: 'allow',
      requestId: 'req-9',
    });

    expect(h.sent).toEqual([
      { managerId: 'mgr-1', message: 'よい', decision: 'allow', requestId: 'req-9' },
    ]);
  });

  it('manager_stop は人間と同じ口で止め、止まったことを確かめてから返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '暴走した',
      force: true,
    });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '暴走した' }]);
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('stopped');
  });

  function withoutRunnerDetail(h: Harness, reply: string): string {
    const transcribed = h.abortDetails.at(-1);
    if (transcribed === undefined)
      throw new Error('テストダブルが detail を1度も返していない（歯の前提が崩れている）');
    expect(
      reply,
      '実装が runner の detail を応答へ転記しなくなった。' +
        'この赤は「歯の欠陥」ではなく「差し引きが空振りするようになった」を意味する —— ' +
        'この歯は転記分を引いた残りを測るので、転記が無くなると測る対象がずれる。',
    ).toContain(transcribed);
    return reply.split(transcribed).join('');
  }

  it('manager_stop は not_stopped のとき「止めた」と言わない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('not_stopped');

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '暴走した',
      force: true,
    });

    expect(
      withoutRunnerDetail(h, reply),
      '実装が自分の言葉で「止まっていない」と言っていない（runner の detail を' +
        '転記しただけになっている）。この赤は「止まらなかったことが、実装の断定として' +
        '出力に残らなくなった」を意味する。',
    ).toContain('止まっていない');
    expect(reply, '止まっていないのに「止めた」と言い切っている').not.toContain('止めた');
    expect(reply).toContain('running');
  });

  it('manager_stop は unknown のとき「止めた」とも「止まっていない」とも言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('unknown');

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '暴走した',
      force: true,
    });

    expect(
      withoutRunnerDetail(h, reply),
      '実装が自分の言葉で「未確認」と言っていない（runner の detail を転記した' +
        'だけになっている）。この赤は「確かめられなかったことが、実装の断定として' +
        '出力に残らなくなった」を意味する。',
    ).toContain('未確認');
    expect(reply, '確かめられていないのに「止めた」と言い切っている').not.toContain('止めた');
    expect(reply, '確かめられていないのに「止まっていない」と言い切っている').not.toContain(
      '止まっていない',
    );
  });

  it('manager_stop は absent のとき居ないと言う', async () => {
    const h = harness();

    const reply = await h.call('manager_stop', { managerId: 'mgr-nope' });

    expect(reply).toContain('居ない');
  });

  it('manager_stop は running を force 無しで止めようとすると断り、abort を呼ばない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '429 の再試行' });

    expect(h.aborted).toEqual([]);
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('running');
    expect(reply, '断りの本文に force という逃げ道が案内されていない').toContain('force');
    expect(reply, '止まっていないのに「止めた」と言い切っている').not.toContain('止めた。');
  });

  it('manager_stop の running 断りは、見つかった作業ツリーを全部出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', {
      kind: 'ok',
      result: {
        cwd: '/workspace',
        worktrees: [
          {
            relativePath: 'mgr-1/repo',
            branch: 'main',
            unpushedCommitCount: 4,
            uncommittedChangeCount: 0,
          },
          {
            relativePath: 'mgr-1/wt-a',
            branch: 'feat/x',
            unpushedCommitCount: 0,
            uncommittedChangeCount: 2,
          },
        ],
      },
    });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('mgr-1/repo');
    expect(reply).toContain('mgr-1/wt-a');
    expect(reply).toContain('4');
    expect(reply).toContain('feat/x');
    expect(h.aborted).toEqual([]);
  });

  it('manager_stop は unpushedWork が失敗しても断りを返し、確かめられなかったと名乗る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWorkThrows('mgr-1', 'runner が応答しなかった（模擬）');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply, '止める道（force の案内）が塞がっている').toContain('force');
    expect(reply, '止めていない、という断りの本題が消えている').toContain('止めていない');
    expect(reply).toContain('確かめられなかった');
    expect(reply, '失敗を0件と混ぜている').not.toMatch(/未 push.*0本/);
    expect(h.aborted, '調べものの失敗で abort が呼ばれてしまっている').toEqual([]);
  });

  it('manager_stop は unpushedWork が「確かめられなかった」を返しても断りを返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', { kind: 'unavailable', reason: 'この runner はこの口を持たない' });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('確かめられなかった');
    expect(reply).toContain('この runner はこの口を持たない');
    expect(reply).toContain('force');
  });

  it('manager_stop の running 断りは、作業ツリー0本で失敗も無いとき「未 push」「CI」を足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', { kind: 'ok', result: { cwd: '/workspace', worktrees: [] } });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('止めていない');
    expect(reply).toContain('そのターンの進行中の作業が失われる');
    expect(reply).toContain('起こした作業者');
    expect(reply).toContain('force: true');
    expect(reply).not.toContain('監視中の CI');
    expect(reply).not.toContain('未 push の実装・起こした作業者');
    expect(reply).not.toContain('作業ツリーが見つからなかった');
    expect(h.aborted).toEqual([]);
  });

  it('manager_stop の running 断りは、作業ツリーが1本以上・探索の失敗・読み残しのとき「未 push」「CI」を足す', async () => {
    const cases: {
      name: string;
      probe: Parameters<ReturnType<typeof harness>['setUnpushedWork']>[1];
    }[] = [
      {
        name: '1本以上',
        probe: {
          kind: 'ok',
          result: {
            cwd: '/workspace',
            worktrees: [
              {
                relativePath: 'mgr-1/repo',
                branch: 'main',
                unpushedCommitCount: 1,
                uncommittedChangeCount: 0,
              },
            ],
          },
        },
      },
      { name: '探索の失敗', probe: { kind: 'unavailable', reason: '模擬' } },
      {
        name: '0本でも読み残し',
        probe: {
          kind: 'ok',
          result: {
            cwd: '/workspace',
            worktrees: [],
            scratchRootsUnknown: '確かめられなかった（EACCES）',
          },
        },
      },
    ];
    for (const c of cases) {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setUnpushedWork('mgr-1', c.probe);
      const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });
      expect(reply, c.name).toContain('そのターンの進行中の作業が失われる');
      expect(reply, c.name).toContain('未 push の実装・起こした作業者・監視中の CI');
      expect(h.aborted, c.name).toEqual([]);
    }
  });

  it('manager_stop の running 断りは scratchRootsUnknown を、打ち切りと同じ強さで注記する', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', {
      kind: 'ok',
      result: {
        cwd: '/workspace',
        worktrees: [
          {
            relativePath: 'mgr-1/repo',
            branch: 'main',
            unpushedCommitCount: 0,
            uncommittedChangeCount: 0,
          },
        ],
        scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった: EACCES）',
      },
    });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('mgr-1/repo');
    expect(reply).toContain('/tmp');
    expect(reply).toContain('確かめられなかった（/tmp を読めなかった: EACCES）');
  });

  it('manager_stop の running 断りは、作業ツリー0本でも scratchRootsUnknown を握り潰さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', {
      kind: 'ok',
      result: {
        cwd: '/workspace',
        worktrees: [],
        scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった: EACCES）',
      },
    });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('確かめられなかった（/tmp を読めなかった: EACCES）');
    expect(reply, '確認できていないのに断定していないか').not.toContain('の下を探索した）。');
  });

  it('manager_stop の running 断りは unreadableDirCount を、打ち切りと同じ強さで注記する', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', {
      kind: 'ok',
      result: {
        cwd: '/workspace',
        worktrees: [
          {
            relativePath: 'mgr-1/repo',
            branch: 'main',
            unpushedCommitCount: 0,
            uncommittedChangeCount: 0,
          },
        ],
        unreadableDirCount: 2,
        unreadableDirSample: '/workspace/mgr-1/locked: EACCES',
      },
    });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('mgr-1/repo');
    expect(reply).toContain('2');
    expect(reply).toContain('子ディレクトリ');
  });

  it.each([
    [
      '作業ツリーあり',
      [
        {
          relativePath: 'mgr-1/repo',
          branch: 'main',
          unpushedCommitCount: 0,
          uncommittedChangeCount: 0,
        },
      ],
    ],
    ['作業ツリー0本', []],
  ])(
    'manager_stop の running 断りは、unreadableDirCount がスクラッチ起点の読み失敗も含むと名乗る（%s）',
    async (_label, worktrees) => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setUnpushedWork('mgr-1', {
        kind: 'ok',
        result: {
          cwd: '/workspace',
          worktrees,
          unreadableDirCount: 1,
          unreadableDirSample: '/tmp/mgr-2: EACCES',
        },
      });

      const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

      expect(reply).toContain('/tmp スクラッチの起点そのものの読み失敗を含む');
    },
  );

  it('manager_stop の running 断りは、作業ツリー0本でも unreadableDirCount を握り潰さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setUnpushedWork('mgr-1', {
      kind: 'ok',
      result: {
        cwd: '/workspace',
        worktrees: [],
        unreadableDirCount: 4,
      },
    });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('4');
    expect(reply).toContain('子ディレクトリ');
    expect(reply, '確認できていないのに断定していないか').not.toContain('の下を探索した）。');
  });

  it('manager_stop は force: true のとき unpushedWork を呼ばない（往復を払わない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認', force: true });

    expect(h.unpushedWorkCalls).toEqual([]);
  });

  it('manager_list は unpushedWork を呼ばない（一覧の側から自動で往復を足さない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    await h.call('manager_list', {});

    expect(h.unpushedWorkCalls).toEqual([]);
  });

  it('manager_stop は running でも force: true なら止める', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '429 の再試行',
      force: true,
    });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '429 の再試行' }]);
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('stopped');
  });

  it('manager_stop は止める前に一覧を読めなかったら、force 無しでは abort を呼ばずに断る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setListFailures([1], 'ledger 応答なし（模擬）');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(h.aborted).toEqual([]);
    expect(reply).toContain('止めていない');
    expect(reply).toContain('読めなかった');
    expect(reply).toContain('判定できない');
    expect(reply, '原因（エラーの要約）が添えられていない').toContain('ledger 応答なし（模擬）');
    expect(reply, '次の手（manager_list で確かめる）が無い').toContain('manager_list');
    expect(reply, '次の手（force: true で呼び直す）が無い').toContain('force: true');
    expect(reply, '読めなかっただけなのに「居ない」と言っている').not.toContain('居ない');
  });

  it('manager_stop は止める前に一覧を読めなかった原因の、2行目以降の値を応答へ出さない（#2468）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setListFailures([1], 'Failed query: select 1\nparams: FAKE_SECRET_VALUE_2468');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '確認' });

    expect(reply).toContain('読めなかった原因: Error: Failed query: select 1\n');
    expect(reply).not.toContain('FAKE_SECRET_VALUE_2468');
  });

  it('manager_stop は止める前に一覧を読めなくても、force: true なら止めに進む', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setListFailures([1], 'ledger 応答なし（模擬）');

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '暴走した',
      force: true,
    });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '暴走した' }]);
    expect(reply).toContain('stopped');
  });

  it('manager_stop は止めた後の一覧だけ読めなかったとき、「消えている」と書かず「読めなかった」と書く', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setListFailures([2], 'ledger 応答なし（模擬）');

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '暴走した',
      force: true,
    });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '暴走した' }]);
    expect(reply).toContain('止めた後の状態を一覧から読めなかった');
    expect(reply, '読めなかっただけなのに一覧から消えたと言っている').not.toContain('消えている');
  });

  it('manager_stop は abort が absent で、止める前も読めなかったとき、「居ない」と言い切らない', async () => {
    const h = harness();
    h.setListFailures([1], 'ledger 応答なし（模擬）');

    const reply = await h.call('manager_stop', { managerId: 'mgr-nope', force: true });

    const own = h.abortDetails.reduce((rest, detail) => rest.replace(detail, ''), reply);
    expect(own).toContain('読めなかった');
    expect(own, '読めなかっただけなのに「居ない」と言い切っている').not.toContain('居ない');
    expect(own, '読めなかっただけなのに「台帳からも消えている」と言っている').not.toContain(
      '消えている',
    );
  });

  it('manager_stop は done なら force 無しでも従来どおり止まる', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'done';

    const reply = await h.call('manager_stop', { managerId: 'mgr-1' });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1' }]);
    expect(reply).toContain('待機中（done）');
  });

  it('manager_stop は waiting_human なら force 無しでも止まる（ガードの対象は running だけ）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'waiting_human';

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '依頼が要らなくなった',
    });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '依頼が要らなくなった' }]);
    expect(reply, 'running 用の断りが waiting_human まで巻き込んでいる').not.toContain(
      '止めていない',
    );
  });

  it('manager_stop は畳んだ本文が届いていれば抜粋を出す（Issue #1038）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastFoldedTurn = {
      text: 'push 完了。PR #313 を出した。',
      at: '2026-09-16T00:10:00.000Z',
    };

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '429 の再試行',
      force: true,
    });

    expect(reply).toContain('push 完了。PR #313 を出した。');
    expect(reply).toContain('2026-09-16T00:10:00.000Z');
    expect(reply, '全文の在り処（manager_report）を案内すること').toContain('manager_report');
  });

  it('manager_stop は畳んだ本文がまだ届いていなければ manager_report への案内を出す（Issue #1038）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', {
      managerId: 'mgr-1',
      reason: '429 の再試行',
      force: true,
    });

    expect(reply, '届いていない本文を待って応答を止めていないこと（そのまま返っている）').toContain(
      'stopped',
    );
    expect(reply).toContain('まだ台帳に届いていない');
    expect(reply, '案内先は manager_report であること').toContain('manager_report');
  });

  it('manager_list は状態と返事待ちを返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('running');
  });

  it('走行中の本数と、そのうち話しかけられる本数を分けて出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.call('manager_start', { request: 'B' });
    const dead = h.running[1];
    if (!dead) throw new Error('準備に失敗');
    dead.live = false;

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('走行中 2 本（うち話しかけられる 1 本）');
  });

  it('走行中の件数は、jobStatusSchema にまだ無い「実行中」相当の値も含める', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const future = h.running[0];
    if (!future) throw new Error('準備に失敗');
    future.status = 'executing-in-background' as JobStatus;

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('走行中 1 本（うち話しかけられる 1 本）');
  });

  it('manager_list / manager_report は provider の行を出さない（層は常に Claude）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.runnerId = 'runner-a';
    expect(await h.call('manager_list', {})).not.toMatch(/^\s*provider: /m);
    expect(await h.call('manager_report', { managerId: target.managerId })).not.toMatch(
      /^\s*provider: /m,
    );
  });

  it('宛先の器が黙っている委譲は、その判定時刻と「失われたとは限らない」を行に添える', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.live = false;
    orphan.runnerId = 'runner-a';
    orphan.runnerLostSince = '2026-08-27T09:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner: runner-a');
    expect(reply).toContain('2026-08-27T09:00:00.000Z 以降 名乗っていない');
    expect(reply).toContain('この委譲が失われたという意味ではない');
  });

  it('黙った器の行に「話しかけられない」と書かない（実測で偽）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.live = false;
    orphan.runnerId = 'runner-a';
    orphan.runnerLostSince = '2026-08-27T09:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('話しかけられない');
    expect(reply).not.toContain('外れている ⟹');
    expect(reply).toContain('新しい委譲の宛先からは外れている');
  });

  it('黙った器の行は、送信が塞がれていないことと、確かめる前に起こし直さないことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.live = false;
    orphan.runnerId = 'runner-a';
    orphan.runnerLostSince = '2026-08-27T09:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('話しかけることは塞いでいない');
    expect(reply).toContain('session_id');
    expect(reply).toContain('届くとは限らない');
    expect(reply).toContain('manager_send');
    expect(reply).toContain('確かめる前に manager_start で起こし直さないこと');
    expect(reply).toContain('runner_list');
  });

  it('runnerLostSince が立っていない委譲には、この注記を1文字も足さない（予算を食わない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const quiet = h.running[0];
    if (!quiet) throw new Error('準備に失敗');
    quiet.runnerId = 'runner-a';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner: runner-a');
    expect(reply).not.toContain('（この器は');
    expect(reply).not.toContain('新しい委譲の宛先からは外れている');
    expect(reply).not.toContain('話しかけることは塞いでいない');
    expect(reply).not.toContain('器そのものは runner_list で見る');
  });

  it('sessionMissingKind: resume-failed は「resume でも入り直せなかった」を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.sessionMissingSince = '2026-08-27T09:00:00.000Z';
    orphan.sessionMissingKind = 'resume-failed';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('resume でも入り直せなかった。');
    expect(reply).not.toContain('名簿に載っていなかった');
  });

  it('sessionMissingKind: unlisted は「名簿に載っていなかった。resume はまだ試していない」を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.sessionMissingSince = '2026-08-27T09:00:00.000Z';
    orphan.sessionMissingKind = 'unlisted';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('名簿に載っていなかった。resume はまだ試していない。');
    expect(reply).not.toContain('resume でも入り直せなかった');
  });

  it('sessionMissingKind が無いときは、由来の字面を1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const orphan = h.running[0];
    if (!orphan) throw new Error('準備に失敗');
    orphan.sessionMissingSince = '2026-08-27T09:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('この委譲のセッションを持っていなかった');
    expect(reply).not.toContain('resume でも入り直せなかった');
    expect(reply).not.toContain('名簿に載っていなかった');
  });

  it('黙った器に載っている本数を件数の行にも出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.call('manager_start', { request: 'B' });
    const orphan = h.running[1];
    if (!orphan) throw new Error('準備に失敗');
    orphan.live = false;
    orphan.runnerLostSince = '2026-08-27T09:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('宛先の器が名乗らなくなった 1 本');
  });

  it('黙った器が1台も無ければ、その区分は件数の行に出さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('宛先の器が名乗らなくなった');
  });

  function countParts(reply: string): string[] {
    const line = reply.split('\n').find((l) => l.startsWith('件数: '));
    if (line === undefined) throw new Error('件数の行が無い（manager_list の本文が変わった）');
    return line.slice('件数: '.length).split('。')[0]!.split(' / ');
  }

  const ZERO_LINE_RULE =
    '赤の意味: `manager_list` の件数の行は**該当が 0 の区分を書かない**規約である' +
    '（`describeManagerCounts` の `if (… > 0) parts.push(…)`）。' +
    '⚠ `situation.ts` の「返事待ち 0」は**意図して 0 を出す**別の規約なので、混ぜないこと。';

  it('該当が無い区分は件数の行に書かない（0 の行を作らない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(countParts(reply), ZERO_LINE_RULE).toEqual([
      '全 1 本',
      '走行中 1 本（うち話しかけられる 1 本）',
    ]);
  });

  it.each([
    ['返事待ち', (m: ManagerSummary) => (m.status = 'waiting_human'), '返事待ち 1 本'],
    [
      '宛先の器が名乗らなくなった',
      (m: ManagerSummary) => (m.runnerLostSince = '2026-08-20T00:00:00.000Z'),
      '宛先の器が名乗らなくなった 1 本',
    ],
    [
      'runner にセッションが無い',
      (m: ManagerSummary) => (m.sessionMissingSince = '2026-08-20T00:00:00.000Z'),
      'runner にセッションが無い 1 本',
    ],
    ['戻れなかった(lost)', (m: ManagerSummary) => (m.status = 'lost'), '戻れなかった(lost) 1 本'],
  ])('（対照）%s が1本在れば、その区分の行が出る', async (_label, mutate, expected) => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (target === undefined) throw new Error('準備に失敗');
    mutate(target);

    const reply = await h.call('manager_list', {});

    expect(countParts(reply), ZERO_LINE_RULE).toContain(expected);
  });

  it('manager_list は返事待ちの種別と時刻を出す（kind/askedAt が揃っているとき）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.waiting = [
      {
        requestId: 'req-1',
        summary: 'これでよいか',
        kind: 'question',
        askedAt: '2026-08-20T00:00:00.000Z',
      },
    ];

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('質問');
    expect(reply).toContain('2026-08-20T00:00:00.000Z から');
    expect(reply).not.toContain('実行許可');
  });

  it('1本のマネージャーの返事待ちが大量でも、件数で切って省略の合図を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    const count = 40;
    target.waiting = Array.from({ length: count }, (_, index) => ({
      requestId: `req-${index}`,
      summary: `質問その${index}`,
      kind: 'question' as const,
      askedAt: '2026-08-20T00:00:00.000Z',
    }));

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('req-0');
    expect(reply).not.toContain('req-39');
    expect(reply).toMatch(/…ほか \d+ 件の返事待ちは省略/);
  });

  it('manager_list は kind/askedAt が無くても「実行許可」と決めつけない（#334 の追加コメント）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.waiting = [
      {
        requestId: 'req-legacy',
        summary: 'これでよいか',
      },
    ];

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('req-legacy');
    expect(reply).not.toContain('実行許可');
    expect(reply).toContain('種別不明');
    expect(reply).not.toContain('undefined');
    expect(reply).not.toMatch(/,\s*から/);
  });

  it('manager_list は runnerId を出す（未記録なら空欄にせずそう言う）', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-shown');
    await h.call('manager_start', { request: 'A' });
    h.setAutoRunnerId(undefined);
    await h.call('manager_start', { request: 'B' });

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner-shown');
    expect(reply).toContain('未記録');
  });

  it('manager_list は作成時刻と更新時刻を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.startedAt = '2026-01-02T03:04:05.000Z';
    target.updatedAt = '2026-03-04T05:06:07.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(reply).toContain('更新: 2026-03-04T05:06:07.000Z');
  });

  it('manager_list は lastReportAt を「直近の報告」の行に添える（行は増やさない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';
    target.lastReportAt = '2026-08-24T00:00:00.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('2026-08-24T00:00:00.000Z');
    expect(reply).toContain('終わった');
    expect(reply.match(/直近の報告/g)).toHaveLength(1);
  });

  it('manager_list は焼いた status といまの status の食い違いを、行を増やさずに印で出す（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.status = 'stopped';

    target.lastReportStatus = 'stopped';
    const clean = await h.call('manager_list', {});

    target.lastReportStatus = 'running';
    const withDrift = await h.call('manager_list', {});

    expect(clean.split('\n').length, '印は既存行の中へ足すので行数は変わらない').toBe(
      withDrift.split('\n').length,
    );
    expect(withDrift).toContain('⚠');
    expect(withDrift).toContain('、⚠ status 食い違い（manager_report で詳細）');
    expect(clean, '一致している回は1文字も増えない').not.toContain('⚠');
  });

  it('manager_list は lastReportStatus が無い（比較できない）行に何も足さない（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.status = 'done';

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('⚠');
  });

  it('manager_list は lastReportAt が無い行に何も足さない（「未受信」を作らない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('直近の報告: 終わった');
    expect(reply).not.toContain('未受信');
    expect(reply).not.toContain('undefined');
  });

  it('manager_list は lastFailure を専用行で出し、見出しを「報告」から切り替える（#714）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '（このターンは応答を返さずに終わった: billing_error）';
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('billing_error');
    expect(reply).toContain('assistant_error');
    expect(reply).toContain('2026-09-09T01:23:45.000Z');
    expect(reply).toContain(
      '直近のターンの中身: （このターンは応答を返さずに終わった: billing_error）',
    );
    expect(reply).not.toContain('直近の報告');
  });

  it('manager_list は lastFailure が無ければ1文字も足さない（#714。予算を食わない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('直近の報告: 終わった');
    expect(reply).not.toContain('直近のターンの中身');
    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain('完遂して畳んだと読まないこと');
    expect(reply).not.toContain('原因が解ければ manager_send で続きから進む');
  });

  it('manager_list は usageStoppedAt を専用行で出す（#1212 残件2の続き）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('2026-09-25T01:23:45.000Z');
    expect(reply).toContain('running');
  });

  it('manager_list は usageStoppedAt が無ければ1文字も足さない（#1212 残件2の続き）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('枠(利用上限)で止まっている');
  });

  it('manager_list: usageStoppedAt と lastFailure が同じ委譲で両方出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-25T01:23:50.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });

  it('manager_list は runnerVanished を専用行で出す（Issue #1212 running 側。段1）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.runnerVanished = true;

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 宛先の runner が名簿から消えている');
    expect(reply).toContain(`この委譲の走り始めは ${target.startedAt}`);
    expect(reply).toContain('消えた時刻は名簿に残っていないので分からない');
    expect(reply).toContain('running');
    expect(reply).toContain('lost ではない');
  });

  it('manager_list は runnerVanished が無ければ1文字も足さない（Issue #1212 running 側。段1）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('宛先の runner が名簿から消えている');
  });

  it('manager_list: runnerVanished と usageStoppedAt と lastFailure が同じ委譲で全部出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.runnerVanished = true;
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-25T01:23:50.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 宛先の runner が名簿から消えている');
    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });

  it('manager_list は observed な未push観測（branch を含む）を1行出す（Issue #1266）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('feat/example');
    expect(reply).toContain('経路不明');
    expect(reply).toContain('manager_list 自身では更新されない');
    expect(reply).toContain('いまの状態ではない');
    expect(reply).not.toContain('枠落ち');
    expect(reply).not.toContain('/workspace/mgr-1/repo');
  });

  it('manager_list は source: closed の未push観測で closed の経路の句を出し、「更新されない」と言い切らない（Issue #1266）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      source: 'closed',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner が closed を出す直前に先取り');
    expect(reply).not.toContain('経路不明');
    expect(reply).not.toContain('枠落ち');
    expect(reply).not.toContain('器の入れ替え');
    expect(reply).not.toContain('manager_stop（running・非force）の断り');
  });

  it('manager_list は observed な未push観測が確かめきれなかったことを持つとき「探しきっていない」と名乗る（Issue #1885）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
      truncatedAtCount: 200,
      unreadableDirCount: 2,
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('feat/example');
    expect(reply).toContain('この観測は探しきっていない');
    expect(reply).toContain('件数の上限（200）で打ち切った');
    expect(reply).toContain('子ディレクトリの読み失敗が2件あった');
    expect(reply).toContain('ここに無い作業ツリーが在りうる');
  });

  it('manager_list は確かめきれなかった申告が無い観測では「探しきっていない」を出さない（Issue #1885。古い台帳の行と同じ形）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).not.toContain('探しきっていない');
  });

  it('manager_list は unavailable な未push観測で reason を出す（Issue #1266。branch が取れなかったと分かる）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: '2026-09-20T00:00:00.000Z',
      reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('この runner はこの口を持たない（古い版、またはテストの偽物）。');
  });

  it('manager_list は未push観測が無い委譲では1文字も足さない（Issue #1266。予算を食わない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('未push観測');
  });

  it('manager_list は作業ツリー0本で探索の失敗も無い観測では「未push観測」を省く・1本以上/失敗/読み残しなら出す（Issue #2970）', async () => {
    const base = {
      at: '2026-09-26T12:00:00.000Z',
      source: 'report' as const,
      cwd: '/workspace/mgr-1',
    };
    const cases: {
      name: string;
      obs: NonNullable<ManagerSummary['lastUnpushedWorkObservation']>;
      shown: boolean;
    }[] = [
      { name: '0本・失敗なし', obs: { kind: 'observed', ...base, worktrees: [] }, shown: false },
      {
        name: '1本',
        obs: {
          kind: 'observed',
          ...base,
          worktrees: [{ relativePath: 'mgr-1/repo', branch: 'main' }],
        },
        shown: true,
      },
      { name: '取れなかった', obs: { kind: 'unavailable', ...base, reason: '模擬' }, shown: true },
      {
        name: '0本・読み残し',
        obs: { kind: 'observed', ...base, worktrees: [], unreadableDirCount: 2 },
        shown: true,
      },
    ];
    for (const c of cases) {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.lastUnpushedWorkObservation = c.obs;
      const reply = await h.call('manager_list', {});
      if (c.shown) expect(reply, c.name).toContain('未push観測');
      else expect(reply, c.name).not.toContain('未push観測');
    }
  });

  it('manager_list は器の入れ替えで応答不能・shutdown 由来の観測が届いていれば「止まる直前の観測」と言い切る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.sessionMissingSince = '2026-09-27T00:00:10.000Z';
    target.shutdownObservationArrivedAfterSwap = true;
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-27T00:00:09.000Z',
      source: 'shutdown',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/arrived-after-swap' }],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('器が止まる直前');
    expect(reply).toContain('2026-09-27T00:00:09.000Z');
    expect(reply).toContain('feat/arrived-after-swap');
    expect(reply).not.toContain('届いていない');
  });

  it('manager_list は器の入れ替えで応答不能・shutdown 側が unavailable でも「届いた」側で言う（取れなかったが、応答はあった）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.sessionMissingSince = '2026-09-27T00:00:10.000Z';
    target.shutdownObservationArrivedAfterSwap = true;
    target.lastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: '2026-09-27T00:00:09.000Z',
      source: 'shutdown',
      reason: '確かめようとして例外が飛んだ: Error: なにか',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('器が止まる直前');
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('確かめようとして例外が飛んだ: Error: なにか');
  });

  it('manager_list は器の入れ替えで応答不能・shutdown 由来の観測が届いていなければ「届いていない」と明示し、古い観測は0件と見せない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.sessionMissingSince = '2026-09-27T00:00:10.000Z';
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-26T12:00:00.000Z',
      source: 'report',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('届いていない');
    expect(reply).toContain('best-effort');
    expect(reply).toContain('未pushが無かったことを意味しない');
    expect(reply).toContain('2026-09-26T12:00:00.000Z');
    expect(reply).toContain('report');
    expect(reply).not.toContain('器が止まる直前（');
  });

  it('manager_list は器の入れ替えで応答不能・stop 由来（Issue #1266 残り2）の観測は shutdown ではないので「届いていない」に倒す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.sessionMissingSince = '2026-09-27T00:00:10.000Z';
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-26T12:00:00.000Z',
      source: 'stop',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [],
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('届いていない');
    expect(reply).toContain('自動畳みが止める直前');
    expect(reply).not.toContain('器が止まる直前（');
  });

  it('manager_list は器の入れ替えで応答不能・観測そのものが一度も無ければ「無い」と明示する（沈黙にしない。予算のルールの例外）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.sessionMissingSince = '2026-09-27T00:00:10.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未push観測');
    expect(reply).toContain('届いていない');
    expect(reply).toContain('表示中の観測は無い');
  });

  it('manager_report は lastReportAt といまの status を見出しに出す（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '報告本文';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.status = 'done';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('2026-09-16T00:00:00.000Z');
    expect(reply).toContain('`done`');
  });

  it('manager_report は焼いた status といまの status が食い違うとき ⚠ を出す（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '報告本文';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.lastReportStatus = 'running';
    target.status = 'stopped';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('⚠');
    expect(reply).toContain('running');
    expect(reply).toContain('stopped');
  });

  it('manager_report は焼いた status といまの status が一致していれば1文字も増えない（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '報告本文';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.status = 'done';
    target.lastReportStatus = 'done';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('⚠');
    expect(
      reply,
      '一致・比較不能な回は describeValidity の changed/unknowable 文言を出さない',
    ).not.toContain('前提は動いています');
  });

  it('manager_report は lastReportStatus が無い（比較できない）行では ⚠ を出さない（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '報告本文';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.status = 'stopped';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('⚠');
  });

  it('manager_report は part=request では齢も status も ⚠ も出さない（Issue #1036）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0]!;
    target.lastReport = '報告本文';
    target.lastReportAt = '2026-09-16T00:00:00.000Z';
    target.lastReportStatus = 'running';
    target.status = 'stopped';

    const reply = await h.call('manager_report', {
      managerId: target.managerId,
      part: 'request',
    });

    expect(reply).not.toContain('2026-09-16T00:00:00.000Z');
    expect(reply).not.toContain('いまの status');
    expect(reply).not.toContain('⚠');
  });

  it('manager_report は lastFoldedTurn を lastReport より優先して見せ、見出しを言い分ける（Issue #1038）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '停止前の完遂した報告';
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('停止後に届いた畳まれた本文');
    expect(reply).toContain('停止後に届いた、畳まれたターンの中身');
    expect(reply).toContain('2026-09-16T00:20:00.000Z');
    expect(reply).not.toContain('停止前の完遂した報告');
  });

  it('manager_report は lastFoldedTurn が無ければ従来どおり lastReport を見せる（Issue #1038）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '完遂した報告';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('完遂した報告');
    expect(reply).not.toContain('停止後に届いた');
  });

  it('manager_report は lastFailure を出し、見出しを「報告」から切り替える（#714）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '（このターンは応答を返さずに終わった: billing_error）';
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('billing_error');
    expect(reply).toContain('assistant_error');
    expect(reply).toContain('2026-09-09T01:23:45.000Z');
    expect(reply).toContain('直近のターンの中身');
    expect(reply).not.toContain('直近の報告');

    const request = await h.call('manager_report', {
      managerId: target.managerId,
      part: 'request',
    });

    expect(request).toContain('依頼文');
    expect(request).toContain('依頼の本文');
    expect(request).not.toContain('直近のターンの中身');
    expect(request).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });

  it('manager_report は lastFailure が無ければ1文字も足さない（#714）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('直近の報告');
    expect(reply).toContain('終わった');
    expect(reply).not.toContain('直近のターンの中身');
    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain('完遂して畳んだと読まないこと');
    expect(reply).not.toContain('原因が解ければ manager_send で続きから進む');
  });

  it('manager_list は lastUnreported が在る回でも見出しを「報告」から切り替える（#917。⚠ 行は出さない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）\n途中まで';
    target.lastUnreported = {
      reason: 'デーモンから停止を指示された。',
      at: '2026-09-13T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain(
      '直近のターンの中身: （このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）',
    );
    expect(reply).not.toContain('直近の報告');
    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });

  it('manager_report は lastUnreported が在る回でも見出しを「報告」から切り替える（#917）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）\n途中まで';
    target.lastUnreported = {
      reason: 'デーモンから停止を指示された。',
      at: '2026-09-13T01:23:45.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('直近のターンの中身');
    expect(reply).not.toContain('直近の報告');
    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');

    const request = await h.call('manager_report', {
      managerId: target.managerId,
      part: 'request',
    });
    expect(request).toContain('依頼文');
    expect(request).not.toContain('直近のターンの中身');
  });

  describe('lastSystemError（#713 段3）', () => {
    const B_SYSTEM_ERROR = {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
      at: '2026-09-10T03:00:00.000Z',
    };

    it('manager_list: B（systemError 在り）と D（無し）で出る文言が違う（入れ替えで赤くなる）', async () => {
      const h = harness();

      await h.call('manager_start', { request: 'B' });
      const b = h.running[0];
      if (!b) throw new Error('準備に失敗');
      b.status = 'failed';
      b.lastSystemError = B_SYSTEM_ERROR;

      await h.call('manager_start', { request: 'D' });
      const d = h.running[1];
      if (!d) throw new Error('準備に失敗');
      d.status = 'failed';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('code=EAGAIN');
      expect(reply).toContain('errno=-11');
      expect(reply).toContain('syscall=spawn /app/node_modules/.bin/claude');
      expect(reply).toContain('2026-09-10T03:00:00.000Z');
      expect(reply).toContain('器の資源による落ち方かどうかは、この欄では判定できなかった');
      expect(reply.match(/code=/g)).toHaveLength(1);
    });

    it('manager_list: 健全なマネージャー（status !== failed）は1文字も足さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'ok' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      target.lastReport = '終わった';

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('器の資源');
      expect(reply).not.toContain('セッションは失敗で畳まれた');
      expect(reply).not.toContain('code=');
    });

    it('manager_list: D の行は、同じ出力に在る lastFailure（別の軸）の事実を消さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.lastReport = '（このターンは応答を返さずに終わった: billing_error / assistant_error）';
      target.lastFailure = {
        code: 'billing_error',
        via: 'assistant_error',
        at: '2026-09-10T02:00:00.000Z',
      };
      target.status = 'failed';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('器の資源による落ち方かどうかは、この欄では判定できなかった');
      expect(reply).toContain('billing_error');
      expect(reply).toContain('assistant_error');
      expect(reply).toContain('2026-09-10T02:00:00.000Z');
      expect(reply).toContain('lastFailure');
    });

    it('manager_report: B と D で出る文言が違い、報告がまだ無い回にも D/B が乗る', async () => {
      const h = harness();

      await h.call('manager_start', { request: 'B-no-report' });
      const b = h.running[0];
      if (!b) throw new Error('準備に失敗');
      b.status = 'failed';
      b.lastSystemError = B_SYSTEM_ERROR;

      const replyB = await h.call('manager_report', { managerId: b.managerId });
      expect(replyB).toContain('報告はまだ無い');
      expect(replyB).toContain('code=EAGAIN');

      await h.call('manager_start', { request: 'D-no-report' });
      const d = h.running[1];
      if (!d) throw new Error('準備に失敗');
      d.status = 'failed';

      const replyD = await h.call('manager_report', { managerId: d.managerId });
      expect(replyD).toContain('報告はまだ無い');
      expect(replyD).toContain('器の資源による落ち方かどうかは、この欄では判定できなかった');
      expect(replyD).not.toContain('code=');
    });

    it('manager_report: 健全なマネージャーは1文字も足さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'ok' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      target.lastReport = '終わった';

      const reply = await h.call('manager_report', { managerId: target.managerId });

      expect(reply).not.toContain('器の資源');
      expect(reply).not.toContain('セッションは失敗で畳まれた');
      expect(reply).not.toContain('code=');
    });
  });

  it('manager_list は失敗の⚠行に回復の見込み（time）を添える。既存の文言は変えない（#393）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
      "You've hit your org's monthly spend limit";
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain(
      '⚠ 直近のターンは報告ではなく失敗で終わっている: billing_error（assistant_error, 2026-09-09T01:23:45.000Z）。',
    );
    expect(reply).toContain('完遂して畳んだと読まないこと');
    expect(reply).toContain('（回復の見込み: 時間で戻る（time））');
  });

  it('manager_list は世代が食い違う委譲に「時間で戻る」だけを出さない（#931）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
      "You've hit your org's monthly spend limit";
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };
    target.tokenGeneration = 3;
    target.activeTokenGeneration = 5;

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('（回復の見込み: 時間で戻る（time））');
    expect(reply).toContain('⚠ 認証トークンの世代が食い違っている');
    expect(reply).toContain(STALE_TOKEN_RECOVERY_CAVEAT);
  });

  it('manager_list は世代が一致していれば但し書きを足さない（#931 の陰性対照）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
      "You've hit your org's monthly spend limit";
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };
    target.tokenGeneration = 5;
    target.activeTokenGeneration = 5;

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('（回復の見込み: 時間で戻る（time））');
    expect(reply).not.toContain(STALE_TOKEN_RECOVERY_CAVEAT);
  });

  it('manager_list は resets 時刻が降りた鍵と一致したら世代ずれの疑いを出す（#914 提案(2)）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.resetTimeSkewMatch = 'stale';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('認証トークンの世代ずれの疑い');
    expect(reply).toContain('現役ではない鍵の冷却期限と一致した');
  });

  it('manager_list の世代ずれの行は、起こし直しの助言より前に「止める前に確かめろ」を置く（#1063）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.resetTimeSkewMatch = 'stale';

    const reply = await h.call('manager_list', {});

    const premise = reply.indexOf('止める前に、その委譲がターンの途中かどうか');
    const advice = reply.indexOf('manager_stop → manager_start で起こし直すこと');
    expect(premise).toBeGreaterThanOrEqual(0);
    expect(advice).toBeGreaterThanOrEqual(0);
    expect(premise).toBeLessThan(advice);
    expect(reply).toContain('未 push・未コミットの実物が出る');
  });

  it('manager_list は resets 時刻が現役自身と一致したら「待てば戻る」と言う（⚠ を立てない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.resetTimeSkewMatch = 'active';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('世代ずれではなく、待てば戻る');
    expect(reply).not.toContain('認証トークンの世代ずれの疑い');
  });

  it('manager_list は提案1が既に食い違いを名乗っていれば resets の行を出さない（#914 提案(2) の陰性対照）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.tokenGeneration = 3;
    target.activeTokenGeneration = 5;
    target.resetTimeSkewMatch = 'stale';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 認証トークンの世代が食い違っている');
    expect(reply).not.toContain('認証トークンの世代ずれの疑い');
  });

  it('manager_list は resetTimeSkewMatch が無ければ何も足さない（#914 提案(2) の陰性対照）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('認証トークンの世代ずれの疑い');
    expect(reply).not.toContain('世代ずれではなく、待てば戻る');
  });

  it('manager_list は失敗の⚠行に回復の見込み（action）を添える（#393）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
      'Your usage allocation has been disabled by your admin';
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('（回復の見込み: 人間が動かないと戻らない（action））');
  });

  it('manager_list は回復の見込みが unknown のとき1文字も足さない（#393）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: exit_code / bash）\n' +
      'Something unrelated went wrong';
    target.lastFailure = {
      code: 'exit_code',
      via: 'bash',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain('回復の見込み');
  });

  it('manager_report は失敗の⚠行に回復の見込みを添える。既存の文言は変えない（#393）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
      "You've hit your org's monthly spend limit";
    target.lastFailure = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain(
      '⚠ 直近のターンは報告ではなく失敗で終わっている: billing_error（assistant_error, 2026-09-09T01:23:45.000Z）。',
    );
    expect(reply).toContain('（回復の見込み: 時間で戻る（time））');

    const request = await h.call('manager_report', {
      managerId: target.managerId,
      part: 'request',
    });
    expect(request).not.toContain('回復の見込み');
  });

  it('manager_list は verification_required では、語の軸から回復の見込み（action）を添える（#809）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: verification_required / assistant_error）\n' +
      'API Error: organization verification required · complete verification at ' +
      'https://console.anthropic.com/settings/verification';
    target.lastFailure = {
      code: 'verification_required',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('（回復の見込み: 人間が動かないと戻らない（action））');
  });

  it('manager_list は overloaded では、語の軸から回復の見込み（time）を添える（#809）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport =
      '（このターンは応答を返さずに終わった: overloaded / assistant_error）\n' +
      'API Error: Overloaded';
    target.lastFailure = {
      code: 'overloaded',
      via: 'assistant_error',
      at: '2026-09-09T01:23:45.000Z',
    };

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('（回復の見込み: 時間で戻る（time））');
  });

  describe('manager_list はターン終了/報告未着の助言を出す（#567）', () => {
    it('turnEndReason が無ければ ⚠ を出さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('ターンは');
    });

    it('(B) turnEndedAt <= lastReportAt なら ⚠ を出さない（正常な待機を症状と名乗らない）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = '2026-08-28T09:00:00.000Z';
      target.turnEndReason = 'end_turn';
      target.lastReportAt = '2026-08-28T09:05:00.000Z';

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('⚠ ターンは');
    });

    it('(C) turnEndedAt > lastReportAt なら ⚠ を出し、turnEndedAt と turnEndReason を本文に含む', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = '2026-08-28T09:10:00.000Z';
      target.turnEndReason = 'end_turn';
      target.lastReportAt = '2026-08-28T09:00:00.000Z';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ ターンは');
      expect(reply).toContain('2026-08-28T09:10:00.000Z');
      expect(reply).toContain('end_turn');
    });

    it('(C) lastReportAt が無いときも ⚠ を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = '2026-08-28T09:10:00.000Z';
      target.turnEndReason = 'end_turn';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ ターンは');
    });

    it('(A) turnEndReason は在るが turnEndedAt が無いなら ⚠ を出し、「分からない」と読める文言にする（「症状ではない」にしない）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndReason = 'end_turn';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ ターンは終わっているらしいが、いつ終わったかが分からない');
      expect(reply).toContain('分からないだけで、症状ではないとは言えない');
      expect(reply).not.toContain('症状ではない）');
    });

    it('turnEndReason が stop_sequence のときは枠の壁（利用上限）の可能性を言い添え、#567 とは別原因だと言い分ける', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = '2026-08-28T09:10:00.000Z';
      target.turnEndReason = 'stop_sequence';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ ターンは');
      expect(reply).toContain('枠の壁');
      expect(reply).toContain('利用上限');
      expect(reply).toContain('Issue #567');
      expect(reply).toContain('とは別の原因である');
    });

    it('turnEndTail が長いときは抜粋され、全文はそのまま出ない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = '2026-08-28T09:10:00.000Z';
      target.turnEndReason = 'end_turn';
      target.turnEndTail = 'あ'.repeat(400);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('末尾の抜粋');
      expect(reply).not.toContain('あ'.repeat(400));
    });

    it('turnEndedAt が Date.parse できない形のとき、lastReportAt が新しくても ⚠ を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.turnEndedAt = 'not-a-timestamp';
      target.turnEndReason = 'end_turn';
      target.lastReportAt = '2026-08-28T09:59:59.000Z';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ ターンは');
    });
  });

  describe('manager_list は「背景処理待ち」と「手が空いた」を潰さない（#621 / #643）', () => {
    it('握り潰しが在れば done/背景処理待ち×N と出る', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      target.awaitingBackground = {
        tasks: 3,
        withheldReports: 2,
        breakdown: 'local_agent×3',
        since: '2026-09-05T00:00:00.000Z',
      };

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('[done/背景処理待ち×3（2026-09-05T00:00:00.000Z から）]');
    });

    it('since が在れば、いつから待っているかの時刻を一覧の行に添える', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      target.awaitingBackground = {
        tasks: 1,
        withheldReports: 1,
        breakdown: 'local_agent×1',
        since: '2026-09-16T11:00:00.000Z',
      };

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('（2026-09-16T11:00:00.000Z から）');
      expect(reply).not.toMatch(/\d+時間|\d+分/);
    });

    it('握り潰しが無ければ done のままで、背景処理の語を1つも足さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('[done]');
      expect(reply).not.toContain('背景処理待ち×');
    });

    it('内訳（breakdown）は一覧の行へ載せない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      target.awaitingBackground = {
        tasks: 3,
        withheldReports: 2,
        breakdown: 'BREAKDOWN-MARKER-a91f',
        since: '2026-09-05T00:00:00.000Z',
      };

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('[done/背景処理待ち×3（2026-09-05T00:00:00.000Z から）]');
      expect(reply).not.toContain('BREAKDOWN-MARKER-a91f');
    });

    it('道具の説明文が「印が無い＝手が空いている」ではないと断る', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'manager_list')?.description;

      expect(description).toContain('done/背景処理待ち×N');
      expect(description).toContain('経過時間そのもの');
      expect(description).toContain('印が無いことを「手が空いている」と読まないこと');
    });
  });

  describe('manager_list は「畳む候補」を ⚠ で表示する（#1394 段⑤。畳む操作はしない）', () => {
    it('条件1・2・4・5をすべて満たすよう仕立てても、条件3の材料が無いので ⚠ は出ない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      delete target.awaitingBackground;
      target.turnEndReason = 'end_turn';
      target.turnEndedAt = '2000-01-01T00:00:00.000Z';
      target.lastReportAt = '2000-01-01T00:00:01.000Z';
      target.updatedAt = '2000-01-01T00:00:01.000Z';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('[done]');
      expect(reply).not.toContain('畳む候補');
    });

    it('器が awaiting-background-signal を名乗っていれば、同じ仕立てで ⚠ が出る（#1394 段(C)）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.status = 'done';
      delete target.awaitingBackground;
      target.turnEndReason = 'end_turn';
      target.turnEndedAt = '2000-01-01T00:00:00.000Z';
      target.lastReportAt = '2000-01-01T00:00:01.000Z';
      target.updatedAt = '2000-01-01T00:00:01.000Z';
      target.runnerId = 'runner-capable';
      h.managers.runnerHasCapability = (runnerId, capability) =>
        runnerId === 'runner-capable' && capability === 'awaiting-background-signal';

      expect(await h.call('manager_list', {})).toContain('畳む候補');

      target.runnerId = 'runner-old';
      expect(await h.call('manager_list', {})).not.toContain('畳む候補');
    });

    it('道具の説明文が「畳む候補」の ⚠ の意味と、畳む操作はしないことを言う', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'manager_list')?.description;

      expect(description).toContain('「畳む候補」の ⚠');
      expect(description).toContain('この道具（manager_list）自身は畳まない');
      expect(description).toContain('runner_list を resources: true で呼んだとき');
      expect(description).toContain('名乗らない古い器');
    });
  });

  describe('manager_list は「道具の応答待ちのまま、誰も待っていない」を出す（#572）', () => {
    it('toolUseStallPending が無ければ ⚠ を出さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('道具の応答待ち');
    });

    it('waiting が空で未応答の tool_use が在れば ⚠ を出し、道具の名前・id・timestamp を本文に含む', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallAt = '2026-08-28T09:10:00.000Z';
      target.toolUseStallPending = [{ id: 'toolu_ask', name: 'AskUserQuestion' }];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 道具の応答待ちのまま、誰もその応答を待っていない');
      expect(reply).toContain('AskUserQuestion');
      expect(reply).toContain('toolu_ask');
      expect(reply).toContain('2026-08-28T09:10:00.000Z');
    });

    it('waiting が非空なら ⚠ を出さない（届いていて、まだ答えていないだけの正常な状態）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallAt = '2026-08-28T09:10:00.000Z';
      target.toolUseStallPending = [{ id: 'toolu_ask', name: 'AskUserQuestion' }];
      target.waiting = [
        {
          requestId: 'req-1',
          summary: 'どちらの案にするか',
          kind: 'question',
          askedAt: '2026-08-28T09:10:00.000Z',
        },
      ];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('返事待ち(requestId: req-1');
      expect(reply).not.toContain('道具の応答待ち');
    });

    it('toolUseStallAt が無くても ⚠ を出し、「いつからかは分からない」と読める文言にする', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallPending = [{ id: 'toolu_ask', name: 'AskUserQuestion' }];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 道具の応答待ちのまま');
      expect(reply).toContain('いつからかは分からない');
      expect(reply).not.toContain('undefined');
    });

    it('name が無い tool_use でも「不明」と分かる形で出し、undefined を出力しない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallPending = [{ id: 'toolu_noname' }];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('toolu_noname');
      expect(reply).not.toContain('undefined');
      expect(
        reply,
        'name の無い tool_use が、undefined でもないが「不明」とも名乗らない形で出ている。' +
          'この赤の意味は「読み手が、名前が取れなかったのか名前が空なのかを区別できない」。',
      ).toContain('不明');
    });

    it('未応答の道具が上限を超えたら、切ったことと全件数を言う', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallPending = Array.from({ length: 5 }, (_, index) => ({
        id: `toolu_${index}`,
        name: 'Bash',
      }));

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('ほか 2 件、全 5 件');
    });

    it('⚠ の行は経過時間を判定せず、閾値を置いていないことを明示する', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallAt = '2026-08-28T09:10:00.000Z';
      target.toolUseStallPending = [{ id: 'toolu_ask', name: 'AskUserQuestion' }];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('時刻の閾値は置いていない');
      expect(reply).toContain('timestamp を読んで判断すること');
    });
  });

  describe('manager_list は「道具を実行中なだけ（矛盾ではない）」を出す（Issue #2173）', () => {
    it('未応答の道具がふつうの道具（Bash）だけなら、⚠ を出さず「実行中」の行を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallAt = '2026-08-28T09:10:00.000Z';
      target.toolUseStallPending = [{ id: 'toolu_bash', name: 'Bash' }];

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('⚠ 道具の応答待ちのまま');
      expect(reply).toContain('道具を実行中');
      expect(reply).toContain('未応答の道具: Bash(toolu_bash)');
    });

    it('AskUserQuestion と Bash が混ざっていれば、⚠ のほうを出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallAt = '2026-08-28T09:10:00.000Z';
      target.toolUseStallPending = [
        { id: 'toolu_bash', name: 'Bash' },
        { id: 'toolu_ask', name: 'AskUserQuestion' },
      ];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 道具の応答待ちのまま');
      expect(reply).not.toContain('道具を実行中');
    });

    it('「実行中」の行も時刻の閾値を置かない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.toolUseStallPending = [{ id: 'toolu_bash', name: 'Bash' }];

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('道具を実行中');
      expect(reply).toContain('いつからかは分からない');
      expect(reply).toContain('時刻の閾値は置いていない');
    });
  });

  describe('manager_list は認証トークンの世代の食い違いを出す（Issue #914 提案1）', () => {
    it('材料が無ければ1文字も足さない（プールを使っていない構成）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });

      const reply = await h.call('manager_list', {});

      expect(reply).not.toContain('認証トークンの世代');
    });

    it('プール未配線が理由なら、その理由を名乗り、起こし直しても変わらないと言う', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGenerationUnknownReason = 'pool-not-wired';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('認証トークンの世代: 分からない');
      expect(reply).toContain('配線していない');
      expect(reply).toContain('起こし直しても変わらない');
      expect(reply).not.toContain('⚠ 認証トークンの世代');
      expect(reply).not.toContain('一致');
    });

    it('一度も観測されていないことが理由なら、始まればすぐ埋まると言い、起こし直せとは言わない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGenerationUnknownReason = 'not-yet-observed';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('認証トークンの世代: 分からない');
      expect(reply).toContain('まだ一度も起きていない');
      expect(reply).not.toContain('manager_stop → manager_start');
      expect(reply).not.toContain('⚠ 認証トークンの世代');
    });

    it('デーモン再起動をまたいだ引き取りが理由なら、その理由と対処を言う', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGenerationUnknownReason = 'reattached-across-restart';

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('認証トークンの世代: 分からない');
      expect(reply).toContain('デーモンの再起動をまたいで');
      expect(reply).toContain('manager_stop → manager_start');
      expect(reply).not.toContain('⚠ 認証トークンの世代');
    });

    it('世代が一致していれば、一致していると言う（⚠ は出さない）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGeneration = 3;
      target.activeTokenGeneration = 3;

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('認証トークンの世代: 3（現役と一致）');
      expect(reply).not.toContain('⚠ 認証トークンの世代');
    });

    it('世代が食い違っていれば ⚠ を立て、両方の世代の値と次の一手を言う', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGeneration = 3;
      target.activeTokenGeneration = 5;

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 認証トークンの世代が食い違っている');
      expect(reply).toContain('世代 3');
      expect(reply).toContain('現役は世代 5');
      expect(reply).toContain('manager_stop → manager_start');
    });

    it('世代が食い違う ⚠ に、runner が見た背景処理の本数（1本以上・0本・分からない）を添える', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGeneration = 3;
      target.activeTokenGeneration = 5;

      target.liveBackgroundTasks = 2;
      expect(await h.call('manager_list', {})).toContain('背景処理は 2 本');

      target.liveBackgroundTasks = 0;
      expect(await h.call('manager_list', {})).toContain('背景処理は 0 本');

      delete target.liveBackgroundTasks;
      const unknown = await h.call('manager_list', {});
      expect(unknown).toContain('背景処理の本数は分からない');
      expect(unknown).not.toContain('背景処理は 0 本');
    });

    it('現役が取れなければ「比べられない」と言い、一致とも不一致とも言わない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0];
      if (!target) throw new Error('準備に失敗');
      target.tokenGeneration = 3;

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('認証トークンの世代: 3（現役は不明——比べられない）');
      expect(reply).not.toContain('一致');
      expect(reply).not.toContain('⚠ 認証トークンの世代');
    });

    it('道具の説明文が世代の食い違いの意味と次の一手を説明する', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'manager_list')?.description;

      expect(description).toContain('認証トークンの世代');
      expect(description).toContain('manager_stop');
    });
  });

  it('manager_list は受信箱に未処理が無くても、0件であることを1行で出す（#562）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('受信箱');
    expect(reply).toContain('無い');
    expect(reply).not.toContain('⚠ クローンの受信箱');
  });

  it('manager_list は、器の行が0件でもメモリの配達待ち行列に残りがあれば「無い」と言い切らない（issue #1133）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setQueuedInMemory(3326);

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('クローンの受信箱に未処理の合図は無い。');
    expect(reply).toContain('器の行に未処理の合図は無い');
    expect(reply).toContain('メモリの配達待ち行列 3326 件');
  });

  it('manager_list は、queuedInMemory を渡さない（省略）呼びでは旧来の0件文言のまま（回帰対策）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('クローンの受信箱に未処理の合図は無い。');
    expect(reply).not.toContain('メモリの配達待ち行列');
  });

  it('manager_list は、器の行が在るときもメモリの配達待ち行列を内訳の後ろに添える（issue #1133）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-both',
        at: '2026-08-24T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-08-24T00:00:00.000Z',
    );
    h.setQueuedInMemory(7);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ クローンの受信箱に未処理の合図が 1 件ある');
    expect(reply).toContain('メモリの配達待ち行列 7 件');
    expect(reply).toContain('足しても引いても意味が無い');
  });

  it('manager_list は受信箱に未処理があれば、件数と最も古い時刻を1行で出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-1',
        at: '2026-08-24T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-08-24T00:00:00.000Z',
    );
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-2',
        at: '2026-08-24T01:00:00.000Z',
        text: 'もう1件',
        conversationId: 'conv-1',
      },
      '2026-08-24T01:00:00.000Z',
    );

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('受信箱');
    expect(reply).toContain('2 件');
    expect(reply).toContain('2026-08-24T00:00:00.000Z');
    expect(reply).toContain('⚠ クローンの受信箱');
    expect(await h.stores.inbox.pending()).toEqual({
      count: 2,
      oldestAt: '2026-08-24T00:00:00.000Z',
    });
  });

  it('manager_list の受信箱の行に内訳（種類・同一本文・器の入れ替え回数）が付き、本文は載らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-1',
        at: '2026-08-24T00:00:00.000Z',
        text: '絶対に外へ出てはいけない本文XYZ',
        conversationId: 'conv-1',
      },
      '2026-08-24T00:00:00.000Z',
    );
    await h.stores.inbox.put(
      {
        type: 'manager_message',
        id: 'evt-2',
        at: '2026-08-24T01:00:00.000Z',
        managerId: 'mgr-a',
        kind: 'report',
        text: 'これも外へ出てはいけない',
      },
      '2026-08-24T01:00:00.000Z',
    );

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('内訳（計 2 件）');
    expect(reply).toContain('種類:');
    expect(reply).toContain('human_message 1');
    expect(reply).toContain('manager_message 1');
    expect(reply).toContain('同一本文');
    expect(reply).toContain('器の入れ替え回数:');
    expect(reply).toContain('0回＝いまの器になってから積まれた 2');
    expect(reply).not.toContain('配達回数');
    expect(reply).not.toContain('未配達');
    expect(reply).not.toContain('絶対に外へ出てはいけない本文XYZ');
    expect(reply).not.toContain('これも外へ出てはいけない');
    expect(await h.stores.inbox.pending()).toEqual({
      count: 2,
      oldestAt: '2026-08-24T00:00:00.000Z',
    });
  });

  it('manager_list はマネージャーが1本も居なくても、受信箱の滞留があれば出す', async () => {
    const h = harness();
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-1',
        at: '2026-08-24T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-08-24T00:00:00.000Z',
    );

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('マネージャーは1本も居ない');
    expect(reply).toContain('受信箱');
    expect(reply).toContain('1 件');
  });

  it('manager_list は人間起点の滞留を、大きい数字（⚠ クローンの受信箱…）より前に単独の行で出す（#917 (B)）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-human',
        at: '2026-08-24T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-08-24T00:00:00.000Z',
    );
    await h.stores.inbox.put(
      {
        type: 'manager_message',
        id: 'evt-manager',
        at: '2026-08-24T01:00:00.000Z',
        managerId: 'mgr-a',
        kind: 'report',
        text: '終わった',
      },
      '2026-08-24T01:00:00.000Z',
    );

    const reply = await h.call('manager_list', {});
    const lines = reply.split('\n');
    const humanLineIndex = lines.findIndex((line) => line.startsWith('⚠ 人間起点'));
    const bigNumberLineIndex = lines.findIndex((line) => line.startsWith('⚠ クローンの受信箱'));

    expect(humanLineIndex).toBeGreaterThanOrEqual(0);
    expect(bigNumberLineIndex).toBeGreaterThanOrEqual(0);
    expect(humanLineIndex).toBeLessThan(bigNumberLineIndex);

    const humanLine = lines[humanLineIndex]!;
    expect(humanLine).toContain('human_message 1');
    expect(humanLine).toContain('2026-08-24T00:00:00.000Z');
    expect(humanLine).toContain('片付いていない分が 1 件');
    expect(humanLine).not.toContain('manager_message');
    expect(reply).not.toContain('未処理の発言');
  });

  it('manager_list は人間起点の滞留が無ければ、#917 (B) の行を追加しない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.stores.inbox.put(
      {
        type: 'manager_message',
        id: 'evt-manager',
        at: '2026-08-24T01:00:00.000Z',
        managerId: 'mgr-a',
        kind: 'report',
        text: '終わった',
      },
      '2026-08-24T01:00:00.000Z',
    );

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('⚠ 人間起点');
    expect(reply).toContain('⚠ クローンの受信箱');
  });

  it('manager_list は runner の滞留キャッシュが cold なら、その注記を1文字も出さない（0件と嘘をつかない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('未送出');
  });

  it('manager_list は runner の滞留が0件のキャッシュなら、その注記を1文字も出さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setRunnerBacklog([
      { runnerId: 'runner-test', pendingEvents: 0, observedAt: '2026-08-27T00:30:00.000Z' },
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('未送出');
  });

  it('manager_list は runner の滞留があれば、件数・最古の時刻・観測時刻を1行で出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setRunnerBacklog([
      {
        runnerId: 'runner-test',
        pendingEvents: 9,
        oldestPendingAt: '2026-08-20T00:00:00.000Z',
        observedAt: '2026-08-27T00:30:00.000Z',
      },
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('未送出');
    expect(reply).toContain('runner-test');
    expect(reply).toContain('9 件');
    expect(reply).toContain('2026-08-20T00:00:00.000Z');
    expect(reply).toContain('2026-08-27T00:30:00.000Z');
  });

  it('manager_list はマネージャーが1本も居なくても、runner の滞留があれば出す', async () => {
    const h = harness();
    h.setRunnerBacklog([
      {
        runnerId: 'runner-test',
        pendingEvents: 4,
        observedAt: '2026-08-27T00:30:00.000Z',
      },
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('マネージャーは1本も居ない');
    expect(reply).toContain('未送出');
    expect(reply).toContain('4 件');
  });

  describe('runner の滞留の行に、脚（デーモン自身の側の端）の状態を添える', () => {
    it('繋がっている: 「まだ届いていない。届く見込みがある」（待ってよい）。バイトが1つも来ていなければその旨を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('まだ届いていない');
      expect(reply).toContain('待ってよい');
      expect(reply).toContain('2026-08-27T00:00:00.000Z');
      expect(reply).toContain('開いてから1バイトも受け取っていない');
      expect(reply).not.toContain('再接続するまで');
      expect(reply).not.toContain('もう来ない');
    });

    it('繋がっている: バイトを受け取っていれば、その時刻を出す（「繋がっている」と「繋がったまま死んでいる」を同じ文面にしない）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: {
            status: 'connected',
            since: '2026-08-27T00:00:00.000Z',
            lastByteAt: '2026-08-27T00:29:55.000Z',
          },
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('まだ届いていない');
      expect(reply).toContain('2026-08-27T00:00:00.000Z');
      expect(reply).toContain('2026-08-27T00:29:55.000Z');
      expect(reply).not.toContain('開いてから1バイトも受け取っていない');
    });

    it('落ちている: 「⚠ 再接続するまで1件も届かない」に、いつから・理由・次の再試行を添える', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: {
            status: 'down',
            since: '2026-08-27T00:10:00.000Z',
            lastFailureReason: 'runner の /events に繋げない (503)',
            nextRetryAt: '2026-08-27T00:31:00.000Z',
          },
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 再接続するまで1件も届かない');
      expect(reply).toContain('2026-08-27T00:10:00.000Z');
      expect(reply).toContain('runner の /events に繋げない (503)');
      expect(reply).toContain('2026-08-27T00:31:00.000Z');
      expect(reply).not.toContain('待ってよい');
    });

    it('一度も繋がっていない: 「⚠ 再接続するまで1件も届かない」に、その旨を添える', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'never-connected' },
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('⚠ 再接続するまで1件も届かない');
      expect(reply).toContain('一度も繋がっていない');
    });

    it('観測していない（legState を持たない）: 「判定できない」——connected/down のどちらにも倒さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('判定できない');
      expect(reply).not.toContain('まだ届いていない');
      expect(reply).not.toContain('再接続するまで');
      expect(reply).not.toContain('もう来ない');
    });

    it('器が入れ替わった: legState が connected でも「もう来ない」を優先する', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'connected', since: '2026-08-27T00:40:00.000Z' },
          instanceSwapped: true,
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('もう来ない');
      expect(reply).toContain('器が入れ替わった');
      expect(reply).not.toContain('まだ届いていない');
      expect(reply).not.toContain('待ってよい');
    });

    it('器が入れ替わっていない（instanceSwapped: false）: 通常どおり legState を読む', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 3,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
          instanceSwapped: false,
        },
      ]);

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('まだ届いていない');
      expect(reply).not.toContain('もう来ない');
    });
  });

  it('manager_list は runners()（resources() を含む）を一度も呼ばない（往復を増やさない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setRunnerBacklog([
      {
        runnerId: 'runner-test',
        pendingEvents: 9,
        observedAt: '2026-08-27T00:30:00.000Z',
      },
    ]);

    await h.call('manager_list', {});

    expect(h.runnersCalls).toEqual([]);
  });

  it('manager_list の説明文に、warm の契機（runner_list resources: true）と cold が既定であることが読める', () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'manager_list');

    expect(found?.description).toContain('resources: true');
    expect(found?.description).toContain('まだ観測していない');
  });

  it('manager_list の説明文に、10秒ごとの生存確認からも自動で warm することが読める（(b-1) の cold 前提を上書きした証拠）', () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'manager_list');

    expect(found?.description).toContain('生存確認');
    expect(found?.description).toContain('自動');
    expect(found?.description).toContain('呼ばない限り一度も warm しない');
  });

  it('manager_list の説明文に、#572 の ⚠（tool_result 未着 / 閾値なし / 返事待ちには出さない）が読める', () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'manager_list');

    expect(found?.description).toContain('tool_result');
    expect(found?.description).toContain('時刻の閾値は置いていない');
    expect(found?.description).toContain('返事待ちが在るものにはこの行を出さない');
  });

  it('manager_list の説明文に、#579（10秒ごとの生存確認から「セッションが無い」が立つ）が読める', () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'manager_list');

    expect(found?.description).toContain('10秒ごとの生存確認');
    expect(found?.description).toContain('manager_send を');
    expect(found?.description).toContain('待たない');
    expect(found?.description).toContain('done');
  });

  it('委譲先が無い場面（蒸留の内部ターン）は、黙らずにそう返す', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'manager_start');
    const result = await found?.handler({ request: 'x' } as never, {});

    expect(JSON.stringify(result)).toContain('委譲できない');
  });
});

describe('issue #2145: 能力を広げる3つの道具は日誌を先に書く', () => {
  async function callExpectingError(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  }

  async function decisionsOf(stores: Stores): Promise<string[]> {
    return (await stores.journal.list({ types: ['decision'], order: 'asc' })).flatMap((entry) =>
      entry.type === 'decision' ? [entry.decision] : [],
    );
  }

  describe('schedule_create', () => {
    it('(a) 日誌の先書きが落ちると道具はエラーで、依頼は仕込まれない', async () => {
      const stores = failingJournalAppend(createMemoryStores(), 'boom-2145-schedule-a');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'schedule_create', {
        kind: 'watch-2145a',
        request: '依頼A',
        everyMinutes: 30,
      });

      expect(isError).toBe(true);
      expect(await stores.schedules.get('watch-2145a')).toBeNull();
      expect((await stores.schedules.list()).entries).toEqual([]);
    });

    it('(b) 状態変更（editRequest/put）が投げたときは、先の行と打ち消しの行の両方が日誌に残る', async () => {
      const stores = createMemoryStores();
      const throwingStores: Stores = {
        ...stores,
        schedules: {
          ...stores.schedules,
          editRequest: () => {
            throw new Error('schedules store unavailable (test)');
          },
        },
      };
      const tools = createCloneTools({
        stores: throwingStores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'schedule_create', {
        kind: 'watch-2145b',
        request: '依頼B',
        everyMinutes: 30,
      });

      expect(isError).toBe(true);
      expect(await stores.schedules.get('watch-2145b')).toBeNull();
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('定期の依頼を設定しようとしている: watch-2145b: 依頼B');
      expect(decisions[1]).toBe('定期の依頼を設定できなかった: watch-2145b: 依頼B');
    });

    it('(c) 正常系: 行数と文言が合っている（新規作成）', async () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'schedule_create', {
        kind: 'watch-2145c',
        request: '依頼C',
        everyMinutes: 30,
      });

      expect(isError).toBe(false);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('定期の依頼を設定しようとしている: watch-2145c: 依頼C');
      expect(decisions[1]).toBe('定期の依頼を仕込んだ: watch-2145c（30 分ごと）: 依頼C');
    });
  });

  describe('profile_write', () => {
    function fakeRunners(setProfileCalls: { count: number }) {
      return {
        async list() {
          return [
            {
              runnerId: 'runner-2145',
              async setProfile() {
                setProfileCalls.count += 1;
                return { ok: true as const };
              },
            },
          ];
        },
        async get() {
          return null;
        },
        async select() {
          throw new Error('この検証では使わない');
        },
      } as never;
    }

    it('(a) 日誌の先書きが落ちると道具はエラーで、正本は書かれず配られてもいない', async () => {
      const stores = failingJournalAppend(createMemoryStores(), 'boom-2145-profile-a');
      const setProfileCalls = { count: 0 };
      const tools = createCloneTools({
        stores,
        emit: () => {},
        profile: createProfileService({ stores, runners: fakeRunners(setProfileCalls) }),
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'profile_write', {
        script: 'export A=1',
        summary: '(a) の検証',
      });

      expect(isError).toBe(true);
      expect(await stores.profile.list()).toEqual([]);
      expect(setProfileCalls.count).toBe(0);
    });

    it('(b) 状態変更（正本への保存）が投げたときは、先の行と打ち消しの行の両方が日誌に残る', async () => {
      const stores = createMemoryStores();
      const throwingStores: Stores = {
        ...stores,
        profile: {
          ...stores.profile,
          set: () => {
            throw new Error('profile store unavailable (test)');
          },
        },
      };
      const tools = createCloneTools({
        stores: throwingStores,
        emit: () => {},
        profile: createProfileService({ stores: throwingStores }),
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'profile_write', {
        script: 'export A=1',
        summary: '(b) の検証',
      });

      expect(isError).toBe(true);
      expect(await stores.profile.list()).toEqual([]);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('実行環境プロファイルを差し替えようとしている: (b) の検証');
      expect(decisions[1]).toBe('実行環境プロファイルを差し替えられなかった: (b) の検証');
    });

    it('(b2) 打ち消しの行の grounds に、例外の message（params の値）は出ず、名前だけが残る', async () => {
      const stores = createMemoryStores();
      const throwingStores: Stores = {
        ...stores,
        profile: {
          ...stores.profile,
          set: () => {
            throw new TypeError(
              'Failed query: insert into "profile" ("script") values ($1)\nparams: FAKE_SECRET_VALUE_2483',
            );
          },
        },
      };
      const tools = createCloneTools({
        stores: throwingStores,
        emit: () => {},
        profile: createProfileService({ stores: throwingStores }),
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'profile_write', {
        script: 'export A=1',
        summary: '(b2) の検証',
      });

      expect(isError).toBe(true);
      const entries = await stores.journal.list({ types: ['decision'], order: 'asc' });
      const cancel = entries.find(
        (entry) =>
          entry.type === 'decision' &&
          entry.decision.startsWith('実行環境プロファイルを差し替えられなかった'),
      );
      expect(cancel?.type === 'decision' ? cancel.grounds : undefined).toBe(
        '差し替えようとしたが、状態の変更が失敗した: TypeError',
      );
      expect(JSON.stringify(entries)).not.toContain('FAKE_SECRET_VALUE_2483');
    });

    it('(d) 反映も書き戻しも落ちたときは、決定の行が状態どおりになり、「差し替えられなかった」は出ない', async () => {
      const stores = createMemoryStores();
      const throwingStores: Stores = {
        ...stores,
        profile: {
          ...stores.profile,
          replaceAll: () => {
            throw new Error('記憶ストアも落ちている（test）');
          },
        },
      };
      const applier: Parameters<typeof createProfileService>[0]['applier'] = {
        vessel: {} as never,
        fingerprint: () => undefined,
        env: () => ({}),
        async apply(script: string) {
          const prepared = await this.prepare(script);
          if (prepared.ok) await prepared.commit();
          return prepared;
        },
        async prepare() {
          return {
            ok: true,
            names: [],
            commit: async () => {
              throw new Error('器へ移せなかった（test）');
            },
            discard: async () => undefined,
          };
        },
      };
      const tools = createCloneTools({
        stores: throwingStores,
        emit: () => {},
        profile: createProfileService({ stores: throwingStores, applier }),
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'profile_write', {
        script: 'export A=1',
        summary: '(d) の検証',
      });

      expect(isError).toBe(true);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('実行環境プロファイルを差し替えようとしている: (d) の検証');
      expect(decisions[1]).toBe(
        '実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）: (d) の検証',
      );
      expect(decisions[1]).not.toContain('差し替えられなかった');
    });

    it('(c) 正常系: 行数と文言が合っている', async () => {
      const stores = createMemoryStores();
      const setProfileCalls = { count: 0 };
      const tools = createCloneTools({
        stores,
        emit: () => {},
        profile: createProfileService({ stores, runners: fakeRunners(setProfileCalls) }),
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'profile_write', {
        script: 'export A=1',
        summary: '(c) の検証',
      });

      expect(isError).toBe(false);
      expect(setProfileCalls.count).toBe(1);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('実行環境プロファイルを差し替えようとしている: (c) の検証');
      expect(decisions[1]).toBe('実行環境プロファイルを更新した: (c) の検証');
    });
  });

  describe('manager_start', () => {
    it('(a) 日誌の先書きが落ちると道具はエラーで、managers.start は呼ばれない', async () => {
      const stores = failingJournalAppend(createMemoryStores(), 'boom-2145-manager-a');
      let startCalls = 0;
      const managers = {
        async start() {
          startCalls += 1;
          throw new Error('この検証では呼ばれないはず');
        },
      } as unknown as ManagerPool;
      const tools = createCloneTools({
        stores,
        emit: () => {},
        managers,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'manager_start', { request: '調査A' });

      expect(isError).toBe(true);
      expect(startCalls).toBe(0);
    });

    it('(b) 状態変更（managers.start）が投げたときは、先の行と打ち消しの行の両方が日誌に残る', async () => {
      const stores = createMemoryStores();
      const managers = {
        async start() {
          throw new Error('managers.start unavailable (test)');
        },
      } as unknown as ManagerPool;
      const tools = createCloneTools({
        stores,
        emit: () => {},
        managers,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'manager_start', { request: '調査B' });

      expect(isError).toBe(true);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('マネージャーを起こそうとしている: 調査B');
      expect(decisions[1]).toBe('マネージャーを起こせなかった: 調査B');
    });

    it('(c) 正常系: 行数と文言が合っている', async () => {
      const stores = createMemoryStores();
      const managers = {
        async start(input: { request: string; cwd?: string; runnerId?: string }) {
          return {
            managerId: 'mgr-2145-c',
            status: 'running',
            live: true,
            cwd: input.cwd ?? '/work-2145',
            request: input.request,
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            waiting: [],
          };
        },
      } as unknown as ManagerPool;
      const tools = createCloneTools({
        stores,
        emit: () => {},
        managers,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError } = await callExpectingError(tools, 'manager_start', { request: '調査C' });

      expect(isError).toBe(false);
      const decisions = await decisionsOf(stores);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toBe('マネージャーを起こそうとしている: 調査C');
      expect(decisions[1]).toBe(
        'マネージャー mgr-2145-c を起こした（実際の cwd は未確認（頼んだ値: /work-2145））: 調査C',
      );
    });
  });
});

describe('runner_list（器の一覧）', () => {
  it('登録が0台のときも「0台である」と言う（空の出力にしない）', async () => {
    const h = harness();
    h.setRunnersOverview({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('0台');
  });

  it('runner が0台でも、デーモン自身の版は出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [],
      unassigned: [],
      daemonRevision: {
        status: 'known',
        commit: 'e'.repeat(40),
        short: 'e'.repeat(12),
        source: 'build',
      },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('0台');
    expect(reply).toContain('e'.repeat(40));
  });

  it('connected のままでも、pids 飽和の器は材料つきの行を出し、材料の無い器は出さない（#2626）', async () => {
    const h = harness();
    const base = {
      revision: { status: 'unknown' as const },
      state: 'connected' as const,
      since: '2026-01-01T00:00:00.000Z',
      managers: [],
    };
    h.setRunnersOverview({
      runners: [
        {
          ...base,
          label: 'runner-burning',
          runnerId: 'runner-burning',
          pidsSaturation: {
            basis: [
              { kind: 'at-limit', current: 1000, max: 1000 },
              { kind: 'fork-denied', count: 3 },
            ],
            windowMs: 5 * 60_000,
          },
        },
        { ...base, label: 'runner-fine', runnerId: 'runner-fine' },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('pids 飽和: 新しい委譲を置けない');
    expect(reply).toContain('pids 1000/1000 で上限に達している');
    expect(reply).toContain('fork が pids 上限で拒まれた委譲 3 本');
    expect(reply.match(/pids 飽和:/g)?.length).toBe(1);
    expect(h.runnersCalls.at(-1)?.resources).toBeUndefined();
  });

  it('説明文が、飽和の器は自動配置から外れる・全台飽和でも断らない・名指しでも断らないと名乗る（#2626）', () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const list = tools.find((entry) => entry.name === 'runner_list')?.description ?? '';
    const start = tools.find((entry) => entry.name === 'manager_start')?.description ?? '';
    expect(list).toMatch(/pids 飽和[\s\S]*候補から外れる/);
    expect(list).toMatch(/全台が飽和なら断らず/);
    expect(start).toMatch(/名指ししても断らず/);
  });

  it('読めない cursor を渡しても、同じ呼び出しで起きた自動畳みを名乗る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unknown' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
      autoFolded: [
        { managerId: 'mgr-idle', runnerId: 'runner-a', outcome: 'folded', detail: '畳んだ' },
      ],
    });

    const reply = await h.call('runner_list', { cursor: 'this-is-not-a-valid-cursor' });

    expect(reply).toContain('この cursor は読めない');
    expect(reply).toContain('mgr-idle');
    expect(reply).toContain('folded');
  });

  it('デーモンの版と runner の版を、同じ出力に並べて出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: {
        status: 'known',
        commit: 'b'.repeat(40),
        short: 'b'.repeat(12),
        source: 'build',
      },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('a'.repeat(40));
    expect(reply).toContain('b'.repeat(40));
  });

  it('版の「不明」と「未確認」を、別の言葉で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-knows-nothing',
          revision: { status: 'unknown' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-knows-nothing',
          managers: [],
        },
        {
          label: 'runner-silent',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('不明');
    expect(reply).toContain('未確認');
  });

  it('器が1台のときは「分散していない」と読める1行が入る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-only',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-only',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('1台のみ');
    expect(reply).toContain('分散していない');
  });

  it('器が複数台のときも形が崩れない（分散していないとは言わない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [{ managerId: 'mgr-1', status: 'running', live: true }],
        },
        {
          label: 'runner-b',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-b',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('runner-a');
    expect(reply).toContain('runner-b');
    expect(reply).not.toContain('分散していない');
  });

  it('state の5値をそのまま出す（connected へ畳まない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'a',
          revision: { status: 'unheard' },
          state: 'connecting',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'b',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'c',
          revision: { status: 'unheard' },
          state: 'unusable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'd',
          revision: { status: 'unheard' },
          state: 'lost',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-d',
          managers: [],
        },
        {
          label: 'e',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-e',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    for (const state of ['connecting', 'unreachable', 'unusable', 'lost', 'connected']) {
      expect(reply).toContain(`[${state}]`);
    }
  });

  it('器ごとのマネージャー本数を出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [
            { managerId: 'mgr-1', status: 'running', live: true },
            { managerId: 'mgr-2', status: 'done', live: true },
          ],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-1');
    expect(reply).toContain('mgr-2');
    expect(reply).toContain('(2)');
  });

  it('内訳のマネージャーの状態を manager_list と同じ字面で出す（セッション切断を潰さない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [
            { managerId: 'mgr-alive', status: 'running', live: true },
            { managerId: 'mgr-dead', status: 'running', live: false },
          ],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-alive[running]');
    expect(reply).toContain('mgr-dead[running/セッション切断]');
  });

  it('内訳のマネージャーの「背景処理待ち」も manager_list と同じ字面で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [
            {
              managerId: 'mgr-bg',
              status: 'done',
              live: true,
              awaitingBackground: {
                tasks: 3,
                withheldReports: 1,
                breakdown: 'local_agent×3',
                since: '2026-09-05T00:00:00.000Z',
              },
            },
            { managerId: 'mgr-idle', status: 'done', live: true },
          ],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-bg[done/背景処理待ち×3（2026-09-05T00:00:00.000Z から）]');
    expect(reply).toContain('mgr-idle[done]');
  });

  it('説明文が state を実装と同じ値・同じ数で名乗り、vacating が何かを添える', () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const description = tools.find((entry) => entry.name === 'runner_list')?.description ?? '';
    // 6値を書き並べない: 7値目が足されても緑のままになるため
    const states = runnerLivenessSchema.options;
    for (const state of states) {
      expect(
        description,
        `【赤の意味】runnerLivenessSchema に在る state（${state}）が runner_list の説明文に無い。` +
          '実装の enum に値を足したが、説明文がその値を含んでいない',
      ).toContain(state);
    }
    expect(
      description,
      `【赤の意味】説明文が名乗る state の数が、runnerLivenessSchema の値の数（${states.length}）と` +
        '違う。数を書くなら出所から導出すること',
    ).toContain(`state は${states.length}値`);
    expect(description).toContain('意図して空けている最中');
  });

  it('別枠（どの器か分からない）のマネージャーも同じ字面で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [{ managerId: 'mgr-orphan', status: 'running', live: false }],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-orphan[running/セッション切断]');
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず別枠で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [{ managerId: 'mgr-legacy', status: 'done', live: false }],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('どの器か分からない');
    expect(reply).toContain('mgr-legacy');
  });

  it('引数を渡さなければ指紋を出さない（既定で文脈へ載せない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('deadbeef0000');
    expect(reply).not.toContain('cafef00dbabe');
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('引数を渡さなければ、probe が asked/unheard/failed のどれでも新しい行を出さない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentialsProbe: { status: 'failed', error: 'Error: credentials RPC failed (test)' },
          profileProbe: { status: 'unheard' },
          mcpServersProbe: { status: 'unsupported' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('鍵を確かめられなかった');
    expect(reply).not.toContain('プロファイル: 確かめていない');
    expect(reply).not.toContain('MCP の登録: 確かめられない');
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('fingerprints: true を渡すと指紋が出る（方針は設定で開けられる）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          credentialsProbe: { status: 'asked' },
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
          profileProbe: { status: 'asked' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('deadbeef0000');
    expect(reply).toContain('cafef00dbabe');
    expect(h.runnersCalls).toEqual([{ fingerprints: true }]);
  });

  it('fingerprints: true でも繋がっていない（unheard）runner は「確かめていない」と出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
          credentialsProbe: { status: 'unheard' },
          profileProbe: { status: 'unheard' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('鍵: 確かめていない（繋がっていないので聞いていない）');
    expect(reply).toContain('プロファイル: 確かめていない（繋がっていないので聞いていない）');
  });

  it('fingerprints: true で聞いたが失敗した（failed）runner は理由付きで「確かめられなかった」と出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentialsProbe: { status: 'failed', error: 'Error: credentials RPC failed (test)' },
          profileProbe: { status: 'failed', error: 'Error: profile RPC failed (test)' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('鍵を確かめられなかった: Error: credentials RPC failed (test)');
    expect(reply).toContain('プロファイルを確かめられなかった: Error: profile RPC failed (test)');
    expect(reply).not.toContain('鍵の指紋');
    expect(reply).not.toContain('プロファイルの指紋');
  });

  it('pushHealth は fingerprints を渡さなくても出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          pushHealth: {
            profile: { status: 'ok', at: '2026-01-01T00:00:00.000Z' },
            credentials: {
              status: 'failed',
              at: '2026-01-01T00:00:01.000Z',
              error: 'credentials sync failed (test)',
            },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('プロファイル ok');
    expect(reply).toContain('環境変数 失敗');
    expect(reply).toContain('credentials sync failed (test)');
    expect(reply).not.toContain('認証トークン');
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('MCP の登録の名前と指紋（fingerprints: true）と、押し込みの結果が出る', async () => {
    const h = harness();
    const overview = {
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' as const },
          state: 'connected' as const,
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          mcpServers: {
            sha256: 'abc123abc123',
            names: ['github', 'remote'],
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          mcpServersProbe: { status: 'asked' as const },
          pushHealth: {
            mcpServers: {
              status: 'failed' as const,
              at: '2026-01-01T00:00:01.000Z',
              error: 'runner-a は MCP の登録を受け取る口を持たない（古い版の runner）',
            },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' as const },
    };
    h.setRunnersOverview(overview);
    const withFingerprints = await h.call('runner_list', { fingerprints: true });
    expect(withFingerprints).toContain('MCP の登録: github, remote（指紋 abc123abc123）');
    expect(withFingerprints).toContain('MCP の登録 失敗');
    expect(withFingerprints).toContain('受け取る口を持たない');

    h.setRunnersOverview(overview);
    const plain = await h.call('runner_list', {});
    expect(plain).not.toContain('abc123abc123');
    expect(plain).toContain('MCP の登録 失敗');
  });

  it('MCP の登録も、繋がっていない（unheard）ときは「確かめていない」と出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
          mcpServersProbe: { status: 'unheard' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('MCP の登録: 確かめていない（繋がっていないので聞いていない）');
  });

  it('MCP の登録は、口を持たない古い runner（unsupported）だと専用の文言で出る（failed とは別）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          mcpServersProbe: { status: 'unsupported' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('MCP の登録: 確かめられない（この runner は口を持たない。古い版）');
    expect(reply).not.toContain('MCP の登録を確かめられなかった');
  });

  it('MCP の登録を聞いて失敗した（failed）ときは理由付きで「確かめられなかった」と出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          mcpServersProbe: { status: 'failed', error: 'Error: mcpServers RPC failed (test)' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('MCP の登録を確かめられなかった: Error: mcpServers RPC failed (test)');
    expect(reply).not.toContain('確かめられない（この runner は口を持たない');
  });

  it('pushHealth 自体が無い（一度も繋がっていない）runner では、その行が出ない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connecting',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('直近の押し込み');
  });

  it('鍵の指紋が大量でも、抜粋の合図を出して伸び続けない', async () => {
    const h = harness();
    const many = Array.from({ length: 100 }, (_, index) => ({
      name: `TOKEN_${index}`,
      sha256: `sha-${index}`.padEnd(64, '0'),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: many,
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    const line = reply.split('\n').find((entry) => entry.includes('鍵の指紋'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(1_000);
    expect(line).toMatch(/省略/);
  });

  it('resources を渡さなければ既定では pids を出さない（往復を足さない側に倒す）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('872');
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('resources: true を渡すと、読めた器の pids（現在値/上限）が出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('872');
    expect(reply).toContain('1000');
    expect(h.runnersCalls).toEqual([{ resources: true }]);
  });

  it('pids の「言えないこと」は、器が何台でも末尾に1度だけ出る', async () => {
    const h = harness();
    const runner = (label: string, current: number) => ({
      label,
      revision: { status: 'unheard' } as const,
      state: 'connected' as const,
      since: '2026-01-01T00:00:00.000Z',
      runnerId: label,
      managers: [],
      resources: { pids: { current, max: 1000 } },
    });
    h.setRunnersOverview({
      runners: [runner('runner-a', 872), runner('runner-b', 120), runner('runner-c', 4)],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('872');
    expect(reply).toContain('120');
    expect(reply).toContain('4');
    expect(reply.split('器の合計であって内訳ではない')).toHaveLength(2);
  });

  it('resources を渡さなければ、pids の「言えないこと」も出ない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('器の合計であって内訳ではない');
  });

  it('runner に訊けなかった器と、訊けたが pids が読めない器を、別の文言で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-unreachable',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'runner-no-cgroup',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-no-cgroup',
          managers: [],
          resources: {},
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('runner に訊けなかった');
    expect(reply).toContain('読めない器だった');
    expect(reply).not.toContain('undefined');
    expect(reply).not.toContain('pids: 0');
    expect(reply).not.toContain('pids: unknown');
  });

  it('pids が出ない理由を、繋がっていない・失敗した・古い runner で別の文言にし、失敗は理由を載せる', async () => {
    const base = {
      revision: { status: 'unheard' as const },
      since: '2026-01-01T00:00:00.000Z',
      managers: [],
    };
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          ...base,
          label: 'runner-a',
          state: 'unreachable',
          resourcesProbe: { status: 'unheard' },
        },
        {
          ...base,
          label: 'runner-b',
          state: 'connected',
          runnerId: 'runner-b',
          resourcesProbe: { status: 'failed', error: 'Error: resources RPC failed (test)' },
        },
        {
          ...base,
          label: 'runner-c',
          state: 'connected',
          runnerId: 'runner-c',
          resourcesProbe: { status: 'unsupported' },
        },
        {
          ...base,
          label: 'runner-d',
          state: 'connected',
          runnerId: 'runner-d',
          resources: { pids: { current: 12, max: 100 } },
          resourcesProbe: { status: 'asked' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('pids: 確かめていない（繋がっていないので聞いていない）');
    expect(reply).toContain('pids: 訊いたが失敗した: Error: resources RPC failed (test)');
    expect(reply).toContain('pids: 確かめられない（この runner は口を持たない。古い版）');
    expect(reply).toContain('pids: 12 / 100');
    expect(reply).not.toContain('器が開いていない、または応答が無い');
  });

  it('resources.tasks が在れば、pids の内訳（ゾンビ/生存・comm 別・いちばん古いゾンビ）が出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: {
            pids: { current: 955, max: 1000 },
            tasks: {
              threads: 955,
              processes: 815,
              zombies: 779,
              zombieCommands: [
                { command: 'esbuild', count: 375 },
                { command: 'node', count: 214 },
              ],
              oldestZombieSeconds: 69_840,
            },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('pids: 955 / 1000');
    expect(reply).toContain('内訳: ゾンビ 779 / 生存 176（36プロセス）');
    expect(reply).toContain('ゾンビの comm: esbuild 375, node 214');
    expect(reply).toContain('いちばん古いゾンビ: 19時間24分前');
  });

  it('resources.tasks.reclaim が在れば、孤児の候補・走査時 pids・撃った本数が出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: {
            pids: { current: 999, max: 1000 },
            tasks: {
              threads: 999,
              processes: 96,
              zombies: 0,
              reclaim: {
                mode: 'observe',
                candidates: 84,
                candidateThreads: 961,
                oldestAgeSec: 23_040,
                signalled: 0,
                killed: 0,
                freedThreads: 0,
                lastRunAt: 1_767_225_600_000,
                pidsAtScan: { current: 999, max: 1000 },
              },
            },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain(
      '孤児（observe: 終端した委譲の木だけ畳む）: 候補 84 本 / 961 threads（いちばん古い 6時間24分前）' +
        '、走査時 pids 999/1000、送出 0 / 畳み 0 / 返却 0 threads',
    );
    expect(reply).not.toContain('孤児の木');
    expect(reply).not.toContain('孤児の齢');
  });

  it('resources.tasks.reclaim.roots 等が在れば、孤児の木の形と齢の分布が候補の行の下に出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: {
            pids: { current: 999, max: 1000 },
            tasks: {
              threads: 999,
              processes: 96,
              zombies: 0,
              reclaim: {
                mode: 'observe',
                candidates: 409,
                candidateThreads: 900,
                roots: 3,
                largestTreeCandidates: 400,
                singletonTrees: 1,
                medianAgeSec: 23_040,
                ageBuckets: [
                  { upToSec: 60, count: 0 },
                  { upToSec: 600, count: 5 },
                  { upToSec: 3600, count: 12 },
                  { upToSec: 21600, count: 392 },
                  { count: 0 },
                ],
                signalled: 0,
                killed: 0,
                freedThreads: 0,
                lastRunAt: 1_767_225_600_000,
              },
            },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('孤児の木: ルート 3 本 / いちばん大きい木 400 本 / 単独 1 本');
    expect(reply).toContain(
      '孤児の齢（⚠ 起動から。孤児になってからではない）: 中央値 6時間24分前 / ' +
        '1分未満 0 / 10分未満 5 / 1時間未満 12 / 6時間未満 392 / それ以上 0',
    );
    const candidateLineIndex = reply.indexOf('孤児（observe: 終端した委譲の木だけ畳む）');
    const treeLineIndex = reply.indexOf('孤児の木');
    expect(candidateLineIndex).toBeGreaterThanOrEqual(0);
    expect(treeLineIndex).toBeGreaterThan(candidateLineIndex);
  });

  describe('resources.tasks.reclaim.notFired', () => {
    const reclaimBase = {
      mode: 'observe' as const,
      candidates: 5,
      candidateThreads: 9,
      signalled: 0,
      killed: 0,
      freedThreads: 0,
      lastRunAt: 1_767_225_600_000,
    };
    const listWith = async (notFired?: Record<string, unknown>) => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-01-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [],
            resources: {
              pids: { current: 999, max: 1000 },
              tasks: {
                threads: 999,
                processes: 96,
                zombies: 0,
                reclaim: { ...reclaimBase, ...(notFired === undefined ? {} : { notFired }) },
              },
            },
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      } as never);
      return h.call('runner_list', { resources: true });
    };

    it('全部在れば、孤児ルート外・hold・observe の3行が候補の行の下に出る', async () => {
      const reply = await listWith({
        outsideRoots: {
          total: 3,
          parentInScan: 1,
          bySid: {
            wouldFire: 1,
            sidUnknown: 0,
            sidLive: 1,
            sidLeaderPresent: 1,
            sidUnrecognised: 0,
          },
        },
        held: { sidUnknown: 1, sidLive: 1, sidLeaderPresent: 1, sidUnrecognised: 1 },
        observeOnly: 1,
      });

      expect(reply).toContain(
        '孤児ルート外: 3（うち親が生存 1。孤児ルートの部分木に入らず、撃つ判定に掛からない）' +
          '。仮に孤児ルートに入っていたら: 撃つ 1 / sid 不明 0 / sid が live 1 / ' +
          'sid の長が残存 1 / sid 未認識 0',
      );
      expect(reply).toContain(
        'hold（候補のうち撃たなかった理由）: sid 不明 1 / sid が live 1 / ' +
          'sid の長が残存 1 / sid 未認識 1',
      );
      expect(reply).toContain(
        '素性の分からない孤児（委譲が0本のとき sid を問わず撃つ形）で、reclaim でないので撃たなかった: 1',
      );
      expect(reply).not.toContain('判定材料');
      expect(reply).toContain('孤児（observe: 終端した委譲の木だけ畳む');
      expect(reply.indexOf('孤児ルート外')).toBeGreaterThan(
        reply.indexOf('孤児（observe: 終端した委譲の木だけ畳む'),
      );
    });

    it('held / bySid / observeOnly が欄ごと無ければ、0 と書かず「出せない」と1行だけ添える', async () => {
      const reply = await listWith({ outsideRoots: { total: 3, parentInScan: 1 } });

      expect(reply).toContain(
        '孤児ルート外: 3（うち親が生存 1。孤児ルートの部分木に入らず、撃つ判定に掛からない）\n',
      );
      expect(reply).not.toContain('仮に孤児ルートに入っていたら');
      expect(reply).not.toContain('hold（');
      expect(reply).not.toContain(
        '素性の分からない孤児（委譲が0本のとき sid を問わず撃つ形）で、reclaim でないので撃たなかった',
      );
      expect(reply).toContain(
        'hold の内訳: この走査には判定材料（live / 終端済みの sid）が渡っていないので出せない',
      );
    });

    it('held だけ無ければ、hold の行を作らず、在る欄（bySid / observeOnly）は出る', async () => {
      const reply = await listWith({
        outsideRoots: {
          total: 2,
          parentInScan: 0,
          bySid: {
            wouldFire: 2,
            sidUnknown: 0,
            sidLive: 0,
            sidLeaderPresent: 0,
            sidUnrecognised: 0,
          },
        },
        observeOnly: 2,
      });

      expect(reply).toContain('孤児ルート外: 2（うち親が生存 0。');
      expect(reply).toContain('仮に孤児ルートに入っていたら: 撃つ 2 /');
      expect(reply).not.toContain('hold（');
      expect(reply).toContain(
        '素性の分からない孤児（委譲が0本のとき sid を問わず撃つ形）で、reclaim でないので撃たなかった: 2',
      );
    });

    it('notFired 自体が無ければ（古い runner）、3行とも出ない', async () => {
      const reply = await listWith();

      expect(reply).toContain('孤児（observe: 終端した委譲の木だけ畳む）');
      expect(reply).not.toContain('孤児ルート外');
      expect(reply).not.toContain('hold');
      expect(reply).not.toContain('reclaim でないので');
    });
  });

  it('resources.tasks.reclaim が無い回では、孤児の行そのものが出ない（0 本と書かない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: {
            pids: { current: 999, max: 1000 },
            tasks: { threads: 999, processes: 96, zombies: 0 },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('pids: 999 / 1000');
    expect(reply).not.toContain('孤児');
  });

  it('resources.tasks が無い runner では、内訳の行そのものが出ない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-old',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-old',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('pids: 872 / 1000');
    // 4文字の字下げまで含めて否定する: 末尾の注記が同じ語を含むので、語だけだと注記に当たって落ちるため
    expect(reply).not.toContain('内訳:');
    expect(reply).not.toContain('    ゾンビの comm');
    expect(reply).not.toContain('    いちばん古いゾンビ');
  });

  it('ゾンビが0本の tasks では、comm 別集計といちばん古いゾンビの行が出ない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-clean',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-clean',
          managers: [],
          resources: {
            pids: { current: 40, max: 1000 },
            tasks: { threads: 40, processes: 40, zombies: 0 },
          },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('内訳: ゾンビ 0 / 生存 40（40プロセス）');
    expect(reply).not.toContain('    ゾンビの comm');
    expect(reply).not.toContain('    いちばん古いゾンビ');
  });

  describe('runner_list は認証トークンの世代の食い違いを短い印で出す（Issue #914 提案1）', () => {
    it('世代が一致していれば、印を1文字も足さない', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-01-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [
              {
                managerId: 'mgr-1',
                status: 'running',
                live: true,
                tokenGeneration: 3,
                activeTokenGeneration: 3,
              },
            ],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).toContain('mgr-1[running]');
      expect(reply).not.toContain('⚠世代');
    });

    it('世代が食い違っていれば、⚠世代N≠現役M を足す', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-01-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [
              {
                managerId: 'mgr-1',
                status: 'running',
                live: true,
                tokenGeneration: 3,
                activeTokenGeneration: 5,
              },
            ],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).toContain('mgr-1[running] ⚠世代3≠現役5');
    });

    it('材料が無ければ、印を1文字も足さない', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-01-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [{ managerId: 'mgr-1', status: 'running', live: true }],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).toContain('mgr-1[running]');
      expect(reply).not.toContain('⚠世代');
      expect(reply).not.toContain('世代');
    });

    it('理由だけ名乗っていても、tokenGeneration が無ければ印を1文字も足さない', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-01-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [
              {
                managerId: 'mgr-1',
                status: 'running',
                live: true,
                tokenGenerationUnknownReason: 'reattached-across-restart',
              },
            ],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).toContain('mgr-1[running]');
      expect(reply).not.toContain('⚠世代');
      expect(reply).not.toContain('世代');
    });

    it('道具の説明文が ⚠世代N≠現役M の意味を説明する', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'runner_list')?.description;

      expect(description).toContain('⚠世代N≠現役M');
      expect(description).toContain('manager_stop');
    });
  });

  describe('since（この状態になった時刻）', () => {
    it('runner ごとに since を出す', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-09-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).toContain('この状態になった: 2026-09-01T00:00:00.000Z');
    });

    it('「作成」「更新」とは書かない', async () => {
      const h = harness();
      h.setRunnersOverview({
        runners: [
          {
            label: 'runner-a',
            revision: { status: 'unheard' },
            state: 'connected',
            since: '2026-09-01T00:00:00.000Z',
            runnerId: 'runner-a',
            managers: [],
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' },
      });

      const reply = await h.call('runner_list', {});

      expect(reply).not.toContain('作成');
      expect(reply).not.toContain('更新');
    });

    it('道具の説明文が、名簿はインメモリで再起動すると作り直されることを説明する', () => {
      const stores = createMemoryStores();
      const tools = createCloneTools({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });
      const description = tools.find((entry) => entry.name === 'runner_list')?.description;

      expect(description).toContain('インメモリ');
      expect(description).toContain('再起動');
    });
  });
});

describe('manager_list は件数が増えても壊れない', () => {
  async function crowded(count: number): Promise<Harness> {
    const h = harness();
    for (let index = 0; index < count; index += 1) {
      await h.call('manager_start', { request: `依頼${index}: ${'あ'.repeat(1500)}` });
    }
    for (const summary of h.running) summary.lastReport = `報告: ${'ほ'.repeat(3000)}`;
    return h;
  }

  it('マネージャーが増えても既定の出力は上限内に収まる', async () => {
    const few = await crowded(3);
    const many = await crowded(120);

    const small = await few.call('manager_list', {});
    const big = await many.call('manager_list', {});

    expect(big.length).toBeLessThan(12_000);
    expect(small.length).toBeLessThan(12_000);
  });

  it('切ったことを黙らない（何文字省いたか・全部で何件かが出力に出る）', async () => {
    const h = await crowded(120);

    const reply = await h.call('manager_list', {});

    expect(reply).toMatch(/省略/);
    expect(reply).toMatch(/全\s*\d[\d,]*\s*文字/);
    expect(reply).toContain('120');
    expect(reply).toContain('manager_report');
  });

  it('manager_report は報告の全文を返し、長ければ続きの取り方を示す', async () => {
    const h = await crowded(2);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('報告: ほ');
    if (!reply.includes('ほ'.repeat(3000))) {
      expect(reply).toMatch(/省略|続き/);
      expect(reply).toMatch(/offset/);
    }
  });

  it('居ないマネージャーを聞かれたら黙らずにそう返す', async () => {
    const h = await crowded(1);

    const reply = await h.call('manager_report', { managerId: 'mgr-999' });

    expect(reply).toContain('mgr-999');
  });
});

describe('manager_list は走行中・返事待ちを窓から落とさない（#688 の3）', () => {
  const NEWEST = Date.parse('2026-09-07T12:00:00.000Z');
  const minutesBefore = (minutes: number) => new Date(NEWEST - minutes * 60_000).toISOString();

  function entry(
    managerId: string,
    status: JobStatus,
    startedAt: string,
    live = status === 'running' || status === 'waiting_human',
  ): ManagerSummary {
    return {
      managerId,
      status,
      live,
      cwd: '/workspace/repo',
      request: `依頼 ${managerId}: ${'あ'.repeat(400)}`,
      startedAt,
      updatedAt: startedAt,
      waiting: [],
      runnerId: 'runner-test',
    };
  }

  function flooded(options: { terminal: number; inFlight: readonly JobStatus[] }): Harness {
    const h = harness();
    for (let index = 0; index < options.terminal; index += 1) {
      h.running.push(
        entry(`mgr-done-${String(index).padStart(4, '0')}`, 'done', minutesBefore(index), false),
      );
    }
    options.inFlight.forEach((status, index) => {
      h.running.push(
        entry(`mgr-live-${String(index).padStart(2, '0')}`, status, minutesBefore(10_000 + index)),
      );
    });
    return h;
  }

  it('終端が大量に溜まっても、走行中・返事待ちは必ず本文に出る', async () => {
    const h = flooded({ terminal: 60, inFlight: ['running', 'waiting_human', 'running'] });

    const reply = await h.call('manager_list', {});

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    for (const id of ['mgr-live-00', 'mgr-live-01', 'mgr-live-02']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-live-00')).toBeLessThan(reply.indexOf('mgr-done-0000'));
  });

  it('省略の断り書きは、実装が実際にやっている並びを言う（「走っているものから順に」は嘘だった）', async () => {
    const h = flooded({ terminal: 60, inFlight: ['running'] });

    const reply = await h.call('manager_list', {});

    expect(reply).toMatch(/…ほか \d+ 件は省略（全 61 件）。走行中・返事待ちを先に出し/);
    expect(reply).not.toContain('走っているものから順に出している');
  });

  it('status の絞りは文字数の予算（LIST_BUDGET）より前に効く——#418 と同じ形の穴を作らない', async () => {
    const h = flooded({ terminal: 60, inFlight: ['running', 'running'] });

    const reply = await h.call('manager_list', { status: ['running'] });

    expect(reply).toContain('mgr-live-00');
    expect(reply).toContain('mgr-live-01');
    expect(reply).not.toContain('mgr-done-');
    expect(reply).not.toMatch(/…ほか \d+ 件は省略/);
  });

  it('絞ったときの省略の断り書きは、絞った後の件数だと分かる形で言う', async () => {
    const h = flooded({
      terminal: 20,
      inFlight: Array.from({ length: 40 }, (): JobStatus => 'running'),
    });

    const reply = await h.call('manager_list', { status: ['running'] });

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('status: running に絞った 40 件のうち');
    expect(reply).not.toContain('全 60 件');
  });

  it('件数の行は絞る前の全件を出す（絞ったせいで全体の実像が消えない）', async () => {
    const h = flooded({ terminal: 5, inFlight: ['running'] });

    const reply = await h.call('manager_list', { status: ['running'] });

    expect(reply).toContain('件数: 全 6 本');
    expect(reply).toContain('絞り込み: status: running に当たるのは 1 件');
    expect(reply).not.toContain('mgr-done-');
  });

  it('status: [] は絞らない（0件へ倒さない）。ただし黙って無視せず、絞らなかったと言う', async () => {
    const h = flooded({ terminal: 3, inFlight: ['running'] });

    const empty = await h.call('manager_list', { status: [] });
    const plain = await h.call('manager_list', {});

    expect(empty).toContain('mgr-live-00');
    expect(empty).toContain('mgr-done-0000');
    expect(empty).not.toContain('絞り込みに当たる委譲は無い');
    expect(empty).not.toMatch(/status:\s*に絞った/);
    expect(empty).toContain('絞り込み: status に空の配列が渡ったので、絞らずに全件を出した');
    expect(
      empty
        .split('\n')
        .filter((line) => !line.startsWith('絞り込み:'))
        .join('\n'),
    ).toBe(plain);
  });

  it('絞った結果が0件なのと、委譲が1本も居ないのを混ぜない', async () => {
    const h = flooded({ terminal: 3, inFlight: [] });

    const reply = await h.call('manager_list', { status: ['waiting_human'] });

    expect(reply).toContain('この status の絞り込みに当たる委譲は無い');
    expect(reply).not.toContain('マネージャーは1本も居ない');
    expect(reply).toContain('件数: 全 3 本');
  });

  it('status を渡さない呼びは、絞り込みの注記が付かないだけで他と同じものを出す', async () => {
    const h = flooded({ terminal: 3, inFlight: ['running'] });

    const plain = await h.call('manager_list', {});
    const all = await h.call('manager_list', {
      status: ['running', 'waiting_human', 'done', 'failed', 'lost', 'stopped'],
    });

    expect(plain).not.toContain('絞り込み');
    expect(plain).not.toMatch(/…ほか \d+ 件は省略/);
    const note = all.split('\n').find((line) => line.startsWith('絞り込み: status:'));
    expect(note, '絞ったのに注記が無い').toBeDefined();
    expect(
      all
        .split('\n')
        .filter((line) => line !== note)
        .join('\n'),
    ).toBe(plain);
  });
});

describe('manager_list は lost を判断待ちの群として窓に入れる（#688）', () => {
  const NEWEST = Date.parse('2026-09-07T12:00:00.000Z');
  const minutesBefore = (minutes: number) => new Date(NEWEST - minutes * 60_000).toISOString();

  function entry(managerId: string, status: JobStatus, minutesAgo: number): ManagerSummary {
    return {
      managerId,
      status,
      live: status === 'running' || status === 'waiting_human',
      cwd: '/workspace/repo',
      request: `依頼 ${managerId}: ${'あ'.repeat(400)}`,
      startedAt: minutesBefore(minutesAgo),
      updatedAt: minutesBefore(minutesAgo),
      waiting: [],
      runnerId: 'runner-test',
    };
  }

  function pool(entries: readonly ManagerSummary[]): Harness {
    const h = harness();
    for (const item of [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      h.running.push(item);
    }
    return h;
  }

  it('⭐ 終端が大量に溜まっても、lost は必ず本文に出る（古い側に置いても落ちない）', async () => {
    const terminal = Array.from({ length: 60 }, (_, index) =>
      entry(
        `mgr-term-${String(index).padStart(4, '0')}`,
        index % 2 === 0 ? 'done' : 'failed',
        index,
      ),
    );
    const lost = Array.from({ length: 3 }, (_, index) =>
      entry(`mgr-lost-${String(index).padStart(2, '0')}`, 'lost', 20_000 + index),
    );
    const h = pool([...terminal, ...lost]);

    const reply = await h.call('manager_list', {});

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    for (const id of ['mgr-lost-00', 'mgr-lost-01', 'mgr-lost-02']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply, 'mgr-term-0001 が窓の外へ落ち、群の順序を測れていない').toContain(
      'mgr-term-0001',
    );
    expect(reply.indexOf('mgr-lost-00')).toBeLessThan(reply.indexOf('mgr-term-0001'));
  });

  it('走行中・返事待ちは lost より先に出る（lost を新しい側に置いても順序が逆にならない）', async () => {
    const lost = Array.from({ length: 3 }, (_, index) =>
      entry(`mgr-lost-${String(index).padStart(2, '0')}`, 'lost', index),
    );
    const terminal = Array.from({ length: 60 }, (_, index) =>
      entry(`mgr-term-${String(index).padStart(4, '0')}`, 'done', 1_000 + index),
    );
    const inFlight = (['running', 'waiting_human'] as const).map((status, index) =>
      entry(`mgr-live-${String(index).padStart(2, '0')}`, status, 30_000 + index),
    );
    const h = pool([...lost, ...terminal, ...inFlight]);

    const reply = await h.call('manager_list', {});

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    for (const id of ['mgr-live-00', 'mgr-live-01', 'mgr-lost-00', 'mgr-term-0000']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-live-00')).toBeLessThan(reply.indexOf('mgr-lost-00'));
    expect(reply.indexOf('mgr-live-01')).toBeLessThan(reply.indexOf('mgr-lost-00'));
    expect(reply.indexOf('mgr-lost-00')).toBeLessThan(reply.indexOf('mgr-term-0000'));
  });

  it('件数の行が lost の本数と、名指しの引き方を出す', async () => {
    const h = pool([
      entry('mgr-lost-00', 'lost', 10),
      entry('mgr-lost-01', 'lost', 11),
      entry('mgr-done-00', 'done', 12),
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 3 本');
    expect(reply).toContain('戻れなかった(lost) 2 本');
    expect(reply).toContain('「戻れなかった(lost)」は「終わった」ではない');
    expect(reply).toContain('status: ["lost"]');
    expect(reply).toContain('確かめる前に manager_start で起こし直さないこと');
  });

  it('⭐ lost が 0 本なら件数の行にも断り書きにも1文字も出ない（0 の行を作らない）', async () => {
    const h = pool([entry('mgr-done-00', 'done', 10), entry('mgr-fail-00', 'failed', 11)]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 2 本');
    expect(reply).not.toContain('戻れなかった(lost)');
    expect(reply).not.toContain('status: ["lost"]');
  });

  it('件数の行が、lost の外に残る2つ（running のまま・done のまま）へ辿る綴りを出す', async () => {
    const h = pool([entry('mgr-lost-00', 'lost', 10), entry('mgr-done-00', 'done', 11)]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('lost を全部確かめても、落ちた委譲を全部見たことにはならない');
    expect(reply).toContain('status: ["running"]');
    expect(reply).toContain('status: ["done"]');
  });

  it('⭐ lost が 0 本なら、器が黙った委譲や失敗で終わった委譲が在っても辿る綴りは出ない', async () => {
    const orphaned = entry('mgr-run-00', 'running', 10);
    orphaned.runnerLostSince = minutesBefore(5);
    const failed = entry('mgr-done-00', 'done', 11);
    failed.lastFailure = { code: 'success/429', via: 'result_is_error', at: minutesBefore(6) };
    const h = pool([orphaned, failed]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 2 本');
    expect(reply).toContain('宛先の器が名乗らなくなった 1 本');
    expect(reply).not.toContain('落ちた委譲を全部見たことにはならない');
    expect(reply).not.toContain('status: ["running"]');
    expect(reply).not.toContain('status: ["done"]');
  });

  it('件数の行が「枠(利用上限)で止まっている」本数と、横断する軸である断りを出す', async () => {
    const running = entry('mgr-run-00', 'running', 10);
    running.usageStoppedAt = minutesBefore(3);
    const done = entry('mgr-done-00', 'done', 11);
    done.usageStoppedAt = minutesBefore(4);
    const healthy = entry('mgr-done-01', 'done', 12);
    const h = pool([running, done, healthy]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 3 本');
    expect(reply).toContain('枠(利用上限)で止まっている 2 本');
    expect(reply).toContain('status の分割ではなく横断する軸である');
    expect(reply).toContain('上の内訳には足し合わせない');
    expect(reply).toContain('名指しで絞る綴りは無い');
    expect(reply).toContain('この一覧の各行に付く注記');
  });

  it('⭐ 枠(利用上限)で止まっている委譲が0本なら件数の行にも断り書きにも1文字も出ない', async () => {
    const h = pool([entry('mgr-done-00', 'done', 10), entry('mgr-fail-00', 'failed', 11)]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 2 本');
    expect(reply).not.toContain('枠(利用上限)で止まっている');
    expect(reply).not.toContain('横断する軸である');
  });

  it('件数の行が「宛先の runner が名簿から消えている」本数と、横断する軸である断りを出す', async () => {
    const running1 = entry('mgr-run-00', 'running', 10);
    running1.runnerVanished = true;
    const running2 = entry('mgr-run-01', 'running', 11);
    running2.runnerVanished = true;
    const healthy = entry('mgr-run-02', 'running', 12);
    const h = pool([running1, running2, healthy]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 3 本');
    expect(reply).toContain('宛先の runner が名簿から消えている 2 本');
    expect(reply).toContain('他の区分とは足し合わせない');
    expect(reply).toContain('status の分割ではなく横断する軸である');
    expect(reply).toContain('名指しで絞る綴りは無い');
    expect(reply).toContain('この一覧の各行に付く注記');
  });

  it('⭐ 宛先の runner が名簿から消えている委譲が0本なら件数の行にも断り書きにも1文字も出ない', async () => {
    const h = pool([entry('mgr-done-00', 'done', 10), entry('mgr-fail-00', 'failed', 11)]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('件数: 全 2 本');
    expect(reply).not.toContain('宛先の runner が名簿から消えている');
  });

  it('⭐ lost が 0 本でも、runnerVanished が在れば辿る綴りが出る（#1414 が running 側に作らなかった穴）', async () => {
    const running = entry('mgr-run-00', 'running', 10);
    running.runnerVanished = true;
    const healthy = entry('mgr-run-01', 'running', 11);
    const h = pool([running, healthy]);

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('戻れなかった(lost)');
    expect(reply).toContain('宛先の runner が名簿から消えている 1 本');
    expect(reply).toContain('この一覧の各行に付く注記');
    expect(reply).toContain('確かめる前に manager_start で起こし直さないこと');
  });
});

describe('manager_list（絞った先）に継続点（cursor）を足す（#662 段1）', () => {
  const NEWEST = Date.parse('2026-09-10T12:00:00.000Z');
  const minutesBefore = (minutes: number) => new Date(NEWEST - minutes * 60_000).toISOString();

  function entry(managerId: string, status: JobStatus, minutesAgo: number): ManagerSummary {
    return {
      managerId,
      status,
      live: status === 'running' || status === 'waiting_human',
      cwd: '/workspace/repo',
      request: `依頼 ${managerId}: ${'あ'.repeat(400)}`,
      startedAt: minutesBefore(minutesAgo),
      updatedAt: minutesBefore(minutesAgo),
      waiting: [],
      runnerId: 'runner-test',
    };
  }

  function pool(entries: readonly ManagerSummary[]): Harness {
    const h = harness();
    for (const item of [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      h.running.push(item);
    }
    return h;
  }

  function extractCursor(reply: string): string {
    const match = /cursor=([A-Za-z0-9\-_]+)/.exec(reply);
    if (!match) throw new Error(`cursor が案内に無い: ${reply}`);
    return match[1]!;
  }

  it('status で絞った先が予算で切れたら、断り書きが cursor= を案内する', async () => {
    const running = Array.from({ length: 40 }, (_, index) =>
      entry(`mgr-run-${index}`, 'running', index),
    );
    const h = pool(running);

    const reply = await h.call('manager_list', { status: ['running'] });

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('cursor=');
    expect(reply).toMatch(/続きは manager_list cursor=[A-Za-z0-9\-_]+/);
  });

  it('cursor を辿ると、絞った先の全 managerId に到達できる（Issue の主題そのもの）', async () => {
    const running = Array.from({ length: 40 }, (_, index) =>
      entry(`mgr-run-${index}`, 'running', index),
    );
    const h = pool(running);
    const ids = running.map((m) => m.managerId);

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let guard = 0; guard < ids.length + 1; guard += 1) {
      const reply: string = await h.call(
        'manager_list',
        cursor === undefined ? { status: ['running'] } : { status: ['running'], cursor },
      );
      for (const id of ids) {
        if (reply.includes(id)) seen.add(id);
      }
      if (!reply.includes('cursor=')) break;
      cursor = extractCursor(reply);
    }

    for (const id of ids) {
      expect(seen, `${id} に到達できなかった（絞った先で迷子）`).toContain(id);
    }
  });

  it('群の順序は cursor をまたいでも保たれる（走行中・返事待ちは最初の頁に出る）', async () => {
    const inFlight = (['running', 'waiting_human'] as const).map((status, index) =>
      entry(`mgr-live-${index}`, status, 30_000 + index),
    );
    const lost = Array.from({ length: 3 }, (_, index) =>
      entry(`mgr-lost-${index}`, 'lost', 1_000 + index),
    );
    const terminal = Array.from({ length: 40 }, (_, index) =>
      entry(`mgr-term-${index}`, 'done', index),
    );
    const h = pool([...inFlight, ...lost, ...terminal]);

    const first = await h.call('manager_list', {});

    expect(first).toMatch(/…ほか \d+ 件は省略/);
    for (const id of ['mgr-live-0', 'mgr-live-1', 'mgr-lost-0', 'mgr-term-0']) {
      expect(first, `${id} が1頁目の窓の外へ落ちた`).toContain(id);
    }
    expect(first.indexOf('mgr-live-0')).toBeLessThan(first.indexOf('mgr-lost-0'));
    expect(first.indexOf('mgr-lost-0')).toBeLessThan(first.indexOf('mgr-term-0'));
  });

  it('status を変えて cursor を渡すと status-mismatch の明示のエラーになる（黙って倒れない）', async () => {
    const running = Array.from({ length: 40 }, (_, index) =>
      entry(`mgr-run-${index}`, 'running', index),
    );
    const h = pool(running);

    const first = await h.call('manager_list', { status: ['running'] });
    const cursor = extractCursor(first);

    const reply = await h.call('manager_list', { cursor });

    expect(reply).toContain('食い違う');
    expect(reply).toContain('status');
  });

  it('壊れた cursor は明示のエラーで、黙って先頭からへ倒さない', async () => {
    const h = pool([entry('mgr-run-0', 'running', 0)]);

    const reply = await h.call('manager_list', { cursor: 'this-is-not-a-real-cursor' });

    expect(reply).toContain('cursor が壊れている');
    expect(reply).not.toContain('mgr-run-0');
  });

  it('母数は頁をまたいでも変わらない', async () => {
    const running = Array.from({ length: 40 }, (_, index) =>
      entry(`mgr-run-${index}`, 'running', index),
    );
    const h = pool(running);

    const first = await h.call('manager_list', { status: ['running'] });
    const cursor = extractCursor(first);
    const second = await h.call('manager_list', { status: ['running'], cursor });

    expect(first).toContain('status: running に絞った 40 件のうち');
    if (second.includes('…ほか')) {
      expect(second).toContain('status: running に絞った 40 件のうち');
    }
  });
});

describe('manager_report: 報告が空のとき、生ログを見て言い分ける（#323）', () => {
  function assistantLine(
    text: string,
    options: { timestamp?: string; isSidechain?: boolean; stopReason?: string } = {},
  ) {
    return JSON.stringify({
      type: 'assistant',
      isSidechain: options.isSidechain ?? false,
      timestamp: options.timestamp ?? '2026-08-26T20:31:59.107Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
      },
    });
  }

  it('part: request では生ログを見ない（往復を無条件に増やさない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.running[0]!.request = '';
    h.setTranscript('mgr-1', assistantLine('この本文は part=request では見に行かれないはず'));

    const reply = await h.call('manager_report', { managerId: 'mgr-1', part: 'request' });

    expect(reply).toContain('依頼文が記録に無い');
    expect(h.transcriptCalls).toEqual([]);
  });

  it('生ログにも本文が無いとき「まだ無い」のままで、⚠は出さない（本文の無い assistant 行だけの生ログ）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const noBodyTranscript = [
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        timestamp: '2026-08-26T20:00:00.000Z',
        message: { role: 'user', content: 'ping' },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-08-26T20:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
        },
      }),
    ].join('\n');
    h.setTranscript('mgr-1', noBodyTranscript);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('まだ無い');
    expect(reply).toContain('生ログにも本文は無い');
    expect(reply).not.toContain('⚠');
    expect(reply).not.toContain('配られていない');
  });

  it('生ログの最後の発言が end_turn で終わっているとき「⚠ 配られていない」と、timestamp・文字数・manager_transcript の案内を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const reportBody = '生成されたのに配られなかった報告の全文（テスト用）';
    const transcript = [
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        timestamp: '2026-08-26T20:30:00.000Z',
        message: { role: 'user', content: 'ping' },
      }),
      assistantLine(reportBody, { timestamp: '2026-08-26T20:31:59.107Z', stopReason: 'end_turn' }),
    ].join('\n');
    h.setTranscript('mgr-1', transcript);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('⚠');
    expect(reply).toContain('配られていない');
    expect(reply).toContain('#323');
    expect(reply).toContain('2026-08-26T20:31:59.107Z');
    expect(reply).toMatch(new RegExp(`約\\s*${reportBody.length}\\s*文字`));
    expect(reply).toContain('manager_transcript managerId=mgr-1 offset=');
    expect(reply).not.toContain(reportBody);
  });

  it('生ログの最後の発言が end_turn ではない（ターン途中）とき、断定しない——⚠ も #323 も付けない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const midTurnBody = 'これから道具を呼ぶ前の語り（ターンはまだ終わっていない）';
    const transcript = [
      assistantLine(midTurnBody, { timestamp: '2026-08-26T20:31:59.107Z', stopReason: 'tool_use' }),
    ].join('\n');
    h.setTranscript('mgr-1', transcript);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).not.toContain('⚠');
    expect(reply).not.toContain('#323');
    expect(reply).toContain('2026-08-26T20:31:59.107Z');
    expect(reply).toContain('stop_reason=tool_use');
    expect(reply).toContain('まだ終わっていない');
    expect(reply).not.toContain(midTurnBody);
  });

  it('生ログの最後の発言に stop_reason 欄が無いとき、終わっているかどちらとも名乗らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const unknownBody = '古い形式か何かで stop_reason が欠けている行';
    const transcript = [assistantLine(unknownBody, { timestamp: '2026-08-26T20:33:00.000Z' })].join(
      '\n',
    );
    h.setTranscript('mgr-1', transcript);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).not.toContain('⚠');
    expect(reply).not.toContain('#323');
    expect(reply).not.toContain('まだ終わっていない');
    expect(reply).toContain('2026-08-26T20:33:00.000Z');
    expect(reply).toContain('判定できなかった');
    expect(reply).toMatch(/stop_reason.*無い/);
    expect(reply).not.toContain(unknownBody);
  });

  it('作業者（サブエージェント）の発言は混ぜない（isSidechain: true の行は無視する）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const workerOnly = [
      assistantLine('これは作業者の発言（サブエージェント）', { isSidechain: true }),
    ].join('\n');
    h.setTranscript('mgr-1', workerOnly);

    const workerOnlyReply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(workerOnlyReply).not.toContain('⚠');
    expect(workerOnlyReply).toContain('生ログにも本文は無い');

    const withManagerLine = [
      assistantLine('マネージャー自身の発言', {
        timestamp: '2026-08-26T20:32:10.000Z',
        stopReason: 'end_turn',
      }),
      workerOnly,
    ].join('\n');
    h.setTranscript('mgr-1', withManagerLine);

    const foundReply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(foundReply).toContain('⚠');
    expect(foundReply).toContain('2026-08-26T20:32:10.000Z');
  });

  it('生ログが読めなかったとき「無い」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscriptFailure('mgr-1', 'ECONNRESET（テスト用）');

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('読めなかった');
    expect(reply).toContain('ECONNRESET');
    expect(reply).not.toContain('生ログにも本文は無い');
    expect(reply).not.toContain('⚠');
  });

  it('生ログが読めなかった理由の、2行目以降の値と URL の資格は応答へ出さない（#2468）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscriptFailure(
      'mgr-1',
      'Failed query: select 1\nparams: FAKE_SECRET_VALUE_2468 postgres://u:FAKE_SECRET_VALUE_2468@h/db',
    );

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('生ログは読めなかった（');
    expect(reply).toContain('Failed query');
    expect(reply).not.toContain('FAKE_SECRET_VALUE_2468');
  });

  it('上限（REPORT_GENERATED_PROBE_CHARS）まで遡っても見つからなかったら「見つからなかった」であって「無い」ではない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const huge = 'x'.repeat(250_000);
    h.setTranscript('mgr-1', huge);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('まだ無い');
    expect(reply).toMatch(/遡った/);
    expect(reply).not.toContain('生ログにも本文は無い');
    expect(reply).not.toContain('⚠');
    expect(reply).not.toContain('配られていない');
  });
});

describe('manager_transcript（生ログへ降りる）', () => {
  it('生ログの全文へ降りられる（lastReport の抜粋ではなく transcript() の中身が返る）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running)
      summary.lastReport = '要約された最終報告（これは生ログではない）';
    h.setTranscript('mgr-1', '{"type":"user","text":"生ログにしか無い中身"}');

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('生ログにしか無い中身');
    expect(reply).not.toContain('要約された最終報告');
  });

  it('切ったことが呼び手に届く', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = 'x'.repeat(9_000);
    h.setTranscript('mgr-1', body);
    for (const summary of h.running) summary.lastReport = body;

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toMatch(/省略|文字目/);
    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
  });

  it('offset で続きが取れる', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    // offset は 8,000（`TRANSCRIPT_PAGE`）を直接使う: 前の応答の「続きの取り方」の文言から抜き出すと、tail の文言のテストと分離しなくなるため
    const body = `${'a'.repeat(8_000)}TAIL-MARK`;
    h.setTranscript('mgr-1', body);
    for (const summary of h.running) summary.lastReport = body;

    const first = await h.call('manager_transcript', { managerId: 'mgr-1' });
    expect(first).not.toContain('TAIL-MARK');

    const second = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      offset: 8_000,
    });
    expect(second).toContain('TAIL-MARK');
  });

  it('3段のどこにも無いとき「無い」と言う（黙って空を返さない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toContain('無い');
    expect(reply).toMatch(/runner/);
    expect(reply).toMatch(/アーカイブ/);
  });

  it('退避から読めた本文には archive id が添う（archive_remove で消せるように）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscript('mgr-1', '退避から読んだ本文', 'mgr-1-archived-0001.jsonl');

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('退避から読んだ本文');
    expect(reply).toContain('mgr-1-archived-0001.jsonl');
    expect(reply).toContain('archive_remove');
  });

  it('archive id が無い（走行中の runner 等から読めた）ときは archive_remove の案内を出さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscript('mgr-1', '走行中の runner から読んだ本文');

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('走行中の runner から読んだ本文');
    expect(reply).not.toContain('archive_remove');
  });

  it('本文が消されている（tombstone）ときは、missing とは別の文言で言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscriptRemoved('mgr-1', {
      archiveId: 'mgr-1-removed-0001.jsonl',
      removedAt: '2026-01-02T00:00:00.000Z',
      bytes: 123,
    });

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('消されている');
    expect(reply).toContain('mgr-1-removed-0001.jsonl');
    expect(reply).toContain('123');
    expect(reply).not.toContain('3段のどこにも見当たらなかった');
  });

  it('manager_report の出力から生ログへの降り方が読める', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running) summary.lastReport = '短い報告';

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('manager_transcript');
  });

  describe('生ログが無いとき、脚の状態から「まだ引き渡していない」と「引き渡せずに消えた」を言い分ける（#634）', () => {
    it('器が入れ替わった後（instanceSwapped: true）: 「引き渡せずに消えた可能性が高い」', async () => {
      const h = harness();
      await h.call('manager_start', { request: '調べて' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 7,
          oldestPendingAt: '2026-08-27T00:10:00.000Z',
          observedAt: '2026-08-27T00:30:00.000Z',
          instanceIdAtObservation: 'instance-old',
          instanceSwapped: true,
        },
      ]);

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('引き渡せずに消えた可能性が高い');
      expect(reply).toContain('7 件');
      expect(reply).toContain('runner-test');
      expect(reply).toContain('archive が含まれていたかもここからは言えない');
      expect(reply).toContain('区別できない');
    });

    it('脚は在るが滞留している（pendingEvents > 0、入れ替わっていない）: 「まだ引き渡していない可能性がある」', async () => {
      const h = harness();
      await h.call('manager_start', { request: '調べて' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 4,
          oldestPendingAt: '2026-08-27T00:10:00.000Z',
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
        },
      ]);

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('まだ引き渡していない可能性がある');
      expect(reply).toContain('4 件');
      expect(reply).toContain('まだ届いていない。届く見込みがある');
      expect(reply).not.toContain('引き渡せずに消えた');
    });

    it('脚が落ちている（down）ときも「まだ引き渡していない可能性がある」側だが、再接続待ちであることが読める', async () => {
      const h = harness();
      await h.call('manager_start', { request: '調べて' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 2,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'down', since: '2026-08-27T00:10:00.000Z' },
        },
      ]);

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('まだ引き渡していない可能性がある');
      expect(reply).toContain('⚠ 再接続するまで1件も届かない');
    });

    it('どちらとも言えない（runnerBacklog に材料が無い）: 「判定できない」', async () => {
      const h = harness();
      await h.call('manager_start', { request: '調べて' });

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('判定できない');
      expect(reply).not.toContain('引き渡せずに消えた可能性が高い');
      expect(reply).not.toContain('まだ引き渡していない可能性がある');
    });

    it('どちらとも言えない（観測できた滞留が0件）: 0件を「引き渡し済み」の証拠にしない', async () => {
      const h = harness();
      await h.call('manager_start', { request: '調べて' });
      h.setRunnerBacklog([
        {
          runnerId: 'runner-test',
          pendingEvents: 0,
          observedAt: '2026-08-27T00:30:00.000Z',
          legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
        },
      ]);

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('判定できない');
    });

    it('runnerId 自体が取れない（この委譲に runner が割り当てられた像を持たない）: 「判定できない」', async () => {
      const h = harness();
      h.setAutoRunnerId(undefined);
      await h.call('manager_start', { request: '調べて' });

      const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

      expect(reply).toContain('判定できない');
    });
  });
});

describe('manager_transcript（生ログを絞る。#2188）', () => {
  const assistantLine = (extra: string) =>
    `{"type":"assistant","timestamp":"2026-01-01T10:00:00.000Z"${extra}}`;

  it('4つの絞り（since/until/type/contains）を1つも渡さないと、出力は絞り機能を足す前と1文字も変わらない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = [assistantLine(',"stop_reason":"tool_use"'), '{"type":"user"}'].join('\n');
    h.setTranscript('mgr-1', body);

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toBe(`マネージャー mgr-1 の生ログ（全 ${body.length} 文字）\n\n${body}`);
    expect(reply).not.toContain('絞り込み');
  });

  it('since/until の窓で絞ると「全X行のうちY行が当たった」が先頭に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = [
      '{"type":"a","timestamp":"2026-01-01T09:00:00.000Z"}',
      '{"type":"b","timestamp":"2026-01-01T10:00:00.000Z"}',
      '{"type":"c","timestamp":"2026-01-01T11:00:00.000Z"}',
    ].join('\n');
    h.setTranscript('mgr-1', body);

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      since: '2026-01-01T10:00:00.000Z',
      until: '2026-01-01T11:00:00.000Z',
    });

    expect(reply).toContain('絞り込み: 全 3 行のうち 1 行が当たった。');
    expect(reply).toContain('{"type":"b"');
    expect(reply).not.toContain('"type":"a"');
    expect(reply).not.toContain('"type":"c"');
  });

  it('窓を渡すと、0件でも「時刻の無い行・読めない行は窓の判定ができないので除いた」を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscript('mgr-1', '{"type":"a"}');

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      since: '2026-01-01T00:00:00.000Z',
    });

    expect(reply).toContain('絞り込み: 全 1 行のうち 0 行が当たった。');
    expect(reply).toContain('時刻の無い行 1 行');
    expect(reply).toContain('読めない行 0 行');
    expect(reply).toContain('窓の判定ができないので除いた');
  });

  it('type で複数種別（カンマ区切り）を絞れる', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = ['{"type":"assistant"}', '{"type":"result"}', '{"type":"user"}'].join('\n');
    h.setTranscript('mgr-1', body);

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      type: 'assistant,result',
    });

    expect(reply).toContain('絞り込み: 全 3 行のうち 2 行が当たった。');
    expect(reply).toContain('"type":"assistant"');
    expect(reply).toContain('"type":"result"');
    expect(reply).not.toContain('"type":"user"');
  });

  it('contains で部分文字列を絞れる（例: "stop_reason":"tool_use"）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = [
      assistantLine(',"stop_reason":"tool_use"'),
      assistantLine(',"stop_reason":"end_turn"'),
    ].join('\n');
    h.setTranscript('mgr-1', body);

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      contains: '"stop_reason":"tool_use"',
    });

    expect(reply).toContain('絞り込み: 全 2 行のうち 1 行が当たった。');
    expect(reply).toContain('tool_use');
    expect(reply).not.toContain('end_turn');
  });

  it('切れたときの続きの案内（offset=…）に、渡した絞りの引数がそのまま付く', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const matching = Array.from({ length: 500 }, (_, i) => assistantLine(`,"i":${i}`)).join('\n');
    const body = [matching, '{"type":"other"}'].join('\n');
    h.setTranscript('mgr-1', body);

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      type: 'assistant',
      contains: 'i',
    });

    expect(reply).toContain('ここで切れている');
    expect(reply).toMatch(
      /manager_transcript managerId=mgr-1 offset=\d+ type=assistant contains=i/,
    );
  });

  it('since/until が ISO 8601 として読めないときは、生ログを読みに行かずその場で断る', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscript('mgr-1', '{"type":"a"}');

    const reply = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      since: 'not-a-date',
    });

    expect(reply).toContain('日時として読めない');
    expect(reply).not.toContain('絞り込み');
  });
});

describe('archive_remove（退避済み生ログの本文を消す）', () => {
  it('存在しない id は黙って成功にしない', async () => {
    const h = harness();

    const reply = await h.call('archive_remove', {
      archiveId: '居ない.jsonl',
      summary: '掃除',
    });

    expect(reply).toContain('存在しない');
    expect(reply).toContain('居ない.jsonl');
  });

  it('消せる（行は list に残る。日誌に決定として残る）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-x', 'BODY\n')).id;

    const reply = await h.call('archive_remove', {
      archiveId,
      summary: 'もう要らないので消した',
    });

    expect(reply).toContain('消した');
    expect((await h.stores.archive.list()).map((entry) => entry.id)).toContain(archiveId);
    expect(await h.stores.archive.read(archiveId)).toMatchObject({ kind: 'removed' });

    const entries = await h.stores.journal.list({ types: ['decision'] });
    const entry = entries.find((e) => e.type === 'decision' && e.decision.includes(archiveId)) as
      { type: 'decision'; decision: string; grounds: string } | undefined;
    expect(entry).toBeDefined();
    expect(entry?.grounds).toBe('もう要らないので消した');
    expect(entries.some((e) => e.type === 'decision' && e.decision.includes('BODY'))).toBe(false);
  });

  it('二重に呼んでも「前から消されている」と言い、何も変えない', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-y', 'BODY\n')).id;
    await h.call('archive_remove', { archiveId, summary: '1回目' });

    const reply = await h.call('archive_remove', { archiveId, summary: '2回目' });

    expect(reply).toContain('前から消されている');
  });

  it('消したバイト数に、置き場で解放した量ではないという単位の断りが付く（応答・日誌・二重削除。#2074）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-unit', 'BODY\n')).id;

    const first = await h.call('archive_remove', { archiveId, summary: '単位の断り' });
    const second = await h.call('archive_remove', { archiveId, summary: '2回目' });
    const entries = await h.stores.journal.list({ types: ['decision'] });
    const journaled = entries.find((e) => e.type === 'decision' && e.decision.includes(archiveId));

    for (const [label, text] of [
      ['単体削除の応答', first],
      ['二重削除の応答', second],
      ['日誌', journaled?.type === 'decision' ? journaled.decision : ''],
    ] as const) {
      expect(text, label).toContain('置き場で解放した量ではなく');
      expect(text, label).toContain('storedBytes');
    }
  });

  it('manager_transcript / manager_report が tombstone を言うときも、バイト数に単位の断りが付く（#2074）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    h.setTranscriptRemoved('mgr-1', {
      archiveId: 'mgr-1-removed-0001.jsonl',
      removedAt: '2026-01-02T00:00:00.000Z',
      bytes: 1234567,
    });

    const transcript = await h.call('manager_transcript', { managerId: 'mgr-1' });
    const report = await h.call('manager_report', { managerId: 'mgr-1' });

    for (const [label, text] of [
      ['manager_transcript', transcript],
      ['manager_report', report],
    ] as const) {
      expect(text, label).toContain('1,234,567');
      expect(text, label).toContain('置き場で解放した量ではなく');
      expect(text, label).toContain('storedBytes');
    }
  });

  it('走行中のマネージャーの退避は消せない（どのマネージャーが走行中かを言う）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-running', 'BODY\n')).id;
    h.setRunningManagerOwning(archiveId, 'mgr-running-1');

    const reply = await h.call('archive_remove', { archiveId, summary: '掃除' });

    expect(reply).toContain('消せない');
    expect(reply).toContain('mgr-running-1');
    expect(await h.stores.archive.read(archiveId)).toEqual({ kind: 'body', body: 'BODY\n' });
  });

  it('overrideReason を渡せば走行中でも消せる（理由が journal に残る）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-override', 'BODY\n')).id;
    h.setRunningManagerOwning(archiveId, 'mgr-running-2');

    const reply = await h.call('archive_remove', {
      archiveId,
      summary: '掃除',
      overrideReason: '本番障害の調査で緊急に消す必要があった',
    });

    expect(reply).toContain('消した');
    expect(reply).toContain('override');
    expect(reply).toContain('mgr-running-2');
    expect(await h.stores.archive.read(archiveId)).toMatchObject({ kind: 'removed' });

    const entries = await h.stores.journal.list({ types: ['decision'] });
    const entry = entries.find((e) => e.type === 'decision' && e.decision.includes(archiveId)) as
      { type: 'decision'; decision: string; grounds: string } | undefined;
    expect(entry?.decision).toContain('override');
    expect(entry?.decision).toContain('mgr-running-2');
    expect(entry?.decision).toContain('本番障害の調査で緊急に消す必要があった');
  });

  it('overrideReason が空文字だと拒否のまま（うっかり通らない）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-empty-override', 'BODY\n')).id;
    h.setRunningManagerOwning(archiveId, 'mgr-running-3');

    const reply = await h.call('archive_remove', {
      archiveId,
      summary: '掃除',
      overrideReason: '',
    });

    expect(reply).toContain('消せない');
    expect(await h.stores.archive.read(archiveId)).toEqual({ kind: 'body', body: 'BODY\n' });
  });

  it('overrideReason が空白だけだと拒否のまま（trim して非空を要求する）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-blank-override', 'BODY\n')).id;
    h.setRunningManagerOwning(archiveId, 'mgr-running-4');

    const reply = await h.call('archive_remove', {
      archiveId,
      summary: '掃除',
      overrideReason: '   ',
    });

    expect(reply).toContain('消せない');
    expect(await h.stores.archive.read(archiveId)).toEqual({ kind: 'body', body: 'BODY\n' });
  });

  it('走行中でなければ overrideReason を渡さなくても普通に消せる（override の有無で通常経路が変わらない）', async () => {
    const h = harness();
    const archiveId = (await h.stores.archive.archive('sess-not-running', 'BODY\n')).id;

    const reply = await h.call('archive_remove', { archiveId, summary: '掃除' });

    expect(reply).toContain('消した');
    expect(reply).not.toContain('override');
  });

  it('managers が配線されていない場面では、安全側に倒して消させない', async () => {
    const stores = createMemoryStores();
    const archiveId = (await stores.archive.archive('sess-no-pool', 'BODY\n')).id;
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'archive_remove');
    if (!found) throw new Error('archive_remove が無い');

    const result = await found.handler({ archiveId, summary: '掃除' } as never, {});
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    expect(text).toContain('消せない');
    expect(await stores.archive.read(archiveId)).toEqual({ kind: 'body', body: 'BODY\n' });
  });
});

describe('一覧の文言は、観測した分しか言わない', () => {
  it('lost に「完了ではない」と書かない（成果の有無は観測していない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'PR を出して' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'lost';
    target.live = false;

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('途中で失われている');
    expect(reply).not.toContain('完了ではない');
    expect(reply).toContain('戻れなかった');
    expect(reply).toMatch(/リモート|PR/);
    expect(reply).toContain('確かめ');
  });

  it('lost は done と混ざらない（起こし直す対象として見分けられる）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.call('manager_start', { request: 'B' });
    const [lost, done] = h.running;
    if (!lost || !done) throw new Error('準備に失敗');
    lost.status = 'lost';
    lost.live = false;
    done.status = 'done';

    const reply = await h.call('manager_list', {});
    expect(reply).toContain('mgr-2');
    const lostEntry = reply.slice(reply.indexOf('mgr-1'), reply.indexOf('mgr-2'));
    const doneEntry = reply.slice(reply.indexOf('mgr-2'));

    expect(lostEntry).toContain('⚠');
    expect(lostEntry).toContain('manager_start');
    expect(doneEntry).not.toContain('⚠');
  });

  it('拒否で手が止まっていることが、状態に添えて一覧に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('[running]');
    expect(reply).toContain('Bash 4件');
    expect(reply).toContain('Write 1件');
    expect(reply).toContain('クローンには回ってきていない');
    expect(reply).toContain('journal_read');
  });

  it('describeDenials も拒否の出所を断定せず、2つの場合分けと「まず担い手の拒否文を読ませる」案内が載る（#1289）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1 }]);

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain(
      'この確認はクローンには回ってきていないので、手が止まっている可能性がある',
    );

    expect(reply).toContain(
      '(a) 器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。',
    );
    expect(reply).toContain('PreToolUse');
    expect(reply).toContain('bash-wait-guard.ts');
    expect(reply).toContain('自力で抜けられることがある');

    const guidanceAt = reply.indexOf('まず担い手自身に返っている拒否文を読ませること');
    const branchAAt = reply.indexOf('(a) 器の分類器か deny 規則なら');
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeLessThan(branchAAt);

    expect(reply).toContain('journal_read');
    expect(reply).toContain('件数はデーモンを作り直すと数え直しになる');
  });

  it('拒否の層（マネージャー／作業者／層不明）が一覧の字面でも3値のまま出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 2, actor: 'manager' },
      { tool: 'Edit', count: 1, actor: 'worker' },
      { tool: 'Write', count: 3 },
    ]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('Bash 2件 [マネージャー]');
    expect(reply).toContain('Edit 1件 [作業者]');
    expect(reply).toContain('Write 3件 [層不明]');
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('止められた道具');
  });

  it('manager_report は拒否を出し、字面が manager_list と割れない（#830）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, actor: 'worker' }]);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('Bash 1件 [作業者]');
    expect(reply).toContain('クローンには回ってきていない');
    expect(reply).toContain('止められた道具');
    expect(reply.indexOf('止められた道具')).toBeLessThan(reply.indexOf('終わった'));

    const list = await h.call('manager_list', {});
    const line = (text: string) =>
      text
        .split('\n')
        .find((row) => row.includes('止められた道具'))
        ?.trim();
    expect(line(reply)).toBe(line(list));
  });

  it('manager_report は報告が空でも拒否を出す（黙って「まだ無い」で終わらせない・#830）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, actor: 'worker' }]);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('Bash 1件 [作業者]');
    expect(reply).toContain('クローンには回ってきていない');
  });

  it('拒否の行に「止められた後に報告が届いたか」を3値で添える（#1455）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');

    target.lastReport = '進めた';
    target.lastReportAt = '2026-09-24T07:10:00.000Z';
    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 1, actor: 'worker', lastAt: '2026-09-24T07:00:00.000Z' },
    ]);
    const after = await h.call('manager_list', {});
    expect(after).toContain('後にも報告が届いている（2026-09-24T07:10:00.000Z）');
    expect(await h.call('manager_report', { managerId: 'mgr-1' })).toContain(
      '後にも報告が届いている',
    );

    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 2, actor: 'worker', lastAt: '2026-09-24T07:20:00.000Z' },
    ]);
    expect(await h.call('manager_list', {})).toContain(
      '最後に止められた（2026-09-24T07:20:00.000Z）後の報告はまだ届いていない',
    );

    h.denied.set('mgr-1', [{ tool: 'Bash', count: 2, actor: 'worker' }]);
    const unknown = await h.call('manager_list', {});
    expect(unknown).toContain('判定できない');
    expect(unknown).not.toContain('まだ届いていない');
  });

  it('manager_report は拒否が無ければ1文字も足さない（#830）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.lastReport = '終わった';

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('終わった');
    expect(reply).not.toContain('止められた道具');
    expect(reply).not.toContain('クローンには回ってきていない');
  });

  it('manager_report の part=request では拒否を出さない（依頼文は止められた話ではない・#830）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, actor: 'worker' }]);

    const reply = await h.call('manager_report', { managerId: 'mgr-1', part: 'request' });

    expect(reply).toContain('依頼の本文');
    expect(reply).not.toContain('止められた道具');
  });

  it('拒否の種類が多くても一覧を食い潰さず、切ったことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set(
      'mgr-1',
      Array.from({ length: 7 }, (_, index) => ({ tool: `tool-${index}`, count: index + 1 })),
    );

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('tool-6 7件');
    expect(reply).toContain('tool-4 5件');
    expect(reply).not.toContain('tool-3');
    expect(reply).toContain('ほか 4 種');
    expect(reply).toContain('全 28 件');
  });

  it('分類・理由・拒否文が一覧の行に載る（journal_read を遡らない・#1105）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      {
        tool: 'Bash',
        count: 1,
        actor: 'worker',
        reasonType: 'classifier',
        reason: 'この形は共有資源を起動しうる',
        message: 'Blocked by classifier',
      },
    ]);

    const list = await h.call('manager_list', {});
    expect(list).toContain('分類: classifier');
    expect(list).toContain('理由: この形は共有資源を起動しうる');
    expect(list).toContain('モデルへの拒否文: Blocked by classifier');

    const report = await h.call('manager_report', { managerId: 'mgr-1' });
    expect(report).toContain('分類: classifier');
    expect(report).toContain('理由: この形は共有資源を起動しうる');
    expect(report).toContain('モデルへの拒否文: Blocked by classifier');
  });

  it('分類・理由・拒否文を持たない拒否（従来どおり）では、その部分が1文字も増えない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, actor: 'worker' }]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('Bash 1件 [作業者]');
    expect(reply).not.toContain('分類:');
    expect(reply).not.toContain('理由:');
    expect(reply).not.toContain('モデルへの拒否文:');
  });

  it('分類だけが在って理由・拒否文が無い回は、その欄だけ出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, reasonType: 'rule' }]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('分類: rule');
    expect(reply).not.toContain('理由:');
    expect(reply).not.toContain('モデルへの拒否文:');
  });

  it('入力の先頭（inputHead）が一覧の行に載る（journal_read には無い値・issue #1105）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      {
        tool: 'Bash',
        count: 1,
        actor: 'worker',
        reasonType: 'classifier',
        inputHead: 'sed -i 1s/.../ 538-comment.md',
      },
    ]);

    const list = await h.call('manager_list', {});
    expect(list).toContain('入力の先頭: sed -i 1s/.../ 538-comment.md');

    const report = await h.call('manager_report', { managerId: 'mgr-1' });
    expect(report).toContain('入力の先頭: sed -i 1s/.../ 538-comment.md');
  });

  it('inputHead を持たない拒否（従来どおり）では、その部分が1文字も増えない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [{ tool: 'Bash', count: 1, reasonType: 'rule' }]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('分類: rule');
    expect(reply).not.toContain('入力の先頭:');
  });

  it('done を畳んだときに「走っている手は無い」と断定しない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'done';

    const reply = await h.call('manager_stop', { managerId: 'mgr-1' });

    expect(reply).toContain('待機中（done）');
    expect(reply).not.toContain('走っている手は無く');
    expect(reply).toContain('作業者');
    expect(reply).toContain('見えていない');
  });
});

describe('usage_read（人間が見られるものはクローンからも見られる）', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.0031,
    },
  };

  async function spent(h: Harness) {
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });
  }

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('usage_read'));
  });

  for (const [name, value] of [
    ['from', '2026-02-30'],
    ['to', '2026-13-01'],
    ['from', 'yesterday'],
    ['to', '2026-8-1'],
  ] as const) {
    it(`${name}=${value} は、実在する日付で書くよう断り、集計しない`, async () => {
      const h = harness();
      let aggregated = false;
      const aggregate = h.stores.usage.aggregate.bind(h.stores.usage);
      h.stores.usage.aggregate = async (query) => {
        aggregated = true;
        return aggregate(query);
      };
      const reply = await h.call('usage_read', { [name]: value });
      expect(reply).toContain(`\`${name}\` は、暦の上に実在する日付（YYYY-MM-DD）で書く`);
      expect(reply).toContain(JSON.stringify(value));
      expect(aggregated).toBe(false);
    });
  }

  it('実在する日（閏年の 2/29）は断らずに集計する', async () => {
    const h = harness();
    const reply = await h.call('usage_read', { from: '2024-02-29', to: '2026-08-31' });
    expect(reply).not.toContain('実在する日付（YYYY-MM-DD）で書く');
  });

  it('合計とモデル別を返し、但し書きを必ず添える', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('合計 $2.00');
    expect(reply).toContain('claude-opus-5');
    expect(reply).toContain('claude-sonnet-5');
    expect(reply).toContain('請求明細ではない');
  });

  it('消費を報告しない provider のターンは、合計の隣に「取れなかった」と出す', async () => {
    const h = harness();
    await spent(h);
    await h.stores.usage.recordUnmetered({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:05:00.000Z',
      provider: 'codex',
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('消費を報告しない provider のターンがある');
    expect(reply).toContain('codex');
    expect(reply).toContain('合計 $2.00');
  });

  it('台帳が空でも、消費を報告しない provider のターンは「取れなかった」と出す', async () => {
    const h = harness();
    await h.stores.usage.recordUnmetered({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:05:00.000Z',
      provider: 'codex',
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('消費を報告しない provider のターンがある');
    expect(reply).not.toContain('$0');
  });

  it('消費を報告しない provider が無ければ、その行を1文字も足さない', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', {});

    expect(reply).not.toContain('消費を報告しない provider');
  });

  it('$1 未満を丸めて 0 にしない（「使っていない」と読めてしまう）', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { managerId: 'mgr-1' });

    expect(reply).toContain('$0.0031');
    expect(reply).not.toContain('$0.00\n');
  });

  it('まだ1件も無ければ「$0」ではなく「記録が無い」と言う', async () => {
    const h = harness();

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('記録が無い');
    expect(reply).not.toContain('$0');
  });

  it('台帳の始点より前を聞かれたら「0」ではなく「記録が無い」と言う', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('台帳の始点');
    expect(reply).toContain('記録が無い');
  });

  it('その範囲に記録が無いことと、台帳が空であることを混ぜない', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2026-09-01', to: '2026-09-30' });

    expect(reply).toContain('その範囲には記録が無い');
    expect(reply).toContain('台帳の始点: 2026-08-14');
  });

  it('to が from より前なら、注記を応答の先頭に添える（CLI・Web と同じ文言）', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2026-09-10', to: '2026-09-01' });

    expect(
      reply.startsWith(
        'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない\n',
      ),
    ).toBe(true);
    expect(reply).toContain('その範囲には記録が無い');
  });

  it('to と from が同じ日、または順が正しいなら注記を出さない', async () => {
    const h = harness();
    await spent(h);

    const same = await h.call('usage_read', { from: '2026-09-01', to: '2026-09-01' });
    const ordered = await h.call('usage_read', { from: '2026-09-01', to: '2026-09-30' });

    expect(same).not.toContain('より前なので');
    expect(ordered).not.toContain('より前なので');
  });

  it('from / to のどちらかしか渡さないときは注記を出さない（比較しようがない）', async () => {
    const h = harness();
    await spent(h);

    const onlyTo = await h.call('usage_read', { to: '2026-09-01' });
    const onlyFrom = await h.call('usage_read', { from: '2026-09-30' });

    expect(onlyTo).not.toContain('より前なので');
    expect(onlyFrom).not.toContain('より前なので');
  });

  it('軸モードでも、同じ注記を応答の先頭に添える（まとめ表示と同じ入口を共有する）', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', {
      from: '2026-09-10',
      to: '2026-09-01',
      axis: 'model',
    });

    expect(
      reply.startsWith(
        'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない\n',
      ),
    ).toBe(true);
  });
});

describe('usage_read の Web 検索の回数（webSearchRequests。Issue #1950）', () => {
  const modelsWithoutSearch = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
  };
  const modelsWithSearch = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 3,
      costUsd: 2,
    },
  };

  it('合計が0のときはWeb検索の行を出さない', async () => {
    const h = harness();
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models: modelsWithoutSearch },
    });

    const reply = await h.call('usage_read', {});

    expect(reply).not.toContain('Web検索');
  });

  it('合計が0より大きいときは回数を出し、費用に含まれていることを添える', async () => {
    const h = harness();
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models: modelsWithSearch },
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('Web検索');
    expect(reply).toContain('3');
    expect(reply).toContain('含む');
  });
});

describe('usage_read の取れなかった区切り（unreadable。Issue #2086）', () => {
  it('unreadable が無ければ、それらしい行を出さない', async () => {
    const h = harness();
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-opus-5': {
            inputTokens: 10,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 2,
          },
        },
      },
    });

    const reply = await h.call('usage_read', {});

    expect(reply).not.toContain('取れなかった');
  });

  it('unreadable が在れば、値を作らず理由の行を出す', async () => {
    const h = harness();
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-opus-5': {
            inputTokens: 10,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 2,
            unreadable: { webSearchRequests: 4 },
          },
        },
      },
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('取れなかった');
    expect(reply).toContain('Web検索 4回');
  });
});

describe('usage_read の回数の軸（起きた回数）', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
  };

  async function spentOnce(h: Harness) {
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });
  }

  it('日別の行に N回 と1回あたりの費用を出す', async () => {
    const h = harness();
    await spentOnce(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('2026-08-14: $2.00 / 1回 / 1回 $2.00');
    expect(reply).toContain('合計 $2.00 / 1回 / 1回 $2.00');
  });

  it('モデル別の行には回数を出さない（1ターンが複数のモデル行を作るので帰属させられない）', async () => {
    const h = harness();
    await spentOnce(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('  claude-opus-5: $2.00\n');
    expect(reply).toContain(
      'モデル別に回数は出さない（1ターンが複数のモデル行を作るので、回数をモデルへ帰属させられない）。',
    );
  });

  it('turnsSince が null のとき「まだ1件も記録していない」と言い、出力のどこにも 0回 が現れない', async () => {
    const h = harness();
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-opus-5': {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 0,
          },
        },
      },
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('その範囲には記録が無い');
    expect(reply).toContain('回数の軸はまだ1件も記録していない。');
    expect(reply).not.toContain('0回');
  });

  it('beforeTurns が真のとき「0 ではなく取れていない」の但し書きが出る', async () => {
    const h = harness();
    await spentOnce(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain(
      '照会した範囲は回数の軸の始点より前にかかっている。その分の回数は **0 ではなく「取れていない」**。',
    );
  });
});

describe('usage_read の台帳に1行も無い委譲（Issue #98）', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
  };

  async function spent(h: Harness, managerId: string, date: string, at: string) {
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId,
      date,
      at,
      snapshot: { models },
    });
  }

  it('台帳に行が無いマネージャーを、managerId と status と起こした時刻付きで出す', async () => {
    const h = harness();
    h.running.push({
      managerId: 'mgr-unrecorded',
      status: 'running',
      live: true,
      cwd: '/work',
      request: '長く走っている',
      startedAt: '2026-08-25T12:00:00.000Z',
      updatedAt: '2026-08-25T12:00:00.000Z',
      waiting: [],
    });
    await spent(h, 'mgr-recorded', '2026-08-14', '2026-08-14T10:00:00.000Z');

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('mgr-unrecorded');
    expect(reply).toContain('running');
    expect(reply).toContain('2026-08-25T12:00:00.000Z');
  });

  it('期間で絞っても、範囲の外で記録された委譲は取りこぼしとして出ない', async () => {
    const h = harness();
    await spent(h, 'mgr-anchor', '2026-01-01', '2026-01-01T00:00:00.000Z');
    h.running.push({
      managerId: 'mgr-old-record',
      status: 'done',
      live: false,
      cwd: '/work',
      request: '5月に走った',
      startedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T01:00:00.000Z',
      waiting: [],
    });
    await spent(h, 'mgr-old-record', '2026-05-01', '2026-05-01T00:30:00.000Z');

    const reply = await h.call('usage_read', { from: '2026-08-01', to: '2026-08-31' });

    expect(reply).toContain('その範囲には記録が無い');
    expect(reply).not.toContain('mgr-old-record');
  });

  it('since より前に createdAt を持つ委譲は出さない', async () => {
    const h = harness();
    await spent(h, 'mgr-recorded', '2026-08-20', '2026-08-20T00:00:00.000Z');
    h.running.push({
      managerId: 'mgr-before-ledger',
      status: 'lost',
      live: false,
      cwd: '/work',
      request: '台帳より前に立った',
      startedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T01:00:00.000Z',
      waiting: [],
    });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('台帳の始点: 2026-08-20');
    expect(reply).not.toContain('mgr-before-ledger');
  });

  it('取りこぼしが0件のときは「0件」と明示する（黙らない）', async () => {
    const h = harness();
    await spent(h, 'mgr-recorded', '2026-08-14', '2026-08-14T10:00:00.000Z');

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('0件');
  });

  it('context.managers が無いときは「確かめられなかった」と言い、0 とは言わない', async () => {
    const stores = createMemoryStores();
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-recorded',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((t) => t.name === 'usage_read');
    const result = await found!.handler({} as never, {} as never);
    const reply = result.content.map((part) => ('text' in part ? part.text : '')).join('\n');

    expect(reply).toContain('確かめられなかった');
    expect(reply).not.toContain('0件');
  });
});

describe('usage_read の5軸と、打ち切りから続きへ辿る道', () => {
  const one = (costUsd: number) => ({
    'claude-opus-5': {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd,
    },
  });

  async function record(
    h: Harness,
    over: {
      layer: 'clone' | 'manager';
      site: 'session' | 'distill';
      managerId: string;
      costUsd: number;
      date?: string;
      at?: string;
    },
  ) {
    await h.stores.usage.record({
      layer: over.layer,
      site: over.site,
      accumulation: over.site === 'distill' ? 'oneshot' : 'cumulative',
      managerId: over.managerId,
      date: over.date ?? '2026-08-14',
      at: over.at ?? '2026-08-14T10:00:00.000Z',
      snapshot: { models: one(over.costUsd) },
    });
  }

  function extractUsageCursor(reply: string, axis: string): string {
    const found = reply.match(new RegExp(`axis="${axis}", cursor="([^"]+)" で続きが出る`));
    if (!found) throw new Error(`usage_read の続きの cursor が見つからない: ${reply}`);
    return found[1]!;
  }

  it('層と場所の軸を出す（モデル名では層を見分けられない）', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('層別（誰が）:');
    expect(reply).toContain('場所別（どこで）:');
    expect(reply).toContain('manager: $2.00');
    expect(reply).toContain('clone: $0.5000');
    expect(reply).toContain('distill: $0.5000');
  });

  it('層で絞れる（4つの口に同じ絞り込みがある）', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 0.5 });

    const onlyClone = await h.call('usage_read', { layer: 'clone' });

    expect(onlyClone).toContain('合計 $0.5000');
    expect(onlyClone).not.toContain('mgr-1');
  });

  it('場所で絞れる', async () => {
    const h = harness();
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const onlyDistill = await h.call('usage_read', { site: 'distill' });

    expect(onlyDistill).toContain('合計 $0.5000');
  });

  it('打ち切ったら、続きの取り方をその行に書く（「残り N 件」で終わらせない）', async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('残り 6 件は出していない');
    expect(reply).toMatch(/axis="manager", cursor="[A-Za-z0-9_-]+" で続きが出る/);
  });

  it('打ち切っていないなら、断り書きは1つも出ない（USAGE_AXIS_LIMIT 未満）', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 5 - i,
      });
    }

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('マネージャー別:');
    expect(reply).toContain('mgr-00');
    expect(reply).not.toContain('は出していない');
  });

  it('axis を指定すると、その軸だけを cursor から出す', async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const summary = await h.call('usage_read', {});
    const cursor = extractUsageCursor(summary, 'manager');
    const reply = await h.call('usage_read', { axis: 'manager', cursor });

    expect(reply).toContain('mgr-14');
    expect(reply).toContain('mgr-19');
    expect(reply).not.toContain('mgr-13');
    expect(reply).not.toContain('日別');
    expect(reply).not.toContain('アカウント全体の残り');
  });

  it('cursor が最後の頁を指していても、黙って空を返さない', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-1', cost: 1 });
    const reply = await h.call('usage_read', { axis: 'manager', cursor });

    expect(reply).toContain('全 1 件');
    expect(reply).toContain('cursor より後ろは無い。これが最後の頁');
  });

  it('壊れた cursor は断る（黙って先頭へ倒さない）', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { axis: 'manager', cursor: '!!!not-a-cursor!!!' });

    expect(reply).toContain('cursor が壊れている');
    expect(reply).not.toContain('mgr-1:');
  });

  it('別の軸の cursor は断る', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const wrongAxisCursor = encodeUsageCursor({ axis: 'model', label: 'claude-opus-5', cost: 1 });
    const reply = await h.call('usage_read', { axis: 'manager', cursor: wrongAxisCursor });

    expect(reply).toContain('別の軸');
    expect(reply).not.toContain('mgr-1:');
  });

  it('#1673: まとめ表示→続きの間に最下位の行が伸びて先頭へ来ても、欠落せず重複もしない', async () => {
    const h = harness();
    const FIRST_CALL_AT = '2026-08-14T10:00:00.000Z';
    for (let i = 1; i <= 14; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 15 - i,
        at: FIRST_CALL_AT,
      });
    }
    await record(h, {
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-15',
      costUsd: 0.5,
      at: FIRST_CALL_AT,
    });

    const summary = await h.call('usage_read', {});
    for (let i = 1; i <= 14; i += 1) {
      expect(summary).toContain(`mgr-${String(i).padStart(2, '0')}`);
    }
    expect(summary).not.toContain('mgr-15');
    const cursor = extractUsageCursor(summary, 'manager');

    await record(h, {
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-15',
      costUsd: 100,
      at: '2026-08-14T11:00:00.000Z',
    });

    const continuation = await h.call('usage_read', { axis: 'manager', cursor });

    expect(continuation).toContain('順位が上がった');
    expect(continuation).toContain('mgr-15');

    const [body] = continuation.split('⚠ 順位が上がった');
    expect(body).not.toContain('mgr-14');
  });

  it('#1719: 軸モードの続きへ辿る間に、最下位の行が asOf と同じミリ秒のまま追い越しても欠落しない（同着）', async () => {
    const h = harness();
    const FIRST_CALL_AT = '2026-08-14T10:00:00.000Z';
    for (let i = 0; i < 100; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(3, '0')}`,
        costUsd: 100 - i,
        at: FIRST_CALL_AT,
      });
    }
    await record(h, {
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-100',
      costUsd: 0.5,
      at: FIRST_CALL_AT,
    });

    const first = await h.call('usage_read', { axis: 'manager' });
    expect(first).not.toContain('mgr-100');
    const cursor = extractUsageCursor(first, 'manager');

    await record(h, {
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-100',
      costUsd: 500,
      at: FIRST_CALL_AT,
    });

    const continuation = await h.call('usage_read', { axis: 'manager', cursor });

    expect(continuation).toContain('順位が上がった');
    expect(continuation).toContain('mgr-100');
  });

  it('記録が増えない場合は、cursor で複数頁を欠落・重複なく辿れる', async () => {
    const h = harness();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(4, '0')}`,
        costUsd: total - i,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > total) throw new Error('頁が終わらない（無限ループの疑い）');
      const reply = await h.call(
        'usage_read',
        cursor === undefined ? { axis: 'manager' } : { axis: 'manager', cursor },
      );
      expect(reply).not.toContain('順位が上がった');
      for (const m of reply.matchAll(/^ {2}(mgr-\d{4}): /gm)) seen.push(m[1]!);
      const next = reply.match(/axis="manager", cursor="([^"]+)" で続きが出る/);
      if (!next) break;
      cursor = next[1];
    }

    expect(new Set(seen).size).toBe(total);
    expect(seen.length).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });

  it('層の軸の始点を台帳の始点と混ぜない', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('層と場所の軸の始点: 2026-08-14');
    expect(reply).toContain('既定値であって観測ではない');
  });
});

describe('usage_read はアカウント全体の残りも返す（人間と同じものを見せる）', () => {
  function withAccount(accountUsage: () => AccountUsageState) {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      accountUsage,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    return async (args: Record<string, unknown> = {}) => {
      const found = tools.find((t) => t.name === 'usage_read');
      const result = await found!.handler(args as never, {} as never);
      return result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    };
  }

  it('まだ取っていないときは「0」ではなく「分からない」と言う', async () => {
    const call = withAccount(() => ({ state: 'unknown' }));
    const reply = await call();
    expect(reply).toContain('まだ取りに行っていない');
    expect(reply).toContain('0 ではなく');
  });

  it('取れなかったときは理由を出す（0% と描かない）', async () => {
    const call = withAccount(() => ({
      state: 'failed',
      at: '2026-08-14T10:00:00.000Z',
      reason: '2つの口のどちらも答えなかった',
    }));
    const reply = await call();
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('0 ではなく');
    expect(reply).not.toContain('0%');
  });

  it('この構成では取れないときは、そう言う', async () => {
    const call = withAccount(() => ({
      state: 'unavailable',
      at: '2026-08-14T10:00:00.000Z',
      reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
    }));
    expect(await call()).toContain('ログインしていない');
  });

  it('枠と支出上限を出す', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [
          { kind: 'five_hour', utilization: 42, resetsAt: Date.parse('2026-08-14T13:00:00.000Z') },
        ],
        extraUsage: {
          enabled: true,
          monthlyLimit: 100,
          usedCredits: 40,
          utilization: 40,
          currency: 'USD',
        },
      },
    }));
    const reply = await call();
    expect(reply).toContain('Claude Max');
    expect(reply).toContain('42% 使用');
    expect(reply).toContain('40 USD / 100 USD');
  });

  it('使用率が付かない枠を 0% と書かない', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', resetsAt: Date.parse('2026-08-14T13:00:00.000Z') }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('使用率は取れなかった');
    expect(reply).not.toContain('0% 使用');
  });

  it('枠が来なかったら「0%」ではなく「取れなかった」', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [],
      },
    }));
    const reply = await call();
    expect(reply).toContain('枠: 取れなかった');
    expect(reply).toContain('0% ではない');
  });

  it('支出上限が取れないことを黙らない（残額が分からないと言う）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', utilization: 10 }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('支出上限: 取れなかった');
    expect(reply).toContain('残額は分からない');
  });

  it('通貨が分からないときは金額として整形しない（嘘の単位を名乗らない）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [],
        extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 40, utilization: 40 },
      },
    }));
    const reply = await call();
    expect(reply).toContain('単位不明');
    expect(reply).not.toContain('$40');
  });
});

describe('self_status（いま自分がどう走っているか）', () => {
  const RUNTIME: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    buildTime: { builtAt: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: heuristicChars(3),
    systemPromptChars: heuristicChars(999),
    lastContextUsage: null,
  };

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('self_status'));
  });

  it('runtime を渡していない場面（蒸留のサイドクエリを模した形）では、落ちずに読めないと返す', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    expect(body).toContain('読めない場面');
  });

  it('記憶の文書数といまの総文字数が出る。焼き込んだ時点の文字数とは別々に出る', async () => {
    const h = harness(() => RUNTIME);
    await writeBased(h, {
      slug: 'values',
      content: '# 価値観\n\n人間が手で書いた方針',
      summary: '書いた',
    });
    await writeBased(h, {
      slug: 'habits',
      content: '# 習慣\n\n毎朝記憶を見直す',
      summary: '書いた',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());
    expect(totalMemory.length).not.toBe(RUNTIME.injectedMemoryChars);

    const reply = await h.call('self_status', {});

    expect(reply).toContain('2 文書');
    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('焼き込んだ記憶の文字数（このセッションを組み立てた時点）: 3 文字');
  });

  it('記憶を書き換えたあとに呼んでも、いまの総文字数は読み直した値が出る', async () => {
    const h = harness(() => RUNTIME);
    await writeBased(h, { slug: 'values', content: '# 価値観\n\n最初の版', summary: '1' });
    await h.call('self_status', {});

    await writeBased(h, {
      slug: 'values',
      content: '# 価値観\n\n書き換えた後のもっと長い方針の本文',
      summary: '2',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());

    const reply = await h.call('self_status', {});

    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('組み立てた時点）: 3 文字');
  });

  describe('記憶内訳の区分ごとの小計（premise 合計 / fact 目次合計。記憶の肥大への恒久対策）', () => {
    it('既存の「総文字数」の行の文言は変わっていない', async () => {
      const h = harness(() => RUNTIME);
      await writeBased(h, { slug: 'a', content: '# A\n本文', summary: '1' });
      const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());

      const reply = await h.call('self_status', {});

      expect(reply).toContain(
        `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（1 文書）`,
      );
    });

    it('⭐⭐ 束ねた予算に当たっているときは、カードを落とした件数を同じ行で名乗る', async () => {
      const h = harness(() => RUNTIME);
      const body = Array.from(
        { length: 200 },
        (_, n) => `## 節${n} ${'見出し'.repeat(4)}\n\n本文\n`,
      ).join('\n');
      const content = `---\ntype: premise\ndescription: ${'あ'.repeat(3_000)}\n---\n\n${body}`;
      for (let i = 0; i < 12; i += 1) {
        await writeBased(h, { slug: `big-${i}`, content, summary: String(i) });
      }
      const floor = measureMemoryFloor(await h.stores.persona.documents());
      expect(floor.demotedPremiseDocs).toBeGreaterThan(0);

      const reply = await h.call('self_status', {});

      expect(reply).toContain(
        `⚠️ うち ${floor.demotedPremiseDocs.toLocaleString('en-US')} 文書は束ねた予算に当たって` +
          'カードを落とし、1行になっている',
      );
      expect(reply).toContain('memory_outline');
    });

    it('premise 合計・fact 目次合計が、measureMemoryFloor が返す値と一致する', async () => {
      const h = harness(() => RUNTIME);
      await writeBased(h, {
        slug: 'premise-doc',
        content: '# 前提\n判断の基準になる本文',
        summary: '1',
      });
      await writeBased(h, {
        slug: 'fact-doc',
        content: '---\ntype: fact\ndescription: 事実の要旨\n---\n# 事実\n本文',
        summary: '2',
      });
      const floor = measureMemoryFloor(await h.stores.persona.documents());

      const reply = await h.call('self_status', {});

      expect(reply).toContain(
        `- premise 合計: ${floor.premiseChars.toLocaleString('en-US')} 文字（${floor.premiseDocs} 文書。毎ターン「要旨＋節の目次」が焼かれる）`,
      );
      expect(reply).toContain(
        `- fact 目次合計: ${floor.tocChars.toLocaleString('en-US')} 文字（${floor.factDocs} 文書。目次の1行だけが焼かれる）`,
      );
    });

    it('文書ごとの行に [premise] / [fact] と、bytes・文字の両方の単位ラベルが出る（bytes は消さない）', async () => {
      const h = harness(() => RUNTIME);
      await writeBased(h, {
        slug: 'premise-doc',
        content: '# 前提\n本文',
        summary: '1',
      });
      await writeBased(h, {
        slug: 'fact-doc',
        content: '---\ntype: fact\ndescription: 要旨\n---\n# 事実\n本文',
        summary: '2',
      });

      const reply = await h.call('self_status', {});

      expect(reply).toMatch(/\[premise\] premise-doc:/);
      expect(reply).toMatch(/\[fact\] fact-doc:/);
      expect(reply).toMatch(/\d[\d,]* bytes \/ [\d,]+ 文字/);
    });
  });

  it('鍵・トークンの値を出さない（profile_write で置いた値が self_status に出ない）', async () => {
    const h = harness(() => RUNTIME);
    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret-value-000',
      summary: 'トークンを実行環境へ移した',
    });

    const reply = await h.call('self_status', {});

    expect(reply).not.toContain('super-secret-value-000');
  });

  it('SDK モデル id がまだ分からなければ、突き合わせをせずそう言う', async () => {
    const h = harness(() => RUNTIME);

    const reply = await h.call('self_status', {});

    expect(reply).toContain('まだ init を観測していない');
  });

  it('台帳に同じモデル id の行があれば、その managerId が出る（軸: 日 × マネージャー × モデル）', async () => {
    const models = {
      'claude-fable-9000': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 1.5,
      },
    };
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-7',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('claude-fable-9000');
    expect(reply).toContain('managerId: "mgr-7"');
    expect(reply).not.toMatch(/あなたの消費が(台帳に)?載って/);
  });

  it('台帳の突き合わせが USAGE_AXIS_LIMIT 未満なら、打ち切りの断り書きは出ない', async () => {
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    for (let i = 0; i < 5; i += 1) {
      await h.stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'cumulative',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        date: '2026-08-14',
        at: '2026-08-14T10:00:00.000Z',
        snapshot: {
          models: {
            'claude-fable-9000': {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1 + i,
            },
          },
        },
      });
    }

    const reply = await h.call('self_status', {});

    expect(reply).toContain('claude-fable-9000');
    expect(reply).toContain('managerId: "mgr-00"');
    expect(reply).not.toContain('は出していない');
  });

  it('同じモデル id の行が無ければ、そう言う（0 件と嘘をつかない）', async () => {
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-other-model': {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 1,
          },
        },
      },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('同じ行は無い');
  });
});

describe('journalEntrySchema の memory_update（action の後方互換）', () => {
  it('action の無い既存エントリ（action 導入前の形）が今も通る', () => {
    const legacy = {
      type: 'memory_update' as const,
      id: 'j-1',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'human' as const,
      summary: '古い形式のエントリ（action フィールドが無い）',
    };

    const result = journalEntrySchema.safeParse(legacy);

    expect(result.success).toBe(true);
  });

  it('action を付けたエントリも通り、値がそのまま読める', () => {
    const withAction = {
      type: 'memory_update' as const,
      id: 'j-2',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'clone' as const,
      action: 'remove' as const,
      summary: '削除の記録',
    };

    const result = journalEntrySchema.safeParse(withAction);

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'memory_update') {
      expect(result.data.action).toBe('remove');
    }
  });
});

describe('journalEntrySchema の turn_usage.contextUsage.categories[].kind（後方互換。#804）', () => {
  const legacyRow = {
    type: 'turn_usage' as const,
    id: 'j-804-legacy',
    at: '2026-09-01T00:00:00.000Z',
    layer: 'clone' as const,
    site: 'session' as const,
    managerId: CLONE_ACTOR_ID,
    models: {},
    summary: 'kind が増える前に書かれたターンの消費',
    contextUsage: {
      durationMs: 12,
      categories: [{ name: 'System prompt', tokens: 8_000 }],
    },
  };

  it('⭐⭐ kind の無い既存の行が今も読み出せる（必須にすると list() から丸ごと消える）', () => {
    const result = journalEntrySchema.safeParse(legacyRow);

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'turn_usage') {
      expect(result.data.contextUsage?.categories).toEqual([
        { name: 'System prompt', tokens: 8_000 },
      ]);
    }
  });

  it('kind を持つ行は、その値がそのまま読める', () => {
    const result = journalEntrySchema.safeParse({
      ...legacyRow,
      id: 'j-804-kind',
      contextUsage: {
        durationMs: 12,
        categories: [
          { name: 'System prompt', tokens: 8_000, kind: 'used' },
          { name: 'Free space', tokens: 4_000, kind: 'free' },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'turn_usage') {
      expect(result.data.contextUsage?.categories?.map((category) => category.kind)).toEqual([
        'used',
        'free',
      ]);
    }
  });

  it('⭐ SDK が5つ目の kind を足しても行は落ちない（z.enum ではなく z.string にしてある）', () => {
    const result = journalEntrySchema.safeParse({
      ...legacyRow,
      id: 'j-804-unknown',
      contextUsage: {
        durationMs: 12,
        categories: [{ name: '将来の軸', tokens: 1_000, kind: 'invented-by-a-later-sdk' }],
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'turn_usage') {
      expect(result.data.contextUsage?.categories?.[0]?.kind).toBe('invented-by-a-later-sdk');
    }
  });
});
describe('journalEntrySchema の subagent_stall（Issue #357）', () => {
  const full = {
    type: 'subagent_stall' as const,
    id: 'j-1',
    at: '2026-08-01T00:00:00.000Z',
    agentId: 'agent-1',
    agentType: 'worker',
    ownedTaskCount: 1,
    sessionTaskCount: 2,
    wakeupCount: 1,
    outcome: 'woken' as const,
    text: '起こし直した（1回目 / 上限 2）。',
  };

  it('全欄が揃っていれば通る', () => {
    const result = journalEntrySchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it('agentType を省いても通る（取れなかった回）', () => {
    const withoutAgentType: Record<string, unknown> = { ...full };
    delete withoutAgentType.agentType;
    const result = journalEntrySchema.safeParse(withoutAgentType);
    expect(result.success).toBe(true);
  });

  it.each(['agentId', 'ownedTaskCount', 'sessionTaskCount', 'wakeupCount', 'outcome', 'text'])(
    '必須欄 %s が欠けると落ちる',
    (key) => {
      const broken: Record<string, unknown> = { ...full };
      delete broken[key];
      const result = journalEntrySchema.safeParse(broken);
      expect(result.success).toBe(false);
    },
  );

  it('outcome が未知の値だと落ちる（2値を潰さない設計の検算）', () => {
    const result = journalEntrySchema.safeParse({ ...full, outcome: 'unknown' });
    expect(result.success).toBe(false);
  });
});

describe('journal_read — turn_usage の文脈の内訳（#804）', () => {
  const appendTurnUsage = async (
    h: ReturnType<typeof harness>,
    contextUsage: Record<string, unknown>,
  ) =>
    h.stores.journal.append({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: CLONE_ACTOR_ID,
      models: {},
      summary: 'ターンの消費',
      contextUsage,
    } as never);

  it('⭐⭐⭐ 内訳（システムプロンプト / MCP の道具 / CLAUDE.md 系）とカテゴリ別を出す', async () => {
    const h = harness();
    const entry = await appendTurnUsage(h, {
      durationMs: 12,
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
      systemPromptTokens: 8_000,
      systemPromptSectionCount: 2,
      mcpToolTokens: 1_000,
      mcpToolCount: 37,
      memoryFileTokens: 700,
      memoryFileCount: 1,
      categories: [
        { name: 'System prompt', tokens: 8_000, kind: 'used' },
        { name: 'MCP tools', tokens: 1_000, kind: 'deferred' },
      ],
    });

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('文脈: 12,000 トークン / 200,000（6%）');
    expect(reply).toContain('システムプロンプト 8,000 トークン');
    expect(reply).toContain('MCP の道具の説明文 1,000 トークン（37 本）');
    expect(reply).toContain('**記憶の焼き込みはここに入る**');
    expect(reply).toContain('**alteroid の記憶ではない**');
    expect(reply).toContain('System prompt 8,000 [used]');
    expect(reply).toContain('MCP tools 1,000 [deferred]');
    expect(reply).toContain('名前は SDK の版で変わりうる');
  });

  it('⭐⭐⭐ kind の無い軸は「分類なし」と名乗る（used へ倒さない）', async () => {
    const h = harness();
    const entry = await appendTurnUsage(h, {
      durationMs: 12,
      totalTokens: 12_000,
      categories: [{ name: 'Messages', tokens: 500 }],
    });

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('Messages 500 [分類なし]');
    expect(reply).not.toContain('Messages 500 [used]');
  });

  it('⭐⭐⭐ 内訳を持たない行では、内訳の節を1文字も出さない（0 として出さない）', async () => {
    const h = harness();
    const entry = await appendTurnUsage(h, {
      durationMs: 12,
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('文脈: 12,000 トークン');
    expect(reply).not.toContain('内訳:');
    expect(reply).not.toContain('システムプロンプト');
    expect(reply).not.toContain('MCP の道具の説明文');
    expect(reply).not.toContain('カテゴリ別');
  });

  it('⭐⭐ 一部の軸だけ在る行では、在る軸だけを出す', async () => {
    const h = harness();
    const entry = await appendTurnUsage(h, {
      durationMs: 12,
      totalTokens: 12_000,
      mcpToolTokens: 1_000,
      mcpToolCount: 37,
    });

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('MCP の道具の説明文 1,000 トークン（37 本）');
    expect(reply).not.toContain('システムプロンプト');
    expect(reply).not.toContain('CLAUDE.md 系');
  });

  it('⭐⭐ カテゴリを切った行では、省いた軸数を名乗る', async () => {
    const h = harness();
    const entry = await appendTurnUsage(h, {
      durationMs: 12,
      totalTokens: 12_000,
      categories: [{ name: '軸0', tokens: 1 }],
      categoriesOmitted: 76,
    });

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('…ほか 76 軸は省略');
  });
});

describe('journal_read — inbox_flow.retained（Issue #1264）', () => {
  it('全文モードの本文に「残存」として4つとも出る。一覧の見出しは太らせない', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'inbox_flow',
      windowStartedAt: '2026-09-20T00:00:00.000Z',
      arrived: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      delivered: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      settled: { total: 0, byType: [] },
      pending: { count: 1 },
      retained: { unread: 1, redelivered: 2, redeliveredClosed: 3, pendingCollapse: 4 },
    } as never);

    const reply = await h.call('journal_read', { id: entry.id });
    expect(reply).toContain('残存: unread=1 redelivered=2 redeliveredClosed=3 pendingCollapse=4');

    const listReply = await h.call('journal_read', { types: ['inbox_flow'] });
    const head = listReply.match(/\[inbox_flow [^\]]*\]/)?.[0];
    if (head === undefined) throw new Error('見出しが見つからない');
    expect(head).not.toContain('unread=');
  });

  it('`retained` を持たない古い行（この欄が増える前に書かれた行）では「残存」を出さない（0として埋めない）', async () => {
    const h = harness();
    const legacy = await h.stores.journal.append({
      type: 'inbox_flow',
      windowStartedAt: '2026-09-20T00:00:00.000Z',
      arrived: { total: 0, byType: [] },
      delivered: { total: 0, byType: [] },
      settled: { total: 0, byType: [] },
      pending: { count: 0 },
    } as never);

    const reply = await h.call('journal_read', { id: legacy.id });
    expect(reply).not.toContain('残存');
    expect(reply).not.toContain('unread=0');
  });
});

describe('journal_read — memory_update の action / バイト数（#339）', () => {
  it('action と前後バイト数を出す（新形式のエントリ）', async () => {
    const h = harness();
    await writeBased(h, { slug: 'values', content: '12345', summary: '最初の書き込み' });
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    if (entry === undefined) throw new Error('memory_write が日誌へ記録していない');

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('write');
    expect(reply).toContain('bytes=0→6');
  });

  it('action / バイト数を持たない古いエントリは「不明」と明示し、0 としては出さない', async () => {
    const h = harness();
    const legacy = await h.stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'human',
      summary: '古い形式のエントリ（action フィールドが無い）',
    });

    const reply = await h.call('journal_read', { id: legacy.id });

    expect(reply).not.toContain('bytes=0→0');
    expect(reply).not.toMatch(/bytes=0(?!→)/);
    expect(reply).toContain('不明');
  });

  it('head のバイト表示（bytes=）が、summary 由来の文字数（body の自由文）の側へ紛れ込まない', async () => {
    const h = harness();
    await h.stores.persona.write('temp-note', '12345');
    await delBased(h, { slug: 'temp-note', summary: '片付け' });
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    if (entry === undefined) throw new Error('memory_delete が日誌へ記録していない');

    const reply = await h.call('journal_read', { id: entry.id });
    const separatorIndex = reply.indexOf('\n\n');
    const headLine = reply.slice(0, separatorIndex);
    const body = reply.slice(separatorIndex + 2);

    expect(headLine).toContain('bytes=6→0');
    expect(body).toContain('文字');
    expect(body).not.toContain('bytes=');
  });
});

describe('self_dropped（自分の跡を器の中から読み戻す。#242）', () => {
  it('まだ何も落としていなければ、そう分かる形で返す（黙って空を返さない）', async () => {
    const h = harness();
    clearRecentTracesForTesting();

    const reply = await h.call('self_dropped', {});

    expect(reply).toContain('まだ');
    expect(reply).not.toBe('');
  });

  it('落とした跡が実際に読み戻せる（本文は乗らない）', async () => {
    const h = harness();
    clearRecentTracesForTesting();
    const secret = 'ghp_000000000000000000000000000000000000';
    setStderrSinkForTesting(() => {});
    try {
      noteDroppedRecord(
        '日誌',
        journalEntryShape({ type: 'decision', decision: secret, grounds: secret }),
        new Error('storage is closed'),
      );
    } finally {
      setStderrSinkForTesting(null);
    }

    const reply = await h.call('self_dropped', {});

    expect(reply).toContain('日誌を記録できませんでした');
    expect(reply).toContain('storage is closed');
    expect(reply).not.toContain(secret);
  });

  it('limit で直近何件かに絞れる（既定より少なく要求すれば、その件数だけ返る）', async () => {
    const h = harness();
    clearRecentTracesForTesting();
    setStderrSinkForTesting(() => {});
    try {
      for (let index = 0; index < 5; index += 1) {
        noteManagerIdCollision(`mgr-${index}`, 1);
      }
    } finally {
      setStderrSinkForTesting(null);
    }

    const reply = await h.call('self_dropped', { limit: 2 });

    expect(reply).toContain('managerId=mgr-3 ');
    expect(reply).toContain('managerId=mgr-4 ');
    expect(reply).not.toContain('managerId=mgr-0 ');
    expect(reply).not.toContain('managerId=mgr-1 ');
    expect(reply).not.toContain('managerId=mgr-2 ');
    expect(reply).toContain('続きは self_dropped offset=2 で取れる');
    expect(reply).toContain('limit を上げても動かない');
  });

  it('limit を上げても、予算で切れる境界（何が載るか）は動かない（#662）', async () => {
    const h = harness();
    clearRecentTracesForTesting();
    setStderrSinkForTesting(() => {});
    try {
      for (let index = 0; index < 200; index += 1) {
        noteManagerIdCollision(`mgr-${String(index).padStart(3, '0')}`, 1);
      }
    } finally {
      setStderrSinkForTesting(null);
    }

    const withLimit100 = await h.call('self_dropped', { limit: 100 });
    const withLimit200 = await h.call('self_dropped', { limit: 200 });

    expect(withLimit100).toContain('件は省略');
    expect(withLimit200).toContain('件は省略');

    const tracesOf = (reply: string) =>
      reply.split('\n').filter((line) => line.startsWith('alteroid: '));
    expect(tracesOf(withLimit200)).toEqual(tracesOf(withLimit100));

    expect(withLimit100).not.toContain('managerId=mgr-050 ');
    expect(withLimit200).not.toContain('managerId=mgr-050 ');
  });

  it('offset で、予算に阻まれていた古い側へ実際に到達できる（#662）', async () => {
    const h = harness();
    clearRecentTracesForTesting();
    setStderrSinkForTesting(() => {});
    try {
      for (let index = 0; index < 200; index += 1) {
        noteManagerIdCollision(`mgr-${String(index).padStart(3, '0')}`, 1);
      }
    } finally {
      setStderrSinkForTesting(null);
    }

    const reply = await h.call('self_dropped', { offset: 100 });

    expect(reply).toContain('managerId=mgr-099 ');
    expect(reply).toContain('managerId=mgr-050 ');
    expect(reply).not.toContain('managerId=mgr-199 ');
    expect(reply).not.toContain('managerId=mgr-100 ');
  });

  it('この道具そのものは HTTP に出していない（`self_read` / `self_status` と同じ扱い）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('self_dropped'));
  });
});

describe('システムプロンプトの道具一覧', () => {
  it('CLONE_TOOL_NAMES の全部が載っている（一覧に無い道具を作らない）', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });
    expect(prompt).toContain('\n# 道具\n');
    expect(prompt).toContain('\n# 委譲\n');
    const section = prompt.split('# 道具')[1]?.split('# 委譲')[0];
    expect(section).toBeDefined();
    const missing = CLONE_TOOL_NAMES.filter((name) => !(section ?? '').includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});

describe('自作ツールの日誌名簿（SELF_JOURNALING_CLONE_TOOLS / TRACELESS_CLONE_TOOLS）', () => {
  it('CLONE_TOOL_NAMES の全部が、2つの名簿のちょうど一方に属する', () => {
    const selfJournaling = new Set<string>(SELF_JOURNALING_CLONE_TOOLS);
    const traceless = new Set<string>(TRACELESS_CLONE_TOOLS);

    const inNeither = CLONE_TOOL_NAMES.filter(
      (name) => !selfJournaling.has(name) && !traceless.has(name),
    );
    expect(inNeither).toEqual([]);

    const inBoth = CLONE_TOOL_NAMES.filter(
      (name) => selfJournaling.has(name) && traceless.has(name),
    );
    expect(inBoth).toEqual([]);
  });

  it('2つの名簿に載っている名前は、全部 CLONE_TOOL_NAMES に在る（架空の名前が混ざっていない）', () => {
    const known = new Set<string>(CLONE_TOOL_NAMES);

    const unknownInSelfJournaling = SELF_JOURNALING_CLONE_TOOLS.filter((name) => !known.has(name));
    expect(unknownInSelfJournaling).toEqual([]);

    const unknownInTraceless = TRACELESS_CLONE_TOOLS.filter((name) => !known.has(name));
    expect(unknownInTraceless).toEqual([]);
  });

  it('cloneToolJournalsItself は、名簿に無い未知の修飾名に false（＝残す側）を返す', () => {
    expect(cloneToolJournalsItself(qualifiedToolName('future_tool'))).toBe(false);
    for (const name of SELF_JOURNALING_CLONE_TOOLS) {
      expect(cloneToolJournalsItself(qualifiedToolName(name))).toBe(true);
    }
    for (const name of TRACELESS_CLONE_TOOLS) {
      expect(cloneToolJournalsItself(qualifiedToolName(name))).toBe(false);
    }
  });
});

describe('cloneToolCarriesSecrets（Issue #1338 残件1——秘密を運ぶ自作ツールの名簿）', () => {
  it('profile_write だけが秘密を運ぶ側として true を返す', () => {
    expect(cloneToolCarriesSecrets(qualifiedToolName('profile_write'))).toBe(true);
    for (const name of SELF_JOURNALING_CLONE_TOOLS) {
      if (name === 'profile_write') continue;
      expect(cloneToolCarriesSecrets(qualifiedToolName(name))).toBe(false);
    }
  });

  it('名簿に無い未知の修飾名には false を返す（TRACELESS 側・未知の自作ツール）', () => {
    for (const name of TRACELESS_CLONE_TOOLS) {
      expect(cloneToolCarriesSecrets(qualifiedToolName(name))).toBe(false);
    }
    expect(cloneToolCarriesSecrets(qualifiedToolName('future_tool'))).toBe(false);
  });
});

describe('detectMcpInputValidationFailure（Issue #1338 残件1）', () => {
  it('印が無い tool_response には undefined を返す（成功応答を誤検知しない）', () => {
    expect(detectMcpInputValidationFailure(undefined)).toBeUndefined();
    expect(detectMcpInputValidationFailure('日誌に記録した（j-1）。')).toBeUndefined();
    expect(
      detectMcpInputValidationFailure({
        content: [{ type: 'text', text: '日誌に記録した（j-1）。' }],
        isError: false,
      }),
    ).toBeUndefined();
  });

  it('印を含む文字列 tool_response は検証落ちとして検知する', () => {
    const message = `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}journal_write: [{"path":["decision"]}]`;
    const result = detectMcpInputValidationFailure(message);
    expect(result).toBeDefined();
    expect(result?.message).toBe(message);
    expect(result?.fields).toEqual(['decision']);
  });

  it('オブジェクトの tool_response でも、文字列化した中に印が在れば検知する（形を仮定しない）', () => {
    const result = detectMcpInputValidationFailure({
      content: [
        {
          type: 'text',
          text: `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}memory_delete: [{"path":["summary"]}]`,
        },
      ],
      isError: true,
    });
    expect(result).toBeDefined();
    expect(result?.fields).toEqual(['summary']);
  });

  it('欄名は「at <path>」形式と JSON の "path": [...] 形式の両方から拾う', () => {
    const dotPathForm = `${MCP_INPUT_VALIDATION_ERROR_MARKER}journal_write: 引数が届いていない at decision`;
    expect(detectMcpInputValidationFailure(dotPathForm)?.fields).toEqual(['decision']);

    const jsonForm = `${MCP_INPUT_VALIDATION_ERROR_MARKER}journal_write: [{"code":"invalid_type","path":["decision"],"message":"x"}]`;
    expect(detectMcpInputValidationFailure(jsonForm)?.fields).toEqual(['decision']);

    const jsonFormMultiple = `${MCP_INPUT_VALIDATION_ERROR_MARKER}profile_write: [{"path":["script"]},{"path":["summary"]}]`;
    expect(detectMcpInputValidationFailure(jsonFormMultiple)?.fields).toEqual([
      'script',
      'summary',
    ]);
  });

  it('欄名が取れなくても、検証落ちという判定そのものは undefined へ倒れない（best-effort）', () => {
    const message = `${MCP_INPUT_VALIDATION_ERROR_MARKER}journal_write: (path 情報なし)`;
    const result = detectMcpInputValidationFailure(message);
    expect(result).toBeDefined();
    expect(result?.fields).toEqual([]);
  });
});

describe('一覧は例外なく件数で壊れない（`*_list` の総当たり）', () => {
  const SWEPT = CLONE_TOOL_NAMES.filter((name) => name.endsWith('_list'));

  const SWEPT_MARKS: Record<string, RegExp> = {
    memory_list: /…ほか \d+ 件は省略（記憶は全 \d+ 件あり、\d+ 件だけ出した）。/,
    approvals_list:
      /…ほか \d+ 件は省略（回答待ちは \d+ 件あり、作成が古い順に先頭から \d+ 件だけ出した）。/,
    schedule_list: /…ほか \d+ 件は省略（継続中の依頼は \d+ 件あり、\d+ 件だけ出した。/,
    commitment_list: /…ほか \d+ 件は省略（未了は \d+ 件あり、古い順に \d+ 件だけ出した。/,
    token_list: /…ほか \d+ 件は省略（プールは \d+ 件あり、order の昇順に \d+ 件だけ出した）。/,
    permission_grant_list:
      /…ほか \d+ 件は省略（許可の記録は \d+ 件あり、grantedAt の昇順に \d+ 件だけ出した）。/,
    account_list:
      /…ほか \d+ 件は省略（アカウントは \d+ 件あり、createdAt の昇順に \d+ 件だけ出した）。/,
    manager_list: /…ほか \d+ 件は省略（全 \d+ 件）。/,
    runner_list: /…ほか \d+ 台は省略（登録は \d+ 台あり、\d+ 台だけ出した）。/,
    file_list:
      /…ほか \d+ 件は省略（この呼び出しで \d+ 件取り、新しい順に \d+ 件だけ出した）。続きは file_list cursor=[A-Za-z0-9_-]+ /,
    practice_list:
      /…ほか \d+ 件は省略（全 \d+ 件のうち slug の昇順に \d+ 件だけ出した）。この一覧に続きを取る口はまだ無い/,
  };

  function sweptMark(name: string): RegExp {
    const mark = SWEPT_MARKS[name];
    if (mark === undefined) {
      throw new Error(
        `SWEPT_MARKS: '${name}' の一覧レベルの断り書きが名簿に無い。` +
          '実際の応答からその逐語を写して足すこと（⛔ 他の道具から写さない）。' +
          '足さずに素の TRUNCATION_MARK へ落とすと、1件ごとの抜粋の「省略」が' +
          '代わりに合格を出して、この道具の歯だけが黙って空になる（#935）。',
      );
    }
    return mark;
  }

  const OUTLINE_FLOOD_SLUG = 'outline-flood';
  const OUTLINE_FLOOD_SECTIONS = 240;

  const NAMED: {
    label: string;
    name: string;
    args: Record<string, unknown>;
    argsOf?: (h: Harness) => Promise<Record<string, unknown>>;
    section?: string;
    mark?: RegExp;
    absent?: RegExp;
  }[] = [
    {
      label: 'journal_read（既定）',
      name: 'journal_read',
      args: {},
      absent: /…ほか \d+ 件は省略（この条件で/,
    },
    {
      label: 'journal_read（limit 最大）',
      name: 'journal_read',
      args: { limit: 200 },
      mark: /…ほか \d+ 件は省略（この条件で \d+ 件あり、新しい順に \d+ 件だけ出した）。/,
    },
    {
      label: 'journal_read（語で探す）',
      name: 'journal_read',
      args: { q: '決めた' },
      absent: /…ほか \d+ 件は省略（この条件で/,
    },
    {
      label: 'journal_read（語で探す・limit 最大）',
      name: 'journal_read',
      args: { q: '決めた', limit: 200 },
      mark: /…ほか \d+ 件は省略（この条件で \d+ 件あり、新しい順に \d+ 件だけ出した）。/,
    },
    {
      label: 'usage_read',
      name: 'usage_read',
      args: {},
      mark: /…（残り \d+ 件は出していない。axis="[a-z]+", cursor="[A-Za-z0-9_-]+" で続きが出る）/,
    },
    {
      label: 'conversation_read（会話の一覧）',
      name: 'conversation_read',
      args: {},
      mark: /…ほか \d+ 件は省略（この窓に \d+ 件あり、新しい順に \d+ 件だけ出した）。省いたのは\*\*古い側\*\*で、切ったのは limit=\d+ である。/,
    },
    {
      label: 'conversation_read（会話の一覧・limit 最大）',
      name: 'conversation_read',
      args: { limit: 200 },
      mark: /…ほか \d+ 件は省略（この窓に \d+ 件あり、新しい順に \d+ 件だけ出した）。省いたのは\*\*古い側\*\*である。limit を増やしても出てこない/,
    },
    {
      label: 'conversation_read（会話の中身）',
      name: 'conversation_read',
      args: { conversationId: 'conv-long' },
      mark: /…この会話の\*\*古い側\*\* \d+ 件は省略（この窓に \d+ 件あり、新しい側から \d+ 件だけ出した）。/,
    },
    {
      label: 'conversation_read（語で探す）',
      name: 'conversation_read',
      args: { q: '発言' },
      mark: /…ほか \d+ 件は省略（"[^"]*" に \d+ 件当たり、新しい順に \d+ 件だけ出した）。/,
    },
    {
      label: 'self_status（記憶の大きさ）',
      name: 'self_status',
      args: {},
      section: '## 記憶の大きさ',
      mark: /…ほか \d+ 文書は省略（全 \d+ 文書のうち \d+ 文書だけ出した）。/,
    },
    {
      label: 'self_status（台帳との突き合わせ）',
      name: 'self_status',
      args: {},
      section: '## 台帳との突き合わせ',
      mark: /…（残り \d+ 件は出していない。self_status の ledgerCursor=[A-Za-z0-9_-]+ で続きが出る）/,
    },
    {
      label: 'memory_outline（既定＝先頭から）',
      name: 'memory_outline',
      args: { slug: OUTLINE_FLOOD_SLUG },
      mark: /…末尾 \d+ 節は省略（節は全 \d+ 件あり、先頭から \d+ 件だけ出した）。/,
    },
    {
      label: 'memory_outline（side=tail＝末尾から）',
      name: 'memory_outline',
      args: { slug: OUTLINE_FLOOD_SLUG, side: 'tail' },
      mark: /…先頭 \d+ 節は省略（節は全 \d+ 件あり、末尾から \d+ 件だけ出した）。/,
    },
    {
      label: 'memory_write（消えた見出しの列挙）',
      name: 'memory_write',
      args: {
        slug: OUTLINE_FLOOD_SLUG,
        content: '---\ndescription: 畳んだ\ntype: fact\n---\n# 残した節\n\n本文',
        summary: '節を1つへ畳んだ',
      },
      argsOf: async (h) => ({
        slug: OUTLINE_FLOOD_SLUG,
        content: '---\ndescription: 畳んだ\ntype: fact\n---\n# 残した節\n\n本文',
        summary: '節を1つへ畳んだ',
        base_version: memoryVersion((await h.stores.persona.read(OUTLINE_FLOOD_SLUG))!.content),
      }),
      mark: /…ほか \d+ 件は省略（消えた見出しは全 \d+ 件のうち \d+ 件だけ出した）。/,
    },
    {
      label: 'self_dropped',
      name: 'self_dropped',
      args: {},
      mark: /…ほか古い \d+ 件は省略（帳面には全 \d+ 件あり、直近から \d+ 件だけ出した）。続きは self_dropped offset=\d+ で取れる（limit を上げても動かない）。/,
    },
    {
      label: 'memory_section_move（移した節の列挙）',
      name: 'memory_section_move',
      args: {},
      argsOf: async (h) => {
        const doc = await h.stores.persona.read(OUTLINE_FLOOD_SLUG);
        if (doc === null) throw new Error('OUTLINE_FLOOD_SLUG が flooded() で積まれていない');
        const { sections } = scanMemorySections(doc.content);
        return {
          fromSlug: OUTLINE_FLOOD_SLUG,
          sections: sections.map((section) => section.id),
          toSlug: 'section-move-flood-target',
          summary: '節をまとめて付録へ移した（掃き出しの歯）',
        };
      },
      mark: /…ほか \d+ 節は一覧から省略（移した \d+ 節のうち \d+ 節だけ出した。/,
    },
  ];

  const OUTPUT_CAP = 12_000;

  const TRUNCATION_MARK = /省略|残り \d|文字目/;

  function extractSection(reply: string, heading: string): string {
    const lines = reply.split('\n');
    const start = lines.findIndex((line) => line.startsWith(heading));
    if (start === -1) {
      throw new Error(`extractSection: 節が見つからない（heading="${heading}"）`);
    }
    const nextHeading = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const end = nextHeading === -1 ? lines.length : nextHeading;
    return lines.slice(start, end).join('\n');
  }

  it('掃き出しが空にならない（検出器そのものが効いていることの確認）', () => {
    expect(SWEPT.length).toBeGreaterThanOrEqual(6);
    expect(SWEPT).toContain('approvals_list');
    expect(SWEPT).toContain('schedule_list');
    expect(SWEPT).toContain('runner_list');
    expect(SWEPT).toContain('memory_list');
    expect(SWEPT).toContain('commitment_list');
    expect(SWEPT).toContain('manager_list');
  });

  const LEDGER_SDK_MODEL = 'claude-listing-sweep-model';

  const LISTING_SWEEP_RUNTIME: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    buildTime: { builtAt: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: LEDGER_SDK_MODEL,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: heuristicChars(0),
    systemPromptChars: heuristicChars(0),
    lastContextUsage: null,
  };

  async function flooded(count: number): Promise<Harness> {
    // 積む前に空にする: `self_dropped` の帳面はこのテストファイルの生存中ずっと1つを共有するため
    clearRecentTracesForTesting();
    const h = harness(() => LISTING_SWEEP_RUNTIME);
    const long = 'あ'.repeat(1_500);

    for (let index = 0; index < count; index += 1) {
      const pad = String(index).padStart(4, '0');
      await h.call('manager_start', { request: `依頼${pad}: ${long}` });
      await h.stores.jobs.putApproval({
        id: `ap-${pad}`,
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        question: `質問${pad}: ${long}`,
        jobId: `mgr-${pad}`,
        requestId: `req-${pad}`,
      });
      await h.call('schedule_create', {
        kind: `watch-${pad}`,
        request: `仕込み${pad}: ${long}`,
        everyMinutes: 60,
      });
      await h.call('commitment_open', { body: `約束${pad}: ${long}` });
      await h.stores.persona.write(
        `doc-${pad}`,
        `---\ndescription: 要旨${pad} ${long}\ntype: fact\n---\n# 題${pad}\n\n${long}`,
      );
      await h.call('journal_write', { type: 'decision', decision: `決めた${pad}: ${long}` });
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `人間の発言${pad}: ${long}`,
        conversationId: `conv-${pad}`,
      });
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'outbound',
        text: `クローンの返答${pad}: ${long}`,
        conversationId: `conv-${pad}`,
      });
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `長い会話の発言${pad}: ${long}`,
        conversationId: 'conv-long',
      });
      await h.stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'cumulative',
        managerId: `mgr-${pad}`,
        date: usageDate(new Date(2026, 7, 14, 10, 0)),
        at: new Date(2026, 7, 14, 10, 0).toISOString(),
        snapshot: {
          models: {
            [`claude-model-${pad}`]: {
              inputTokens: 10,
              outputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1 + index,
            },
            [LEDGER_SDK_MODEL]: {
              inputTokens: 10,
              outputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1 + index,
            },
          },
        },
      });
      // 本文ではなく title を長くして嵩上げする: practice_list はメタしか出さないため
      await h.call('practice_write', {
        slug: `practice-${pad}`,
        kind: `種類${pad}`,
        title: `やり方${pad}: ${long}`,
        content: `本文${pad}`,
      });
    }
    // ループの中で作らない: 要るのは文書の件数ではなく1つの文書の節数で、1文書1節のままでは `MEMORY_OUTLINE_BUDGET` が拘束条件にならないため
    // type: fact にする: プロンプトへ焼かれる量を増やさないため
    // 節ごとに本文を変える: 中身まで同一の節は節id が衝突し、`renderMemoryOutline` が ⚠ を付けるため
    // 名前を長くして嵩上げする: file_list は控えだけ（名前・種類・出所など）を出し、1行ごとに名前を抜粋で締めるため
    for (let index = 0; index < count; index += 1) {
      const pad = String(index).padStart(4, '0');
      await h.stores.attachments.put({
        name: `添付${pad}-${long.slice(0, 200)}.txt`,
        mediaType: 'text/plain',
        bytes: new Uint8Array(8).fill(65),
      });
    }
    await h.stores.persona.write(
      OUTLINE_FLOOD_SLUG,
      `---\ndescription: 節の多い文書（目次と見出しの列挙の足場）\ntype: fact\n---\n` +
        Array.from({ length: OUTLINE_FLOOD_SECTIONS }, (_, index) => {
          const pad = String(index).padStart(4, '0');
          return `# 節${pad}: ${'み'.repeat(40)}\n\n本文${pad}\n`;
        }).join('\n'),
    );
    setStderrSinkForTesting(() => {});
    try {
      for (let index = 0; index < count; index += 1) {
        const pad = String(index).padStart(4, '0');
        noteDroppedRecord('probe', `flood-${pad}`, new Error(`理由${pad}: ${'x'.repeat(250)}`));
      }
    } finally {
      setStderrSinkForTesting(null);
    }
    // ループの外で一度に積む: `replace` は全文置換で、1本ずつ足すと毎回上書きになるため
    await h.stores.tokens.replace(
      Array.from({ length: count }, (_, index) => {
        const pad = String(index).padStart(4, '0');
        return {
          id: `tok-${pad}`,
          label: `予備${pad}: ${long}`,
          value: `fake-value-${pad}`,
          order: index,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          cooldownUntil: Date.now() + 3_600_000,
          lastRejectedReason: `止まった理由${pad}: ${long}`,
        };
      }),
    );
    for (let index = 0; index < count; index += 1) {
      const pad = String(index).padStart(4, '0');
      await h.stores.permissionGrants.put({
        id: `pg-${pad}`,
        rule: `Bash(echo fake-${pad}-${long}:*)`,
        allows: [`echo fake-${pad}-${long}`],
        denies: [`rm fake-${pad}-${long}`],
        approvalId: `ap-pg-${pad}`,
        answer: `許可します ${long}`,
        grantedAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        route: { principalKind: 'account', accountId: 'acct-fake' },
      });
    }
    for (let index = 0; index < count; index += 1) {
      const pad = String(index).padStart(4, '0');
      await h.stores.auth.putAccount({
        id: `acct-${pad}`,
        displayName: `Flood Name ${pad}`,
        email: `flood-${pad}@example.test`,
        createdAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        lastLoginAt: '2026-02-01T00:00:00.000Z',
        grantedAt: '2026-01-02T00:00:00.000Z',
        grantedBy: 'operator',
        ownerDeclaredAt: null,
      });
    }
    for (const summary of h.running) {
      summary.lastReport = `報告: ${'ほ'.repeat(3_000)}`;
      summary.waiting = [
        {
          requestId: `req-${summary.managerId}`,
          summary: 'ま'.repeat(3_000),
          kind: 'permission',
          askedAt: '2026-08-01T00:00:00.000Z',
        },
      ];
    }
    h.setRunnersOverview({
      runners: Array.from({ length: 120 }, (_, index) => ({
        label: `runner-${index}`,
        state: 'connected' as const,
        since: '2026-01-01T00:00:00.000Z',
        runnerId: `runner-${index}`,
        workspacePath: '/workspace',
        revision: { status: 'unknown' as const },
        managers: h.running.map((m) => ({ managerId: m.managerId, status: m.status, live: false })),
      })),
      unassigned: h.running.map((m) => ({
        managerId: m.managerId,
        status: m.status,
        live: false,
      })),
      daemonRevision: { status: 'unknown' as const },
    });
    return h;
  }

  const CASES: {
    label: string;
    name: string;
    args: Record<string, unknown>;
    argsOf?: (h: Harness) => Promise<Record<string, unknown>>;
    section?: string;
    mark?: RegExp;
    absent?: RegExp;
  }[] = [
    ...SWEPT.map((name) => ({
      label: name,
      name,
      args: {} as Record<string, unknown>,
      mark: sweptMark(name),
    })),
    ...NAMED,
  ];

  it.each(CASES)('$label — 件数が増えても出力は上限内に収まる', async ({ name, args, argsOf }) => {
    const h = await flooded(60);
    const effectiveArgs = argsOf === undefined ? args : await argsOf(h);

    const reply = await h.call(name, effectiveArgs);

    expect(reply.length).toBeLessThan(OUTPUT_CAP);
  });

  it.each(CASES)(
    '$label — 切ったなら黙らない（省いたことが出力に出る）',
    async ({ label, name, args, argsOf, section, mark, absent }) => {
      const h = await flooded(60);
      const effectiveArgs = argsOf === undefined ? args : await argsOf(h);

      const reply = await h.call(name, effectiveArgs);

      if ((mark === undefined) === (absent === undefined)) {
        throw new Error(
          `CASES: mark と absent は、どちらか一方だけを指定すること（label="${label}"）。` +
            'どちらも無いと表明が素の TRUNCATION_MARK へ落ち、1件ごとの抜粋の「省略」が' +
            '代わりに合格を出して、この歯は何も測らなくなる（#406 / #935）。' +
            '両方在ると、同じ断り書きについて出ていることと出ていないことを同時に主張する。',
        );
      }
      const scope = section === undefined ? reply : extractSection(reply, section);

      if (absent !== undefined) {
        expect(scope).not.toMatch(absent);
        return;
      }
      expect(scope).toMatch(mark!);

      expect(mark!.exec(scope)?.[0] ?? '').toMatch(TRUNCATION_MARK);
    },
  );

  const AXIS_UNDECIDED = new Map<string, string>([
    [
      'runner_list',
      // `unknown` で埋めない: 作成時刻の軸そのものが未定義で、`unknown` は「在るはずだが根拠が無い」を表す値のため
      '人間が出さないと決めた（2026-08-23。runner_list には作成時刻を置かない。unknown で埋めない）',
    ],
  ]);

  const SHAPE_DIFFERENT = new Map<string, string>([
    [
      'memory_list',
      '形が違うことが設計（P1 は満たす）。階層をインデントで表す1行1件の木なので、' +
        '4つの一覧と同じ3行ブロックへ寄せると親子関係を表す手段が消える。' +
        '#220（記憶に createdAt を持たせ memory_list に出す）は既にマージ済みで、' +
        '「#220 待ち」という理由はもう書けない',
    ],
  ]);

  const FIVE_FIELD_SWEPT = SWEPT.filter((name) => !AXIS_UNDECIDED.has(name));
  const STRICT_SHAPE_SWEPT = FIVE_FIELD_SWEPT.filter((name) => !SHAPE_DIFFERENT.has(name));

  it('P1/P2 それぞれの網が空にならず、除外は実在する道具を指している', () => {
    for (const name of AXIS_UNDECIDED.keys()) expect(SWEPT).toContain(name);
    for (const name of SHAPE_DIFFERENT.keys()) expect(SWEPT).toContain(name);
    expect(FIVE_FIELD_SWEPT.length).toBeGreaterThanOrEqual(5);
    expect(FIVE_FIELD_SWEPT).toContain('approvals_list');
    expect(FIVE_FIELD_SWEPT).toContain('schedule_list');
    expect(FIVE_FIELD_SWEPT).toContain('commitment_list');
    expect(FIVE_FIELD_SWEPT).toContain('manager_list');
    expect(FIVE_FIELD_SWEPT).toContain('memory_list');
    expect(STRICT_SHAPE_SWEPT.length).toBeGreaterThanOrEqual(4);
    expect(STRICT_SHAPE_SWEPT).toContain('approvals_list');
    expect(STRICT_SHAPE_SWEPT).toContain('schedule_list');
    expect(STRICT_SHAPE_SWEPT).toContain('commitment_list');
    expect(STRICT_SHAPE_SWEPT).toContain('manager_list');
    expect(STRICT_SHAPE_SWEPT).not.toContain('memory_list');
    expect(STRICT_SHAPE_SWEPT).not.toContain('runner_list');
  });

  function splitListingEntries(reply: string): string[] {
    const lines = reply.split('\n');
    const starts: number[] = [];
    lines.forEach((line, index) => {
      if (/^\s*-\s\S/.test(line)) starts.push(index);
    });
    return starts.map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]! : lines.length;
      return lines.slice(start, end).join('\n');
    });
  }

  const CREATED_AT_PATTERN = /作成: (?:\d{4}-\d{2}-\d{2}T[\d:.]+Z|不明)/;
  const UPDATED_AT_PATTERN = /更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z/;
  const ID_AND_NAME_PATTERN = /^\s*-\s+\S+\s+\S/;
  const TIMESTAMP_PAIR_PATTERN =
    /作成: (?:\d{4}-\d{2}-\d{2}T[\d:.]+Z|不明) \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z/;

  function hasSummaryBeyondTimestamps(entry: string): boolean {
    const withoutTimestamps = entry.replace(TIMESTAMP_PAIR_PATTERN, '');
    const lines = withoutTimestamps.split('\n');
    const hasSummaryLine = (lines[2] ?? '').trim().length > 0;
    const hasInlineSummary = /—\s*\S/.test(lines[0] ?? '');
    return hasSummaryLine || hasInlineSummary;
  }

  function fiveFieldViolations(entry: string): string[] {
    const violations: string[] = [];
    const firstLine = entry.split('\n')[0] ?? '';
    if (!CREATED_AT_PATTERN.test(entry)) violations.push('作成 が無い');
    if (!UPDATED_AT_PATTERN.test(entry)) violations.push('更新 が無い');
    if (!ID_AND_NAME_PATTERN.test(firstLine)) violations.push('id + 名前 が先頭行に無い');
    if (!hasSummaryBeyondTimestamps(entry))
      violations.push('概要 が無い（3行目も、1行目の — の後ろも空）');
    return violations;
  }

  function matchesStrictBlockShape(entry: string): boolean {
    const lines = entry.split('\n');
    if (!/^- \S+ \S/.test(lines[0] ?? '')) return false;
    if (
      !/^ {2}作成: \d{4}-\d{2}-\d{2}T[\d:.]+Z \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(
        lines[1] ?? '',
      )
    )
      return false;
    if (!/^ {2}\S/.test(lines[2] ?? '')) return false;
    return true;
  }

  it.each(FIVE_FIELD_SWEPT)(
    '%s — どの1件も id + 名前 / 作成 + 更新 / 概要 を出す（形は問わない。P1）',
    async (name) => {
      const h = await flooded(60);

      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(fiveFieldViolations(entry)).toEqual([]);
      }
    },
  );

  function extractMemorySizeEntries(reply: string): string[] {
    const heading = '## 記憶の大きさ';
    const start = reply.indexOf(heading);
    if (start === -1) return [];
    const rest = reply.slice(start);
    const nextHeadingAt = rest.indexOf('\n## ', heading.length);
    const section = nextHeadingAt === -1 ? rest : rest.slice(0, nextHeadingAt);
    const lines = section.split('\n');
    const totalAt = lines.findIndex((line) => line.startsWith('- 総文字数'));
    if (totalAt === -1) return [];
    const run: string[] = [];
    for (const line of lines.slice(totalAt + 1)) {
      if (!/^ {2}\S/.test(line)) break;
      run.push(line);
    }
    return splitListingEntries(run.join('\n'));
  }

  it(
    'extractMemorySizeEntries — 節に、文書一覧の後ろへ0字下げの新しい箇条書き' +
      '（文書一覧でない行）が増えても、その行を一覧の1件として数えない（#299）',
    () => {
      const section = [
        '## 記憶の大きさ（いま stores.persona を読み直した値）',
        '',
        '- 総文字数: 12,345 文字（3 文書）',
        '  - doc-a: 題0001 (作成: 2026-01-01T00:00:00.000Z / 更新: 2026-01-02T00:00:00.000Z) ' +
          '100 bytes — 要旨',
        '- 直近書き込みが多い上位3件:',
        '  - doc-b (直近24hで5回書き込み)',
        '',
        '## 次の節',
        '本文',
      ].join('\n');

      const entries = extractMemorySizeEntries(section);

      expect(entries).toEqual([
        '  - doc-a: 題0001 (作成: 2026-01-01T00:00:00.000Z / 更新: 2026-01-02T00:00:00.000Z) ' +
          '100 bytes — 要旨',
      ]);
      for (const entry of entries) {
        expect(fiveFieldViolations(entry)).toEqual([]);
      }
    },
  );

  it(
    'extractMemorySizeEntries — 集計行の直後という前提そのものが崩れたら、' +
      '混ぜずに空配列を返す（残る限界。#299）',
    () => {
      const section = [
        '## 記憶の大きさ（いま stores.persona を読み直した値）',
        '',
        '- 総文字数: 12,345 文字（3 文書）',
        '- 何か新しい0字下げの行',
        '  - doc-a: 題0001 (作成: 2026-01-01T00:00:00.000Z / 更新: 2026-01-02T00:00:00.000Z) ' +
          '100 bytes — 要旨',
        '',
        '## 次の節',
        '本文',
      ].join('\n');

      expect(extractMemorySizeEntries(section)).toEqual([]);
    },
  );

  it('self_status — 記憶の内訳のどの1件も id + 名前 / 作成 + 更新 / 概要 を出す（P1）', async () => {
    const h = await flooded(60);

    const reply = await h.call('self_status', {});
    const entries = extractMemorySizeEntries(reply);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(fiveFieldViolations(entry)).toEqual([]);
      expect(entry).toMatch(/題\d{4}/);
    }
  });

  it('self_status — 記憶の内訳を切ったら、件数と続きの取り方（memory_list / memory_read）が出る', async () => {
    const h = await flooded(60);

    const reply = await h.call('self_status', {});

    expect(reply).toMatch(/…ほか \d+ 文書は省略（全 \d+ 文書のうち \d+ 文書だけ出した）。/);
    expect(reply).toContain('memory_list');
    expect(reply).toContain('memory_read slug=<slug>');
  });

  it('⭐ 並びは寄与の大きい順で、予算で省略しても最大の premise は必ず出る', async () => {
    const h = await flooded(60);
    const sections = Array.from({ length: 40 }, (_, index) => {
      const pad = String(index).padStart(2, '0');
      return `## 節${pad}: ${'あ'.repeat(30)}\n\n本文${pad}\n`;
    }).join('\n');
    await h.stores.persona.write(
      'zzz-huge-premise',
      `---\ndescription: 巨大な前提の要旨\ntype: premise\n---\n# 巨大な前提\n\n${sections}`,
    );

    const contributions = await Promise.all(
      (await h.stores.persona.list()).map(async (meta) => {
        const doc = await h.stores.persona.read(meta.slug);
        return { slug: meta.slug, chars: measureMemoryFloor([doc as never]).totalChars };
      }),
    );
    const largest = contributions.reduce((best, entry) =>
      entry.chars > best.chars ? entry : best,
    );
    expect(largest.slug).toBe('zzz-huge-premise');
    expect([...contributions].sort((a, b) => a.slug.localeCompare(b.slug)).at(-1)?.slug).toBe(
      'zzz-huge-premise',
    );

    const reply = await h.call('self_status', {});

    expect(reply).toContain('[premise] zzz-huge-premise:');
    expect(reply.indexOf('[premise] zzz-huge-premise:')).toBeLessThan(
      reply.indexOf('[fact] doc-0000:'),
    );
    expect(reply).toContain('は省略');
  });

  const TITLE_IS_REAL_CONTENT_CASES: {
    name: string;
    check: (firstLine: string) => void;
  }[] = [
    {
      name: 'approvals_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に質問の1行目が無い: ${firstLine}`).toMatch(/^- \S+ 質問\d{4}/),
    },
    {
      name: 'schedule_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に周期の説明（60 分ごと）が無い: ${firstLine}`).toContain(
          '60 分ごと',
        ),
    },
    {
      name: 'commitment_list',
      check: (firstLine) =>
        expect(
          firstLine,
          `id の隣に出所の札（[自分で気づいた宿題]）が無い: ${firstLine}`,
        ).toContain('[自分で気づいた宿題]'),
    },
    {
      name: 'manager_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に状態の札（[running]）が無い: ${firstLine}`).toContain(
          '[running]',
        ),
    },
    {
      // `ready` を選ばない: 「状態の列が1つも立っていない」ときの値で、`title` を空文字へ落とす変異と見分けが付きにくいため
      name: 'token_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に状態（cooling）が無い: ${firstLine}`).toMatch(/^- \S+ cooling/),
    },
    {
      name: 'permission_grant_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に状態（有効）が無い: ${firstLine}`).toMatch(/^- \S+ 有効/),
    },
    {
      name: 'account_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に許可の状態（許可済み）が無い: ${firstLine}`).toMatch(
          /^- \S+ 許可済み/,
        ),
    },
    {
      name: 'practice_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に種類の札（[種類0000]）が無い: ${firstLine}`).toMatch(
          /^- \S+ \[種類\d{4}\]/,
        ),
    },
    {
      name: 'file_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に添付の名前（添付NNNN-…）が無い: ${firstLine}`).toMatch(
          /^- \S+ 添付\d{4}-/,
        ),
    },
  ];

  it.each(TITLE_IS_REAL_CONTENT_CASES)(
    '$name — id の隣は id そのものではなく、その一覧固有のタイトルである（#284）',
    async ({ name, check }) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        check(entry.split('\n')[0] ?? '');
      }
    },
  );

  it('memory_list — タイトルは id や slug の繰り返しではなく、記憶の見出しである（#284）', async () => {
    const h = await flooded(60);

    const reply = await h.call('memory_list', {});
    const entries = splitListingEntries(reply);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry, `記憶の見出し（題NNNN）が出ていない: ${entry}`).toMatch(/題\d{4}/);
    }
  });

  const TITLE_CHECK_NAMES = new Set<string>([
    ...TITLE_IS_REAL_CONTENT_CASES.map((c) => c.name),
    'memory_list',
  ]);

  const TITLE_CHECK_EXCLUDED = new Map<string, string>([]);

  it('タイトルの歯が FIVE_FIELD_SWEPT を漏れなく覆っている（新しい _list の足し忘れを検出する）', () => {
    for (const name of TITLE_CHECK_EXCLUDED.keys()) {
      expect(SWEPT, `除外 ${name} が実在する道具を指していない`).toContain(name);
    }

    const uncovered = FIVE_FIELD_SWEPT.filter(
      (name) => !TITLE_CHECK_NAMES.has(name) && !TITLE_CHECK_EXCLUDED.has(name),
    );
    expect(
      uncovered,
      'タイトルの歯（TITLE_IS_REAL_CONTENT_CASES への追加 / memory_list のような ' +
        '名指しの it() / 理由つきの TITLE_CHECK_EXCLUDED のいずれか）が無い一覧: ' +
        `${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it.each(STRICT_SHAPE_SWEPT)(
    '%s — どの1件も id + 名前 / 作成 + 更新 / 概要 を決まった順で出す（P2）',
    async (name) => {
      const h = await flooded(60);

      const reply = await h.call(name, {});
      const lines = reply.split('\n');
      const heads = lines.filter((line) => line.startsWith('- '));
      expect(heads.length).toBeGreaterThan(0);

      for (const [index, line] of lines.entries()) {
        if (!line.startsWith('- ')) continue;
        expect(line).toMatch(/^- \S+ \S/);
        expect(lines[index + 1]).toMatch(
          /^ {2}作成: \d{4}-\d{2}-\d{2}T[\d:.]+Z \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
        );
        expect(lines[index + 2]).toMatch(/^ {2}\S/);
      }
    },
  );

  it.each([...AXIS_UNDECIDED.keys()])(
    '%s は除外の理由どおり、いまも P1 を満たさない（満たしたら除外を外す番）',
    async (name) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      const anyViolation = entries.some((entry) => fiveFieldViolations(entry).length > 0);
      expect(anyViolation).toBe(true);
    },
  );

  it.each([...SHAPE_DIFFERENT.keys()])(
    '%s は P1 を満たし、P2 は満たさない（形が違うのは設計であることの実測）',
    async (name) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(fiveFieldViolations(entry)).toEqual([]);
      }
      const anyShapeMismatch = entries.some((entry) => !matchesStrictBlockShape(entry));
      expect(anyShapeMismatch).toBe(true);
    },
  );

  it('積んだ器が本当に溢れる量を持っている（上限を外すと落ちること）', async () => {
    const h = await flooded(60);

    const approvals = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    const raw = approvals.map((a) => a.question).join('\n');
    expect(raw.length).toBeGreaterThan(OUTPUT_CAP * 4);
  });

  it('memory_list で概要が無い記憶は、概要の不在として検出される（歯が緩んでいないことの確認）', async () => {
    const h = harness();
    await h.stores.persona.write(
      'doc-a',
      '---\ndescription: これは要旨である\ntype: fact\n---\n# 題A\n\n本文A',
    );
    await h.stores.persona.write('doc-b', '---\ntype: premise\n---\n# 題B\n\n本文B');

    const reply = await h.call('memory_list', {});
    const entries = splitListingEntries(reply);
    expect(entries.length).toBe(2);

    const withDescription = entries.find((entry) => entry.includes('doc-a'))!;
    const withoutDescription = entries.find((entry) => entry.includes('doc-b'))!;
    expect(fiveFieldViolations(withDescription)).toEqual([]);
    expect(fiveFieldViolations(withoutDescription)).toContain(
      '概要 が無い（3行目も、1行目の — の後ろも空）',
    );
  });
});

describe('一覧を抜粋にしたものには、全文の行き先がある', () => {
  it('approvals_list id=<id> で質問の全文が取れる', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: `頭${'あ'.repeat(400)}尻`,
      context: '背景の説明',
    });

    const listing = await h.call('approvals_list', {});
    const full = await h.call('approvals_list', { id: 'ap-1' });

    expect(listing).not.toContain('尻');
    expect(full).toContain('尻');
    expect(full).toContain('背景の説明');
  });

  it('approvals_list は回答が付いた件も id で読める（一覧からは消えていても）', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-done',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '本番に出してよいか',
      answeredAt: '2026-01-01T01:00:00.000Z',
      answer: 'よい',
    });

    expect(await h.call('approvals_list', {})).not.toContain('本番に出してよいか');

    const full = await h.call('approvals_list', { id: 'ap-done' });
    expect(full).toContain('本番に出してよいか');
    expect(full).toContain('よい');
    expect(full).toContain('回答済み');
  });

  it('approvals_list の全文が長ければ、続きの取り方が出力に出る', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-long',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: 'あ'.repeat(9_000),
    });

    const reply = await h.call('approvals_list', { id: 'ap-long' });

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
    expect(reply).toMatch(/文字目/);
  });

  it('schedule_list kind=<kind> で依頼本文の全文が取れる', async () => {
    const h = harness();
    await h.call('schedule_create', {
      kind: 'watch',
      request: `頭${'あ'.repeat(400)}尻`,
      everyMinutes: 60,
    });

    const listing = await h.call('schedule_list', {});
    const full = await h.call('schedule_list', { kind: 'watch' });

    expect(listing).not.toContain('尻');
    expect(full).toContain('尻');
  });

  it('memory_read は長ければ切れて、続きの取り方が出力に出る', async () => {
    const h = harness();
    await h.stores.persona.write('big', `# 題\n\n${'あ'.repeat(9_000)}`);

    const reply = await h.call('memory_read', { slug: 'big' });

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('memory_read');
    expect(reply).toContain('offset');
  });

  it('memory_read は offset で続きが取れる（分けて渡せば全部届く）', async () => {
    const h = harness();
    await h.stores.persona.write('big', `${'あ'.repeat(9_000)}しっぽ`);

    const first = await h.call('memory_read', { slug: 'big' });
    const second = await h.call('memory_read', { slug: 'big', offset: 8_000 });

    expect(first).not.toContain('しっぽ');
    expect(second).toContain('しっぽ');
  });

  it('memory_read は切れていないとき注記を出さない（目印を効かせるため）', async () => {
    const h = harness();
    await h.stores.persona.write('small', '# 題\n\n短い本文\n');

    const reply = await h.call('memory_read', { slug: 'small' });

    expect(reply).toMatch(/^# 題\n\n短い本文\n\n\n（版 base_version=[0-9a-f]{64} /);
    expect(reply).not.toContain('ここで切れている');
  });

  it('self_read は長い正典を切って返し、続きの取り方を示す', async () => {
    const h = harness();

    const reply = await h.call('self_read', { document: 'architecture' });

    expect(reply.length).toBeLessThan(12_000);
    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('self_read');
    expect(reply).toContain('offset');
  });

  it('self_read は offset で続きが取れる', async () => {
    const h = harness();

    const first = await h.call('self_read', { document: 'architecture' });
    const second = await h.call('self_read', { document: 'architecture', offset: 8_000 });

    expect(second).not.toBe(first);
    expect(second).toMatch(/文字目/);
  });

  it('profile_read が切れるときは、全文置換の危険まで言う', async () => {
    const h = harness();
    await h.call('profile_write', { script: `export A=1\n${'# 埋め草\n'.repeat(1_500)}` });

    const reply = await h.call('profile_read', { name: 'default' });

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
    expect(reply).toContain('全文置換');
  });
});

describe('commitment_list を文字数の予算へ寄せる（潜在バグの修正）', () => {
  it('commitment_list は件数ではなく文字数の予算で切る（30件を下回っていても長い本文なら切れる）', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.call('commitment_open', { body: `約束${String(index).padStart(3, '0')}: ${long}` });
    }

    const reply = await h.call('commitment_list', {});

    // `/省略/` だけにしない: 1件の本文の抜粋も「省略」を含むので、一覧の断り書きの形（`…ほか N 件は省略`）で狙う
    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('未了は 25 件あり');
    expect(reply.length).toBeLessThan(9_000);
  });

  it('commitment_list は includeClosed:true でも、省略の断り書きで片付いた分を未了と偽らない', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    const openCount = 15;
    const closedCount = 15;
    for (let index = 0; index < openCount; index += 1) {
      await h.stores.commitments.open({
        id: `open-${index}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `未了${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < closedCount; index += 1) {
      const id = `closed-${index}`;
      await h.stores.commitments.open({
        id,
        at: `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `片付いた${String(index).padStart(3, '0')}: ${long}`,
      });
      await h.stores.commitments.close(
        id,
        `2026-01-03T00:00:${String(index).padStart(2, '0')}.000Z`,
        '対応済み',
        'clone',
      );
    }
    const total = openCount + closedCount;

    const reply = await h.call('commitment_list', { includeClosed: true });

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain(`片付けた分を含めて ${total} 件あり`);
    expect(reply).not.toContain(`未了は ${total} 件あり`);
  });
});

describe('commitment_list は読めない行を隠さない（issue #296）', () => {
  it('一覧の末尾に「読めない行が N 件」が id 付きで出る（読める行が0件でも「無い」とは誤読しない）', async () => {
    const stores = createMemoryStores();
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list(options) {
          const base = await stores.commitments.list(options);
          return {
            entries: base.entries,
            unreadable: [
              { id: 'c-broken-1', at: '2026-08-01T00:00:00.000Z', reason: '型が合わない' },
            ],
            trimmedClosed: 0,
          };
        },
      },
    };
    const tools = createCloneTools({
      stores: withUnreadable,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');

    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(reply).toContain('読めない行が 1 件ある');
    expect(reply).toContain('c-broken-1');
    expect(reply).toContain('片付いたのではない');

    expect(reply).not.toBe('（引き受けたまま終わっていない仕事は無い）');
  });

  it('0件のときは断りを足さない', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    await opened?.handler({ body: '健全な依頼' } as never, {});

    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toContain('読めない行');
  });

  it('id が取れない行は件数だけに数える（id: の並びに出ない）', async () => {
    const stores = createMemoryStores();
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list() {
          return {
            entries: [],
            unreadable: [
              { id: 'c-broken-1', reason: '型が合わない' },
              { reason: 'id も取れない行' },
            ],
            trimmedClosed: 0,
          };
        },
      },
    };
    const tools = createCloneTools({
      stores: withUnreadable,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('読めない行が 2 件ある');
    expect(reply).toContain('（id: c-broken-1）');
  });

  it('読めない行が大量でも、id の列挙は上限で締まり省略の合図を出す', async () => {
    const stores = createMemoryStores();
    const count = 60;
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list() {
          return {
            entries: [],
            unreadable: Array.from({ length: count }, (_, index) => ({
              id: `c-broken-${index}`,
              reason: '型が合わない',
            })),
            trimmedClosed: 0,
          };
        },
      },
    };
    const tools = createCloneTools({
      stores: withUnreadable,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain(`読めない行が ${count} 件ある`);
    const line = reply.split('\n').find((entry) => entry.includes('読めない行が'));
    expect(line).toBeDefined();
    expect(line).toContain('c-broken-0');
    expect(line).not.toContain('c-broken-59');
    expect(line).toMatch(/…ほか \d+ 件は省略/);
  });
});

describe('commitment_open は「載せた」と名乗る前にストアを確かめる（issue #856）', () => {
  it('通常どおり書けたときは名乗り、日誌にも決定を残す（回帰）', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    const result = await opened?.handler({ body: '健全な依頼' } as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('台帳に載せた');
    expect(reply).not.toContain('確認できなかった');
  });

  it('open() が例外を投げずに解決しても、直後の get(id) が null なら「載せた」と名乗らない', async () => {
    const stores = createMemoryStores();
    const silentlyLostWrite: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async open() {
          return { opened: true, folded: false };
        },
        async get() {
          return null;
        },
      },
    };
    const tools = createCloneTools({
      stores: silentlyLostWrite,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    const result = await opened?.handler({ body: '静かに消える依頼' } as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toContain('台帳に載せた');
    expect(reply).toContain('確認できなかった');

    const decisions = await silentlyLostWrite.journal.list({ types: ['decision'] });
    expect(
      decisions.some(
        (entry) => entry.type === 'decision' && entry.decision.includes('台帳に載せた'),
      ),
    ).toBe(false);
  });

  it('open() が解決しても、直後の get(id) が UnreadableCommitmentError を投げるなら「載せた」と名乗らない', async () => {
    const stores = createMemoryStores();
    const unreadableAfterWrite: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async open() {
          return { opened: true, folded: false };
        },
        async get(id) {
          return Promise.reject(new UnreadableCommitmentError(`${id} は壊れて読めない`));
        },
      },
    };
    const tools = createCloneTools({
      stores: unreadableAfterWrite,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    const result = await opened?.handler({ body: '読めなくなる依頼' } as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toContain('台帳に載せた');
    expect(reply).toContain('確認できなかった');

    const decisions = await unreadableAfterWrite.journal.list({ types: ['decision'] });
    expect(
      decisions.some(
        (entry) => entry.type === 'decision' && entry.decision.includes('台帳に載せた'),
      ),
    ).toBe(false);
  });

  it('get(id) が UnreadableCommitmentError 以外を投げたら握り潰さずに上へ通す（器そのものの障害と取り違えない）', async () => {
    const stores = createMemoryStores();
    const brokenStore: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async open() {
          return { opened: true, folded: false };
        },
        async get() {
          throw new Error('DB接続断（器そのものの障害。テスト用）');
        },
      },
    };
    const tools = createCloneTools({
      stores: brokenStore,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    await expect(opened?.handler({ body: '器が壊れている依頼' } as never, {})).rejects.toThrow(
      'DB接続断（器そのものの障害。テスト用）',
    );
  });
});

describe('commitment_close が「台帳に無い」と答えるとき、機械側の記録の有無で言い分ける（issue #1060）', () => {
  it('機械が名乗った記録が日誌に在れば、「載った後に消えた」（#856 本体）と言う', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        '受信箱の合図から、引き受けた仕事として台帳に開いた（id: c-vanished）。' +
        '合図: manager_message kind=report',
    });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    const result = await close?.handler(
      { id: 'c-vanished', reason: '片付けようとした' } as never,
      {},
    );
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('台帳に無い');
    expect(reply).toContain('機械が名乗った記録は日誌に在る');
    expect(reply).toContain('#856 本体');
    expect(reply).toContain('id の取り違えではない');
  });

  it('機械が名乗った記録も日誌に無ければ、id の取り違えの可能性を言う（「名乗っていない」とは断定しない）', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    const result = await close?.handler(
      { id: 'c-typo-xyz', reason: '片付けようとした' } as never,
      {},
    );
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('台帳に無い');
    expect(reply).toContain('機械が名乗った記録も日誌に無い');
    expect(reply).toContain('取り違えた可能性がある');
    expect(reply).toContain('記録自体が落ちた場合と');
  });

  it('日誌が読めなければ「判定できない」と言い、握り潰して他の2つへ倒さない', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: () => Promise.reject(new Error('DB接続断（テスト用）')),
      },
    };
    const tools = createCloneTools({
      stores: broken,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const close = tools.find((entry) => entry.name === 'commitment_close');
    const result = await close?.handler(
      { id: 'c-unreadable', reason: '片付けようとした' } as never,
      {},
    );
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('台帳に無い');
    expect(reply).toContain('どちらかは判定できない');
    expect(reply).toContain('DB接続断（テスト用）');
    expect(reply).not.toContain('機械が名乗った記録は日誌に在る');
    expect(reply).not.toContain('機械が名乗った記録も日誌に無い');
  });

  it('⚠️ 対象は commitment_close だけである（commitment_edit の同じ枝は変えない）', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const edit = tools.find((entry) => entry.name === 'commitment_edit');
    const editResult = await edit?.handler({ id: 'c-none', body: '書き換え' } as never, {});
    const editReply = (editResult?.content ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(editReply).toBe('引き受けた仕事 c-none は台帳に無い。');
  });
});

describe('commitment_list は物理削除された片付き行を隠さない（issue #416）', () => {
  it('一覧の末尾に「保持上限を超えて物理削除された片付き行が累計 N 件ある」が出る', async () => {
    const stores = createMemoryStores();
    const withTrimmed: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list(options) {
          const base = await stores.commitments.list(options);
          return { ...base, trimmedClosed: 7 };
        },
      },
    };
    const tools = createCloneTools({
      stores: withTrimmed,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    await opened?.handler({ body: '健全な依頼' } as never, {});

    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('保持上限を超えて物理削除された片付き行が累計 7 件ある');
  });

  it('読める行・読めない行が0件でも、物理削除された片付き行が在れば「無い」とは言わない', async () => {
    const stores = createMemoryStores();
    const withTrimmed: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list() {
          return { entries: [], unreadable: [], trimmedClosed: 2 };
        },
      },
    };
    const tools = createCloneTools({
      stores: withTrimmed,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toBe('（引き受けたまま終わっていない仕事は無い）');
    expect(reply).toContain('保持上限を超えて物理削除された片付き行が累計 2 件ある');
  });

  it('0件のときは断りを足さない', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    await opened?.handler({ body: '健全な依頼' } as never, {});

    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toContain('物理削除された');
  });
});

describe('commitment_list / approvals_list に札と作成・更新を足す（#215）', () => {
  it('commitment_list の札は origin 4種を撃ち分ける', async () => {
    const h = harness();
    const origins = [
      { id: 'c-human', origin: 'human', label: '人間の依頼' },
      { id: 'c-manager', origin: 'manager', label: 'マネージャーの報告' },
      { id: 'c-external', origin: 'external', label: '外部イベント' },
      { id: 'c-self', origin: 'self', label: '自分で気づいた宿題' },
    ] as const;
    for (const [index, entry] of origins.entries()) {
      await h.stores.commitments.open({
        id: entry.id,
        at: `2026-01-0${index + 1}T00:00:00.000Z`,
        origin: entry.origin,
        body: `本文${entry.id}`,
      });
    }

    const reply = await h.call('commitment_list', {});
    const lines = reply.split('\n');

    for (const entry of origins) {
      expect(lines).toContain(`- ${entry.id} [${entry.label}]`);
    }
  });

  it('commitment_list の札は source が在れば添え、無ければ付けない', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-with-source',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-9',
      body: '報告が来た',
    });
    await h.stores.commitments.open({
      id: 'c-no-source',
      at: '2026-01-02T00:00:00.000Z',
      origin: 'manager',
      body: '出所の細目は無い',
    });

    const lines = (await h.call('commitment_list', {})).split('\n');

    expect(lines).toContain('- c-with-source [マネージャーの報告 / mgr-9]');
    expect(lines).toContain('- c-no-source [マネージャーの報告]');
  });

  it('commitment_list の作成は at・更新は closedAt ?? at（同じ行に並ぶので入れ替わりも落ちる）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-02-01T00:00:00.000Z',
      origin: 'external',
      body: '未了のまま',
    });
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-02-02T00:00:00.000Z',
      origin: 'manager',
      body: '片付いた',
    });
    await h.stores.commitments.close('c-closed', '2026-02-03T00:00:00.000Z', '対応済み', 'clone');

    const lines = (await h.call('commitment_list', { includeClosed: true })).split('\n');

    expect(lines).toContain('  作成: 2026-02-01T00:00:00.000Z / 更新: 2026-02-01T00:00:00.000Z');
    expect(lines).toContain('  作成: 2026-02-02T00:00:00.000Z / 更新: 2026-02-03T00:00:00.000Z');
  });

  it('approvals_list の札は質問の1行目だけで、2行目は混ざらない', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-multiline',
      createdAt: '2026-03-01T00:00:00.000Z',
      question: '本番へ出してよいか\n影響範囲: 全ユーザー',
    });

    const reply = await h.call('approvals_list', {});
    const titleLine = reply.split('\n').find((line) => line.startsWith('- ap-multiline'));

    expect(titleLine).toBe('- ap-multiline 本番へ出してよいか');
    expect(reply).toContain('影響範囲: 全ユーザー');
  });

  it('approvals_list の札は、質問が改行で始まっても空にならない', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-leading-newline',
      createdAt: '2026-03-02T00:00:00.000Z',
      question: '\n先頭が改行の質問',
    });

    const titleLine = (await h.call('approvals_list', {}))
      .split('\n')
      .find((line) => line.startsWith('- ap-leading-newline'));

    expect(titleLine).toBe('- ap-leading-newline 先頭が改行の質問');
  });

  it('approvals_list は作成と更新を出す（回答待ちだけの一覧なので両方が一致する）', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-04-01T00:00:00.000Z',
      question: '続けてよいか',
    });

    const reply = await h.call('approvals_list', {});

    expect(reply.split('\n')).toContain(
      '  作成: 2026-04-01T00:00:00.000Z / 更新: 2026-04-01T00:00:00.000Z',
    );
    expect(reply).toContain('更新＝この1件が最後に変わった時刻');
  });
});

describe('commitment_list id=<id> で1件の全文が取れる（#218）', () => {
  it('片付いた1件を id で読むと closedReason が全文で出る（一覧は120字で止まる）', async () => {
    const h = harness();
    const reason = `頭${'り'.repeat(300)}尻`;
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-05-01T00:00:00.000Z',
      origin: 'human',
      source: 'conv-7',
      body: '本番リリースを確認する',
    });
    await h.stores.commitments.close('c-closed', '2026-05-02T00:00:00.000Z', reason, 'clone');

    const listing = await h.call('commitment_list', { includeClosed: true });
    const detail = await h.call('commitment_list', { id: 'c-closed' });

    expect(listing).not.toContain('尻');
    expect(detail).toContain('尻');
    expect(detail).toContain(reason);
    expect(detail).toContain('2026-05-02T00:00:00.000Z');
  });

  it('未了の1件を id で読むと本文が全文で出る（一覧は240字で止まる）', async () => {
    const h = harness();
    const body = `頭${'ほ'.repeat(600)}尻`;
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-05-03T00:00:00.000Z',
      origin: 'self',
      body,
    });

    const listing = await h.call('commitment_list', {});
    const detail = await h.call('commitment_list', { id: 'c-open' });

    expect(listing).not.toContain('尻');
    expect(detail).toContain(body);
    expect(detail).toContain('状態: 未了');
  });

  it('id で名指しすれば includeClosed 無しでも片付いた件が読める', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-done',
      at: '2026-05-04T00:00:00.000Z',
      origin: 'manager',
      body: '報告を受けた件',
    });
    await h.stores.commitments.close(
      'c-done',
      '2026-05-05T00:00:00.000Z',
      '差し戻して直した',
      'clone',
    );

    expect(await h.call('commitment_list', {})).not.toContain('c-done');
    const detail = await h.call('commitment_list', { id: 'c-done' });
    expect(detail).toContain('差し戻して直した');
  });

  it('無い id は「無い」と分かる形で返る（黙って空を返さない）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-real',
      at: '2026-05-06T00:00:00.000Z',
      origin: 'self',
      body: '実在する件',
    });

    const reply = await h.call('commitment_list', { id: 'c-typo' });

    expect(reply).toContain('c-typo');
    expect(reply).toContain('無い');
    expect(reply).not.toContain('実在する件');
  });

  it('片付けた理由は、本文が1ページを超えても最初の呼びで出る', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-huge',
      at: '2026-05-07T00:00:00.000Z',
      origin: 'external',
      body: 'ぬ'.repeat(20_000),
    });
    await h.stores.commitments.close(
      'c-huge',
      '2026-05-08T00:00:00.000Z',
      '外部側で解決した',
      'clone',
    );

    const first = await h.call('commitment_list', { id: 'c-huge' });

    expect(first).toContain('外部側で解決した');
    expect(first).toContain('ここで切れている');
    expect(first).toContain('offset');
  });

  it('全文が長ければ offset で続きが取れる（切って捨てていない）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-long',
      at: '2026-05-09T00:00:00.000Z',
      origin: 'self',
      body: `頭${'ら'.repeat(20_000)}尻`,
    });

    const first = await h.call('commitment_list', { id: 'c-long' });
    const offset = Number(/offset=(\d+)/.exec(first)?.[1]);
    expect(Number.isFinite(offset)).toBe(true);

    let reply = first;
    let cursor = offset;
    for (let guard = 0; guard < 10 && !reply.includes('尻'); guard += 1) {
      reply = await h.call('commitment_list', { id: 'c-long', offset: cursor });
      cursor = Number(/offset=(\d+)/.exec(reply)?.[1] ?? cursor);
    }
    expect(reply).toContain('尻');
  });

  it('一覧が案内する導線は空振りしない（案内どおり呼ぶと全文が返る）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-guided',
      at: '2026-05-10T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: `頭${'わ'.repeat(600)}尻`,
    });

    const listing = await h.call('commitment_list', {});

    expect(listing).toContain('commitment_list id=<id>');
    const id = /^- (\S+) /m.exec(listing)?.[1];
    expect(id).toBe('c-guided');
    const detail = await h.call('commitment_list', { id: id as string });
    expect(detail).toContain('尻');
  });

  it('詳細の口ができても、一覧の既定は未了だけのまま', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-still-open',
      at: '2026-05-11T00:00:00.000Z',
      origin: 'self',
      body: '未了のまま',
    });
    await h.stores.commitments.open({
      id: 'c-already-closed',
      at: '2026-05-12T00:00:00.000Z',
      origin: 'self',
      body: '片付いた',
    });
    await h.stores.commitments.close(
      'c-already-closed',
      '2026-05-13T00:00:00.000Z',
      '済み',
      'clone',
    );

    const listing = await h.call('commitment_list', {});

    expect(listing).toContain('c-still-open');
    expect(listing).not.toContain('c-already-closed');
  });
});

describe('token_list（読むだけ。値は返らない）', () => {
  async function put(
    h: Harness,
    over: Partial<Parameters<Stores['tokens']['replace']>[0][number]> = {},
  ) {
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: '予備1',
        value: 'sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN',
        order: 0,
        ...over,
      },
    ]);
  }

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('token_list'));
  });

  it('**書き込みの道具は配られていない**（回すのは実装であってクローンではない）', () => {
    for (const name of ['token_add', 'token_remove', 'token_disable', 'token_enable']) {
      expect(CLONE_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('値を1文字も返さない（受け入れ基準5）', async () => {
    const h = harness();
    await put(h);

    const reply = await h.call('token_list', {});

    expect((await h.stores.tokens.list())[0]?.value).toBe('sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN');
    expect(reply).not.toContain('sk-ant');
    expect(reply).not.toContain('FAKE-NOT-A-REAL-TOKEN');
    expect(reply).toContain('- tok-a ');
    expect(reply).toContain('予備1');
    expect(reply).toContain('指紋 ');
  });

  it('プールが空なら「回らない」と言う（0本を静かに正常として見せない）', async () => {
    const h = harness();

    const reply = await h.call('token_list', {});

    expect(reply).toContain('プールは空である');
    expect(reply).toContain('回らない');
  });

  it('現役の指名が無いことを「1本目が現役」と書かない', async () => {
    const h = harness();
    await put(h);

    const reply = await h.call('token_list', {});

    expect(reply).toContain('まだ一度も無い');
    expect(reply).not.toContain('← 現役');
  });

  it('現役が在れば、どれが現役かと世代が出る', async () => {
    const h = harness();
    await put(h);
    await h.stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 3,
      rotatedAt: '2026-08-25T10:00:00.000Z',
    });

    const reply = await h.call('token_list', {});

    expect(reply).toContain('← 現役');
    expect(reply).toContain('世代 3');
  });

  it('冷却中・失効・人間が外した行を、使える行と同じ顔にしない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-cool',
        label: '冷却中',
        value: 'v1',
        order: 0,
        cooldownUntil: Date.now() + 3_600_000,
        lastRejectedReason: "You've hit your usage limit",
      },
      {
        id: 'tok-off',
        label: '外した',
        value: 'v2',
        order: 1,
        disabledAt: '2026-08-25T00:00:00.000Z',
      },
      { id: 'tok-ok', label: '使える', value: 'v3', order: 2 },
    ]);

    const reply = await h.call('token_list', {});

    expect(reply).toContain('- tok-cool cooling');
    expect(reply).toContain('- tok-off disabled');
    expect(reply).toContain('- tok-ok ready');
    expect(reply).toContain("You've hit your usage limit");
    expect(reply).toContain('回復の見込み（分類）');
  });

  it('止まった理由の原文が長くても、1件が一覧を食い潰さない', async () => {
    const h = harness();
    const long = 'り'.repeat(3_000);
    await h.stores.tokens.replace([
      { id: 'tok-a', label: '予備1', value: 'v1', order: 0, lastRejectedReason: long },
      { id: 'tok-b', label: '予備2', value: 'v2', order: 1 },
      { id: 'tok-c', label: '予備3', value: 'v3', order: 2 },
    ]);

    const reply = await h.call('token_list', {});

    for (const id of ['tok-a', 'tok-b', 'tok-c']) {
      expect(reply, `${id} が出ていない（1件目が一覧を食い潰した）`).toContain(`- ${id} `);
    }
    expect(reply).not.toContain(long);
    expect(reply).toMatch(/…|文字/);
  });

  it('回す契機と冷却の既定も出る（なぜ回らなかったのかを1回で読めるように）', async () => {
    const h = harness();
    await put(h);

    const reply = await h.call('token_list', {});

    expect(reply).toContain('回す契機:');
    expect(reply).toContain('冷却 ');
  });

  it('回す契機・冷却の設定が読めなくても一覧は返り、理由と直し方が1行出る（issue #2095）', async () => {
    const h = harness();
    await put(h);
    const REASON = 'rotateOn が enum の外（テスト用）';
    h.stores.tokens.readSettings = () => {
      throw new UnreadableTokenSettingsError(REASON);
    };

    const reply = await h.call('token_list', {});

    expect(reply).toContain('- tok-a ');
    expect(reply).toContain('予備1');
    expect(reply).not.toContain('回す契機:');
    expect(reply).toContain('回転の設定は読めない');
    expect(reply).toContain(REASON);
    expect(reply).toContain('回す契機と冷却の両方を指定して');
  });

  it('readSettings が UnreadableTokenSettingsError 以外を投げたら握り潰さずに上へ通す', async () => {
    const h = harness();
    await put(h);
    h.stores.tokens.readSettings = () => {
      throw new Error('DB 接続断（テスト用。設定の形とは無関係の障害）');
    };

    await expect(h.call('token_list', {})).rejects.toThrow(
      'DB 接続断（テスト用。設定の形とは無関係の障害）',
    );
  });

  it('現役の指名が読めなくても一覧は返り、理由が1行出て現役の印は付かない（issue #2125）', async () => {
    const h = harness();
    await put(h);
    const REASON = 'generation が数値でない（テスト用）';
    h.stores.tokens.readActive = () => {
      throw new UnreadableActiveTokenError(REASON);
    };

    const reply = await h.call('token_list', {});

    expect(reply).toContain('- tok-a ');
    expect(reply).toContain('予備1');
    expect(reply).not.toContain('現役の指名: **まだ一度も無い**');
    expect(reply).toContain('現役の指名は読めない');
    expect(reply).toContain(REASON);
    expect(reply).not.toContain('← 現役');
  });

  it('readActive が UnreadableActiveTokenError 以外を投げたら握り潰さずに上へ通す', async () => {
    const h = harness();
    await put(h);
    h.stores.tokens.readActive = () => {
      throw new Error('DB 接続断（テスト用。指名の形とは無関係の障害）');
    };

    await expect(h.call('token_list', {})).rejects.toThrow(
      'DB 接続断（テスト用。指名の形とは無関係の障害）',
    );
  });
});

describe('journal_read に with の絞りを足す（issue #426）', () => {
  it('with で exchange の相手を絞れる（human 以外は出ない）', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    });
    await h.stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: 'マネージャーとの往復',
    });
    await h.stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '内部ターン',
    });
    await h.stores.journal.append({ type: 'decision', decision: '無関係な判断', grounds: '記憶' });

    const reply = await h.call('journal_read', { with: ['human'] });

    expect(reply).toContain('人間からの発言');
    expect(reply).not.toContain('マネージャーとの往復');
    expect(reply).not.toContain('内部ターン');
    expect(reply).not.toContain('無関係な判断');
  });

  it('with: [] は「絞らない」ではなく0件として扱う（types: [] と同じ0件の契約に揃える）', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    });

    const reply = await h.call('journal_read', { with: [] });

    expect(reply).toBe('（その条件に当たる日誌は無い）');
  });

  it('types: [] も「絞らない」ではなく0件として扱う（with: [] と同じ渡し方であること）', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    });
    await h.stores.journal.append({ type: 'decision', decision: '無関係な判断', grounds: '記憶' });

    const reply = await h.call('journal_read', { types: [] });

    expect(reply).toBe('（その条件に当たる日誌は無い）');
  });

  it('with は limit（既定20件）より前に効く——#418 と同じ形の穴を作らない', async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `古い人間の発言${index}`,
      });
    }
    for (let index = 0; index < 25; index += 1) {
      await h.stores.journal.append({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text: `新しいマネージャーとの往復${index}`,
      });
    }

    const reply = await h.call('journal_read', { with: ['human'] });

    for (let index = 0; index < 5; index += 1) {
      expect(reply, `古い人間の発言${index} が窓の外へ落ちた`).toContain(`古い人間の発言${index}`);
    }
    expect(reply).not.toContain('マネージャーとの往復');
  });
});

describe('journal_read が日誌の地平を伝える（issue #1510）', () => {
  it('窓がまるごと地平より後ろで0件なら、地平は付けない（本当に無かったと言い切れる）', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });

    const since = new Date(Date.parse(entry.at) + 60 * 60 * 1000).toISOString();
    const reply = await h.call('journal_read', { since });

    expect(reply).toBe('（その条件に当たる日誌は無い）');
    expect(reply).not.toContain('最古');
  });

  it('since が地平より前で0件なら、地平を添える', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });

    const since = new Date(Date.parse(entry.at) - 60 * 60 * 1000).toISOString();
    const until = new Date(Date.parse(entry.at) - 1000).toISOString();
    const reply = await h.call('journal_read', { since, until });

    expect(reply).toContain('（その条件に当たる日誌は無い）');
    expect(reply).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);
    expect(reply).toContain(`指定の since（${since}）`);
    expect(reply).toContain('判定できない');
  });

  it('since が地平より前で非空でも、地平を添える（#1092 と同じ誤読を防ぐ）', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });

    const since = new Date(Date.parse(entry.at) - 60 * 60 * 1000).toISOString();
    const reply = await h.call('journal_read', { since });

    expect(reply).toContain('最古の判断');
    expect(reply).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);
    expect(reply).toContain(`指定の since（${since}）`);
    expect(reply).toContain('判定できない');
  });

  it('since は文字列ではなく時刻として比べる（秒の省略・オフセット付きでも地平より前なら添える）', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });
    const at = Date.parse(entry.at);

    const minuteStart = new Date(Math.floor(at / 60_000) * 60_000 - 60_000);
    const sinceWithoutSeconds = `${minuteStart.toISOString().slice(0, 16)}Z`;
    const reply1 = await h.call('journal_read', { since: sinceWithoutSeconds });
    expect(reply1).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);

    const beforeInJst = new Date(at - 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
    const sinceWithOffset = `${beforeInJst.toISOString().slice(0, 19)}+09:00`;
    const reply2 = await h.call('journal_read', { since: sinceWithOffset });
    expect(reply2).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);

    const afterInJst = new Date(at + 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
    const lateWithOffset = `${afterInJst.toISOString().slice(0, 19)}+09:00`;
    const reply3 = await h.call('journal_read', { since: lateWithOffset });
    expect(reply3).not.toContain('最古');
  });

  it('until だけの指定は、窓の始点が -∞ なので常に地平を添える', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });

    const reply = await h.call('journal_read', {
      until: new Date(Date.parse(entry.at) + 60 * 60 * 1000).toISOString(),
    });

    expect(reply).toContain('最古の判断');
    expect(reply).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);
    expect(reply).toContain('それより前は');
    expect(reply).toContain('判定できない');
  });

  it('日誌そのものが空なら、時間で絞っても地平は付けない（比べる地平が無い）', async () => {
    const h = harness();

    const reply = await h.call('journal_read', { until: '2020-01-01T00:00:00.000Z' });

    expect(reply).toBe('（その条件に当たる日誌は無い）');
    expect(reply).not.toContain('最古');
  });

  it('時間で絞っていない0件には地平を付けない（呼ばない——oldestAt を引かない）', async () => {
    const h = harness();
    await h.stores.journal.append({ type: 'decision', decision: '無関係な判断', grounds: '記憶' });
    const oldestAtSpy = vi.spyOn(h.stores.journal, 'oldestAt');

    const reply = await h.call('journal_read', { types: ['tool_use'] });

    expect(reply).toBe('（その条件に当たる日誌は無い）');
    expect(reply).not.toContain('最古');
    expect(oldestAtSpy).not.toHaveBeenCalled();
  });

  it('q と併せて0件のときも、窓が地平にかかっていれば地平を添える', async () => {
    const h = harness();
    const entry = await h.stores.journal.append({
      type: 'decision',
      decision: '最古の判断',
      grounds: '記憶',
    });

    const reply = await h.call('journal_read', {
      q: '当たらない語',
      until: new Date(Date.parse(entry.at) - 1000).toISOString(),
    });

    expect(reply).toContain('当たらない語');
    expect(reply).toContain(`この記憶ストアの日誌の最古は ${entry.at}`);
  });
});

describe('journal_read で subagent_stall を絞れる（Issue #357）', () => {
  it('types: ["subagent_stall"] で当たり、見出しに outcome と各カウントが載る', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'subagent_stall',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: '[mgr-1] 起こし直した（1回目 / 上限 2）。',
    });
    await h.stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: '[mgr-1] 無関係な note。',
    });

    const reply = await h.call('journal_read', { types: ['subagent_stall'] });

    expect(reply).toContain('subagent_stall');
    expect(reply).toContain('woken');
    expect(reply).toContain('agent=agent-1');
    expect(reply).toContain('owned=1');
    expect(reply).toContain('session=2');
    expect(reply).toContain('wakeup=1');
    expect(reply).toContain('起こし直した（1回目 / 上限 2）');
    expect(reply).not.toContain('無関係な note');
  });

  it('types: ["exchange"] では subagent_stall は当たらない（雑多入れへ埋もれない）', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'subagent_stall',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 1,
      outcome: 'woken',
      text: '[mgr-1] 起こし直した（1回目 / 上限 2）。',
    });
    await h.stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: '[mgr-1] 別件の note。',
    });

    const reply = await h.call('journal_read', { types: ['exchange'] });

    expect(reply).toContain('別件の note');
    expect(reply).not.toContain('起こし直した（1回目 / 上限 2）');
  });

  it('agentType が無いとき（取れなかった回）は見出しに /agentType を作らない', async () => {
    const h = harness();
    await h.stores.journal.append({
      type: 'subagent_stall',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 1,
      outcome: 'limit_reached',
      text: '[mgr-1] 起こし直さなかった。',
    });

    const reply = await h.call('journal_read', { types: ['subagent_stall'] });

    expect(reply).toContain('agent=agent-1 owned=1');
    expect(reply).not.toContain('agent=agent-1/');
  });
});

describe('journal_read の tool_use 断り書き（M > 0 かつ tool_use だけを名指しした呼びではないとき）', () => {
  async function appendToolUse(h: ReturnType<typeof harness>, count: number) {
    for (let index = 0; index < count; index += 1) {
      await h.stores.journal.append({
        type: 'tool_use',
        actor: 'clone',
        tool: `Tool${index}`,
        input: { index },
      });
    }
  }

  async function appendDecisions(h: ReturnType<typeof harness>, count: number) {
    for (let index = 0; index < count; index += 1) {
      await h.stores.journal.append({
        type: 'decision',
        decision: `判断${index}`,
        grounds: '記憶',
      });
    }
  }

  it('types 省略で tool_use が混ざる呼び（5件中2件）→ 出る。件数が実数と一致する', async () => {
    const h = harness();
    await appendDecisions(h, 3);
    await appendToolUse(h, 2);

    const reply = await h.call('journal_read', {});

    expect(reply).toContain(
      '（tool_use が今回の 5 件中 2 件。判断の記録だけを見るなら types で外せる）',
    );
  });

  it('types 省略で tool_use が混ざる呼び（3件中1件）→ 出る。件数が実数と一致する', async () => {
    const h = harness();
    await appendDecisions(h, 2);
    await appendToolUse(h, 1);

    const reply = await h.call('journal_read', {});

    expect(reply).toContain(
      '（tool_use が今回の 3 件中 1 件。判断の記録だけを見るなら types で外せる）',
    );
  });

  it('tool_use が0件の呼び → 断り書きが出ない', async () => {
    const h = harness();
    await appendDecisions(h, 3);

    const reply = await h.call('journal_read', {});

    expect(reply).not.toContain('判断の記録だけを見るなら types で外せる');
  });

  it('types が tool_use だけの呼び → M > 0 でも出ない', async () => {
    const h = harness();
    await appendDecisions(h, 2);
    await appendToolUse(h, 3);

    const reply = await h.call('journal_read', { types: ['tool_use'] });

    expect(reply).not.toContain('判断の記録だけを見るなら types で外せる');

    const repeated = await h.call('journal_read', { types: ['tool_use', 'tool_use'] });

    expect(repeated).not.toContain('判断の記録だけを見るなら types で外せる');
  });

  it('types に tool_use と他の種別が入る呼び → 出る', async () => {
    const h = harness();
    await appendDecisions(h, 2);
    await appendToolUse(h, 2);

    const reply = await h.call('journal_read', { types: ['tool_use', 'decision'] });

    expect(reply).toContain(
      '（tool_use が今回の 4 件中 2 件。判断の記録だけを見るなら types で外せる）',
    );
  });

  it('types 省略で、取れた件が全部 tool_use（M === N）→ 出る（呼びで判定していることの歯。M === N で黙る実装ならここが赤くなる）', async () => {
    const h = harness();
    await appendToolUse(h, 3);

    const reply = await h.call('journal_read', {});

    expect(reply).toContain(
      '（tool_use が今回の 3 件中 3 件。判断の記録だけを見るなら types で外せる）',
    );
  });

  it('id 指定の全文モードでは出ない', async () => {
    const h = harness();
    await appendToolUse(h, 2);
    const [entry] = await h.stores.journal.list({ types: ['tool_use'] });
    if (entry === undefined) throw new Error('tool_use が日誌へ記録されていない');

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).not.toContain('判断の記録だけを見るなら types で外せる');
  });
});

describe('commitment_list に origin の絞りを足す（issue #426）', () => {
  it('origin で出所を絞れる（manager 以外は出ない）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-human',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'human',
      body: '人間からの依頼',
    });
    await h.stores.commitments.open({
      id: 'c-manager',
      at: '2026-01-01T00:00:01.000Z',
      origin: 'manager',
      body: 'マネージャーからの一件',
    });
    await h.stores.commitments.open({
      id: 'c-external',
      at: '2026-01-01T00:00:02.000Z',
      origin: 'external',
      body: '外部からのイベント',
    });
    await h.stores.commitments.open({
      id: 'c-self',
      at: '2026-01-01T00:00:03.000Z',
      origin: 'self',
      body: '自分で気づいた宿題',
    });

    const reply = await h.call('commitment_list', { origin: ['manager'] });

    expect(reply).toContain('c-manager');
    expect(reply).not.toContain('c-human');
    expect(reply).not.toContain('c-external');
    expect(reply).not.toContain('c-self');
  });

  it('origin: [] は「絞らない」ではなく0件として扱う（journal_read の with と同じ契約）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '何か',
    });

    const reply = await h.call('commitment_list', { origin: [] });

    expect(reply).not.toBe('（引き受けたまま終わっていない仕事は無い）');
    expect(reply).toContain('絞り込みに当たる行は無い');
  });

  it('台帳自体に読める行が無いときは「読める行は無い」のまま——origin の絞りのせいだと誤読させない', async () => {
    const stores = createMemoryStores();
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list() {
          return {
            entries: [],
            unreadable: [
              { id: 'c-broken', at: '2026-08-01T00:00:00.000Z', reason: '型が合わない' },
            ],
            trimmedClosed: 0,
          };
        },
      },
    };
    const tools = createCloneTools({
      stores: withUnreadable,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({ origin: ['manager'] } as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).toContain('読めない行が 1 件ある');
    expect(reply).not.toContain('絞り込みに当たる行は無い');
  });

  it('origin の絞りは文字数の予算（COMMITMENT_LIST_BUDGET）より前に効く——#418 と同じ形の穴を作らない', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `manager-${index}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'manager',
        source: 'mgr-1',
        body: `マネージャーからの一件${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await h.stores.commitments.open({
        id: `human-${index}`,
        at: `2026-01-02T00:00:0${index}.000Z`,
        origin: 'human',
        body: `人間からの依頼${index}: ${long}`,
      });
    }

    const reply = await h.call('commitment_list', { origin: ['human'] });

    for (let index = 0; index < 3; index += 1) {
      expect(reply, `human-${index} が窓の外へ落ちた`).toContain(`human-${index}`);
    }
    expect(reply).not.toContain('manager-');
    expect(reply).not.toMatch(/…ほか \d+ 件は省略/);
  });

  it('origin を指定した省略の断り書きは、絞った後の件数だと分かる形で言う（数え違いを「絞る前の全体」と誤読させない）', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    const managerCount = 25;
    const selfCount = 25;
    for (let index = 0; index < managerCount; index += 1) {
      await h.stores.commitments.open({
        id: `manager-${index}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'manager',
        body: `マネージャーからの一件${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < selfCount; index += 1) {
      await h.stores.commitments.open({
        id: `self-${index}`,
        at: `2026-01-01T01:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `自分の宿題${String(index).padStart(3, '0')}: ${long}`,
      });
    }

    const reply = await h.call('commitment_list', { origin: ['manager'] });

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain(`origin: manager に絞った、未了は ${managerCount} 件あり`);
    expect(reply).not.toContain(`${managerCount + selfCount} 件あり`);
    expect(reply).not.toContain('self-');
  });
});

describe('commitment_list の一覧モードに継続点（cursor）を足す', () => {
  function extractCursor(reply: string): string {
    const match = /cursor=([A-Za-z0-9\-_]+)/.exec(reply);
    if (!match) throw new Error(`cursor が案内に無い: ${reply}`);
    return match[1]!;
  }

  it('T1: 予算内なら cursor の案内は出ない（回帰）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '短い宿題',
    });

    const reply = await h.call('commitment_list', {});

    expect(reply).not.toMatch(/…ほか \d+ 件は省略/);
    expect(reply).not.toContain('cursor=');
  });

  it('T2: 予算で切れたら次に打つ cursor がそのまま案内される', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `c-${String(index).padStart(3, '0')}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `約束${String(index).padStart(3, '0')}: ${long}`,
      });
    }

    const reply = await h.call('commitment_list', {});

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('cursor=');
    expect(reply).toContain('省いたのは、これより新しい依頼である。');
    expect(reply).toMatch(/続きは commitment_list cursor=[A-Za-z0-9\-_]+ で取れる/);
  });

  it('T3（事故の再現）: 25件の未了行の後に届いた新しい依頼が、cursor で読める', async () => {
    // 本文に連番を入れる: 同一マネージャー×同一本文×未了は1行に畳まれ（`findOpenManagerDuplicate`）、同文だと cursor の頁送りを踏まなくなるため
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `mgr-report-${String(index).padStart(3, '0')}`,
        at: `2026-09-04T22:33:${String(index).padStart(2, '0')}.000Z`,
        origin: 'manager',
        source: 'mgr-1',
        body: `Poller draining. No change. #${index} ${long}`,
      });
    }
    await h.stores.commitments.open({
      id: 'human-request',
      at: '2026-09-04T22:40:00.000Z',
      origin: 'human',
      body: 'オーナーからの新しい依頼——これが埋もれてはいけない',
    });

    const first = await h.call('commitment_list', {});
    expect(first).toMatch(/…ほか \d+ 件は省略/);
    expect(first).not.toContain('human-request');

    const cursor = extractCursor(first);
    const second = await h.call('commitment_list', { cursor });

    expect(second).toContain('human-request');
    expect(second).toContain('オーナーからの新しい依頼——これが埋もれてはいけない');
  });

  it('T4: 壊れた cursor は明示のエラーで、黙って先頭からへ倒さない', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '何か',
    });

    const reply = await h.call('commitment_list', { cursor: 'this-is-not-a-real-cursor' });

    expect(reply).toContain('cursor が壊れている');
    expect(reply).not.toContain('c-1');
  });

  it('T5: includeClosed が食い違う cursor は明示のエラー', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '未了',
    });
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-01-02T00:00:00.000Z',
      origin: 'self',
      body: '片付いた',
    });
    await h.stores.commitments.close('c-closed', '2026-01-03T00:00:00.000Z', '済み', 'clone');

    const { encodeCommitmentCursor } = await import('./commitment-cursor.js');
    const cursor = encodeCommitmentCursor({
      segment: 'open',
      key: '2026-01-01T00:00:00.000Z',
      id: 'c-open',
      includeClosed: true,
      order: 'oldest',
    });

    const reply = await h.call('commitment_list', { cursor });

    expect(reply).toContain('cursor は includeClosed=true');
    expect(reply).toContain('食い違う');
  });

  it('T6: 最後の頁は「もう続きは無い」であって「絞り込みに0件」ではない', async () => {
    const h = harness();
    const { encodeCommitmentCursor, commitmentPosition } = await import('./commitment-cursor.js');
    const only = {
      id: 'c-only',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self' as const,
      body: '唯一の未了',
    };
    await h.stores.commitments.open(only);
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(only),
      includeClosed: false,
      order: 'oldest',
    });

    const reply = await h.call('commitment_list', { cursor });

    expect(reply).toContain('cursor より後ろの行は無い。これが最後の頁');
    expect(reply).not.toContain('絞り込みに当たる行は無い');
    expect(reply).not.toContain('読める行は無い');
  });

  it('T7: id が在るとき cursor は無視される（他の条件と同じ規約）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-detail',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '全文を読みたい依頼',
    });

    const reply = await h.call('commitment_list', {
      id: 'c-detail',
      cursor: 'garbage-cursor-value',
    });

    expect(reply).toContain('全文を読みたい依頼');
    expect(reply).not.toContain('cursor が壊れている');
  });

  it('T8: origin と cursor を併用しても絞った後の並びで正しく続く', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `manager-${String(index).padStart(3, '0')}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'manager',
        source: 'mgr-1',
        body: `マネージャーからの一件${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < 5; index += 1) {
      await h.stores.commitments.open({
        id: `human-${index}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.500Z`,
        origin: 'human',
        body: `人間からの依頼${index}: ${long}`,
      });
    }

    const first = await h.call('commitment_list', { origin: ['human'] });
    expect(first).not.toContain('manager-');
    expect(first).not.toMatch(/…ほか \d+ 件は省略/);
    for (let index = 0; index < 5; index += 1) {
      expect(first, `human-${index} が origin 絞りの一覧から落ちた`).toContain(`human-${index}`);
    }
  });

  it('T9: includeClosed の cursor は open→closed の段を跨いでも正しく続く', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    await h.stores.commitments.open({
      id: 'c-open-only',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '唯一の未了',
    });
    for (let index = 0; index < 25; index += 1) {
      const id = `c-closed-${String(index).padStart(3, '0')}`;
      await h.stores.commitments.open({
        id,
        at: `2025-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `片付いた${String(index).padStart(3, '0')}: ${long}`,
      });
      await h.stores.commitments.close(
        id,
        `2026-02-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        '対応済み',
        'clone',
      );
    }

    const first = await h.call('commitment_list', { includeClosed: true });
    expect(first).toContain('c-open-only');
    expect(first).toMatch(/…ほか \d+ 件は省略/);
    expect(first).toContain(
      '省いたのは、未了ならこれより新しい依頼、片付いた分ならこれより古い記録である。',
    );

    const cursor = extractCursor(first);
    const second = await h.call('commitment_list', { includeClosed: true, cursor });

    expect(second).not.toContain('c-open-only');
    expect(second).toContain('c-closed-000');
  });

  it('T10: origin が食い違う cursor は明示のエラー（origin-mismatch。issue #1390）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'human',
      body: '見えてはいけない本文',
    });
    const { encodeCommitmentCursor, commitmentPosition } = await import('./commitment-cursor.js');
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
      includeClosed: false,
      order: 'oldest',
      origin: ['manager'],
    });

    const reply = await h.call('commitment_list', { origin: ['human'], cursor });

    expect(reply).toContain('cursor は origin=manager');
    expect(reply).toContain('食い違う');
    expect(reply).not.toContain('見えてはいけない本文');
  });

  it('T11: q が食い違う cursor は明示のエラー（q-mismatch。issue #1390）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: 'UNIQUEWORD を含む宿題',
    });
    const { encodeCommitmentCursor, commitmentPosition } = await import('./commitment-cursor.js');
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
      includeClosed: false,
      order: 'oldest',
      q: 'foo',
    });

    const reply = await h.call('commitment_list', { q: 'bar', cursor });

    expect(reply).toContain('cursor は q="foo"');
    expect(reply).toContain('食い違う');
    expect(reply).not.toContain('UNIQUEWORD');
  });

  it(
    'T12: origin/q が正規化して同値なら cursor はそのまま続く' +
      '（順序違い・大文字小文字違いは同じ絞りとして扱う）',
    async () => {
      const h = harness();
      const long = 'あ'.repeat(500);
      for (let index = 0; index < 25; index += 1) {
        const originValue = index % 2 === 0 ? ('human' as const) : ('manager' as const);
        await h.stores.commitments.open({
          id: `c-${String(index).padStart(3, '0')}`,
          at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
          origin: originValue,
          ...(originValue === 'manager' ? { source: 'mgr-1' } : {}),
          body: `NEEDLE${String(index).padStart(3, '0')}: ${long}`,
        });
      }

      const first = await h.call('commitment_list', {
        origin: ['human', 'manager'],
        q: 'NEEDLE',
      });
      expect(first).toMatch(/…ほか \d+ 件は省略/);
      const cursor = extractCursor(first);

      const second = await h.call('commitment_list', {
        origin: ['manager', 'human'],
        q: 'needle',
        cursor,
      });

      expect(second).not.toContain('cursor は');
      expect(second).not.toContain('食い違う');
    },
  );

  it(
    'T13: origin/q の欄を持たない（この変更より前に発行された）cursor は malformed にならず、' +
      '絞っていない呼びでは続きが読める',
    async () => {
      const h = harness();
      await h.stores.commitments.open({
        id: 'c-1',
        at: '2026-01-01T00:00:00.000Z',
        origin: 'self',
        body: '古い方',
      });
      await h.stores.commitments.open({
        id: 'c-2',
        at: '2026-01-02T00:00:00.000Z',
        origin: 'self',
        body: '新しい方',
      });
      const { commitmentPosition } = await import('./commitment-cursor.js');
      const legacyCursor = Buffer.from(
        JSON.stringify({
          ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
          includeClosed: false,
          order: 'oldest',
        }),
        'utf8',
      ).toString('base64url');

      const reply = await h.call('commitment_list', { cursor: legacyCursor });

      expect(reply).not.toContain('cursor が壊れている');
      expect(reply).not.toContain('食い違う');
      expect(reply).toContain('c-2');
      expect(reply).not.toContain('c-1 ');
    },
  );

  it(
    'T14（安全側の確認。issue #1390）: origin/q の欄を持たない古い cursor を、' +
      '絞った呼び（origin 指定）へ渡すと、黙って続けず origin-mismatch で断る',
    async () => {
      const h = harness();
      await h.stores.commitments.open({
        id: 'c-1',
        at: '2026-01-01T00:00:00.000Z',
        origin: 'human',
        body: '古い方',
      });
      await h.stores.commitments.open({
        id: 'c-2',
        at: '2026-01-02T00:00:00.000Z',
        origin: 'human',
        body: '新しい方',
      });
      const { commitmentPosition } = await import('./commitment-cursor.js');
      const legacyCursor = Buffer.from(
        JSON.stringify({
          ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
          includeClosed: false,
          order: 'oldest',
        }),
        'utf8',
      ).toString('base64url');

      const reply = await h.call('commitment_list', { origin: ['human'], cursor: legacyCursor });

      expect(reply).toContain('cursor は origin=');
      expect(reply).toContain('食い違う');
    },
  );
});

describe('commitment_list に q（語で探す）を足す', () => {
  it('q は body に当たる（大文字小文字を区別しない部分一致）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-target',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: 'UNIQUEWORD を含む宿題',
    });
    await h.stores.commitments.open({
      id: 'c-other',
      at: '2026-01-01T00:00:01.000Z',
      origin: 'self',
      body: '関係ない宿題',
    });

    const reply = await h.call('commitment_list', { q: 'uniqueword' });

    expect(reply).toContain('c-target');
    expect(reply).not.toContain('c-other');
  });

  it(
    'q は source に当たる（origin: manager の行は managerId が source に入り、' +
      'body には入らないため——body だけでは探せない）',
    async () => {
      const h = harness();
      await h.stores.commitments.open({
        id: 'c-from-target-manager',
        at: '2026-01-01T00:00:00.000Z',
        origin: 'manager',
        source: 'mgr-special-99',
        body: '[report] 作業完了',
      });
      await h.stores.commitments.open({
        id: 'c-from-other-manager',
        at: '2026-01-01T00:00:01.000Z',
        origin: 'manager',
        source: 'mgr-other-1',
        body: '[report] 別の作業完了',
      });

      const reply = await h.call('commitment_list', { q: 'mgr-special-99' });

      expect(reply).toContain('c-from-target-manager');
      expect(reply).not.toContain('c-from-other-manager');
    },
  );

  it('q と origin を併用できる', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-match-both',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: 'MATCHME を含む報告',
    });
    await h.stores.commitments.open({
      id: 'c-match-q-only',
      at: '2026-01-01T00:00:01.000Z',
      origin: 'self',
      body: 'MATCHME を含む宿題（origin が違う）',
    });
    await h.stores.commitments.open({
      id: 'c-match-origin-only',
      at: '2026-01-01T00:00:02.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: '関係ない報告（q には当たらない）',
    });

    const reply = await h.call('commitment_list', { q: 'MATCHME', origin: ['manager'] });

    expect(reply).toContain('c-match-both');
    expect(reply).not.toContain('c-match-q-only');
    expect(reply).not.toContain('c-match-origin-only');
  });

  it('q の絞りは文字数の予算（COMMITMENT_LIST_BUDGET）より前に効く——#418 と同じ形の穴を作らない', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `noise-${String(index).padStart(3, '0')}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `関係ない宿題${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await h.stores.commitments.open({
        id: `hit-${index}`,
        at: `2026-01-02T00:00:0${index}.000Z`,
        origin: 'self',
        body: `NEEDLE を含む宿題${index}: ${long}`,
      });
    }

    const reply = await h.call('commitment_list', { q: 'NEEDLE' });

    for (let index = 0; index < 3; index += 1) {
      expect(reply, `hit-${index} が窓の外へ落ちた`).toContain(`hit-${index}`);
    }
    expect(reply).not.toContain('noise-');
    expect(reply).not.toMatch(/…ほか \d+ 件は省略/);
  });

  it('q は id を指定した全文モードでは無視される（id の doc のとおり）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-detail',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: 'この1件の全文',
    });

    const reply = await h.call('commitment_list', {
      id: 'c-detail',
      q: 'この語には絶対に当たらないはずの文字列xyz',
    });

    expect(reply).toContain('この1件の全文');
  });
});

describe('commitment_list に order（並び順）を足す', () => {
  it(
    'order: newest は実際に新しい側から出る' +
      '（並びそのものを測る——件数が同じだけでは既定でも通ってしまうので、出現位置を見る）',
    async () => {
      const h = harness();
      await h.stores.commitments.open({
        id: 'c-oldest',
        at: '2026-01-01T00:00:00.000Z',
        origin: 'self',
        body: '最も古い宿題',
      });
      await h.stores.commitments.open({
        id: 'c-middle',
        at: '2026-01-02T00:00:00.000Z',
        origin: 'self',
        body: '中間の宿題',
      });
      await h.stores.commitments.open({
        id: 'c-newest',
        at: '2026-01-03T00:00:00.000Z',
        origin: 'self',
        body: '最も新しい宿題',
      });

      const oldestReply = await h.call('commitment_list', {});
      expect(oldestReply.indexOf('c-oldest')).toBeGreaterThanOrEqual(0);
      expect(oldestReply.indexOf('c-newest')).toBeGreaterThan(oldestReply.indexOf('c-oldest'));

      const newestReply = await h.call('commitment_list', { order: 'newest' });
      expect(newestReply).toContain('c-oldest');
      expect(newestReply).toContain('c-middle');
      expect(newestReply).toContain('c-newest');
      expect(newestReply.indexOf('c-newest')).toBeGreaterThanOrEqual(0);
      expect(newestReply.indexOf('c-oldest')).toBeGreaterThan(newestReply.indexOf('c-newest'));
    },
  );

  it('order: newest は予算で切る前に効く——台帳が膨らんでも直近の行へ届く（今回直した事故そのもの）', async () => {
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.stores.commitments.open({
        id: `old-${String(index).padStart(3, '0')}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `古い宿題${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    await h.stores.commitments.open({
      id: 'c-made-tonight',
      at: '2026-01-02T00:00:00.000Z',
      origin: 'self',
      body: '今夜作られた行',
    });

    const oldestReply = await h.call('commitment_list', {});
    expect(oldestReply).not.toContain('c-made-tonight');

    const newestReply = await h.call('commitment_list', { order: 'newest' });
    expect(newestReply).toContain('c-made-tonight');
  });

  it('order を跨いだ cursor の食い違いは明示のエラーになる（includeClosed と同じ形）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'self',
      body: '何か',
    });
    const { encodeCommitmentCursor, commitmentPosition } = await import('./commitment-cursor.js');
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
      includeClosed: false,
      order: 'newest',
    });

    const reply = await h.call('commitment_list', { cursor });

    expect(reply).toContain('cursor は order=newest');
    expect(reply).toContain('食い違う');
    expect(reply).not.toContain('c-1 ');
  });

  it(
    'order の欄を持たない（order を足す前に発行された）cursor は malformed にならず、' +
      '既定（oldest）として続きが読める',
    async () => {
      const h = harness();
      await h.stores.commitments.open({
        id: 'c-1',
        at: '2026-01-01T00:00:00.000Z',
        origin: 'self',
        body: '古い方',
      });
      await h.stores.commitments.open({
        id: 'c-2',
        at: '2026-01-02T00:00:00.000Z',
        origin: 'self',
        body: '新しい方',
      });
      const { commitmentPosition } = await import('./commitment-cursor.js');
      const legacyCursor = Buffer.from(
        JSON.stringify({
          ...commitmentPosition({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
          includeClosed: false,
        }),
        'utf8',
      ).toString('base64url');

      const reply = await h.call('commitment_list', { cursor: legacyCursor });

      expect(reply).not.toContain('cursor が壊れている');
      expect(reply).not.toContain('食い違う');
      expect(reply).toContain('c-2');
      expect(reply).not.toContain('c-1 ');
    },
  );
});

describe('journal.append が失敗したとき（跡が消えない・isError を殺さない）', () => {
  async function callExpectingError(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  }

  function firstSectionId(outline: string): string {
    const match = /^\s*\[([0-9a-f]{8}-[0-9a-f]{8})\]/m.exec(outline);
    if (match === null) throw new Error(`節idが目次に無い:\n${outline}`);
    return match[1] as string;
  }

  it('正常系: 日誌に残るエントリの種類と件数を全数で固定する（記録が減っていないことの歯）', async () => {
    const h = harness();

    // 削除対象は直接ストアへ仕込む: `memory_write` 経由だと、その道具自身の memory_update が1件混ざるため
    await h.stores.persona.write('doc-to-delete', '消される文書\n');
    await delBased(h, { slug: 'doc-to-delete', summary: '削除' });

    await h.call('ask_human', { question: '質問' });

    await h.call('profile_write', { script: 'export A=1', summary: 'プロファイル更新' });

    await h.call('manager_start', { request: '調査' });

    await h.call('journal_write', { decision: '判断した', grounds: '根拠' });

    await h.call('daily_report_write', { body: '今日の報告' });

    await h.stores.persona.write('from-doc', '# 表紙\n\n芯\n\n## 節A\n\n本文\n');
    const outline = await h.call('memory_outline', { slug: 'from-doc' });
    await h.call('memory_section_move', {
      fromSlug: 'from-doc',
      sections: [firstSectionId(outline)],
      toSlug: 'to-doc',
      summary: '移動',
    });

    const all = await h.stores.journal.list({});
    const byType = new Map<string, number>();
    for (const entry of all) byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);

    expect(all.length).toBe(10);
    expect(byType.get('memory_update')).toBe(3);
    expect(byType.get('escalation')).toBe(1);
    expect(byType.get('decision')).toBe(5);
    expect(byType.get('daily_report')).toBe(1);

    const memoryUpdateActions = all
      .filter((entry) => entry.type === 'memory_update')
      .map((entry) => (entry as { action?: string }).action)
      .sort();
    expect(memoryUpdateActions).toEqual(['move_in', 'move_out', 'remove']);
  });

  describe('journal.append が例外を投げたとき（failingJournalAppend）', () => {
    it('act-completed（memory_delete）: 副作用は完了している。跡が残り、isError のまま「やり直し禁止」が返る', async () => {
      clearRecentTracesForTesting();
      const stores = failingJournalAppend(createMemoryStores(), 'boom-act-completed');
      await stores.persona.write('temp-note', '消される文書\n');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError, text } = await callExpectingError(tools, 'memory_delete', {
        slug: 'temp-note',
        summary: '整理',
        base_version: memoryVersion((await stores.persona.read('temp-note'))!.content),
      });

      expect(await stores.persona.read('temp-note')).toBeNull();
      expect(await stores.journal.list({})).toHaveLength(0);
      const traces = recentDroppedTraces();
      expect(traces.length).toBeGreaterThan(0);
      expect(traces.some((line) => line.includes('日誌を記録できませんでした'))).toBe(true);
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(text).toContain('やり直さないこと');
      expect(text).toContain('記録できなかったエントリ:');
      expect(text).toContain('memory_update');
      expect(text).toContain('boom-act-completed');
      expect(text).toContain('memory_delete');
    });

    it('act-not-performed（journal_write）: 日誌への記録そのものが行為。副作用は無く「やり直してよい」と返る', async () => {
      clearRecentTracesForTesting();
      const stores = failingJournalAppend(createMemoryStores(), 'boom-act-not-performed');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError, text } = await callExpectingError(tools, 'journal_write', {
        decision: '判断した',
        grounds: '根拠',
      });

      expect(await stores.journal.list({})).toHaveLength(0);
      const traces = recentDroppedTraces();
      expect(traces.length).toBeGreaterThan(0);
      expect(traces.some((line) => line.includes('日誌を記録できませんでした'))).toBe(true);
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe('⚠⚠ 未記録・行為は起きていない・やり直してよい');
      expect(text).toContain('やり直してよい');
      expect(text).toContain('記録できなかったエントリ:');
      expect(text).toContain('decision');
      expect(text).toContain('boom-act-not-performed');
      expect(text).toContain('journal_write');
    });

    it('act-not-performed（daily_report_write）: こちらも記録そのものが行為で、副作用は無い', async () => {
      clearRecentTracesForTesting();
      const stores = failingJournalAppend(createMemoryStores(), 'boom-daily-report');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const { isError, text } = await callExpectingError(tools, 'daily_report_write', {
        body: '今日の報告',
      });

      expect(await stores.journal.list({})).toHaveLength(0);
      expect(recentDroppedTraces().length).toBeGreaterThan(0);
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe('⚠⚠ 未記録・行為は起きていない・やり直してよい');
      expect(text).toContain('記録できなかったエントリ:');
      expect(text).toContain('daily_report');
      expect(text).toContain('boom-daily-report');
      expect(text).toContain('daily_report_write');
    });

    it('act-partially-completed（memory_section_move の move_in）: 移し先への追記だけが済んだ半完了として断られる', async () => {
      clearRecentTracesForTesting();
      const stores = failingJournalAppend(createMemoryStores(), 'boom-partial');
      await stores.persona.write('from-doc', '# 表紙\n\n芯\n\n## 節A\n\n本文\n');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const outlineResult = await callExpectingError(tools, 'memory_outline', {
        slug: 'from-doc',
      });
      expect(outlineResult.isError).toBe(false);
      const sectionId = firstSectionId(outlineResult.text);

      const { isError, text } = await callExpectingError(tools, 'memory_section_move', {
        fromSlug: 'from-doc',
        sections: [sectionId],
        toSlug: 'to-doc',
        summary: '移動',
      });

      expect((await stores.persona.read('to-doc'))?.content).toContain('節A');
      expect((await stores.persona.read('from-doc'))?.content).toContain('## 節A');
      expect(await stores.journal.list({})).toHaveLength(0);

      const traces = recentDroppedTraces();
      expect(traces.length).toBeGreaterThan(0);
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe('⚠⚠ 一部完了・未記録・やり直し禁止');
      expect(text).toContain('重複しているが、失われてはいない');
      expect(text).toContain('やり直さないこと');
      expect(text).toContain('記録できなかったエントリ:');
      expect(text).toContain('boom-partial');
      expect(text).toContain('memory_section_move');
    });

    it('act-completed（ask_human）: 承認は実在し（approvals_list から読める）、跡も残る。isError のまま「やり直し禁止」が返る', async () => {
      clearRecentTracesForTesting();
      const stores = failingJournalAppend(createMemoryStores(), 'boom-ask-human');
      const tools = createCloneTools({
        stores,
        emit: () => {},
        memoryCause: () => 'clone',
        conversationId: () => undefined,
      });

      const QUESTION = '歯4用の確認: 本当に実行してよいか（ask_human の journal 失敗時）';
      const { isError, text } = await callExpectingError(tools, 'ask_human', {
        question: QUESTION,
      });

      const listing = await callExpectingError(tools, 'approvals_list', {});
      expect(listing.isError).toBe(false);
      expect(listing.text).toContain(QUESTION);

      expect(await stores.journal.list({})).toHaveLength(0);
      const traces = recentDroppedTraces();
      expect(traces.length).toBeGreaterThan(0);
      expect(traces.some((line) => line.includes('日誌を記録できませんでした'))).toBe(true);
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(text).toContain('やり直さないこと');
      expect(text).toContain('記録できなかったエントリ:');
      expect(text).toContain('escalation');
      expect(text).toContain('boom-ask-human');
      expect(text).toContain('ask_human');
    });
  });

  it('🔴 秘密: profile_write の journal.append が失敗しても、応答にも stderr 側にもプロファイル本文が出ない', async () => {
    const CANARY = 'FAKE-SECRET-CANARY-Q7mZbN3';
    clearRecentTracesForTesting();
    const stores = failingJournalAppend(createMemoryStores(), 'boom-secret');
    const runners = {
      async list() {
        return [
          {
            runnerId: 'runner-test',
            async setProfile() {
              return { ok: true as const };
            },
          },
        ];
      },
      async get() {
        return null;
      },
      async select() {
        throw new Error('この検証では使わない');
      },
    } as never;
    const tools = createCloneTools({
      stores,
      emit: () => {},
      profile: createProfileService({ stores, runners }),
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

    let result: { isError: boolean; text: string } | undefined;
    const stderrLines = await captureStderr(async () => {
      result = await callExpectingError(tools, 'profile_write', {
        script: `export SECRET=${CANARY}`,
        summary: 'テスト用の秘密',
      });
    });

    if (result === undefined) throw new Error('呼び出しが完了していない');
    expect(result.isError).toBe(true);
    expect(result.text.split('\n')[0]).toBe('⚠⚠ 未記録・行為は起きていない・やり直してよい');
    expect(await stores.profile.list()).toEqual([]);
    expect(result.text).toContain('profile_write');
    expect(result.text).not.toContain(CANARY);

    expect(stderrLines.join('\n')).not.toContain(CANARY);
    const traces = recentDroppedTraces();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.join('\n')).not.toContain(CANARY);
  });
});

describe('#1230 memory_section_move: 半完了 → やり直し → 状態（通しの歯）', () => {
  async function callExpectingError(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  }

  function firstSectionId(outline: string): string {
    const match = /^\s*\[([0-9a-f]{8}-[0-9a-f]{8})\]/m.exec(outline);
    if (match === null) throw new Error(`節idが目次に無い:\n${outline}`);
    return match[1] as string;
  }

  function sectionIdFor(outline: string, heading: string): string {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`\\[([0-9a-f]{8}-[0-9a-f]{8})\\] ${escaped} — `).exec(outline);
    if (match === null) throw new Error(`見出し「${heading}」の節idが目次に無い:\n${outline}`);
    return match[1] as string;
  }

  function journalAppendFailsOnce(stores: Stores, reason: string): Stores {
    let calls = 0;
    return {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error(reason));
          return stores.journal.append(entry);
        },
      },
    };
  }

  it('半完了 → 同じ呼び出しをやり直す → 移し先に重複が増えない・出どころから切れている（journal.append が1回だけ落ちる）', async () => {
    clearRecentTracesForTesting();
    const stores = journalAppendFailsOnce(createMemoryStores(), 'boom-1230-once');
    await stores.persona.write(
      'from-doc-1230',
      '# 表紙\n\n芯\n\n## 節A\n\n節Aの本文\n\n## 節B\n\n節Bの本文\n',
    );
    const tools = createCloneTools({
      stores,
      emit: () => {},
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

    const outline = await callExpectingError(tools, 'memory_outline', {
      slug: 'from-doc-1230',
    });
    expect(outline.isError).toBe(false);
    const sectionIds = [sectionIdFor(outline.text, '## 節A'), sectionIdFor(outline.text, '## 節B')];

    const args = {
      fromSlug: 'from-doc-1230',
      sections: sectionIds,
      toSlug: 'to-doc-1230',
      summary: '節A・節Bをまとめる',
    };

    const first = await callExpectingError(tools, 'memory_section_move', args);
    expect(first.isError).toBe(true);
    expect(first.text.split('\n')[0]).toBe('⚠⚠ 一部完了・未記録・やり直し禁止');
    expect(first.text).toContain('重複しているが、失われてはいない');

    const fromAfterFirst = await stores.persona.read('from-doc-1230');
    const toAfterFirst = await stores.persona.read('to-doc-1230');
    expect(fromAfterFirst?.content).toContain('## 節A');
    expect(fromAfterFirst?.content).toContain('## 節B');
    expect(toAfterFirst?.content).toContain('## 節A');
    expect(toAfterFirst?.content).toContain('## 節B');
    expect(await stores.journal.list({})).toHaveLength(0);

    const second = await callExpectingError(tools, 'memory_section_move', args);
    expect(second.isError).toBe(false);

    expect(second.text).toContain('既に在ったため、追記していない');

    const fromAfterSecond = await stores.persona.read('from-doc-1230');
    const toAfterSecond = await stores.persona.read('to-doc-1230');
    expect(fromAfterSecond).not.toBeNull();
    expect(toAfterSecond).not.toBeNull();

    expect(fromAfterSecond?.content).not.toContain('## 節A');
    expect(fromAfterSecond?.content).not.toContain('## 節B');

    const destSections = scanMemorySections(toAfterSecond?.content ?? '').sections;
    const destIds = destSections.map((section) => section.id);
    expect(destIds).toHaveLength(new Set(destIds).size);
    expect(destSections.filter((section) => section.heading === '## 節A')).toHaveLength(1);
    expect(destSections.filter((section) => section.heading === '## 節B')).toHaveLength(1);

    const all = await stores.journal.list({});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'memory_update', action: 'move_out' });
    expect((all[0] as { summary: string }).summary).toContain('既に');
  });

  it('半完了 → やり直しを繰り返しても、3回目以降も重複が増えない（一度決着した後は通常どおり）', async () => {
    const stores = journalAppendFailsOnce(createMemoryStores(), 'boom-1230-repeat');
    await stores.persona.write('from-doc-1230b', '# 表紙\n\n芯\n\n## 節C\n\n節Cの本文\n');
    const tools = createCloneTools({
      stores,
      emit: () => {},
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

    const outline = await callExpectingError(tools, 'memory_outline', {
      slug: 'from-doc-1230b',
    });
    const sectionId = firstSectionId(outline.text);
    const args = {
      fromSlug: 'from-doc-1230b',
      sections: [sectionId],
      toSlug: 'to-doc-1230b',
      summary: '節Cを移す',
    };

    await callExpectingError(tools, 'memory_section_move', args);
    const settled = await callExpectingError(tools, 'memory_section_move', args);
    expect(settled.isError).toBe(false);

    const third = await callExpectingError(tools, 'memory_section_move', args);
    expect(third.isError).toBe(false);
    expect(third.text).toContain('の節は無い');
    expect(third.text).not.toContain('曖昧');

    const toContent = (await stores.persona.read('to-doc-1230b'))?.content ?? '';
    const destSections = scanMemorySections(toContent).sections;
    expect(destSections.filter((section) => section.heading === '## 節C')).toHaveLength(1);
  });
});

describe('ask_human の putApproval が失敗したとき（跡が消えない・SQLSTATE が両方に出る）', () => {
  async function callExpectingError(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  }

  function fakePgInsertError(): Error {
    const pgError = new Error('duplicate key value violates unique constraint "approvals_pkey"');
    Object.assign(pgError, { code: '23505', constraint: 'approvals_pkey', table: 'approvals' });
    const drizzleError = new Error(
      'Failed query: insert into "approvals" ("id", "created_at", "answered_at", ' +
        '"withdrawn_at", "approval") values ($1, $2, $3, $4, $5)\n' +
        'params: SECRET-QUESTION-VALUE-CANARY',
    );
    drizzleError.name = 'DrizzleQueryError';
    (drizzleError as { cause?: unknown }).cause = pgError;
    return drizzleError;
  }

  function storesWithFailingPutApproval(error: unknown): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      jobs: {
        ...base.jobs,
        putApproval: () => Promise.reject(error),
      },
    };
  }

  it('⭐ SQLSTATE が本文にも stderr の跡にも出る。生の SQL・束縛パラメータ・質問本文は出ない', async () => {
    clearRecentTracesForTesting();
    const CANARY = 'CANARY-QUESTION-本文は出てはいけない';
    const stores = storesWithFailingPutApproval(fakePgInsertError());
    const tools = createCloneTools({
      stores,
      emit: () => {},
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

    let result: { isError: boolean; text: string } | undefined;
    const stderrLines = await captureStderr(async () => {
      result = await callExpectingError(tools, 'ask_human', { question: CANARY });
    });

    if (result === undefined) throw new Error('呼び出しが完了していない');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('code=23505');
    expect(result.text).toContain('constraint=approvals_pkey');
    expect(result.text).toContain('table=approvals');
    expect(result.text).not.toContain('SECRET-QUESTION-VALUE-CANARY');
    expect(result.text).not.toContain(CANARY);

    const stderrJoined = stderrLines.join('\n');
    expect(stderrJoined).toContain('code=23505');
    expect(stderrJoined).not.toContain('SECRET-QUESTION-VALUE-CANARY');
    expect(stderrJoined).not.toContain(CANARY);

    expect((await stores.jobs.listApprovals()).entries).toHaveLength(0);
    const traces = recentDroppedTraces();
    expect(traces.some((line) => line.includes('承認待ちを記録できませんでした'))).toBe(true);
  });

  it('先頭行だけで「未記録・確認は届いていない・やり直してよい」と分かる。isError のまま', async () => {
    const stores = storesWithFailingPutApproval(new Error('boom'));
    const tools = createCloneTools({
      stores,
      emit: () => {},
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

    const { isError, text } = await callExpectingError(tools, 'ask_human', { question: 'Q' });

    expect(isError).toBe(true);
    expect(text.split('\n')[0]).toBe('⚠⚠ 未記録・確認は人間へ届いていない・やり直してよい');
    expect(text).toContain('やり直してよい');
  });
});

describe('説明文が実装のふるまいを数え直している箇所（#701 の族）', () => {
  const RUNTIME_FOR_DESCRIPTION_TEETH: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    buildTime: { builtAt: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: heuristicChars(3),
    systemPromptChars: heuristicChars(999),
    lastContextUsage: null,
  };

  function descriptionOf(tool: string): string {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    return tools.find((entry) => entry.name === tool)?.description ?? '';
  }

  describe('memory_section_move の断りの列挙', () => {
    const SOURCE = ['# 私について', '', '## 事例', '', '本文', ''].join('\n');

    it('出どころの文書が存在しないときの断りが、実際に踏めて、説明文に在る', async () => {
      const h = harness();
      await h.stores.persona.write('about-me', SOURCE);

      const outline = await h.call('memory_outline', { slug: 'about-me' });
      const id = /\[([^\]]+)\]/.exec(outline)?.[1];
      if (id === undefined) throw new Error(`節id を取れない: ${outline}`);
      const moved = await h.call('memory_section_move', {
        fromSlug: 'about-me',
        sections: [id],
        toSlug: 'about-me-appendix',
        summary: '移した',
      });
      expect(moved, '正の対照: ふつうの移動が通らない器では、下の断りを測れない').not.toContain(
        '存在しない',
      );

      const denied = await h.call('memory_section_move', {
        fromSlug: 'about-me-typo',
        sections: [id],
        toSlug: 'about-me-appendix',
        summary: '打ち間違えた',
      });
      expect(denied).toContain('存在しない');
      expect(denied).toContain('何も変わっていない');

      const description = descriptionOf('memory_section_move');
      expect(
        /断るのは[^。]*出どころの文書がそもそも無い/.test(description),
        '【赤の意味】memory_section_move の説明文の列挙に「出どころの文書がそもそも無い」が無い。' +
          '実装は `記憶 <slug> は存在しない` で断るのに、説明文がそれを予告していない——' +
          '打ち間違い1つで踏める、いちばん普通の断りである',
      ).toBe(true);
    });

    it('断りの本数を数で名乗らない（数に入れるかの判断が説明文から確かめられない）', () => {
      const description = descriptionOf('memory_section_move');
      expect(
        /断るのは\d+つ/.test(description),
        '【赤の意味】memory_section_move の説明文が断りの本数を数で名乗っている。' +
          '到達しない断り（guardFullReplace の denial・frontmatter の解釈が変わる枝）を' +
          '数に入れるかどうかは説明文の側から確かめようが無い。数を書かず、列挙だけにすること',
      ).toBe(false);
    });
  });

  describe('approvals_list は答えの本文を持つ（id モード）', () => {
    async function seedAnswered(h: Harness): Promise<void> {
      await h.stores.jobs.putApproval({
        id: 'apr-answered',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: '本番へ出してよいか',
        answeredAt: '2026-01-01T01:00:00.000Z',
        answer: 'いまは出さないでほしい',
      });
    }

    it('実装側: 回答済みの1件を id で開くと、答えの本文が返る', async () => {
      const h = harness();
      await seedAnswered(h);

      const reply = await h.call('approvals_list', { id: 'apr-answered' });

      expect(reply).toContain('回答: いまは出さないでほしい');
      expect(reply).toContain('に回答済み');

      const listing = await h.call('approvals_list', {});
      expect(listing).toContain('人間の回答待ちは無い');
    });

    it('説明文側: conversation_read の説明文が「答えの本文を持たない」と言っていない', () => {
      const description = descriptionOf('conversation_read');
      expect(
        description,
        '【赤の意味】conversation_read の説明文が「approvals_list は答えの本文を持たない」と' +
          '言っている。実装の id モードは `回答: <本文>` を返すので、これは偽である',
      ).not.toContain('答えの本文を持たない');
    });

    it('説明文側: システムプロンプトも「答えの本文を持たない」と言っていない', () => {
      const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });
      expect(
        prompt,
        '【赤の意味】システムプロンプト（prompt.ts）が「approvals_list は答えの本文を持たない」と' +
          '言っている。道具の説明文と同じ主張が2箇所に写されているので、片方だけ直すと族を再生産する',
      ).not.toContain('答えの本文を持たない');
    });
  });

  describe('manager_list の「背景処理待ち×N」の N', () => {
    it('N は tasks であって withheldReports ではない（2つが違う値のときに見分ける）', async () => {
      const h = harness();
      h.running.push({
        managerId: 'mgr-bg',
        status: 'done',
        live: true,
        cwd: '/work',
        request: '委譲',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
        awaitingBackground: {
          // わざと違う値にする: 同じ値だと、どちらを描いているか分からないため
          tasks: 3,
          withheldReports: 2,
          breakdown: 'local_agent×3',
          since: '2026-09-05T00:00:00.000Z',
        },
      });

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('背景処理待ち×3');
      expect(reply, 'N が withheldReports（2）で描かれている').not.toContain('背景処理待ち×2');
    });

    it('説明文が N を「握り潰した報告の本数」と言っていない', () => {
      const description = descriptionOf('manager_list');
      expect(
        description,
        '【赤の意味】manager_list の説明文が「N はそのとき握り潰した報告の本数」と言っている。' +
          '実際に描かれるのは awaitingBackground.tasks（背景タスクの在り高）で、' +
          'ManagerAwaitingBackground の doc は逐語で「`withheldReports` と1つに畳まない。」と' +
          '名指しで禁じている',
      ).not.toContain('N はそのとき握り潰した報告の本数');
    });
  });

  describe('manager_report の配っていない報告の本数（Issue #2183）', () => {
    it('manager_report は awaitingBackground のときだけ本数を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0]!;
      target.lastReport = '報告本文';
      target.awaitingBackground = {
        tasks: 5,
        withheldReports: 2,
        breakdown: 'local_agent×5',
        since: '2026-09-05T00:00:00.000Z',
      };

      const reply = await h.call('manager_report', { managerId: target.managerId });

      expect(reply).toContain('配っていない報告 2 本');
      expect(reply, 'tasks（5）ではなく withheldReports（2）を出す').not.toContain(
        '配っていない報告 5 本',
      );
      expect(reply).toContain('中身は日誌の decision に在る');
    });

    it('manager_report は awaitingBackground が無ければ本数の行を足さない', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0]!;
      target.lastReport = '報告本文';

      const reply = await h.call('manager_report', { managerId: target.managerId });

      expect(reply).not.toContain('配っていない報告');
    });

    it('manager_report は報告がまだ無い回でも、awaitingBackground が在れば本数を出す', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0]!;
      target.awaitingBackground = {
        tasks: 1,
        withheldReports: 3,
        breakdown: 'local_agent×1',
        since: '2026-09-05T00:00:00.000Z',
      };

      const reply = await h.call('manager_report', { managerId: target.managerId });

      expect(reply).toContain('配っていない報告 3 本');
    });

    it('manager_list はこの本数を出さない（tasks と並べて畳まない設計）', async () => {
      const h = harness();
      await h.call('manager_start', { request: 'A' });
      const target = h.running[0]!;
      target.awaitingBackground = {
        tasks: 5,
        withheldReports: 2,
        breakdown: 'local_agent×5',
        since: '2026-09-05T00:00:00.000Z',
      };

      const reply = await h.call('manager_list', {});

      expect(reply).toContain('背景処理待ち×5');
      expect(reply, 'manager_list は withheldReports を出さない設計のまま').not.toContain(
        '配っていない報告',
      );
    });
  });

  describe('usage_read はアカウント全体の残り枠も返す', () => {
    it('実装側: 軸を渡さなければ出て、軸を渡せば出ない', async () => {
      const h = harness();

      const whole = await h.call('usage_read', {});
      expect(whole).toContain('アカウント全体');
      expect(whole).toContain('alteroid が使った分');

      const axisOnly = await h.call('usage_read', { axis: 'date' });
      expect(axisOnly, '軸モードでアカウント全体が出ている').not.toContain('アカウント全体');
    });

    it('説明文が、台帳とアカウント全体の残りの両方を名乗る', () => {
      const description = descriptionOf('usage_read');
      expect(
        description.includes('アカウント全体'),
        '【赤の意味】usage_read の説明文が、アカウント全体の残り枠・支出上限に1文字も触れていない。' +
          '実装は軸を渡さないモードで renderAccountUsage を先頭に置いており、prompt.ts の側は' +
          '正しく両方を言っている——腐っているのは説明文の側である',
      ).toBe(true);
    });
  });

  describe('self_status の項目列挙', () => {
    function runtimeItemLabels(): string[] {
      return describeCloneRuntime(RUNTIME_FOR_DESCRIPTION_TEETH)
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).split(': ')[0] ?? '');
    }

    it('実装が実際に出す項目が、全部そろって取れている（この歯の空振り防止）', () => {
      const labels = runtimeItemLabels();
      expect(labels.length, 'describeCloneRuntime から項目名が1つも取れない').toBeGreaterThan(0);
      expect(labels.every((label) => label.length > 0)).toBe(true);
    });

    it('整形の出力と CLONE_RUNTIME_ITEM_LABELS が、数も名前も一致する', () => {
      expect(
        runtimeItemLabels(),
        '【赤の意味】describeCloneRuntime が実際に出す行と CLONE_RUNTIME_ITEM_LABELS（self.ts）が' +
          'ずれている。説明文はこの定数から導出しているので、ずれた分は説明文からも静かに落ちる',
      ).toEqual([...CLONE_RUNTIME_ITEM_LABELS]);
    });

    it('実装が出す項目が全部、説明文に現れる', () => {
      const description = descriptionOf('self_status');
      const missing = runtimeItemLabels().filter((label) => !description.includes(label));
      expect(
        missing,
        '【赤の意味】describeCloneRuntime（self.ts）が実際に出す項目が、self_status の説明文に' +
          `無い: ${missing.join(' / ')}\n` +
          '説明文が実装の項目を数え直していて、実装だけが増えた。説明文を出所から導出すること' +
          '——具体を落とすと、クローンは「その値が取れる」と気づけなくなる（north_star 禁止1）。',
      ).toEqual([]);
    });
  });

  describe('commitment_list の「自動的にここへ載る」出所', () => {
    function openingEventTypes(): string[] {
      const at = '2026-01-01T00:00:00.000Z';
      const events: InboxEvent[] = [
        { type: 'human_message', id: 'e1', at, text: 'やって', conversationId: 'c1' },
        { type: 'human_answer', id: 'e2', at, approvalId: 'apr-1', answer: 'よい' },
        { type: 'manager_message', id: 'e3', at, managerId: 'm1', kind: 'report', text: '報告' },
        { type: 'external', id: 'e4', at, source: 'github', payload: { n: 1 } },
        { type: 'timer', id: 'e5', at, kind: 'daily_report' },
        { type: 'self_initiative', id: 'e6', at, reason: 'tick' },
        { type: 'distill', id: 'e7', at, reason: 'scheduled' },
      ];
      return events.filter((event) => commitmentFor(event) !== null).map((event) => event.type);
    }

    it('実装側: 台帳を開く出所は4つである', () => {
      expect(openingEventTypes()).toEqual([
        'human_message',
        'human_answer',
        'manager_message',
        'external',
      ]);
    });

    it('説明文が、人間の回答（ask_human の答え）も自動で載ると言っている', () => {
      const description = descriptionOf('commitment_list');
      expect(
        /人間の回答|承認待ちへの回答/.test(description),
        '【赤の意味】commitment_list の説明文が、台帳へ自動で載る出所を3つしか名乗っていない。' +
          'clone.ts の commitmentFor は human_answer にも台帳を開く（＝ ask_human の答えが来ると' +
          '1件開く）ので、説明文がそれを予告していない。prompt.ts の側は正しく4つ言っている',
      ).toBe(true);
    });
  });

  describe('approvals_list の並び順の名乗り', () => {
    async function seedMany(h: Harness, order: string[]): Promise<void> {
      for (const id of order) {
        await h.stores.jobs.putApproval({
          id,
          createdAt: '2026-01-01T00:00:00.000Z',
          question: `${id} ${'あ'.repeat(400)}`,
        });
      }
    }

    it('実装側: #757 で全順序にした（同じ createdAt なら id 昇順で、挿入順に関わらず揃う）', async () => {
      const ascending = harness();
      await seedMany(ascending, ['apr-a', 'apr-b', 'apr-c']);
      const forward = await ascending.call('approvals_list', {});

      const shuffled = harness();
      await seedMany(shuffled, ['apr-c', 'apr-a', 'apr-b']);
      const backward = await shuffled.call('approvals_list', {});

      for (const id of ['apr-a', 'apr-b', 'apr-c']) {
        expect(forward).toContain(id);
        expect(backward).toContain(id);
      }
      expect(forward.indexOf('apr-a')).toBeLessThan(forward.indexOf('apr-c'));
      expect(
        backward.indexOf('apr-a'),
        '【赤の意味】同着の並べ直し（id 昇順）が効いていない。挿入順（apr-c が先）の' +
          'まま出ている——#757 の全順序化が壊れている。',
      ).toBeLessThan(backward.indexOf('apr-c'));
    });

    it('省略の行が「作成が古い順に」と断言している（#757 でハンドラが実際に並べ直すようになった）', async () => {
      const h = harness();
      await seedMany(
        h,
        Array.from({ length: 40 }, (_, index) => `apr-${index}`),
      );

      const reply = await h.call('approvals_list', {});

      expect(reply, '正の対照: 省略の行が出ていない（本数か長さが足りない）').toContain('は省略');
      expect(
        reply,
        '【赤の意味】approvals_list の省略の行が「作成が古い順に」と言っていない。' +
          '#757 でハンドラ自身が createdAt 昇順・同着は id 昇順に並べ直すようになった' +
          'ので、断言できるはずである。文言を変えたなら、この歯の期待する語も合わせて直すこと',
      ).toContain('古い順に');
    });
  });

  describe('approvals_list は createdAt の順序も同着の順序も保証しない（#757 の固定歯）', () => {
    it('#757 で直った: createdAt が新しい方を先に積んでも、createdAt 昇順（古い方が先）で出る', async () => {
      const h = harness();
      await h.stores.jobs.putApproval({
        id: 'apr-new',
        createdAt: '2026-02-01T00:00:00.000Z',
        question: 'new',
      });
      await h.stores.jobs.putApproval({
        id: 'apr-old',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: 'old',
      });

      const reply = await h.call('approvals_list', {});

      expect(reply).toContain('apr-new');
      expect(reply).toContain('apr-old');
      expect(
        reply.indexOf('apr-old'),
        '【赤の意味】createdAt 昇順になっていない。挿入順のまま apr-new が先に' +
          '出ている——#757 のハンドラ側の並べ直しが効いていない。',
      ).toBeLessThan(reply.indexOf('apr-new'));
    });

    it('#757 で直った: 同じ createdAt の同着は id 昇順で決まる（挿入順に関わらず）', async () => {
      const h = harness();
      await h.stores.jobs.putApproval({
        id: 'apr-z',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: 'z',
      });
      await h.stores.jobs.putApproval({
        id: 'apr-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        question: 'a',
      });

      const reply = await h.call('approvals_list', {});

      expect(reply).toContain('apr-z');
      expect(reply).toContain('apr-a');
      expect(
        reply.indexOf('apr-a'),
        '【赤の意味】同着が id 昇順になっていない。挿入順のまま apr-z が先に' +
          '出ている——#757 の同着タイブレークが効いていない。',
      ).toBeLessThan(reply.indexOf('apr-z'));
    });
  });
});

describe('journal.append 失敗時の応答本文: 呼び出し箇所すべてで道具名と先頭行 outcome を測る', () => {
  async function callExpectingError(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  }

  function firstSectionId(outline: string): string {
    const match = /^\s*\[([0-9a-f]{8}-[0-9a-f]{8})\]/m.exec(outline);
    if (match === null) throw new Error(`節idが目次に無い:\n${outline}`);
    return match[1] as string;
  }

  function failingJournalAppendAtCall(stores: Stores, failAt: number, reason: string): Stores {
    let calls = 0;
    return {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) => {
          calls += 1;
          if (calls === failAt) return Promise.reject(new Error(reason));
          return stores.journal.append(entry);
        },
      },
    };
  }

  const ACT_COMPLETED = '⚠⚠ 完了済み・未記録・やり直し禁止';
  const ACT_NOT_PERFORMED = '⚠⚠ 未記録・行為は起きていない・やり直してよい';
  const ACT_PARTIALLY_COMPLETED = '⚠⚠ 一部完了・未記録・やり直し禁止';

  interface Case {
    tool: string;
    firstLine: string;
    run: () => Promise<{ isError: boolean; text: string }>;
  }

  const CASES: Case[] = [
    {
      tool: 'memory_write',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-01');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'memory_write', {
          slug: 'doc-write',
          content: '本文',
          summary: '要約',
        });
      },
    },
    {
      tool: 'memory_append',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-02');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'memory_append', {
          slug: 'doc-append',
          content: '追記',
          summary: '要約',
        });
      },
    },
    {
      tool: 'memory_delete',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-03');
        await stores.persona.write('doc-to-delete', '消される文書\n');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'memory_delete', {
          slug: 'doc-to-delete',
          summary: '整理',
          base_version: memoryVersion((await stores.persona.read('doc-to-delete'))!.content),
        });
      },
    },
    {
      tool: 'memory_frontmatter_set',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-04');
        await stores.persona.write('doc-fm', '---\ntype: premise\n---\n# 表紙\n本文');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'memory_frontmatter_set', {
          slug: 'doc-fm',
          description: '新しい要旨',
          summary: '要旨を直した',
          base_version: memoryVersion((await stores.persona.read('doc-fm'))!.content),
        });
      },
    },
    {
      tool: 'memory_section_move',
      firstLine: ACT_PARTIALLY_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-05');
        await stores.persona.write('from-doc-mi', '# 表紙\n\n芯\n\n## 節A\n\n本文\n');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        const outline = await callExpectingError(tools, 'memory_outline', { slug: 'from-doc-mi' });
        const sectionId = firstSectionId(outline.text);
        return callExpectingError(tools, 'memory_section_move', {
          fromSlug: 'from-doc-mi',
          sections: [sectionId],
          toSlug: 'to-doc-mi',
          summary: '移動',
        });
      },
    },
    {
      tool: 'memory_section_move',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppendAtCall(createMemoryStores(), 2, 'boom-case-06');
        await stores.persona.write('from-doc-mo', '# 表紙\n\n芯\n\n## 節A\n\n本文\n');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        const outline = await callExpectingError(tools, 'memory_outline', { slug: 'from-doc-mo' });
        const sectionId = firstSectionId(outline.text);
        return callExpectingError(tools, 'memory_section_move', {
          fromSlug: 'from-doc-mo',
          sections: [sectionId],
          toSlug: 'to-doc-mo',
          summary: '移動',
        });
      },
    },
    {
      tool: 'journal_write',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-07');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'journal_write', {
          decision: '判断した',
          grounds: '根拠',
        });
      },
    },
    {
      tool: 'ask_human',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-08');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'ask_human', { question: '質問' });
      },
    },
    {
      tool: 'request_permission',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-08a');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'request_permission', {
          rule: 'Bash(gh release edit:*)',
          allows: ['gh release edit'],
          denies: ['gh release edit; rm -rf /'],
          reason: '理由',
        });
      },
    },
    {
      tool: 'approval_withdraw',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-08b');
        await stores.jobs.putApproval({
          id: 'ap-withdraw-test',
          createdAt: '2026-01-01T00:00:00.000Z',
          question: '取り下げられる質問',
        });
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'approval_withdraw', {
          id: 'ap-withdraw-test',
          reason: '不要になった',
        });
      },
    },
    {
      tool: 'daily_report_write',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-09');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'daily_report_write', { body: '今日の報告' });
      },
    },
    {
      tool: 'conversation_post',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-conversation-post');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'conversation_post', {
          conversationId: 'conv-1',
          text: '知らせ',
        });
      },
    },
    {
      tool: 'schedule_create',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-10');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'schedule_create', {
          kind: 'watch-test',
          request: 'いつもの見回り',
          dailyAt: '09:00',
        });
      },
    },
    {
      tool: 'schedule_remove',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-11');
        await stores.schedules.put({
          kind: 'watch-test',
          spec: { type: 'daily', at: '09:00' },
          request: 'いつもの見回り',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'schedule_remove', { kind: 'watch-test' });
      },
    },
    {
      tool: 'commitment_open',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-12');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'commitment_open', { body: '宿題を引き受けた' });
      },
    },
    {
      tool: 'commitment_close',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-13');
        await stores.commitments.open({
          id: 'c-close-test',
          at: '2026-01-01T00:00:00.000Z',
          origin: 'self',
          body: '片付ける件',
        });
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'commitment_close', {
          id: 'c-close-test',
          reason: '終わった',
        });
      },
    },
    {
      tool: 'commitment_close_many',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-13b');
        await stores.commitments.open({
          id: 'c-close-many-test',
          at: '2026-01-01T00:00:00.000Z',
          origin: 'external',
          source: 'token-pool',
          body: '知らせ',
        });
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'commitment_close_many', {
          origin: ['external'],
          reason: '知らせなので引き受ける対象が無い',
          dryRun: false,
        });
      },
    },
    {
      tool: 'commitment_edit',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-14');
        await stores.commitments.open({
          id: 'c-edit-test',
          at: '2026-01-01T00:00:00.000Z',
          origin: 'self',
          body: '直す前の本文',
        });
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'commitment_edit', {
          id: 'c-edit-test',
          body: '直した後の本文',
        });
      },
    },
    {
      tool: 'inbox_remove_many',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-14b');
        await stores.inbox.put(
          {
            type: 'manager_message',
            id: 'evt-remove-many-test',
            at: '2026-01-01T00:00:00.000Z',
            managerId: 'mgr-1',
            kind: 'report',
            text: '429',
          },
          '2026-01-01T00:00:00.000Z',
        );
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
          dropQueuedInboxEvents: async (ids) => ids.length,
        });
        return callExpectingError(tools, 'inbox_remove_many', {
          types: ['manager_message'],
          reason: '同じ失敗の写しを畳む',
          dryRun: false,
        });
      },
    },
    {
      tool: 'profile_write',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-15');
        const runners = {
          async list() {
            return [
              {
                runnerId: 'runner-test',
                async setProfile() {
                  return { ok: true as const };
                },
              },
            ];
          },
          async get() {
            return null;
          },
          async select() {
            throw new Error('この検証では使わない');
          },
        } as never;
        const tools = createCloneTools({
          stores,
          emit: () => {},
          profile: createProfileService({ stores, runners }),
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'profile_write', {
          script: 'export A=1',
          summary: 'プロファイル更新',
        });
      },
    },
    {
      tool: 'profile_remove',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-profile-remove');
        await stores.profile.set('a', 'export A=1\n', 'all');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          profile: createProfileService({ stores }),
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        const outcome = await callExpectingError(tools, 'profile_remove', {
          name: 'a',
          summary: 'プロファイル行を外す',
        });
        expect((await stores.profile.list()).map((row) => row.name)).toEqual(['a']);
        return outcome;
      },
    },
    {
      tool: 'manager_start',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-16');
        const managers = {
          async start(input: { request: string; cwd?: string; runnerId?: string }) {
            return {
              managerId: 'mgr-manager_start-test',
              status: 'running',
              live: true,
              cwd: input.cwd ?? '/work',
              request: input.request,
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              waiting: [],
            };
          },
        } as unknown as ManagerPool;
        const tools = createCloneTools({
          stores,
          emit: () => {},
          managers,
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'manager_start', { request: '調査' });
      },
    },
    {
      tool: 'archive_remove',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-17');
        const archiveId = (await stores.archive.archive('sess-case-17', 'BODY\n')).id;
        const managers = { runningManagerOwning: () => undefined } as unknown as ManagerPool;
        const tools = createCloneTools({
          stores,
          emit: () => {},
          managers,
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'archive_remove', {
          archiveId,
          summary: '不要になったので消す',
        });
      },
    },
    {
      tool: 'archive_remove_many',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-18');
        await stores.archive.archive('sess-case-18', 'AAA');
        await stores.archive.archive('sess-case-18', 'AAABBB');
        const managers = { runningManagerOwning: () => undefined } as unknown as ManagerPool;
        const tools = createCloneTools({
          stores,
          emit: () => {},
          managers,
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'archive_remove_many', {
          sessionIds: ['sess-case-18'],
          summary: '不要になったので消す',
          dryRun: false,
        });
      },
    },
    {
      tool: 'practice_write',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-19');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'practice_write', {
          slug: 'daily',
          kind: '日報',
          title: '日報のやり方',
          content: '毎日夕方に書く',
        });
      },
    },
    {
      tool: 'practice_remove',
      firstLine: ACT_COMPLETED,
      async run() {
        const stores = createMemoryStores();
        const written = await stores.practices.write({
          slug: 'daily',
          kind: '日報',
          title: '日報のやり方',
          content: '毎日夕方に書く',
        });
        const failing = failingJournalAppend(stores, 'boom-case-20');
        const tools = createCloneTools({
          stores: failing,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'practice_remove', {
          slug: 'daily',
          base_version: practiceVersion(written),
        });
      },
    },
    {
      tool: 'github_observation_record',
      firstLine: ACT_NOT_PERFORMED,
      async run() {
        const stores = failingJournalAppend(createMemoryStores(), 'boom-case-github-observation');
        const tools = createCloneTools({
          stores,
          emit: () => {},
          memoryCause: () => 'clone',
          conversationId: () => undefined,
        });
        return callExpectingError(tools, 'github_observation_record', {
          repo: 'a/b',
          query: 'gh issue list --state open',
          result: { status: 'ok', openIssues: 1, openPulls: 0, truncated: false },
        });
      },
    },
  ];

  it.each(CASES)(
    '$tool ($firstLine): 応答本文が道具名と先頭行 outcome を持つ',
    async ({ tool, firstLine, run }) => {
      const { isError, text } = await run();
      expect(isError).toBe(true);
      expect(text.split('\n')[0]).toBe(firstLine);
      expect(text).toContain(tool);
    },
  );

  it('CASES の道具名の集合は、SELF_JOURNALING_CLONE_TOOLS から manager_send / manager_stop を除いたものと一致する', () => {
    const EXPECTED_TOOLS = SELF_JOURNALING_CLONE_TOOLS.filter(
      (name) => name !== 'manager_send' && name !== 'manager_stop',
    );
    const actualTools = [...new Set(CASES.map((c) => c.tool))];
    expect(actualTools.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe('#857: lost / failed の中を「依頼者が何を知らないか」で並べる', () => {
  const NEWEST = Date.parse('2026-09-12T12:00:00.000Z');
  const minutesBefore = (minutes: number) => new Date(NEWEST - minutes * 60_000).toISOString();

  const FAILURE = {
    code: 'billing_error',
    via: 'assistant_error',
    at: '2026-09-12T01:00:00.000Z',
  } as const;

  function entry(
    managerId: string,
    status: JobStatus,
    minutesAgo: number,
    report: 'none' | 'failure-wrapped' | 'delivered',
  ): ManagerSummary {
    return {
      managerId,
      status,
      live: false,
      cwd: '/workspace/repo',
      request: `依頼 ${managerId}: ${'あ'.repeat(400)}`,
      startedAt: minutesBefore(minutesAgo),
      updatedAt: minutesBefore(minutesAgo),
      waiting: [],
      runnerId: 'runner-test',
      ...(report === 'none'
        ? {}
        : report === 'failure-wrapped'
          ? {
              lastReport: '（このターンは応答を返さずに終わった: billing_error）',
              lastFailure: FAILURE,
            }
          : { lastReport: '終わった' }),
    };
  }

  function pool(entries: readonly ManagerSummary[]): Harness {
    const h = harness();
    for (const item of [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      h.running.push(item);
    }
    return h;
  }

  it('⭐⭐ lost の中は none → failure-wrapped → delivered の順に出る（古い側に none を置いても逆転しない）', async () => {
    const h = pool([
      entry('mgr-lost-none', 'lost', 300, 'none'),
      entry('mgr-lost-wrapped', 'lost', 200, 'failure-wrapped'),
      entry('mgr-lost-delivered', 'lost', 100, 'delivered'),
    ]);

    const reply = await h.call('manager_list', {});

    for (const id of ['mgr-lost-none', 'mgr-lost-wrapped', 'mgr-lost-delivered']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-lost-none')).toBeLessThan(reply.indexOf('mgr-lost-wrapped'));
    expect(reply.indexOf('mgr-lost-wrapped')).toBeLessThan(reply.indexOf('mgr-lost-delivered'));
  });

  it('⭐⭐ failed の中も none → failure-wrapped → delivered の順に出る（同じ測定条件の反転）', async () => {
    const h = pool([
      entry('mgr-fail-none', 'failed', 300, 'none'),
      entry('mgr-fail-wrapped', 'failed', 200, 'failure-wrapped'),
      entry('mgr-fail-delivered', 'failed', 100, 'delivered'),
    ]);

    const reply = await h.call('manager_list', {});

    for (const id of ['mgr-fail-none', 'mgr-fail-wrapped', 'mgr-fail-delivered']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-fail-none')).toBeLessThan(reply.indexOf('mgr-fail-wrapped'));
    expect(reply.indexOf('mgr-fail-wrapped')).toBeLessThan(reply.indexOf('mgr-fail-delivered'));
  });

  it('🔴 群の境界は動いていない（走行中・返事待ち → lost → その他。副順位は群を跨がない）', async () => {
    const inFlight = (['running', 'waiting_human'] as const).map((status, index) =>
      entry(`mgr-live-${index}`, status, 30_000 + index, 'delivered'),
    );
    const lost = [
      // 副順位はいちばん後ろ（`delivered`）
      entry('mgr-lost-delivered', 'lost', 20_000, 'delivered'),
    ];
    const terminal = [
      entry('mgr-fail-none', 'failed', 1, 'none'),
      entry('mgr-done-0', 'done', 2, 'delivered'),
    ];
    const h = pool([...inFlight, ...lost, ...terminal]);

    const reply = await h.call('manager_list', {});

    for (const id of ['mgr-live-0', 'mgr-live-1', 'mgr-lost-delivered', 'mgr-fail-none']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-live-0')).toBeLessThan(reply.indexOf('mgr-lost-delivered'));
    expect(reply.indexOf('mgr-live-1')).toBeLessThan(reply.indexOf('mgr-lost-delivered'));
    expect(reply.indexOf('mgr-lost-delivered')).toBeLessThan(reply.indexOf('mgr-fail-none'));
  });

  it('対象外（done / stopped）と delivered は startedAt のまま混ざる（4つ目の群を作っていない）', async () => {
    const h = pool([
      entry('mgr-done-new', 'done', 10, 'delivered'),
      entry('mgr-fail-delivered', 'failed', 20, 'delivered'),
      entry('mgr-stopped-old', 'stopped', 30, 'delivered'),
    ]);

    const reply = await h.call('manager_list', {});

    for (const id of ['mgr-done-new', 'mgr-fail-delivered', 'mgr-stopped-old']) {
      expect(reply, `${id} が窓の外へ落ちた`).toContain(id);
    }
    expect(reply.indexOf('mgr-done-new')).toBeLessThan(reply.indexOf('mgr-fail-delivered'));
    expect(reply.indexOf('mgr-fail-delivered')).toBeLessThan(reply.indexOf('mgr-stopped-old'));
  });

  it('🔴 副順位を挟んでも cursor は飛ばない・繰り返さない（並びと継続点が同じ比較を使っている）', async () => {
    const kinds = ['none', 'failure-wrapped', 'delivered'] as const;
    const entries = Array.from({ length: 45 }, (_, index) =>
      entry(`mgr-unobs-${String(index).padStart(2, '0')}`, 'lost', index, kinds[index % 3]!),
    );
    const h = pool(entries);
    const ids = entries.map((m) => m.managerId);

    const sequence: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (let guard = 0; guard < ids.length + 1; guard += 1) {
      const reply: string = await h.call('manager_list', cursor === undefined ? {} : { cursor });
      pages += 1;
      const onThisPage = ids
        .filter((id) => reply.includes(id))
        .sort((a, b) => reply.indexOf(a) - reply.indexOf(b));
      sequence.push(...onThisPage);
      if (!reply.includes('cursor=')) break;
      cursor = /cursor=([A-Za-z0-9\-_]+)/.exec(reply)![1]!;
    }

    expect(pages, '1頁で収まってしまい、cursor を測れていない').toBeGreaterThan(1);
    expect(new Set(sequence).size, '到達できなかった委譲が在る').toBe(ids.length);
    expect(sequence.length, '同じ委譲が2つの頁に出ている').toBe(ids.length);
    const firstDelivered = sequence.findIndex((id) => {
      const found = entries.find((e) => e.managerId === id)!;
      return found.lastReport !== undefined && found.lastFailure === undefined;
    });
    const lastNone = sequence.reduce(
      (acc, id, index) =>
        entries.find((e) => e.managerId === id)!.lastReport === undefined ? index : acc,
      -1,
    );
    expect(lastNone, 'none が1本も出ていない').toBeGreaterThanOrEqual(0);
    expect(lastNone, 'none より先に delivered が出ている').toBeLessThan(firstDelivered);
  });

  it('⭐ running / waiting_human / done / stopped には1文字も足さない（予算を食わない）', async () => {
    for (const status of ['running', 'waiting_human', 'done', 'stopped'] as const) {
      const h = pool([entry(`mgr-${status}`, status, 10, 'delivered')]);

      const reply = await h.call('manager_list', {});

      expect(reply, `${status} に行が出た`).toContain(`mgr-${status}`);
      for (const word of [
        '終端までに本文が1文字も届いていない',
        '包んだエラー文であって報告ではない',
        '完遂した報告とは限らない',
      ]) {
        expect(reply, `${status} に #857 の行（${word}）が漏れている`).not.toContain(word);
      }
    }
  });

  it('manager_report は報告が空の回にも #857 の行を出す（掘った先で消えない）', async () => {
    const target = entry('mgr-report-none', 'lost', 10, 'none');
    const h = pool([target]);

    const reply = await h.call('manager_report', { managerId: 'mgr-report-none' });

    expect(reply).toContain('終端までに本文が1文字も届いていない');
  });

  it('manager_report は報告が在る回にも出し、part: request では1文字も足さない', async () => {
    const target = entry('mgr-report-delivered', 'failed', 10, 'delivered');
    const h = pool([target]);

    const reply = await h.call('manager_report', { managerId: 'mgr-report-delivered' });
    expect(reply).toContain('完遂した報告とは限らない');

    const request = await h.call('manager_report', {
      managerId: 'mgr-report-delivered',
      part: 'request',
    });
    expect(request).toContain('依頼文');
    expect(request).not.toContain('完遂した報告とは限らない');
  });

  it('既存の lost の注記は消えていない（軸が違うので両方出る）', async () => {
    const h = pool([entry('mgr-lost-both', 'lost', 10, 'none')]);

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 前のセッションへ戻れなかった');
    expect(reply).toContain('終端までに本文が1文字も届いていない');
  });
});

describe('引数が欠けたときの断り文（#1141）', () => {
  const toolsForShape = () =>
    createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });

  const shapeOf = (name: string) =>
    toolsForShape().find((entry) => entry.name === name)?.inputSchema as
      Record<string, z.ZodTypeAny> | undefined;

  it('必須の引数が欠けたら、呼び出しの生の形を疑えと言う（zod の既定文のままにしない）', () => {
    const shape = shapeOf('journal_write');
    expect(shape).toBeDefined();
    const result = z.object(shape!).safeParse({});
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((issue) => issue.message);

    expect(messages).not.toContain('Invalid input: expected string, received undefined');
    for (const message of messages) {
      expect(message).toContain('呼び出しの生の形');
    }
  });

  it('型が違うだけのときは、zod の既定の文を残す（何が来たかを名乗るのはあちらが正確）', () => {
    const shape = shapeOf('journal_write');
    const result = z.object(shape!).safeParse({ decision: 123, grounds: 'g' });
    expect(result.success).toBe(false);
    const message = result.error!.issues[0]!.message;
    expect(message).toContain('expected string');
    expect(message).not.toContain('呼び出しの生の形');
  });

  it('説明（describe）を落としていない —— モデルが読むのはこちらである', () => {
    const shape = shapeOf('journal_write');
    expect(shape!.decision!.description).toBe('何を判断し、何をしたか');
    expect(shape!.grounds!.description).toBe(
      '記憶のどこに根拠があったか。無いなら「根拠なし」と書く。省いた呼び出しも記録は通るが、根拠は「届かなかった」として残る',
    );
  });

  it('任意の引数が無いだけなら、何も言わずに通る', () => {
    const shape = shapeOf('journal_read');
    expect(shape).toBeDefined();
    expect(Object.keys(shape!).length).toBeGreaterThan(0);
    expect(z.object(shape!).safeParse({}).success).toBe(true);
  });
});

describe('予算で落ちた分へ到達できる（#662）', () => {
  it('memory_list: 落ちた分があるなら、断り書きが cursor を案内する', async () => {
    const h = harness();
    for (let i = 0; i < 200; i += 1) {
      await h.stores.persona.write(
        `doc-${String(i).padStart(3, '0')}`,
        `# 文書 ${i}\n\n本文がここにある。\n`,
      );
    }

    const reply = await h.call('memory_list', {});

    expect(reply).toContain('件は省略');
    expect(reply).toMatch(/memory_list cursor=\S+/);
  });

  it('memory_list: 案内された cursor を渡すと、続きが読める（同じ行を繰り返さない）', async () => {
    const h = harness();
    for (let i = 0; i < 200; i += 1) {
      await h.stores.persona.write(
        `doc-${String(i).padStart(3, '0')}`,
        `# 文書 ${i}\n\n本文がここにある。\n`,
      );
    }

    const first = await h.call('memory_list', {});
    const cursor = /memory_list cursor=(\S+?)[)\s]/.exec(first)?.[1];
    expect(cursor).toBeDefined();

    const second = await h.call('memory_list', { cursor });

    expect(first).toContain('doc-000');
    expect(second).not.toContain('doc-000');
  });

  it('token_list: 落ちた分があるなら、断り書きが cursor を案内する', async () => {
    const h = harness();
    await h.stores.tokens.replace(
      Array.from({ length: 120 }, (_, i) => ({
        id: `tok-${String(i).padStart(3, '0')}`,
        label: `予備 ${i}`,
        value: 'sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN',
        order: i,
      })),
    );

    const reply = await h.call('token_list', {});

    expect(reply).toContain('省略');
    expect(reply).toMatch(/token_list cursor=\S+/);
  });

  it('token_list: 案内された cursor を渡すと、続きが読める', async () => {
    const h = harness();
    await h.stores.tokens.replace(
      Array.from({ length: 120 }, (_, i) => ({
        id: `tok-${String(i).padStart(3, '0')}`,
        label: `予備 ${i}`,
        value: 'sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN',
        order: i,
      })),
    );

    const first = await h.call('token_list', {});
    const cursor = /token_list cursor=(\S+?)[)\s]/.exec(first)?.[1];
    expect(cursor).toBeDefined();

    const second = await h.call('token_list', { cursor });

    expect(first).toContain('tok-000');
    expect(second).not.toContain('tok-000');
  });

  it('token_list: 値（value）は cursor を足しても出ない', async () => {
    const h = harness();
    await h.stores.tokens.replace(
      Array.from({ length: 120 }, (_, i) => ({
        id: `tok-${String(i).padStart(3, '0')}`,
        label: `予備 ${i}`,
        value: 'sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN',
        order: i,
      })),
    );

    const first = await h.call('token_list', {});
    const cursor = /token_list cursor=(\S+?)[)\s]/.exec(first)?.[1];
    const second = await h.call('token_list', { cursor });

    expect(first).not.toContain('sk-ant-oat01');
    expect(second).not.toContain('sk-ant-oat01');
  });

  it('memory_list: 壊れた cursor は黙って先頭へ倒さず、そうと言う', async () => {
    const h = harness();
    await h.stores.persona.write('doc-000', '# 文書\n\n本文\n');

    const reply = await h.call('memory_list', { cursor: 'not-a-real-cursor' });

    expect(reply).not.toContain('doc-000');
    expect(reply).toContain('cursor');
  });

  function floodRunners(count: number): RunnerFleetOverview {
    return {
      runners: Array.from({ length: count }, (_, i) => ({
        label: `runner-${String(i).padStart(3, '0')}`,
        revision: { status: 'unheard' as const },
        state: 'connected' as const,
        since: '2026-01-01T00:00:00.000Z',
        runnerId: `runner-${String(i).padStart(3, '0')}`,
        managers: [],
      })),
      unassigned: [],
      daemonRevision: { status: 'unknown' as const },
    };
  }

  it('runner_list: 落ちた分があるなら、断り書きが cursor を案内する', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(120));

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('台は省略');
    expect(reply).toMatch(/runner_list cursor=\S+/);
  });

  it('runner_list: 案内された cursor を渡すと、続きが読める（同じ行を繰り返さない）', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(120));

    const first = await h.call('runner_list', {});
    const cursor = /runner_list cursor=(\S+?)[)\s]/.exec(first)?.[1];
    expect(cursor).toBeDefined();

    const second = await h.call('runner_list', { cursor });

    expect(first).toContain('runner-000');
    expect(second).not.toContain('runner-000');
  });

  it('runner_list: 壊れた cursor は黙って先頭へ倒さず、そうと言う', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(3));

    const reply = await h.call('runner_list', { cursor: 'not-a-real-cursor' });

    expect(reply).not.toContain('runner-000');
    expect(reply).toContain('cursor');
  });

  it('runner_list: 辿り切ったら「最後の頁」と言う（0台の言い方を奪わない）', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(3));

    const cursor = encodeRunnerCursor({ label: 'runner-002' });
    const reply = await h.call('runner_list', { cursor });

    expect(reply).toContain('最後の頁');
    expect(reply).not.toContain('0台');
  });

  it('runner_list: 錨の器が名簿から消えていたら、出し直したとそう言う（黙って重複させない）', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(3));

    const cursor = encodeRunnerCursor({ label: 'runner-999-いなくなった' });
    const reply = await h.call('runner_list', { cursor });

    expect(reply).toContain('先頭から出し直した');
    expect(reply).toContain('runner-000');
    expect(reply).toContain('runner-001');
    expect(reply).toContain('runner-002');
  });

  it('runner_list: 出し直した頁から取った cursor は、次はちゃんと進む', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(120));

    const restarted = await h.call('runner_list', {
      cursor: encodeRunnerCursor({ label: 'いなくなった器' }),
    });
    expect(restarted).toContain('先頭から出し直した');

    const cursor = /runner_list cursor=(\S+?)[)\s]/.exec(restarted)?.[1];
    expect(cursor).toBeDefined();
    const second = await h.call('runner_list', { cursor });

    expect(second).not.toContain('先頭から出し直した');
    expect(second).not.toContain('runner-000');
  });

  it('runner_list: 「登録は N 台あり」は頁が進んでも動かない', async () => {
    const h = harness();
    h.setRunnersOverview(floodRunners(200));

    const first = await h.call('runner_list', {});
    const cursor = /runner_list cursor=(\S+?)[)\s]/.exec(first)?.[1];
    const second = await h.call('runner_list', { cursor });

    expect(first).toContain('登録は 200 台あり');
    expect(second).toContain('登録は 200 台あり');
  });
});

describe('conversation_post', () => {
  it('指定した会話へ、ターンの返答と同じ形（with: human / role: outbound）で日誌に書き、開いている画面へ流す', async () => {
    const h = harness();

    const reply = await h.call('conversation_post', {
      conversationId: 'conv-1',
      text: '定期の確認で、PR が1本赤くなっていた。',
    });

    expect(reply).toContain('会話 conv-1 へ書いた');
    const [entry] = await h.stores.journal.list({ types: ['exchange'] });
    expect(entry).toMatchObject({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '定期の確認で、PR が1本赤くなっていた。',
      conversationId: 'conv-1',
    });
    expect(h.posted).toEqual([
      { conversationId: 'conv-1', text: '定期の確認で、PR が1本赤くなっていた。' },
    ]);
  });

  it('conversationId を省くと新しい会話を始め、振った id を応答で返す（日誌と画面へ同じ id で届く）', async () => {
    const h = harness();

    const reply = await h.call('conversation_post', { text: '新しく知らせたいことがある。' });

    const [entry] = await h.stores.journal.list({ types: ['exchange'] });
    const id = entry?.type === 'exchange' ? entry.conversationId : undefined;
    expect(id).toBeDefined();
    expect(reply).toContain(`新しい会話 ${id ?? ''} を始めて書いた`);
    expect(h.posted).toEqual([{ conversationId: id, text: '新しく知らせたいことがある。' }]);
  });

  it('いまのターンの会話へは書かない（返答と2通並ぶので）。日誌にも画面にも何も出さない', async () => {
    const h = harness();
    h.setConversationId('conv-now');

    const reply = await h.call('conversation_post', {
      conversationId: 'conv-now',
      text: '重ねて書く',
    });

    expect(reply).toContain('いまのターンの会話なので、この道具では書かなかった');
    expect(await h.stores.journal.list({ types: ['exchange'] })).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it('日誌へ書けなかったら、開いている画面へも流さない（記録に無い発言を画面にだけ出さない）', async () => {
    const posted: { conversationId: string; text: string }[] = [];
    const tools = createCloneTools({
      stores: failingJournalAppend(createMemoryStores(), 'boom-post'),
      emit: () => {},
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      postToConversation: (id, body) => posted.push({ conversationId: id, text: body }),
    });
    const found = tools.find((entry) => entry.name === 'conversation_post');

    let message: string;
    try {
      const result = await found?.handler(
        { conversationId: 'conv-1', text: '知らせ' } as never,
        {},
      );
      message = (result?.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('conversation_post');
    expect(posted).toEqual([]);
  });

  it('いまのターンが別の会話なら、名指しした会話へは書ける', async () => {
    const h = harness();
    h.setConversationId('conv-now');

    await h.call('conversation_post', { conversationId: 'conv-other', text: '別の会話への知らせ' });

    expect(h.posted).toEqual([{ conversationId: 'conv-other', text: '別の会話への知らせ' }]);
  });
});

describe('self_status の台帳の内訳は、打ち切った続きを ledgerCursor で辿れる（#1638 / #1673）', () => {
  const MODEL = 'claude-ledger-offset-model';
  const RUNTIME: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    buildTime: { builtAt: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: MODEL,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: heuristicChars(0),
    systemPromptChars: heuristicChars(0),
    lastContextUsage: null,
  };

  async function seed(h: Harness, count: number, at = '2026-08-14T10:00:00.000Z'): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await h.stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'cumulative',
        managerId: `mgr-${String(i).padStart(3, '0')}`,
        date: '2026-08-14',
        at,
        snapshot: {
          models: {
            [MODEL]: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1 + i,
            },
          },
        },
      });
    }
  }

  async function bump(h: Harness, managerId: string, costUsd: number, at: string): Promise<void> {
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId,
      date: '2026-08-14',
      at,
      snapshot: {
        models: {
          [MODEL]: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd,
          },
        },
      },
    });
  }

  function extractLedgerCursor(reply: string): string {
    const found = reply.match(/self_status の ledgerCursor=([A-Za-z0-9_-]+) で続きが出る/);
    if (!found) throw new Error(`self_status の ledgerCursor が見つからない: ${reply}`);
    return found[1]!;
  }

  it('14件を超えたら、打ち切りの行に ledgerCursor での続きの呼び方を書く', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 15);

    const reply = await h.call('self_status', {});

    expect(reply).toMatch(
      /…（残り 1 件は出していない。self_status の ledgerCursor=[A-Za-z0-9_-]+ で続きが出る）/,
    );
    expect(reply).not.toContain('"mgr-000"');
  });

  it('案内どおり ledgerCursor で呼ぶと、落ちた15件目がその節だけで出る', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 15);

    const first = await h.call('self_status', {});
    const cursor = extractLedgerCursor(first);
    const reply = await h.call('self_status', { ledgerCursor: cursor });

    expect(reply).toContain('（全 15 件）');
    expect(reply).toContain('managerId: "mgr-000"');
    expect(reply).not.toContain('## いまどう走っているか');
    expect(reply).not.toContain('## 記憶の大きさ');
    expect(reply).not.toContain('続きが出る');
  });

  it('1頁に収まらなければ、次の ledgerCursor を案内する', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 120);

    const first = await h.call('self_status', {});
    const cursor = extractLedgerCursor(first);
    const reply = await h.call('self_status', { ledgerCursor: cursor });

    expect(reply).toContain('（全 120 件）');
    expect(reply).toMatch(
      /…（残り 6 件は出していない。self_status の ledgerCursor=[A-Za-z0-9_-]+ で続きが出る）/,
    );
  });

  it('範囲外の ledgerCursor は、黙って空を返さずそう言う', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 3);

    const cursor = encodeUsageCursor({
      axis: 'ledger',
      label: ['mgr-000', 'manager', 'session'].join('\u0000'),
      cost: 1,
    });
    const reply = await h.call('self_status', { ledgerCursor: cursor });

    expect(reply).toContain('ledgerCursor より後ろは無い。これが最後の頁');
  });

  it('壊れた ledgerCursor は断る（黙って先頭へ倒さない）', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 3);

    const reply = await h.call('self_status', { ledgerCursor: '!!!not-a-cursor!!!' });

    expect(reply).toContain('ledgerCursor が壊れている');
    expect(reply).not.toContain('"mgr-000"');
  });

  it('usage_read の axis 用の cursor は self_status の ledgerCursor には使えない', async () => {
    const h = harness(() => RUNTIME);
    await seed(h, 3);

    const wrongContextCursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-000', cost: 1 });
    const reply = await h.call('self_status', { ledgerCursor: wrongContextCursor });

    expect(reply).toContain('別の文脈');
    expect(reply).not.toContain('"mgr-000"');
  });

  it('#1673: 前回の呼び出し以降に記録が増えると、順位が上がった行が別枠で出る', async () => {
    const h = harness(() => RUNTIME);
    const FIRST_CALL_AT = '2026-08-14T10:00:00.000Z';
    await seed(h, 15, FIRST_CALL_AT);

    const first = await h.call('self_status', {});
    const cursor = extractLedgerCursor(first);
    expect(first).not.toContain('"mgr-000"');

    await bump(h, 'mgr-000', 1000, '2026-08-14T11:00:00.000Z');

    const reply = await h.call('self_status', { ledgerCursor: cursor });

    expect(reply).toContain('順位が上がった');
    expect(reply).toContain('managerId: "mgr-000"');
  });

  it('#1719: 前回の呼び出しと同じミリ秒のまま記録が増えると、順位が上がった行が別枠で出る（同着）', async () => {
    const h = harness(() => RUNTIME);
    const FIRST_CALL_AT = '2026-08-14T10:00:00.000Z';
    await seed(h, 15, FIRST_CALL_AT);

    const first = await h.call('self_status', {});
    const cursor = extractLedgerCursor(first);
    expect(first).not.toContain('"mgr-000"');

    await bump(h, 'mgr-000', 1000, FIRST_CALL_AT);

    const reply = await h.call('self_status', { ledgerCursor: cursor });

    expect(reply).toContain('順位が上がった');
    expect(reply).toContain('managerId: "mgr-000"');
  });

  it('記録が増えない場合は、ledgerCursor で複数頁を欠落・重複なく辿れる', async () => {
    const h = harness(() => RUNTIME);
    const total = 250;
    await seed(h, total);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > total) throw new Error('頁が終わらない（無限ループの疑い）');
      const reply = await h.call(
        'self_status',
        cursor === undefined ? {} : { ledgerCursor: cursor },
      );
      expect(reply).not.toContain('順位が上がった');
      for (const m of reply.matchAll(/managerId: "(mgr-\d{3})"/g)) seen.push(m[1]!);
      const next = reply.match(/self_status の ledgerCursor=([A-Za-z0-9_-]+) で続きが出る/);
      if (!next) break;
      cursor = next[1];
    }

    expect(new Set(seen).size).toBe(total);
    expect(seen.length).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });
});

describe('permission_grant_list（読むだけ。HTTP の GET /permission-grants と同じ中身）', () => {
  const grant = (index: number, over: Record<string, unknown> = {}) => {
    const pad = String(index).padStart(2, '0');
    return {
      id: `pg-${pad}`,
      rule: `Bash(echo fake-${pad})`,
      allows: [`echo fake-${pad}`],
      denies: [],
      approvalId: `ap-${pad}`,
      answer: '許可します',
      grantedAt: `2026-01-01T00:00:${pad}.000Z`,
      route: { principalKind: 'account' as const, accountId: 'acct-fake' },
      ...over,
    };
  };

  it('道具として配られ、書き込みの道具（取り消し・消す口）は配られていない', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('permission_grant_list'));
    for (const name of [
      'permission_grant_revoke',
      'permission_grant_remove',
      'permission_grant_remove_unreadable',
    ]) {
      expect(CLONE_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('読める行が出る（有効と取り消し済みの両方。状態つき）', async () => {
    const h = harness();
    await h.stores.permissionGrants.put(grant(1));
    await h.stores.permissionGrants.put(grant(2, { revokedAt: '2026-01-02T00:00:00.000Z' }));

    const reply = await h.call('permission_grant_list', {});

    expect(reply).toMatch(/^- pg-01 有効$/m);
    expect(reply).toMatch(/^- pg-02 取り消し済み$/m);
    expect(reply).toContain('Bash(echo fake-01)');
    expect(reply).toContain('取り消し 2026-01-02T00:00:00.000Z');
  });

  it('読めない行は rowsUnreadable で出る（件数と id・理由。本文は載らない）', async () => {
    const h = harness();
    await h.stores.permissionGrants.put(grant(1));
    h.stores.permissionGrants.listUnreadable = async () => [
      { id: 'pg-bad', reason: 'rule が文字列でない' },
      { reason: 'id も取れない' },
    ];

    const reply = await h.call('permission_grant_list', {});

    expect(reply).toContain(
      'rowsUnreadable: {"count":2,"rows":[{"id":"pg-bad","reason":"rule が文字列でない"}]}',
    );
    expect(reply).toContain('- pg-01 有効');
  });

  it('読めない行しか無いときは「許可が無い」と言わない', async () => {
    const h = harness();
    h.stores.permissionGrants.listUnreadable = async () => [{ id: 'pg-bad', reason: 'x' }];

    const reply = await h.call('permission_grant_list', {});

    expect(reply).toContain('rowsUnreadable');
    expect(reply).toContain('「許可が無い」とは言えない');
    expect(reply).not.toContain('（許可の記録は無い）');
  });

  it('読めない行が0件なら、rowsUnreadable の鍵が無い', async () => {
    const h = harness();
    expect(await h.call('permission_grant_list', {})).not.toContain('rowsUnreadable');
    await h.stores.permissionGrants.put(grant(1));
    expect(await h.call('permission_grant_list', {})).not.toContain('rowsUnreadable');
  });

  it('長い本文でも予算で締まり、切れたら続きの取り方（from）が出る。from で続きが読める', async () => {
    const h = harness();
    const long = 'あ'.repeat(5_000);
    for (let index = 0; index < 40; index += 1) {
      await h.stores.permissionGrants.put(
        grant(index, { rule: `Bash(echo ${long}:*)`, answer: `許可します ${long}` }),
      );
    }

    const reply = await h.call('permission_grant_list', {});

    expect(reply.length).toBeLessThan(10_000);
    expect(reply).toMatch(/…ほか \d+ 件は省略（許可の記録は 40 件あり/);
    const next = /permission_grant_list from=(\d+) で取れる/.exec(reply)?.[1];
    expect(next).toBeDefined();
    const second = await h.call('permission_grant_list', { from: Number(next) });
    expect(second).toContain(`- pg-${String(next).padStart(2, '0')} `);
    expect(second).not.toContain('- pg-00 ');
  });

  it('id を渡すと全文が読め、長ければ offset で続きが読める', async () => {
    const h = harness();
    const long = 'あ'.repeat(10_000);
    await h.stores.permissionGrants.put(grant(1, { answer: `許可します ${long}` }));

    const first = await h.call('permission_grant_list', { id: 'pg-01' });

    expect(first).toContain('Bash(echo fake-01)');
    const offset = /offset=(\d+)/.exec(first)?.[1];
    expect(offset).toBeDefined();
    const second = await h.call('permission_grant_list', { id: 'pg-01', offset: Number(offset) });
    expect(second).toContain('あ');
    expect(second).not.toContain('ここで切れている');
  });
});

describe('account_list（読むだけ。id・許可の状態・時刻だけで、個人の情報は返さない）', () => {
  const EMAIL = 'alice-unique@example.test';
  const NAME = 'Alice Uniquename';
  const at = (day: string, index: number) =>
    `2026-${day}T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
  const account = (index: number, over: Record<string, unknown> = {}) => {
    const pad = String(index).padStart(2, '0');
    return {
      id: `acct-${pad}`,
      displayName: index === 1 ? NAME : `Other Name ${pad}`,
      email: index === 1 ? EMAIL : `other-${pad}@example.test`,
      createdAt: at('01-01', index),
      lastLoginAt: at('02-01', index),
      grantedAt: at('01-02', index),
      grantedBy: 'operator',
      ownerDeclaredAt: null,
      ...over,
    };
  };

  it('道具として配られ、書き込みの道具は配られていない', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('account_list'));
    for (const name of [
      'account_grant',
      'account_revoke',
      'account_remove',
      'account_remove_unreadable',
      'account_set_owner',
    ]) {
      expect(CLONE_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('対照: 載せるべき値（id・状態・時刻・許可した者）は出る', async () => {
    const h = harness();
    await h.stores.auth.putAccount(account(1));
    await h.stores.auth.putAccount(account(2, { grantedAt: null, grantedBy: null }));

    const reply = await h.call('account_list', {});

    expect(reply).toMatch(/^- acct-01 許可済み$/m);
    expect(reply).toMatch(/^- acct-02 未許可$/m);
    expect(reply).toContain('2026-01-01T00:00:01.000Z');
    expect(reply).toContain('2026-02-01T00:00:01.000Z');
    expect(reply).toContain('許可した者: operator');
  });

  it('陰性対照: 一覧・詳細（id 指定）・どの出力にも email と表示名が現れない', async () => {
    const h = harness();
    await h.stores.auth.putAccount(account(1));
    await h.stores.auth.putAccount(account(2));
    const outputs = [
      await h.call('account_list', {}),
      await h.call('account_list', { id: 'acct-01' }),
      await h.call('account_list', { id: 'acct-02' }),
      await h.call('account_list', { id: 'acct-99' }),
      await h.call('account_list', { from: 1 }),
      await h.call('account_list', { from: 99 }),
    ];
    expect(outputs[0]).toContain('acct-01');
    expect(outputs[1]).toContain('acct-01');
    for (const output of outputs) {
      expect(output).not.toContain(EMAIL);
      expect(output).not.toContain('alice-unique');
      expect(output).not.toContain(NAME);
      expect(output).not.toContain('Uniquename');
      expect(output).not.toContain('@example.test');
      expect(output).not.toContain('Other Name');
    }
  });

  it('identity・アクセストークンの値も出ない', async () => {
    const h = harness();
    await h.stores.auth.putAccount(account(1));
    await h.stores.auth.putIdentity({
      provider: 'google',
      subject: 'sub-unique-123',
      accountId: 'acct-01',
      email: EMAIL,
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    });
    const reply = [
      await h.call('account_list', {}),
      await h.call('account_list', { id: 'acct-01' }),
    ].join('\n');
    expect(reply).toContain('acct-01');
    expect(reply).not.toContain('sub-unique-123');
    expect(reply).not.toContain(EMAIL);
  });

  it('読めない行は rowsUnreadable で出る（件数と id・理由。中身は載らない）', async () => {
    const h = harness();
    await h.stores.auth.putAccount(account(1));
    h.stores.auth.listUnreadableAccounts = async () => [
      { id: 'acct-bad', reason: 'createdAt が日時でない' },
      { reason: 'id も取れない' },
    ];

    const reply = await h.call('account_list', {});

    expect(reply).toContain(
      'rowsUnreadable: {"count":2,"rows":[{"id":"acct-bad","reason":"createdAt が日時でない"}]}',
    );
    expect(reply).toContain('- acct-01 許可済み');
  });

  it('読めない行しか無いときは「アカウントが無い」と言わない', async () => {
    const h = harness();
    h.stores.auth.listUnreadableAccounts = async () => [{ id: 'acct-bad', reason: 'x' }];

    const reply = await h.call('account_list', {});

    expect(reply).toContain('rowsUnreadable');
    expect(reply).toContain('「アカウントが無い」とは言えない');
    expect(reply).not.toContain('（アカウントは無い）');
  });

  it('読めない行が0件なら rowsUnreadable の鍵が無い。アカウントが無ければそう言う', async () => {
    const h = harness();
    const empty = await h.call('account_list', {});
    expect(empty).toContain('（アカウントは無い）');
    expect(empty).not.toContain('rowsUnreadable');
    await h.stores.auth.putAccount(account(1));
    expect(await h.call('account_list', {})).not.toContain('rowsUnreadable');
  });

  it('件数が多くても予算で締まり、切れたら from で続きが読める', async () => {
    const h = harness();
    for (let index = 0; index < 80; index += 1) {
      await h.stores.auth.putAccount(
        account(index, {
          createdAt: `2026-01-01T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }),
      );
    }

    const reply = await h.call('account_list', {});

    expect(reply.length).toBeLessThan(10_000);
    expect(reply).toMatch(/…ほか \d+ 件は省略（アカウントは 80 件あり/);
    const next = /account_list from=(\d+) で取れる/.exec(reply)?.[1];
    expect(next).toBeDefined();
    const second = await h.call('account_list', { from: Number(next) });
    expect(second).toContain(`- acct-${String(next).padStart(2, '0')} `);
    expect(second).not.toContain('- acct-00 ');
  });
});

describe('クローンの記憶の全文書き直しは読んだ版を前提にする（#2809）', () => {
  const versionOf = (readResult: string): string => {
    const m = /base_version[=:：]\s*([0-9a-f]{64})/.exec(readResult);
    if (m === null) throw new Error(`memory_read の応答に版が無い: ${readResult}`);
    return m[1]!;
  };

  it('人間が同じ大きさの別の内容に直した後の memory_write は、書かずに「変わった」と返す', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n人間の元の内容AAAA\n');
    const read = await h.call('memory_read', { slug: 'ops' });
    await h.stores.persona.write('ops', '# 運用\n\n人間が直した内容BBB\n');
    await h.stores.persona.markHumanTouched('ops', new Date().toISOString());

    const result = await h.call('memory_write', {
      slug: 'ops',
      content: '# 運用\n\nクローンの書き直しCCCCC\n',
      summary: '書き直し',
      base_version: versionOf(read),
    });

    expect((await h.stores.persona.read('ops'))?.content).toContain('人間が直した内容BBB');
    expect(result).toContain('その間に変わった');
    expect(result).toContain('memory_read');
    expect(await h.stores.journal.list({ types: ['memory_update'] })).toHaveLength(0);
  });

  it('版が合えば書ける（応答に次の版が付き、続けて書ける）', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n初版\n');
    const read = await h.call('memory_read', { slug: 'ops' });
    const first = await h.call('memory_write', {
      slug: 'ops',
      content: '# 運用\n\n二版\n',
      summary: '二版',
      base_version: versionOf(read),
    });
    const second = await h.call('memory_write', {
      slug: 'ops',
      content: '# 運用\n\n三版\n',
      summary: '三版',
      base_version: versionOf(first),
    });
    expect(second).toContain('更新した');
    expect((await h.stores.persona.read('ops'))?.content).toContain('三版');
  });

  it('読んだ後に人間が別内容へ直し、版を持たずに memory_write すると、書かずに memory_read を促す（再現）', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n人間の元AAAA\n');
    await h.call('memory_read', { slug: 'ops' });
    await h.stores.persona.write('ops', '# 運用\n\n人間の内容\n');
    await h.stores.persona.markHumanTouched('ops', new Date().toISOString());
    const result = await h.call('memory_write', {
      slug: 'ops',
      content: '上書き',
      summary: 'x',
    });
    expect((await h.stores.persona.read('ops'))?.content).toContain('人間の内容');
    expect(result).toContain('base_version');
    expect(result).toContain('memory_read');
  });

  it('新規作成は版なしで書けるが、読んだ後に誰かが作っていれば書かない', async () => {
    const h = harness();
    expect(await h.call('memory_write', { slug: 'fresh', content: '新', summary: 'n' })).toContain(
      '更新した',
    );
  });

  it('memory_frontmatter_set は、読んだ後に人間が直していれば書かず、「何も書いていない」と返す', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '---\ndescription: 旧\n---\n# 運用\n\n本文\n');
    const read = await h.call('memory_read', { slug: 'ops' });
    await h.stores.persona.write('ops', '---\ndescription: 人間の要旨\n---\n# 運用\n\n本文\n');
    const result = await h.call('memory_frontmatter_set', {
      slug: 'ops',
      type: 'fact',
      summary: 'd',
      base_version: versionOf(read),
    });
    expect(result).toContain('その間に変わった');
    expect(result).toContain('何も書いていない');
    expect(result).toContain('memory_read');
    const after = (await h.stores.persona.read('ops'))!.content;
    expect(after).toContain('description: 人間の要旨');
    expect(after).not.toContain('type: fact');
  });

  it('memory_frontmatter_set は版なしでは書かず、「何も書いていない」と読み直しを返す', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '---\ndescription: 旧\n---\n# 運用\n');
    const result = await h.call('memory_frontmatter_set', {
      slug: 'ops',
      description: '新',
      summary: 'd',
    });
    expect(result).toContain('何も書いていない');
    expect(result).toContain('base_version');
    expect(result).toContain('memory_read');
    expect((await h.stores.persona.read('ops'))?.content).toContain('description: 旧');
  });

  it('memory_write の断り（版なし・衝突）は「何も書いていない」と言う', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n人間の内容\n');
    const noVersion = await h.call('memory_write', { slug: 'ops', content: 'x', summary: 's' });
    expect(noVersion).toContain('何も書いていない');
    const stale = await h.call('memory_write', {
      slug: 'ops',
      content: 'x',
      summary: 's',
      base_version: 'f'.repeat(64),
    });
    expect(stale).toContain('何も書いていない');
    expect(stale).toContain('その間に変わった');
  });

  it('統合の走行（distill）でも、版が無い・食い違うと断られ、読み直した版を付ければ通る（clone-only の文書）', async () => {
    const h = harness();
    await h.stores.persona.write('notes', '# 覚え書き\n\n初版\n');
    h.setMemoryCause('distill');

    const noVersion = await h.call('memory_write', {
      slug: 'notes',
      content: '# 覚え書き\n\n蒸留の版\n',
      summary: '蒸留',
    });
    expect(noVersion).toContain('memory_read');
    expect(noVersion).toContain('base_version');
    expect(noVersion).toContain('何も書いていない');

    const read = await h.call('memory_read', { slug: 'notes' });
    await h.stores.persona.write('notes', '# 覚え書き\n\n別ターンの追記\n');
    const stale = await h.call('memory_write', {
      slug: 'notes',
      content: '# 覚え書き\n\n蒸留の版\n',
      summary: '蒸留',
      base_version: versionOf(read),
    });
    expect(stale).toContain('その間に変わった');
    expect(stale).toContain('memory_read');
    expect(stale).toContain('base_version');
    expect(stale).toContain('何も書いていない');
    expect((await h.stores.persona.read('notes'))?.content).toContain('別ターンの追記');

    const reread = await h.call('memory_read', { slug: 'notes' });
    const ok = await h.call('memory_write', {
      slug: 'notes',
      content: '# 覚え書き\n\n別ターンの追記\n蒸留の版\n',
      summary: '蒸留',
      base_version: versionOf(reread),
    });
    expect(ok).toContain('更新した');
    expect((await h.stores.persona.read('notes'))?.content).toContain('蒸留の版');
  });

  it('memory_section_move は、出どころを読んでから切り取るまでの間に変わっていれば切り取らない（重複は失われない側）', async () => {
    const h = harness();
    await h.stores.persona.write('src', '# 親\n\n## 動かす\n\n事例\n\n## 残す\n\n元の残す節\n');
    const { sections } = scanMemorySections((await h.stores.persona.read('src'))!.content);
    const target = sections.find((x) => x.heading.includes('動かす'))!;
    const realRead = h.stores.persona.read.bind(h.stores.persona);
    let first = true;
    h.stores.persona.read = async (slug: string) => {
      const doc = await realRead(slug);
      if (first && slug === 'src') {
        first = false;
        await h.stores.persona.write(
          'src',
          '# 親\n\n## 動かす\n\n事例\n\n## 残す\n\n人間が直した節\n',
        );
      }
      return doc;
    };
    const result = await h.call('memory_section_move', {
      fromSlug: 'src',
      sections: [target.id],
      toSlug: 'dst',
      summary: '移す',
    });
    expect(result).toContain('その間に変わった');
    expect(result).toContain('重複しているが、失われてはいない');
    expect(result).not.toContain('何も書いていない');
    expect((await h.stores.persona.read('dst'))?.content).toContain('事例');
    expect((await h.stores.persona.read('src'))?.content).toContain('人間が直した節');
  });
});

describe('クローンの記憶の削除は読んだ版を前提にする（#2881）', () => {
  const versionOf = (readResult: string): string => {
    const m = /base_version[=:：]\s*([0-9a-f]{64})/.exec(readResult);
    if (m === null) throw new Error(`memory_read の応答に版が無い: ${readResult}`);
    return m[1]!;
  };

  it('読んだ後に人間が直した記憶を、版付きの memory_delete は消さずに「変わった」と返す（再現）', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n元の内容\n');
    const read = await h.call('memory_read', { slug: 'ops' });
    await h.stores.persona.write('ops', '# 運用\n\n人間が直した内容\n');

    const result = await h.call('memory_delete', {
      slug: 'ops',
      summary: '整理',
      base_version: versionOf(read),
    });

    expect((await h.stores.persona.read('ops'))?.content).toContain('人間が直した内容');
    expect(result).toContain('その間に変わった');
    expect(result).toContain('何も消していない');
    expect(result).toContain('memory_read');
    expect(await h.stores.journal.list({ types: ['memory_update'] })).toHaveLength(0);
  });

  it('版を持たない memory_delete は、消さずに memory_read を促す（何も消していない）', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n内容\n');
    const result = await h.call('memory_delete', { slug: 'ops', summary: '整理' });
    expect(await h.stores.persona.read('ops')).not.toBeNull();
    expect(result).toContain('base_version');
    expect(result).toContain('memory_read');
    expect(result).toContain('何も消していない');
  });

  it('版が合えば消せる', async () => {
    const h = harness();
    await h.stores.persona.write('ops', '# 運用\n\n内容\n');
    const read = await h.call('memory_read', { slug: 'ops' });
    const result = await h.call('memory_delete', {
      slug: 'ops',
      summary: '整理',
      base_version: versionOf(read),
    });
    expect(result).toContain('消した');
    expect(await h.stores.persona.read('ops')).toBeNull();
  });
});
