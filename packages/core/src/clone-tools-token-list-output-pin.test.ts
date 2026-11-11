import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderListingEntry } from './excerpt.js';
import { UnreadableActiveTokenError, UnreadableTokenSettingsError } from './store.js';
import type { Stores } from './store.js';
import type { UnreadableToken } from './schema.js';
import type {
  ActiveAgentToken,
  AgentToken,
  CooldownSource,
  TokenRotationSettings,
} from './token-pool.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `token_list` の出力（全文と字数）と、呼んだあとの状態（トークンの行・設定・現役の指名・日誌・ストアの書き込み口が呼ばれたか）を、
// 場面ごとにコミットした固定値（clone-tools-token-list-output-pin.json）と丸ごと比べる。
// `clone-tools-profile.ts` の `tool('token_list', …)`（約 136 行・入れ子 8 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・トークンの行）を固定して毎回同じにする。
// この道具は読むだけ。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - wrote: 呼ぶ前後でトークンの行（値を含む）・設定・現役の指名・日誌の行数が変わったか。全場面で false（試験の中で比べる）
//   - writeCalls: 呼びの間にストアの書き込み口（tokens の replace / writeSettings / writeActive / removeUnreadable・日誌の append・
//     tokens と日誌以外のストアのどの口でも）が呼ばれた記録。全場面で空
//   - readCalls: 呼びの間に呼ばれた tokens の読む口の並び（list → listUnreadable → readSettings → readActive の順と、途中で落ちたら以降を読まないこと）
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
// （環境変数の名前を `UPDATE_TOKEN_LIST_PIN` にしない: `vitest.env-scrub.ts` が語 `TOKEN` を含む名前を秘密として外すため、渡しても届かない）
//   UPDATE_TOKENLIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-token-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-token-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 秘密: 入力のトークンの値は明らかな偽物（`fake-token-value-<id>`）。道具は値を返さない作り（id・ラベル・指紋・状態だけ）で、
// 場面ごとに「入力に使った値のどれも出力の全文に含まれない」と、「json の全文にも含まれない」を確かめる。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。冷却の期限は基準時刻（BASE_ISO）からの相対で絶対値にして入れる。
// 一覧の予算（TOKEN_LIST_BUDGET = 6,000 字）の境目は、1件ぶんの字数を `renderListingEntry` で測ってラベルの長さで合わせて作る。
// 続きの cursor を使う場面は、前の呼びの出力から cursor を取り出して渡す（道具が案内した cursor がそのまま使えることも測る）。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

interface SeedToken {
  id: string;
  label: string;
  order: number;
  value?: string;
  disabledAt?: string;
  cooldownUntil?: number;
  cooldownSource?: CooldownSource;
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Hooks {
  /** 一覧が返す「読めない行」 */
  unreadable?: UnreadableToken[];
  listFails?: boolean;
  listUnreadableFails?: boolean;
  /** readSettings が落ちる。unreadable は UnreadableTokenSettingsError、other は普通の Error */
  settings?: 'unreadable' | 'other';
  /** readActive が落ちる。unreadable は UnreadableActiveTokenError、other は普通の Error */
  active?: 'unreadable' | 'other';
}

interface Step {
  /** 前の呼びの出力の全文（先頭の呼びは空）を受けて引数を作れる（cursor の取り出し用） */
  args: Args | ((previous: string) => Args);
  hooks?: Hooks;
  /** この呼びの直前に、別の経路がストアを動かす（呼ぶ前の状態を作る。道具の書き込みではない） */
  before?: (base: Stores) => Promise<void>;
}

interface Scenario {
  name: string;
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedToken[];
  settings?: TokenRotationSettings;
  active?: ActiveAgentToken;
  hooks?: Hooks;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const T_CREATED = '2026-10-01T00:00:00.000Z';
const T_UPDATED = '2026-10-02T03:04:05.000Z';
const PIN_URL = new URL('./clone-tools-token-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TOKENLIST_PIN === '1';

const TOKEN_LIST_BUDGET = 6_000;

/** 入力に使った偽のトークンの値（全部）。出力・json に1つも出ないことを確かめる */
const ALL_VALUES = new Set<string>();

function fakeValue(id: string): string {
  return `fake-token-value-${id}`;
}

function tok(
  id: string,
  order: number,
  extra: Partial<Omit<SeedToken, 'id' | 'order'>> = {},
): SeedToken {
  const value = 'value' in extra ? extra.value : fakeValue(id);
  const rest = { ...extra };
  delete rest.value;
  if (value !== undefined) ALL_VALUES.add(value);
  return {
    id,
    label: `ラベル ${id}`,
    order,
    createdAt: T_CREATED,
    updatedAt: T_UPDATED,
    ...rest,
    ...(value === undefined ? {} : { value }),
  };
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** cursor を道具の実装と独立に組む（形そのものも固定する） */
function cur(id: string, order: number): string {
  return rawCursor({ id, order });
}

/** 前の出力の「続きは token_list cursor=… で取れる」から cursor を取り出す */
function cursorOf(previous: string): string {
  const found = /token_list cursor=([A-Za-z0-9_-]+) で取れる/.exec(previous);
  if (found === null || found[1] === undefined) throw new Error('前の出力に cursor の案内が無い');
  return found[1];
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 一覧の1件ぶんの字数（ready の行。値あり） */
function itemLength(spec: SeedToken): number {
  return renderListingEntry({
    id: spec.id,
    title: 'ready',
    summary: `${spec.label}（order ${String(spec.order)}）`,
    createdAt: T_CREATED,
    updatedAt: T_UPDATED,
    extra: [`  指紋 ${fingerprint(spec.value ?? '')}`],
  }).length;
}

/** 先頭から count 件の1件ぶんの字数の合計がちょうど target になる並び（最後の1件のラベルの長さで合わせる）。後ろに extras を足す */
function calibrated(count: number, target: number, extras: SeedToken[] = []): SeedToken[] {
  const specs = Array.from({ length: count }, (_, index) =>
    tok(`b-${pad2(index + 1)}`, index, { label: spaced(300, 'label') }),
  );
  const last = specs[count - 1];
  if (last === undefined) throw new Error('count が 0');
  let others = 0;
  for (const spec of specs.slice(0, -1)) others += itemLength(spec);
  const base = itemLength({ ...last, label: '' });
  const labelLen = target - others - base;
  if (labelLen < 1) throw new Error(`ラベルの長さが合わせられない: ${String(labelLen)}`);
  last.label = spaced(labelLen, 'label');
  const total = others + itemLength(last);
  if (total !== target) throw new Error(`合計が目標と違う: ${String(total)} / ${String(target)}`);
  return [...specs, ...extras];
}

function manyTokens(count: number): SeedToken[] {
  return Array.from({ length: count }, (_, index) =>
    tok(`m-${pad2(index + 1)}`, index, { label: spaced(150, 'lab') }),
  );
}

const HIT_TIME = "You've hit your limit · resets 3pm (UTC)";
const HIT_ACTION = "You've hit your individual spend limit · ask your admin to raise it";
const HIT_UNKNOWN = "You've hit your limit";
const ORG_POLICY = 'This service is disabled for your org';
const PLAIN_REASON = 'some unclassified rejection';

/** 全部の状態・出所・理由を持つ標準のプール（order 昇順） */
const MIX: SeedToken[] = [
  tok('t-ready', 0),
  tok('t-cool-quota', 1, {
    cooldownUntil: BASE_MS + 2 * 3_600_000,
    cooldownSource: 'quota_reset',
    lastRejectedAt: '2026-10-28T23:00:00.000Z',
    lastRejectedReason: HIT_TIME,
  }),
  tok('t-cool-overage', 2, {
    cooldownUntil: BASE_MS + 3_600_000,
    cooldownSource: 'overage_reset',
    lastRejectedReason: HIT_ACTION,
  }),
  tok('t-cool-notice', 3, {
    cooldownUntil: BASE_MS + 5 * 60_000,
    cooldownSource: 'notice_text',
    lastRejectedReason: PLAIN_REASON,
  }),
  tok('t-cool-default', 4, {
    cooldownUntil: BASE_MS + 18_000_000,
    cooldownSource: 'default',
  }),
  tok('t-cool-unrecorded', 5, { cooldownUntil: BASE_MS + 1_000 }),
  tok('t-disabled', 6, { disabledAt: '2026-10-10T00:00:00.000Z' }),
  tok('t-invalid', 7, {
    invalidatedAt: '2026-10-20T00:00:00.000Z',
    invalidatedReason: 'authentication_failed',
  }),
  tok('t-no-times', 8, { value: undefined, createdAt: undefined, updatedAt: undefined }),
  tok('t-expired', 9, { cooldownUntil: BASE_MS - 1, cooldownSource: 'quota_reset' }),
];

function withoutTimes(spec: SeedToken): SeedToken {
  const out = { ...spec };
  delete out.createdAt;
  delete out.updatedAt;
  return out;
}

const ONE = [tok('only-1', 0)];

function activeOf(tokenId: string, generation = 3): ActiveAgentToken {
  return { tokenId, generation, rotatedAt: '2026-10-27T12:00:00.000Z' };
}

const GONE_POOL = [tok('g-a', 0), tok('g-b', 1), tok('g-c', 1), tok('g-d', 2)];
const GONE_POOL_NO_B = [GONE_POOL[0]!, GONE_POOL[2]!, GONE_POOL[3]!];
const FOLD_POOL = [tok('f-a', 0), tok('f-b', 1)];

function unreadableRows(n: number, named = true): UnreadableToken[] {
  return Array.from({ length: n }, (_, i) => ({
    ...(named ? { id: `bad-${pad2(i + 1)}` } : {}),
    reason: '壊れ',
  }));
}

const SCENARIOS: Scenario[] = [
  // ---- 空のプール ----
  {
    name: 'empty-pool',
    group: '空のプール',
    covers:
      'トークンが1件も無く読めない行も無い: 「プールは空である」＋登録の案内。設定・現役の指名は既定（null）',
    seed: [],
    steps: [{ args: {} }],
  },
  {
    name: 'empty-cursor',
    group: '空のプール',
    covers:
      '空のプールに cursor: 正しい cursor は「cursor より後ろのトークンは無い」（空のときの言い方より先）。壊れた cursor（空文字を含む）は壊れた断り。いずれも設定・現役の行は付かない',
    seed: [],
    steps: [
      { args: { cursor: cur('x', 0) } },
      { args: { cursor: 'garbage' } },
      { args: { cursor: '' } },
    ],
  },
  {
    name: 'empty-with-unreadable',
    group: '空のプール',
    covers:
      '読める行が無く読めない行だけ: 「プールは空である」とは言わず「読めたトークンの行は無い」。読めない行の注（id・ラベルの出方）が頭に付く',
    seed: [],
    steps: [
      { args: {}, hooks: { unreadable: [{ id: 'bad-1', label: '壊れたラベル', reason: '壊れ' }] } },
      { args: {}, hooks: { unreadable: [{ label: 'ラベルだけ', reason: '壊れ' }] } },
      { args: {}, hooks: { unreadable: [{ reason: 'id もラベルも無い' }] } },
    ],
  },

  // ---- 設定 ----
  {
    name: 'settings-variants',
    group: '設定（readSettings）',
    covers:
      '設定の行: 既定（free_exhausted / 18000000ms）・off・overage_exhausted と短い冷却・長い冷却。別の経路が writeSettings した後の読み（道具は書かない）',
    seed: ONE,
    steps: [
      { args: {} },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1 });
        },
      },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeSettings({
            rotateOn: 'overage_exhausted',
            cooldownMs: 123_456_789,
          });
        },
      },
    ],
  },
  {
    name: 'settings-unreadable',
    group: '設定（readSettings）',
    covers:
      '設定が読めない（UnreadableTokenSettingsError）: 例外にせず設定の行が「回転の設定は読めない（理由）。直すには…」に代わり、一覧は出る。プールが空でも・現役の指名が読めなくても続く。現役の指名は読みに行く',
    seed: ONE,
    hooks: { settings: 'unreadable' },
    steps: [
      { args: {} },
      { args: {}, hooks: { settings: 'unreadable', active: 'unreadable' } },
      {
        args: {},
        before: async (base) => {
          await base.tokens.replace([]);
        },
      },
    ],
  },
  {
    name: 'settings-other-error',
    group: '設定（readSettings）',
    covers:
      '設定の読みが UnreadableTokenSettingsError 以外で落ちる: 飲み込まず例外のまま出る（THREW）。現役の指名は読まない（readCalls で固定）。list が先に落ちれば設定も読まない',
    seed: ONE,
    steps: [
      { args: {}, hooks: { settings: 'other' } },
      { args: {}, hooks: { settings: 'other', active: 'unreadable' } },
      { args: {}, hooks: { listFails: true, settings: 'other' } },
      { args: {}, hooks: { listUnreadableFails: true, settings: 'other' } },
    ],
  },

  // ---- 現役の指名 ----
  {
    name: 'active-states',
    group: '現役の指名（readActive）',
    covers:
      '現役の指名: まだ一度も無い（null）・状態ごとの行に「← 現役」（ready / cooling / disabled）・プールに居ない id・世代 0。印は id が一致する1行だけに付く',
    seed: MIX,
    steps: [
      { args: {} },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeActive(activeOf('t-ready'));
        },
      },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeActive(activeOf('t-cool-quota', 4));
        },
      },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeActive(activeOf('t-disabled', 0));
        },
      },
      {
        args: {},
        before: async (base) => {
          await base.tokens.writeActive(activeOf('t-not-in-pool', 1));
        },
      },
    ],
  },
  {
    name: 'active-unreadable',
    group: '現役の指名（readActive）',
    covers:
      '現役の指名が読めない（UnreadableActiveTokenError）: 「現役の指名は読めない（理由）。」で、null（まだ一度も無い）とは別の文。どの行にも「← 現役」は付かない。読めない行・設定が読めない場合と重なっても続く',
    seed: MIX,
    active: activeOf('t-ready'),
    steps: [
      { args: {}, hooks: { active: 'unreadable' } },
      {
        args: {},
        hooks: { active: 'unreadable', settings: 'unreadable', unreadable: unreadableRows(1) },
      },
    ],
  },
  {
    name: 'active-other-error',
    group: '現役の指名（readActive）',
    covers:
      '現役の読みが UnreadableActiveTokenError 以外で落ちる: 飲み込まず例外のまま出る（THREW）',
    seed: ONE,
    steps: [{ args: {}, hooks: { active: 'other' } }],
  },

  // ---- 状態 ----
  {
    name: 'state-mix',
    group: '状態',
    covers:
      '標準の10件: ready・冷却中（出所 4 種＋記録なし）・無効（人間が外した）・失効・時刻と指紋の無い行・冷却明けを過ぎた行。止まった理由（原文）と回復の見込み（time / action / unknown）、失効（原文）。冷却の行は ISO の時刻と出所',
    seed: MIX,
    steps: [{ args: {} }],
  },
  {
    name: 'state-mix-active',
    group: '状態',
    covers:
      '標準の10件に現役の指名（冷却中の行）と設定の変更。「← 現役」は冷却中の行の title の末尾',
    seed: MIX,
    settings: { rotateOn: 'overage_exhausted', cooldownMs: 3_600_000 },
    active: activeOf('t-cool-overage', 7),
    steps: [{ args: {} }],
  },
  {
    name: 'state-precedence',
    group: '状態',
    covers:
      '状態の優先: disabled > invalidated > cooling > ready。disabled と invalidated と cooldown が全部在る行は disabled、invalidated と cooldown は invalidated。各行の追加行（冷却明け・人間が外した・理由・失効）は状態に関わらず出る',
    seed: [
      tok('p-all', 0, {
        disabledAt: '2026-10-10T00:00:00.000Z',
        invalidatedAt: '2026-10-11T00:00:00.000Z',
        invalidatedReason: 'revoked',
        cooldownUntil: BASE_MS + 3_600_000,
        cooldownSource: 'default',
        lastRejectedReason: HIT_TIME,
      }),
      tok('p-inv-cool', 1, {
        invalidatedAt: '2026-10-11T00:00:00.000Z',
        cooldownUntil: BASE_MS + 3_600_000,
        cooldownSource: 'quota_reset',
      }),
      tok('p-dis-cool', 2, {
        disabledAt: '2026-10-10T00:00:00.000Z',
        cooldownUntil: BASE_MS + 3_600_000,
      }),
      tok('p-dis-inv', 3, {
        disabledAt: '2026-10-10T00:00:00.000Z',
        invalidatedAt: '2026-10-11T00:00:00.000Z',
      }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'state-cooldown-boundary',
    group: '状態',
    covers:
      '冷却の境目（比較は「期限が now より後ろなら cooling」）: 期限が now の 1ms 前・ちょうど now・1ms 後。now と同時刻は ready、1ms 後は cooling。どれも冷却明けの行は出る',
    seed: [
      tok('c-before', 0, { cooldownUntil: BASE_MS - 1, cooldownSource: 'default' }),
      tok('c-equal', 1, { cooldownUntil: BASE_MS, cooldownSource: 'default' }),
      tok('c-after', 2, { cooldownUntil: BASE_MS + 1, cooldownSource: 'default' }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'state-recovery',
    group: '状態',
    covers:
      '止まった理由の分類（回復の見込み）: time（resets を含む）・action（individual spend limit・組織方針）・unknown（上限の接頭辞だが分類なし・上限の文言ですらない）。理由は原文のまま（言い換えない）',
    seed: [
      tok('r-time', 0, { lastRejectedReason: HIT_TIME }),
      tok('r-action', 1, { lastRejectedReason: HIT_ACTION }),
      tok('r-org', 2, { lastRejectedReason: ORG_POLICY }),
      tok('r-unknown-prefix', 3, { lastRejectedReason: HIT_UNKNOWN }),
      tok('r-unknown-plain', 4, { lastRejectedReason: PLAIN_REASON }),
      tok('r-empty', 5, { lastRejectedReason: '' }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'state-reason-excerpt',
    group: '状態',
    covers:
      '止まった理由・失効の理由の抜粋（200 字）: 199 / 200 字はそのまま、201 字は 200 字で切って「…（1 文字省略。全 201 文字）」。空白・改行は1つの空白にたたむ（たたんだ後が収まれば切らない）。補助面の文字は 1 字と数える（200 字目が補助面の文字ならそこまで残す。1 文字省略。全 201 文字）',
    seed: [
      tok('x-199', 0, { lastRejectedReason: spaced(199), invalidatedReason: spaced(199) }),
      tok('x-200', 1, { lastRejectedReason: spaced(200), invalidatedReason: spaced(200) }),
      tok('x-201', 2, { lastRejectedReason: spaced(201), invalidatedReason: spaced(201) }),
      tok('x-fold', 3, {
        lastRejectedReason: 'abcdefghi\n\n   '.repeat(20),
        invalidatedReason: '前後に空白  \n  ',
      }),
      tok('x-astral', 4, {
        lastRejectedReason: `${spaced(199)}😀z`,
        invalidatedReason: `${spaced(199)}😀z`,
      }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'state-fields',
    group: '状態',
    covers:
      '欄の有り無し: 作成だけ・更新だけ・両方無し（「（記録が無い）」。now で埋めない）・値が無い行（指紋の行が出ない）・ラベルが空・ラベルに改行・order が負・同じ order の行（並びは order 昇順で、同値は入れた順）・冷却の出所が無い行',
    seed: [
      tok('f-neg', -5, { label: '負の order' }),
      tok('f-created-only', 0, { updatedAt: undefined }),
      tok('f-updated-only', 0, { createdAt: undefined }),
      withoutTimes(tok('f-none', 1)),
      tok('f-novalue', 1, { value: undefined }),
      tok('f-empty-label', 2, { label: '' }),
      tok('f-newline-label', 3, { label: '一行目\n二行目' }),
      tok('f-nosource', 4, { cooldownUntil: BASE_MS + 60_000 }),
    ],
    steps: [{ args: {} }],
  },

  // ---- 読めない行 ----
  {
    name: 'unreadable-with-pool',
    group: '読めない行',
    covers:
      '読める行と読めない行が両方在る: 一覧の頭（設定・現役の下）に注が付き、「プールは空」「読めたトークンの行は無い」は出ない。id・ラベル・両方・どちらも無しの出し分け。id の無い行が在れば「（id が取れない行は、その口では消せない）」',
    seed: [tok('u-1', 0), tok('u-2', 1)],
    steps: [
      { args: {}, hooks: { unreadable: [{ id: 'bad-1', reason: '壊れ' }] } },
      { args: {}, hooks: { unreadable: [{ id: 'bad-1', label: 'ラベル1', reason: '壊れ' }] } },
      { args: {}, hooks: { unreadable: [{ label: 'ラベルだけ', reason: '壊れ' }] } },
      {
        args: {},
        hooks: { unreadable: [{ id: 'bad-1', reason: '壊れ' }, { reason: 'どちらも無い' }] },
      },
      { args: {}, hooks: { unreadable: [{ reason: 'どちらも無い' }, { reason: 'どちらも無い' }] } },
    ],
  },
  {
    name: 'unreadable-shown-limit',
    group: '読めない行',
    covers:
      '読めない行の名前は 10 件まで: 10 件は全部並べ、11 件目から「ほか n 件」。id の無い行は件数に数えるが並びには出ない（「id もラベルも取れない行が n 件」）',
    seed: ONE,
    steps: [
      ...[10, 11, 15].map((n) => ({ args: {}, hooks: { unreadable: unreadableRows(n) } })),
      {
        args: {},
        hooks: { unreadable: [...unreadableRows(3), ...unreadableRows(2, false)] },
      },
      {
        args: {},
        hooks: { unreadable: [...unreadableRows(11), ...unreadableRows(2, false)] },
      },
    ],
  },

  // ---- 予算（TOKEN_LIST_BUDGET）----
  {
    name: 'budget-exact-fit',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers:
      '12 件の字数の合計がちょうど 6,000 字: 全部出る（省略の断り書きなし）。比較は「予算を超えたら切る」（6,000 字ちょうどは超えない）',
    seed: calibrated(12, TOKEN_LIST_BUDGET),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-under-by-one',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers: '12 件の字数の合計が 5,999 字: 全部出る',
    seed: calibrated(12, TOKEN_LIST_BUDGET - 1),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-over-by-one',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers:
      '12 件の字数の合計が 6,001 字: 最後の1件だけ落ちる（…ほか 1 件は省略。プールは 12 件あり 11 件を出した）。続きの cursor は 11 件目の id と order。cursor で続けると最後の1件が出る',
    seed: calibrated(12, TOKEN_LIST_BUDGET + 1),
    steps: [{ args: {} }, { args: (previous) => ({ cursor: cursorOf(previous) }) }],
  },
  {
    name: 'budget-first-item-over',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers:
      '先頭の1件だけで予算を超える（ラベルが 7,000 字）: その1件を抜粋して出し（…（n 文字省略。全 m 文字））、後ろは省略。続きは1件目から。cursor で続けると残りが出る',
    seed: [tok('big-1', 0, { label: spaced(7_000, 'huge') }), tok('small-1', 1), tok('small-2', 2)],
    steps: [{ args: {} }, { args: (previous) => ({ cursor: cursorOf(previous) }) }],
  },
  {
    name: 'budget-single-6000',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers: '先頭の1件がちょうど 6,000 字: 抜粋せず出る。後ろの1件は予算が尽きて省略',
    seed: calibrated(1, TOKEN_LIST_BUDGET, [tok('after-1', 1)]),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-6001',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers: '先頭の1件が 6,001 字: 抜粋される（1 文字省略）。後ろの1件は省略',
    seed: calibrated(1, TOKEN_LIST_BUDGET + 1, [tok('after-1', 1)]),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-pages',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers:
      '30 件を頁で読む: 1頁目 → 案内の cursor で2頁目（最後。省略なし）→ 最後の件の cursor で「これが最後の頁」。母数（プールは 30 件あり）は頁が進んでも省略の文にだけ出る',
    seed: manyTokens(30),
    steps: [
      { args: {} },
      { args: (previous) => ({ cursor: cursorOf(previous) }) },
      { args: { cursor: cur('m-30', 29) } },
    ],
  },
  {
    name: 'budget-with-notes',
    group: '予算（TOKEN_LIST_BUDGET）',
    covers:
      '予算で切れた回にも、頭の設定・現役・読めない行の注と脚注が付く。予算は一覧の件だけで測る（頭・脚注は数えない）。cursor の続きにも頭が付く（最後の頁の断りのときだけ付かない）',
    seed: manyTokens(30),
    active: activeOf('m-02'),
    hooks: { unreadable: unreadableRows(2) },
    steps: [
      { args: {} },
      { args: (previous) => ({ cursor: cursorOf(previous) }) },
      { args: { cursor: cur('m-30', 29) } },
    ],
  },

  // ---- cursor ----
  {
    name: 'cursor-follow',
    group: 'cursor',
    covers:
      '標準の10件で cursor を渡す: 先頭の次から・途中・最後の1つ前（最後の1件だけ）・最後の件（「これが最後の頁」）。cursor の前の行は出ない。指す id が居れば order は見ない（食い違う order でも id で切る）',
    seed: MIX,
    steps: [
      { args: { cursor: cur('t-ready', 0) } },
      { args: { cursor: cur('t-cool-notice', 3) } },
      { args: { cursor: cur('t-no-times', 8) } },
      { args: { cursor: cur('t-expired', 9) } },
      { args: { cursor: cur('t-cool-notice', 999) } },
    ],
  },
  {
    name: 'cursor-malformed',
    group: 'cursor',
    covers:
      'cursor が壊れている: 空文字・base64url でない・JSON でない・null・数・文字列・配列・id が無い・id が空・id が数・order が無い・order が小数・order が文字列。どれも同じ断り（先頭から読み直す案内）。余分な欄が有っても正しければ通る',
    seed: MIX,
    steps: [
      { args: { cursor: '' } },
      { args: { cursor: '!!!' } },
      { args: { cursor: Buffer.from('not json', 'utf8').toString('base64url') } },
      { args: { cursor: rawCursor(null) } },
      { args: { cursor: rawCursor(5) } },
      { args: { cursor: rawCursor('t-ready') } },
      { args: { cursor: rawCursor([]) } },
      { args: { cursor: rawCursor({ order: 0 }) } },
      { args: { cursor: rawCursor({ id: '', order: 0 }) } },
      { args: { cursor: rawCursor({ id: 5, order: 0 }) } },
      { args: { cursor: rawCursor({ id: 't-ready' }) } },
      { args: { cursor: rawCursor({ id: 't-ready', order: 0.5 }) } },
      { args: { cursor: rawCursor({ id: 't-ready', order: '0' }) } },
      { args: { cursor: rawCursor({ id: 't-ready', order: 0, extra: 1 }) } },
    ],
  },
  {
    name: 'cursor-anchor-gone',
    group: 'cursor',
    covers:
      'cursor の指す id が居ない: 錨と同じ order 以上の行から続ける（「>」ではなく「>=」: 同じ order の別の行を飛ばさない）。order が全部より大きければ「これが最後の頁」。錨が呼ぶ前に消されても同じ',
    seed: GONE_POOL,
    steps: [
      { args: { cursor: cur('g-b', 1) } },
      { args: { cursor: cur('no-such', 1) } },
      { args: { cursor: cur('no-such', 0) } },
      { args: { cursor: cur('no-such', 2) } },
      { args: { cursor: cur('no-such', 3) } },
      {
        args: { cursor: cur('g-b', 1) },
        before: async (base) => {
          await base.tokens.replace(GONE_POOL_NO_B.map(({ ...spec }) => spec));
        },
      },
    ],
  },
  {
    name: 'cursor-with-unreadable',
    group: 'cursor',
    covers:
      '読めない行が在るとき cursor の続きにも注が付く。最後の頁の断り・壊れた cursor の断りには付かない（頭の設定・現役の行も付かない）',
    seed: FOLD_POOL,
    hooks: { unreadable: unreadableRows(1) },
    steps: [
      { args: { cursor: cur('f-a', 0) } },
      { args: { cursor: cur('f-b', 1) } },
      { args: { cursor: 'garbage' } },
    ],
  },
  {
    name: 'cursor-malformed-before-errors',
    group: 'cursor',
    covers:
      'cursor の検査は設定・現役を読んだあと: 設定が読めない・現役が読めなくても、壊れた cursor の断りが出る（例外にならない）。設定が普通の Error で落ちれば cursor の検査まで届かず例外',
    seed: ONE,
    steps: [
      { args: { cursor: 'garbage' }, hooks: { settings: 'unreadable', active: 'unreadable' } },
      { args: { cursor: cur('only-1', 0) }, hooks: { settings: 'unreadable' } },
      { args: { cursor: 'garbage' }, hooks: { settings: 'other' } },
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
}

interface PinnedStep {
  output: PinnedOutput;
  /** トークンの行・設定・現役の指名・日誌が呼ぶ前から変わったか（読むだけの道具なので全場面で false） */
  wrote: boolean;
  /** 呼びの間に呼ばれたストアの書き込み口（全場面で空） */
  writeCalls: string[];
  /** 呼びの間に呼ばれた tokens の読む口の並び */
  readCalls: string[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`） */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(stores: Stores): Promise<unknown> {
  return plain({
    tokens: await stores.tokens.list(),
    settings: await stores.tokens.readSettings(),
    active: await stores.tokens.readActive(),
    journalCount: (await stores.journal.list({ order: 'asc' })).length,
  });
}

interface Calls {
  reads: string[];
  writes: string[];
}

function withHooks(base: Stores, hooks: () => Hooks, calls: Calls): Stores {
  const tokens: Stores['tokens'] = {
    ...base.tokens,
    list: async () => {
      calls.reads.push('tokens.list');
      if (hooks().listFails === true) throw new Error('トークンの一覧が読めない');
      return base.tokens.list();
    },
    listUnreadable: async () => {
      calls.reads.push('tokens.listUnreadable');
      const now = hooks();
      if (now.listUnreadableFails === true) throw new Error('読めない行の一覧が読めない');
      return now.unreadable ?? [];
    },
    readSettings: async () => {
      calls.reads.push('tokens.readSettings');
      const now = hooks();
      if (now.settings === 'unreadable') {
        throw new UnreadableTokenSettingsError('cooldownMs が壊れている（テスト用）');
      }
      if (now.settings === 'other') throw new Error('設定のストアが落ちた');
      return base.tokens.readSettings();
    },
    readActive: async () => {
      calls.reads.push('tokens.readActive');
      const now = hooks();
      if (now.active === 'unreadable') {
        throw new UnreadableActiveTokenError('tokenId が壊れている（テスト用）');
      }
      if (now.active === 'other') throw new Error('現役のストアが落ちた');
      return base.tokens.readActive();
    },
    replace: (...args) => {
      calls.writes.push('tokens.replace');
      return base.tokens.replace(...args);
    },
    writeSettings: (...args) => {
      calls.writes.push('tokens.writeSettings');
      return base.tokens.writeSettings(...args);
    },
    writeActive: (...args) => {
      calls.writes.push('tokens.writeActive');
      return base.tokens.writeActive(...args);
    },
    removeUnreadable: (...args) => {
      calls.writes.push('tokens.removeUnreadable');
      return base.tokens.removeUnreadable(...args);
    },
  };
  const out: Record<string, unknown> = { ...base, tokens };
  for (const [group, value] of Object.entries(base)) {
    if (group === 'tokens' || typeof value !== 'object' || value === null) continue;
    if (group === 'journal') {
      out[group] = {
        ...value,
        append: (...args: unknown[]) => {
          calls.writes.push('journal.append');
          return (value as { append: (...a: unknown[]) => unknown }).append(...args);
        },
      };
      continue;
    }
    // tokens と日誌以外のストアは、どの口が呼ばれても記録する（この道具は触らないはず）
    out[group] = new Proxy(value, {
      get(target, prop) {
        const member = (target as Record<string | symbol, unknown>)[prop];
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          calls.writes.push(`${group}.${String(prop)}`);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
  return out as unknown as Stores;
}

function toRow(spec: SeedToken): AgentToken {
  return { ...spec, source: 'stored' };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await base.tokens.replace(scenario.seed.map(toRow));
  if (scenario.settings !== undefined) await base.tokens.writeSettings(scenario.settings);
  if (scenario.active !== undefined) await base.tokens.writeActive(scenario.active);
  let hooks: Hooks = {};
  const calls: Calls = { reads: [], writes: [] };
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
  });
  const found = tools.find((entry) => entry.name === 'token_list');
  if (!found) throw new Error('token_list が無い');

  const results: PinnedStep[] = [];
  let previous = '';
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) await step.before(base);
    hooks = { ...scenario.hooks, ...step.hooks };
    const before = await snapshot(base);
    calls.reads.length = 0;
    calls.writes.length = 0;
    const args = typeof step.args === 'function' ? step.args(previous) : step.args;
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = { length: text.length, text, isError: result.isError === true, thrown: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = { length: text.length, text, isError: true, thrown: true };
    }
    previous = output.text;
    const reads = [...calls.reads];
    const writes = [...calls.writes];
    const after = await snapshot(base);
    const wrote = JSON.stringify(before) !== JSON.stringify(after);
    const key = stepKey(scenario, index);
    // 読むだけの道具: 行・設定・現役・日誌が呼ぶ前と同じで、書き込み口も呼ばれていない
    expect(after, `場面 ${key} は読むだけのはずだが、トークンの状態が呼ぶ前から変わった`).toEqual(
      before,
    );
    expect(writes, `場面 ${key} は読むだけのはずだが、書き込み口が呼ばれた`).toEqual([]);
    results.push({ output, wrote, writeCalls: writes, readCalls: reads });
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

describe('token_list の出力の固定（場面ごとの全文と字数・読むだけで書かないこと）', () => {
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
  }, 60_000);

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

  it('読むだけの道具: 全場面でトークン・設定・現役・日誌が変わらず、書き込み口も呼ばれていない', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe(false);
      expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe(false);
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
    }
  });

  it('トークンの値が出力にも json にも入っていない（入力の偽の値のどれも、各場面の出力の全文と json の全文に無い）', () => {
    expect(ALL_VALUES.size, '偽の値が1つも作られていない（確かめが空振り）').toBeGreaterThan(20);
    for (const key of ALL_KEYS) {
      const text = actual[key]?.output.text ?? '';
      for (const value of ALL_VALUES) {
        expect(text.includes(value), `場面 ${key} の出力にトークンの値 ${value} が入っている`).toBe(
          false,
        );
      }
      expect(text, `場面 ${key} の出力に偽の値の接頭辞が入っている`).not.toContain(
        'fake-token-value',
      );
    }
    for (const value of ALL_VALUES) {
      expect(pinnedRaw.includes(value), `json にトークンの値 ${value} が入っている`).toBe(false);
    }
    expect(pinnedRaw).not.toContain('fake-token-value');
    expect(pinnedRaw).not.toMatch(/sk-/);
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
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
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
        expect(got?.readCalls, `場面 ${key} の tokens の読む口の呼びの並びが変わった`).toEqual(
          want?.readCalls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const thrown = (key: string): boolean | undefined => actual[key]?.output.thrown;
    const reads = (key: string): string[] | undefined => actual[key]?.readCalls;
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const before = (key: string, first: string, second: string): boolean =>
      text(key).indexOf(first) >= 0 && text(key).indexOf(first) < text(key).indexOf(second);
    const EMPTY = 'プールは空である。**この状態では回らない**';
    const EMPTY_UNREADABLE = '読めたトークンの行は無い。**プールが空だとは言えない**';
    const LAST_PAGE = '（cursor より後ろのトークンは無い。これが最後の頁）';
    const MALFORMED = 'この cursor は読めない（壊れているか、この道具のものではない）。';
    const NO_ACTIVE = '現役の指名: **まだ一度も無い**';
    const SETTINGS_UNREADABLE = '回転の設定は読めない（cooldownMs が壊れている（テスト用））。';
    const ACTIVE_UNREADABLE = '現役の指名は読めない（tokenId が壊れている（テスト用））。';
    const FOOT_TIMES_FULL = '（作成 = 行を足した時刻 / 更新 = 最後に変わった時刻。';
    const REGISTER_FULL = '登録は人間の手で（`alteroid token add --label <名前> --file <path>`）。';
    const READ_ALL = [
      'tokens.list',
      'tokens.listUnreadable',
      'tokens.readSettings',
      'tokens.readActive',
    ];

    // 空のプール
    expect(text('empty-pool')).toContain(EMPTY);
    expect(text('empty-pool')).toContain('回す契機: free_exhausted / 冷却 18000000ms');
    expect(text('empty-pool')).toContain(NO_ACTIVE);
    expect(text('empty-pool')).toContain(REGISTER_FULL);
    expect(text('empty-cursor#1')).toBe(LAST_PAGE);
    expect(text('empty-cursor#2')).toContain(MALFORMED);
    expect(text('empty-cursor#3')).toContain(MALFORMED);
    expect(text('empty-with-unreadable#1')).toContain(EMPTY_UNREADABLE);
    expect(text('empty-with-unreadable#1')).not.toContain(EMPTY);
    expect(text('empty-with-unreadable#1')).toContain('（id bad-1 / ラベル 壊れたラベル）');
    expect(text('empty-with-unreadable#2')).toContain('（ラベル ラベルだけ）');
    expect(text('empty-with-unreadable#3')).toContain('（id もラベルも取れない）');
    expect(text('empty-with-unreadable#3')).toContain('（id が取れない行は、その口では消せない）');
    expect(text('empty-with-unreadable#1')).not.toContain('その口では消せない');
    // 設定
    expect(text('settings-variants#1')).toContain('回す契機: free_exhausted / 冷却 18000000ms');
    expect(text('settings-variants#2')).toContain('回す契機: off / 冷却 1ms');
    expect(text('settings-variants#3')).toContain('回す契機: overage_exhausted / 冷却 123456789ms');
    expect(text('settings-unreadable#1')).toContain(SETTINGS_UNREADABLE);
    expect(text('settings-unreadable#1')).toContain('- only-1 ready');
    expect(text('settings-unreadable#1')).toContain(
      '`alteroid token policy <free_exhausted|overage_exhausted|off> --cooldown-ms <値>` / `PUT /tokens/policy`',
    );
    expect(text('settings-unreadable#2')).toContain(ACTIVE_UNREADABLE);
    expect(text('settings-unreadable#2')).toContain(SETTINGS_UNREADABLE);
    expect(text('settings-unreadable#3')).toContain(EMPTY);
    expect(text('settings-unreadable#3')).toContain(SETTINGS_UNREADABLE);
    expect(reads('settings-unreadable#1')).toEqual(READ_ALL);
    expect(thrown('settings-other-error#1')).toBe(true);
    expect(text('settings-other-error#1')).toBe('設定のストアが落ちた');
    expect(reads('settings-other-error#1')).toEqual(READ_ALL.slice(0, 3));
    expect(thrown('settings-other-error#2')).toBe(true);
    expect(text('settings-other-error#3')).toBe('トークンの一覧が読めない');
    expect(reads('settings-other-error#3')).toEqual(['tokens.list']);
    expect(text('settings-other-error#4')).toBe('読めない行の一覧が読めない');
    expect(reads('settings-other-error#4')).toEqual(READ_ALL.slice(0, 2));
    // 現役の指名
    expect(text('active-states#1')).toContain(NO_ACTIVE);
    expect(text('active-states#1')).not.toContain('← 現役');
    expect(text('active-states#2')).toContain(
      '現役の指名: t-ready（世代 3、2026-10-27T12:00:00.000Z）',
    );
    expect(text('active-states#2')).toContain('- t-ready ready ← 現役');
    expect(count(text('active-states#2'), '← 現役')).toBe(1);
    expect(text('active-states#3')).toContain('- t-cool-quota cooling ← 現役');
    expect(text('active-states#4')).toContain('- t-disabled disabled ← 現役');
    expect(text('active-states#4')).toContain('（世代 0、');
    expect(text('active-states#5')).toContain('現役の指名: t-not-in-pool（世代 1、');
    expect(count(text('active-states#5'), '← 現役')).toBe(0);
    expect(text('active-unreadable#1')).toContain(ACTIVE_UNREADABLE);
    expect(text('active-unreadable#1')).not.toContain(NO_ACTIVE);
    expect(count(text('active-unreadable#1'), '← 現役')).toBe(0);
    expect(text('active-unreadable#2')).toContain(SETTINGS_UNREADABLE);
    expect(text('active-unreadable#2')).toContain('読めないトークンの行が 1 件ある');
    expect(thrown('active-other-error')).toBe(true);
    expect(text('active-other-error')).toBe('現役のストアが落ちた');
    expect(reads('active-other-error')).toEqual(READ_ALL);
    // 状態
    for (const state of ['ready', 'cooling', 'disabled', 'invalidated']) {
      expect(text('state-mix')).toContain(` ${state}\n`);
    }
    expect(text('state-mix')).toContain('- t-cool-quota cooling');
    expect(text('state-mix')).toContain('- t-expired ready');
    expect(text('state-mix')).toContain(
      '  冷却明け 2026-10-29T02:00:00.000Z（出所: 枠の resetsAt（権威ある値））',
    );
    expect(text('state-mix')).toContain(
      '（出所: 課金枠の overageResetsAt（権威ある値。枠そのものではない））',
    );
    expect(text('state-mix')).toContain(
      '（出所: **上限の文言に書かれていた時刻（推測。ただし既定よりは良い）**）',
    );
    expect(text('state-mix')).toContain('（出所: **設定の既定（ただの推測）**）');
    expect(text('state-mix')).toContain('（出所: 記録が無い）');
    expect(text('state-mix')).toContain('  人間が外した 2026-10-10T00:00:00.000Z');
    expect(text('state-mix')).toContain('  失効（原文）: authentication_failed');
    expect(text('state-mix')).toContain(
      `  止まった理由（原文）: ${HIT_TIME} / 回復の見込み（分類）: time`,
    );
    expect(text('state-mix')).toContain('作成: （記録が無い） / 更新: （記録が無い）');
    expect(count(text('state-mix'), '  指紋 ')).toBe(9);
    expect(text('state-mix-active')).toContain('回す契機: overage_exhausted / 冷却 3600000ms');
    expect(text('state-mix-active')).toContain('- t-cool-overage cooling ← 現役');
    expect(text('state-precedence')).toContain('- p-all disabled\n');
    expect(text('state-precedence')).toContain('- p-inv-cool invalidated\n');
    expect(text('state-precedence')).toContain('- p-dis-cool disabled\n');
    expect(text('state-precedence')).toContain('- p-dis-inv disabled\n');
    expect(text('state-cooldown-boundary')).toContain('- c-before ready');
    expect(text('state-cooldown-boundary')).toContain('- c-equal ready');
    expect(text('state-cooldown-boundary')).toContain('- c-after cooling');
    expect(count(text('state-cooldown-boundary'), '  冷却明け ')).toBe(3);
    expect(text('state-recovery')).toContain('回復の見込み（分類）: time');
    expect(text('state-recovery')).toContain('回復の見込み（分類）: action');
    expect(text('state-recovery')).toContain('回復の見込み（分類）: unknown');
    expect(count(text('state-recovery'), '回復の見込み（分類）: action')).toBe(2);
    expect(count(text('state-recovery'), '回復の見込み（分類）: unknown')).toBe(3);
    expect(count(text('state-reason-excerpt'), '文字省略。全 ')).toBe(4);
    expect(text('state-reason-excerpt')).toContain('…（1 文字省略。全 201 文字）');
    expect(text('state-reason-excerpt')).toContain('😀…（1 文字省略。全 201 文字）');
    expect(text('state-fields')).toContain('作成: （記録が無い） / 更新: ' + T_UPDATED);
    expect(text('state-fields')).toContain('作成: ' + T_CREATED + ' / 更新: （記録が無い）');
    expect(before('state-fields', '- f-neg ', '- f-created-only ')).toBe(true);
    expect(before('state-fields', '- f-none ', '- f-novalue ')).toBe(true);
    expect(count(text('state-fields'), '  指紋 ')).toBe(7);
    expect(text('state-fields')).toContain('一行目\n二行目（order 3）');
    // 読めない行
    expect(text('unreadable-with-pool#1')).not.toContain('読める task');
    expect(text('unreadable-with-pool#1')).not.toContain(EMPTY);
    expect(text('unreadable-with-pool#1')).toContain(
      '読めないトークンの行が 1 件ある（id bad-1）。',
    );
    expect(text('unreadable-with-pool#2')).toContain('（id bad-1 / ラベル ラベル1）');
    expect(text('unreadable-with-pool#4')).toContain('。id もラベルも取れない行が 1 件）');
    expect(text('unreadable-with-pool#5')).toContain('（id もラベルも取れない）');
    expect(before('unreadable-with-pool#1', '現役の指名', '読めないトークンの行')).toBe(true);
    expect(before('unreadable-with-pool#1', '読めないトークンの行', '- u-1 ')).toBe(true);
    expect(text('unreadable-shown-limit#1')).toContain('bad-10）');
    expect(text('unreadable-shown-limit#1')).not.toContain('ほか');
    expect(text('unreadable-shown-limit#2')).toContain('bad-10 ほか 1 件）');
    expect(text('unreadable-shown-limit#2')).not.toContain('bad-11');
    expect(text('unreadable-shown-limit#3')).toContain('ほか 5 件');
    expect(text('unreadable-shown-limit#4')).toContain('。id もラベルも取れない行が 2 件）');
    expect(text('unreadable-shown-limit#5')).toContain(
      'ほか 1 件。id もラベルも取れない行が 2 件）',
    );
    // 予算
    for (const key of ['budget-exact-fit', 'budget-under-by-one']) {
      expect(text(key)).not.toContain('…ほか');
      expect(text(key)).toContain('- b-12 ready');
      expect(text(key)).toContain(FOOT_TIMES_FULL);
    }
    expect(text('budget-over-by-one#1')).toContain(
      '…ほか 1 件は省略（プールは 12 件あり、order の昇順に 11 件だけ出した）。',
    );
    expect(text('budget-over-by-one#1')).toContain(`token_list cursor=${cur('b-11', 10)} で取れる`);
    expect(text('budget-over-by-one#1')).not.toContain('- b-12 ');
    expect(text('budget-over-by-one#2')).toContain('- b-12 ready');
    expect(text('budget-over-by-one#2')).not.toContain('- b-11 ');
    expect(text('budget-over-by-one#2')).not.toContain('…ほか');
    expect(text('budget-first-item-over#1')).toContain('文字省略。全 ');
    expect(text('budget-first-item-over#1')).toContain(
      '…ほか 2 件は省略（プールは 3 件あり、order の昇順に 1 件だけ出した）。',
    );
    expect(text('budget-first-item-over#1')).toContain(`cursor=${cur('big-1', 0)} で取れる`);
    expect(text('budget-first-item-over#2')).toContain('- small-1 ');
    expect(text('budget-first-item-over#2')).toContain('- small-2 ');
    expect(text('budget-single-6000')).not.toContain('文字省略');
    expect(text('budget-single-6000')).toContain('…ほか 1 件は省略（プールは 2 件あり');
    expect(text('budget-single-6001')).toContain('…（1 文字省略。全 6,001 文字）');
    expect(text('budget-pages#1')).toContain('…ほか ');
    expect(text('budget-pages#1')).toContain('プールは 30 件あり、order の昇順に ');
    expect(text('budget-pages#2')).toContain('- m-30 ready');
    expect(text('budget-pages#2')).not.toContain('…ほか');
    expect(text('budget-pages#2')).not.toContain('- m-01 ');
    expect(text('budget-pages#3')).toBe(LAST_PAGE);
    expect(text('budget-with-notes#1')).toContain('現役の指名: m-02（世代 3、');
    expect(text('budget-with-notes#1')).toContain('読めないトークンの行が 2 件ある');
    expect(text('budget-with-notes#2')).toContain('読めないトークンの行が 2 件ある');
    expect(text('budget-with-notes#2')).toContain(FOOT_TIMES_FULL);
    expect(text('budget-with-notes#3')).toBe(LAST_PAGE);
    // cursor
    expect(text('cursor-follow#1')).not.toContain('- t-ready ');
    expect(text('cursor-follow#1')).toContain('- t-cool-quota ');
    expect(text('cursor-follow#2')).not.toContain('- t-cool-notice ');
    expect(text('cursor-follow#2')).toContain('- t-cool-default ');
    expect(text('cursor-follow#2')).not.toContain('- t-cool-quota ');
    expect(text('cursor-follow#3')).toContain('- t-expired ');
    expect(text('cursor-follow#3')).not.toContain('- t-no-times ');
    expect(text('cursor-follow#4')).toBe(LAST_PAGE);
    expect(text('cursor-follow#5')).toBe(text('cursor-follow#2'));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(text(`cursor-malformed#${String(n)}`)).toContain(MALFORMED);
    }
    expect(text('cursor-malformed#14')).toContain('- t-cool-quota ');
    expect(text('cursor-malformed#14')).not.toContain('- t-ready ');
    expect(text('cursor-anchor-gone#1')).toContain('- g-c ');
    expect(text('cursor-anchor-gone#1')).not.toContain('- g-b ');
    expect(text('cursor-anchor-gone#2')).toContain('- g-b ');
    expect(text('cursor-anchor-gone#2')).toContain('- g-c ');
    expect(text('cursor-anchor-gone#2')).not.toContain('- g-a ');
    expect(text('cursor-anchor-gone#3')).toContain('- g-a ');
    expect(text('cursor-anchor-gone#4')).toContain('- g-d ');
    expect(text('cursor-anchor-gone#4')).not.toContain('- g-c ');
    expect(text('cursor-anchor-gone#5')).toBe(LAST_PAGE);
    expect(text('cursor-anchor-gone#6')).toContain('- g-c ');
    expect(text('cursor-anchor-gone#6')).toContain('- g-d ');
    expect(text('cursor-with-unreadable#1')).toContain('- f-b ');
    expect(text('cursor-with-unreadable#1')).toContain('読めないトークンの行が 1 件ある');
    expect(text('cursor-with-unreadable#2')).toBe(LAST_PAGE);
    expect(text('cursor-with-unreadable#3')).toContain(MALFORMED);
    expect(text('cursor-with-unreadable#3')).not.toContain('読めないトークンの行');
    expect(text('cursor-malformed-before-errors#1')).toContain(MALFORMED);
    expect(text('cursor-malformed-before-errors#2')).toBe(LAST_PAGE);
    expect(thrown('cursor-malformed-before-errors#3')).toBe(true);
    expect(reads('cursor-malformed-before-errors#1')).toEqual(READ_ALL);
  });
});
