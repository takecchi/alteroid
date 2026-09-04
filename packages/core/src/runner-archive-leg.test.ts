import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { captureStderr } from './testing.js';

/**
 * **`#shipArchive()` が `report` / `ask` と同じ1本の脚（`this.#emit`）を通る
 * ことを、実物の呼び出しで固定する歯（#634。PR #628 が範囲外として指した
 * 穴の対応）。**
 *
 * `runner.ts` の `Host` は `emit: (event) => void` を1つだけコンストラクタで
 * 受け取り（`readonly #emit`）、`report` / `ask` / `archive` を含む全種別が
 * そのフィールドを通じて呼び出し側へ渡る。**ここでは grep で「`this.#emit(`
 * が何箇所にあるか」を数えない**——実際にセッションを起こし、`report` を
 * 生む経路（`say()` → `stop()` の `#flushUnreported`）、`ask` を生む経路
 * （`canUseTool` からの確認）、`archive` を生む経路（`PostToolUse` フックで
 * `transcript_path` を控えてから `stop()`）の3つを順に踏んで、**同じ1つの
 * 配列（`emit` がそのまま積む先）に3種とも積まれることを見る**。
 */

interface FakeSession {
  options: Options;
  say(text: string): Promise<void>;
  askPermission(toolName: string, requestId: string): Promise<PermissionResult>;
  postToolUse(input: unknown): Promise<unknown>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let finish: (() => void) | null = null;
    let emitMessage: ((message: SDKMessage) => void) | null = null;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage) => {
      if (emitMessage) {
        const resolve = emitMessage;
        emitMessage = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    };

    const session: FakeSession = {
      options,
      async say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-archive-leg',
          uuid: `uuid-say-${text}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async askPermission(toolName, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const result = await canUseTool(toolName, { command: 'rm -rf /' }, {
          signal: new AbortController().signal,
          requestId,
          toolUseID: `tool-${requestId}`,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-archive-leg',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emitMessage = resolve;
          finish = () => resolve(null);
        });
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-archive-leg-'));
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  rmSync(dir, { recursive: true, force: true });
});

describe('#shipArchive() は report / ask と同じ1本の脚（emit）を通る（#634）', () => {
  it('report・ask・archive の3種が、同じ emit 呼び出し列へ積まれる', async () => {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-leg-test',
      workspacePath: '/work/project',
      // **ここが「1本の脚」そのものである。** report/ask/archive、どれもこの
      // 1つの関数を通る以外に外へ出る経路を持たない。
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-archive-leg', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    // --- ask: canUseTool 経由の確認を1件起こす（settle はしない——中断で自然に解ける） ---
    const askPromise = session.askPermission('Bash', 'req-1');

    // --- report: 本文を1つ喋っておく（result を待たずに畳んで #flushUnreported を踏む） ---
    await session.say('archive-leg のための本文');

    // --- archive: PostToolUse フックへ transcript_path を渡して控えさせる ---
    const transcriptPath = join(dir, 'transcript.jsonl');
    const archivedBody = '要約に潰される前の生ログ（archive-leg テスト）';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });

    // stop() が #shipArchive() と #flushUnreported の両方を踏む
    // （`stop()` の doc — 器の入れ替えと manager_stop はここを通る）。
    await host.stop('mgr-archive-leg');
    // canUseTool の Promise は stop() の #settleAll で deny 解決される。
    await askPromise;

    const types = events.map((event) => event.type);
    expect(types).toContain('report');
    expect(types).toContain('ask');
    expect(types).toContain('archive');

    const archiveEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    );
    expect(archiveEvent?.managerId).toBe('mgr-archive-leg');
    expect(archiveEvent?.body).toBe(archivedBody);

    const reportEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'report' }> => event.type === 'report',
    );
    expect(reportEvent?.managerId).toBe('mgr-archive-leg');
    expect(reportEvent?.text).toContain('archive-leg のための本文');

    const askEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'ask' }> => event.type === 'ask',
    );
    expect(askEvent?.managerId).toBe('mgr-archive-leg');
  });

  it('#shipArchive() は transcript_path を一度も受け取っていないとき何も emit しない（既存挙動）が、跡は残す', async () => {
    const events: RunnerEvent[] = [];
    const { fn } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-leg-empty-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    // transcript_path を一度も渡さない — #readTranscript() は
    // { status: 'no-path' } を返すので #shipArchive() は archive を出さずに
    // 戻る（`runner.ts` の該当 doc）。**この歯は残す**（archive を出さないのは
    // 正しい）。足すのは、同じ回に「path を一度も受け取っていない」という跡が
    // stderr へ出ること——`no-path` と「読めたが本文が0文字」（もう1本の
    // テスト）は「次の一手」が違うので、同じ沈黙にしない。
    const lines = await captureStderr(async () => {
      await host.start({ managerId: 'mgr-archive-empty', request: '調べて', cwd: '/work/project' });
      await host.stop('mgr-archive-empty');
    });

    expect(events.some((event) => event.type === 'archive')).toBe(false);
    const noted = lines.filter((line) => line.includes('生ログ'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('の取得元を一度も受け取っていません');
    expect(noted[0]).toContain('managerId=mgr-archive-empty');
    // **本文は乗らない**（`noteMissingRecordSource` の doc、#52 と同じ理由）。
    expect(noted[0]).not.toContain('調べて');
  });

  it('#shipArchive() は transcript_path はあるが読めないとき、archive を emit せず「読めなかった」の跡を残す', async () => {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-leg-unreadable-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({
      managerId: 'mgr-archive-unreadable',
      request: '調べて',
      cwd: '/work/project',
    });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    // path は在るが、実際には存在しないファイルを指す — readFile が投げる側
    // （`#readTranscript` の `unreadable`）。`no-path`（上のテスト）とは別の
    // 状況であることを、同じ管理で区別できることを見る。
    const missingPath = join(dir, 'does-not-exist.jsonl');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: missingPath,
    });

    const lines = await captureStderr(async () => {
      await host.stop('mgr-archive-unreadable');
    });

    expect(events.some((event) => event.type === 'archive')).toBe(false);
    const noted = lines.filter((line) => line.includes('生ログ'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('生ログを読み出せませんでした');
    expect(noted[0]).toContain('managerId=mgr-archive-unreadable');
    // `no-path` の文言（「取得元を一度も受け取っていません」）とは別の文言である
    // ことも見ておく——同じ文に潰していないことの確認。
    expect(noted[0]).not.toContain('取得元を一度も受け取っていません');
  });

  it('#shipArchive() は読めたが本文が0文字のとき、正常として何も跡を出さない（この PR の判断）', async () => {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-leg-blank-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-archive-blank', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    // path は在り、実際に読める——ただし中身が0文字（「何も書かれていない
    // セッション」）。`no-path` / `unreadable` とは違い、次の一手が要らない
    // 状態なので、跡を出さない（PR 本文にこの判断とその理由を書く）。
    const blankPath = join(dir, 'blank-transcript.jsonl');
    writeFileSync(blankPath, '', 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: blankPath,
    });

    const lines = await captureStderr(async () => {
      await host.stop('mgr-archive-blank');
    });

    expect(events.some((event) => event.type === 'archive')).toBe(false);
    expect(lines.some((line) => line.includes('生ログ'))).toBe(false);
  });
});
