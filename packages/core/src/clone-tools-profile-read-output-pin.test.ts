import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { profileEntryVersionOf } from './profile-service.js';
import type { EnvProfileScope, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `profile_read` の出力（全文と字数）と、呼んだあとの状態（プロファイルの行・日誌の行数が変わったか・書き込み口が呼ばれたか）・
// 呼びの並び（`stores.profile.list` の呼びとその結果の行数・投げたか）を、場面ごとにコミットした固定値
// （clone-tools-profile-read-output-pin.json）と丸ごと比べる。
// `clone-tools-profile.ts` の `tool('profile_read', …)`（offset の検査 → `profile.list()` → 行が0 → 一覧 → 無い名前 → 本文を `page` で切る → 版）を
// 小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・行）を固定して毎回同じにする。
// この道具は読むだけ。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。例外は素の message をそのまま固定する
//   - wrote: 呼ぶ前後でプロファイルの行・日誌の行数が変わったか（none / journal / profile）。場面ごとの宣言（全場面 none）と実際が合うことも確かめる
//   - writeCalls: 呼びの間にストアの書き込み口（profile の set / remove / replaceAll / clear・profile 以外のストアのどの口でも）が呼ばれた記録。全場面で空
//   - calls: 呼びの間の `stores.profile.list` の呼びと、その結果の行数（投げたら投げた文言）。offset を断った場面は list まで届かず空
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PROFILE_READ_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-profile-read-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-profile-read-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。行は基準の 2026-10-01 で積み（呼びの前に別の経路が行を変えるときは 1 分ずつ進める）、
// 呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 行は本物のメモリのストア（`createMemoryStores`）へ入れる。一覧が返る順（名前のコード単位順）はストアの側の仕事で、ここでは入れた順を変えて確かめる。
// 道具が読む本文の上限は PROFILE_PAGE（8,000 字。バイトではなく JS の文字数）、一覧の予算は PROFILE_LIST_BUDGET（6,000 字）で、
// どちらもこの試験の側に値を持つ（道具の定数を import しない）。一覧の予算の境目は、1行ぶんの字数を試験の側で組んで最後の行の名前の長さで合わせて作る。
//
// 秘密: 本文は作りものだけ（`export FOO=bar` ほか・コメント・日本語・絵文字）。この道具は本文を返す作りなので、出力に本文が出ること自体は固定値になる。
// 入力の本文のどの行も許す形（作りものの代入・コメント・飾り）に収まることと、json の全文に鍵らしい形（sk- / ghp_ / AKIA / 秘密鍵の見出し ほか）が無いことを確かめる。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み。none: 行も日誌も同じ / journal: 日誌だけ足された / profile: 行が変わった */
type Writes = 'none' | 'journal' | 'profile';

interface SeedRow {
  name: string;
  script: string;
  scope?: EnvProfileScope;
}

interface Step {
  /** 前の呼びの出力の全文（先頭の呼びは空）を受けて引数を作れる（続きの offset の取り出し用） */
  args: Args | ((previous: string) => Args);
  /** 道具が読むだけであることの宣言（全場面 none）。実際と合うことを確かめる */
  writes: Writes;
  /** この呼びの直前に、別の経路がストアを動かす（呼ぶ前の状態を作る。道具の書き込みではない） */
  before?: (base: Stores) => Promise<void>;
  /** `stores.profile.list` が投げる */
  listFails?: boolean;
}

interface Scenario {
  name: string;
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedRow[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const SEED_ISO = '2026-10-01T00:00:00.000Z';
const SEED_MS = Date.parse(SEED_ISO);
const PIN_URL = new URL('./clone-tools-profile-read-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PROFILE_READ_PIN === '1';

const PROFILE_PAGE = 8_000;
const PROFILE_LIST_BUDGET = 6_000;
const LIST_FAILS = 'プロファイルの一覧が読めない（テスト用）';

function callTime(index: number): number {
  return BASE_MS + index * 60_000;
}

/** 入力に使った本文（全部）。どの行も許す形に収まることを確かめる */
const ALL_SCRIPTS = new Set<string>();

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

/** ちょうど len 字のコメント行（`# ` ＋ 空白入りの飾り） */
function filler(len: number): string {
  return `# ${spaced(len - 2)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function row(name: string, script: string, scope: EnvProfileScope = 'all'): SeedRow {
  ALL_SCRIPTS.add(script);
  return { name, script, scope };
}

function stepOf(args: Args | ((previous: string) => Args), extra: Partial<Step> = {}): Step {
  return { args, writes: 'none', ...extra };
}

function r(args: Args, extra: Partial<Step> = {}): Step {
  return stepOf(args, extra);
}

/** 前の出力の「続きは profile_read name=… offset=N」から offset を取り出して、同じ name で続ける */
function follow(name: string): (previous: string) => Args {
  return (previous) => {
    const found = /profile_read name=\S+ offset=(\d+)/.exec(previous);
    if (found === null || found[1] === undefined) throw new Error('前の出力に offset の案内が無い');
    return { name, offset: Number(found[1]) };
  };
}

/** 一覧の1行ぶんの字数を、道具の実装と独立に組む（形そのものも固定する） */
function listLine(spec: {
  name: string;
  script: string;
  scope: string;
  updatedAt: string;
}): string {
  return `- ${spec.name} / 撒く先 ${spec.scope} / ${String(Buffer.byteLength(spec.script))} バイト / 更新 ${spec.updatedAt}`;
}

/** count 行の字数の合計がちょうど target になる並び（名前順で最後の行の名前の長さで合わせる） */
function calibrated(count: number, target: number): SeedRow[] {
  const script = 'export A=1';
  const rows = Array.from({ length: count }, (_, index) =>
    row(`cal-${pad2(index + 1)}-${'x'.repeat(33)}`, script),
  );
  const last = rows[count - 1];
  if (last === undefined) throw new Error('count が 0');
  const lineOf = (name: string): number =>
    listLine({ name, script, scope: 'all', updatedAt: SEED_ISO }).length;
  let others = 0;
  for (const spec of rows.slice(0, -1)) others += lineOf(spec.name);
  const prefix = `cal-${pad2(count)}-`;
  const nameLen = target - others - (lineOf(prefix) - prefix.length);
  if (nameLen < prefix.length + 1 || nameLen > 64) {
    throw new Error(`名前の長さが合わせられない: ${String(nameLen)}`);
  }
  last.name = `${prefix}${'x'.repeat(nameLen - prefix.length)}`;
  const total = others + lineOf(last.name);
  if (total !== target) throw new Error(`合計が目標と違う: ${String(total)} / ${String(target)}`);
  return rows;
}

function manyRows(count: number): SeedRow[] {
  return Array.from({ length: count }, (_, index) =>
    row(`many-${String(index + 1).padStart(3, '0')}`, `export V${String(index)}=1`, 'app'),
  );
}

function sha(script: string, scope: string): string {
  return createHash('sha256')
    .update(JSON.stringify([script, scope]), 'utf8')
    .digest('hex');
}

const ONE = [row('rust', 'export FOO=bar\n')];
const SURROGATE_AT_EDGE = `${filler(PROFILE_PAGE - 1)}😀`;
const PAIR_ENDS_AT_EDGE = `${filler(PROFILE_PAGE - 2)}😀z`;
const LONG_20000 = filler(20_000);

const SCENARIOS: Scenario[] = [
  // ---- offset の断り ----
  {
    name: 'offset-refused',
    group: 'offset の断り',
    covers:
      'offset が整数でない・負（describeIntRangeViolation が断る）: -1・-0.5・0.5・NaN・Infinity・-Infinity・桁の大きい負。「offset X は使えない（0以上の整数のみ）。」で list まで届かない（calls が空）。name の有無・名前が無い行でも同じ',
    seed: ONE,
    steps: [
      r({ name: 'rust', offset: -1 }),
      r({ name: 'rust', offset: -0.5 }),
      r({ name: 'rust', offset: 0.5 }),
      r({ name: 'rust', offset: Number.NaN }),
      r({ name: 'rust', offset: Number.POSITIVE_INFINITY }),
      r({ name: 'rust', offset: Number.NEGATIVE_INFINITY }),
      r({ name: 'rust', offset: -1e21 }),
      r({ offset: -1 }),
      r({ name: 'nope', offset: 1.5 }),
    ],
  },
  {
    name: 'offset-refused-empty',
    group: 'offset の断り',
    covers:
      'プロファイルが空でも offset の断りが先（「置かれていない」とは言わない）。list は呼ばれない',
    seed: [],
    steps: [r({ offset: -1 }), r({ name: 'rust', offset: Number.NaN })],
  },
  {
    name: 'offset-accepted-edge',
    group: 'offset の断り',
    covers:
      '断られない境目: -0・0・省略・undefined は先頭から。offset が全体の長さ以上の巨大な整数（1e21 は整数）は断られず「末尾を越えている」。name を省略したときの offset は一覧では使われない（効かない）',
    seed: ONE,
    steps: [
      r({ name: 'rust' }),
      r({ name: 'rust', offset: undefined }),
      r({ name: 'rust', offset: 0 }),
      r({ name: 'rust', offset: -0 }),
      r({ name: 'rust', offset: 1e21 }),
      r({ offset: 5 }),
    ],
  },

  // ---- 行が0 ----
  {
    name: 'empty-profile',
    group: '行が0',
    covers:
      'プロファイルに行が1つも無い: name の有無・offset に関わらず「置かれていない」（無い名前の言い方より先）。list は1回',
    seed: [],
    steps: [r({}), r({ name: 'rust' }), r({ name: 'rust', offset: 5 }), r({ name: '' })],
  },

  // ---- 一覧 ----
  {
    name: 'list-one',
    group: '一覧',
    covers:
      '1行: 「- 名前 / 撒く先 … / N バイト / 更新 …」の1行と、後書き（本文は載せていない・つなげる順番・更新時刻の注）。予算内なので「ほか」は出ない',
    seed: ONE,
    steps: [r({})],
  },
  {
    name: 'list-scopes',
    group: '一覧',
    covers: '撒く先の各値（all / app / runner）が行に出る。本文は載らない',
    seed: [
      row('everywhere', 'export A=1', 'all'),
      row('only-app', 'export B=2', 'app'),
      row('only-runner', 'export C=3', 'runner'),
    ],
    steps: [r({})],
  },
  {
    name: 'list-order',
    group: '一覧',
    covers:
      '複数行の並びは名前のコード単位順（入れた順ではない）: 数字 < 大文字 < - . … ではなく ASCII 順（- . 数字 大文字 _ 小文字）。大文字小文字が違う名前は別の行として並ぶ。入れた順を変えて固定する',
    seed: [
      row('zeta', 'export Z=1', 'runner'),
      row('alpha', 'export A=1', 'all'),
      row('b2', 'export B=2', 'app'),
      row('Alpha', 'export A=2', 'app'),
      row('a_b', 'export U=1', 'all'),
      row('B1', 'export B=1', 'runner'),
      row('a.b', 'export D=1', 'all'),
      row('a-b', 'export H=1', 'app'),
      row('10', 'export N=1', 'all'),
    ],
    steps: [r({})],
  },
  {
    name: 'list-bytes',
    group: '一覧',
    covers:
      '本文のバイト数（UTF-8）が文字数と別: ASCII 3 字は 3、「あ」は 3、「é」は 2、絵文字（サロゲートペア 2 字）は 4、空の本文は 0、改行も数える。一覧に載るのはバイト数だけ',
    seed: [
      row('b-ascii', 'abc'),
      row('b-hira', 'あ'),
      row('b-eacute', 'é'),
      row('b-emoji', '😀'),
      row('b-empty', ''),
      row('b-newline', 'export A=1\n\n'),
      row('b-mixed', 'export G=こんにちは😀\n'),
    ],
    steps: [r({})],
  },
  {
    name: 'list-budget-exact',
    group: '一覧（予算）',
    covers:
      '66 行の字数の合計がちょうど 6,000 字: 全部出る（「ほか」なし）。比較は「予算を超えたら切る」',
    seed: calibrated(66, PROFILE_LIST_BUDGET),
    steps: [r({})],
  },
  {
    name: 'list-budget-under',
    group: '一覧（予算）',
    covers: '66 行の合計が 5,999 字: 全部出る',
    seed: calibrated(66, PROFILE_LIST_BUDGET - 1),
    steps: [r({})],
  },
  {
    name: 'list-budget-over',
    group: '一覧（予算）',
    covers:
      '66 行の合計が 6,001 字: 最後の1行だけ落ちる（「…ほか 1 件は省略（全 66 件のうち 65 件だけ出した。名前が分かっていれば profile_read name=<名前> で取れる）。」）。後書きは省略の行の後ろに付く',
    seed: calibrated(66, PROFILE_LIST_BUDGET + 1),
    steps: [r({})],
  },
  {
    name: 'list-budget-many',
    group: '一覧（予算）',
    covers:
      '120 行（1行あたりの字数はほぼ同じ）: 予算で切れて、出した件数と「ほか N 件」の合計が全件数に合う。省略された名前は一覧に出ない（name を渡せば本文は取れる）',
    seed: manyRows(120),
    steps: [r({}), r({ name: 'many-120' })],
  },
  {
    name: 'list-budget-first-over',
    group: '一覧（予算）',
    covers:
      '先頭の1行だけで予算を超える（名前が 7,000 字。正本の検査は通らないがメモリのストアは通す作りもの）: その1行を抜粋して出し（…（n 文字省略。全 m 文字））、後ろの1行は省略。道具の側の分岐を縛るための入力',
    seed: [row(spaced(7_000, 'huge'), 'export A=1'), row('z-small', 'export B=2')],
    steps: [r({})],
  },

  // ---- 無い名前 ----
  {
    name: 'name-missing',
    group: '無い名前',
    covers:
      '行が在るが name の行が無い: 「プロファイルに行 X は無い。行の一覧は profile_read（name を省略）で取れる。」。大文字小文字違い・前後の空白・空文字・一部だけ一致する名前も無い扱い。別の行の本文は出ない',
    seed: [row('alpha', 'export A=1'), row('beta', 'export B=2')],
    steps: [
      r({ name: 'nope' }),
      r({ name: 'Alpha' }),
      r({ name: ' alpha' }),
      r({ name: 'alpha ' }),
      r({ name: 'alph' }),
      r({ name: '' }),
      r({ name: 'nope', offset: 10 }),
    ],
  },

  // ---- 本文 ----
  {
    name: 'body-short',
    group: '本文',
    covers:
      '短い本文（1 頁に収まる）: 見出し（行 / 撒く先 / 最終更新 / 全 N 文字）→ 本文 → 版の行。続きの案内も profile_write の注意も出ない。撒く先 all / app / runner・末尾の改行の有無・複数行・日本語・絵文字・空の本文',
    seed: [
      row('s-all', 'export FOO=bar\n', 'all'),
      row('s-app', 'export FOO=bar', 'app'),
      row('s-runner', 'export A=1\nexport B=2\n', 'runner'),
      row('s-ja', 'export GREETING=こんにちは\n', 'all'),
      row('s-emoji', 'export E=😀\n', 'app'),
      row('s-empty', '', 'all'),
      row('s-comment', '# コメントだけ', 'all'),
    ],
    steps: [
      r({ name: 's-all' }),
      r({ name: 's-app' }),
      r({ name: 's-runner' }),
      r({ name: 's-ja' }),
      r({ name: 's-emoji' }),
      r({ name: 's-empty' }),
      r({ name: 's-comment' }),
    ],
  },
  {
    name: 'body-only-named-row',
    group: '本文',
    covers:
      'name を渡すと、その行の本文だけが出る（ほかの行の本文・名前は出ない）。list は行ぶん全部読む（1回）',
    seed: [row('first', 'export F=1'), row('second', 'export S=2'), row('third', 'export T=3')],
    steps: [r({ name: 'second' })],
  },
  {
    name: 'body-boundary',
    group: '本文',
    covers:
      'PROFILE_PAGE（8,000 字）の境目: 7,999 字・8,000 字ちょうどは全部出る（「全 N 文字」・続きなし）。8,001 字は 8,000 字で切れて、続きの案内（offset=8000）と profile_write の注意が付く。16,000 字ちょうどの offset=8000 は最後まで出る（続きなし）。16,001 字の offset=8000 はまた切れる',
    seed: [
      row('p-7999', filler(7_999)),
      row('p-8000', filler(8_000)),
      row('p-8001', filler(8_001)),
      row('p-16000', filler(16_000)),
      row('p-16001', filler(16_001)),
    ],
    steps: [
      r({ name: 'p-7999' }),
      r({ name: 'p-8000' }),
      r({ name: 'p-8001' }),
      r({ name: 'p-16000', offset: 8_000 }),
      r({ name: 'p-16001', offset: 8_000 }),
    ],
  },
  {
    name: 'body-long-continue',
    group: '本文',
    covers:
      '20,000 字を案内どおりに続けて読む: 1 頁目（1〜8,000 文字目・続きあり）→ 案内の offset で2頁目（8,001〜16,000・続きあり）→ 3 頁目（16,001〜20,000・最後。続きなし）。版は頁が進んでも同じ。「全 N 文字」ではなく範囲で言う',
    seed: [row('long', LONG_20000)],
    steps: [r({ name: 'long' }), stepOf(follow('long')), stepOf(follow('long'))],
  },
  {
    name: 'body-offset',
    group: '本文',
    covers:
      'offset を渡す: 途中から（範囲の言い方「2〜100 文字目 / 全 100 文字」）・最後の1字・全体の長さちょうど・全体の長さより後ろ・巨大な値（1e21 は整数）。長さ以上は本文が空で「全 N 文字の末尾を越えている（offset が全体の長さ以上）。この位置に本文は無い」。続きの案内は出ない',
    seed: [row('o-100', filler(100)), row('o-20000', LONG_20000)],
    steps: [
      r({ name: 'o-100', offset: 1 }),
      r({ name: 'o-100', offset: 99 }),
      r({ name: 'o-100', offset: 100 }),
      r({ name: 'o-100', offset: 101 }),
      r({ name: 'o-100', offset: 1e21 }),
      r({ name: 'o-20000', offset: 12_345 }),
      r({ name: 'o-20000', offset: 19_999 }),
      r({ name: 'o-20000', offset: 20_000 }),
    ],
  },
  {
    name: 'body-multibyte',
    group: '本文（多バイト文字）',
    covers:
      '切り口が多バイト文字・サロゲートペアに来る: 「あ」8,000 字は全部（バイトではなく文字数で数える）・8,001 字は 8,000 字で切れる・「あ」3,000 字（9,000 バイト）は切れない。7,999 字＋絵文字（境目の 8,000 字目にペアの後半が掛かる）は高サロゲートを残さず 7,999 字で切る（続きの offset=7999 から絵文字が丸ごと出る）。7,998 字＋絵文字＋z はペアが 8,000 字目で終わるのでペアごと 8,000 字で切る（続きは z だけ）',
    seed: [
      row('m-ja-8000', 'あ'.repeat(PROFILE_PAGE)),
      row('m-ja-8001', 'あ'.repeat(PROFILE_PAGE + 1)),
      row('m-ja-3000', 'あ'.repeat(3_000)),
      row('m-pair-edge', SURROGATE_AT_EDGE),
      row('m-pair-ends', PAIR_ENDS_AT_EDGE),
    ],
    steps: [
      r({ name: 'm-ja-8000' }),
      r({ name: 'm-ja-8001' }),
      r({ name: 'm-ja-3000' }),
      r({ name: 'm-pair-edge' }),
      stepOf(follow('m-pair-edge')),
      r({ name: 'm-pair-ends' }),
    ],
  },
  {
    name: 'body-offset-in-pair',
    group: '本文（多バイト文字）',
    covers:
      'offset がサロゲートペアの真ん中（後半の位置）に当たる: 開始は寄せず、後半の単独のサロゲートから出る（固定値の側では \\udXXX の形）。これは道具のいまの振る舞いで、固定する。ペアの手前・後ろの offset も並べる',
    seed: [row('pair', '😀😀'), row('pair-edge', SURROGATE_AT_EDGE)],
    steps: [
      r({ name: 'pair', offset: 0 }),
      r({ name: 'pair', offset: 1 }),
      r({ name: 'pair', offset: 2 }),
      r({ name: 'pair', offset: 3 }),
      r({ name: 'pair', offset: 4 }),
      r({ name: 'pair-edge', offset: PROFILE_PAGE }),
    ],
  },

  // ---- 版 ----
  {
    name: 'version-vary',
    group: '版（base_version）',
    covers:
      '版は本文と撒く先で決まる（sha256(JSON.stringify([本文, 撒く先])) と一致）。同じ本文で撒く先 all / app / runner・本文だけ変えた行は、どれも版が違う。行の名前・更新時刻は版に入らない（別名の同じ本文・同じ撒く先の行、同じ内容を書き直した行は、同じ版）',
    seed: [row('v', 'export FOO=bar\n', 'all')],
    steps: [
      r({ name: 'v' }),
      r(
        { name: 'v' },
        {
          before: async (base) => {
            await base.profile.set('v', 'export FOO=bar\n', 'app');
          },
        },
      ),
      r(
        { name: 'v' },
        {
          before: async (base) => {
            await base.profile.set('v', 'export FOO=bar\n', 'runner');
          },
        },
      ),
      r(
        { name: 'v' },
        {
          before: async (base) => {
            await base.profile.set('v', 'export FOO=baz\n', 'runner');
          },
        },
      ),
      r(
        { name: 'w' },
        {
          before: async (base) => {
            await base.profile.set('w', 'export FOO=baz\n', 'runner');
          },
        },
      ),
      r(
        { name: 'v' },
        {
          before: async (base) => {
            await base.profile.set('v', 'export FOO=baz\n', 'runner');
          },
        },
      ),
    ],
  },
  {
    name: 'version-whole-body',
    group: '版（base_version）',
    covers:
      '版は切れた頁ではなく本文の全体で決まる: 長い本文の 1 頁目（切れる）と offset を進めた頁の版が同じ。末尾 1 字だけ違う本文は 1 頁目の見た目が同じでも版が違う',
    seed: [row('w-a', `${filler(PROFILE_PAGE + 10)}`), row('w-b', `${filler(PROFILE_PAGE + 9)}x`)],
    steps: [r({ name: 'w-a' }), r({ name: 'w-a', offset: 8_000 }), r({ name: 'w-b' })],
  },

  // ---- list が投げる ----
  {
    name: 'list-throws',
    group: 'list が投げる',
    covers:
      '`stores.profile.list()` が投げたら、道具は握らず例外のまま出る（THREW。名前と message）: 一覧でも本文でも同じ。offset を断った呼びは list まで届かず断りの文を返す（例外にならない）',
    seed: ONE,
    steps: [
      r({}, { listFails: true }),
      r({ name: 'rust' }, { listFails: true }),
      r({ name: 'rust', offset: 3 }, { listFails: true }),
      r({ name: 'rust', offset: -1 }, { listFails: true }),
      r({ name: 'rust' }),
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
  /** list が返した行の数 */
  rows?: number;
  /** list が投げた文言 */
  threw?: string;
}

interface PinnedStep {
  output: PinnedOutput;
  /** 呼ぶ前から変わったもの（読むだけの道具なので全場面で none） */
  wrote: Writes;
  /** 呼びの間に呼ばれたストアの書き込み口（全場面で空） */
  writeCalls: string[];
  /** 呼びの間の `stores.profile.list` の呼びと結果 */
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

async function snapshot(base: Stores): Promise<{ rows: unknown; journalCount: number }> {
  return {
    rows: plain(await base.profile.list()),
    journalCount: (await base.journal.list({ order: 'asc' })).length,
  };
}

function withHooks(base: Stores, failsNow: () => boolean, recorded: Recorded): Stores {
  const profile: Stores['profile'] = {
    list: async () => {
      if (failsNow()) {
        recorded.calls.push({ op: 'profile.list', threw: LIST_FAILS });
        throw new Error(LIST_FAILS);
      }
      const rows = await base.profile.list();
      recorded.calls.push({ op: 'profile.list', rows: rows.length });
      return rows;
    },
    set: (...args) => {
      recorded.writes.push('profile.set');
      return base.profile.set(...args);
    },
    remove: (...args) => {
      recorded.writes.push('profile.remove');
      return base.profile.remove(...args);
    },
    replaceAll: (...args) => {
      recorded.writes.push('profile.replaceAll');
      return base.profile.replaceAll(...args);
    },
    clear: (...args) => {
      recorded.writes.push('profile.clear');
      return base.profile.clear(...args);
    },
  };
  const out: Record<string, unknown> = { ...base, profile };
  for (const [group, value] of Object.entries(base)) {
    if (group === 'profile' || typeof value !== 'object' || value === null) continue;
    // profile 以外のストアは、どの口が呼ばれても記録する（この道具は触らないはず）
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

function classify(
  before: { rows: unknown; journalCount: number },
  after: { rows: unknown; journalCount: number },
): Writes {
  if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) return 'profile';
  if (before.journalCount !== after.journalCount) return 'journal';
  return 'none';
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(SEED_MS));
  for (const spec of scenario.seed) await base.profile.set(spec.name, spec.script, spec.scope);
  let failsNow = false;
  const recorded: Recorded = { calls: [], writes: [] };
  const tools = createCloneTools({
    stores: withHooks(base, () => failsNow, recorded),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
  });
  const found = tools.find((entry) => entry.name === 'profile_read');
  if (!found) throw new Error('profile_read が無い');

  const results: PinnedStep[] = [];
  let previous = '';
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) {
      vi.setSystemTime(new Date(SEED_MS + (index + 1) * 60_000));
      await step.before(base);
    }
    vi.setSystemTime(new Date(callTime(index)));
    failsNow = step.listFails === true;
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
    failsNow = false;
    const calls = recorded.calls.map((entry) => ({ ...entry }));
    const writes = [...recorded.writes];
    const wrote = classify(before, await snapshot(base));
    results.push({ output, wrote, writeCalls: writes, calls });
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

describe('profile_read の出力の固定（場面ごとの全文と字数・読むだけで書かないこと）', () => {
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

  it('読むだけの道具: 書き込みの有無が宣言（none）・固定値と同じで、書き込み口も呼ばれていない', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(step.writes, `${key}: 宣言が none でない`).toBe('none');
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
        expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が宣言と違う`).toBe(
          step.writes,
        );
        expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
        expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
      }
    }
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

      it(`${key} の stores.profile.list の呼びと結果の行数が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls,
          `場面 ${key} の stores.profile.list の呼びの並び・結果が変わった`,
        ).toEqual(want?.calls);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（入力の本文のどの行も許す形に収まり、json の全文に鍵らしい形が無い）', () => {
    expect(ALL_SCRIPTS.size, '本文が1つも作られていない（確かめが空振り）').toBeGreaterThan(30);
    const allowed = /^(export [A-Z][A-Z0-9_]*=[a-z0-9]+|# .*|[あ😀éz]*|abc)$/u;
    const loose = /^export GREETING=こんにちは$|^export G=こんにちは😀$|^export E=😀$/u;
    for (const script of ALL_SCRIPTS) {
      if (script.length > 200) {
        expect(script, '長い本文は飾りのコメントか「あ」だけ').toMatch(/^# |^あ+$|😀/u);
        continue;
      }
      for (const line of script.split('\n')) {
        expect(allowed.test(line) || loose.test(line), `作りもの以外の行: ${line}`).toBe(true);
      }
    }
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|github_pat_|AKIA|xox[abp]-|BEGIN [A-Z ]*PRIVATE KEY/);
    expect(pinnedRaw).not.toMatch(/Bearer /);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const versionOf = (key: string): string | undefined =>
      /base_version=([0-9a-f]{64})/.exec(text(key))?.[1];
    const listCalls = (key: string): PinnedCall[] => step(key).calls;
    const OFFSET_REFUSED = (value: string): string =>
      `offset ${value} は使えない（0以上の整数のみ）。`;
    const EMPTY = '実行環境プロファイルは置かれていない。';
    const LIST_FOOT_1 =
      '（本文は載せていない。取るには profile_read name=<名前>。つなげる順番は名前のコード単位順。';
    const LIST_FOOT_2 = '更新時刻は「最後に本文か撒く先を変えた時刻」で、作成時刻は持っていない）';
    const CUT = '…（ここで切れている。続きは profile_read name=';
    const WRITE_WARN =
      '**profile_write は行の全文置換なので、書き戻すつもりなら先に offset を進めて最後まで取ること** — ここまでの分だけを渡すと残りが消える）';
    const VERSION_TAIL =
      '——この行を書き直す profile_write と、外す profile_remove に渡せば、読んだ後に人間や別のターンが変えていたとき何も変えずに断られる）';

    // offset の断り: list へ届かない
    const refused: [string, string][] = [
      ['offset-refused#1', '-1'],
      ['offset-refused#2', '-0.5'],
      ['offset-refused#3', '0.5'],
      ['offset-refused#4', 'NaN'],
      ['offset-refused#5', 'Infinity'],
      ['offset-refused#6', '-Infinity'],
      ['offset-refused#8', '-1'],
      ['offset-refused#9', '1.5'],
    ];
    for (const [key, shown] of refused) {
      expect(text(key), key).toBe(OFFSET_REFUSED(shown));
      expect(listCalls(key), `${key}: list まで届いた`).toEqual([]);
      expect(step(key).output.isError, key).toBe(false);
    }
    expect(text('offset-refused#7')).toContain('は使えない（0以上の整数のみ）。');
    expect(listCalls('offset-refused#7')).toEqual([]);
    expect(text('offset-refused-empty#1')).toBe(OFFSET_REFUSED('-1'));
    expect(text('offset-refused-empty#2')).toBe(OFFSET_REFUSED('NaN'));
    expect(listCalls('offset-refused-empty#1')).toEqual([]);
    for (const key of [
      'offset-accepted-edge#1',
      'offset-accepted-edge#2',
      'offset-accepted-edge#3',
      'offset-accepted-edge#4',
    ]) {
      expect(text(key), key).toContain('全 15 文字）\nexport FOO=bar\n\n（版 base_version=');
      expect(listCalls(key), key).toEqual([{ op: 'profile.list', rows: 1 }]);
    }
    expect(text('offset-accepted-edge#5')).toContain(
      '全 15 文字の末尾を越えている（offset が全体の長さ以上）。この位置に本文は無い',
    );
    expect(text('offset-accepted-edge#6')).toContain('- rust / 撒く先 all / 15 バイト / 更新 ');

    // 行が0
    for (const key of [
      'empty-profile#1',
      'empty-profile#2',
      'empty-profile#3',
      'empty-profile#4',
    ]) {
      expect(text(key), key).toBe(EMPTY);
      expect(listCalls(key), key).toEqual([{ op: 'profile.list', rows: 0 }]);
    }

    // 一覧
    expect(text('list-one')).toBe(
      `- rust / 撒く先 all / 15 バイト / 更新 ${SEED_ISO}\n${LIST_FOOT_1}\n${LIST_FOOT_2}`,
    );
    expect(text('list-scopes')).toContain('/ 撒く先 all /');
    expect(text('list-scopes')).toContain('/ 撒く先 app /');
    expect(text('list-scopes')).toContain('/ 撒く先 runner /');
    expect(text('list-scopes')).not.toContain('export');
    const orderNames = text('list-order')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).split(' / ')[0]);
    expect(orderNames).toEqual(['10', 'Alpha', 'B1', 'a-b', 'a.b', 'a_b', 'alpha', 'b2', 'zeta']);
    for (const [name, bytes] of [
      ['b-ascii', 3],
      ['b-hira', 3],
      ['b-eacute', 2],
      ['b-emoji', 4],
      ['b-empty', 0],
      ['b-newline', 12],
      ['b-mixed', 29],
    ] as const) {
      expect(text('list-bytes'), name).toContain(
        `- ${name} / 撒く先 all / ${String(bytes)} バイト / `,
      );
    }
    // 9（export G=）＋ 15（こんにちは）＋ 4（絵文字）＋ 1（改行）
    expect(Buffer.byteLength('export G=こんにちは😀\n')).toBe(29);
    const budgetLines = (key: string): string[] =>
      text(key)
        .split('\n')
        .filter((line) => line.startsWith('- cal-'));
    const sumLen = (lines: string[]): number => lines.reduce((acc, line) => acc + line.length, 0);
    expect(budgetLines('list-budget-exact')).toHaveLength(66);
    expect(sumLen(budgetLines('list-budget-exact'))).toBe(PROFILE_LIST_BUDGET);
    expect(text('list-budget-exact')).not.toContain('件は省略');
    expect(budgetLines('list-budget-under')).toHaveLength(66);
    expect(sumLen(budgetLines('list-budget-under'))).toBe(PROFILE_LIST_BUDGET - 1);
    expect(text('list-budget-under')).not.toContain('件は省略');
    expect(budgetLines('list-budget-over')).toHaveLength(65);
    expect(text('list-budget-over')).toContain(
      '…ほか 1 件は省略（全 66 件のうち 65 件だけ出した。名前が分かっていれば profile_read name=<名前> で取れる）。\n' +
        LIST_FOOT_1,
    );
    expect(text('list-budget-over')).not.toContain('cal-66-');
    const manyShown = text('list-budget-many#1')
      .split('\n')
      .filter((line) => line.startsWith('- many-')).length;
    expect(manyShown).toBeGreaterThan(30);
    expect(manyShown).toBeLessThan(120);
    expect(text('list-budget-many#1')).toContain(
      `…ほか ${String(120 - manyShown)} 件は省略（全 120 件のうち ${String(manyShown)} 件だけ出した。`,
    );
    expect(text('list-budget-many#2')).toContain('export V119=1');
    expect(text('list-budget-first-over')).toContain('文字省略。全 ');
    expect(text('list-budget-first-over')).toContain(
      '…ほか 1 件は省略（全 2 件のうち 1 件だけ出した。',
    );

    // 無い名前
    for (const [index, shown] of [
      [1, 'nope'],
      [2, 'Alpha'],
      [3, ' alpha'],
      [4, 'alpha '],
      [5, 'alph'],
      [6, ''],
      [7, 'nope'],
    ] as const) {
      const key = `name-missing#${String(index)}`;
      expect(text(key), key).toBe(
        `プロファイルに行 ${shown} は無い。行の一覧は profile_read（name を省略）で取れる。`,
      );
      expect(listCalls(key), key).toEqual([{ op: 'profile.list', rows: 2 }]);
    }

    // 本文: 短い
    expect(text('body-short#1')).toBe(
      `（行 s-all / 撒く先 all / 最終更新 ${SEED_ISO} / 全 15 文字）\nexport FOO=bar\n\n（版 base_version=${sha('export FOO=bar\n', 'all')} ${VERSION_TAIL}`,
    );
    expect(text('body-short#2')).toContain('/ 撒く先 app /');
    expect(text('body-short#3')).toContain('/ 撒く先 runner /');
    expect(text('body-short#6')).toContain('全 0 文字）\n\n（版 base_version=');
    for (let i = 1; i <= 7; i += 1) {
      expect(text(`body-short#${String(i)}`)).not.toContain(CUT);
      expect(text(`body-short#${String(i)}`)).not.toContain('profile_write は行の全文置換');
    }
    expect(text('body-only-named-row')).toContain('export S=2');
    expect(text('body-only-named-row')).not.toContain('export F=1');
    expect(text('body-only-named-row')).not.toContain('export T=3');
    expect(listCalls('body-only-named-row')).toEqual([{ op: 'profile.list', rows: 3 }]);

    // 本文: 境目
    expect(text('body-boundary#1')).toContain('全 7,999 文字）');
    expect(text('body-boundary#2')).toContain('全 8,000 文字）');
    expect(text('body-boundary#1')).not.toContain(CUT);
    expect(text('body-boundary#2')).not.toContain(CUT);
    expect(text('body-boundary#3')).toContain('1〜8,000 文字目 / 全 8,001 文字）');
    expect(text('body-boundary#3')).toContain(`${CUT}p-8001 offset=8000。${WRITE_WARN}`);
    expect(text('body-boundary#4')).toContain('8,001〜16,000 文字目 / 全 16,000 文字）');
    expect(text('body-boundary#4')).not.toContain(CUT);
    expect(text('body-boundary#5')).toContain('8,001〜16,000 文字目 / 全 16,001 文字）');
    expect(text('body-boundary#5')).toContain(`${CUT}p-16001 offset=16000。`);
    // 本文の長さ: 見出し行 + 本文 8,000 字
    expect(text('body-boundary#2').split('\n')[1]?.length).toBe(PROFILE_PAGE);
    expect(text('body-boundary#3').split('\n')[1]?.length).toBe(PROFILE_PAGE);

    // 本文: 続き
    expect(text('body-long-continue#1')).toContain('1〜8,000 文字目 / 全 20,000 文字）');
    expect(text('body-long-continue#1')).toContain(`${CUT}long offset=8000。`);
    expect(text('body-long-continue#2')).toContain('8,001〜16,000 文字目 / 全 20,000 文字）');
    expect(text('body-long-continue#2')).toContain(`${CUT}long offset=16000。`);
    expect(text('body-long-continue#3')).toContain('16,001〜20,000 文字目 / 全 20,000 文字）');
    expect(text('body-long-continue#3')).not.toContain(CUT);
    expect(versionOf('body-long-continue#1')).toBe(sha(LONG_20000, 'all'));
    expect(versionOf('body-long-continue#2')).toBe(versionOf('body-long-continue#1'));
    expect(versionOf('body-long-continue#3')).toBe(versionOf('body-long-continue#1'));

    // 本文: offset
    expect(text('body-offset#1')).toContain('2〜100 文字目 / 全 100 文字）');
    expect(text('body-offset#2')).toContain('100〜100 文字目 / 全 100 文字）');
    for (const key of ['body-offset#3', 'body-offset#4', 'body-offset#5']) {
      expect(text(key), key).toContain(
        '全 100 文字の末尾を越えている（offset が全体の長さ以上）。この位置に本文は無い',
      );
    }
    expect(text('body-offset#6')).toContain('12,346〜20,000 文字目 / 全 20,000 文字）');
    expect(text('body-offset#7')).toContain('20,000〜20,000 文字目 / 全 20,000 文字）');
    expect(text('body-offset#8')).toContain('末尾を越えている');

    // 本文: 多バイト
    expect(text('body-multibyte#1')).toContain('全 8,000 文字）');
    expect(text('body-multibyte#2')).toContain('1〜8,000 文字目 / 全 8,001 文字）');
    expect(text('body-multibyte#2')).toContain(`${CUT}m-ja-8001 offset=8000。`);
    expect(text('body-multibyte#3')).toContain('全 3,000 文字）');
    expect(text('body-multibyte#3')).not.toContain(CUT);
    expect(text('body-multibyte#4')).toContain('1〜7,999 文字目 / 全 8,001 文字）');
    expect(text('body-multibyte#4')).toContain(`${CUT}m-pair-edge offset=7999。`);
    expect(text('body-multibyte#4')).not.toContain('😀');
    expect(text('body-multibyte#5')).toContain('8,000〜8,001 文字目 / 全 8,001 文字）\n😀\n');
    expect(text('body-multibyte#6')).toContain('1〜8,000 文字目 / 全 8,001 文字）');
    expect(text('body-multibyte#6')).toContain('😀\n…（ここで切れている。続きは');
    expect(text('body-multibyte#6')).toContain(`${CUT}m-pair-ends offset=8000。`);
    expect(text('body-offset-in-pair#1')).toContain('全 4 文字）\n😀😀\n');
    // 後半の単独のサロゲート（U+DE00）から出る: 本文の行は「後半 ＋ 絵文字」の 3 字
    const lone = text('body-offset-in-pair#2').split('\n')[1] ?? '';
    expect(lone.length).toBe(3);
    expect(lone.charCodeAt(0)).toBe(0xde00);
    expect(lone.slice(1)).toBe('😀');
    expect(text('body-offset-in-pair#2')).toContain('2〜4 文字目 / 全 4 文字）\n');
    expect((text('body-offset-in-pair#4').split('\n')[1] ?? '').charCodeAt(0)).toBe(0xde00);
    expect(text('body-offset-in-pair#3')).toContain('3〜4 文字目 / 全 4 文字）\n😀\n');
    expect(text('body-offset-in-pair#4')).toContain('4〜4 文字目 / 全 4 文字）\n');
    expect(text('body-offset-in-pair#5')).toContain('末尾を越えている');

    // 版
    const versions = [1, 2, 3, 4, 5, 6].map((i) => versionOf(`version-vary#${String(i)}`));
    expect(versions[0]).toBe(sha('export FOO=bar\n', 'all'));
    expect(versions[1]).toBe(sha('export FOO=bar\n', 'app'));
    expect(versions[2]).toBe(sha('export FOO=bar\n', 'runner'));
    expect(versions[3]).toBe(sha('export FOO=baz\n', 'runner'));
    expect(new Set(versions.slice(0, 4)).size).toBe(4);
    expect(versions[4]).toBe(versions[3]);
    expect(versions[5]).toBe(versions[3]);
    expect(versions[0]).toBe(profileEntryVersionOf({ script: 'export FOO=bar\n', scope: 'all' }));
    expect(text('version-vary#6')).toContain(
      `最終更新 ${new Date(SEED_MS + 6 * 60_000).toISOString()} /`,
    );
    expect(text('version-vary#4')).toContain(
      `最終更新 ${new Date(SEED_MS + 4 * 60_000).toISOString()} /`,
    );
    expect(count(text('version-vary#1'), '版 base_version=')).toBe(1);
    expect(text('version-vary#1').endsWith(`${VERSION_TAIL}`)).toBe(true);
    expect(versionOf('version-whole-body#1')).toBe(versionOf('version-whole-body#2'));
    expect(versionOf('version-whole-body#3')).not.toBe(versionOf('version-whole-body#1'));
    expect(text('version-whole-body#1')).toContain(CUT);
    expect(text('version-whole-body#3')).toContain(CUT);

    // list が投げる
    for (const key of ['list-throws#1', 'list-throws#2', 'list-throws#3']) {
      expect(step(key).output.thrown, key).toBe(true);
      expect(step(key).output.errorName, key).toBe('Error');
      expect(text(key), key).toBe(LIST_FAILS);
      expect(listCalls(key), key).toEqual([{ op: 'profile.list', threw: LIST_FAILS }]);
    }
    expect(step('list-throws#4').output.thrown).toBe(false);
    expect(text('list-throws#4')).toBe(OFFSET_REFUSED('-1'));
    expect(listCalls('list-throws#4')).toEqual([]);
    expect(step('list-throws#5').output.thrown).toBe(false);
    expect(listCalls('list-throws#5')).toEqual([{ op: 'profile.list', rows: 1 }]);
  });
});
