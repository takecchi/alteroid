import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerRequestQueue } from './runner-request-queue.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession` が `RunnerRequestQueue` へ口を渡す所（コンストラクタ）と、呼び元 2 か所（`#onPermission`・`#onPermissionDenied`）が
// `queueRequest` を呼ぶ所を、`runner-queue-request-pin.test.ts` が縛れない側から縛る。
// 協力者を、構築と呼び出しを横から控える薄い派生に差し替える（本体は本物。控えるだけで挙動は変えない）。
// - 口は 6 本で、`pending`・`resolved`・`sdkSession` は `RunnerSession` が持つ本物の参照（写していない）。
//   別の器・写し（`[...pending]` など）を渡すと、`state().waiting`・再送の判定・`state().status` が口を通した変更を見られず赤くなる。
// - 関数の口（`emit`・`deliverPeerNotices`）は `async` で包まない（戻りが Promise でない）。`decideAnswer` は口ではなく、
//   `RunnerRequestQueue` が `runner-decide-answer.ts` から直に import する（結果の縛りは pin と `runner-request-queue.test.ts`）。
// - 呼び元 2 か所は、`queueRequest` を 1 回ずつ同期で呼び、戻りの `result`・`answered` をそのまま使う（呼び元の周回数は pin が縛る）。
// 実時間では待たない。

interface Captured {
  ports: Record<string, unknown>[];
  specs: Record<string, unknown>[];
  returned: { result: Promise<unknown>; answered: Promise<unknown> }[];
}

const captured = vi.hoisted((): Captured => ({ ports: [], specs: [], returned: [] }));

vi.mock('./runner-request-queue.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runner-request-queue.js')>();
  class Spy extends original.RunnerRequestQueue {
    constructor(ports: ConstructorParameters<typeof original.RunnerRequestQueue>[0]) {
      super(ports);
      captured.ports.push(ports as unknown as Record<string, unknown>);
    }

    override queueRequest(
      spec: Parameters<RunnerRequestQueue['queueRequest']>[0],
    ): ReturnType<RunnerRequestQueue['queueRequest']> {
      captured.specs.push(spec as unknown as Record<string, unknown>);
      const out = super.queueRequest(spec);
      captured.returned.push(out);
      return out;
    }
  }
  return { ...original, RunnerRequestQueue: Spy };
});

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: { options: Options }[] } {
  const started: { options: Options }[] = [];
  const fn = ((input: { options: Options }) => {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    started.push({ options: input.options });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await closed;
    }
    return Object.assign(generate(), {
      close: () => release?.(),
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-request-queue-wiring-');
  captured.ports.length = 0;
  captured.specs.length = 0;
  captured.returned.length = 0;
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open() {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const options = started[0]?.options;
  if (options === undefined) throw new Error('セッションが開いていない');
  return { host, events, options };
}

function ports(): Record<string, unknown> {
  expect(captured.ports).toHaveLength(1);
  return captured.ports[0] as Record<string, unknown>;
}

describe('口の渡し方', () => {
  it('セッション 1 本につき 1 つ作り、口は 6 本（名前を固定する）', async () => {
    await open();
    expect(Object.keys(ports()).sort()).toMatchInlineSnapshot(`
      [
        "deliverPeerNotices",
        "emit",
        "managerId",
        "pending",
        "resolved",
        "sdkSession",
      ]
    `);
  });

  it('managerId は値（セッションの id）', async () => {
    await open();
    expect(ports().managerId).toBe('mgr-1');
  });

  it('pending は参照: 口の配列を直に変えると、state().waiting がそのまま映す（写しでない）', async () => {
    const rig = await open();
    const pending = ports().pending as { id: string }[];
    pending.push({
      id: 'injected',
      kind: 'permission',
      summary: '外から差した',
      askedAt: '2026-10-20T00:00:00.000Z',
    } as never);
    expect(rig.host.list()[0]?.waiting.map((entry) => entry.requestId)).toEqual(['injected']);
    pending.splice(0);
    expect(rig.host.list()[0]?.waiting).toEqual([]);
  });

  it('resolved は参照: 口へ set した結果を、同じ id の再送が返す（別の器だと、再送が新しい確認になる）', async () => {
    const rig = await open();
    (ports().resolved as { set: (id: string, value: unknown) => void }).set('seeded', {
      behavior: 'deny',
      message: '覚えさせた',
    });
    const canUseTool = rig.options.canUseTool;
    const value = await canUseTool?.('Bash', { command: 'echo' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu',
      requestId: 'seeded',
    } as never);
    expect(value).toMatchInlineSnapshot(`
      {
        "behavior": "deny",
        "message": "覚えさせた",
      }
    `);
    expect(rig.events.filter((event) => event.type === 'ask')).toEqual([]);
  });

  it('sdkSession は参照: 口の setStatus が、state().status に映る（値へ写していない）', async () => {
    const rig = await open();
    const sdk = ports().sdkSession as { setStatus: (status: string) => void; status: string };
    sdk.setStatus('waiting_human');
    expect(rig.host.list()[0]?.status).toBe('waiting_human');
    expect(sdk.status).toBe('waiting_human');
    sdk.setStatus('running');
    expect(rig.host.list()[0]?.status).toBe('running');
  });

  it('emit は同期で、降ろした出来事が runner の emit に届く。戻りは Promise でない', async () => {
    const rig = await open();
    const emit = ports().emit as (event: RunnerEvent) => unknown;
    const before = rig.events.length;
    const returned = emit({ type: 'note', managerId: 'mgr-1', text: '口から' } as RunnerEvent);
    expect(returned).toBeUndefined();
    expect(rig.events.length).toBe(before + 1);
    expect(rig.events.at(-1)).toMatchObject({ type: 'note', text: '口から' });
  });

  it('deliverPeerNotices は同期で、戻りは Promise でない', async () => {
    await open();
    expect((ports().deliverPeerNotices as () => unknown)()).toBeUndefined();
  });
});

describe('呼び元 2 か所', () => {
  it('canUseTool（#onPermission）: queueRequest を 1 回呼び、spec は kind・signal・abortAnswer を持ち onAbort は持たない。戻りの result をそのまま返す', async () => {
    const rig = await open();
    const controller = new AbortController();
    const called = rig.options.canUseTool?.('Bash', { command: 'echo' }, {
      signal: controller.signal,
      toolUseID: 'tu',
      requestId: 'req-w',
    } as never);
    expect(captured.specs).toHaveLength(1);
    const spec = captured.specs[0] ?? {};
    expect({
      keys: Object.keys(spec),
      id: spec.id,
      kind: spec.kind,
      input: spec.input,
      source: spec.source,
      signalIsGiven: spec.signal === controller.signal,
      abortAnswer: spec.abortAnswer,
      hasOnAbort: 'onAbort' in spec,
    }).toMatchInlineSnapshot(`
      {
        "abortAnswer": {
          "aborted": true,
          "decision": "deny",
          "message": "マネージャー側で中断された。",
        },
        "hasOnAbort": false,
        "id": "req-w",
        "input": {
          "command": "echo",
        },
        "keys": [
          "id",
          "kind",
          "summary",
          "askedAt",
          "input",
          "source",
          "signal",
          "abortAnswer",
        ],
        "kind": "permission",
        "signalIsGiven": true,
        "source": undefined,
      }
    `);
    controller.abort();
    await called;
    expect(captured.returned).toHaveLength(1);
  });

  it('PermissionDenied フック（#onPermissionDenied）: queueRequest を 1 回呼び、spec は input が空・onAbort を持つ。戻りの answered と result の両方を使う', async () => {
    const rig = await open();
    const controller = new AbortController();
    const fn = rig.options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
    if (fn === undefined) throw new Error('PermissionDenied フックが無い');
    const raw = fn(
      {
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_use_id: 'tu-hook',
        reason: '理由',
      } as never,
      undefined,
      { signal: controller.signal },
    );
    expect(captured.specs).toHaveLength(1);
    const spec = captured.specs[0] ?? {};
    expect({
      keys: Object.keys(spec),
      id: spec.id,
      kind: spec.kind,
      input: spec.input,
      source: spec.source,
      signalIsGiven: spec.signal === controller.signal,
      abortAnswer: spec.abortAnswer,
      onAbort: typeof spec.onAbort,
    }).toMatchInlineSnapshot(`
      {
        "abortAnswer": {
          "aborted": true,
          "decision": "deny",
          "message": "フックの持ち時間が尽きたので、安全側でこの1回だけの許可は出さない。",
        },
        "id": "tu-hook",
        "input": {},
        "keys": [
          "id",
          "kind",
          "summary",
          "askedAt",
          "input",
          "source",
          "signal",
          "abortAnswer",
          "onAbort",
        ],
        "kind": "permission",
        "onAbort": "function",
        "signalIsGiven": true,
        "source": undefined,
      }
    `);
    await rig.host.answer('mgr-1', { requestId: 'tu-hook', message: 'ok', decision: 'allow' });
    await raw;
    // 呼び元は戻りの 2 つの Promise を実際に待った: どちらも解けている
    const [out] = captured.returned;
    expect(await out?.answered).toMatchObject({ message: 'ok' });
    expect(await out?.result).toEqual({ behavior: 'allow' });
  });

  it('呼び元の周回数: 答えてから canUseTool / フックが解けるまでの周回（観測用の then が 1 周足されるので、pin の 3 / 10 に 1 を足した 4 / 11）', async () => {
    const rig = await open();
    const lapsUntil = async (done: () => boolean): Promise<number> => {
      let laps = 0;
      while (!done() && laps < 40) {
        await Promise.resolve();
        laps += 1;
      }
      return laps;
    };
    let permissionDone = false;
    void rig.options
      .canUseTool?.('Bash', { command: 'echo' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu',
        requestId: 'lap-1',
      } as never)
      ?.then(() => {
        permissionDone = true;
      });
    const answering = rig.host.answer('mgr-1', {
      requestId: 'lap-1',
      message: 'ok',
      decision: 'allow',
    });
    const permissionLaps = await lapsUntil(() => permissionDone);
    await answering;

    const fn = rig.options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
    if (fn === undefined) throw new Error('PermissionDenied フックが無い');
    let hookDone = false;
    void Promise.resolve(
      fn(
        {
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
          tool_use_id: 'lap-2',
          reason: '理由',
        } as never,
        undefined,
        { signal: new AbortController().signal },
      ),
    ).then(() => {
      hookDone = true;
    });
    const answeringHook = rig.host.answer('mgr-1', {
      requestId: 'lap-2',
      message: 'ok',
      decision: 'allow',
    });
    const hookLaps = await lapsUntil(() => hookDone);
    await answeringHook;
    await tick();
    expect({ permissionLaps, hookLaps }).toMatchInlineSnapshot(`
      {
        "hookLaps": 11,
        "permissionLaps": 4,
      }
    `);
  });
});
