import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import { encodeUsageCursor } from './usage-cursor.js';
import type { AccountUsageState } from './usage-snapshot.js';

// `usage_read` の出力（全文と字数）と、呼びの並び（`stores.usage.aggregate` に渡した絞り込みとその結果の件数・
// `stores.usage.recordedManagerIds`・`context.accountUsage`・`context.managers.list`）を、場面ごとにコミットした固定値
// （clone-tools-usage-read-output-pin.json）と丸ごと比べる。
// `clone-tools-usage.ts` の `tool('usage_read', …)`（tokenId の検査 → from / to の実在の検査 → `usage.aggregate`（渡した絞り込みだけ）→
// 期間の逆の注記 → axis ならその軸だけ・無ければアカウント全体の残り＋見出し＋まとめ表示（記録の無い委譲の行を含む））を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・台帳の行・アカウントの状態・マネージャー）を固定して毎回同じにする。
// この道具は読むだけ。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。例外は素の message をそのまま固定する
//   - wrote: 呼ぶ前後で台帳（全期間の集計・記録のあるマネージャー）・日誌の行数が変わったか。全場面で none（宣言と実際が合うことも確かめる）
//   - writeCalls: 呼びの間にストアの書き込み口（usage の record / recordUnmetered / clear・usage 以外のストアのどの口でも）が呼ばれた記録。全場面で空
//   - calls: 呼びの並び。`usage.aggregate`（渡した絞り込み・結果の件数または投げた文言）・`usage.recordedManagerIds`・
//     `context.accountUsage`（返した状態）・`managers.list`（返した件数）。検査で断った呼びは何も呼ばない（空）
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_USAGE_READ_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-usage-read-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-usage-read-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。台帳の行は `usage.record(accumulation: 'oneshot')` で積み、`at` は基準から分で決める。
// 1回の `record` が1ターン（回数の軸）になる。続きの cursor を使う場面は、前の呼びの出力から cursor を取り出して渡す
// （道具が案内した cursor がそのまま使えることも測る）。「順位が上がった行」は、呼びの前に別の経路が台帳へ積み足して作る（`before`）。
// 道具の定数（USAGE_AXIS_LIMIT = 14 / USAGE_AXIS_PAGE = 100）はこの試験の側に値を持つ（import しない）。
//
// 秘密: トークンの id・マネージャーの id・組織名は作りものだけ（`tk-a`・`mgr-001`・`org-fake`）。実値は入れない。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。

type Args = Record<string, unknown>;

type Layer = 'clone' | 'manager';
type Site = 'session' | 'distill' | 'peer';

interface UsageSeed {
  date: string;
  managerId: string;
  model: string;
  layer?: Layer;
  site?: Site;
  tokenId?: string;
  cost: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  web?: number;
  unreadable?: Record<string, number>;
  minute?: number;
}

interface UnmeteredSeed {
  date: string;
  managerId: string;
  layer?: Layer;
  site?: Site;
  provider: string;
  tokenId?: string;
  minute?: number;
}

interface ManagerSeed {
  managerId: string;
  status: string;
  startedAt: string;
}

type AccountSpec = 'absent' | AccountUsageState;

/** 場面の中で呼びごとに差し替える口 */
interface Hooks {
  /** `usage.aggregate` が落ちる */
  aggregateFails?: boolean;
  /** `usage.aggregate` の結果へ「読めない行」を足す（メモリのストアは作らない。fs / pg だけが作る） */
  unreadableRows?: { table: 'usage_daily' | 'usage_turns'; date?: string; fields: string[] }[];
  /** `usage.recordedManagerIds` が落ちる */
  recordedFails?: boolean;
  /** `managers.list` が落ちる */
  managersFail?: boolean;
  /** この呼びの `context.accountUsage` の状態 */
  account?: AccountSpec;
  /** この呼びの `context.managers`（`undefined` は無い） */
  managers?: ManagerSeed[] | 'absent';
}

interface Step {
  args: Args | ((previous: string) => Args);
  hooks?: Hooks;
  /** この呼びの直前に、別の経路が台帳へ積み足す（呼ぶ前の状態を作る。道具の書き込みではない） */
  before?: (base: Stores) => Promise<void>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: UsageSeed[];
  unmetered?: UnmeteredSeed[];
  /** 場面の既定のアカウントの状態・マネージャー（呼びごとに hooks で差し替えられる） */
  account?: AccountSpec;
  managers?: ManagerSeed[] | 'absent';
  steps: Step[];
}

const BASE_ISO = '2026-10-27T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-usage-read-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_USAGE_READ_PIN === '1';

const USAGE_AXIS_LIMIT = 14;
const USAGE_AXIS_PAGE = 100;
const AGGREGATE_FAILS = '台帳が読めない（テスト用）';

// 台帳の行の `at` の基準。台帳の行の日付（2026-10-20〜22）より後で、昼の 12 時（UTC）: 台帳の始点の「日」はローカル時刻で切られる（`usageDate`）ので、
// 日付をまたがない時刻にして、どの時間帯の環境でも同じ日になるようにする
const AT_BASE_ISO = '2026-10-23T12:00:00.000Z';

function iso(minutesFromBase: number): string {
  return new Date(Date.parse(AT_BASE_ISO) + minutesFromBase * 60_000).toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function u(
  date: string,
  managerId: string,
  model: string,
  cost: number,
  extra: Partial<UsageSeed> = {},
): UsageSeed {
  return { date, managerId, model, cost, ...extra };
}

function a(args: Args = {}, extra: Partial<Step> = {}): Step {
  return { args, ...extra };
}

/** 前の出力の `cursor="…"` から cursor を取り出して、同じ軸で続ける */
function follow(axis: string, extra: Args = {}): (previous: string) => Args {
  return (previous) => {
    const found = new RegExp(`axis="${axis}", cursor="([A-Za-z0-9_-]+)" で続きが出る`).exec(
      previous,
    );
    if (found === null || found[1] === undefined) throw new Error('前の出力に cursor の案内が無い');
    return { axis, cursor: found[1], ...extra };
  };
}

/** 軸ごとに 3 つ以上の値が出る標準の台帳（日 3・マネージャー 3・モデル 3・層 2・場所 3・トークン 2 ＋ 帰属なし） */
const BASIC: UsageSeed[] = [
  u('2026-10-20', 'mgr-001', 'opus', 1.5, {
    layer: 'manager',
    site: 'session',
    tokenId: 'tk-a',
    input: 100,
    output: 200,
    cacheRead: 50,
    cacheCreation: 10,
    minute: 0,
  }),
  u('2026-10-20', 'mgr-001', 'sonnet', 0.25, {
    layer: 'manager',
    site: 'session',
    tokenId: 'tk-a',
    input: 10,
    output: 20,
    minute: 1,
  }),
  u('2026-10-21', 'mgr-002', 'opus', 3, {
    layer: 'manager',
    site: 'peer',
    tokenId: 'tk-b',
    input: 1_000_000,
    output: 2_500,
    web: 2,
    minute: 2,
  }),
  u('2026-10-21', 'clone', 'opus', 0.0042, {
    layer: 'clone',
    site: 'session',
    input: 5,
    minute: 3,
  }),
  u('2026-10-22', 'mgr-001', 'haiku', 0.5, {
    layer: 'manager',
    site: 'distill',
    tokenId: 'tk-a',
    input: 7,
    output: 7,
    minute: 4,
  }),
  u('2026-10-22', 'clone', 'sonnet', 0.001, {
    layer: 'clone',
    site: 'distill',
    input: 1,
    minute: 5,
  }),
];

/** 日付が 20 個（軸の打ち切り 14 を超える）。費用は日ごとに違う */
const MANY_DATES: UsageSeed[] = Array.from({ length: 20 }, (_, index) =>
  u(`2026-10-${pad2(index + 1)}`, 'mgr-001', 'opus', index + 1, {
    layer: 'manager',
    site: 'session',
    minute: index,
  }),
);

/** マネージャーが 130 人（軸の頁 100 を超える）。費用は番号が小さいほど高い */
const MANY_MANAGERS: UsageSeed[] = Array.from({ length: 130 }, (_, index) =>
  u('2026-10-20', `mgr-${pad3(index + 1)}`, 'opus', 1000 - index, {
    layer: 'manager',
    site: 'session',
    minute: index,
  }),
);

/** 130 人の最後の1人（mgr-130）を指す cursor。最後の頁の断りを作る（案内の cursor は残りがあるときしか出ないので、道具の encode で組む） */
const LAST_MANAGER_CURSOR = encodeUsageCursor({
  axis: 'manager',
  label: 'mgr-130',
  cost: 871,
  asOf: iso(129),
});

/** 費用が同額の行（並びの同値は名前の昇順） */
const TIED: UsageSeed[] = ['mgr-003', 'mgr-001', 'mgr-002'].map((id, index) =>
  u('2026-10-20', id, 'opus', 2, { layer: 'manager', site: 'session', minute: index }),
);

const ACCOUNT_AT = '2026-10-27T00:00:00.000Z';
const ACCOUNT_AT_MS = Date.parse(ACCOUNT_AT);

const ACC_OK_FULL: AccountUsageState = {
  state: 'ok',
  usage: {
    at: ACCOUNT_AT,
    plan: 'max',
    organization: 'org-fake',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
    tokenSourcePresence: 'present',
    limitsAvailable: true,
    windows: [
      { kind: 'five_hour', utilization: 42, resetsAt: ACCOUNT_AT_MS + 90 * 60_000 },
      { kind: 'seven_day', utilization: 7, resetsAt: ACCOUNT_AT_MS + (3 * 1440 + 5 * 60) * 60_000 },
      { kind: 'seven_day_opus', utilization: 0 },
      { kind: 'seven_day_sonnet', resetsAt: ACCOUNT_AT_MS - 60_000 },
    ],
    extraUsage: {
      enabled: true,
      usedCredits: 12.5,
      monthlyLimit: 100,
      utilization: 12.5,
      currency: 'USD',
    },
  },
};

const ACC_OK_BARE: AccountUsageState = {
  state: 'ok',
  usage: { at: ACCOUNT_AT, limitsAvailable: false, windows: [] },
};

const ACC_OK_DISABLED_EXTRA: AccountUsageState = {
  state: 'ok',
  usage: {
    at: ACCOUNT_AT,
    plan: '',
    organization: '',
    limitsAvailable: true,
    windows: [],
    extraUsage: { enabled: false },
  },
};

const ACC_OK_STALE: AccountUsageState = {
  state: 'ok',
  usage: {
    at: ACCOUNT_AT,
    plan: 'pro',
    tokenSourcePresence: 'not_returned',
    limitsAvailable: true,
    windows: [{ kind: 'five_hour', utilization: 99.5 }],
    extraUsage: { enabled: true, usedCredits: 3 },
  },
  refreshFailure: {
    since: '2026-10-26T20:00:00.000Z',
    at: '2026-10-26T23:00:00.000Z',
    reason: '更新に失敗した（テスト用）',
  },
};

const ACC_FAILED: AccountUsageState = {
  state: 'failed',
  at: '2026-10-26T23:30:00.000Z',
  reason: '取りに行けなかった（テスト用）',
};

const ACC_UNAVAILABLE: AccountUsageState = {
  state: 'unavailable',
  at: '2026-10-26T23:30:00.000Z',
  reason: '枠が返らなかった（テスト用）',
  cause: 'non_first_party',
  apiKeySource: 'ANTHROPIC_API_KEY',
  accountKeys: ['email', 'plan'],
};

const ACC_UNAVAILABLE_BARE: AccountUsageState = {
  state: 'unavailable',
  at: '2026-10-26T23:30:00.000Z',
  reason: '枠が返らなかった（テスト用・欄なし）',
};

// 台帳の始点は 2026-10-23T12:00Z。mgr-903 はそれより前に起こした委譲（数えない）、mgr-904 は始点と同時刻（数える）
const MANAGERS_MIX: ManagerSeed[] = [
  { managerId: 'mgr-001', status: 'running', startedAt: '2026-10-19T00:00:00.000Z' },
  { managerId: 'mgr-901', status: 'running', startedAt: '2026-10-25T00:00:00.000Z' },
  { managerId: 'mgr-902', status: 'failed', startedAt: '2026-10-24T00:00:00.000Z' },
  { managerId: 'mgr-903', status: 'done', startedAt: '2026-10-01T00:00:00.000Z' },
  { managerId: 'mgr-904', status: 'waiting_human', startedAt: '2026-10-23T12:00:00.000Z' },
  { managerId: 'mgr-002', status: 'done', startedAt: '2026-10-20T00:00:00.000Z' },
];

const MANAGERS_ALL_RECORDED: ManagerSeed[] = [
  { managerId: 'mgr-001', status: 'running', startedAt: '2026-10-19T00:00:00.000Z' },
  { managerId: 'mgr-002', status: 'done', startedAt: '2026-10-20T00:00:00.000Z' },
];

const SCENARIOS: Scenario[] = [
  // ---- tokenId の断り ----
  {
    name: 'tokenid-refused',
    covers:
      'tokenId の長さの検査: 空文字は断る（「tokenId … 1文字以上」）。断ると台帳を読まず（aggregate を呼ばない）、from / to の検査にも進まない。空でなければ通る',
    seed: BASIC,
    steps: [
      a({ tokenId: '' }),
      a({ tokenId: '', from: 'bad', to: 'bad' }),
      a({ tokenId: '', axis: 'date' }),
      a({ tokenId: 'tk-a', axis: 'date' }),
    ],
  },
  // ---- from / to の断り ----
  {
    name: 'date-refused',
    covers:
      'from / to の検査（isRealUsageDate）: 形の違い（月・日が 1 桁・区切り無し・文字・空文字・前後の空白）・月が 0 や 13・日が 0・31 日の無い月・うるう年でない年の 2/29・100 で割れて 400 で割れない年の 2/29 は断る。断ると台帳を読まない。from が先に見られ、両方が不正なら from の断り',
    seed: BASIC,
    steps: [
      a({ from: '2026-2-3' }),
      a({ from: '20261020' }),
      a({ from: 'abc' }),
      a({ from: '' }),
      a({ from: ' 2026-10-20' }),
      a({ from: '2026-10-20 ' }),
      a({ from: '2026-00-10' }),
      a({ from: '2026-13-01' }),
      a({ from: '2026-01-00' }),
      a({ from: '2026-02-30' }),
      a({ from: '2026-04-31' }),
      a({ from: '2025-02-29' }),
      a({ from: '2100-02-29' }),
      a({ to: '2026-02-30' }),
      a({ to: 'x' }),
      a({ from: 'bad-from', to: 'bad-to' }),
      a({ from: '2026-10-20', to: '2026-02-30' }),
      a({ from: '2026-02-30', axis: 'date' }),
    ],
  },
  {
    name: 'date-leap-accepted',
    covers:
      'うるう日の境目で断られない: 2024-02-29（4 で割れる）・2000-02-29（400 で割れる）・各月の末日（1/31・4/30・12/31・2/28）・0001-01-01・9999-12-31。from / to の両方に使う。台帳は読む（aggregate に渡る）',
    seed: BASIC,
    steps: [
      a({ from: '2024-02-29' }),
      a({ to: '2000-02-29' }),
      a({ from: '2026-01-31', to: '2026-04-30' }),
      a({ from: '2026-12-31', to: '2026-12-31' }),
      a({ from: '2026-02-28', to: '2026-02-28' }),
      a({ from: '0001-01-01', to: '9999-12-31' }),
    ],
  },

  // ---- 台帳が空 ----
  {
    name: 'ledger-empty',
    covers:
      '台帳に1件も無い（since が null）: まとめ表示は「台帳にはまだ1件も記録が無い」（アカウント全体の残りの節・見出しは付く）。記録の無い委譲の行は、managers が無ければ「確かめられなかった」・在れば「0件」または一覧。軸モードは「台帳にはまだ1件も…」だけ（残り・見出し・記録の無い委譲の行は出ない）。絞り込み・期間でも同じ',
    seed: [],
    account: ACC_OK_BARE,
    managers: 'absent',
    steps: [
      a({}),
      a({}, { hooks: { managers: [] } }),
      a({}, { hooks: { managers: MANAGERS_MIX } }),
      a({ axis: 'date' }),
      a({ axis: 'manager', cursor: 'garbage' }),
      a({ managerId: 'mgr-001', from: '2026-10-01', to: '2026-10-31' }),
      a({ from: '2026-10-31', to: '2026-10-01' }),
    ],
  },

  // ---- まとめ表示 ----
  {
    name: 'summary-basic',
    covers:
      'まとめ表示（数件の記録）: アカウント全体の残り → 空行 → 「## alteroid が使った分（台帳）」→ 合計（費用・回数・1回あたり）・トークン数（桁区切り）・Web検索 → 軸 6 つ（日別・マネージャー別・モデル別・層別・場所別・認証トークン別。帰属が無い分は「（トークンの帰属が無い分）」）→ モデル別に回数を出さない理由 → 台帳の始点・層・トークン・回数の始点 → 推定の注記',
    seed: BASIC,
    account: ACC_OK_FULL,
    managers: MANAGERS_ALL_RECORDED,
    steps: [a({})],
  },
  {
    name: 'summary-tied-costs',
    covers:
      '費用が同額の行の並びは名前の昇順（全順序: 費用降順 → ラベル昇順）。入れた順を変えて固定する',
    seed: TIED,
    account: 'absent',
    managers: [],
    steps: [a({}), a({ axis: 'manager' })],
  },
  {
    name: 'axes',
    covers:
      '各軸だけを出す（date・manager・model・layer・site・token）: 見出しは「日別（全 N 件）」の形。アカウント全体の残り・まとめ表示・他の軸・記録の無い委譲の行は出ない。日別は新しい順・他は費用降順。「台帳の始点」ほかの脚注と推定の注記は付く。accountUsage・managers は呼ばない',
    seed: BASIC,
    account: ACC_OK_FULL,
    managers: MANAGERS_MIX,
    steps: [
      a({ axis: 'date' }),
      a({ axis: 'manager' }),
      a({ axis: 'model' }),
      a({ axis: 'layer' }),
      a({ axis: 'site' }),
      a({ axis: 'token' }),
    ],
  },
  {
    name: 'zero-vs-unreadable',
    covers:
      '「取れなかった」と 0 の区別: 全部 0 で読めた記録は台帳に行を作らないので「その範囲には記録が無い」になり（合計 $0 とは出ない。いまの振る舞い）、「取れなかった」の行も出ない。取れなかった欄が在る行（unreadable）は 0 円でも行が残り「$0.0000」と出て、「⚠ 一部の区切りで SDK から値が取れなかった（0 ではなく取れなかった。取れなかった数: …）」が付き、欄ごとの回数が出る。Web検索が 0 のときは欄を作らない（2 回なら「Web検索 2回（費用は合計に含む）」）',
    seed: [],
    account: 'absent',
    managers: [],
    steps: [
      a(
        {},
        {
          before: async (base) => {
            await seedUsage(base, [
              u('2026-10-20', 'mgr-001', 'opus', 0, {
                layer: 'manager',
                site: 'session',
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheCreation: 0,
                web: 0,
                minute: 0,
              }),
            ]);
          },
        },
      ),
      a(
        {},
        {
          before: async (base) => {
            await seedUsage(base, [
              u('2026-10-21', 'mgr-001', 'sonnet', 0, {
                layer: 'manager',
                site: 'session',
                minute: 1,
                unreadable: { inputTokens: 1, costUsd: 2, webSearchRequests: 1 },
              }),
              u('2026-10-21', 'mgr-002', 'sonnet', 0.5, {
                layer: 'manager',
                site: 'session',
                web: 2,
                minute: 2,
              }),
            ]);
          },
        },
      ),
      a({ axis: 'model' }),
    ],
  },
  {
    name: 'unmetered-and-unreadable-rows',
    covers:
      '無報告の provider のターン（recordUnmetered）は合計に混ぜず、「⚠ 消費を報告しない provider のターンがある（0 ではなく取れなかった。合計に含まれない: …）」の行（provider・層ごとに畳む・昇順）。読めずに外した行（unreadableRows）は「⚠ 読めない使用量の行が N 行あり…」（内訳・日付 5 つまで・ほか N 日）。まとめ表示・軸モード・記録なし・その範囲に無い、のどれでも出る',
    seed: [u('2026-10-20', 'mgr-001', 'opus', 1, { layer: 'manager', site: 'session', minute: 0 })],
    unmetered: [
      { date: '2026-10-20', managerId: 'mgr-001', provider: 'codex', minute: 1 },
      { date: '2026-10-20', managerId: 'mgr-001', provider: 'codex', minute: 2 },
      { date: '2026-10-21', managerId: 'clone', layer: 'clone', provider: 'codex', minute: 3 },
      { date: '2026-10-21', managerId: 'mgr-002', provider: 'aaa', minute: 4 },
    ],
    account: 'absent',
    managers: [],
    steps: [
      a({}),
      a({ axis: 'date' }),
      a({ managerId: 'mgr-no-such' }),
      a(
        {},
        {
          hooks: {
            unreadableRows: [
              { table: 'usage_daily', date: '2026-10-20', fields: ['costUsd'] },
              { table: 'usage_turns', date: '2026-10-19', fields: ['turns'] },
              { table: 'usage_daily', date: '2026-10-18', fields: ['costUsd'] },
              { table: 'usage_daily', date: '2026-10-17', fields: ['costUsd'] },
              { table: 'usage_daily', date: '2026-10-16', fields: ['costUsd'] },
              { table: 'usage_daily', date: '2026-10-15', fields: ['costUsd'] },
              { table: 'usage_daily', fields: ['costUsd'] },
            ],
          },
        },
      ),
      a(
        { axis: 'model' },
        { hooks: { unreadableRows: [{ table: 'usage_turns', fields: ['turns'] }] } },
      ),
    ],
  },
  {
    name: 'unmetered-only',
    covers:
      '消費の記録が無く、無報告のターンだけ在る（台帳の始点は null のまま）: 「台帳にはまだ1件も記録が無い」の後ろに「⚠ 消費を報告しない…」と読めない行の注が付く',
    seed: [],
    unmetered: [{ date: '2026-10-20', managerId: 'mgr-001', provider: 'codex', minute: 1 }],
    account: 'absent',
    managers: 'absent',
    steps: [
      a({}),
      a(
        {},
        {
          hooks: { unreadableRows: [{ table: 'usage_daily', date: '2026-10-20', fields: ['x'] }] },
        },
      ),
    ],
  },

  // ---- 絞り込み ----
  {
    name: 'filters-single',
    covers:
      '絞り込みの各引数を1つずつ（managerId・layer・site・tokenId・from・to）: aggregate に渡すのは渡したものだけ（欠けた欄は載せない）。managerId は clone も指せる。まとめ表示と軸モードの両方',
    seed: BASIC,
    account: 'absent',
    managers: MANAGERS_ALL_RECORDED,
    steps: [
      a({ managerId: 'mgr-001' }),
      a({ managerId: 'clone' }),
      a({ layer: 'clone' }),
      a({ layer: 'manager', axis: 'layer' }),
      a({ site: 'peer' }),
      a({ site: 'distill', axis: 'site' }),
      a({ tokenId: 'tk-a' }),
      a({ tokenId: 'tk-b', axis: 'token' }),
      a({ from: '2026-10-21' }),
      a({ to: '2026-10-21' }),
      a({ from: '2026-10-21', axis: 'date' }),
    ],
  },
  {
    name: 'filters-combined',
    covers:
      '絞り込みの組み合わせ: managerId ＋ layer ＋ site ＋ tokenId ＋ 期間（全部）・期間だけ（from = to の1日）・2つの組み合わせ。台帳の始点より前にかかる from は「照会した範囲は台帳の始点より前にかかっている…0 ではなく『記録が無い』」',
    seed: BASIC,
    account: 'absent',
    managers: MANAGERS_ALL_RECORDED,
    steps: [
      a({
        managerId: 'mgr-001',
        layer: 'manager',
        site: 'session',
        tokenId: 'tk-a',
        from: '2026-10-20',
        to: '2026-10-20',
      }),
      a({ from: '2026-10-21', to: '2026-10-21' }),
      a({ managerId: 'mgr-001', site: 'distill' }),
      a({ layer: 'clone', from: '2026-10-22', axis: 'site' }),
      a({ from: '2026-09-01', to: '2026-10-21' }),
      a({ from: '2026-09-01', axis: 'date' }),
    ],
  },
  {
    name: 'filters-no-match',
    covers:
      '絞り込みの結果が0行（台帳には記録が在る）: まとめ表示は「その範囲には記録が無い。」＋台帳の始点などの脚注（記録の無い委譲の行は出す）。軸モードは「（その軸には記録が無い）」。cursor を付けた軸モードは「cursor より後ろは無い。これが最後の頁」',
    seed: BASIC,
    account: ACC_OK_BARE,
    managers: MANAGERS_MIX,
    steps: [
      a({ managerId: 'mgr-no-such' }),
      a({ managerId: 'mgr-no-such', axis: 'manager' }),
      a({ from: '2027-01-01' }),
      a({ layer: 'clone', site: 'peer' }),
      a({ to: '2026-10-01', axis: 'date' }),
    ],
  },
  {
    name: 'date-order-notice',
    covers:
      'to が from より前: 「to（…）が from（…）より前なので、この範囲には1日も入らない」を応答の先頭へ添える（まとめ表示・軸モード・台帳が空のときも）。to = from・to が後ろ・片方だけのときは添えない',
    seed: BASIC,
    account: 'absent',
    managers: MANAGERS_ALL_RECORDED,
    steps: [
      a({ from: '2026-10-22', to: '2026-10-20' }),
      a({ from: '2026-10-22', to: '2026-10-20', axis: 'date' }),
      a({ from: '2026-10-21', to: '2026-10-21' }),
      a({ from: '2026-10-20', to: '2026-10-22' }),
      a({ to: '2026-10-20' }),
      a({ from: '2026-10-22' }),
    ],
  },
  {
    name: 'date-order-notice-empty',
    covers:
      '台帳が空で to が from より前: 注記が先頭に付き、そのあとに「台帳にはまだ1件も記録が無い」',
    seed: [],
    account: 'absent',
    managers: [],
    steps: [a({ from: '2026-10-22', to: '2026-10-20' })],
  },

  // ---- 打ち切りと cursor ----
  {
    name: 'summary-cut-and-follow',
    covers:
      '日付が 20 個（まとめ表示の軸の打ち切りは 14 件）: 日別だけ「…（残り 6 件は出していない。axis="date", cursor="…" で続きが出る）」。他の軸（1 値）は打ち切らない。案内の cursor をそのまま渡して続きを読む（残り 6 件・最後の頁の断りは出ない）。続きの応答はその軸だけ（まとめ表示ではない）',
    seed: MANY_DATES,
    account: 'absent',
    managers: [],
    steps: [a({}), { args: follow('date') }],
  },
  {
    name: 'axis-page-and-follow',
    covers:
      'マネージャーが 130 人（軸モードの頁は 100 件）: 先頭の 100 件・「…（残り 30 件は出していない。axis="manager", cursor="…" で続きが出る）」。cursor で続けると残り 30 件（案内なし）→ 最後の件の cursor で「cursor より後ろは無い。これが最後の頁」。途中の cursor を渡し直しても同じ頁',
    seed: MANY_MANAGERS,
    account: 'absent',
    managers: [],
    steps: [
      a({ axis: 'manager' }),
      { args: follow('manager') },
      a({ axis: 'manager', cursor: LAST_MANAGER_CURSOR }),
    ],
  },
  {
    name: 'axis-cursor-chain',
    covers:
      '案内の cursor をそのまま渡して最後まで読む: まとめ表示の先頭（マネージャー別 130 人のうち 14 件）→ 続き（100 件）→ 続き（16 件・最後）→ 最後の頁の断り。各頁は重ならず、並びは費用降順のまま',
    seed: MANY_MANAGERS,
    account: 'absent',
    managers: [],
    steps: [
      a({}),
      { args: follow('manager') },
      { args: follow('manager') },
      a({ axis: 'manager', cursor: LAST_MANAGER_CURSOR }),
    ],
  },
  {
    name: 'axis-cursor-risen',
    covers:
      '続きの間に台帳へ記録が増える（呼びの前に別の経路が積み足す）: 先頭の頁より上の行が伸びると、続きの応答に別枠「順位が上がった、または既に見せた行が伸びた可能性がある行」が出て、通常の続きの頁とは重複しない（mgr-001 は先頭の頁で見せた行・mgr-050 も見せた行。どちらも続きの頁には出ない）',
    seed: MANY_MANAGERS,
    account: 'absent',
    managers: [],
    steps: [
      a({ axis: 'manager' }),
      {
        args: follow('manager'),
        before: async (base) => {
          await seedUsage(base, [
            u('2026-10-20', 'mgr-001', 'opus', 5, {
              layer: 'manager',
              site: 'session',
              minute: 1_000,
            }),
            u('2026-10-20', 'mgr-050', 'opus', 5, {
              layer: 'manager',
              site: 'session',
              minute: 1_001,
            }),
          ]);
        },
      },
    ],
  },
  {
    name: 'axis-cursor-refused',
    covers:
      'cursor の断り: 壊れた cursor（base64 でない・空文字・JSON でない）は「cursor が壊れている…cursor を付けずに axis=… で呼び直す」。別の軸の cursor は「cursor が別の軸（または self_status）のものである」。どちらも見出しだけ（軸名＋1行）で、台帳が空なら cursor の検査より先に「台帳にはまだ1件も…」。axis を付けない cursor は無視される（まとめ表示のまま）',
    seed: BASIC,
    account: 'absent',
    managers: [],
    steps: [
      a({ axis: 'date', cursor: 'garbage' }),
      a({ axis: 'date', cursor: '' }),
      a({ axis: 'date', cursor: Buffer.from('not json', 'utf8').toString('base64url') }),
      a({ axis: 'model', cursor: Buffer.from('{}', 'utf8').toString('base64url') }),
      a({ cursor: 'garbage' }),
    ],
  },
  {
    name: 'axis-cursor-wrong-axis',
    covers:
      '案内の cursor を別の軸へ渡す: date の cursor を manager の軸へ → 「cursor が別の軸…」。同じ軸なら通る。「全 N 件」の見出しは出ない',
    seed: MANY_DATES,
    account: 'absent',
    managers: [],
    steps: [
      a({}),
      { args: (previous) => ({ ...follow('date')(previous), axis: 'manager' }) },
      a({}),
      { args: follow('date') },
    ],
  },

  // ---- アカウント全体の残り ----
  {
    name: 'account-states',
    covers:
      'context.accountUsage の状態ごとの節: 無い（「この応答にアカウント全体の残りが入っていない」は使わず unknown 扱い: 「まだ取りに行っていない（起動直後）」）・ok（全部入り: プラン・組織・認証の出所・鍵の届き具合・枠 4 つ（使用率有り/無し・リセットあと N 日・N 時間・N 分・過ぎていれば 0 分）・支出上限）・ok（枠が空・支出上限なし・プラン空）・ok（取り直しが失敗している警告・使用率の小数・単位不明の支出上限）・failed・unavailable（欄あり・欄なし）。取れなかったを 0 と描かない',
    seed: BASIC,
    managers: [],
    steps: [
      a({}, { hooks: { account: 'absent' } }),
      a({}, { hooks: { account: ACC_OK_FULL } }),
      a({}, { hooks: { account: ACC_OK_BARE } }),
      a({}, { hooks: { account: ACC_OK_DISABLED_EXTRA } }),
      a({}, { hooks: { account: ACC_OK_STALE } }),
      a({}, { hooks: { account: ACC_FAILED } }),
      a({}, { hooks: { account: ACC_UNAVAILABLE } }),
      a({}, { hooks: { account: ACC_UNAVAILABLE_BARE } }),
      a({}, { hooks: { account: { state: 'unknown' } } }),
    ],
  },
  {
    name: 'account-with-axis',
    covers: 'axis を渡すとアカウント全体の残りは出ず、context.accountUsage も呼ばない',
    seed: BASIC,
    account: ACC_OK_FULL,
    managers: MANAGERS_MIX,
    steps: [a({ axis: 'date' }), a({ axis: 'token', managerId: 'mgr-001' })],
  },

  // ---- 記録の無い委譲 ----
  {
    name: 'unrecorded-managers',
    covers:
      '台帳に1行も無い委譲（context.managers と usage.recordedManagerIds の差）: 全部記録済みなら「0件（台帳が始まってから立った委譲は、全部台帳に最低1行ある…）」。無ければ「⚠ …N件。上の合計にはまだ入っていない。」＋ id [状態]（起こした時刻）を古い順。台帳の始点より前に起こした委譲は数えない。照会の期間・絞り込みでは絞らない（recordedManagerIds は全期間）。managers が無い器は「確かめられなかった…0 件ではない」',
    seed: BASIC,
    account: 'absent',
    steps: [
      a({}, { hooks: { managers: MANAGERS_ALL_RECORDED } }),
      a({}, { hooks: { managers: MANAGERS_MIX } }),
      a({}, { hooks: { managers: [] } }),
      a({}, { hooks: { managers: 'absent' } }),
      a({ managerId: 'mgr-001', from: '2026-10-22' }, { hooks: { managers: MANAGERS_MIX } }),
      a({ managerId: 'mgr-no-such' }, { hooks: { managers: MANAGERS_MIX } }),
    ],
  },
  {
    name: 'unrecorded-managers-axis',
    covers: '軸モードは記録の無い委譲を調べない（managers.list も recordedManagerIds も呼ばない）',
    seed: BASIC,
    account: 'absent',
    managers: MANAGERS_MIX,
    steps: [a({ axis: 'manager' }), a({ axis: 'date', from: '2026-10-21' })],
  },
  {
    name: 'unrecorded-managers-empty-range',
    covers:
      '範囲に台帳の行が無くても、記録の無い委譲の行は出す（全期間で判定。空行を挟んで「その範囲には記録が無い。」の後ろ）',
    seed: BASIC,
    account: 'absent',
    managers: MANAGERS_MIX,
    steps: [a({ from: '2027-01-01' })],
  },

  // ---- 始点・脚注 ----
  {
    name: 'ledger-axes-sources',
    covers:
      '軸ごとの始点の脚注: トークンの帰属が無い記録だけ（「認証トークンの軸はまだ1件も記録していない（プールを使っていない構成なら、これが正常である）」）・層と場所の始点・回数の始点。from が台帳・層・トークン・回数の始点のどれより前でも、それぞれの「…始点より前にかかっている」が付く',
    seed: [
      u('2026-10-20', 'mgr-001', 'opus', 1, { layer: 'manager', site: 'session', minute: 0 }),
      u('2026-10-21', 'mgr-001', 'opus', 1, {
        layer: 'manager',
        site: 'session',
        tokenId: 'tk-a',
        minute: 60 * 24,
      }),
    ],
    account: 'absent',
    managers: [],
    steps: [
      a({ tokenId: 'tk-no-such' }),
      a({ from: '2026-09-01' }),
      a({ from: '2026-10-23' }),
      a({ from: '2026-10-24' }),
      a({ from: '2026-10-25' }),
      a({ axis: 'token' }),
    ],
  },

  // ---- 値の形 ----
  {
    name: 'value-forms',
    covers:
      '値の書式: $1 未満は 4 桁・$1 以上は 2 桁・ちょうど $1・0.00005（$0.0001 に丸まる）・非常に大きい額。トークン数は桁区切り。1回あたりの額（費用 ÷ 回数）。ラベルに日本語・空白・長い名前',
    seed: [
      u('2026-10-20', 'mgr-001', 'opus', 1, {
        layer: 'manager',
        site: 'session',
        input: 1,
        minute: 0,
      }),
      u('2026-10-20', 'mgr-002', 'sonnet', 0.00005, {
        layer: 'manager',
        site: 'session',
        input: 123_456_789,
        minute: 1,
      }),
      u('2026-10-20', 'mgr-003', 'haiku', 12345.678, {
        layer: 'manager',
        site: 'session',
        output: 1_000,
        minute: 2,
      }),
      u('2026-10-21', '作業者 一', 'モデル 一', 0.9999, {
        layer: 'manager',
        site: 'session',
        minute: 3,
      }),
      u('2026-10-21', 'mgr-001', 'opus', 1, { layer: 'manager', site: 'session', minute: 4 }),
    ],
    account: 'absent',
    managers: [],
    steps: [a({}), a({ axis: 'manager' })],
  },

  // ---- ストアが投げる ----
  {
    name: 'aggregate-throws',
    covers:
      '`stores.usage.aggregate` が投げたとき: 握らず例外のまま出る（THREW。名前と message）。まとめ表示も軸モードも同じ。context.accountUsage・managers は呼ばない。検査で断った呼びは aggregate まで届かない',
    seed: BASIC,
    account: ACC_OK_FULL,
    managers: MANAGERS_MIX,
    steps: [
      a({}, { hooks: { aggregateFails: true } }),
      a({ axis: 'date' }, { hooks: { aggregateFails: true } }),
      a({ from: '2026-10-20', managerId: 'mgr-001' }, { hooks: { aggregateFails: true } }),
      a({ from: 'bad' }, { hooks: { aggregateFails: true } }),
      a({ tokenId: '' }, { hooks: { aggregateFails: true } }),
      a({}),
    ],
  },
  {
    name: 'recorded-or-managers-throws',
    covers:
      '記録の無い委譲の読みが落ちる: managers.list が投げても recordedManagerIds が投げても、握らず例外のまま出る（Promise.all の先に落ちた方）。両方を呼んだ記録は残る。軸モードは読まないので落ちない',
    seed: BASIC,
    account: ACC_OK_FULL,
    managers: MANAGERS_MIX,
    steps: [
      a({}, { hooks: { managersFail: true } }),
      a({}, { hooks: { recordedFails: true } }),
      a({}, { hooks: { managersFail: true, recordedFails: true } }),
      a({ axis: 'date' }, { hooks: { managersFail: true, recordedFails: true } }),
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
  /** 例外の名前（投げていなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args?: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  /** 呼ぶ前から変わったもの（読むだけの道具なので全場面で none） */
  wrote: 'none' | 'ledger' | 'journal';
  /** 呼びの間に呼ばれたストアの書き込み口（全場面で空） */
  writeCalls: string[];
  /** 呼びの並び */
  calls: PinnedCall[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`） */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

interface Recorded {
  calls: PinnedCall[];
  writes: string[];
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function seedUsage(stores: Stores, rows: readonly UsageSeed[]): Promise<void> {
  for (const row of rows) {
    await stores.usage.record({
      layer: row.layer ?? 'manager',
      site: row.site ?? 'session',
      managerId: row.managerId,
      date: row.date,
      at: iso(row.minute ?? 0),
      accumulation: 'oneshot',
      ...(row.tokenId === undefined ? {} : { tokenId: row.tokenId }),
      snapshot: {
        models: {
          [row.model]: {
            inputTokens: row.input ?? 0,
            outputTokens: row.output ?? 0,
            cacheReadInputTokens: row.cacheRead ?? 0,
            cacheCreationInputTokens: row.cacheCreation ?? 0,
            webSearchRequests: row.web ?? 0,
            costUsd: row.cost,
            ...(row.unreadable === undefined ? {} : { unreadable: row.unreadable }),
          },
        },
      },
    });
  }
}

async function seedUnmetered(stores: Stores, rows: readonly UnmeteredSeed[]): Promise<void> {
  for (const row of rows) {
    await stores.usage.recordUnmetered({
      layer: row.layer ?? 'manager',
      site: row.site ?? 'session',
      managerId: row.managerId,
      date: row.date,
      at: iso(row.minute ?? 0),
      provider: row.provider,
      ...(row.tokenId === undefined ? {} : { tokenId: row.tokenId }),
    });
  }
}

interface Snapshot {
  ledger: string;
  recorded: string[];
  journalCount: number;
}

async function snapshot(base: Stores): Promise<Snapshot> {
  return {
    ledger: JSON.stringify(await base.usage.aggregate({})),
    recorded: [...(await base.usage.recordedManagerIds())].sort(),
    journalCount: (await base.journal.list({ order: 'asc' })).length,
  };
}

function classify(before: Snapshot, after: Snapshot): PinnedStep['wrote'] {
  if (before.ledger !== after.ledger || before.recorded.join() !== after.recorded.join()) {
    return 'ledger';
  }
  return before.journalCount === after.journalCount ? 'none' : 'journal';
}

function withHooks(base: Stores, hooks: () => Hooks, recorded: Recorded): Stores {
  const usage: Stores['usage'] = {
    ...base.usage,
    aggregate: async (query) => {
      const args = plain(query);
      if (hooks().aggregateFails === true) {
        recorded.calls.push({
          op: 'usage.aggregate',
          args,
          outcome: `threw Error: ${AGGREGATE_FAILS}`,
        });
        throw new Error(AGGREGATE_FAILS);
      }
      const result = await base.usage.aggregate(query);
      const extra = hooks().unreadableRows;
      recorded.calls.push({
        op: 'usage.aggregate',
        args,
        outcome: `ok rows=${String(result.rows.length)} turnRows=${String(result.turnRows?.length ?? 0)} unmetered=${String(result.unmeteredRows?.length ?? 0)}`,
      });
      return extra === undefined ? result : { ...result, unreadableRows: extra };
    },
    recordedManagerIds: async () => {
      if (hooks().recordedFails === true) {
        recorded.calls.push({
          op: 'usage.recordedManagerIds',
          outcome: 'threw Error: 記録の一覧が読めない',
        });
        throw new Error('記録の一覧が読めない');
      }
      const ids = await base.usage.recordedManagerIds();
      recorded.calls.push({
        op: 'usage.recordedManagerIds',
        outcome: `ok ${String(ids.size)} ids`,
      });
      return ids;
    },
    record: (...args) => {
      recorded.writes.push('usage.record');
      return base.usage.record(...args);
    },
    recordUnmetered: (...args) => {
      recorded.writes.push('usage.recordUnmetered');
      return base.usage.recordUnmetered(...args);
    },
    clear: (...args) => {
      recorded.writes.push('usage.clear');
      return base.usage.clear(...args);
    },
  };
  const out: Record<string, unknown> = { ...base, usage };
  for (const [group, value] of Object.entries(base)) {
    if (group === 'usage' || typeof value !== 'object' || value === null) continue;
    // usage 以外のストアは、どの口が呼ばれても記録する（この道具は触らないはず）
    out[group] = new Proxy(value, {
      get(target, prop) {
        const member = (target as Record<string | symbol, unknown>)[prop];
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          recorded.writes.push(`${group}.${String(prop)}`);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
  return out as unknown as Stores;
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedUsage(base, scenario.seed);
  await seedUnmetered(base, scenario.unmetered ?? []);
  let hooks: Hooks = {};
  let account: AccountSpec = scenario.account ?? 'absent';
  let managers: ManagerSeed[] | 'absent' = scenario.managers ?? 'absent';
  const recorded: Recorded = { calls: [], writes: [] };
  const managerPool = {
    list: async () => {
      if (hooks.managersFail === true) {
        recorded.calls.push({ op: 'managers.list', outcome: 'threw Error: 委譲の一覧が読めない' });
        throw new Error('委譲の一覧が読めない');
      }
      const rows = managers === 'absent' ? [] : managers;
      recorded.calls.push({ op: 'managers.list', outcome: `ok ${String(rows.length)} managers` });
      return rows;
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, recorded),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    get managers() {
      return managers === 'absent' ? undefined : managerPool;
    },
    get accountUsage() {
      if (account === 'absent') return undefined;
      return () => {
        recorded.calls.push({
          op: 'context.accountUsage',
          outcome: `state=${account === 'absent' ? 'absent' : account.state}`,
        });
        return account === 'absent' ? { state: 'unknown' as const } : account;
      };
    },
  });
  const found = tools.find((entry) => entry.name === 'usage_read');
  if (!found) throw new Error('usage_read が無い');

  const results: PinnedStep[] = [];
  let previous = '';
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) await step.before(base);
    hooks = { ...step.hooks };
    account = hooks.account ?? scenario.account ?? 'absent';
    managers = hooks.managers ?? scenario.managers ?? 'absent';
    const before = await snapshot(base);
    recorded.calls.length = 0;
    recorded.writes.length = 0;
    const args = typeof step.args === 'function' ? step.args(previous) : step.args;
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = {
        length: text.length,
        text,
        isError: result.isError === true,
        thrown: false,
        errorName: null,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = {
        length: text.length,
        text,
        isError: true,
        thrown: true,
        errorName: error instanceof Error ? error.name : null,
      };
    }
    previous = output.text;
    const wrote = classify(before, await snapshot(base));
    results.push({
      output,
      wrote,
      writeCalls: [...recorded.writes],
      calls: plain(recorded.calls),
    });
    expect(
      wrote,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、台帳か日誌が変わった`,
    ).toBe('none');
    expect(
      recorded.writes,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、書き込み口が呼ばれた`,
    ).toEqual([]);
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('usage_read の出力の固定（場面ごとの全文と字数・読むだけで書かないこと）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('読むだけの道具: 全場面で書き込みが none（台帳・日誌が変わらない）で、書き込み口も呼ばれていない', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe('none');
      expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe('none');
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          {
            isError: got?.output.isError,
            thrown: got?.output.thrown,
            errorName: got?.output.errorName,
          },
          `場面 ${key} の出力の isError／例外で返ったか／例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼びの並び（aggregate に渡した絞り込み・accountUsage・managers）が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び（引数・結果）が固定値からずれた`).toEqual(
          want?.calls,
        );
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（json の全文に鍵らしい形が無い）', () => {
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-|ghp_|github_pat_|AKIA|xox[abp]-/);
    expect(pinnedRaw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const aggregateArgs = (key: string): unknown =>
      step(key).calls.find((entry) => entry.op === 'usage.aggregate')?.args;
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const linesOf = (key: string, prefix: string): string[] =>
      text(key)
        .split('\n')
        .filter((line) => line.startsWith(prefix));
    const HEAD_ACCOUNT = '## アカウント全体の残り（claude.ai 側の値）';
    const HEAD_LEDGER = '## alteroid が使った分（台帳）';
    const EMPTY_LEDGER = '台帳にはまだ1件も記録が無い。';
    const UNREC_ZERO =
      '台帳に1行も記録が無い委譲: 0件（台帳が始まってから立った委譲は、全部台帳に最低1行ある。照会の期間では絞っていない）。';
    const UNREC_UNKNOWN =
      '⚠ 台帳に1行も記録が無い委譲: 確かめられなかった（この場ではマネージャーの一覧が読めない。0 件ではない）。';
    const BEFORE = 'にかかっている。';
    const RISEN = '⚠ 順位が上がった、または既に見せた行が伸びた可能性がある行';
    const FULL_OPS = [
      'usage.aggregate',
      'managers.list',
      'usage.recordedManagerIds',
      'context.accountUsage',
    ];

    // tokenId の断り
    for (const n of [1, 2, 3]) {
      expect(text(`tokenid-refused#${String(n)}`)).toBe('tokenId は使えない（1文字以上のみ）。');
      expect(ops(`tokenid-refused#${String(n)}`)).toEqual([]);
    }
    expect(text('tokenid-refused#4')).toContain('日別（全 2 件）');
    expect(aggregateArgs('tokenid-refused#4')).toEqual({ tokenId: 'tk-a' });

    // from / to の断り
    const refusedDates: [number, string, string][] = [
      [1, 'from', '2026-2-3'],
      [2, 'from', '20261020'],
      [3, 'from', 'abc'],
      [4, 'from', ''],
      [5, 'from', ' 2026-10-20'],
      [6, 'from', '2026-10-20 '],
      [7, 'from', '2026-00-10'],
      [8, 'from', '2026-13-01'],
      [9, 'from', '2026-01-00'],
      [10, 'from', '2026-02-30'],
      [11, 'from', '2026-04-31'],
      [12, 'from', '2025-02-29'],
      [13, 'from', '2100-02-29'],
      [14, 'to', '2026-02-30'],
      [15, 'to', 'x'],
      [16, 'from', 'bad-from'],
      [17, 'to', '2026-02-30'],
      [18, 'from', '2026-02-30'],
    ];
    for (const [n, name, value] of refusedDates) {
      const key = `date-refused#${String(n)}`;
      expect(text(key), key).toBe(
        `\`${name}\` は、暦の上に実在する日付（YYYY-MM-DD）で書く（受け取った値: ${JSON.stringify(value)}）。` +
          '形の合わない値や、2026-02-30 のような実在しない日では絞り込めない。',
      );
      expect(ops(key), key).toEqual([]);
      expect(step(key).output.isError, key).toBe(false);
    }
    const accepted: [number, Record<string, string>][] = [
      [1, { from: '2024-02-29' }],
      [2, { to: '2000-02-29' }],
      [3, { from: '2026-01-31', to: '2026-04-30' }],
      [4, { from: '2026-12-31', to: '2026-12-31' }],
      [5, { from: '2026-02-28', to: '2026-02-28' }],
      [6, { from: '0001-01-01', to: '9999-12-31' }],
    ];
    for (const [n, query] of accepted) {
      const key = `date-leap-accepted#${String(n)}`;
      expect(text(key), key).not.toContain('実在する日付');
      expect(aggregateArgs(key), key).toEqual(query);
    }

    // 台帳が空
    expect(text('ledger-empty#1').startsWith(HEAD_ACCOUNT)).toBe(true);
    expect(text('ledger-empty#1')).toContain(
      `${HEAD_LEDGER}\n${EMPTY_LEDGER}\n（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）\n\n${UNREC_UNKNOWN}`,
    );
    expect(text('ledger-empty#2')).toContain(UNREC_ZERO);
    expect(text('ledger-empty#3')).toContain(
      '⚠ 台帳に1行も記録が無い委譲: 6件。上の合計にはまだ入っていない。',
    );
    for (const key of ['ledger-empty#4', 'ledger-empty#5']) {
      expect(text(key), key).toBe(
        `${EMPTY_LEDGER}\n（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）`,
      );
      expect(ops(key), key).toEqual(['usage.aggregate']);
    }
    expect(aggregateArgs('ledger-empty#6')).toEqual({
      managerId: 'mgr-001',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(
      text('ledger-empty#7').startsWith(
        'to（2026-10-01）が from（2026-10-31）より前なので、この範囲には1日も入らない\n## アカウント',
      ),
    ).toBe(true);

    // まとめ表示
    const basic = text('summary-basic');
    expect(ops('summary-basic')).toEqual(FULL_OPS);
    expect(basic.indexOf(HEAD_ACCOUNT)).toBe(0);
    expect(basic.indexOf(HEAD_ACCOUNT)).toBeLessThan(basic.indexOf(HEAD_LEDGER));
    expect(basic).toContain('合計 $5.26 / 6回 / 1回 $0.8759');
    expect(basic).toContain(
      '入力 1,000,123 / 出力 2,727 / キャッシュ読み 50 / キャッシュ書き 10 / Web検索 2回（費用は合計に含む）',
    );
    for (const title of [
      '日別:',
      'マネージャー別:',
      'モデル別:',
      '層別（誰が）:',
      '場所別（どこで）:',
      '認証トークン別:',
    ]) {
      expect(basic, title).toContain(`\n${title}\n`);
    }
    expect(basic).toContain('  （トークンの帰属が無い分）: $0.0052 / 2回 / 1回 $0.0026');
    expect(basic).toContain('  opus: $4.50\n');
    expect(basic).toContain(
      'モデル別に回数は出さない（1ターンが複数のモデル行を作るので、回数をモデルへ帰属させられない）。',
    );
    expect(
      basic.endsWith(
        'SDK が返す推定値であり、Anthropic の請求明細ではない（一致しないことがある）。',
      ),
    ).toBe(true);
    expect(linesOf('summary-tied-costs#2', '  mgr-').map((line) => line.slice(0, 10))).toEqual([
      '  mgr-001:',
      '  mgr-002:',
      '  mgr-003:',
    ]);
    // accountUsage の無い器では context.accountUsage を呼ばず、unknown として描く
    expect(ops('summary-tied-costs#1')).toEqual([
      'usage.aggregate',
      'managers.list',
      'usage.recordedManagerIds',
    ]);

    // 各軸
    const axisHeads = [
      '日別（全 3 件）\n  2026-10-22: ',
      'マネージャー別（全 3 件）\n  mgr-002: ',
      'モデル別（全 3 件）\n  opus: ',
      '層別（誰が）（全 2 件）\n  manager: ',
      '場所別（どこで）（全 3 件）\n  peer: ',
      '認証トークン別（全 3 件）\n  tk-b: ',
    ];
    for (const [index, head] of axisHeads.entries()) {
      const key = `axes#${String(index + 1)}`;
      expect(text(key).startsWith(head), key).toBe(true);
      expect(text(key), key).not.toContain(HEAD_ACCOUNT);
      expect(text(key), key).not.toContain('合計 $');
      expect(text(key), key).toContain('\n台帳の始点: 2026-10-23T12:00:00.000Z');
      expect(ops(key), key).toEqual(['usage.aggregate']);
    }
    expect(text('axes#3')).not.toContain('回 / 1回');

    // 取れなかったと 0
    // 全部 0 で読めた記録は台帳に行を作らない（`fold.delta` が空）: 「合計 $0.0000」ではなく「その範囲には記録が無い」になる。いまの振る舞い
    expect(text('zero-vs-unreadable#1')).toContain('その範囲には記録が無い。');
    expect(text('zero-vs-unreadable#1')).not.toContain('合計 $');
    expect(text('zero-vs-unreadable#1')).not.toContain('⚠ 一部の区切り');
    expect(text('zero-vs-unreadable#2')).toContain('  mgr-001: $0.0000 / 1回 / 1回 $0.0000');
    expect(text('zero-vs-unreadable#2')).toContain(
      '⚠ 一部の区切りで SDK から値が取れなかった（0 ではなく取れなかった。取れなかった数: ',
    );
    expect(text('zero-vs-unreadable#2')).toContain('入力 1回');
    expect(text('zero-vs-unreadable#2')).toContain('費用 2回');
    expect(text('zero-vs-unreadable#2')).toContain('Web検索 2回（費用は合計に含む）');

    // 無報告・読めない行
    expect(text('unmetered-and-unreadable-rows#1')).toContain(
      '⚠ 消費を報告しない provider のターンがある（0 ではなく取れなかった。合計に含まれない: aaa・manager層 1ターン / codex・clone層 1ターン / codex・manager層 2ターン）。',
    );
    expect(text('unmetered-and-unreadable-rows#2')).toContain('⚠ 消費を報告しない provider');
    expect(text('unmetered-and-unreadable-rows#3')).toContain('その範囲には記録が無い。');
    expect(text('unmetered-and-unreadable-rows#4')).toContain(
      '⚠ 読めない使用量の行が 7 行あり、合計に入っていない（読めない行の値は足していない。合計はその分少ない。内訳: 消費量の行 6 行 / 回数の行 1 行。日付: 2026-10-15, 2026-10-16, 2026-10-17, 2026-10-18, 2026-10-19 ほか 1 日）。',
    );
    expect(text('unmetered-and-unreadable-rows#5')).toContain('内訳: 回数の行 1 行）。');
    expect(text('unmetered-only#1')).toContain(
      `${EMPTY_LEDGER}\n（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）\n⚠ 消費を報告しない provider のターンがある`,
    );
    expect(text('unmetered-only#2')).toContain('⚠ 読めない使用量の行が 1 行あり');

    // 絞り込み
    const filters: [number, Record<string, string>][] = [
      [1, { managerId: 'mgr-001' }],
      [2, { managerId: 'clone' }],
      [3, { layer: 'clone' }],
      [4, { layer: 'manager' }],
      [5, { site: 'peer' }],
      [6, { site: 'distill' }],
      [7, { tokenId: 'tk-a' }],
      [8, { tokenId: 'tk-b' }],
      [9, { from: '2026-10-21' }],
      [10, { to: '2026-10-21' }],
      [11, { from: '2026-10-21' }],
    ];
    for (const [n, query] of filters) {
      expect(aggregateArgs(`filters-single#${String(n)}`), `filters-single#${String(n)}`).toEqual(
        query,
      );
    }
    expect(aggregateArgs('filters-combined#1')).toEqual({
      managerId: 'mgr-001',
      layer: 'manager',
      site: 'session',
      tokenId: 'tk-a',
      from: '2026-10-20',
      to: '2026-10-20',
    });
    expect(aggregateArgs('filters-combined#2')).toEqual({ from: '2026-10-21', to: '2026-10-21' });
    expect(aggregateArgs('filters-combined#4')).toEqual({ layer: 'clone', from: '2026-10-22' });
    expect(count(text('filters-combined#5'), BEFORE)).toBe(4);
    // 台帳の行の日付（10-20〜22）は台帳の始点（10-23）より前なので、from を渡すとどの場面でも 4 つの「始点より前にかかっている」が付く
    expect(count(text('filters-combined#1'), BEFORE)).toBe(4);
    expect(text('filters-single#2')).toContain('マネージャー別:\n  clone: $0.0052');
    expect(text('filters-no-match#1')).toContain('その範囲には記録が無い。');
    expect(text('filters-no-match#1')).toContain('⚠ 台帳に1行も記録が無い委譲: 3件');
    expect(text('filters-no-match#2')).toContain(
      'マネージャー別（全 0 件）\n  （その軸には記録が無い）',
    );
    expect(text('filters-no-match#5')).toContain('日別（全 0 件）\n  （その軸には記録が無い）');

    // 期間の逆
    const ORDER = (to: string, from: string): string =>
      `to（${to}）が from（${from}）より前なので、この範囲には1日も入らない\n`;
    expect(
      text('date-order-notice#1').startsWith(`${ORDER('2026-10-20', '2026-10-22')}${HEAD_ACCOUNT}`),
    ).toBe(true);
    expect(
      text('date-order-notice#2').startsWith(`${ORDER('2026-10-20', '2026-10-22')}日別（全 0 件）`),
    ).toBe(true);
    for (const n of [3, 4, 5, 6]) {
      expect(text(`date-order-notice#${String(n)}`), `#${String(n)}`).not.toContain(
        'より前なので、この範囲には1日も入らない',
      );
    }
    expect(
      text('date-order-notice-empty').startsWith(
        `${ORDER('2026-10-20', '2026-10-22')}${HEAD_ACCOUNT}`,
      ),
    ).toBe(true);
    expect(text('date-order-notice-empty')).toContain(EMPTY_LEDGER);

    // 打ち切りと cursor
    expect(linesOf('summary-cut-and-follow#1', '  2026-10-').length).toBe(USAGE_AXIS_LIMIT);
    expect(text('summary-cut-and-follow#1')).toContain(
      '…（残り 6 件は出していない。axis="date", cursor="',
    );
    expect(text('summary-cut-and-follow#1')).not.toContain('axis="manager"');
    expect(text('summary-cut-and-follow#2').startsWith('日別（全 20 件）\n  2026-10-06: ')).toBe(
      true,
    );
    expect(linesOf('summary-cut-and-follow#2', '  2026-10-')).toHaveLength(6);
    expect(text('summary-cut-and-follow#2')).not.toContain('残り');
    expect(text('summary-cut-and-follow#2')).not.toContain(HEAD_ACCOUNT);

    expect(linesOf('axis-page-and-follow#1', '  mgr-')).toHaveLength(USAGE_AXIS_PAGE);
    expect(text('axis-page-and-follow#1')).toContain(
      '…（残り 30 件は出していない。axis="manager", cursor="',
    );
    expect(linesOf('axis-page-and-follow#2', '  mgr-')).toHaveLength(30);
    expect(text('axis-page-and-follow#2')).toContain('  mgr-101: ');
    expect(text('axis-page-and-follow#2')).not.toContain('  mgr-100: ');
    expect(text('axis-page-and-follow#2')).not.toContain('残り');
    expect(text('axis-page-and-follow#3')).toContain(
      'マネージャー別（全 130 件）\n  （cursor より後ろは無い。これが最後の頁）',
    );

    expect(linesOf('axis-cursor-chain#1', '  mgr-')).toHaveLength(USAGE_AXIS_LIMIT);
    expect(text('axis-cursor-chain#1')).toContain(
      '…（残り 116 件は出していない。axis="manager", cursor="',
    );
    expect(linesOf('axis-cursor-chain#2', '  mgr-')).toHaveLength(USAGE_AXIS_PAGE);
    expect(text('axis-cursor-chain#2')).toContain('  mgr-015: ');
    expect(text('axis-cursor-chain#2')).toContain('  mgr-114: ');
    expect(linesOf('axis-cursor-chain#3', '  mgr-')).toHaveLength(16);
    expect(text('axis-cursor-chain#3')).toContain('  mgr-115: ');
    expect(text('axis-cursor-chain#3')).toContain('  mgr-130: ');
    expect(text('axis-cursor-chain#4')).toContain('（cursor より後ろは無い。これが最後の頁）');

    expect(text('axis-cursor-risen#1')).not.toContain(RISEN);
    const risenBody = text('axis-cursor-risen#2').split(RISEN)[0] ?? '';
    expect(text('axis-cursor-risen#2')).toContain(RISEN);
    expect(risenBody).not.toContain('  mgr-001: ');
    expect(risenBody).not.toContain('  mgr-050: ');
    expect(text('axis-cursor-risen#2')).toContain('  mgr-001: $1005.00 / 2回 / 1回 $502.50');
    expect(text('axis-cursor-risen#2')).toContain('  mgr-050: $956.00 / 2回 / 1回 $478.00');

    // cursor の断り
    for (const n of [1, 2, 3, 4]) {
      const key = `axis-cursor-refused#${String(n)}`;
      const title = n === 4 ? 'モデル別' : '日別';
      const axis = n === 4 ? 'model' : 'date';
      expect(text(key), key).toBe(
        `${title}\ncursor が壊れている（この道具が返したものではないか、書き換えられている）。cursor を付けずに axis="${axis}" で usage_read を呼び直すと先頭から読める。`,
      );
    }
    expect(text('axis-cursor-refused#5')).toContain(HEAD_LEDGER);
    expect(text('axis-cursor-wrong-axis#2')).toBe(
      'マネージャー別\ncursor が別の軸（または self_status）のものである。axis="manager" の cursor をそのまま渡すこと（自分で組み立てない）。',
    );
    expect(text('axis-cursor-wrong-axis#4')).toContain('日別（全 20 件）');

    // アカウント全体の残り
    expect(text('account-states#1')).toContain(
      'まだ取りに行っていない（起動直後）。**0 ではなく、分からない。**',
    );
    expect(ops('account-states#1')).not.toContain('context.accountUsage');
    expect(text('account-states#2')).toContain('プラン: max / 組織: org-fake');
    expect(text('account-states#2')).toContain('  five_hour: 42% 使用 / あと 1時間30分でリセット');
    expect(text('account-states#2')).toContain('  seven_day: 7% 使用 / あと 3日5時間でリセット');
    expect(text('account-states#2')).toContain('  seven_day_opus: 0% 使用\n');
    expect(text('account-states#2')).toContain(
      '  seven_day_sonnet: 使用率は取れなかった / あと 0分でリセット',
    );
    expect(text('account-states#2')).toContain('支出上限: 12.5 USD / 100 USD（12.5% 使用）');
    expect(text('account-states#3')).toContain(
      '枠: 取れなかった（向こうが枠を返さなかった。**0% ではない**）',
    );
    expect(text('account-states#3')).toContain(
      '支出上限: 取れなかった（**0 ではない**。この情報が無いと残額は分からない）',
    );
    expect(text('account-states#4')).toContain('プラン: （欄はあるが空） / 組織: （欄はあるが空）');
    expect(text('account-states#4')).toContain('支出上限: 設定されていない');
    expect(text('account-states#5')).toContain(
      '**⚠️ 上の値は最後に取れたときのもの。2026-10-26T20:00:00.000Z から取り直しが失敗している',
    );
    expect(text('account-states#5')).toContain('  five_hour: 99.5% 使用');
    expect(text('account-states#5')).toContain('支出上限: 3（単位不明） / 取れなかった');
    expect(text('account-states#6')).toContain(
      '取れなかった: 取りに行けなかった（テスト用）（2026-10-26T23:30:00.000Z）。**0 ではなく、分からない。**',
    );
    expect(text('account-states#7')).toContain(
      '枠が返ってこない: 枠が返らなかった（テスト用）（2026-10-26T23:30:00.000Z）',
    );
    expect(text('account-states#7')).toContain(
      'accountInfo の応答が持っていた欄（名前だけ）: email, plan',
    );
    expect(text('account-states#8')).toContain(
      'accountInfo の応答: 無かった（欄の名前も取れていない）',
    );
    expect(text('account-states#9')).toContain('まだ取りに行っていない（起動直後）');
    for (let n = 2; n <= 9; n += 1)
      expect(ops(`account-states#${String(n)}`)).toContain('context.accountUsage');
    for (const n of [1, 2]) {
      expect(ops(`account-with-axis#${String(n)}`)).toEqual(['usage.aggregate']);
      expect(text(`account-with-axis#${String(n)}`)).not.toContain(HEAD_ACCOUNT);
    }

    // 記録の無い委譲
    expect(text('unrecorded-managers#1')).toContain(UNREC_ZERO);
    const unrec = text('unrecorded-managers#2');
    expect(unrec).toContain('⚠ 台帳に1行も記録が無い委譲: 3件。上の合計にはまだ入っていない。');
    expect(unrec.indexOf('mgr-904 [waiting_human]')).toBeLessThan(
      unrec.indexOf('mgr-902 [failed]'),
    );
    expect(unrec.indexOf('mgr-902 [failed]')).toBeLessThan(unrec.indexOf('mgr-901 [running]'));
    expect(unrec).not.toContain('mgr-903');
    expect(text('unrecorded-managers#3')).toContain(UNREC_ZERO);
    expect(text('unrecorded-managers#4')).toContain(UNREC_UNKNOWN);
    expect(ops('unrecorded-managers#4')).not.toContain('managers.list');
    expect(aggregateArgs('unrecorded-managers#5')).toEqual({
      managerId: 'mgr-001',
      from: '2026-10-22',
    });
    expect(text('unrecorded-managers#5')).toContain('⚠ 台帳に1行も記録が無い委譲: 3件');
    expect(text('unrecorded-managers#6')).toContain('その範囲には記録が無い。');
    for (const key of ['unrecorded-managers-axis#1', 'unrecorded-managers-axis#2']) {
      expect(ops(key), key).toEqual(['usage.aggregate']);
      expect(text(key), key).not.toContain('台帳に1行も記録が無い委譲');
    }
    expect(text('unrecorded-managers-empty-range')).toContain(
      'その範囲には記録が無い。\n\n⚠ 台帳に1行も記録が無い委譲: 3件',
    );

    // 始点の脚注
    expect(text('ledger-axes-sources#1')).toContain('その範囲には記録が無い。');
    expect(text('ledger-axes-sources#2')).toContain(
      '認証トークンの軸の始点: 2026-10-24T12:00:00.000Z',
    );
    expect(text('ledger-axes-sources#2')).toContain('層と場所の軸の始点: 2026-10-23T12:00:00.000Z');
    expect(count(text('ledger-axes-sources#2'), BEFORE)).toBe(4);
    expect(count(text('ledger-axes-sources#3'), BEFORE)).toBe(1);
    expect(text('ledger-axes-sources#3')).toContain('認証トークンの軸の始点より前にかかっている。');
    expect(count(text('ledger-axes-sources#4'), BEFORE)).toBe(0);
    expect(count(text('ledger-axes-sources#5'), BEFORE)).toBe(0);
    expect(text('ledger-axes-sources#6').startsWith('認証トークン別（全 2 件）')).toBe(true);

    // 値の形
    expect(text('value-forms#1')).toContain('$12345.68');
    expect(text('value-forms#1')).toContain('$0.0001');
    expect(text('value-forms#1')).toContain('  作業者 一: $0.9999');
    expect(text('value-forms#1')).toContain('  モデル 一: $0.9999');
    expect(text('value-forms#1')).toContain('入力 123,456,790 / ');
    expect(text('value-forms#2')).toContain('マネージャー別（全 4 件）\n  mgr-003: $12345.68');

    // ストアが投げる
    for (const key of ['aggregate-throws#1', 'aggregate-throws#2', 'aggregate-throws#3']) {
      expect(step(key).output.thrown, key).toBe(true);
      expect(step(key).output.errorName, key).toBe('Error');
      expect(text(key), key).toBe(AGGREGATE_FAILS);
      expect(ops(key), key).toEqual(['usage.aggregate']);
      expect(step(key).calls[0]?.outcome, key).toBe(`threw Error: ${AGGREGATE_FAILS}`);
    }
    expect(step('aggregate-throws#4').output.thrown).toBe(false);
    expect(ops('aggregate-throws#4')).toEqual([]);
    expect(step('aggregate-throws#5').output.thrown).toBe(false);
    expect(ops('aggregate-throws#5')).toEqual([]);
    expect(ops('aggregate-throws#6')).toEqual(FULL_OPS);
    expect(step('recorded-or-managers-throws#1').output.thrown).toBe(true);
    expect(text('recorded-or-managers-throws#1')).toBe('委譲の一覧が読めない');
    expect(ops('recorded-or-managers-throws#1')).toEqual([
      'usage.aggregate',
      'managers.list',
      'usage.recordedManagerIds',
    ]);
    expect(step('recorded-or-managers-throws#2').output.thrown).toBe(true);
    expect(text('recorded-or-managers-throws#2')).toBe('記録の一覧が読めない');
    expect(step('recorded-or-managers-throws#3').output.thrown).toBe(true);
    expect(ops('recorded-or-managers-throws#3')).toEqual([
      'usage.aggregate',
      'managers.list',
      'usage.recordedManagerIds',
    ]);
    expect(step('recorded-or-managers-throws#4').output.thrown).toBe(false);
    expect(ops('recorded-or-managers-throws#4')).toEqual(['usage.aggregate']);
  });
});
