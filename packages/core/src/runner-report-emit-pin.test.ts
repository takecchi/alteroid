import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession#applyTurnEnded` の「後半」（報告本文の組み立て → 出し箱の取り込み → `setStatus` → `wantsTokenRecycle` の起こし →
// `awaitingBackground` → `outwardActions` → `report` の送出 → `#wakeForFinishedBackgroundTaskOutputs` → `#deliverPeerNotices`）を、
// 外から見える結果だけで縛る。入口は SDK の `result`（と、その前の `assistant`・`system`）。
// 期待の文字列・欄・周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回と `setTimeout(0)` だけ）。
//
// 各枝が縛る、`runner.ts` の元のコメントの意図:
// - 「取り込みは `setStatus` より前に済ませる」 → 『取り込みの間に確認へ答えた回』（`status` が嘘にならない）
// - 「背景処理の完了待ちで畳む報告でも取り込む」 → 『背景処理が在る回の出し箱』（`files` が載る・`awaitingBackground` も載る）
// - 「取り込みの `await` より前に 1 回だけ読む」 → 『awaitingBackground の件数と内訳』（取り込み前の一覧）
// - 「出し箱が空なら `await` を挟まない」 → 『出る周回数』（空: 3 周回で見える。在り: 周回では見えず、I/O の後に見える）
// - 「3 条件が揃うときだけ載せる、欠けたら配る側へ倒す」 → 『awaitingBackground の 3 条件』
// - 「`report` を出した後に `#wakeForFinishedBackgroundTaskOutputs` を呼ぶ」 → 『起こし直す回の report.status』
// - 「確認待ちの間に溜めた peer の知らせも同じ理由でここで届ける」 → ここからは観測できない（末尾の注を参照）

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const NOT_LOGGED_IN = 'Not logged in · Please run /login';
const OLD_TOKEN = 'token-fake-old-000';

interface Started {
  options: Options;
  /** SDK へ渡された入力（最初の依頼を含む）。 */
  inputs: string[];
  push: (message: SDKMessage) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: {
    prompt: AsyncIterable<{ message: { content: unknown } }>;
    options: Options;
  }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    let ended = false;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];
    const endOutput = () => {
      ended = true;
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(null);
      }
    };
    const record: Started = {
      options: input.options,
      inputs,
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
    // 入力側を読み続ける（読まないと `#inputStream` が駆動されず、境界の判定が走らない）。入力が閉じたら CLI も終わる
    void (async () => {
      const iterator = input.prompt[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          endOutput();
          return;
        }
        inputs.push(String(next.value.message.content));
      }
    })();
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
        if (ended) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: endOutput,
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-report-emit-pin-');
});

afterEach(async () => {
  vi.useRealTimers();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

interface Rig {
  started: Started[];
  events: RunnerEvent[];
  host: RunnerHost;
  /** 出し箱の担当の置き場（`outbox: true` のときだけ）。 */
  outboxDir: string;
}

async function open(
  options: {
    outbox?: boolean;
    credentials?: 'store' | 'with-old-token';
    throwOn?: (event: RunnerEvent) => boolean;
  } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  let thrown = false;
  const outboxRoot = join(dir, 'outbox');
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (!thrown && options.throwOn?.(event) === true) {
        thrown = true;
        throw new Error('emit が落ちた（テスト用）');
      }
    },
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    ...(options.outbox === true
      ? { outboxRoot, outboxStagedRoot: join(dir, 'outbox-staged') }
      : {}),
    ...(options.credentials === undefined
      ? {}
      : {
          credentials: createCredentialStore({
            dir: join(dir, 'creds'),
            seed:
              options.credentials === 'with-old-token'
                ? { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN }
                : {},
            names: ['CLAUDE_CODE_OAUTH_TOKEN'],
          }),
        }),
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  if (started[0] === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started, events, host, outboxDir: join(outboxRoot, 'mgr-1') };
}

let serial = 0;
const first = (rig: Rig): Started => {
  const found = rig.started[0];
  if (found === undefined) throw new Error('セッションが無い');
  return found;
};

function say(rig: Rig, text: string, fields: { error?: string; parent?: string } = {}): void {
  first(rig).push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: fields.parent ?? null,
    session_id: 'sess-mgr',
    uuid: `uuid-say-${String((serial += 1))}`,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  } as unknown as SDKMessage);
}

function result(
  rig: Rig,
  fields: { text: string; isError?: boolean; apiStatus?: number; uuid?: string },
): void {
  first(rig).push({
    type: 'result',
    subtype: 'success',
    result: fields.text,
    session_id: 'sess-mgr',
    uuid: fields.uuid ?? `uuid-result-${String((serial += 1))}`,
    ...(fields.isError === undefined ? {} : { is_error: fields.isError }),
    ...(fields.apiStatus === undefined ? {} : { api_error_status: fields.apiStatus }),
  } as unknown as SDKMessage);
}

function startTask(rig: Rig, taskId: string): void {
  first(rig).push({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    task_type: 'local_agent',
    uuid: `uuid-task-started-${String((serial += 1))}`,
    session_id: 'sess-mgr',
  } as unknown as SDKMessage);
}

function notify(rig: Rig, taskId: string, status: string, summary: string): void {
  first(rig).push({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    summary,
    output_file: '/tmp/out-1554.txt',
    uuid: `uuid-task-notification-${String((serial += 1))}`,
    session_id: 'sess-mgr',
  } as unknown as SDKMessage);
}

function backgroundTasks(rig: Rig, tasks: readonly { id: string; taskType: string }[]): void {
  first(rig).push({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((task) => ({ task_id: task.id, task_type: task.taskType, description: '' })),
    session_id: 'sess-mgr',
    uuid: `uuid-bg-${String((serial += 1))}`,
  } as unknown as SDKMessage);
}

/** 確認を開いたまま答えない（`waiting_human` を作る）。 */
function ask(rig: Rig): void {
  const canUseTool = first(rig).options.canUseTool;
  if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
  void canUseTool('Bash', { command: 'echo hi' }, {
    signal: new AbortController().signal,
    toolUseID: `tool-${String((serial += 1))}`,
    requestId: `req-${String((serial += 1))}`,
  } as never);
}

function fire(
  rig: Rig,
  name: 'PostToolUse' | 'SubagentStop',
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = first(rig).options.hooks?.[name]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const reportsOf = (rig: Rig): ReportEvent[] =>
  rig.events.filter((event): event is ReportEvent => event.type === 'report');

/** `sessionGeneration` は実行ごとに違う UUID なので、在ることだけ確かめて落とす。 */
function shape(report: ReportEvent): Omit<ReportEvent, 'sessionGeneration'> {
  const { sessionGeneration, ...rest } = report;
  expect(typeof sessionGeneration).toBe('string');
  return rest;
}

/** 結果を押して外へ出るまで回す（マイクロタスクと `setTimeout(0)` だけ。実時間では待たない）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await tick();
}

/**
 * 出し箱にファイルが在る回は、実際のファイル I/O の後に report が出る: 固定の回数（6 周）では、負荷の高い CI で間に合わないことがある。
 * report が出るまで、回数の上限つきで回す（実時間の締め切りは足さない。上限は 6 周の 100 倍）。出た後は settle で 2 本目が出ないことも見る。
 */
async function untilReport(rig: Rig): Promise<void> {
  for (let i = 0; i < 600 && reportsOf(rig).length === 0; i += 1) await tick();
  await settle();
}

async function only(rig: Rig): Promise<ReportEvent> {
  await untilReport(rig);
  const [report] = reportsOf(rig);
  if (report === undefined || reportsOf(rig).length !== 1) throw new Error('report が1本ではない');
  return report;
}

describe('report の全欄（成功）', () => {
  it('成功・本文あり: text・status・reportId だけが載り、contentless・failure・synthesized・awaitingBackground・outwardActions は無い', async () => {
    const rig = await open();
    say(rig, 'やった');
    result(rig, { text: 'やった', uuid: 'uuid-result-a' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "managerId": "mgr-1",
        "reportId": "uuid-result-a",
        "status": "done",
        "text": "やった",
        "type": "report",
      }
    `);
  });

  it('成功・本文なし: `（報告なし）` と contentless: true', async () => {
    const rig = await open();
    result(rig, { text: '', uuid: 'uuid-result-b' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "contentless": true,
        "managerId": "mgr-1",
        "reportId": "uuid-result-b",
        "status": "done",
        "text": "（報告なし）",
        "type": "report",
      }
    `);
  });

  it('途中の発言が在り、結論と全文が違う: fullText が載る（結論は最後の発言）', async () => {
    const rig = await open();
    say(rig, '途中の発言');
    say(rig, '結論');
    result(rig, { text: '結論', uuid: 'uuid-result-c' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "fullText": "途中の発言

      結論",
        "managerId": "mgr-1",
        "reportId": "uuid-result-c",
        "status": "done",
        "text": "結論",
        "type": "report",
      }
    `);
  });

  it('発言が1つで result と同じなら fullText は載らない（`outcome` に在るときだけ）', async () => {
    const rig = await open();
    say(rig, '結論だけ');
    result(rig, { text: '結論だけ', uuid: 'uuid-result-c2' });
    expect('fullText' in (await only(rig))).toBe(false);
  });
});

describe('report の全欄（失敗）', () => {
  it('失敗・status 無し: failure は code と via だけ。synthesized: turn_failed・contentless は載らない（false）・本文は failedReportText', async () => {
    const rig = await open({ credentials: 'store' });
    result(rig, { text: '壊れた', isError: true, uuid: 'uuid-result-d' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "failure": {
          "code": "success",
          "via": "result_is_error",
        },
        "managerId": "mgr-1",
        "reportId": "uuid-result-d",
        "status": "done",
        "synthesized": "turn_failed",
        "text": "（このターンは応答を返さずに終わった: success / result_is_error）
      壊れた",
        "type": "report",
      }
    `);
  });

  it('失敗・status あり（api_error_status）: failure.status が載る。失敗前の本文は「失敗する前に出ていた本文」として後ろへ付く', async () => {
    const rig = await open({ credentials: 'store' });
    say(rig, '調べている途中');
    result(rig, { text: '過負荷', isError: true, apiStatus: 529, uuid: 'uuid-result-e' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "failure": {
          "code": "success/529",
          "status": 529,
          "via": "result_is_error",
        },
        "managerId": "mgr-1",
        "reportId": "uuid-result-e",
        "status": "done",
        "synthesized": "turn_failed",
        "text": "（このターンは応答を返さずに終わった: success/529 / result_is_error）
      過負荷

      （失敗する前に出ていた本文）
      調べている途中",
        "type": "report",
      }
    `);
  });

  it('失敗・本文が空: contentless は載らない（失敗で終わった回は含めない）', async () => {
    const rig = await open({ credentials: 'store' });
    result(rig, { text: '', isError: true, uuid: 'uuid-result-f' });
    expect(shape(await only(rig))).toMatchInlineSnapshot(`
      {
        "failure": {
          "code": "success",
          "via": "result_is_error",
        },
        "managerId": "mgr-1",
        "reportId": "uuid-result-f",
        "status": "done",
        "synthesized": "turn_failed",
        "text": "（このターンは応答を返さずに終わった: success / result_is_error）
      （報告なし）",
        "type": "report",
      }
    `);
  });

  it('鍵の置き場が無い器の Not logged in: 本文の末尾に案内が付く（鍵の置き場が在る器では付かない）', async () => {
    const without = await open();
    result(without, { text: NOT_LOGGED_IN, isError: true, uuid: 'uuid-result-g' });
    const hinted = (await only(without)).text;
    await host?.shutdown();
    host = undefined;
    const withStore = await open({ credentials: 'store' });
    result(withStore, { text: NOT_LOGGED_IN, isError: true, uuid: 'uuid-result-g' });
    const plain = (await only(withStore)).text;
    expect({ hinted, plain }).toMatchInlineSnapshot(`
      {
        "hinted": "（このターンは応答を返さずに終わった: success / result_is_error）
      Not logged in · Please run /login

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
        "plain": "（このターンは応答を返さずに終わった: success / result_is_error）
      Not logged in · Please run /login",
      }
    `);
  });
});

describe('失敗の本文の組み立て（failedReportText の入力の組み合わせ）', () => {
  // 作業者の絡み方ごとに本文が変わる。優先は `workerRejections` → `failedWorkerNotifications` → `openedWorkers`（3 つを足し合わせない）。
  // `via` が assistant_error（本体の発言に拒否の印）か result_is_error かでも言い回しが変わる
  type Setup = (rig: Rig) => void;
  const bodyFailure: Setup = (rig) => result(rig, { text: 'エラー本文', isError: true });
  const bodyHit: Setup = (rig) => {
    say(rig, '', { error: 'billing_error' });
    result(rig, { text: '' });
  };
  const cases: { name: string; setup: Setup }[] = [
    { name: '作業者なし・発言なし', setup: bodyFailure },
    {
      name: '作業者なし・発言あり',
      setup: (rig) => {
        say(rig, '1つ目');
        say(rig, '2つ目');
        bodyFailure(rig);
      },
    },
    {
      name: '作業者1体が開いていた',
      setup: (rig) => {
        startTask(rig, 't1');
        bodyFailure(rig);
      },
    },
    {
      name: '作業者2体が開いていた・本体は拒否の印あり',
      setup: (rig) => {
        startTask(rig, 't1');
        startTask(rig, 't2');
        bodyHit(rig);
      },
    },
    {
      name: '作業者の失敗通知1体（枠は名乗らない）',
      setup: (rig) => {
        startTask(rig, 't1');
        notify(rig, 't1', 'failed', '普通のエラー');
        bodyFailure(rig);
      },
    },
    {
      name: '作業者の失敗通知2体のうち1体が枠を名乗る・本体は拒否の印あり',
      setup: (rig) => {
        startTask(rig, 't1');
        startTask(rig, 't2');
        notify(rig, 't1', 'failed', '普通のエラー');
        notify(rig, 't2', 'failed', ORG_SPEND_LIMIT);
        bodyHit(rig);
      },
    },
    {
      name: '作業者の発言に拒否の印（billing_error ×2・rate_limit ×1）',
      setup: (rig) => {
        say(rig, '', { error: 'billing_error', parent: 'tool-a' });
        say(rig, '', { error: 'rate_limit', parent: 'tool-b' });
        say(rig, '', { error: 'billing_error', parent: 'tool-c' });
        bodyFailure(rig);
      },
    },
    {
      name: '作業者の発言に拒否の印・本体も拒否の印',
      setup: (rig) => {
        say(rig, '', { error: 'billing_error', parent: 'tool-a' });
        bodyHit(rig);
      },
    },
    {
      name: '3つの証拠が全部ある: 拒否の印が通知と開いた数に勝つ',
      setup: (rig) => {
        startTask(rig, 't1');
        notify(rig, 't1', 'failed', 'エラー');
        say(rig, '', { error: 'billing_error', parent: 'tool-a' });
        bodyFailure(rig);
      },
    },
    {
      name: '通知と開いた数だけがある: 通知が開いた数に勝つ',
      setup: (rig) => {
        startTask(rig, 't1');
        startTask(rig, 't2');
        notify(rig, 't1', 'failed', 'エラー');
        bodyFailure(rig);
      },
    },
  ];

  it('各組み合わせで本文の全文が変わる', async () => {
    const texts: Record<string, string> = {};
    for (const entry of cases) {
      const rig = await open({ credentials: 'store' });
      entry.setup(rig);
      texts[entry.name] = (await only(rig)).text;
      await host?.shutdown();
      host = undefined;
    }
    expect(texts).toMatchInlineSnapshot(`
      {
        "3つの証拠が全部ある: 拒否の印が通知と開いた数に勝つ": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文
      （このターンでは作業者の発言に SDK の拒否の印が付いていた: billing_error ×1。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）",
        "作業者1体が開いていた": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文
      （このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）",
        "作業者2体が開いていた・本体は拒否の印あり": "（このターンは応答を返さずに終わった: billing_error / assistant_error）
      （報告なし）
      （このターンでは作業者が 2 体開いていた。作業者が当たったかは SDK からは分からないが、本体の発言には拒否の印が付いていたので、本体は当たっている）",
        "作業者なし・発言あり": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文

      （失敗する前に出ていた本文）
      1つ目

      2つ目",
        "作業者なし・発言なし": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文",
        "作業者の失敗通知1体（枠は名乗らない）": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文
      （このターンでは作業者 1 体が失敗で終わった。本体も当たったかは SDK からは分からない）",
        "作業者の失敗通知2体のうち1体が枠を名乗る・本体は拒否の印あり": "（このターンは応答を返さずに終わった: billing_error / assistant_error）
      （報告なし）
      （このターンでは作業者 2 体が失敗で終わった（うち 1 体は枠(429)を名乗った）。本体の発言にも拒否の印が付いていたので、本体も当たっている）",
        "作業者の発言に拒否の印・本体も拒否の印": "（このターンは応答を返さずに終わった: billing_error / assistant_error）
      （報告なし）
      （このターンでは作業者の発言に SDK の拒否の印が付いていた: billing_error ×1。作業者が当たったことは確かで、本体の発言にも拒否の印が付いていたので、本体も当たっている）",
        "作業者の発言に拒否の印（billing_error ×2・rate_limit ×1）": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文
      （このターンでは作業者の発言に SDK の拒否の印が付いていた: billing_error ×2 / rate_limit ×1。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）",
        "通知と開いた数だけがある: 通知が開いた数に勝つ": "（このターンは応答を返さずに終わった: success / result_is_error）
      エラー本文
      （このターンでは作業者 1 体が失敗で終わった。本体も当たったかは SDK からは分からない）",
      }
    `);
  });
});

describe('status と awaitingBackground（3 条件が揃うときだけ載る。欠けたら配る側へ倒す）', () => {
  it('条件の組み合わせごとの status と awaitingBackground', async () => {
    const out: Record<string, unknown> = {};
    const run = async (name: string, body: (rig: Rig) => void): Promise<void> => {
      const rig = await open();
      body(rig);
      const report = await only(rig);
      out[name] = {
        status: report.status,
        awaitingBackground: report.awaitingBackground,
        failure: report.failure?.code,
      };
      await host?.shutdown();
      host = undefined;
    };
    await run('成功・done・背景処理あり（種類が2つ）', (rig) => {
      backgroundTasks(rig, [
        { id: 'bg-1', taskType: 'shell' },
        { id: 'bg-2', taskType: 'local_agent' },
        { id: 'bg-3', taskType: 'shell' },
      ]);
      say(rig, '待つ');
      result(rig, { text: '待つ' });
    });
    await run('成功・done・背景処理なし', (rig) => {
      say(rig, '終わった');
      result(rig, { text: '終わった' });
    });
    await run('失敗・done・背景処理あり（失敗が欠ける）', (rig) => {
      backgroundTasks(rig, [{ id: 'bg-1', taskType: 'shell' }]);
      result(rig, { text: '壊れた', isError: true });
    });
    await run('成功・waiting_human・背景処理あり（done が欠ける）', (rig) => {
      backgroundTasks(rig, [{ id: 'bg-1', taskType: 'shell' }]);
      ask(rig);
      result(rig, { text: '確認をお願いします' });
    });
    await run('成功・waiting_human・背景処理なし', (rig) => {
      ask(rig);
      result(rig, { text: '確認をお願いします' });
    });
    await run('失敗・waiting_human・背景処理あり', (rig) => {
      backgroundTasks(rig, [{ id: 'bg-1', taskType: 'shell' }]);
      ask(rig);
      result(rig, { text: '壊れた', isError: true });
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "失敗・done・背景処理あり（失敗が欠ける）": {
          "awaitingBackground": undefined,
          "failure": "success",
          "status": "done",
        },
        "失敗・waiting_human・背景処理あり": {
          "awaitingBackground": undefined,
          "failure": "success",
          "status": "waiting_human",
        },
        "成功・done・背景処理あり（種類が2つ）": {
          "awaitingBackground": {
            "breakdown": "shell×2, local_agent×1",
            "count": 3,
          },
          "failure": undefined,
          "status": "done",
        },
        "成功・done・背景処理なし": {
          "awaitingBackground": undefined,
          "failure": undefined,
          "status": "done",
        },
        "成功・waiting_human・背景処理あり（done が欠ける）": {
          "awaitingBackground": undefined,
          "failure": undefined,
          "status": "waiting_human",
        },
        "成功・waiting_human・背景処理なし": {
          "awaitingBackground": undefined,
          "failure": undefined,
          "status": "waiting_human",
        },
      }
    `);
  });
});

describe('outwardActions（splice(0) で空に戻す）', () => {
  it('在る回は載り、次の報告では空に戻る（キーごと無い）。無い回はキーごと無い', async () => {
    const rig = await open();
    const bash = (command: string) =>
      fire(rig, 'PostToolUse', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
    await bash('git push origin main');
    await bash('gh pr merge 1 --squash');
    await bash('git push origin main');
    result(rig, { text: '1回目' });
    await settle();
    result(rig, { text: '2回目' });
    await settle();
    await bash('ls');
    result(rig, { text: '3回目（外へ出さないコマンドだけ）' });
    await settle();
    expect(
      reportsOf(rig).map((report) => ({
        text: report.text,
        hasKey: 'outwardActions' in report,
        outwardActions: report.outwardActions,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "hasKey": true,
          "outwardActions": [
            "git push",
            "gh pr merge",
          ],
          "text": "1回目",
        },
        {
          "hasKey": false,
          "outwardActions": undefined,
          "text": "2回目",
        },
        {
          "hasKey": false,
          "outwardActions": undefined,
          "text": "3回目（外へ出さないコマンドだけ）",
        },
      ]
    `);
  });
});

describe('出し箱の取り込み', () => {
  it('在れば #collectOutbox の欄（files）が report に載り、背景処理の完了待ちの報告でも取り込む（awaitingBackground も載る）', async () => {
    const rig = await open({ outbox: true });
    backgroundTasks(rig, [{ id: 'bg-1', taskType: 'local_agent' }]);
    writeFileSync(join(rig.outboxDir, 'compare.png'), '成果物');
    say(rig, '完了を待つ');
    result(rig, { text: '完了を待つ', uuid: 'uuid-result-o1' });
    const report = await only(rig);
    expect({
      keys: Object.keys(report).sort(),
      files: report.files?.map((file) => file.name),
      rejectedFiles: report.rejectedFiles,
      awaitingBackground: report.awaitingBackground,
      status: report.status,
    }).toMatchInlineSnapshot(`
      {
        "awaitingBackground": {
          "breakdown": "local_agent×1",
          "count": 1,
        },
        "files": [
          "compare.png",
        ],
        "keys": [
          "awaitingBackground",
          "files",
          "managerId",
          "reportId",
          "sessionGeneration",
          "status",
          "text",
          "type",
        ],
        "rejectedFiles": undefined,
        "status": "done",
      }
    `);
  });

  it('取り込めなかった名前は rejectedFiles に載る（files は載らない）', async () => {
    const rig = await open({ outbox: true });
    mkdirSync(join(rig.outboxDir, 'subdir'));
    result(rig, { text: '済んだ', uuid: 'uuid-result-o2' });
    const report = await only(rig);
    expect({ files: report.files, rejectedFiles: report.rejectedFiles }).toMatchInlineSnapshot(`
      {
        "files": undefined,
        "rejectedFiles": [
          {
            "name": "subdir",
            "reason": "サブディレクトリは送れない（出し箱の直下のファイルだけ）",
          },
        ],
      }
    `);
  });

  it('空なら欄は載らない（`{}`）', async () => {
    const rig = await open({ outbox: true });
    result(rig, { text: '空', uuid: 'uuid-result-o3' });
    const report = await only(rig);
    expect({ files: 'files' in report, rejectedFiles: 'rejectedFiles' in report })
      .toMatchInlineSnapshot(`
      {
        "files": false,
        "rejectedFiles": false,
      }
    `);
  });

  it('⭐ 取り込みの間に確認へ答えても、report.status は答えた後の状態（done）になる（setStatus は取り込みの後）', async () => {
    const rig = await open({ outbox: true });
    ask(rig);
    writeFileSync(join(rig.outboxDir, 'a.txt'), 'a');
    result(rig, { text: '確認待ちで畳む', uuid: 'uuid-result-o4' });
    // 取り込み（実 I/O）の `await` に入るまでマイクロタスクだけを回す。I/O は終わらない
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(reportsOf(rig)).toHaveLength(0);
    const requestId = rig.host.list()[0]?.waiting[0]?.requestId;
    if (requestId === undefined) throw new Error('waiting が見つからない');
    await rig.host.answer('mgr-1', { requestId, decision: 'allow', message: 'どうぞ' });
    const report = await only(rig);
    expect({ status: report.status, files: report.files?.map((file) => file.name) })
      .toMatchInlineSnapshot(`
      {
        "files": [
          "a.txt",
        ],
        "status": "done",
      }
    `);
  });
});

describe('report が見える周回数（出し箱が空なら await を挟まない）', () => {
  /** `result` を押してから report が見えるまでのマイクロタスクの周回数。上限までに見えなければ undefined。 */
  async function roundsUntilReport(rig: Rig): Promise<number | undefined> {
    result(rig, { text: '済んだ', uuid: 'uuid-result-r' });
    for (let ticks = 0; ticks < 200; ticks += 1) {
      await Promise.resolve();
      if (reportsOf(rig).length > 0) return ticks;
    }
    return undefined;
  }

  it('出し箱が無い器・出し箱が空の器は同じ周回数で見える', async () => {
    const none = await open();
    const noneRounds = await roundsUntilReport(none);
    await host?.shutdown();
    host = undefined;
    const empty = await open({ outbox: true });
    const emptyRounds = await roundsUntilReport(empty);
    expect({ noOutbox: noneRounds, emptyOutbox: emptyRounds }).toMatchInlineSnapshot(`
      {
        "emptyOutbox": 3,
        "noOutbox": 3,
      }
    `);
  });

  it('出し箱に置かれていると、マイクロタスクの周回では見えず（実 I/O を待つ）、待てば files つきで見える', async () => {
    const rig = await open({ outbox: true });
    writeFileSync(join(rig.outboxDir, 'a.txt'), 'a');
    const rounds = await roundsUntilReport(rig);
    await untilReport(rig);
    expect({
      roundsWithinMicrotasks: rounds,
      afterIo: reportsOf(rig).map((report) => report.files?.map((file) => file.name)),
    }).toMatchInlineSnapshot(`
      {
        "afterIo": [
          [
            "a.txt",
          ],
        ],
        "roundsWithinMicrotasks": undefined,
      }
    `);
  });
});

describe('wantsTokenRecycle（setStatus の後で入力を起こす）', () => {
  it('鍵の付け替えが走行中に届いたら、そのターンの報告の後で畳み直す（2 本目のセッションが開く）', async () => {
    const rig = await open({ credentials: 'with-old-token' });
    await rig.host.setCredentials([
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-111' },
    ]);
    await settle();
    expect(rig.started).toHaveLength(1);
    say(rig, 'やった');
    result(rig, { text: 'やった', uuid: 'uuid-result-t' });
    await settle();
    expect({
      sessions: rig.started.length,
      reports: reportsOf(rig).map((report) => report.status),
      newToken: rig.started[1]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN,
    }).toMatchInlineSnapshot(`
      {
        "newToken": "token-fake-new-111",
        "reports": [
          "done",
        ],
        "sessions": 2,
      }
    `);
  });

  it('付け替えが無ければ畳み直さない', async () => {
    const rig = await open({ credentials: 'with-old-token' });
    result(rig, { text: '済んだ', uuid: 'uuid-result-t2' });
    await settle();
    expect({ sessions: rig.started.length, reports: reportsOf(rig).length }).toMatchInlineSnapshot(`
      {
        "reports": 1,
        "sessions": 1,
      }
    `);
  });
});

describe('report の後で起こす（#wakeForFinishedBackgroundTaskOutputs）', () => {
  /** 打ち切った作業者の背景処理が、走っている最中に終わった状態を作る（`runner-cut-off-wake.test.ts` と同じ手順）。 */
  async function queueFinishedOutput(rig: Rig): Promise<void> {
    await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 90', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-agent-1' },
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    vi.useFakeTimers();
    try {
      const stopped = fire(rig, 'SubagentStop', {
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_transcript_path: '/tmp/does-not-exist.jsonl',
        agent_type: 'worker',
        session_crons: [],
        agent_id: 'agent-1',
        background_tasks: [
          { id: 'agent-1', type: 'subagent', status: 'running', description: '当人' },
          { id: 'bg-agent-1', type: 'monitor', status: 'running', command: 'sleep 90' },
        ],
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
      expect(await stopped).toEqual({ continue: true });
    } finally {
      vi.useRealTimers();
    }
    await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-test-1' },
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    notify(rig, 'bg-test-1', 'completed', '完了');
    await settle();
  }

  it('⭐ 走っている最中に積まれた完了は、report（status は done）を出した後で push される（先に呼ぶと status が running に戻る）', async () => {
    const rig = await open();
    await queueFinishedOutput(rig);
    expect(first(rig).inputs).toHaveLength(1);
    say(rig, '畳む');
    result(rig, { text: '畳む', uuid: 'uuid-result-w1' });
    await settle();
    expect({
      order: rig.events
        .filter((event) => event.type === 'report' || event.type === 'note')
        .filter(
          (event) =>
            event.type === 'report' || event.text.includes('止まっていたマネージャーを起こした'),
        )
        .map((event) => event.type),
      reports: reportsOf(rig).map((report) => ({
        status: report.status,
        awaitingBackground: report.awaitingBackground,
      })),
      inputs: first(rig).inputs.length,
      pushed: (first(rig).inputs[1] ?? '').includes('alteroid が自動で送った知らせである（#1554）'),
    }).toMatchInlineSnapshot(`
      {
        "inputs": 2,
        "order": [
          "report",
          "note",
        ],
        "pushed": true,
        "reports": [
          {
            "awaitingBackground": undefined,
            "status": "done",
          },
        ],
      }
    `);
  });

  it('確認待ちが残る回（waiting_human）は起こさない（push されない）', async () => {
    const rig = await open();
    await queueFinishedOutput(rig);
    ask(rig);
    result(rig, { text: '確認をお願いします', uuid: 'uuid-result-w2' });
    await settle();
    expect({
      statuses: reportsOf(rig).map((report) => report.status),
      inputs: first(rig).inputs.length,
    }).toMatchInlineSnapshot(`
      {
        "inputs": 1,
        "statuses": [
          "waiting_human",
        ],
      }
    `);
  });

  it('report の emit が同期で投げたら、起こしは走らず（push されない）、セッションが閉じる', async () => {
    const rig = await open({ throwOn: (event) => event.type === 'report' });
    await queueFinishedOutput(rig);
    result(rig, { text: '畳む', uuid: 'uuid-result-w3' });
    // 投げた後にセッションが閉じる（`closed`）のは非同期で、いつ届くかが揺れる: 届くまで回す（実時間では待たない）
    for (let ticks = 0; ticks < 100 && !rig.events.some((e) => e.type === 'closed'); ticks += 1) {
      await tick();
    }
    expect({
      types: rig.events.filter((e) => e.type !== 'note').map((event) => event.type),
      inputs: first(rig).inputs.length,
    }).toMatchInlineSnapshot(`
      {
        "inputs": 1,
        "types": [
          "session",
          "tool_use",
          "tool_use",
          "context_usage",
          "report",
          "closed",
        ],
      }
    `);
  });
});

// 「`liveBackground` を取り込みの `await` より前に 1 回だけ読む」は、このファイルでは縛らない。SDK 由来の背景処理の一覧（`background_tasks_changed`）は
// `#read` が出来事を 1 件ずつ `await` して処理するので、`turn_ended` の取り込みの間には変わらない。変わりうるのは背景の peer が止まる経路だけで、
// それには Codex の app server のフェイクが要る（`runner-peer.test.ts` の作り）。読む位置を取り込みの後へ動かす変異は、この試験では赤くならない。
//
// `#deliverPeerNotices`（確認待ちの間に溜めた peer の知らせを、report の後でここで届ける）も、このファイルでは縛らない。
// 溜まるのは `waiting_human` の間だけで、`settle`（確認への答え）が同じ `#deliverPeerNotices` を呼んで先に届けるため、
// `turn_ended` から呼ばれる側が単独で効く入り口を、外から（Codex の app server のフェイクなしに）作れなかった。
// 削除する変異は、この試験では赤くならない。
