import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV, BASH_SHAPE_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession#onPreToolUse` の `Bash` ブロック（release-prod → 形の歯 → `off` 判定 → `inspectBashCommand` → 例外は確認へ倒す →
// blocked なら note → deny を返すか `guardAsk` を立てる）を、外から見える結果だけで縛る。
// 見るのは: フックが返す決定・`note` の全文と順・note が送られる周回・決定が返るまでの周回数・throw の伝わり方。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。
// 実時間では待たない（待つのはマイクロタスクの周回だけ）。

const stderrSpy = vi.hoisted(() => ({ lines: [] as string[], throwOnWrite: false }));

// 標準エラーへの書き込みだけを差し替える: `#tryObservation` が握った失敗の行を読み、書き込み自体が投げる場合を作るため。
vi.mock('./dropped-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dropped-record.js')>();
  return {
    ...actual,
    writeStderrLine: (line: string) => {
      stderrSpy.lines.push(line);
      if (stderrSpy.throwOnWrite) throw new Error('標準エラーが書けない（テスト用）');
    },
  };
});

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: { options: Options }[] } {
  const started: { options: Options }[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-guard-pin-');
  stderrSpy.lines = [];
  stderrSpy.throwOnWrite = false;
});

afterEach(async () => {
  stderrSpy.throwOnWrite = false;
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

interface Opened {
  hook: NonNullable<NonNullable<Options['hooks']>['PreToolUse']>[number]['hooks'][number];
  events: RunnerEvent[];
}

async function open(
  env: NodeJS.ProcessEnv,
  options: { throwOnNote?: boolean } = {},
): Promise<Opened> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (options.throwOnNote === true && event.type === 'note') {
        throw new Error('note の送り出しが落ちた（テスト用）');
      }
    },
    queryFn: fn,
    env,
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const hook = started[0]?.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  // 起動までに出た出来事・標準エラーは見ない
  events.length = 0;
  stderrSpy.lines = [];
  return { hook, events };
}

function fire(opened: Opened, input: Record<string, unknown>): Promise<HookJSONOutput> {
  return opened.hook(
    { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1', ...input } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

function bashInput(
  toolInput: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: toolInput, ...extra };
}

function decisionOf(result: HookJSONOutput): { decision: unknown; reason: unknown } {
  const output = (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
  return { decision: output?.permissionDecision, reason: output?.permissionDecisionReason };
}

// 起動直後の `session` は見ない（起動の完了と前後しうる）。note は全文を返す。
function eventLines(events: readonly RunnerEvent[]): string[] {
  return events
    .filter((event) => event.type !== 'session')
    .map((event) => (event.type === 'note' ? `note: ${event.text}` : event.type));
}

/** 長い理由の全文は表の末尾に 1 度だけ出し、各行は番号で指す（note は「前置き + 理由」の形なら前置きだけ残す）。 */
function abbreviate(
  reasons: string[],
  decision: { decision: unknown; reason: unknown },
  lines: readonly string[],
): { decision: unknown; reason: unknown; events: string[] } {
  let reasonRef: unknown = decision.reason;
  let events = [...lines];
  if (typeof decision.reason === 'string') {
    const reason = decision.reason;
    let index = reasons.indexOf(reason);
    if (index < 0) index = reasons.push(reason) - 1;
    reasonRef = `<reason#${index}>`;
    events = events.map((line) =>
      line.endsWith(reason) ? `${line.slice(0, -reason.length)}<reason#${index}>` : line,
    );
  }
  return { decision: decision.decision, reason: reasonRef, events };
}

interface Case {
  label: string;
  env: NodeJS.ProcessEnv;
  input: Record<string, unknown>;
}

/** 1 件ずつ新しい runner を立てて流し、返る決定と出来事の列を表にする。 */
async function runCases(cases: readonly Case[]): Promise<Record<string, unknown>> {
  const table: Record<string, unknown> = {};
  const reasons: string[] = [];
  for (const { label, env, input } of cases) {
    const opened = await open(env);
    const result = await fire(opened, input);
    table[label] = abbreviate(reasons, decisionOf(result), eventLines(opened.events));
    await host?.shutdown().catch(() => undefined);
    host = undefined;
  }
  return { cases: table, reasons };
}

const RELEASE_PROD = 'gh workflow run release-prod.yml';
const WAITING = 'tail -f /tmp/run.log';
const FD_DUP = 'pnpm test 2>&1';
const WORKER = { agent_id: 'agent-xyz', agent_type: 'worker' };
const SHAPE_ON = { [BASH_SHAPE_GUARD_ENV]: 'on' };

describe('release-prod（決定と note の全文・順）', () => {
  it('off でも確認に残り、deny 設定なら deny。作業者は actor が worker:。形の歯が on でも release-prod が先に当たる', async () => {
    expect(
      await runCases([
        { label: 'unset', env: {}, input: bashInput({ command: RELEASE_PROD }) },
        {
          label: 'ask',
          env: { [BASH_GUARD_ENV]: 'ask' },
          input: bashInput({ command: RELEASE_PROD }),
        },
        {
          label: 'off',
          env: { [BASH_GUARD_ENV]: 'off' },
          input: bashInput({ command: RELEASE_PROD }),
        },
        {
          label: 'deny',
          env: { [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: RELEASE_PROD }),
        },
        {
          label: 'off+worker',
          env: { [BASH_GUARD_ENV]: 'off' },
          input: bashInput({ command: RELEASE_PROD }, WORKER),
        },
        {
          label: 'shape-on+fd-dup',
          env: { ...SHAPE_ON, [BASH_GUARD_ENV]: 'off' },
          input: bashInput({ command: `${RELEASE_PROD} 2>&1` }),
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "cases": {
          "ask": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "off": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "off+worker": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（worker:mgr-1:worker・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "shape-on+fd-dup": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "unset": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
        },
        "reasons": [
          "本番デプロイ（release-prod）を起動する形である（\`gh workflow run … release-prod…\` / \`gh api …/workflows/…release-prod…/dispatches\`）。**取り返しがつきにくい**ので、確かめるまでは通さない。起動してよいか、いつ起動するか（夜の自動反映に任せてよいか）を確かめること。",
        ],
      }
    `);
  });
});

describe('形の歯（ALTEROID_BASH_SHAPE_GUARD）', () => {
  it('on なら ask / off 設定でも deny。off・未設定・空なら見ない', async () => {
    expect(
      await runCases([
        { label: 'on+unset', env: SHAPE_ON, input: bashInput({ command: FD_DUP }) },
        {
          label: 'on+ask',
          env: { ...SHAPE_ON, [BASH_GUARD_ENV]: 'ask' },
          input: bashInput({ command: FD_DUP }),
        },
        {
          label: 'on+off',
          env: { ...SHAPE_ON, [BASH_GUARD_ENV]: 'off' },
          input: bashInput({ command: FD_DUP }),
        },
        {
          label: 'on+deny',
          env: { ...SHAPE_ON, [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: FD_DUP }),
        },
        {
          label: 'on+worker',
          env: SHAPE_ON,
          input: bashInput({ command: FD_DUP }, WORKER),
        },
        {
          label: 'shape-off',
          env: { [BASH_SHAPE_GUARD_ENV]: 'off' },
          input: bashInput({ command: FD_DUP }),
        },
        {
          label: 'shape-empty',
          env: { [BASH_SHAPE_GUARD_ENV]: '' },
          input: bashInput({ command: FD_DUP }),
        },
        { label: 'shape-unset', env: {}, input: bashInput({ command: FD_DUP }) },
        {
          label: 'shape-on+wait-form(形の歯に掛からない待ち形は wait-guard)',
          env: SHAPE_ON,
          input: bashInput({ command: WAITING }),
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "cases": {
          "on+ask": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "on+deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "on+off": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "on+unset": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "on+worker": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（worker:mgr-1:worker・形=fd-dup）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "shape-empty": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "shape-off": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "shape-on+wait-form(形の歯に掛からない待ち形は wait-guard)": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=tail-f）。<reason#1>",
            ],
            "reason": "<reason#1>",
          },
          "shape-unset": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
        },
        "reasons": [
          "記述子の付け替え（\`2>&1\`・\`>&2\`）は通らないので、付け替えを外してそのまま打つこと（Bash の道具は標準エラーも一緒に返す）。止めたのはこの1回の呼び出しだけなので、上のとおり書き直して、依頼者の返事を待たずにそのまま続けること。迷ったら、1回の Bash では1つのコマンドだけを、変数を使わず絶対パスで打ち、出力はそのまま読む。",
          "\`tail -f\` / \`tail --follow\` はファイルの終端で止まらず追従し続ける（上限を付けるなら、その tail の直前に \`timeout <秒>\` を置くか、\`--pid=<待つ相手の pid>\` を付ける。#4976）（無限待ちの形）。代わりに次のいずれかを使うこと: (1) 起動した処理の完了を待つなら、待ち自体が終わる呼び出しにする （例: 対象の完了を返すコマンドを**前景で**。CI なら \`gh run watch <id> --exit-status\`）。 (2) 待ちに上限が要るなら \`timeout <秒> <コマンド>\` で自分から終わらせる。 (3) 完了通知を待つのではなく、成果物が在るかを前景の呼び出しで見に行く。 **確認に上がらない書き方の例**（上限があれば通る）: 回数で終わる \`for i in $(seq 60); do <条件> && break; sleep 5; done\`、外側の timeout で終わる \`timeout 300 bash -c 'until <条件>; do sleep 5; done'\`。",
        ],
      }
    `);
  });
});

describe('#bashGuard の off・ask・deny と run_in_background', () => {
  it('弾く待ち形は ask / deny、off は何もしない。note の文言は 確認に上げた / 弾いた', async () => {
    expect(
      await runCases([
        { label: 'unset', env: {}, input: bashInput({ command: WAITING }) },
        { label: 'ask', env: { [BASH_GUARD_ENV]: 'ask' }, input: bashInput({ command: WAITING }) },
        { label: 'off', env: { [BASH_GUARD_ENV]: 'off' }, input: bashInput({ command: WAITING }) },
        {
          label: 'deny',
          env: { [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: WAITING }),
        },
        {
          label: 'ask+worker',
          env: {},
          input: bashInput({ command: WAITING }, WORKER),
        },
        {
          label: 'deny+worker',
          env: { [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: WAITING }, WORKER),
        },
        { label: 'not-blocked', env: {}, input: bashInput({ command: 'echo hi' }) },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "cases": {
          "ask": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "ask+worker": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（worker:mgr-1:worker・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "deny+worker": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（worker:mgr-1:worker・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "not-blocked": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "off": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "unset": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
        },
        "reasons": [
          "\`tail -f\` / \`tail --follow\` はファイルの終端で止まらず追従し続ける（上限を付けるなら、その tail の直前に \`timeout <秒>\` を置くか、\`--pid=<待つ相手の pid>\` を付ける。#4976）（無限待ちの形）。代わりに次のいずれかを使うこと: (1) 起動した処理の完了を待つなら、待ち自体が終わる呼び出しにする （例: 対象の完了を返すコマンドを**前景で**。CI なら \`gh run watch <id> --exit-status\`）。 (2) 待ちに上限が要るなら \`timeout <秒> <コマンド>\` で自分から終わらせる。 (3) 完了通知を待つのではなく、成果物が在るかを前景の呼び出しで見に行く。 **確認に上がらない書き方の例**（上限があれば通る）: 回数で終わる \`for i in $(seq 60); do <条件> && break; sleep 5; done\`、外側の timeout で終わる \`timeout 300 bash -c 'until <条件>; do sleep 5; done'\`。",
        ],
      }
    `);
  });

  it('run_in_background が true のときだけ backgrounded（欠け・文字列 "true"・数値・false は前景）', async () => {
    const command = 'gh run watch 123 --exit-status 2>&1 | tail -60';
    const table = await runCases([
      { label: 'true', env: {}, input: bashInput({ command, run_in_background: true }) },
      { label: 'missing', env: {}, input: bashInput({ command }) },
      { label: 'string-true', env: {}, input: bashInput({ command, run_in_background: 'true' }) },
      { label: 'number-1', env: {}, input: bashInput({ command, run_in_background: 1 }) },
      { label: 'false', env: {}, input: bashInput({ command, run_in_background: false }) },
      {
        label: 'true+deny',
        env: { [BASH_GUARD_ENV]: 'deny' },
        input: bashInput({ command, run_in_background: true }),
      },
    ]);
    expect(table).toMatchInlineSnapshot(`
      {
        "cases": {
          "false": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "missing": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "number-1": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "string-true": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "true": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-run-watch-background）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
          "true+deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=gh-run-watch-background）。<reason#0>",
            ],
            "reason": "<reason#0>",
          },
        },
        "reasons": [
          "\`gh run watch\` を背景へ置いている（\`&\` か \`Bash\` の \`run_in_background\`）。**待ちが自分の手から外れる形**で、背景処理を残したまま作業者が畳むと、完了を待つ上限（30分）を超えた時点で打ち切られて委譲そのものが止まる（実測 2026-09-17: 作業者2人が同じ形で停止した）。代わりに次のいずれかを使うこと: (1) 前景で \`timeout <秒> gh run watch <id> --exit-status\` と書き、待ち自体に上限を持たせる。 (2) 上限付きのポーリングで確かめる（\`gh api repos/<owner>/<repo>/commits/<head_sha>/check-runs\` を回数の上限を先に決めて叩く。**head sha を明示すること** — PR 番号だけで引くと draft 中の \`skipped\` を緑と読む）。 ⚠️ どちらでも \`| tail\` / \`| head\` をチェーンの末尾に置かないこと —— パイプの終了コードは既定で最後のものなので、\`gh run watch\` が 404 で即死しても成功の顔で返る。",
        ],
      }
    `);
  });
});

describe('入力の形・Bash 以外', () => {
  it('tool_input が null・欠け・文字列・配列・command が文字列でないときは何も起きない。Bash 以外は弾く形でも何も起きない', async () => {
    expect(
      await runCases([
        { label: 'toolInput-null', env: SHAPE_ON, input: bashInput(null) },
        { label: 'toolInput-missing', env: SHAPE_ON, input: { tool_name: 'Bash' } },
        { label: 'toolInput-string', env: SHAPE_ON, input: bashInput(WAITING) },
        { label: 'toolInput-array', env: SHAPE_ON, input: bashInput([WAITING]) },
        { label: 'command-number', env: SHAPE_ON, input: bashInput({ command: 123 }) },
        { label: 'command-missing', env: SHAPE_ON, input: bashInput({}) },
        {
          label: 'command-array',
          env: SHAPE_ON,
          input: bashInput({ command: [RELEASE_PROD] }),
        },
        {
          label: 'tool-Read',
          env: SHAPE_ON,
          input: { tool_name: 'Read', tool_input: { command: RELEASE_PROD } },
        },
        {
          label: 'tool-missing',
          env: SHAPE_ON,
          input: { tool_input: { command: RELEASE_PROD } },
        },
        {
          label: 'tool-lowercase-bash',
          env: SHAPE_ON,
          input: { tool_name: 'bash', tool_input: { command: RELEASE_PROD } },
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "cases": {
          "command-array": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "command-missing": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "command-number": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "tool-Read": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "tool-lowercase-bash": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "tool-missing": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "toolInput-array": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "toolInput-missing": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "toolInput-null": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "toolInput-string": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
        },
        "reasons": [],
      }
    `);
  });
});

describe('判定が例外で終わる（不正な ALTEROID_BASH_SHAPE_GUARD）', () => {
  const BAD = { [BASH_SHAPE_GUARD_ENV]: 'yes' };

  it('deny 設定なら deny、それ以外は ask。判定の順（release-prod → 形の歯 → off 判定）も固定する。例外のときは note を出さない', async () => {
    expect(
      await runCases([
        { label: 'unset', env: BAD, input: bashInput({ command: 'echo hi' }) },
        {
          label: 'ask',
          env: { ...BAD, [BASH_GUARD_ENV]: 'ask' },
          input: bashInput({ command: 'echo hi' }),
        },
        {
          label: 'off(形の歯の評価は off 判定より先)',
          env: { ...BAD, [BASH_GUARD_ENV]: 'off' },
          input: bashInput({ command: 'echo hi' }),
        },
        {
          label: 'deny',
          env: { ...BAD, [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: 'echo hi' }),
        },
        {
          label: 'ask+multiline-message(2行目以降は理由に出ない)',
          env: { ...BAD, [BASH_SHAPE_GUARD_ENV]: 'yes\nsecond line' },
          input: bashInput({ command: 'echo hi' }),
        },
        {
          label: 'release-prod(当たれば形の歯を評価しないので投げない)',
          env: BAD,
          input: bashInput({ command: RELEASE_PROD }),
        },
        {
          label: 'release-prod+deny',
          env: { ...BAD, [BASH_GUARD_ENV]: 'deny' },
          input: bashInput({ command: RELEASE_PROD }),
        },
        { label: 'command-not-string(評価に入らない)', env: BAD, input: bashInput({ command: 1 }) },
        {
          label: 'tool-Read(評価に入らない)',
          env: BAD,
          input: { tool_name: 'Read', tool_input: {} },
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "cases": {
          "ask": {
            "decision": "ask",
            "events": [],
            "reason": "<reason#0>",
          },
          "ask+multiline-message(2行目以降は理由に出ない)": {
            "decision": "ask",
            "events": [],
            "reason": "<reason#2>",
          },
          "command-not-string(評価に入らない)": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "deny": {
            "decision": "deny",
            "events": [],
            "reason": "<reason#1>",
          },
          "off(形の歯の評価は off 判定より先)": {
            "decision": "ask",
            "events": [],
            "reason": "<reason#0>",
          },
          "release-prod(当たれば形の歯を評価しないので投げない)": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#3>",
            ],
            "reason": "<reason#3>",
          },
          "release-prod+deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=gh-release-prod）。<reason#3>",
            ],
            "reason": "<reason#3>",
          },
          "tool-Read(評価に入らない)": {
            "decision": undefined,
            "events": [],
            "reason": undefined,
          },
          "unset": {
            "decision": "ask",
            "events": [],
            "reason": "<reason#0>",
          },
        },
        "reasons": [
          "Bash のガードの判定が例外で終わったので、安全側で確認に上げた（Error: ALTEROID_BASH_SHAPE_GUARD の値が不正: yes（使えるのは on / off。既定は off））。形を変えずに打ち直さず、依頼者へ報告すること。",
          "Bash のガードの判定が例外で終わったので、安全側で拒否した（Error: ALTEROID_BASH_SHAPE_GUARD の値が不正: yes（使えるのは on / off。既定は off））。形を変えずに打ち直さず、依頼者へ報告すること。",
          "Bash のガードの判定が例外で終わったので、安全側で確認に上げた（Error: ALTEROID_BASH_SHAPE_GUARD の値が不正: yes）。形を変えずに打ち直さず、依頼者へ報告すること。",
          "本番デプロイ（release-prod）を起動する形である（\`gh workflow run … release-prod…\` / \`gh api …/workflows/…release-prod…/dispatches\`）。**取り返しがつきにくい**ので、確かめるまでは通さない。起動してよいか、いつ起動するか（夜の自動反映に任せてよいか）を確かめること。",
        ],
      }
    `);
  });
});

describe('throw の伝わり方', () => {
  it('note の送り出しが同期で投げても決定は変わらず、標準エラーへ 1 行残る（ask・deny・形の歯の deny）', async () => {
    const results: Record<string, unknown> = {};
    const reasons: string[] = [];
    for (const [label, env, command] of [
      ['ask', {}, WAITING],
      ['deny', { [BASH_GUARD_ENV]: 'deny' }, WAITING],
      ['shape-deny', SHAPE_ON, FD_DUP],
      ['release-prod-ask', { [BASH_GUARD_ENV]: 'off' }, RELEASE_PROD],
    ] as const) {
      const opened = await open(env, { throwOnNote: true });
      const result = await fire(opened, bashInput({ command }));
      results[label] = {
        ...abbreviate(reasons, decisionOf(result), eventLines(opened.events)),
        stderr: stderrSpy.lines,
      };
      await host?.shutdown().catch(() => undefined);
      host = undefined;
    }
    expect({ results, reasons }).toMatchInlineSnapshot(`
      {
        "reasons": [
          "\`tail -f\` / \`tail --follow\` はファイルの終端で止まらず追従し続ける（上限を付けるなら、その tail の直前に \`timeout <秒>\` を置くか、\`--pid=<待つ相手の pid>\` を付ける。#4976）（無限待ちの形）。代わりに次のいずれかを使うこと: (1) 起動した処理の完了を待つなら、待ち自体が終わる呼び出しにする （例: 対象の完了を返すコマンドを**前景で**。CI なら \`gh run watch <id> --exit-status\`）。 (2) 待ちに上限が要るなら \`timeout <秒> <コマンド>\` で自分から終わらせる。 (3) 完了通知を待つのではなく、成果物が在るかを前景の呼び出しで見に行く。 **確認に上がらない書き方の例**（上限があれば通る）: 回数で終わる \`for i in $(seq 60); do <条件> && break; sleep 5; done\`、外側の timeout で終わる \`timeout 300 bash -c 'until <条件>; do sleep 5; done'\`。",
          "記述子の付け替え（\`2>&1\`・\`>&2\`）は通らないので、付け替えを外してそのまま打つこと（Bash の道具は標準エラーも一緒に返す）。止めたのはこの1回の呼び出しだけなので、上のとおり書き直して、依頼者の返事を待たずにそのまま続けること。迷ったら、1回の Bash では1つのコマンドだけを、変数を使わず絶対パスで打ち、出力はそのまま読む。",
          "本番デプロイ（release-prod）を起動する形である（\`gh workflow run … release-prod…\` / \`gh api …/workflows/…release-prod…/dispatches\`）。**取り返しがつきにくい**ので、確かめるまでは通さない。起動してよいか、いつ起動するか（夜の自動反映に任せてよいか）を確かめること。",
        ],
        "results": {
          "ask": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
            "stderr": [
              "alteroid: ガードの note の送り出しが失敗した（判定は続ける）: Error: note の送り出しが落ちた（テスト用）
      ",
            ],
          },
          "deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=tail-f）。<reason#0>",
            ],
            "reason": "<reason#0>",
            "stderr": [
              "alteroid: ガードの note の送り出しが失敗した（判定は続ける）: Error: note の送り出しが落ちた（テスト用）
      ",
            ],
          },
          "release-prod-ask": {
            "decision": "ask",
            "events": [
              "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-release-prod）。<reason#2>",
            ],
            "reason": "<reason#2>",
            "stderr": [
              "alteroid: ガードの note の送り出しが失敗した（判定は続ける）: Error: note の送り出しが落ちた（テスト用）
      ",
            ],
          },
          "shape-deny": {
            "decision": "deny",
            "events": [
              "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。<reason#1>",
            ],
            "reason": "<reason#1>",
            "stderr": [
              "alteroid: ガードの note の送り出しが失敗した（判定は続ける）: Error: note の送り出しが落ちた（テスト用）
      ",
            ],
          },
        },
      }
    `);
  });

  it('標準エラーの書き込みまで投げる（握る側の後始末が落ちる）と、決定は返らず #onPreToolUse の拒否（フックの rejection）として伝わる', async () => {
    const opened = await open({ [BASH_GUARD_ENV]: 'deny' }, { throwOnNote: true });
    stderrSpy.throwOnWrite = true;
    await expect(fire(opened, bashInput({ command: WAITING }))).rejects.toThrow(
      '標準エラーが書けない（テスト用）',
    );
  });

  it('note が投げない対照では、同じ入力が決定を返す', async () => {
    const opened = await open({ [BASH_GUARD_ENV]: 'deny' });
    stderrSpy.throwOnWrite = true;
    expect(decisionOf(await fire(opened, bashInput({ command: WAITING }))).decision).toBe('deny');
  });
});

describe('同期のまま保つ（note が送られる周回と、決定が返るまでの周回数）', () => {
  /** フックを呼んだ直後（await を 1 度も挟まない）に出ていた出来事と、promise が決着するまでの `await Promise.resolve()` の回数。 */
  async function measure(
    env: NodeJS.ProcessEnv,
    input: Record<string, unknown>,
  ): Promise<{ eventsAtCall: string[]; ticksToSettle: number; settled: string }> {
    const opened = await open(env);
    const promise = fire(opened, input);
    // 全文は他の表で縛っている。ここは「出ていたか・何件か・どの note か」だけを見る
    const eventsAtCall = eventLines(opened.events).map((line) => line.slice(0, 48));
    let outcome = 'pending';
    promise.then(
      (result) => {
        outcome = String(decisionOf(result).decision);
      },
      () => {
        outcome = 'rejected';
      },
    );
    let ticks = 0;
    while (outcome === 'pending' && ticks < 100) {
      await Promise.resolve();
      ticks += 1;
    }
    await host?.shutdown().catch(() => undefined);
    host = undefined;
    return { eventsAtCall, ticksToSettle: ticks, settled: outcome };
  }

  it('呼んだ周回のうちに note が出ている（deny・ask・形の歯）。決定が返るまでの周回数は blocked かどうかで変わらない', async () => {
    expect({
      deny: await measure({ [BASH_GUARD_ENV]: 'deny' }, bashInput({ command: WAITING })),
      ask: await measure({}, bashInput({ command: WAITING })),
      shape: await measure(SHAPE_ON, bashInput({ command: FD_DUP })),
      releaseProd: await measure({ [BASH_GUARD_ENV]: 'off' }, bashInput({ command: RELEASE_PROD })),
      exception: await measure(
        { [BASH_SHAPE_GUARD_ENV]: 'yes' },
        bashInput({ command: 'echo hi' }),
      ),
      pass: await measure({}, bashInput({ command: 'echo hi' })),
      notBash: await measure({}, { tool_name: 'Read', tool_input: {} }),
    }).toMatchInlineSnapshot(`
      {
        "ask": {
          "eventsAtCall": [
            "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=tail-f）。",
          ],
          "settled": "ask",
          "ticksToSettle": 3,
        },
        "deny": {
          "eventsAtCall": [
            "note: Bash の呼び出しを弾いた（manager:mgr-1・形=tail-f）。\`ta",
          ],
          "settled": "deny",
          "ticksToSettle": 3,
        },
        "exception": {
          "eventsAtCall": [],
          "settled": "ask",
          "ticksToSettle": 3,
        },
        "notBash": {
          "eventsAtCall": [],
          "settled": "undefined",
          "ticksToSettle": 3,
        },
        "pass": {
          "eventsAtCall": [],
          "settled": "undefined",
          "ticksToSettle": 3,
        },
        "releaseProd": {
          "eventsAtCall": [
            "note: Bash の呼び出しを確認に上げた（manager:mgr-1・形=gh-relea",
          ],
          "settled": "ask",
          "ticksToSettle": 3,
        },
        "shape": {
          "eventsAtCall": [
            "note: Bash の呼び出しを弾いた（manager:mgr-1・形=fd-dup）。記述子",
          ],
          "settled": "deny",
          "ticksToSettle": 3,
        },
      }
    `);
  });
});
