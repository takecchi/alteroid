import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { captureStderr } from './testing.js';

// `RunnerSession#applyTurnEnded` の「失敗分類の前半」（`usage_notice` の送出・分類できなかった失敗の跡・鍵の置き場の案内の判定）を、
// 外から見える結果だけで縛る。入口は SDK の `result`（と、その前の `assistant.error`）。
// 見るのは: `usage_notice` の全文・報告（`report`）の本文と failure・stderr に出る「分類できなかった」の跡（初出と、停止時の合計）・
// 出来事が出る周回数・emit が同期で投げたときの伝わり方。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。
// 実時間では待たない（待つのはマイクロタスクの周回と `setTimeout(0)` だけ）。

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const NOT_LOGGED_IN = 'Not logged in · Please run /login';

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
  dir = makeTempDirSync('alteroid-runner-failure-classify-pin-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
}

async function open(
  options: { withCredentialStore?: boolean; throwOn?: (event: RunnerEvent) => boolean } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  let thrown = false;
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
    env: {},
    ...(options.withCredentialStore === true
      ? { credentials: createCredentialStore({ dir, seed: {} }) }
      : {}),
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started: first, events, host };
}

function assistant(rig: Rig, text: string, error?: string): void {
  rig.started.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: 'sess-mgr',
    uuid: `uuid-say-${text.length}`,
    ...(error === undefined ? {} : { error }),
  } as unknown as SDKMessage);
}

function result(
  rig: Rig,
  fields: { text: string; isError?: boolean; subtype?: string; errors?: string[] },
): void {
  rig.started.push({
    type: 'result',
    subtype: fields.subtype ?? 'success',
    result: fields.text,
    session_id: 'sess-mgr',
    uuid: 'uuid-result',
    ...(fields.isError === undefined ? {} : { is_error: fields.isError }),
    ...(fields.errors === undefined ? {} : { errors: fields.errors }),
  } as unknown as SDKMessage);
}

/** `usage_notice` は全文、`report` は本文と failure と status、「分類できなかった」の stderr の行は全文。 */
function view(events: readonly RunnerEvent[], stderr: readonly string[]): unknown[] {
  return [
    ...events.flatMap((event): unknown[] => {
      if (event.type === 'usage_notice') return [event];
      if (event.type === 'report') {
        return [{ report: event.text, status: event.status, failure: event.failure }];
      }
      return [];
    }),
    ...traceLines(stderr),
  ];
}

/** 行頭の時刻は揺れるので落とす。 */
function traceLines(stderr: readonly string[]): string[] {
  return stderr
    .filter((line) => line.includes('枠の文言として分類できなかった'))
    .map((line) => line.replace(/^(alteroid: )\S+ /, '$1'));
}

/** 結果を押して外へ出るまで回し、停止して合計の行まで出す。 */
async function scenario(
  options: { withCredentialStore?: boolean },
  body: (rig: Rig) => void,
): Promise<unknown[]> {
  let rig: Rig | undefined;
  const lines = await captureStderr(async () => {
    rig = await open(options);
    body(rig);
    await tick();
    await tick();
    await rig.host.stop('mgr-1');
  });
  if (rig === undefined) throw new Error('rig が無い');
  return view(rig.events, lines);
}

describe('失敗が無い（failure === undefined）なら何もしない', () => {
  it('成功した結果は、本文や errors が上限や Not logged in の文面でも、usage_notice も跡も案内も出さない', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, { text: NOT_LOGGED_IN, errors: [ORG_SPEND_LIMIT] });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": undefined,
          "report": "Not logged in · Please run /login",
          "status": "done",
        },
      ]
    `);
  });
});

describe('分類できた失敗（usage_notice を出し、跡も案内も残さない）', () => {
  it('failure.text（result の本文）から分類できる: usage_notice の全文が出る。errors に Not logged in があっても案内は付かない', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, { text: ORG_SPEND_LIMIT, isError: true, errors: [NOT_LOGGED_IN] });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "managerId": "mgr-1",
          "notice": {
            "kind": "reached",
            "text": "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          },
          "type": "usage_notice",
        },
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          "status": "done",
        },
      ]
    `);
  });

  it('event.errorLines から分類できる（failure.text は空）', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, { text: '', isError: true, errors: ['関係ない行', ORG_SPEND_LIMIT] });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "managerId": "mgr-1",
          "notice": {
            "kind": "reached",
            "text": "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          },
          "type": "usage_notice",
        },
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      （報告なし）",
          "status": "done",
        },
      ]
    `);
  });

  it('assistant.error で止まった回（result は成功で返る）でも、failure.text から分類できる', async () => {
    const out = await scenario({}, (rig) => {
      assistant(rig, ORG_SPEND_LIMIT, 'billing_error');
      result(rig, { text: '' });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "managerId": "mgr-1",
          "notice": {
            "kind": "reached",
            "text": "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          },
          "type": "usage_notice",
        },
        {
          "failure": {
            "code": "billing_error",
            "via": "assistant_error",
          },
          "report": "（このターンは応答を返さずに終わった: billing_error / assistant_error）
      You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          "status": "done",
        },
      ]
    `);
  });

  it('マネージャーの本文 said に上限の文面があっても、失敗が別の理由なら分類に通さない', async () => {
    const out = await scenario({}, (rig) => {
      assistant(rig, ORG_SPEND_LIMIT);
      result(rig, { text: '落ちた', isError: true });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      落ちた

      （失敗する前に出ていた本文）
      You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_is_error code=success
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_is_error:success×1
      ",
      ]
    `);
  });
});

describe('分類できなかった失敗（noteUnclassifiedFailure と、鍵の置き場の案内）', () => {
  it('failure.text に Not logged in: 鍵の器が無いと案内が付く。跡は via・code の組で初出に1行と、停止時の合計', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, { text: NOT_LOGGED_IN, isError: true });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      Not logged in · Please run /login

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_is_error code=success
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_is_error:success×1
      ",
      ]
    `);
  });

  it('同じ条件で鍵の器が在れば、案内は付かないが跡は残る', async () => {
    const out = await scenario({ withCredentialStore: true }, (rig) => {
      result(rig, { text: NOT_LOGGED_IN, isError: true });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      Not logged in · Please run /login",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_is_error code=success
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_is_error:success×1
      ",
      ]
    `);
  });

  it('errorLines だけに Not logged in がある（failure.text は空）: 案内が付く', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, {
        text: '',
        isError: true,
        subtype: 'error_during_execution',
        errors: ['x', NOT_LOGGED_IN],
      });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "error_during_execution",
            "via": "result_subtype",
          },
          "report": "（このターンは応答を返さずに終わった: error_during_execution / result_subtype）
      （結果なしで終了: error_during_execution）

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_subtype code=error_during_execution
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_subtype:error_during_execution×1
      ",
      ]
    `);
  });

  it('failure.text だけに Not logged in がある（assistant.error の本文。result の本文は空）: 案内が付く', async () => {
    const out = await scenario({}, (rig) => {
      assistant(rig, NOT_LOGGED_IN, 'authentication_failed');
      result(rig, { text: '' });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "authentication_failed",
            "via": "assistant_error",
          },
          "report": "（このターンは応答を返さずに終わった: authentication_failed / assistant_error）
      Not logged in · Please run /login

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=assistant_error code=authentication_failed
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 assistant_error:authentication_failed×1
      ",
      ]
    `);
  });

  it('resultTextOf(event).text だけに Not logged in がある（failure は assistant.error の別の本文）: 案内が付く', async () => {
    const out = await scenario({}, (rig) => {
      assistant(rig, '別の理由', 'unknown');
      result(rig, { text: NOT_LOGGED_IN });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "unknown",
            "via": "assistant_error",
          },
          "report": "（このターンは応答を返さずに終わった: unknown / assistant_error）
      別の理由

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=assistant_error code=unknown
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 assistant_error:unknown×1
      ",
      ]
    `);
  });

  it('Not logged in の語が無い失敗: 案内は付かず、跡だけ残る（assistant.error の経路で via・code が変わる）', async () => {
    const out = await scenario({}, (rig) => {
      assistant(rig, '別の理由', 'unknown');
      result(rig, { text: '' });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "unknown",
            "via": "assistant_error",
          },
          "report": "（このターンは応答を返さずに終わった: unknown / assistant_error）
      別の理由",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=assistant_error code=unknown
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 assistant_error:unknown×1
      ",
      ]
    `);
  });

  it('大文字小文字を区別しない（NOT LOGGED IN）', async () => {
    const out = await scenario({}, (rig) => {
      result(rig, { text: 'NOT LOGGED IN', isError: true });
    });
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "failure": {
            "code": "success",
            "via": "result_is_error",
          },
          "report": "（このターンは応答を返さずに終わった: success / result_is_error）
      NOT LOGGED IN

      鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。\`ALTEROID_CREDENTIAL_DIR\` 付きの runner（apps/runner）を別に起こし、デーモンの \`ALTEROID_RUNNER_URL\` で繋ぐこと。",
          "status": "done",
        },
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_is_error code=success
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_is_error:success×1
      ",
      ]
    `);
  });

  it('同じ組が2回続いたら、跡の行は初出の1回だけで、合計が×2になる', async () => {
    let rig: Rig | undefined;
    const lines = await captureStderr(async () => {
      rig = await open();
      result(rig, { text: '', isError: true });
      await tick();
      await tick();
      rig.started.push({
        type: 'result',
        subtype: 'success',
        result: '',
        is_error: true,
        session_id: 'sess-mgr',
        uuid: 'uuid-result-2',
      } as unknown as SDKMessage);
      await tick();
      await tick();
      await rig.host.stop('mgr-1');
    });
    if (rig === undefined) throw new Error('rig が無い');
    expect(traceLines(lines)).toMatchInlineSnapshot(`
      [
        "alteroid: SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: manager=mgr-1 via=result_is_error code=success
      ",
        "alteroid: SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: manager=mgr-1 result_is_error:success×2
      ",
      ]
    `);
  });
});

describe('出来事が出る周回数と、emit が投げたときの伝わり方', () => {
  it('usage_notice と report が見える周回数（`await #observeContextUsage` の後の同じ周回）', async () => {
    const rig = await open();
    result(rig, { text: ORG_SPEND_LIMIT, isError: true });
    const seenAt: Record<string, number> = {};
    for (let ticks = 0; ticks < 200 && Object.keys(seenAt).length < 2; ticks += 1) {
      await Promise.resolve();
      for (const event of rig.events) {
        if (event.type === 'usage_notice' || event.type === 'report') seenAt[event.type] ??= ticks;
      }
    }
    expect(seenAt).toMatchInlineSnapshot(`
      {
        "report": 3,
        "usage_notice": 3,
      }
    `);
  });

  it('usage_notice の emit が同期で投げると、report は出ず、セッションが閉じる（その後ろの処理は走らない）', async () => {
    let rig: Rig | undefined;
    const lines = await captureStderr(async () => {
      rig = await open({ throwOn: (event) => event.type === 'usage_notice' });
      result(rig, { text: ORG_SPEND_LIMIT, isError: true });
      // 投げた後にセッションが閉じる（`closed`）のは非同期で、いつ届くかが揺れる: 届くまで回す（実時間では待たない）
      for (let ticks = 0; ticks < 100 && !rig.events.some((e) => e.type === 'closed'); ticks += 1) {
        await tick();
      }
    });
    if (rig === undefined) throw new Error('rig が無い');
    expect({
      types: rig.events.map((event) => event.type),
      stderr: lines.filter((line) => line.includes('emit が落ちた')).length > 0,
    }).toMatchInlineSnapshot(`
      {
        "stderr": false,
        "types": [
          "session",
          "context_usage",
          "usage_notice",
          "closed",
        ],
      }
    `);
  });
});
