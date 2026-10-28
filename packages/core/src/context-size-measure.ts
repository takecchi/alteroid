/**
 * クローンの1ターンに載る文脈の量を、種類ごとに測る道具（#5469 P0）。
 *
 * 手で文字列を再現しない: 本物の `createClone` を偽の SDK（`queryFn`）で動かし、
 * (1) SDK へ渡ったシステムプロンプトと道具、(2) ターンごとに SDK へ押し込まれた入力そのもの、を取る。
 * ターンの入力の内訳は `composeTurnInputText` と `buildActivityDigest` を包んで取る（包みは `context-size-measure.test.ts` の `vi.mock`）。
 * 取れないもの（SDK 本体の組み込み道具・CLAUDE.md・skills の一覧・会話の履歴）は測らず、出力の表に「測れなかった」と書く。
 *
 * **試験専用（本番へ出さない）。** `clone-test-harness.ts` 経由で vitest を引くので、本番の入口（`index.ts`・`tsup.config.ts` の entry・`package.json` の exports）から
 * 辿れてはならない。辿れないことは `context-size-measure.test.ts` の「本番の入口から引かれない」が確かめる。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { fakeSdk, waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { seedCommitments, seedJobs, seedJournal, seedMemory } from './context-size-fixtures.js';
import { contextSizeRecorder } from './context-size-recorder.js';
import type { MemoryFixtureSize } from './context-size-fixtures.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { buildSelfKnowledge } from './self.js';
import type { SelfFacts } from './self.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer, qualifiedToolName } from './tools.js';
import type { ToolContext } from './tools.js';
import type { Stores } from './store.js';

/**
 * トークンの近似に使う UTF-8 のバイト数 / トークン。
 * 依存に実トークナイザが無いので近似である（日本語は 1 字 3 バイトで約 1〜1.5 トークン、英語は 1 バイト 1 字で約 4 字 1 トークン。混在なので ±30% は見込む）。
 */
export const APPROX_BYTES_PER_TOKEN = 3;

export interface Size {
  chars: number;
  bytes: number;
  /** `bytes / APPROX_BYTES_PER_TOKEN` の切り上げ。実トークンではない。 */
  tokens: number;
}

export function sizeOf(text: string): Size {
  const bytes = Buffer.byteLength(text, 'utf8');
  return { chars: text.length, bytes, tokens: Math.ceil(bytes / APPROX_BYTES_PER_TOKEN) };
}

export function addSizes(...sizes: readonly Size[]): Size {
  const chars = sizes.reduce((sum, size) => sum + size.chars, 0);
  const bytes = sizes.reduce((sum, size) => sum + size.bytes, 0);
  return { chars, bytes, tokens: Math.ceil(bytes / APPROX_BYTES_PER_TOKEN) };
}

export type TurnKind = 'human' | 'report' | 'timer' | 'initiative';

export const TURN_KIND_LABELS: Record<TurnKind, string> = {
  human: '人間の発言',
  report: 'マネージャーの報告',
  timer: '定期の tick（timer）',
  initiative: '発意の tick（self_initiative）',
};

export interface FixtureConfig {
  memory: MemoryFixtureSize;
  /** 台帳の未了の件数（最古は 30 日前）。 */
  commitments: number;
  /** 委譲（Job）の件数。 */
  jobs: number;
  /** 直近 24 時間の日誌の行数（digest の材料）。 */
  journalRows: number;
  /** 人間の発言の字数。 */
  humanChars: number;
  /** マネージャーの報告 1 件の字数（上限は 8,000）。 */
  reportChars: number;
}

export const BASELINE: FixtureConfig = {
  memory: 'cap',
  commitments: 327,
  jobs: 40,
  journalRows: 200,
  humanChars: 80,
  reportChars: 1_500,
};

const SELF_FACTS: SelfFacts = {
  storage: 'PostgreSQL（Railway）',
  local: '/data/alteroid（state のみ）',
  workspace: '/work',
  cwd: '/data/alteroid/clone',
  runner: 'ローカル runner 1 台',
  entrypoint: 'https://alteroid.example.invalid',
  auth: 'トークン認証',
  models: { clone: 'opus' },
};

export interface TurnSample {
  kind: TurnKind;
  /** 同じ種類の何本目のターンか。1 = セッション最初（固定文は全文）、2 以降 = 同じ会話の続き（固定文は参照に畳まれる）。 */
  ordinal: number;
  /** SDK へ押し込まれた入力そのもの。 */
  total: Size;
  /** `composeTurnInputText` の欄ごと（空欄は含めない）。 */
  parts: Record<string, Size>;
  /** 欄に入らない後付け（記憶の差分・人間の操作の断り書き。`#withFreshMemory` / `#withHumanActions`）。 */
  extra: Size;
  /** この回に組まれた digest の生の長さ（会話の履歴に載せるために差分へ畳む前。呼ばれなければ空）。 */
  digestsBuilt: { shape: string; size: Size }[];
}

export interface SessionSample {
  /** SDK へ渡ったシステムプロンプト全体。 */
  systemPrompt: Size;
  /** うち記憶の索引（`renderMemoryDocuments` の結果）。 */
  memory: Size;
  /** うち自己認識（`buildSelfKnowledge`）。 */
  self: Size;
  /** 残り = テンプレート本体（と節の継ぎ目）。引き算で出す。 */
  template: Size;
  /** システムプロンプトが記憶の索引・自己認識の文字列をそのまま含むか（引き算で出した内訳が、実在する部分文字列の分け方になっている確認）。 */
  contains: { memory: boolean; self: boolean };
}

export interface ToolsSample {
  count: number;
  /** `tools/list` の応答に載る、道具1本ごとの name + description + inputSchema（JSON）。 */
  definitions: Size;
  descriptionsOnly: Size;
  inputSchemasOnly: Size;
  /** 名前だけの一覧（ToolSearch が MCP の道具を deferred にしたとき、一覧に載る形の下限）。`mcp__alteroid__` 付き、改行区切り。 */
  namesOnly: Size;
  serverInstructions: Size;
  /** 大きい順の上位。 */
  largest: { name: string; size: Size }[];
}

function eventFor(kind: TurnKind, index: number, config: FixtureConfig): InboxEvent {
  const at = new Date().toISOString();
  switch (kind) {
    case 'human':
      return {
        ...humanMessage(
          `${String(index)} 件目の依頼です。${'確認してもらえますか。'.repeat(Math.ceil(config.humanChars / 11))}`.slice(
            0,
            config.humanChars,
          ),
        ),
        id: `evt-human-${String(index)}`,
        at,
      };
    case 'report':
      return {
        type: 'manager_message',
        id: `evt-report-${String(index)}`,
        at,
        managerId: `mgr-${String(100 + ((3 + 10 * index) % Math.max(config.jobs, 1)))}`,
        kind: 'report',
        text: `${'報告: 調査と実装が終わった。差分と検証結果は次のとおり。'.repeat(Math.ceil(config.reportChars / 28))}`.slice(
          0,
          config.reportChars,
        ),
      };
    case 'timer':
      return {
        type: 'timer',
        id: `evt-timer-${String(index)}`,
        at,
        kind: 'issue-round',
        cause: 'manual',
      };
    case 'initiative':
      return {
        type: 'self_initiative',
        id: `evt-initiative-${String(index)}`,
        at,
        reason: '定期 tick: 記憶にある目的から次にやることを決める',
      };
  }
}

async function buildStores(config: FixtureConfig, now: number): Promise<Stores> {
  const stores = createMemoryStores();
  await seedMemory(stores, config.memory);
  await seedCommitments(stores, config.commitments, now);
  await seedJobs(stores, config.jobs, now);
  await seedJournal(stores, config.journalRows);
  await stores.schedules.put({
    kind: 'issue-round',
    spec: { type: 'daily', at: '09:00' },
    request: 'open issue を見て、着手できるものから進める',
    createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return stores;
}

/** ターンの間に状態を動かす: 日誌 20 行・委譲 5 本の状態・台帳 5 件。何本動くかは仮定（本番の動き方は測っていない）。 */
async function churnState(stores: Stores, now: number): Promise<void> {
  await seedJournal(stores, 20);
  const at = new Date(now + 1_000).toISOString();
  for (let index = 0; index < 5; index += 1) {
    const job = await stores.jobs.getJob(`mgr-${String(100 + index)}`);
    if (job === null) continue;
    await stores.jobs.putJob({
      ...job,
      status: job.status === 'running' ? 'done' : 'running',
      updatedAt: at,
      lastReportAt: at,
    });
  }
  await seedCommitments(stores, 5, now, 0, 'churn-');
}

interface BootedClone {
  clone: CloneHost;
  stores: Stores;
  calls: ReturnType<typeof fakeSdk>['calls'];
  toolContext(): ToolContext | undefined;
}

function bootClone(stores: Stores): BootedClone {
  // 使用量の観測を返す: 返さないと「要約が走るか確かめられない」として固定文が毎回全文に戻り（`#fullReasonThisTurn` の `usage_null`）、本番の定常より大きく出る。
  // 閾値から遠い値（要約が走らない定常）にしている。要約が走る回・走った直後の全文は測っていない
  const { fn, calls } = fakeSdk(() => 'ok', {
    getContextUsage: () => ({
      categories: [],
      totalTokens: 60_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 6,
      autoCompactThreshold: 900_000,
      isAutoCompactEnabled: true,
    }),
  });
  let captured: ToolContext | undefined;
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    self: SELF_FACTS,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
  });
  return { clone, stores, calls, toolContext: () => captured };
}

export interface ScenarioResult {
  session: SessionSample;
  turns: TurnSample[];
  tools: ToolsSample;
  /** SDK へ押し込まれた入力の本文そのもの（表の根拠を後から読み直すため）。 */
  inputs: string[];
}

/**
 * 1 つの条件で、同じ種類のターンを 3 本続けて回し、入力を取る。
 * 別のターンを間に挟まない: 固定文の畳み（2 回目から参照）は直前の入力の履歴に依存するため、種類ごとに独立した会話で測る。
 * 1 本目 = 全文、2 本目 = 状態が1本目から動いていない（畳みが最もよく効く側）、3 本目 = 2 本目と3本目の間に状態を動かした（`churn`）。
 * 本番の定常は 2 本目と 3 本目の間にある。
 */
export async function measureKind(kind: TurnKind, config: FixtureConfig): Promise<ScenarioResult> {
  const turns = 3;
  contextSizeRecorder.reset();
  const now = Date.now();
  const stores = await buildStores(config, now);
  // 積んだ日誌の最後の行の時刻より、器の起動の時刻を必ず後ろにする: 同じミリ秒だと「起きる前の活動」として数えられず（`distill-gap.ts` の `at < until`）、
  // 1 本目の入力から「蒸留が移りきっていない」の断り書き（約 600 字）が出たり出なかったりして、同じ条件の測りが揺れる。時間に賭けず、時計が進むのを条件にして待つ
  const seededAt = Date.now();
  while (Date.now() <= seededAt) {
    // 時計が次のミリ秒へ進むまで（高々 1ms）
  }
  const booted = bootClone(stores);
  const samples: TurnSample[] = [];
  try {
    for (let index = 1; index <= turns; index += 1) {
      if (index === 3) await churnState(stores, now);
      booted.clone.post(eventFor(kind, index, config));
      await waitFor(
        () =>
          (booted.calls.find((candidate) => candidate.kind === 'session')?.inputs.length ?? 0) >=
            index && booted.clone.activeTurn?.() === null,
        `${kind} の ${String(index)} 本目のターンが終わる`,
      );
      // 時間では待たない: 次の合図が前の束に混ざれば、下の「入力の本数が合わない」が声を出して落ちる
    }
    const call = booted.calls.find((candidate) => candidate.kind === 'session');
    if (call === undefined) throw new Error('本流のセッションが起きなかった');
    const recorded = contextSizeRecorder.composed;
    if (recorded.length !== call.inputs.length) {
      throw new Error(
        `入力の本数が合わない: composeTurnInputText が ${String(recorded.length)} 回、SDK への入力が ${String(call.inputs.length)} 本`,
      );
    }
    recorded.forEach((record, position) => {
      const input = call.inputs[position]!;
      const parts: Record<string, Size> = {};
      for (const [name, text] of Object.entries(record.parts)) {
        if (text.length > 0) parts[name] = sizeOf(text);
      }
      const extraBytes =
        Buffer.byteLength(input, 'utf8') - Buffer.byteLength(record.composed, 'utf8');
      samples.push({
        kind,
        ordinal: position + 1,
        total: sizeOf(input),
        parts,
        extra: {
          chars: input.length - record.composed.length,
          bytes: extraBytes,
          tokens: Math.ceil(extraBytes / APPROX_BYTES_PER_TOKEN),
        },
        digestsBuilt: contextSizeRecorder.digests
          .slice(recorded[position - 1]?.digestsBefore ?? 0, record.digestsBefore)
          .map((digest) => ({ shape: digest.shape, size: sizeOf(digest.text) })),
      });
    });

    const documents = await stores.persona.documents();
    const memoryText = renderMemoryDocuments(documents);
    const systemPrompt = call.options.systemPrompt;
    if (typeof systemPrompt !== 'string') {
      throw new Error('クローンの systemPrompt が文字列でない（preset の形になった？）');
    }
    const selfText = buildSelfKnowledge(SELF_FACTS);
    const session: SessionSample = {
      systemPrompt: sizeOf(systemPrompt),
      memory: sizeOf(memoryText),
      self: sizeOf(selfText),
      template: {
        chars: systemPrompt.length - memoryText.length - selfText.length,
        bytes:
          Buffer.byteLength(systemPrompt, 'utf8') -
          Buffer.byteLength(memoryText, 'utf8') -
          Buffer.byteLength(selfText, 'utf8'),
        tokens: 0,
      },
      contains: {
        memory: systemPrompt.includes(memoryText),
        self: systemPrompt.includes(selfText),
      },
    };
    session.template.tokens = Math.ceil(session.template.bytes / APPROX_BYTES_PER_TOKEN);

    const context = booted.toolContext();
    if (context === undefined) throw new Error('ToolContext が捕まらなかった');
    return {
      session,
      turns: samples,
      tools: await measureTools(context),
      inputs: [...call.inputs],
    };
  } finally {
    await booted.clone.stop();
  }
}

export async function measureTools(context: ToolContext): Promise<ToolsSample> {
  const server = createCloneMcpServer(context);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'context-size-measure', version: '0' });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const per = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      schema: JSON.stringify(tool.inputSchema),
    }));
    const defOf = (tool: (typeof per)[number]): string =>
      JSON.stringify({
        name: qualifiedToolName(tool.name),
        description: tool.description,
        input_schema: JSON.parse(tool.schema) as unknown,
      });
    const sized = per.map((tool) => ({ name: tool.name, size: sizeOf(defOf(tool)) }));
    return {
      count: tools.length,
      definitions: addSizes(...sized.map((entry) => entry.size)),
      descriptionsOnly: addSizes(...per.map((tool) => sizeOf(tool.description))),
      inputSchemasOnly: addSizes(...per.map((tool) => sizeOf(tool.schema))),
      namesOnly: sizeOf(per.map((tool) => qualifiedToolName(tool.name)).join('\n')),
      serverInstructions: sizeOf(client.getInstructions() ?? ''),
      largest: [...sized].sort((a, b) => b.size.bytes - a.size.bytes).slice(0, 8),
    };
  } finally {
    await client.close();
  }
}

export interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultSample {
  call: ToolCallSpec;
  isError: boolean;
  /** 会話の履歴（tool_result）へ載る本文。 */
  result: Size;
  /** 呼び出し側（tool_use の入力）の JSON。 */
  callInput: Size;
}

/**
 * 道具の返り値が会話の履歴へ積む量（#5469 P8 前段）。本物の道具サーバ（`createCloneMcpServer`）へ MCP Client から呼んで、返った本文を測る。
 * 偽データ（`FixtureConfig`）の本文は同じ日本語文の繰り返しなので、トークン近似は実文より大きめに出うる。上限は各道具の予算（`tools.ts` の `*_BUDGET`・`*_PAGE` = 8,000 字）で決まる。
 * 呼び出しは 1 回ずつ順に行い、状態を変える道具（commitment_close など）は呼び出しの並びの中で効く。
 */
export async function measureToolResults(
  config: FixtureConfig,
  calls: readonly ToolCallSpec[],
): Promise<ToolResultSample[]> {
  const now = Date.now();
  const stores = await buildStores(config, now);
  const booted = bootClone(stores);
  try {
    booted.clone.post(eventFor('human', 1, config));
    await waitFor(() => booted.toolContext() !== undefined, 'ToolContext が捕まる');
    const server = createCloneMcpServer(booted.toolContext()!);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'context-size-measure-results', version: '0' });
    await client.connect(clientSide);
    try {
      const samples: ToolResultSample[] = [];
      for (const call of calls) {
        const response = await client.callTool({ name: call.name, arguments: call.args });
        const body = (response.content as { type: string; text?: string }[])
          .map((block) => block.text ?? '')
          .join('');
        samples.push({
          call,
          isError: response.isError === true,
          result: sizeOf(body),
          callInput: sizeOf(JSON.stringify(call.args)),
        });
      }
      return samples;
    } finally {
      await client.close();
    }
  } finally {
    await booted.clone.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// 表にする

const fmt = (value: number): string => value.toLocaleString('en-US');

export function cell(size: Size): string {
  return `${fmt(size.chars)}字 / ${fmt(size.bytes)}B / 約${fmt(size.tokens)}tok`;
}

/** 状態（digest / situation / 台帳の断り書き）に数える欄。残りの欄は「その他の断り書き」。 */
const STATE_PARTS = ['commitment', 'situation'] as const;

export function stateOf(sample: TurnSample): Size {
  return addSizes(...STATE_PARTS.map((name) => sample.parts[name] ?? sizeOf('')));
}

export function otherNoticesOf(sample: TurnSample): Size {
  const names = Object.keys(sample.parts).filter(
    (name) => name !== 'body' && !(STATE_PARTS as readonly string[]).includes(name),
  );
  return addSizes(...names.map((name) => sample.parts[name]!), sample.extra);
}

/** 「その他」の中身（どの欄が何字か）。欄の名前は `TurnInputText` のまま、`extra` は欄に入らない後付け。 */
function otherBreakdown(sample: TurnSample): string {
  const items = Object.entries(sample.parts)
    .filter(([name]) => name !== 'body' && !(STATE_PARTS as readonly string[]).includes(name))
    .map(([name, size]) => `${name}=${fmt(size.chars)}字`);
  if (sample.extra.chars > 0) items.push(`extra=${fmt(sample.extra.chars)}字`);
  return items.length === 0 ? '' : `（${items.join(', ')}）`;
}

export function bodyOf(sample: TurnSample): Size {
  return sample.parts['body'] ?? sizeOf('');
}

export interface KindRun {
  kind: TurnKind;
  result: ScenarioResult;
}

const ORDINAL_LABELS: Record<number, string> = {
  1: '（全文）',
  2: '（畳み後・状態不変）',
  3: '（畳み後・状態が動いた）',
};

export function renderTurnTable(runs: readonly KindRun[]): string {
  const lines = [
    '| ターンの種類 | 回 | 入力の合計 | (3) 状態: 台帳の断り書き | (3) 状態: situation | (4) 本文（合図・tick の指示と digest） | その他の断り書き・記憶の差分 | 組んだ digest（畳む前の生の長さ） |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of runs) {
    for (const sample of run.result.turns) {
      lines.push(
        `| ${TURN_KIND_LABELS[run.kind]} | ${String(sample.ordinal)}${ORDINAL_LABELS[sample.ordinal] ?? ''} | ${cell(sample.total)} | ${cell(sample.parts['commitment'] ?? sizeOf(''))} | ${cell(sample.parts['situation'] ?? sizeOf(''))} | ${cell(bodyOf(sample))} | ${cell(otherNoticesOf(sample))}${otherBreakdown(sample)} | ${
          sample.digestsBuilt.length === 0
            ? '—'
            : sample.digestsBuilt.map((d) => `${d.shape}: ${fmt(d.size.chars)}字`).join(', ')
        } |`,
      );
    }
  }
  return lines.join('\n');
}

export function renderSessionTable(session: SessionSample, tools: ToolsSample): string {
  const rows: [string, Size][] = [
    ['(1) システムプロンプトのテンプレート本体', session.template],
    ['(2) 記憶の索引（premise カード＋目次）', session.memory],
    ['自己認識（self.ts の `buildSelfKnowledge`）', session.self],
    ['システムプロンプト合計（SDK へ渡った値）', session.systemPrompt],
    [
      `(5) 道具の定義（${String(tools.count)} 本。name+description+input_schema）`,
      tools.definitions,
    ],
    ['(5) 道具の定義のうち description だけ', tools.descriptionsOnly],
    ['(5) 道具の定義のうち input schema だけ', tools.inputSchemasOnly],
    ['(5) 道具の名前だけの一覧（deferred のとき一覧に載る形の下限）', tools.namesOnly],
    ['(5) MCP サーバの instructions', tools.serverInstructions],
  ];
  return [
    '| 種類 | 量 |',
    '| --- | --- |',
    ...rows.map(([label, size]) => `| ${label} | ${cell(size)} |`),
  ].join('\n');
}

export function renderToolsLargest(tools: ToolsSample): string {
  return [
    '| 道具 | 定義の量 |',
    '| --- | --- |',
    ...tools.largest.map((entry) => `| ${entry.name} | ${cell(entry.size)} |`),
  ].join('\n');
}

export const ALL_KINDS: readonly TurnKind[] = ['human', 'report', 'timer', 'initiative'];

export async function measureAllKinds(
  config: FixtureConfig,
  kinds: readonly TurnKind[] = ALL_KINDS,
): Promise<KindRun[]> {
  const runs: KindRun[] = [];
  for (const kind of kinds) runs.push({ kind, result: await measureKind(kind, config) });
  return runs;
}

export interface Variant {
  label: string;
  config: FixtureConfig;
}

/** 基準（`BASELINE`）から 1 つだけ動かした条件。データ量への感度を見るための表。 */
export const SENSITIVITY_VARIANTS: readonly Variant[] = [
  { label: '台帳 未了 50 件', config: { ...BASELINE, commitments: 50 } },
  { label: '台帳 未了 327 件（基準）', config: BASELINE },
  { label: '台帳 未了 1000 件', config: { ...BASELINE, commitments: 1_000 } },
  { label: '記憶 小（premise 4 + fact 10）', config: { ...BASELINE, memory: 'small' } },
  { label: '記憶 上限近く（基準。premise 24 + fact 300）', config: BASELINE },
  { label: '委譲 0 本', config: { ...BASELINE, jobs: 0 } },
  { label: '委譲 40 本（基準）', config: BASELINE },
  { label: '委譲 100 本', config: { ...BASELINE, jobs: 100 } },
  { label: '日誌（直近 24h）0 行', config: { ...BASELINE, journalRows: 0 } },
  { label: '日誌（直近 24h）1000 行', config: { ...BASELINE, journalRows: 1_000 } },
  { label: '人間の発言 2000 字', config: { ...BASELINE, humanChars: 2_000 } },
  { label: '報告 8000 字（1 件の上限）', config: { ...BASELINE, reportChars: 8_000 } },
];

export interface VariantRun {
  variant: Variant;
  runs: KindRun[];
}

export function renderSensitivity(rows: readonly VariantRun[]): string {
  const lines = [
    '| 条件 | ターンの種類 | 1本目（全文）の入力 | 3本目（畳み後・状態が動いた）の入力 | 3本目のうち台帳の断り書き | 1本目のうち situation | 1本目に組んだ digest（生） | システムプロンプト合計 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    for (const run of row.runs) {
      const first = run.result.turns[0]!;
      const third = run.result.turns[2]!;
      lines.push(
        `| ${row.variant.label} | ${TURN_KIND_LABELS[run.kind]} | ${cell(first.total)} | ${cell(third.total)} | ${cell(third.parts['commitment'] ?? sizeOf(''))} | ${cell(first.parts['situation'] ?? sizeOf(''))} | ${
          first.digestsBuilt.length === 0
            ? '—'
            : first.digestsBuilt.map((d) => `${d.shape}: ${fmt(d.size.chars)}字`).join(', ')
        } | ${fmt(run.result.session.systemPrompt.chars)}字 |`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * #5397 の本番の日誌の集計（2026-10-28 前後。`turn-census.mjs`）から引いた値。ここでは測っていない。
 * 1 日 1,173 ターンのうち、報告 891・人間 108・自発 tick 26・定期 tick 4。
 * 残り 144 ターン（枠の知らせ 86・外部 53・その他 5）はこの測りの対象外。
 */
export const DAILY_TURNS = 1_173;
export const DAILY_COUNT: Record<TurnKind, number> = {
  report: 891,
  human: 108,
  initiative: 26,
  timer: 4,
};
export const DAILY_UNMEASURED = '枠の知らせ 86・外部 53・その他 5（計 144 ターン）';

export function renderDaily(runs: readonly KindRun[]): string {
  const lines = [
    '| ターンの種類 | ターン/日（#5397） | 3本目の入力（約 tok） | 入力の約 tok/日 |',
    '| --- | --- | --- | --- |',
  ];
  let total = 0;
  let turnsTotal = 0;
  for (const run of runs) {
    const turns = DAILY_COUNT[run.kind];
    const tokens = run.result.turns[2]!.total.tokens;
    total += turns * tokens;
    turnsTotal += turns;
    lines.push(
      `| ${TURN_KIND_LABELS[run.kind]} | ${fmt(turns)} | ${fmt(tokens)} | ${fmt(turns * tokens)} |`,
    );
  }
  lines.push(`| 合計 | ${fmt(turnsTotal)} | | ${fmt(total)} |`);
  lines.push(`| 対象外（未測定） | ${fmt(DAILY_TURNS - turnsTotal)} | ⚠ ${DAILY_UNMEASURED} | |`);
  return lines.join('\n');
}

/** 道具の定義と記憶の索引を含む「毎リクエストの土台」の大きさ。 */
export function renderPrefixPerRequest(session: SessionSample, tools: ToolsSample): string {
  const base = session.systemPrompt.tokens;
  return [
    '| 土台 | 約 tok / リクエスト |',
    '| --- | --- |',
    `| システムプロンプトのみ | ${fmt(base)} |`,
    `| + 道具の定義を全部載せたとき（ToolSearch が止まっている場合） | ${fmt(base + tools.definitions.tokens)} |`,
    `| + 道具が deferred で名前だけのとき（ToolSearch が効いている場合） | ${fmt(base + tools.namesOnly.tokens)} |`,
  ].join('\n');
}

/** 全部の表を 1 つの Markdown にする。 */
export async function buildReport(): Promise<string> {
  const baselineRuns = await measureAllKinds(BASELINE);
  const first = baselineRuns[0]!.result;
  const variantRuns: VariantRun[] = [];
  for (const variant of SENSITIVITY_VARIANTS) {
    variantRuns.push({ variant, runs: await measureAllKinds(variant.config) });
  }
  return [
    `# クローンの1ターンに載る文脈の量（基準の条件）`,
    '',
    `トークン近似: UTF-8 バイト ÷ ${String(APPROX_BYTES_PER_TOKEN)}（実トークナイザは依存に無い。±30% は見込む）。`,
    '',
    '## セッションに固定で載るもの',
    '',
    renderSessionTable(first.session, first.tools),
    '',
    '### 道具の定義が大きい順',
    '',
    renderToolsLargest(first.tools),
    '',
    '### 毎リクエストの土台',
    '',
    renderPrefixPerRequest(first.session, first.tools),
    '',
    '## ターンごとの入力（種類 × 回）',
    '',
    renderTurnTable(baselineRuns),
    '',
    '## データ量への感度',
    '',
    renderSensitivity(variantRuns),
    '',
    '## 1 日あたり',
    '',
    renderDaily(baselineRuns),
    '',
  ].join('\n');
}
