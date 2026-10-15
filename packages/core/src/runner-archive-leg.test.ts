import { writeFileSync } from 'node:fs';
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

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { captureStderr } from './testing.js';

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
  dir = makeTempDirSync('alteroid-archive-leg-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('#shipArchive() は report / ask と同じ1本の脚（emit）を通る（#634）', () => {
  it('report・ask・archive の3種が、同じ emit 呼び出し列へ積まれる', async () => {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-leg-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-archive-leg', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    const askPromise = session.askPermission('Bash', 'req-1');

    await session.say('archive-leg のための本文');

    const transcriptPath = join(dir, 'transcript.jsonl');
    const archivedBody = '要約に潰される前の生ログ（archive-leg テスト）';
    writeFileSync(transcriptPath, archivedBody, 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });

    await host.stop('mgr-archive-leg');
    await askPromise;

    const types = events.map((event) => event.type);
    expect(types).toContain('report');
    expect(types).toContain('ask');
    expect(types).toContain('archive');

    const archiveEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    );
    expect(archiveEvent?.managerId).toBe('mgr-archive-leg');
    // 本文は SSE に載せず預ける（#4485）。預かりから同じ本文が読める
    expect(archiveEvent?.body).toBeUndefined();
    expect(host.readArchive('mgr-archive-leg', archiveEvent?.ref?.id ?? '')).toBe(archivedBody);

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

    const lines = await captureStderr(async () => {
      await host.start({ managerId: 'mgr-archive-empty', request: '調べて', cwd: '/work/project' });
      await host.stop('mgr-archive-empty');
    });

    expect(events.some((event) => event.type === 'archive')).toBe(false);
    const noted = lines.filter((line) => line.includes('生ログ'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('の取得元を一度も受け取っていません');
    expect(noted[0]).toContain('managerId=mgr-archive-empty');
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

// 2026-10-12T03:20Z、6〜35MB の archive の出来事が SSE の1行で届き、デーモンのループが 1.2〜1.4 秒ずつ塞がった（#4485）
describe('参照で受け取れるデーモンには、退避の本文を SSE に載せず預ける（#4485）', () => {
  const BODY = '大きな生ログ（参照で運ぶ）';

  async function shipWith(accepts: boolean | undefined) {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-ref-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);
    if (accepts !== undefined) host.setDaemonAcceptsArchiveRef(accepts);
    await host.start({ managerId: 'mgr-archive-ref', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');
    const transcriptPath = join(dir, 'ref-transcript.jsonl');
    writeFileSync(transcriptPath, BODY, 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    await host.stop('mgr-archive-ref');
    const archive = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    );
    return { host, archive };
  }

  it('名乗ったデーモンには参照（id と文字数）だけを送り、本文は預かりから読め、消せば読めない', async () => {
    const { host, archive } = await shipWith(true);
    expect(archive?.body).toBeUndefined();
    expect(archive?.ref?.chars).toBe(BODY.length);
    const id = archive?.ref?.id ?? '';
    expect(host.readArchive('mgr-archive-ref', id)).toBe(BODY);
    // 別の委譲の id としては読めない
    expect(host.readArchive('mgr-other', id)).toBeUndefined();
    host.deleteArchive('mgr-archive-ref', id);
    expect(host.readArchive('mgr-archive-ref', id)).toBeUndefined();
  });

  // 2026-10-13T16:54Z、名乗りを覚えていない回に 155MB の本文が SSE の1行で届き、デーモンのループが 3.8 秒塞がった
  // （ヒープ 1722/1759MB）。名乗りの有無に関わらず、本文は SSE に載せない（#4485）
  it('名乗りを覚えていない回も、本文は SSE に載せずに預けて参照を送り、そのことを stderr に残す', async () => {
    for (const accepts of [undefined, false]) {
      let shipped: Awaited<ReturnType<typeof shipWith>> | undefined;
      const lines = await captureStderr(async () => {
        shipped = await shipWith(accepts);
      });
      const archive = shipped?.archive;
      expect(archive?.body).toBeUndefined();
      expect(archive?.ref?.chars).toBe(BODY.length);
      expect(shipped?.host.readArchive('mgr-archive-ref', archive?.ref?.id ?? '')).toBe(BODY);
      expect(lines.some((line) => line.includes('参照を受けると名乗っていない'))).toBe(true);
      // 本文は stderr にも出さない
      expect(lines.some((line) => line.includes(BODY))).toBe(false);
    }
  });
});

// 器の入れ替えの直前に預けた退避を、デーモンが取りに行った時には新しいプロセスに無く、生ログが失われた（#4896）
describe('畳むとき、取られていない預けた退避を待ち、取られなければ本文を載せて送る（#4896）', () => {
  const BODY = '畳む前に預けた生ログ';

  async function stashedBeforeShutdown() {
    const events: RunnerEvent[] = [];
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-archive-shutdown-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
    });
    hosts.push(host);
    host.setDaemonAcceptsArchiveRef(true);
    await host.start({ managerId: 'mgr-archive-sd', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');
    const transcriptPath = join(dir, 'sd-transcript.jsonl');
    writeFileSync(transcriptPath, BODY, 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });
    // 畳む前に預ける（stop は畳み始める前の経路）
    await host.stop('mgr-archive-sd');
    const ref = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    )?.ref;
    if (ref === undefined) throw new Error('参照が出ていない');
    return { host, events, id: ref.id };
  }

  it('⭐ 畳む前に預けて、まだ取られていない退避は、畳み始めから待ちに入り、取られると外れる', async () => {
    const { host, id } = await stashedBeforeShutdown();
    expect(host.pendingPickups()).toBe(0);

    await host.shutdown();
    expect(host.pendingPickups()).toBe(1);

    host.deleteArchive('mgr-archive-sd', id);
    expect(host.pendingPickups()).toBe(0);
  });

  it('⭐ 取られなかった退避は、本文を載せて送り直し、待ちと預かりから外す', async () => {
    const { host, events, id } = await stashedBeforeShutdown();
    await host.shutdown();

    expect(host.inlineUnpickedArchives()).toBe(1);

    const inlined = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> =>
        event.type === 'archive' && event.body !== undefined,
    );
    expect(inlined).toHaveLength(1);
    expect(inlined[0]?.body).toBe(BODY);
    expect(inlined[0]?.managerId).toBe('mgr-archive-sd');
    // 元の id を載せる: デーモンが参照と突き合わせて二重を防ぐため（#4899）
    expect(inlined[0]?.id).toBe(id);
    expect(host.pendingPickups()).toBe(0);
    expect(host.readArchive('mgr-archive-sd', id)).toBeUndefined();
    // 二度は送らない
    expect(host.inlineUnpickedArchives()).toBe(0);
  });

  it('畳む前にデーモンが取り終えた退避は、待たず、送り直しもしない', async () => {
    const { host, events, id } = await stashedBeforeShutdown();
    host.deleteArchive('mgr-archive-sd', id);

    await host.shutdown();

    expect(host.pendingPickups()).toBe(0);
    expect(host.inlineUnpickedArchives()).toBe(0);
    expect(events.some((event) => event.type === 'archive' && event.body !== undefined)).toBe(
      false,
    );
  });

  it('⭐ 取り終えた（GET 済み）が DELETE が落ちた退避は、畳みで待たず、送り直さない（取られていないものは上の2件のとおり待って送り直す。#4899）', async () => {
    const { host, events, id } = await stashedBeforeShutdown();
    host.markArchiveFetched('mgr-archive-sd', id);
    // DELETE は呼ばれない: 本文は預かりに残る
    expect(host.readArchive('mgr-archive-sd', id)).toBe(BODY);

    await host.shutdown();
    expect(host.pendingPickups()).toBe(0);
    expect(host.inlineUnpickedArchives()).toBe(0);
    expect(events.some((event) => event.type === 'archive' && event.body !== undefined)).toBe(
      false,
    );
  });
});
