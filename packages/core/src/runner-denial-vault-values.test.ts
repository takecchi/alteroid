import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

interface Started {
  options: Options;
  finish: () => void;
  /** 保留中の `emit` が無ければバッファへ積む: 素の resolve だけでは、押した直後に読まれる保証が無く取りこぼす。 */
  push: (message: SDKMessage) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
    };
    started.push(record);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => record.finish(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

async function firePostToolUseFailure(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const PRE_TOOL_USE_BASE = { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1' };

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
type PermissionDeniedEvent = Extract<RunnerEvent, { type: 'permission_denied' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 実機の SDK が送ってくる形（`tool_input` を持たない）で作る。 */
function liveDenialAsSdkSends(tool: string, toolUseId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_use_id: toolUseId,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-${toolUseId}`,
  } as unknown as SDKMessage;
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-denial-vault-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

// 名前が TOKEN 等の決まりに合わず、8字以上24字未満の英数字混在でもない塊（ダミー）
const VAULT_VALUE = 'Pa55w0rd-xyz1234';

async function startWithVault(): Promise<{ started: Started; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  const credentials = createCredentialStore({
    dir: join(dir, 'creds'),
    seed: { DB_PASS: VAULT_VALUE },
    names: ['DB_PASS'],
  });
  await credentials.flush();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: DENY_ENV,
    credentials,
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  return { started: first, events };
}

function denialOf(events: readonly RunnerEvent[]): PermissionDeniedEvent | undefined {
  return events.find((event): event is PermissionDeniedEvent => event.type === 'permission_denied');
}

describe('inputHead — 資格の正本の値は名前によらず伏せる（issue #4829）', () => {
  it('名前の決まりに合わない正本の値が、値だけで現れても inputHead に出ない', async () => {
    const { started, events } = await startWithVault();
    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: `echo ${VAULT_VALUE} | psql -h db` },
    });
    started.push(liveDenialAsSdkSends('Bash', 'tu-1'));
    await tick();

    const head = denialOf(events)?.inputHead;
    expect(head).toBeDefined();
    expect(head).not.toContain(VAULT_VALUE);
    // 対照: 値以外の部分は残る
    expect(head).toContain('psql -h db');
  });

  it('担い手の道具の失敗の文（note）でも、正本の値を伏せる', async () => {
    const { started, events } = await startWithVault();
    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-2',
      agent_id: 'worker-1',
      error: `psql: password ${VAULT_VALUE} rejected by db`,
    });
    await tick();

    const failures = noteEvents(events).filter((note) => note.text.includes('道具=Bash'));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.text).not.toContain(VAULT_VALUE);
    // 対照: 値以外の部分は残る
    expect(failures[0]?.text).toContain('rejected by db');
  });
});
