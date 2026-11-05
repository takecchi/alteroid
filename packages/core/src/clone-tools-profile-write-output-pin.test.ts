import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import {
  createProfileService,
  profileEntryVersionOf,
  ProfileInputError,
  type ApplyProfileResult,
  type ProfileService,
} from './profile-service.js';
import type { ProfileApplier } from './profile.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { EnvProfileEntry, EnvProfileScope, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `profile_write` の出力（全文と字数）と、呼んだあとの状態（プロファイルの行・日誌へ足された行）・呼びの並び
// （`journal.append`・`context.profile.set` に渡した name / script / scope / ifMatch・その下で走る正本の保存・クローンの器・runner への配布）を、
// 場面ごとにコミットした固定値（clone-tools-profile-write-output-pin.json）と丸ごと比べる。
// `clone-tools-profile.ts` の `tool('profile_write', …)`（約 46 行のハンドラ。断り → 日誌が先 → `set` → 投げたら `profileToolFailed`・返したら `profileToolReport`）を
// 小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・行・runner・器の結果）を固定して毎回同じにする。
// この道具は実行環境プロファイル（鍵が入りうる）の正本を書き換えるので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。道具が投げ直した例外は、素の message をそのまま固定する
//   - wrote: 呼ぶ前から変わったもの。none（日誌も行も同じ）/ journal（日誌だけ）/ profile（行が変わった。日誌も足される）。場面ごとの宣言と実際が合うことも確かめる
//   - profileRows: 呼んだあとのプロファイルの全行（`stores.profile.list()` のまま）
//   - journal: 呼んだあとに日誌へ足された行（先の行・結果の行。種類・本文・grounds・id・at をそのまま）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: 呼びの並び。`journal.append`・`context.profile.set`（渡した引数と結果）に加え、その下で走る
//     `stores.profile.list/set/replaceAll`・`applier.prepare/commit/discard`・`runners.list`・`runner.setProfile`（引数と結果・失敗付き）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PROFILE_WRITE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-profile-write-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-profile-write-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、行・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。行は場面の頭に基準の 2026-10-01 で積み、呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 道具が下で使うのは本物の `createProfileService`（記憶ストア・偽の器・偽の runner）。投げる・返すの形は、器・runner・正本の口の側で起こす。
// 本物のサービスが作れない形（`ProfileInputError` を名前・本文の検査より後ろで投げる・非 Error を投げる・entries の無い戻り）だけ、`set` の口で差し替える（`override`）。
//
// 秘密: 本文・環境の値は作りものだけ（`export FOO=bar` ほか）。伏せ字の場面は、環境変数 PIN_FAKE_DEPLOY_SECRET（vi.stubEnv で固定）の作りものの値と、
// 作りものの代入 `PIN_FAKE_API_TOKEN=…` が、器・runner の失敗の文に混じっても出力に出ない（伏せられる）ことを確かめる。入力の値のどれも json の全文に無い。
// 環境変数の名前は `PIN_FAKE_DEPLOY_SECRET`（`vitest.env-scrub.ts` が外すのは起動時に在った名前だけ。stubEnv で後から足すものは残る）。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み。none: 日誌も行も同じ / journal: 日誌だけ足された / profile: 行が変わった（日誌も足される） */
type Writes = 'none' | 'journal' | 'profile';

type ApplierMode =
  | { kind: 'absent' }
  | { kind: 'ok'; output?: string }
  | { kind: 'fail'; error?: string; output?: string }
  | { kind: 'prepare-throws'; message: string }
  | { kind: 'commit-throws'; message: string };

type RunnerResult = { ok: boolean; error?: string; output?: string };

interface RunnerSpec {
  id: string;
  result: RunnerResult | { throws: string };
}

type Override = 'throw-string' | 'input-error' | 'stored-minimal' | 'stored-other-entry';

/** 呼びごとに差し替える口（器・runner・正本・日誌の振る舞い） */
interface Hooks {
  /** `journal.append` の何回目（この呼びの中・1 から）を投げさせるか */
  journalFailsAt: number[];
  applier: ApplierMode;
  /** runner の一覧と、それぞれの `setProfile` の結果。'list-throws' は一覧そのものが落ちる */
  runners: RunnerSpec[] | 'list-throws';
  /** 正本の `profile.set` が投げる（error は普通の Error、typeerror は `params:` を持つ TypeError） */
  storeSetThrows: 'none' | 'error' | 'typeerror';
  /** 正本の `profile.replaceAll`（失敗の巻き戻し）が投げる */
  replaceAllThrows: boolean;
  /** 正本の `profile.list` の何回目を投げさせるか */
  listFailsAt: number[];
  /** `context.profile.set` そのものを差し替える */
  override: Override | null;
}

interface SeedRow {
  name: string;
  script: string;
  scope?: EnvProfileScope;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
}

interface Scenario {
  name: string;
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed?: SeedRow[];
  /** `context.profile` を渡さない（記憶へ移す内部ターン） */
  noProfile?: boolean;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const SEED_ISO = '2026-10-01T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-profile-write-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PROFILE_WRITE_PIN === '1';

function callTime(index: number): number {
  return BASE_MS + index * 60_000;
}

const SECRET_ENV_NAME = 'PIN_FAKE_DEPLOY_SECRET';
/** 作りものの環境変数の値。出力にも json にも出ないことを確かめる */
const FAKE_ENV_VALUE = 'pinfake-env-value-0123456789';
/** 作りものの代入の値（`PIN_FAKE_API_TOKEN=…`）。同じく出ない */
const FAKE_ASSIGN_VALUE = 'pinfake-assign-9876543210';
const ALL_FAKE_VALUES = [FAKE_ENV_VALUE, FAKE_ASSIGN_VALUE];

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

function w(args: Args, writes: Writes, hooks?: Partial<Hooks>): Step {
  return { args, writes, ...(hooks === undefined ? {} : { hooks }) };
}

function put(extra: Args = {}): Args {
  return { script: 'export FOO=bar', summary: 'FOO を置いた', ...extra };
}

function okRunners(ids: string[]): RunnerSpec[] {
  return ids.map((id) => ({ id, result: { ok: true } }));
}

const RUST_SEED: SeedRow = { name: 'rust', script: 'export R=1\n', scope: 'all' };
const RUST_VERSION = profileEntryVersionOf({ script: RUST_SEED.script, scope: 'all' });

const SCENARIOS: Scenario[] = [
  // ---- context.profile が無い ----
  {
    name: 'no-profile',
    group: 'context.profile が無い',
    covers:
      '記憶へ移す内部ターン（context.profile が undefined）: 何を渡しても同じ断り。名前の形・本文・base_version の検査より先で、日誌も呼びも無い',
    noProfile: true,
    steps: [
      w(put(), 'none'),
      w(put({ name: '../x', script: '' }), 'none'),
      w(put({ name: 'rust', base_version: RUST_VERSION, scope: 'runner' }), 'none'),
    ],
  },

  // ---- 名前 ----
  {
    name: 'name-invalid',
    group: '行の名前',
    covers:
      '名前の形が不正（PROFILE_ENTRY_NAME）: 空・`/` を含む・先頭が . / - / _・空白・全角・改行付き・65 字。いずれも同じ断り（「何も変えていない」）で、日誌も set も呼ばれない。本文の検査より先',
    steps: [
      w(put({ name: '' }), 'none'),
      w(put({ name: '../x' }), 'none'),
      w(put({ name: 'a/b' }), 'none'),
      w(put({ name: '.hidden' }), 'none'),
      w(put({ name: '-lead' }), 'none'),
      w(put({ name: '_lead' }), 'none'),
      w(put({ name: 'a b' }), 'none'),
      w(put({ name: 'あい' }), 'none'),
      w(put({ name: 'x\n' }), 'none'),
      w(put({ name: 'a'.repeat(65) }), 'none'),
      w(put({ name: '../x', script: '  ' }), 'none'),
    ],
  },
  {
    name: 'name-valid-forms',
    group: '行の名前',
    covers:
      '名前の形が通る境目: 1 字・数字始まり・. _ - を含む・大文字・64 字ちょうど。どれも set まで届き、行の名前は文言（（行 名前）・行 名前 を置いた）にそのまま出る',
    steps: [
      w(put({ name: 'a' }), 'profile'),
      w(put({ name: '0lead' }), 'profile'),
      w(put({ name: 'a.b_c-d' }), 'profile'),
      w(put({ name: 'ZZ' }), 'profile'),
      w(put({ name: `b${'.'.repeat(63)}` }), 'profile'),
    ],
  },
  {
    name: 'name-default',
    group: '行の名前',
    covers:
      'name 省略は default（日誌の文言に（行 …）が付かない）。name: undefined・name: "default" も同じ。default 以外の名前は（行 名前）が付く。default に上書きされて他の行は残る',
    steps: [
      w(put({ script: 'export A=1' }), 'profile'),
      w(put({ name: undefined, script: 'export A=2' }), 'profile'),
      w(put({ name: 'default', script: 'export A=3' }), 'profile'),
      w(put({ name: 'other', script: 'export B=1' }), 'profile'),
      w(put({ name: 'default', script: 'export A=4' }), 'profile'),
    ],
  },
  {
    name: 'name-case-clash',
    group: '行の名前',
    covers:
      '大文字小文字だけが違う既存の行（本物のサービスが ProfileInputError を投げる）: 日誌は先の行のあとに「差し替えられなかった」の行が付き、応答は「プロファイルの行を置けなかった（何も変えていない）: 理由」（isError ではない）。行は変わらない',
    seed: [
      { name: 'Rust', script: 'export R=1\n' },
      { name: 'default', script: 'export D=1\n' },
    ],
    steps: [
      w(put({ name: 'rust' }), 'journal'),
      w(put({ name: 'RUST', script: 'export R=2' }), 'journal'),
      w(put({ name: 'DEFAULT' }), 'journal'),
      w(put({ name: 'Rust', script: 'export R=3' }), 'profile'),
    ],
  },

  // ---- 本文 ----
  {
    name: 'script-empty',
    group: '本文',
    covers:
      '本文が空・空白だけ（trim して 0 字。NBSP・全角空白・改行・タブを含む）: 「本文が空では行を置けない」。日誌も set も呼ばれない。名前の検査のあと',
    steps: [
      w(put({ script: '' }), 'none'),
      w(put({ script: ' ' }), 'none'),
      w(put({ script: '\n\t \n' }), 'none'),
      w(put({ script: ' ' }), 'none'),
      w(put({ script: '　\r\n' }), 'none'),
    ],
  },
  {
    name: 'script-forms',
    group: '本文',
    covers:
      '本文の形（set には道具が渡した文字列のまま届き、サービスが末尾の改行を整える）: 末尾に改行が無い・ある・複数・CRLF・コメントだけ・日本語。呼びの script と正本の行の script の差で見る',
    steps: [
      w(put({ script: 'export A=1' }), 'profile'),
      w(put({ script: 'export A=2\n' }), 'profile'),
      w(put({ script: 'export A=3\n\n\n' }), 'profile'),
      w(put({ script: 'export A=4\r\nexport B=4\r\n' }), 'profile'),
      w(put({ script: '# コメントだけ' }), 'profile'),
      w(put({ script: 'export GREETING=こんにちは' }), 'profile'),
    ],
  },
  {
    name: 'script-nul',
    group: '本文',
    covers:
      '本文に NUL（正本の set が NulNotAllowedError を投げる）: 普通の Error 系なので ProfileInputError ではなく、道具が素のまま投げ直す。日誌は先の行と「差し替えられなかった」（grounds は例外の名前だけ）。行は変わらない',
    steps: [w(put({ script: 'export A=1\u0000' }), 'journal')],
  },

  // ---- scope ----
  {
    name: 'scope-cycle',
    group: 'scope',
    covers:
      'scope: 省略（新しい行は all）→ app → 省略（既存の app を保つ）→ runner → 省略（runner を保つ）→ all → 省略。呼びの scope は道具が渡したまま（省略は undefined）。出力の「撒く先」・合成後の指紋の「（掛かる行なし）」・runner への配布（app のときは空が降りる）が scope で変わる',
    steps: [
      w(put({ name: 'sc' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc', scope: 'app' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc', scope: 'runner' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc', scope: 'all' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'sc' }), 'profile', { runners: okRunners(['runner-a']) }),
    ],
  },

  // ---- base_version ----
  {
    name: 'base-version',
    group: 'base_version',
    covers:
      'base_version: 無い（ifMatch を渡さない＝set の第4引数が undefined）・合っている（{ ifMatch }）・食い違う（「変わっている・作られている」）・行が無い名前に付ける（「消されている」）・空文字（空文字も渡す。食い違い）・撒く先を変えた後の古い版（版は本文と撒く先から作る）。食い違いは何も変えず日誌は先の行と「差し替えられなかった」',
    seed: [RUST_SEED],
    steps: [
      w(put({ name: 'rust', script: 'export R=2' }), 'profile'),
      w(put({ name: 'rust', script: 'export R=3', base_version: RUST_VERSION }), 'journal'),
      w(
        put({
          name: 'rust',
          script: 'export R=4',
          base_version: profileEntryVersionOf({ script: 'export R=2\n', scope: 'all' }),
        }),
        'profile',
      ),
      w(put({ name: 'ghost', base_version: RUST_VERSION }), 'journal'),
      w(put({ name: 'rust', script: 'export R=5', base_version: '' }), 'journal'),
      w(
        put({
          name: 'rust',
          script: 'export R=6',
          scope: 'app',
          base_version: profileEntryVersionOf({ script: 'export R=4\n', scope: 'all' }),
        }),
        'profile',
      ),
      w(
        put({
          name: 'rust',
          script: 'export R=7',
          base_version: profileEntryVersionOf({ script: 'export R=4\n', scope: 'all' }),
        }),
        'journal',
      ),
    ],
  },
  {
    name: 'base-version-default-name',
    group: 'base_version',
    covers:
      'name 省略（default）に base_version: 行が無ければ「消されている」。ラベルの無い日誌の文言。合っていれば置ける',
    steps: [
      w(put({ base_version: RUST_VERSION }), 'journal'),
      w(put({}), 'profile'),
      w(
        put({
          script: 'export FOO=baz',
          base_version: profileEntryVersionOf({ script: 'export FOO=bar\n', scope: 'all' }),
        }),
        'profile',
      ),
    ],
  },

  // ---- summary ----
  {
    name: 'summary-forms',
    group: 'summary',
    covers:
      'summary は日誌の本文にそのまま入る（検査も切り詰めも無い）: 空文字・改行を含む・長い（600 字）・default 以外の行。先の行と結果の行の両方に同じ文が載る。応答には出ない',
    steps: [
      w(put({ summary: '' }), 'profile'),
      w(put({ summary: '一行目\n二行目' }), 'profile'),
      w(put({ summary: spaced(600, 'summary') }), 'profile'),
      w(put({ name: 'named', summary: '名前付きの行の要約' }), 'profile'),
    ],
  },

  // ---- 先の日誌 ----
  {
    name: 'journal-first-fails',
    group: '先の日誌',
    covers:
      '先の日誌が書けない: set も正本の保存も器も runner も呼ばず、JournalNotRecordedError（act-not-performed）を投げる。行は変わらない。2 回目も落ちる指定でも 1 回目で止まる。日誌が戻れば次の呼びは置ける',
    seed: [RUST_SEED],
    steps: [
      w(put(), 'none', { journalFailsAt: [1] }),
      w(put({ name: 'rust', base_version: RUST_VERSION }), 'none', {
        journalFailsAt: [1],
        applier: { kind: 'fail', error: '使われない' },
      }),
      w(put({ name: 'rust', scope: 'runner' }), 'none', {
        journalFailsAt: [1, 2],
        runners: okRunners(['runner-a']),
      }),
      w(put(), 'profile'),
    ],
  },
  {
    name: 'journal-after-fails',
    group: '先の日誌',
    covers:
      '結果の日誌（2 行目）だけが落ちる: 応答は日誌が通ったときと同じ（握る）で、先の行だけが残り、stderr に跡。set が返した形（置けた・評価で断られた）でも、投げた形（正本の保存・版の食い違い・巻き戻し失敗）でも同じ。投げた例外は握り潰さず出る',
    seed: [RUST_SEED],
    steps: [
      w(put(), 'profile', { journalFailsAt: [2] }),
      w(put(), 'journal', {
        journalFailsAt: [2],
        applier: { kind: 'fail', error: '構文が壊れている' },
      }),
      w(put({ script: 'export A=1' }), 'journal', {
        journalFailsAt: [2],
        storeSetThrows: 'error',
      }),
      w(put({ name: 'rust', base_version: '' }), 'journal', { journalFailsAt: [2] }),
      w(put({ script: 'export A=2' }), 'profile', {
        journalFailsAt: [2],
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        replaceAllThrows: true,
      }),
      w(put({ script: 'export A=3' }), 'none', { journalFailsAt: [1, 2] }),
    ],
  },

  // ---- set が投げる ----
  {
    name: 'set-store-throws',
    group: 'set が投げる',
    covers:
      '正本の保存が投げる（クローンの器の評価は済んでいる）: サービスは器を discard し前の行へ書き戻して元の例外を投げ、道具は「差し替えられなかった」の行（grounds は例外の名前だけ）を足して素のまま投げ直す。TypeError の message（`params:` を含む）は日誌に入らず、投げ直した例外には入る。書き戻しが落ちても握って元の例外が出る。行は変わらない',
    seed: [RUST_SEED],
    steps: [
      w(put({ script: 'export A=1' }), 'journal', { storeSetThrows: 'error' }),
      w(put({ name: 'rust', script: 'export A=1' }), 'journal', { storeSetThrows: 'typeerror' }),
      w(put({ script: 'export A=1' }), 'journal', {
        storeSetThrows: 'error',
        replaceAllThrows: true,
      }),
      w(put({ script: 'export A=1' }), 'journal', {
        storeSetThrows: 'error',
        applier: { kind: 'absent' },
      }),
    ],
  },
  {
    name: 'set-list-throws',
    group: 'set が投げる',
    covers:
      '正本の一覧（前の版の読み）が最初に落ちる: 器も正本の保存も呼ばれず、素の Error を投げ直す。日誌は先の行と「差し替えられなかった」',
    steps: [w(put(), 'journal', { listFailsAt: [1] })],
  },
  {
    name: 'set-commit-throws',
    group: 'set が投げる',
    covers:
      'クローンの器への反映（commit）が落ちる: サービスが正本を前の版へ戻して「正本も元へ戻した」の Error を投げ（cause 付き）、道具は「差し替えられなかった」の行を足して素のまま投げ直す。行は変わらない（updatedAt も戻る）。runner へは配られない',
    seed: [RUST_SEED],
    steps: [
      w(put(), 'journal', {
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        runners: okRunners(['runner-a']),
      }),
      w(put({ name: 'rust' }), 'journal', {
        applier: { kind: 'commit-throws', message: `器へ移せなかった ${FAKE_ENV_VALUE}` },
      }),
    ],
  },
  {
    name: 'set-rollback-failed',
    group: 'set が投げる',
    covers:
      '反映も書き戻しも落ちる（ProfileRollbackFailedError）: 日誌の決定は「差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）」で「差し替えられなかった」は出ない（default はラベル無し・名前付きは（行 名前））。grounds は例外の名前。正本は新しい行のまま残る（writes は profile）。反映側の理由の値は伏せ字になる',
    steps: [
      w(put(), 'profile', {
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        replaceAllThrows: true,
      }),
      w(put({ name: 'named' }), 'profile', {
        applier: { kind: 'commit-throws', message: `器へ移せなかった ${FAKE_ENV_VALUE}` },
        replaceAllThrows: true,
      }),
    ],
  },
  {
    name: 'set-throws-raw',
    group: 'set が投げる',
    covers:
      '本物のサービスが作れない投げ方（set の口で差し替え）: 文字列を投げる（grounds は typeof の string）・ProfileInputError を直接投げる（改行を含む理由は reasonOf で 1 行になる。isError ではなく文）。日誌は先の行と「差し替えられなかった」',
    steps: [
      w(put(), 'journal', { override: 'throw-string' }),
      w(put({ name: 'named' }), 'journal', { override: 'input-error' }),
    ],
  },
  {
    name: 'set-after-write-failures',
    group: 'set が投げる',
    covers:
      '正本と器へ反映したあとで、runner の一覧・配布後の一覧が落ちる: サービスは握って stored=true で返す（一覧の失敗は runnersUnconfirmed、読み直しの失敗は書いた行を entries にする）。道具は投げず「更新した」と報告し、一覧の失敗のときだけ日誌と応答に配布を確かめられなかった旨を足す（Issue #6506）。戻しはしない',
    steps: [
      w(put({ name: 'late-a' }), 'profile', { runners: 'list-throws' }),
      w(put({ name: 'late-b' }), 'profile', { listFailsAt: [2] }),
    ],
  },

  // ---- set が返す ----
  {
    name: 'return-clone-only',
    group: 'set が返す',
    covers:
      'クローンだけ（runner が居ない）: 「配った先」「配れなかった先」の行が無く、合成後の指紋と撒く先と固定の末尾の文だけ。器に output が在っても出ない。器が無い構成（clone は ok のまま）でも同じ形。日誌は先の行と「更新した」',
    steps: [
      w(put({ name: 'solo' }), 'profile'),
      w(put({ name: 'solo', script: 'export B=1' }), 'profile', {
        applier: { kind: 'ok', output: '評価の出力（置けたときは出ない）' },
      }),
      w(put({ name: 'solo', script: 'export B=2' }), 'profile', { applier: { kind: 'absent' } }),
    ],
  },
  {
    name: 'return-runner-only',
    group: 'set が返す',
    covers:
      'runner だけ（scope=runner。クローン用の合成は「（掛かる行なし）」）: 配った先に runner が並ぶ（出た順）。runner の数が 1・2 の場合',
    steps: [
      w(put({ name: 'rn', scope: 'runner' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'rn', scope: 'runner', script: 'export B=1' }), 'profile', {
        runners: okRunners(['runner-b', 'runner-a']),
      }),
    ],
  },
  {
    name: 'return-both',
    group: 'set が返す',
    covers:
      'クローンと runner の両方（scope=all）: 合成後の指紋はクローン用・runner 用とも出て、配った先も出る。scope=app のときは runner 用が「（掛かる行なし）」で、runner へは空の本文が降りる（calls の runner.setProfile の script が空）',
    steps: [
      w(put({ name: 'both', scope: 'all' }), 'profile', { runners: okRunners(['runner-a']) }),
      w(put({ name: 'both', scope: 'app' }), 'profile', { runners: okRunners(['runner-a']) }),
    ],
  },
  {
    name: 'runners-partial-fail',
    group: 'set が返す',
    covers:
      '一部の runner の失敗: 配った先（成功した runner）と配れなかった先（失敗した runner の「（理由）」）が両方出る。理由が無い失敗は「理由不明」・setProfile が投げた失敗はその理由（reasonOf）・理由の空白と改行は 1 つの空白にたたむ。置けたことは変わらず日誌は「更新した」',
    steps: [
      w(put({ name: 'part' }), 'profile', {
        runners: [
          { id: 'runner-1', result: { ok: true } },
          { id: 'runner-2', result: { ok: false, error: '評価が失敗した' } },
          { id: 'runner-3', result: { ok: false } },
          { id: 'runner-4', result: { throws: 'ネットワークが切れた' } },
          {
            id: 'runner-5',
            result: { ok: false, error: '一行目\n\n   二行目', output: '出力は出ない' },
          },
          { id: 'runner-6', result: { ok: true } },
        ],
      }),
    ],
  },
  {
    name: 'runners-all-fail',
    group: 'set が返す',
    covers:
      '全部の runner が失敗: 「配った先」の行が無く、「配れなかった先」だけ。置けたこと（stored）は変わらず「更新した」を返す（クローンには効いている）',
    steps: [
      w(put({ name: 'allfail' }), 'profile', {
        runners: [
          { id: 'runner-1', result: { ok: false, error: '評価が失敗した' } },
          { id: 'runner-2', result: { throws: '接続できない' } },
        ],
      }),
    ],
  },
  {
    name: 'runners-many',
    group: 'set が返す',
    covers:
      '配った先・配れなかった先の抜粋（400 字）: 多数の runner が成功 → 「配った先」が「…（n 文字省略。全 m 文字）」で切れる。多数が失敗 → 「配れなかった先」が切れる。400 字に収まる数ならそのまま',
    steps: [
      w(put({ name: 'many' }), 'profile', {
        runners: okRunners(Array.from({ length: 40 }, (_, i) => `runner-${pad2(i + 1)}`)),
      }),
      w(put({ name: 'many', script: 'export B=1' }), 'profile', {
        runners: okRunners(Array.from({ length: 30 }, (_, i) => `runner-${pad2(i + 1)}`)),
      }),
      w(put({ name: 'many', script: 'export B=2' }), 'profile', {
        runners: Array.from({ length: 24 }, (_, i) => ({
          id: `runner-${pad2(i + 1)}`,
          result: { ok: false, error: '評価が失敗した' },
        })),
      }),
    ],
  },
  {
    name: 'applier-fail',
    group: 'set が返す（評価で断られた）',
    covers:
      'クローンの器が評価で断った（stored=false）: 日誌は先の行と「差し替えられなかった（読めなかった）」（grounds は値は記録しない旨）。応答は「実行環境プロファイルを置けなかった（保存も配布もしていない）: 理由」＋ output があれば改行して続ける。理由・output が無ければ「理由不明」。行は変わらず runner へも配られない。isError ではない',
    seed: [RUST_SEED],
    steps: [
      w(put(), 'journal', { applier: { kind: 'fail', error: '構文が壊れている' } }),
      w(put({ name: 'rust' }), 'journal', {
        applier: {
          kind: 'fail',
          error: 'プロファイルの評価が失敗した（終了コード 2）',
          output: 'line 3: 構文エラー',
        },
        runners: okRunners(['runner-a']),
      }),
      w(put({ name: 'named' }), 'journal', { applier: { kind: 'fail' } }),
      w(put(), 'journal', { applier: { kind: 'fail', output: '理由は無く出力だけ' } }),
    ],
  },
  {
    name: 'applier-fail-redaction',
    group: 'set が返す（評価で断られた）',
    covers:
      '伏せ字（redactProfileFailure。process.env を読む）: 器の理由・output に作りものの環境変数の値・作りもの代入の値が混じっても伏せ字になる。`params:` 以降は伏せる。器が投げた例外の文（String(error)）も同じ。出力は 4,000 字で切る（前略の印）。伏せてから切る（切り口で割れた断片が残らない）',
    seed: [RUST_SEED],
    steps: [
      w(put(), 'journal', {
        applier: {
          kind: 'fail',
          error: `評価が失敗した ${FAKE_ENV_VALUE}`,
          output: `+ export ${SECRET_ENV_NAME}=${FAKE_ENV_VALUE}\n構文エラー: ${FAKE_ENV_VALUE} の近く`,
        },
      }),
      w(put(), 'journal', {
        applier: {
          kind: 'fail',
          error: '評価が失敗した',
          output: '+ export PIN_FAKE_API_TOKEN=' + FAKE_ASSIGN_VALUE + '\nexit 3',
        },
      }),
      w(put(), 'journal', {
        applier: {
          kind: 'fail',
          error: 'Failed query: insert into "profile" ("script") values ($1)\nparams: 本文の断片',
        },
      }),
      w(put(), 'journal', {
        applier: { kind: 'prepare-throws', message: `器が落ちた ${FAKE_ENV_VALUE}` },
      }),
      w(put(), 'journal', {
        applier: { kind: 'fail', error: '評価が失敗した', output: spaced(5_000, 'output') },
      }),
      w(put(), 'journal', {
        applier: {
          kind: 'fail',
          error: '評価が失敗した',
          output: `${spaced(3_990, 'tail')} ${FAKE_ENV_VALUE} ${spaced(3_990, 'back')}`,
        },
      }),
      w(put(), 'journal', {
        applier: {
          kind: 'fail',
          error: `${spaced(4_100, 'error')} ${FAKE_ENV_VALUE}`,
          output: '',
        },
      }),
    ],
  },
  {
    name: 'runners-redaction',
    group: 'set が返す（評価で断られた）',
    covers:
      'runner の失敗の文の伏せ字（サービスが出口で伏せる）: runner が返した error・output と、setProfile が投げた例外の文に作りもの値が混じっても「配れなかった先」には伏せ字で出る（output は出ない）。置けたことは変わらない',
    steps: [
      w(put({ name: 'rr' }), 'profile', {
        runners: [
          {
            id: 'runner-1',
            result: {
              ok: false,
              error: `評価が失敗した ${FAKE_ENV_VALUE}`,
              output: FAKE_ENV_VALUE,
            },
          },
          { id: 'runner-2', result: { throws: `接続できない ${FAKE_ENV_VALUE}` } },
          {
            id: 'runner-3',
            result: { ok: false, error: `PIN_FAKE_API_TOKEN=${FAKE_ASSIGN_VALUE}` },
          },
          { id: 'runner-4', result: { ok: true } },
        ],
      }),
    ],
  },
  {
    name: 'return-minimal',
    group: 'set が返す（本物のサービスが作れない戻り）',
    covers:
      'set の口の差し替え: entries も composed も無い戻り（「撒く先」も「合成後の指紋」も出ない）・entries に自分の名前の行が無い戻り（撒く先が出ず、合成の指紋は出る。runner の失敗は理由不明）。日誌は先の行と「更新した」',
    steps: [
      w(put(), 'journal', { override: 'stored-minimal' }),
      w(put({ name: 'mine' }), 'journal', { override: 'stored-other-entry' }),
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
  /** 例外で返ったときの名前（例外でなければ null。Error でないものは typeof） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: Writes;
  /** 呼んだあとのプロファイルの全行 */
  profileRows: Record<string, unknown>[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 日誌の書き損じを握ったときに stderr へ残った跡 */
  dropped: string[];
  /** 呼びの並び */
  calls: PinnedCall[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Snapshot {
  profileRows: Record<string, unknown>[];
  journal: Record<string, unknown>[];
}

async function snapshot(base: Stores): Promise<Snapshot> {
  return {
    profileRows: plain(await base.profile.list()) as unknown as Record<string, unknown>[],
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function freshHooks(): Hooks {
  return {
    journalFailsAt: [],
    applier: { kind: 'ok' },
    runners: [],
    storeSetThrows: 'none',
    replaceAllThrows: false,
    listFailsAt: [],
    override: null,
  };
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 呼びを記録して返す（結果は戻ってから埋める。並びは呼んだ順） */
function record(calls: PinnedCall[], op: string, args: unknown): PinnedCall {
  const entry: PinnedCall = { op, args: plain(args), outcome: '(まだ戻っていない)' };
  calls.push(entry);
  return entry;
}

function countOf(calls: PinnedCall[], op: string): number {
  return calls.filter((entry) => entry.op === op).length;
}

function describeResult(result: ApplyProfileResult): string {
  const runners = result.runners
    .map((runner) => `${runner.runnerId}:${runner.ok ? 'ok' : 'ng'}`)
    .join(',');
  return `stored=${String(result.stored)} clone.ok=${String(result.clone.ok)} runners=[${runners}] entries=${
    result.entries === undefined ? 'undefined' : String(result.entries.length)
  }`;
}

/** 正本の口（list / set / replaceAll / remove / clear）と日誌の append を、呼びの記録つき・失敗を起こせる形にする */
function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  const profile: Stores['profile'] = {
    ...base.profile,
    list: async () => {
      const entry = record(calls, 'stores.profile.list', {});
      if (hooks.listFailsAt.includes(countOf(calls, 'stores.profile.list'))) {
        entry.outcome = 'threw Error';
        throw new Error('正本の一覧が読めない（test）');
      }
      const rows = await base.profile.list();
      entry.outcome = `${String(rows.length)} rows`;
      return rows;
    },
    set: async (name, script, scope) => {
      const entry = record(calls, 'stores.profile.set', { name, script, scope });
      try {
        if (hooks.storeSetThrows === 'error') throw new Error('正本へ書けない（test）');
        if (hooks.storeSetThrows === 'typeerror') {
          throw new TypeError(
            'Failed query: insert into "profile" ("script") values ($1)\nparams: PIN_PARAM_MARKER',
          );
        }
        const row = await base.profile.set(name, script, scope);
        entry.outcome = 'ok';
        return row;
      } catch (error) {
        entry.outcome = `threw ${nameOf(error)}`;
        throw error;
      }
    },
    replaceAll: async (previous) => {
      const entry = record(calls, 'stores.profile.replaceAll', {
        names: previous.map((row) => row.name),
      });
      if (hooks.replaceAllThrows) {
        entry.outcome = 'threw Error';
        throw new Error('書き戻しが落ちた（test）');
      }
      await base.profile.replaceAll(previous);
      entry.outcome = 'ok';
    },
    remove: async (name) => {
      const entry = record(calls, 'stores.profile.remove', { name });
      const removed = await base.profile.remove(name);
      entry.outcome = String(removed);
      return removed;
    },
    clear: async () => {
      const entry = record(calls, 'stores.profile.clear', {});
      const count = await base.profile.clear();
      entry.outcome = String(count);
      return count;
    },
  };
  return {
    ...base,
    profile,
    journal: {
      ...base.journal,
      append: async (input) => {
        const entry = record(calls, 'journal.append', input);
        if (hooks.journalFailsAt.includes(countOf(calls, 'journal.append'))) {
          entry.outcome = 'threw Error: 日誌が落ちた';
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(input);
        entry.outcome = `ok ${written.id}`;
        return written;
      },
    },
  };
}

function buildApplier(mode: ApplierMode, calls: PinnedCall[]): ProfileApplier | undefined {
  if (mode.kind === 'absent') return undefined;
  const never = async (): Promise<never> => {
    throw new Error('この試験では使わない');
  };
  return {
    vessel: {} as never,
    fingerprint: () => undefined,
    env: () => ({}),
    apply: never,
    prepare: async (script) => {
      const entry = record(calls, 'applier.prepare', { script });
      if (mode.kind === 'prepare-throws') {
        entry.outcome = 'threw Error';
        throw new Error(mode.message);
      }
      const failed = mode.kind === 'fail';
      entry.outcome = failed ? 'ok=false' : 'ok=true';
      return {
        ok: !failed,
        ...(mode.kind === 'fail' && mode.error !== undefined ? { error: mode.error } : {}),
        ...(mode.kind !== 'commit-throws' && mode.output !== undefined
          ? { output: mode.output }
          : {}),
        commit: async () => {
          const commit = record(calls, 'applier.commit', {});
          if (mode.kind === 'commit-throws') {
            commit.outcome = 'threw Error';
            throw new Error(mode.message);
          }
          commit.outcome = 'ok';
          return undefined;
        },
        discard: async () => {
          record(calls, 'applier.discard', {}).outcome = 'ok';
        },
      };
    },
  };
}

function buildRunners(specs: RunnerSpec[] | 'list-throws', calls: PinnedCall[]): RunnerRegistry {
  return {
    list: async () => {
      const entry = record(calls, 'runners.list', {});
      if (specs === 'list-throws') {
        entry.outcome = 'threw Error';
        throw new Error('runner の一覧が取れない（test）');
      }
      entry.outcome = `${String(specs.length)} runners`;
      return specs.map((spec) => ({
        runnerId: spec.id,
        setProfile: async (script: string) => {
          const call = record(calls, 'runner.setProfile', { runnerId: spec.id, script });
          if ('throws' in spec.result) {
            call.outcome = 'threw Error';
            throw new Error(spec.result.throws);
          }
          call.outcome = `ok=${String(spec.result.ok)}`;
          return spec.result;
        },
      })) as never;
    },
    get: async () => null,
    select: async () => {
      throw new Error('この試験では使わない');
    },
  } as unknown as RunnerRegistry;
}

const OTHER_ENTRY: EnvProfileEntry = {
  name: 'other',
  script: 'export OTHER=1\n',
  scope: 'app',
  updatedAt: SEED_ISO,
};

/** `context.profile`。`set` の呼び（渡した引数と結果）を記録する。override のときは本物のサービスを通さず差し替える */
function buildProfile(service: ProfileService, hooks: Hooks, calls: PinnedCall[]): ProfileService {
  return {
    ...service,
    set: async (name, script, scope, options) => {
      const entry = record(calls, 'context.profile.set', {
        name,
        script,
        scope: scope ?? null,
        options: options ?? null,
      });
      try {
        let result: ApplyProfileResult;
        switch (hooks.override) {
          case 'throw-string':
            // 非 Error を投げる枝を作る
            throw 'raw string failure';
          case 'input-error':
            throw new ProfileInputError('名前の形が不正\n二行目の理由');
          case 'stored-minimal':
            result = { stored: true, clone: { ok: true }, runners: [] };
            break;
          case 'stored-other-entry':
            result = {
              stored: true,
              updatedAt: SEED_ISO,
              entries: [OTHER_ENTRY],
              composed: {
                clone: { sha256: 'abcdef012345', bytes: 15 },
                runner: {},
              },
              clone: { ok: true },
              runners: [
                { runnerId: 'runner-x', ok: true },
                { runnerId: 'runner-y', ok: false },
              ],
            };
            break;
          case null:
            result = await service.set(name, script, scope, options);
            break;
        }
        entry.outcome = describeResult(result);
        return result;
      } catch (error) {
        entry.outcome = `threw ${nameOf(error)}`;
        throw error;
      }
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(SEED_ISO));
  for (const seed of scenario.seed ?? []) {
    await base.profile.set(seed.name, seed.script, seed.scope ?? 'all');
  }
  const hooks = freshHooks();
  const calls: PinnedCall[] = [];
  const dropped: string[] = [];
  setStderrSinkForTesting((line) => {
    dropped.push(line);
  });
  const results: PinnedStep[] = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      Object.assign(hooks, freshHooks(), step.hooks ?? {});
      calls.length = 0;
      dropped.length = 0;
      const stores = withHooks(base, hooks, calls);
      const applier = buildApplier(hooks.applier, calls);
      const service = createProfileService({
        stores,
        ...(applier === undefined ? {} : { applier }),
        runners: buildRunners(hooks.runners, calls),
      });
      const context: ToolContext = {
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        ...(scenario.noProfile === true ? {} : { profile: buildProfile(service, hooks, calls) }),
      };
      const found = createCloneTools(context).find((entry) => entry.name === 'profile_write');
      if (!found) throw new Error('profile_write が無い');

      const before = await snapshot(base);
      vi.setSystemTime(new Date(callTime(index)));
      let output: PinnedOutput;
      try {
        const result = await found.handler(step.args as never, {} as never);
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
          errorName: nameOf(error),
        };
      }
      Object.assign(hooks, freshHooks());
      const after = await snapshot(base);
      const profileChanged =
        JSON.stringify(before.profileRows) !== JSON.stringify(after.profileRows);
      const journalChanged = before.journal.length !== after.journal.length;
      const wrote: Writes = profileChanged ? 'profile' : journalChanged ? 'journal' : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 書き込みの有無が宣言（${step.writes}）と違う`).toBe(step.writes);
      if (step.writes === 'none') {
        // 書き込みが起きなかった呼びは、行・日誌が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
        expect(after.profileRows, `場面 ${key}: 断ったのに行が変わった`).toEqual(
          before.profileRows,
        );
        expect(after.journal.length, `場面 ${key}: 断ったのに日誌へ行が足された`).toBe(
          before.journal.length,
        );
      }
      results.push({
        output,
        wrote,
        profileRows: after.profileRows,
        journal: after.journal.slice(before.journal.length),
        dropped: [...dropped],
        calls: plain(calls),
      });
    }
  } finally {
    setStderrSinkForTesting(null);
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

describe('profile_write の出力と呼んだあとの状態の固定（場面ごとの出力の全文・行・日誌の行・呼びの並び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    // 伏せ字は process.env を読む: 作りものの値を固定して、環境に左右されないようにする
    vi.stubEnv(SECRET_ENV_NAME, FAKE_ENV_VALUE);
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
    vi.unstubAllEnvs();
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

  it('書き込みの有無が、場面の宣言・固定値と同じ（断った場面は none で、呼びも日誌も無い）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
        expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が宣言と違う`).toBe(
          step.writes,
        );
        if (step.writes === 'none' && step.hooks?.journalFailsAt === undefined) {
          expect(actual[key]?.calls, `${key}: 断った場面で呼びが起きた`).toEqual([]);
          expect(actual[key]?.journal, `${key}: 断った場面で日誌が足された`).toEqual([]);
        }
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

      it(`${key} の呼んだあとのプロファイルの行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.profileRows,
          `場面 ${key} のプロファイルの行（名前・本文・撒く先・更新時刻）が変わった`,
        ).toEqual(want?.profileRows);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとに日誌へ足された行と握った跡が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・grounds・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(got?.dropped, `場面 ${key} の握った書き損じの跡（stderr）が変わった`).toEqual(
          want?.dropped,
        );
      });

      it(`${key} の呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び（引数・結果・失敗）が固定値からずれた`).toEqual(
          want?.calls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・行・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値が出力にも json にも入っていない（伏せ字の場面は伏せられ、値のどれも各場面の出力・日誌・呼び・json の全文に無い）', () => {
    for (const key of ALL_KEYS) {
      const step = actual[key];
      const whole = JSON.stringify(step);
      for (const value of ALL_FAKE_VALUES) {
        expect(
          step?.output.text.includes(value),
          `場面 ${key} の出力に作りものの値 ${value} が入っている`,
        ).toBe(false);
        expect(
          // 呼びの引数・日誌・行に入る入力の本文は作りものの値を含まない（含むのは器・runner が返す失敗の文だけで、結果は呼びに写さない）
          whole.includes(value),
          `場面 ${key} の記録に作りものの値 ${value} が入っている`,
        ).toBe(false);
      }
    }
    for (const value of ALL_FAKE_VALUES) {
      expect(pinnedRaw.includes(value), `json に作りものの値 ${value} が入っている`).toBe(false);
    }
    expect(pinnedRaw).not.toContain('pinfake');
    expect(pinnedRaw).not.toMatch(/sk-/);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const decisions = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.decision));
    const groundsOf = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.grounds));
    const setCall = (key: string): PinnedCall | undefined =>
      step(key).calls.find((entry) => entry.op === 'context.profile.set');
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

    const NO_PROFILE =
      'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。次の会話で置くこと。';
    const BAD_NAME = '行の名前の形が不正（^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$）。何も変えていない。';
    const EMPTY = '本文が空では行を置けない。外すなら profile_remove を使う。何も変えていない。';
    const PRE = '実行環境プロファイルを差し替えようとしている';
    const FAILED = '実行環境プロファイルを差し替えられなかった';
    const FAILED_UNREAD = '実行環境プロファイルを差し替えられなかった（読めなかった）';
    const UPDATED = '実行環境プロファイルを更新した';
    const HALF =
      '実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）';
    const PRE_GROUNDS = '人間から実行環境そのものを渡された（値は記録しない）';
    const TAIL_LINE =
      'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。';

    // context.profile が無い
    for (const key of ['no-profile#1', 'no-profile#2', 'no-profile#3']) {
      expect(text(key)).toBe(NO_PROFILE);
      expect(step(key).calls).toEqual([]);
    }

    // 断り（検査）: 日誌も呼びも無い
    for (let i = 1; i <= 11; i += 1) {
      expect(text(`name-invalid#${String(i)}`)).toBe(BAD_NAME);
      expect(step(`name-invalid#${String(i)}`).calls).toEqual([]);
    }
    for (let i = 1; i <= 5; i += 1) {
      expect(text(`script-empty#${String(i)}`)).toBe(EMPTY);
      expect(step(`script-empty#${String(i)}`).calls).toEqual([]);
    }

    // 通る名前・default の文言
    expect(decisions('name-default#1')).toEqual([
      `${PRE}: FOO を置いた`,
      `${UPDATED}: FOO を置いた`,
    ]);
    expect(decisions('name-default#4')[0]).toBe(`${PRE}（行 other）: FOO を置いた`);
    expect(text('name-default#4')).toContain('行 other を置いた');
    expect(setCall('name-default#2')?.args).toMatchObject({ name: 'default' });
    expect(text('name-valid-forms#5')).toContain(`行 b${'.'.repeat(63)} を置いた`);
    expect(text('name-case-clash#1')).toContain(
      'プロファイルの行を置けなかった（何も変えていない）',
    );
    expect(text('name-case-clash#1')).toContain('大文字小文字だけが違う行 Rust');
    expect(step('name-case-clash#1').output.isError).toBe(false);
    expect(decisions('name-case-clash#1')).toEqual([
      `${PRE}（行 rust）: FOO を置いた`,
      `${FAILED}（行 rust）: FOO を置いた`,
    ]);
    expect(text('name-case-clash#4')).toContain('行 Rust を置いた');

    // 本文の整形（呼びの script は渡したまま、正本の行は整う）
    expect(setCall('script-forms#1')?.args).toMatchObject({ script: 'export A=1' });
    expect(step('script-forms#1').profileRows[0]).toMatchObject({ script: 'export A=1\n' });
    expect(step('script-forms#2').profileRows[0]).toMatchObject({ script: 'export A=2\n' });
    expect(step('script-forms#3').profileRows[0]).toMatchObject({ script: 'export A=3\n\n\n' });
    expect(step('script-nul').output.thrown).toBe(true);
    expect(step('script-nul').output.errorName).toBe('NulNotAllowedError');
    expect(groundsOf('script-nul')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: NulNotAllowedError',
    );

    // scope: 渡したまま・省略は null で、撒く先が保たれる
    expect(setCall('scope-cycle#1')?.args).toMatchObject({ scope: null });
    expect(text('scope-cycle#1')).toContain('撒く先 all');
    expect(text('scope-cycle#2')).toContain('撒く先 app');
    expect(text('scope-cycle#3')).toContain('撒く先 app');
    expect(text('scope-cycle#4')).toContain('撒く先 runner');
    expect(text('scope-cycle#5')).toContain('撒く先 runner');
    expect(text('scope-cycle#6')).toContain('撒く先 all');
    expect(text('scope-cycle#7')).toContain('撒く先 all');
    expect(text('scope-cycle#2')).toContain('runner 用 （掛かる行なし）');
    expect(text('scope-cycle#4')).toContain('クローン用 （掛かる行なし）');
    expect(
      step('scope-cycle#2').calls.find((entry) => entry.op === 'runner.setProfile')?.args,
    ).toMatchObject({ script: '' });

    // base_version
    expect(setCall('base-version#1')?.args).toMatchObject({ options: null });
    expect(setCall('base-version#2')?.args).toMatchObject({ options: { ifMatch: RUST_VERSION } });
    expect(text('base-version#2')).toContain(
      '読んだ後に変わっている・作られている（何も変えていない）',
    );
    expect(text('base-version#2')).toContain('profile_read name=rust で読み直し');
    expect(step('base-version#2').output.isError).toBe(false);
    expect(text('base-version#3')).toContain('行 rust を置いた');
    expect(text('base-version#4')).toContain('読んだ後に消されている（何も変えていない）');
    expect(setCall('base-version#5')?.args).toMatchObject({ options: { ifMatch: '' } });
    expect(text('base-version#5')).toContain('変わっている・作られている');
    expect(text('base-version#6')).toContain('行 rust を置いた');
    expect(text('base-version#7')).toContain('変わっている・作られている');
    expect(groundsOf('base-version#2')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: ProfileVersionMismatchError',
    );
    expect(text('base-version-default-name#1')).toContain('profile_read name=default で読み直し');
    expect(text('base-version-default-name#1')).toContain('消されている');
    expect(decisions('base-version-default-name#1')[1]).toBe(`${FAILED}: FOO を置いた`);

    // summary
    expect(decisions('summary-forms#1')).toEqual([`${PRE}: `, `${UPDATED}: `]);
    expect(decisions('summary-forms#2')[0]).toBe(`${PRE}: 一行目\n二行目`);
    expect(decisions('summary-forms#3')[0]?.length).toBe(PRE.length + 2 + 600);
    expect(text('summary-forms#3')).not.toContain('summary');
    expect(groundsOf('summary-forms#1')).toEqual([
      PRE_GROUNDS,
      '人間から実行環境そのものを渡された（値は記録しない）',
    ]);

    // 先の日誌
    for (const key of ['journal-first-fails#1', 'journal-first-fails#2', 'journal-first-fails#3']) {
      expect(step(key).output.errorName).toBe('JournalNotRecordedError');
      expect(step(key).output.thrown).toBe(true);
      expect(text(key)).toContain('profile_write');
      expect(ops(key)).toEqual(['journal.append']);
      expect(step(key).journal).toEqual([]);
    }
    expect(text('journal-first-fails#1')).toContain('理由: Error: 日誌が落ちた');
    expect(ops('journal-first-fails#4')).toContain('context.profile.set');
    expect(step('journal-first-fails#4').journal).toHaveLength(2);
    for (const key of [
      'journal-after-fails#1',
      'journal-after-fails#2',
      'journal-after-fails#3',
      'journal-after-fails#4',
      'journal-after-fails#5',
    ]) {
      expect(step(key).journal, key).toHaveLength(1);
      expect(step(key).dropped, key).toHaveLength(1);
    }
    expect(step('journal-after-fails#1').output.thrown).toBe(false);
    expect(text('journal-after-fails#1')).toContain('行 default を置いた');
    expect(text('journal-after-fails#2')).toContain('実行環境プロファイルを置けなかった');
    expect(step('journal-after-fails#3').output.thrown).toBe(true);
    expect(step('journal-after-fails#4').output.thrown).toBe(false);
    expect(step('journal-after-fails#5').output.errorName).toBe('ProfileRollbackFailedError');
    expect(step('journal-after-fails#6').output.errorName).toBe('JournalNotRecordedError');
    expect(ops('journal-after-fails#6')).toEqual(['journal.append']);

    // set が投げる
    expect(step('set-store-throws#1').output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: '正本へ書けない（test）',
    });
    expect(decisions('set-store-throws#1')).toEqual([
      `${PRE}: FOO を置いた`,
      `${FAILED}: FOO を置いた`,
    ]);
    expect(groundsOf('set-store-throws#1')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: Error',
    );
    expect(groundsOf('set-store-throws#2')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: TypeError',
    );
    expect(text('set-store-throws#2')).toContain('params: PIN_PARAM_MARKER');
    expect(JSON.stringify(step('set-store-throws#2').journal)).not.toContain('PIN_PARAM_MARKER');
    expect(ops('set-store-throws#1')).toEqual([
      'journal.append',
      'context.profile.set',
      'stores.profile.list',
      'applier.prepare',
      'stores.profile.set',
      'applier.discard',
      'stores.profile.replaceAll',
      'journal.append',
    ]);
    expect(ops('set-store-throws#3')).toContain('stores.profile.replaceAll');
    expect(step('set-store-throws#4').calls.some((entry) => entry.op.startsWith('applier.'))).toBe(
      false,
    );
    expect(ops('set-list-throws')).toEqual([
      'journal.append',
      'context.profile.set',
      'stores.profile.list',
      'journal.append',
    ]);
    expect(text('set-commit-throws#1')).toContain(
      'プロファイルをクローンへ反映できなかったので、正本も元へ戻した: ',
    );
    expect(ops('set-commit-throws#1')).not.toContain('runner.setProfile');
    expect(decisions('set-commit-throws#1')[1]).toBe(`${FAILED}: FOO を置いた`);
    expect(step('set-commit-throws#2').output.text).not.toContain(FAKE_ENV_VALUE);
    expect(step('set-rollback-failed#1').output.errorName).toBe('ProfileRollbackFailedError');
    expect(decisions('set-rollback-failed#1')[1]).toBe(`${HALF}: FOO を置いた`);
    expect(decisions('set-rollback-failed#2')[1]).toBe(`${HALF}（行 named）: FOO を置いた`);
    expect(groundsOf('set-rollback-failed#1')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: ProfileRollbackFailedError',
    );
    expect(decisions('set-rollback-failed#1').join('')).not.toContain('差し替えられなかった');
    expect(step('set-rollback-failed#1').wrote).toBe('profile');
    expect(step('set-throws-raw#1').output).toMatchObject({
      thrown: true,
      errorName: 'string',
      text: 'raw string failure',
    });
    expect(groundsOf('set-throws-raw#1')[1]).toBe(
      '差し替えようとしたが、状態の変更が失敗した: string',
    );
    expect(step('set-throws-raw#2').output.thrown).toBe(false);
    expect(text('set-throws-raw#2')).toContain(
      'プロファイルの行を置けなかった（何も変えていない）: ',
    );
    expect(count(text('set-throws-raw#2'), '\n')).toBe(0);
    expect(step('set-after-write-failures#1').wrote).toBe('profile');
    expect(step('set-after-write-failures#2').wrote).toBe('profile');
    // 書けた側を正にして報告する（Issue #6506）: 投げず、置けたと返す。戻しもしない
    for (const key of ['set-after-write-failures#1', 'set-after-write-failures#2']) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).output.isError, key).toBe(false);
      expect(ops(key), key).not.toContain('applier.discard');
      expect(ops(key), key).not.toContain('stores.profile.replaceAll');
      expect(decisions(key)[1], key).not.toContain('差し替えられなかった');
    }
    expect(decisions('set-after-write-failures#1')[1]).toBe(
      `${UPDATED}（行 late-a）（runner への配布は確かめられなかった）: FOO を置いた`,
    );
    expect(groundsOf('set-after-write-failures#1')[1]).toBe(
      `${PRE_GROUNDS}。runner の一覧を読めず、配布を確かめられなかった: Error: runner の一覧が取れない（test）`,
    );
    expect(text('set-after-write-failures#1')).toContain(
      'runner への配布を確かめられなかった（runner の一覧を読めない）: Error: runner の一覧が取れない（test）',
    );
    expect(text('set-after-write-failures#1')).not.toContain('配った先');
    expect(decisions('set-after-write-failures#2')[1]).toBe(
      `${UPDATED}（行 late-b）: FOO を置いた`,
    );
    expect(text('set-after-write-failures#2')).toContain('撒く先 all');
    expect(text('set-after-write-failures#2')).not.toContain('確かめられなかった');

    // set が返す
    expect(text('return-clone-only#1')).toContain(
      '実行環境プロファイルを更新した（行 solo を置いた。撒く先 all）。',
    );
    expect(text('return-clone-only#1')).not.toContain('配った先');
    expect(text('return-clone-only#1')).not.toContain('配れなかった先');
    expect(text('return-clone-only#1').endsWith(TAIL_LINE)).toBe(true);
    expect(text('return-clone-only#2')).not.toContain('評価の出力');
    expect(ops('return-clone-only#3')).not.toContain('applier.prepare');
    expect(text('return-runner-only#1')).toContain('配った先: runner-a');
    expect(text('return-runner-only#2')).toContain('配った先: runner-b, runner-a');
    expect(text('return-both#1')).toMatch(/クローン用 [0-9a-f]{12} \/ runner 用 [0-9a-f]{12}/);
    expect(text('runners-partial-fail')).toContain('配った先: runner-1, runner-6');
    expect(text('runners-partial-fail')).toContain('runner-3（理由不明）');
    expect(text('runners-partial-fail')).toContain('runner-4（Error: ネットワークが切れた）');
    expect(text('runners-partial-fail')).toContain('runner-5（一行目 二行目）');
    expect(text('runners-partial-fail')).not.toContain('出力は出ない');
    expect(text('runners-all-fail')).not.toContain('配った先');
    expect(text('runners-all-fail')).toContain(
      '配れなかった先: runner-1（評価が失敗した）, runner-2（Error: 接続できない）',
    );
    expect(text('runners-many#1')).toMatch(/配った先: .*…（\d+ 文字省略。全 \d+ 文字）/);
    expect(text('runners-many#2')).not.toMatch(/配った先: .*省略/);
    expect(text('runners-many#3')).toMatch(/配れなかった先: .*…（\d+ 文字省略。全 \d+ 文字）/);
    expect(decisions('return-clone-only#1')[1]).toBe(`${UPDATED}（行 solo）: FOO を置いた`);

    // 評価で断られた
    expect(text('applier-fail#1')).toBe(
      '実行環境プロファイルを置けなかった（保存も配布もしていない）: 構文が壊れている',
    );
    expect(text('applier-fail#2')).toBe(
      '実行環境プロファイルを置けなかった（保存も配布もしていない）: プロファイルの評価が失敗した（終了コード 2）\nline 3: 構文エラー',
    );
    expect(text('applier-fail#3')).toBe(
      '実行環境プロファイルを置けなかった（保存も配布もしていない）: 理由不明',
    );
    expect(text('applier-fail#4')).toBe(
      '実行環境プロファイルを置けなかった（保存も配布もしていない）: 理由不明\n理由は無く出力だけ',
    );
    expect(decisions('applier-fail#1')).toEqual([
      `${PRE}: FOO を置いた`,
      `${FAILED_UNREAD}: FOO を置いた`,
    ]);
    expect(groundsOf('applier-fail#1')[1]).toBe(
      '人間から実行環境そのものを渡されたが、評価で断られた（値は記録しない）',
    );
    expect(decisions('applier-fail#3')[1]).toBe(`${FAILED_UNREAD}（行 named）: FOO を置いた`);
    expect(ops('applier-fail#2')).not.toContain('runners.list');
    expect(ops('applier-fail#2')).toContain('applier.discard');
    expect(step('applier-fail#1').output.isError).toBe(false);
    for (let i = 1; i <= 7; i += 1) {
      const key = `applier-fail-redaction#${String(i)}`;
      expect(text(key), key).toContain(
        '実行環境プロファイルを置けなかった（保存も配布もしていない）',
      );
    }
    expect(text('applier-fail-redaction#1')).toContain('[REDACTED]');
    expect(text('applier-fail-redaction#2')).toContain('PIN_FAKE_API_TOKEN=[REDACTED]');
    expect(text('applier-fail-redaction#3')).toContain('params: [REDACTED]');
    expect(text('applier-fail-redaction#3')).not.toContain('本文の断片');
    expect(text('applier-fail-redaction#4')).toContain('Error: 器が落ちた [REDACTED]');
    expect(text('applier-fail-redaction#5')).toContain('…（前略）\n');
    // 伏せたあとで末尾 4,000 字へ切る。切り口が伏せ字の印の途中に当たったら、印の後ろから残す（欠けた印を出さない。#6506）
    expect(text('applier-fail-redaction#6')).toContain('…（前略）\n back');
    expect(text('applier-fail-redaction#6')).not.toContain('REDACTED]');
    expect(text('applier-fail-redaction#7')).toContain('[REDACTED]');
    expect(text('runners-redaction')).toContain('runner-1（評価が失敗した [REDACTED]）');
    expect(text('runners-redaction')).toContain('runner-2（Error: 接続できない [REDACTED]）');
    expect(text('runners-redaction')).toContain('runner-3（PIN_FAKE_API_TOKEN=[REDACTED]）');
    expect(text('runners-redaction')).toContain('配った先: runner-4');

    // 本物のサービスが作れない戻り
    expect(text('return-minimal#1')).toBe(
      `実行環境プロファイルを更新した（行 default を置いた）。\n${TAIL_LINE}`,
    );
    expect(text('return-minimal#2')).not.toContain('撒く先');
    expect(text('return-minimal#2')).toContain(
      '合成後の指紋: クローン用 abcdef012345 / runner 用 （掛かる行なし）',
    );
    expect(text('return-minimal#2')).toContain('配った先: runner-x');
    expect(text('return-minimal#2')).toContain('配れなかった先: runner-y（理由不明）');
  });
});
