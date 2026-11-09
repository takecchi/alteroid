import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession#onStop`（Stop フックの観測。`#stopTaskOwnerKind`・`#renderStopTaskLine`・`#noteStopIdle` を含む）を、外から見える結果だけで縛る。
// `runner-stop.test.ts` が `toContain` で縛っていない所を足す: note の全文（0 件の回・在り高の回の全欄・stop_hook_active の 3 通り・
// 所有者 5 種と status 3 種の内訳・⚠️ 行の出る／出ない）・上限（1_500 文字）で切れる長い行・`readError` の枝・`note` が投げたときの握り方
// （本文／失敗の note／失敗の note も投げる）・通算が毎回進むこと・`#markProgressed` を呼ばないこと（resume の作り直しで観測）・
// フックを呼んだ直後（await なし）に note が出ていることと、フックの戻りまでの周回数。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回と、resume の観測の `vi.waitFor` だけ）。

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
  finish: () => void;
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
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-stop-pin-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
}

async function open(options: { throwOn?: (event: RunnerEvent) => boolean } = {}): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (options.throwOn?.(event) === true) throw new Error('emit が落ちた（テスト用）');
    },
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  // 起動までに出た出来事は見ない
  events.length = 0;
  return { started: first, events };
}

function hookOf(rig: Rig, name: 'Stop' | 'PostToolUse') {
  const hook = rig.started.options.hooks?.[name]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook;
}

function fireStop(rig: Rig, input: Record<string, unknown>): Promise<HookJSONOutput> {
  // `input` は展開せずそのまま渡す（getter が投げる入力を、展開でテスト側が先に読んでしまわないため）
  return hookOf(rig, 'Stop')(input as never, undefined, {
    signal: new AbortController().signal,
  });
}

async function registerBackgroundTask(rig: Rig, taskId: string, agentId?: string): Promise<void> {
  await hookOf(rig, 'PostToolUse')(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 90', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
      ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

const stopNotes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  events.filter(
    (event): event is NoteEvent => event.type === 'note' && event.text.startsWith('Stop'),
  );

/** note の全文だけ（欄は `escalate`／`stall`／`notifyClone` が無いことも一緒に見る）。 */
function viewNotes(events: readonly RunnerEvent[]): unknown[] {
  return stopNotes(events).map((note) => {
    const extraKeys = Object.keys(note).filter(
      (key) => key !== 'type' && key !== 'managerId' && key !== 'text',
    );
    return extraKeys.length === 0 ? note.text : { text: note.text, extraKeys };
  });
}

function shell(id: string, status = 'running', extra: Record<string, unknown> = {}) {
  return { id, type: 'shell', status, description: '背景のシェル', command: 'sleep 90', ...extra };
}

/** 投げるのは、条件に当たった最初の 1 回だけ（その出来事は `events` に積んだ後で投げる）。 */
function throwOnce(predicate: (event: RunnerEvent) => boolean): (event: RunnerEvent) => boolean {
  let thrown = false;
  return (event) => {
    if (thrown || !predicate(event)) return false;
    thrown = true;
    return true;
  };
}

const isStopNote = (event: RunnerEvent): boolean =>
  event.type === 'note' && event.text.startsWith('Stop');

describe('在り高が 0 の回（#noteStopIdle の全文）', () => {
  it('1 回目の note の全文。2 回目以降は出ない', async () => {
    const rig = await open();
    await fireStop(rig, { stop_hook_active: false, background_tasks: [], session_crons: [] });
    await fireStop(rig, { stop_hook_active: false, background_tasks: [], session_crons: [] });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop: マネージャーのターンが閉じたが、**背景処理も session_crons も 0件 だった**（このセッションで通算 1回目の発火）。⟹ SDK の言う「session is done」の側である。**この行が出たこと自体が「\`Stop\` はこの器で発火する」の実測である**（#861 の段1）。（雑音にしないため、この「0件で閉じた」診断はセッションに1回だけ出す —— \`Stop\` はターンが閉じるたびに来るので、毎回出せば日誌がターン数ぶんの同じ行で埋まる。⟹ **2回目以降の「0件で閉じた」回は個別には残らない。** 続きは #861。）",
      ]
    `);
  });

  it('background_tasks も session_crons も無い入力（欄ごと欠け）も 0 件として扱う', async () => {
    const rig = await open();
    await fireStop(rig, {});
    expect(viewNotes(rig.events)).toHaveLength(1);
    expect(stopNotes(rig.events)[0]?.text).toContain('背景処理も session_crons も 0件 だった');
  });
});

describe('在り高が残っている回（note の全文）', () => {
  it('所有者 5 種と status 3 種が全部出る回: 内訳・各タスク行・⚠️ 行の全文（stop_hook_active=true）', async () => {
    const rig = await open();
    await registerBackgroundTask(rig, 'bg-m');
    await registerBackgroundTask(rig, 'bg-w', 'agent-xyz');
    await fireStop(rig, {
      stop_hook_active: true,
      session_crons: [{ id: 'cron-1', schedule: '* * * * *', recurring: false, prompt: '起きろ' }],
      background_tasks: [
        shell('bg-m', 'running'),
        shell('bg-w', 'completed'),
        { id: 'agent-1', type: 'subagent', status: 'paused', description: '委譲' },
        { id: 'mon-1', type: 'monitor', status: 'ぬるぬる', description: '監視' },
        shell('bg-orphan', 'pending', { command: undefined }),
      ],
    });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 1回目）: **背景処理 5件 / session_crons 1件 を残したまま閉じようとしている。** stop_hook_active=true。
      所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 1件 / 作業者 1件 / 委譲そのもの 1件 / 控えられない種類 1件 / 引けなかった 1件。
      status の内訳: 走っている 3件 / 終わった 1件 / 分からない 1件。
      - id=bg-m owner=manager type=shell status=running description=背景のシェル command=sleep 90
      - id=bg-w owner=worker:agent-xyz type=shell status=completed description=背景のシェル command=sleep 90
      - id=agent-1 owner=delegation type=subagent status=paused description=委譲
      - id=mon-1 owner=unrecordable type=monitor status=ぬるぬる description=監視
      - id=bg-orphan owner=unresolved type=shell status=pending description=背景のシェル
      ⚠️ 上のうち 1件 は**所有者を引けなかった**（\`type\` が**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器のほうを疑う —— \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。（\`monitor\` / \`workflow\` / 遠隔の \`Task\` は元から控えられないので、この数には入らない—— それらは「控えられない種類」に数えてある。）
      ⚠️ 上のうち 1件 は status が既知の語彙のどちらでもない。この行が出たら計器のほうを疑う —— SDK が status の語彙を変えた見込みが高い。
      ⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない —— \`Stop\` は**マネージャーが起きているときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、この観測にも現れない（#861）。",
      ]
    `);
  });

  it('⚠️ 行が出ない回（unresolved も unknown も 0）: 内訳の 0 の行は残り、観測だけの 2 行で終わる（stop_hook_active=false）', async () => {
    const rig = await open();
    await registerBackgroundTask(rig, 'bg-m');
    await fireStop(rig, {
      stop_hook_active: false,
      background_tasks: [shell('bg-m')],
      session_crons: [],
    });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 1回目）: **背景処理 1件 / session_crons 0件 を残したまま閉じようとしている。** stop_hook_active=false。
      所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 1件 / 作業者 0件 / 委譲そのもの 0件 / 控えられない種類 0件 / 引けなかった 0件。
      status の内訳: 走っている 1件 / 終わった 0件 / 分からない 0件。
      - id=bg-m owner=manager type=shell status=running description=背景のシェル command=sleep 90
      ⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない —— \`Stop\` は**マネージャーが起きているときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、この観測にも現れない（#861）。",
      ]
    `);
  });

  it('stop_hook_active が無い（欄ごと欠け）と、その断りの文が出ない。session_crons だけの在り高', async () => {
    const rig = await open();
    await fireStop(rig, {
      session_crons: [{ id: 'cron-1', schedule: '* * * * *', recurring: true, prompt: 'p' }],
    });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 1回目）: **背景処理 0件 / session_crons 1件 を残したまま閉じようとしている。**
      所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 0件 / 作業者 0件 / 委譲そのもの 0件 / 控えられない種類 0件 / 引けなかった 0件。
      status の内訳: 走っている 0件 / 終わった 0件 / 分からない 0件。
      ⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない —— \`Stop\` は**マネージャーが起きているときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、この観測にも現れない（#861）。",
      ]
    `);
  });

  it('id / type / status / description が文字列でない・欠けた行は「(不明)」で描き、所有者は引けない側へ倒れる', async () => {
    const rig = await open();
    await fireStop(rig, {
      background_tasks: [
        { id: 5, type: 'shell', status: 7, description: null },
        { type: 'subagent' },
        {},
      ],
    });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 1回目）: **背景処理 3件 / session_crons 0件 を残したまま閉じようとしている。**
      所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 0件 / 作業者 0件 / 委譲そのもの 1件 / 控えられない種類 1件 / 引けなかった 1件。
      status の内訳: 走っている 0件 / 終わった 0件 / 分からない 3件。
      - id=(不明) owner=unresolved type=shell status=(不明) description=(不明)
      - id=(不明) owner=delegation type=subagent status=(不明) description=(不明)
      - id=(不明) owner=unrecordable type=(不明) status=(不明) description=(不明)
      ⚠️ 上のうち 1件 は**所有者を引けなかった**（\`type\` が**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器のほうを疑う —— \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。（\`monitor\` / \`workflow\` / 遠隔の \`Task\` は元から控えられないので、この数には入らない—— それらは「控えられない種類」に数えてある。）
      ⚠️ 上のうち 3件 は status が既知の語彙のどちらでもない。この行が出たら計器のほうを疑う —— SDK が status の語彙を変えた見込みが高い。
      ⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない —— \`Stop\` は**マネージャーが起きているときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、この観測にも現れない（#861）。",
      ]
    `);
  });
});

describe('所有者の引き当て（backgroundTaskOwner）', () => {
  it('表で ""（マネージャー自身）なら manager・他の id なら worker:<id>。type=subagent は表に載っていても表が先に効く', async () => {
    const rig = await open();
    await registerBackgroundTask(rig, 'bg-m');
    await registerBackgroundTask(rig, 'bg-w', 'agent-q');
    // 表に在る id が type=subagent でも、表の答えが先（delegation にならない）
    await registerBackgroundTask(rig, 'bg-sub', 'agent-s');
    await fireStop(rig, {
      background_tasks: [
        shell('bg-m'),
        shell('bg-w'),
        { id: 'bg-sub', type: 'subagent', status: 'running', description: '表が先' },
      ],
    });
    const lines = (stopNotes(rig.events)[0]?.text ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- id='))
      .map((line) => line.split(' type=')[0]);
    expect(lines).toMatchInlineSnapshot(`
      [
        "- id=bg-m owner=manager",
        "- id=bg-w owner=worker:agent-q",
        "- id=bg-sub owner=worker:agent-s",
      ]
    `);
  });

  it('表に無い種類は、記録できる種類（shell）だけ unresolved・それ以外は unrecordable', async () => {
    const rig = await open();
    await fireStop(rig, {
      background_tasks: [
        { id: 'a', type: 'shell', status: 'running' },
        { id: 'b', type: 'workflow', status: 'running' },
        { id: 'c', type: 'local_workflow', status: 'running' },
        { id: 'd', status: 'running' },
      ],
    });
    const text = stopNotes(rig.events)[0]?.text ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('所有者の内訳')))
      .toMatchInlineSnapshot(`
      [
        "所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 0件 / 作業者 0件 / 委譲そのもの 0件 / 控えられない種類 3件 / 引けなかった 1件。",
      ]
    `);
  });
});

describe('通算は毎回進む（間引かれても・失敗しても）', () => {
  it('0 件の回が間引かれても、読み取りに失敗した回でも通算に入る', async () => {
    const rig = await open();
    await fireStop(rig, { background_tasks: [] });
    await fireStop(rig, { background_tasks: [] });
    const throwing: Record<string, unknown> = { hook_event_name: 'Stop' };
    // 読み取りの失敗は provider の `toAgentStopRecord` が `readError` に包む（入力の getter が投げる）
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom-stop-pin-read');
      },
    });
    await fireStop(rig, throwing);
    await fireStop(rig, { background_tasks: [shell('bg-x')] });
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop: マネージャーのターンが閉じたが、**背景処理も session_crons も 0件 だった**（このセッションで通算 1回目の発火）。⟹ SDK の言う「session is done」の側である。**この行が出たこと自体が「\`Stop\` はこの器で発火する」の実測である**（#861 の段1）。（雑音にしないため、この「0件で閉じた」診断はセッションに1回だけ出す —— \`Stop\` はターンが閉じるたびに来るので、毎回出せば日誌がターン数ぶんの同じ行で埋まる。⟹ **2回目以降の「0件で閉じた」回は個別には残らない。** 続きは #861。）",
        "Stop の観測に失敗した: Error: boom-stop-pin-read",
        "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 4回目）: **背景処理 1件 / session_crons 0件 を残したまま閉じようとしている。**
      所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 0件 / 作業者 0件 / 委譲そのもの 0件 / 控えられない種類 0件 / 引けなかった 1件。
      status の内訳: 走っている 1件 / 終わった 0件 / 分からない 0件。
      - id=bg-x owner=unresolved type=shell status=running description=背景のシェル command=sleep 90
      ⚠️ 上のうち 1件 は**所有者を引けなかった**（\`type\` が**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器のほうを疑う —— \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。（\`monitor\` / \`workflow\` / 遠隔の \`Task\` は元から控えられないので、この数には入らない—— それらは「控えられない種類」に数えてある。）
      ⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない —— \`Stop\` は**マネージャーが起きているときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、この観測にも現れない（#861）。",
      ]
    `);
  });
});

describe('上限（STOP_NOTE_TEXT_LIMIT = 1_500 文字）で切れる', () => {
  it('長い行（description が 3_000 文字）で切れ、末尾に切ったことを書く。長さと末尾を固定する', async () => {
    const rig = await open();
    await fireStop(rig, {
      background_tasks: [shell('bg-long', 'running', { description: 'あ'.repeat(3_000) })],
    });
    const text = stopNotes(rig.events)[0]?.text ?? '';
    expect({ length: text.length, tail: text.slice(-40), head: text.slice(0, 20) })
      .toMatchInlineSnapshot(`
      {
        "head": "Stop（マネージャーのターンが閉じる瞬",
        "length": 1517,
        "tail": "あああああああああああああああああああああああ…（上限 1500 文字で切った）",
      }
    `);
  });

  it('ちょうど上限の長さは切らない（境界）。上限 +1 では切る', async () => {
    // 上限ちょうどの本文を作るため、まず description 空の長さを測って足りない分を埋める
    const rig0 = await open();
    await fireStop(rig0, { background_tasks: [shell('bg-b', 'running', { description: '' })] });
    const base = (stopNotes(rig0.events)[0]?.text ?? '').length;
    await host?.shutdown().catch(() => undefined);

    const rigExact = await open();
    await fireStop(rigExact, {
      background_tasks: [shell('bg-b', 'running', { description: 'x'.repeat(1_500 - base) })],
    });
    const rigOver = await open();
    await fireStop(rigOver, {
      background_tasks: [shell('bg-b', 'running', { description: 'x'.repeat(1_500 - base + 1) })],
    });
    const exact = stopNotes(rigExact.events)[0]?.text ?? '';
    const over = stopNotes(rigOver.events)[0]?.text ?? '';
    expect({
      exactLength: exact.length,
      exactCut: exact.includes('文字で切った'),
      overCut: over.includes('…（上限 1500 文字で切った）'),
    }).toMatchInlineSnapshot(`
      {
        "exactCut": false,
        "exactLength": 1500,
        "overCut": true,
      }
    `);
  });

  it('0 件の回の note も同じ上限を通る（本文は上限より短いので切れない）', async () => {
    const rig = await open();
    await fireStop(rig, { background_tasks: [] });
    const text = stopNotes(rig.events)[0]?.text ?? '';
    expect({ length: text.length, cut: text.includes('文字で切った') }).toMatchInlineSnapshot(`
      {
        "cut": false,
        "length": 283,
      }
    `);
  });
});

describe('readError と note が投げたとき（握る）', () => {
  it('入力の読み取りが失敗した回は「Stop の観測に失敗した: …」を 1 本だけ出し、戻り値は continue: true', async () => {
    const rig = await open();
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'session_crons', {
      enumerable: true,
      get(): never {
        throw new Error('boom-stop-pin-read');
      },
    });
    const result = await fireStop(rig, throwing);
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          "Stop の観測に失敗した: Error: boom-stop-pin-read",
        ],
        "result": {
          "continue": true,
        },
      }
    `);
  });

  it('タスクの 1 行が null（taskRow が投げる）でも、観測の失敗として握り、本文の note は出ない', async () => {
    const rig = await open();
    const result = await fireStop(rig, { background_tasks: [shell('bg-ok'), null] });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          "Stop の観測に失敗した: TypeError: Cannot read properties of null (reading 'id')",
        ],
        "result": {
          "continue": true,
        },
      }
    `);
  });

  it('失敗の理由は reasonOf を通す（原因 cause の連鎖も畳んで 1 行に出る）', async () => {
    const rig = await open();
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('外側', { cause: new Error('内側の原因') });
      },
    });
    await fireStop(rig, throwing);
    expect(viewNotes(rig.events)).toMatchInlineSnapshot(`
      [
        "Stop の観測に失敗した: Error: 外側 <- Error: 内側の原因",
      ]
    `);
  });

  it('Stop の観測は note だけを出す（0 件・在り高・失敗のどの回も、ほかの出来事・追加の欄を足さない）', async () => {
    const rig = await open();
    await fireStop(rig, { background_tasks: [] });
    await fireStop(rig, { background_tasks: [shell('bg-n')], stop_hook_active: true });
    await fireStop(rig, { background_tasks: [null] });
    expect(
      // 起動の合図（`session`）は、この試験の前に出たもので Stop の観測ではない（届く周回が不定のため除く）
      rig.events
        .filter((event) => event.type !== 'session')
        .map((event) => ({
          type: event.type,
          keys: Object.keys(event).sort().join(','),
        })),
    ).toMatchInlineSnapshot(`
      [
        {
          "keys": "managerId,text,type",
          "type": "note",
        },
        {
          "keys": "managerId,text,type",
          "type": "note",
        },
        {
          "keys": "managerId,text,type",
          "type": "note",
        },
      ]
    `);
  });

  it('本文の note が投げたら、失敗の note を 1 本足し、戻り値は continue: true（本文は emit の先に積まれている）', async () => {
    const rig = await open({ throwOn: throwOnce(isStopNote) });
    const result = await fireStop(rig, { background_tasks: [shell('bg-t')] });
    const notes = viewNotes(rig.events) as string[];
    expect({
      result,
      count: notes.length,
      first: notes[0]?.slice(0, 40),
      second: notes[1],
    }).toMatchInlineSnapshot(`
      {
        "count": 2,
        "first": "Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 1回目）: *",
        "result": {
          "continue": true,
        },
        "second": "Stop の観測に失敗した: Error: emit が落ちた（テスト用）",
      }
    `);
  });

  it('失敗の note も投げたら、黙って諦める（投げ直さない）。次の回は動く', async () => {
    const rig = await open({ throwOn: isStopNote });
    const result = await fireStop(rig, { background_tasks: [shell('bg-t')] });
    const countAfterFirst = stopNotes(rig.events).length;
    const second = await fireStop(rig, { background_tasks: [] });
    expect({
      result,
      second,
      countAfterFirst,
      countAfterSecond: stopNotes(rig.events).length,
    }).toMatchInlineSnapshot(`
      {
        "countAfterFirst": 2,
        "countAfterSecond": 4,
        "result": {
          "continue": true,
        },
        "second": {
          "continue": true,
        },
      }
    `);
  });

  it('0 件の回の note が投げても、診断は済んだ扱い（次の 0 件の回で出し直さない）。失敗の note が 1 本出る', async () => {
    const rig = await open({ throwOn: throwOnce(isStopNote) });
    await fireStop(rig, { background_tasks: [] });
    await fireStop(rig, { background_tasks: [] });
    expect((viewNotes(rig.events) as string[]).map((text) => text.slice(0, 40)))
      .toMatchInlineSnapshot(`
      [
        "Stop: マネージャーのターンが閉じたが、**背景処理も session_cr",
        "Stop の観測に失敗した: Error: emit が落ちた（テスト用）",
      ]
    `);
  });
});

describe('#markProgressed を呼ばない（resume の作り直しで観測）', () => {
  // Stop だけを受けた resume は「まだ手が動いていない」ままなので、そのあとセッションが黙って落ちると作り直す（resume_failed）。
  // 対照: Stop の観測が手が動いた印を立てるなら、作り直さず closed で終わる。
  async function resumeThenStop(input: Record<string, unknown>): Promise<{
    resumeFailed: number;
    closed: number;
    sessions: number;
  }> {
    const events: RunnerEvent[] = [];
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => events.push(event),
      queryFn: fn,
      env: {},
    });
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: dir,
      request: '最初の依頼',
      // 素材を 1 件渡す: 空だと作り直さない理由が `#progressed` だと確かめられない
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });
    const first = await vi.waitFor(() => {
      const found = started[0];
      if (found === undefined) throw new Error('セッションがまだ開いていない');
      return found;
    });
    await fireStop({ started: first, events }, input);
    await tick();
    first.finish();
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === 'resume_failed' || e.type === 'closed')) {
        throw new Error('resume_failed も closed もまだ来ていない');
      }
    });
    return {
      resumeFailed: events.filter((e) => e.type === 'resume_failed').length,
      closed: events.filter((e) => e.type === 'closed').length,
      sessions: started.length,
    };
  }

  it('0 件の回だけ受けても、落ちれば作り直す', async () => {
    expect(await resumeThenStop({ background_tasks: [] })).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });

  it('在り高の回だけ受けても、落ちれば作り直す', async () => {
    expect(await resumeThenStop({ background_tasks: [shell('bg-r')] })).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });

  it('読み取りに失敗した回だけ受けても、落ちれば作り直す', async () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    expect(await resumeThenStop(throwing)).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });
});

describe('周回（await を足さない・外さない）', () => {
  async function observe(
    rig: Rig,
    input: Record<string, unknown>,
  ): Promise<{ noteSync: number; notesAtTick: number[]; settledAtTick: number }> {
    const before = stopNotes(rig.events).length;
    const promise = fireStop(rig, input);
    // フックを呼んだ直後（await なし）に出ている note の本数
    const noteSync = stopNotes(rig.events).length - before;
    let ticks = 0;
    let settledAtTick = -1;
    void promise.then(() => {
      settledAtTick = ticks;
    });
    const notesAtTick: number[] = [];
    while (settledAtTick < 0 && ticks < 50) {
      await Promise.resolve();
      ticks += 1;
      notesAtTick.push(stopNotes(rig.events).length - before);
    }
    return { noteSync, notesAtTick, settledAtTick };
  }

  it('0 件の回・在り高の回・失敗の回: 呼んだ直後に note が出ているか、戻りまでの周回数', async () => {
    const rigIdle = await open();
    const idle = await observe(rigIdle, { background_tasks: [] });
    await host?.shutdown().catch(() => undefined);

    const rigBusy = await open();
    const busy = await observe(rigBusy, { background_tasks: [shell('bg-tick')] });
    await host?.shutdown().catch(() => undefined);

    const rigThinned = await open();
    await fireStop(rigThinned, { background_tasks: [] });
    const thinned = await observe(rigThinned, { background_tasks: [] });
    await host?.shutdown().catch(() => undefined);

    const rigFail = await open();
    const failing: Record<string, unknown> = {};
    Object.defineProperty(failing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    const failed = await observe(rigFail, failing);

    expect({ idle, busy, thinned, failed }).toMatchInlineSnapshot(`
      {
        "busy": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "failed": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "idle": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "thinned": {
          "noteSync": 0,
          "notesAtTick": [
            0,
            0,
            0,
          ],
          "settledAtTick": 2,
        },
      }
    `);
  });
});
