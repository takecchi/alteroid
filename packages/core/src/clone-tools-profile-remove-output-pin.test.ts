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

// `profile_remove` の出力（全文と字数）と、呼んだあとの状態（プロファイルの行・日誌へ足された行）・呼びの並び
// （`journal.append`・`context.profile.remove` に渡した name / ifMatch・その下で走る正本の削除・クローンの器・runner への配布）を、
// 場面ごとにコミットした固定値（clone-tools-profile-remove-output-pin.json）と丸ごと比べる。
// `clone-tools-profile.ts` の `tool('profile_remove', …)`（断り → 日誌が先 → `remove` → 投げたら `profileToolFailed`・無ければ `appendJournalOrDrop`・
// あれば `profileToolReport`）を小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。
// 手本は clone-tools-profile-write-output-pin.test.ts（同じ `transact` を通る）。固定値の側で値を伏せず、入力（時計・行・runner・器の結果）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。道具が投げ直した例外は、素の message をそのまま固定する
//   - wrote: 呼ぶ前から変わったもの。none（日誌も行も同じ）/ journal（日誌だけ）/ profile（行が変わった。日誌も足される）。場面ごとの宣言と実際が合うことも確かめる
//   - profileRows: 呼んだあとのプロファイルの全行（`stores.profile.list()` のまま）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・id・at をそのまま）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: 呼びの並び。`journal.append`・`context.profile.remove`（渡した name / options と結果）に加え、その下で走る
//     `stores.profile.list/remove/replaceAll`・`applier.prepare/commit/discard`・`runners.list`・`runner.setProfile`（引数と結果・失敗付き）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PROFILE_REMOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-profile-remove-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-profile-remove-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、行・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。行は場面の頭に基準の 2026-10-01 で積み、呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 道具が下で使うのは本物の `createProfileService`（記憶ストア・偽の器・偽の runner）。投げる・返すの形は、器・runner・正本の口の側で起こす。
// 本物のサービスが作れない形（名前の検査のあとで `ProfileInputError` を投げる・非 Error を投げる・entries の無い戻り）だけ、`remove` の口で差し替える（`override`）。
//
// 秘密: 本文・環境の値は作りものだけ（`export FOO=bar` ほか）。伏せ字の場面は、環境変数 PIN_FAKE_DEPLOY_SECRET（vi.stubEnv で固定）の作りものの値と、
// 作りものの代入 `PIN_FAKE_API_TOKEN=…` が、器・runner の失敗の文に混じっても出力に出ない（伏せられる）ことを確かめる。入力の値のどれも json の全文に無い。
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
  /** 正本の `profile.remove` が投げる（error は普通の Error、typeerror は `params:` を持つ TypeError） */
  storeRemoveThrows: 'none' | 'error' | 'typeerror';
  /** 正本の `profile.replaceAll`（失敗の巻き戻し）が投げる */
  replaceAllThrows: boolean;
  /** 正本の `profile.list` の何回目を投げさせるか */
  listFailsAt: number[];
  /** `context.profile.remove` そのものを差し替える */
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
const PIN_URL = new URL('./clone-tools-profile-remove-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PROFILE_REMOVE_PIN === '1';

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

/** `profile_remove` の引数。要約は固定 */
function rm(name: string, extra: Args = {}): Args {
  return { name, summary: 'FOO を外した', ...extra };
}

function okRunners(ids: string[]): RunnerSpec[] {
  return ids.map((id) => ({ id, result: { ok: true } }));
}

const RUST_SEED: SeedRow = { name: 'rust', script: 'export R=1\n', scope: 'all' };
const RUST_VERSION = profileEntryVersionOf({ script: RUST_SEED.script, scope: 'all' });
const OTHER_SEED: SeedRow = { name: 'other', script: 'export O=1\n', scope: 'all' };

const SCENARIOS: Scenario[] = [
  // ---- 断り ----
  {
    name: 'no-profile',
    group: '断り',
    covers:
      '記憶へ移す内部ターン（context.profile が undefined）: 何を渡しても同じ断り。名前の形・base_version の検査より先で、日誌も呼びも無い',
    noProfile: true,
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'none'),
      w(rm('../x'), 'none'),
      w(rm('rust', { base_version: RUST_VERSION }), 'none'),
    ],
  },
  {
    name: 'name-invalid',
    group: '断り',
    covers:
      '名前の形が不正（PROFILE_ENTRY_NAME）: 空・`/` を含む・先頭が . / - / _・空白・全角・改行付き・65 字。いずれも同じ断り（「何も変えていない」）で、日誌も remove も呼ばれない',
    seed: [RUST_SEED],
    steps: [
      w(rm(''), 'none'),
      w(rm('../x'), 'none'),
      w(rm('a/b'), 'none'),
      w(rm('.hidden'), 'none'),
      w(rm('-lead'), 'none'),
      w(rm('_lead'), 'none'),
      w(rm('a b'), 'none'),
      w(rm('あい'), 'none'),
      w(rm('x\n'), 'none'),
      w(rm('a'.repeat(65)), 'none'),
    ],
  },

  // ---- 先の日誌 ----
  {
    name: 'journal-first-fails',
    group: '先の日誌',
    covers:
      '先の日誌が書けない: remove も正本の削除も器も runner も呼ばず、JournalNotRecordedError（act-not-performed）を投げる。行は変わらない。2 回目も落ちる指定でも 1 回目で止まる。日誌が戻れば次の呼びは外せる',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'none', { journalFailsAt: [1] }),
      w(rm('rust', { base_version: RUST_VERSION }), 'none', {
        journalFailsAt: [1],
        applier: { kind: 'fail', error: '使われない' },
      }),
      w(rm('ghost'), 'none', { journalFailsAt: [1, 2], runners: okRunners(['runner-a']) }),
      w(rm('rust'), 'profile'),
    ],
  },

  // ---- 無い名前 ----
  {
    name: 'remove-missing',
    group: '無い名前を外す',
    covers:
      '無い名前を外す（removed: false）: 日誌は先の行のあとに「無かったので何も変えなかった」（appendJournalOrDrop）。応答は「プロファイルに行 … は無い。何も変えていない。」。正本は何も変わらず、サービスは無い名前でも器・runner へ同じ本文を配り直す。空のプロファイルでも、大文字小文字だけが違う行（別の行として扱う）でも同じ',
    seed: [RUST_SEED],
    steps: [
      w(rm('ghost'), 'journal', { runners: okRunners(['runner-a']) }),
      w(rm('RUST'), 'journal'),
      w(rm('ghost'), 'journal', { applier: { kind: 'absent' } }),
    ],
  },
  {
    name: 'remove-missing-empty',
    group: '無い名前を外す',
    covers:
      'プロファイルが空のとき無い名前を外す: 行は無いまま、日誌だけ足される。default を渡しても同じ',
    steps: [w(rm('ghost'), 'journal'), w(rm('default'), 'journal')],
  },
  {
    name: 'remove-missing-journal-fails',
    group: '無い名前を外す',
    covers:
      '無い名前で、結果の日誌（2 行目）が落ちる: appendJournalOrDrop が握り、応答は通ったときと同じ。先の行だけが残り、stderr に跡が 1 つ',
    seed: [RUST_SEED],
    steps: [w(rm('ghost'), 'journal', { journalFailsAt: [2] })],
  },

  // ---- 外せる ----
  {
    name: 'remove-last-row',
    group: '外せる',
    covers:
      '最後の1行を外す（runner が居ない・居る）: 器へ空が降りる。合成後の指紋は両側とも「（掛かる行なし）」。「撒く先」は出ない（外した行は entries に無い）。日誌は先の行と「外した」。runner が 2 つ居れば配った先が並ぶ',
    seed: [{ name: 'solo', script: 'export S=1\n', scope: 'all' }],
    steps: [w(rm('solo'), 'profile')],
  },
  {
    name: 'remove-last-two-runners',
    group: '外せる',
    covers: '最後の1行を外し、runner が 2 つ居る: 配った先が出た順に並ぶ',
    seed: [{ name: 'solo', script: 'export S=1\n', scope: 'all' }],
    steps: [w(rm('solo'), 'profile', { runners: okRunners(['runner-a', 'runner-b']) })],
  },
  {
    name: 'remove-last-clone-only',
    group: '外せる',
    covers: 'クローンだけの行（scope=app）の最後の1行を外す。runner は居るが空が降りるだけ',
    seed: [{ name: 'solo', script: 'export S=1\n', scope: 'app' }],
    steps: [w(rm('solo'), 'profile', { runners: okRunners(['runner-a']) })],
  },
  {
    name: 'remove-last-runner-only',
    group: '外せる',
    covers: 'runner だけの行（scope=runner）の最後の1行を外す。クローンの器へは空が降りる',
    seed: [{ name: 'solo', script: 'export S=1\n', scope: 'runner' }],
    steps: [w(rm('solo'), 'profile', { runners: okRunners(['runner-a']) })],
  },
  {
    name: 'remove-last-both',
    group: '外せる',
    covers: 'クローンと runner の両方（scope=all）の最後の1行を外す。両方へ空が降りる',
    seed: [{ name: 'solo', script: 'export S=1\n', scope: 'all' }],
    steps: [w(rm('solo'), 'profile', { runners: okRunners(['runner-a']) })],
  },
  {
    name: 'remove-others-remain',
    group: '外せる',
    covers:
      '他の行が残る: 外したのは指定した 1 行だけで、残りの行は変わらない（updatedAt もそのまま）。合成後の指紋は残りの行から出る。scope が違う行が残るとき、掛かる側だけ指紋が出る。名前の形の境目（1 字・数字始まり・. _ - を含む・64 字）も外せる',
    seed: [
      RUST_SEED,
      OTHER_SEED,
      { name: 'app-only', script: 'export A=1\n', scope: 'app' },
      { name: 'a', script: 'export X=1\n' },
      { name: '0lead', script: 'export X=2\n' },
      { name: 'a.b_c-d', script: 'export X=3\n' },
      { name: `b${'.'.repeat(63)}`, script: 'export X=4\n' },
    ],
    steps: [
      w(rm('rust'), 'profile', { runners: okRunners(['runner-a']) }),
      w(rm('other'), 'profile', { runners: okRunners(['runner-a']) }),
      w(rm('a'), 'profile'),
      w(rm('0lead'), 'profile'),
      w(rm('a.b_c-d'), 'profile'),
      w(rm(`b${'.'.repeat(63)}`), 'profile'),
      w(rm('app-only'), 'profile'),
    ],
  },
  {
    name: 'remove-default-name',
    group: '外せる',
    covers:
      'default も他の名前と同じ文言（日誌の「行 default を外した」・応答の「行 default を外した」）。他の行は残る',
    seed: [
      { name: 'default', script: 'export D=1\n' },
      { name: 'zzz', script: 'export Z=1\n' },
    ],
    steps: [w(rm('default'), 'profile')],
  },
  {
    name: 'summary-forms',
    group: '外せる',
    covers:
      'summary は日誌の本文にそのまま入る（検査も切り詰めも無い）: 空文字・改行を含む・長い（600 字）。先の行と結果の行の両方に同じ文が載る。応答には出ない',
    seed: [
      { name: 'a', script: 'export A=1\n' },
      { name: 'b', script: 'export B=1\n' },
      { name: 'c', script: 'export C=1\n' },
    ],
    steps: [
      w(rm('a', { summary: '' }), 'profile'),
      w(rm('b', { summary: '一行目\n二行目' }), 'profile'),
      w(rm('c', { summary: spaced(600, 'summary') }), 'profile'),
    ],
  },

  // ---- base_version ----
  {
    name: 'base-version',
    group: 'base_version',
    covers:
      'base_version: 無い（ifMatch を渡さない）・合っている（{ ifMatch }）・食い違う（「変わっている・作られている」。何も変えず、日誌は先の行と「外せなかった」）・行が無い名前に付ける（「消されている」）・空文字（空文字も渡す。食い違い）・撒く先を変えた後の古い版（版は本文と撒く先から作る）。食い違いは isError ではない',
    seed: [RUST_SEED, OTHER_SEED, { name: 'sc', script: 'export S=1\n', scope: 'app' }],
    steps: [
      w(rm('other'), 'profile'),
      w(rm('rust', { base_version: RUST_VERSION }), 'profile'),
      w(rm('rust', { base_version: RUST_VERSION }), 'journal'),
      w(rm('ghost', { base_version: RUST_VERSION }), 'journal'),
      w(rm('sc', { base_version: '' }), 'journal'),
      w(
        rm('sc', {
          base_version: profileEntryVersionOf({ script: 'export S=1\n', scope: 'all' }),
        }),
        'journal',
      ),
      w(
        rm('sc', {
          base_version: profileEntryVersionOf({ script: 'export S=1\n', scope: 'app' }),
        }),
        'profile',
      ),
    ],
  },
  {
    name: 'base-version-journal-fails',
    group: 'base_version',
    covers:
      '食い違いで、「外せなかった」の日誌（2 行目）も落ちる: 応答は食い違いの文のまま（握る）。先の行だけが残り、stderr に跡',
    seed: [RUST_SEED],
    steps: [w(rm('rust', { base_version: '' }), 'journal', { journalFailsAt: [2] })],
  },

  // ---- remove が投げる ----
  {
    name: 'remove-store-throws',
    group: 'remove が投げる',
    covers:
      '正本の削除が投げる（クローンの器の評価は済んでいる）: サービスは器を discard し前の行へ書き戻して元の例外を投げ、道具は「外せなかった」の行（grounds は例外の名前だけ）を足して素のまま投げ直す。TypeError の message（`params:` を含む）は日誌に入らず、投げ直した例外には入る。書き戻しが落ちても握って元の例外が出る。器が無くても同じ。行は変わらない',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', { storeRemoveThrows: 'error' }),
      w(rm('rust'), 'journal', { storeRemoveThrows: 'typeerror' }),
      w(rm('rust'), 'journal', { storeRemoveThrows: 'error', replaceAllThrows: true }),
      w(rm('rust'), 'journal', { storeRemoveThrows: 'error', applier: { kind: 'absent' } }),
    ],
  },
  {
    name: 'remove-list-throws',
    group: 'remove が投げる',
    covers:
      '正本の一覧（前の版の読み）が最初に落ちる: 器も正本の削除も呼ばれず、素の Error を投げ直す。日誌は先の行と「外せなかった」',
    seed: [RUST_SEED],
    steps: [w(rm('rust'), 'journal', { listFailsAt: [1] })],
  },
  {
    name: 'remove-commit-throws',
    group: 'remove が投げる',
    covers:
      'クローンの器への反映（commit）が落ちる: サービスが正本を前の版へ戻して「正本も元へ戻した」の Error を投げ（cause 付き）、道具は「外せなかった」の行を足して素のまま投げ直す。行は変わらない。runner へは配られない。理由の作りもの値は伏せ字になる',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', {
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        runners: okRunners(['runner-a']),
      }),
      w(rm('rust'), 'journal', {
        applier: { kind: 'commit-throws', message: `器へ移せなかった ${FAKE_ENV_VALUE}` },
      }),
    ],
  },
  {
    name: 'remove-rollback-failed',
    group: 'remove が投げる',
    covers:
      '反映も書き戻しも落ちる（ProfileRollbackFailedError）: 日誌の決定は「削除が途中で止まった（正本は新しい版のまま・クローンは前の版）」で「外せなかった」は出ない。grounds は例外の名前。正本からは行が外れたまま残る（writes は profile）。反映側の理由の値は伏せ字になる',
    seed: [RUST_SEED, OTHER_SEED],
    steps: [
      w(rm('rust'), 'profile', {
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        replaceAllThrows: true,
      }),
      w(rm('other'), 'profile', {
        applier: { kind: 'commit-throws', message: `器へ移せなかった ${FAKE_ENV_VALUE}` },
        replaceAllThrows: true,
      }),
    ],
  },
  {
    name: 'remove-throws-raw',
    group: 'remove が投げる',
    covers:
      '本物のサービスが作れない投げ方（remove の口で差し替え）: 文字列を投げる（grounds は typeof の string）・ProfileInputError を直接投げる（改行を含む理由は reasonOf で 1 行になる。isError ではなく文）。日誌は先の行と「外せなかった」',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', { override: 'throw-string' }),
      w(rm('rust'), 'journal', { override: 'input-error' }),
    ],
  },
  {
    name: 'remove-after-write-failures',
    group: '正本に書いた後の失敗（#6506）',
    covers:
      '正本と器へ反映したあとで、runner の一覧・配布後の一覧が落ちる（Issue #6506）: サービスは握って stored=true で返す（一覧の失敗は runnersUnconfirmed、読み直しの失敗は書いた行を entries にする）。道具は投げず「外した」と報告し、日誌と応答に配布を確かめられなかった旨を足す（一覧の失敗のときだけ）。戻しはしない',
    seed: [RUST_SEED, OTHER_SEED, { name: 'third', script: 'export T=1\n' }],
    steps: [
      w(rm('rust'), 'profile', { runners: 'list-throws' }),
      w(rm('other'), 'profile', { listFailsAt: [2] }),
      w(rm('third'), 'profile', { runners: okRunners(['runner-a']), listFailsAt: [2] }),
    ],
  },

  // ---- 結果の報告 ----
  {
    name: 'runners-partial-fail',
    group: '結果の報告',
    covers:
      '一部の runner の失敗: 配った先（成功した runner）と配れなかった先（失敗した runner の「（理由）」）が両方出る。理由が無い失敗は「理由不明」・setProfile が投げた失敗はその理由（reasonOf）・理由の空白と改行は 1 つの空白にたたむ。外せたことは変わらず日誌は「外した」',
    seed: [RUST_SEED, OTHER_SEED],
    steps: [
      w(rm('rust'), 'profile', {
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
    group: '結果の報告',
    covers:
      '全部の runner が失敗: 「配った先」の行が無く、「配れなかった先」だけ。外せたことは変わらず「更新した」を返す',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'profile', {
        runners: [
          { id: 'runner-1', result: { ok: false, error: '評価が失敗した' } },
          { id: 'runner-2', result: { throws: '接続できない' } },
        ],
      }),
    ],
  },
  {
    name: 'runners-many',
    group: '結果の報告',
    covers:
      '配った先・配れなかった先の抜粋（400 字）: 多数の runner が成功 → 「配った先」が「…（n 文字省略。全 m 文字）」で切れる。多数が失敗 → 「配れなかった先」が切れる。400 字に収まる数ならそのまま',
    seed: [
      { name: 'a', script: 'export A=1\n' },
      { name: 'b', script: 'export B=1\n' },
      { name: 'c', script: 'export C=1\n' },
    ],
    steps: [
      w(rm('a'), 'profile', {
        runners: okRunners(Array.from({ length: 40 }, (_, i) => `runner-${pad2(i + 1)}`)),
      }),
      w(rm('b'), 'profile', {
        runners: okRunners(Array.from({ length: 30 }, (_, i) => `runner-${pad2(i + 1)}`)),
      }),
      w(rm('c'), 'profile', {
        runners: Array.from({ length: 24 }, (_, i) => ({
          id: `runner-${pad2(i + 1)}`,
          result: { ok: false, error: '評価が失敗した' },
        })),
      }),
    ],
  },
  {
    name: 'journal-after-fails',
    group: '結果の報告',
    covers:
      '結果の日誌（2 行目）だけが落ちる: 応答は日誌が通ったときと同じ（握る）で、先の行だけが残り、stderr に跡。外せた形でも、評価で断られた形でも同じ。投げた例外は握り潰さず出る（正本の削除・版の食い違い・巻き戻し失敗）',
    seed: [RUST_SEED, OTHER_SEED],
    steps: [
      w(rm('rust'), 'profile', { journalFailsAt: [2] }),
      w(rm('other'), 'journal', {
        journalFailsAt: [2],
        applier: { kind: 'fail', error: '構文が壊れている' },
      }),
      w(rm('other'), 'journal', { journalFailsAt: [2], storeRemoveThrows: 'error' }),
      w(rm('other', { base_version: '' }), 'journal', { journalFailsAt: [2] }),
      w(rm('other'), 'profile', {
        journalFailsAt: [2],
        applier: { kind: 'commit-throws', message: '器へ移せなかった（test）' },
        replaceAllThrows: true,
      }),
    ],
  },
  {
    name: 'applier-fail',
    group: '結果の報告',
    covers:
      'クローンの器が評価で断った（stored=false。外したあとの本文を器が受け付けない）: 日誌は先の行と「行 名前 を外せなかった（読めなかった）」（grounds は値は記録しない旨）。応答は「実行環境プロファイルの行 名前 を外せなかった（保存も配布もしていない）: 理由」＋ output があれば改行して続ける。理由・output が無ければ「理由不明」。行は変わらず runner へも配られない。isError ではない。外す道具なので「差し替え」「置けなかった」とは書かない（#6506）',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', { applier: { kind: 'fail', error: '構文が壊れている' } }),
      w(rm('rust'), 'journal', {
        applier: {
          kind: 'fail',
          error: 'プロファイルの評価が失敗した（終了コード 2）',
          output: 'line 3: 構文エラー',
        },
        runners: okRunners(['runner-a']),
      }),
      w(rm('rust'), 'journal', { applier: { kind: 'fail' } }),
      w(rm('rust'), 'journal', { applier: { kind: 'fail', output: '理由は無く出力だけ' } }),
    ],
  },
  {
    name: 'applier-fail-redaction',
    group: '伏せ字',
    covers:
      '伏せ字（redactProfileFailure。process.env を読む）: 器の理由・output に作りものの環境変数の値・作りもの代入の値が混じっても伏せ字になる。`params:` 以降は伏せる。器が投げた例外の文も同じ。出力は 4,000 字で切る（前略の印）',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', {
        applier: {
          kind: 'fail',
          error: `評価が失敗した ${FAKE_ENV_VALUE}`,
          output: `+ export ${SECRET_ENV_NAME}=${FAKE_ENV_VALUE}\n構文エラー: ${FAKE_ENV_VALUE} の近く`,
        },
      }),
      w(rm('rust'), 'journal', {
        applier: {
          kind: 'fail',
          error: '評価が失敗した',
          output: '+ export PIN_FAKE_API_TOKEN=' + FAKE_ASSIGN_VALUE + '\nexit 3',
        },
      }),
      w(rm('rust'), 'journal', {
        applier: {
          kind: 'fail',
          error: 'Failed query: insert into "profile" ("script") values ($1)\nparams: 本文の断片',
        },
      }),
      w(rm('rust'), 'journal', {
        applier: { kind: 'prepare-throws', message: `器が落ちた ${FAKE_ENV_VALUE}` },
      }),
      w(rm('rust'), 'journal', {
        applier: { kind: 'fail', error: '評価が失敗した', output: spaced(5_000, 'output') },
      }),
    ],
  },
  {
    name: 'runners-redaction',
    group: '伏せ字',
    covers:
      'runner の失敗の文の伏せ字（サービスが出口で伏せる）: runner が返した error・output と、setProfile が投げた例外の文に作りもの値が混じっても「配れなかった先」には伏せ字で出る（output は出ない）。外せたことは変わらない',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'profile', {
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
    group: '本物のサービスが作れない戻り',
    covers:
      'remove の口の差し替え: entries も composed も無い戻り（「合成後の指紋」が出ない）・entries に他の行だけがある戻り（合成の指紋は出る。runner の失敗は理由不明）。日誌は先の行と「外した」',
    seed: [RUST_SEED],
    steps: [
      w(rm('rust'), 'journal', { override: 'stored-minimal' }),
      w(rm('rust'), 'journal', { override: 'stored-other-entry' }),
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
  /** 場面ごとの出力の字数の一覧（`output.length`） */
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
    storeRemoveThrows: 'none',
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

function describeResult(result: ApplyProfileResult & { removed: boolean }): string {
  const runners = result.runners
    .map((runner) => `${runner.runnerId}:${runner.ok ? 'ok' : 'ng'}`)
    .join(',');
  return `removed=${String(result.removed)} stored=${String(result.stored)} clone.ok=${String(result.clone.ok)} runners=[${runners}] entries=${
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
      const row = await base.profile.set(name, script, scope);
      entry.outcome = 'ok';
      return row;
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
      try {
        if (hooks.storeRemoveThrows === 'error') throw new Error('正本から外せない（test）');
        if (hooks.storeRemoveThrows === 'typeerror') {
          throw new TypeError(
            'Failed query: delete from "profile" where "name" = $1\nparams: PIN_PARAM_MARKER',
          );
        }
        const removed = await base.profile.remove(name);
        entry.outcome = String(removed);
        return removed;
      } catch (error) {
        entry.outcome = `threw ${nameOf(error)}`;
        throw error;
      }
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

/** `context.profile`。`remove` の呼び（渡した引数と結果）を記録する。override のときは本物のサービスを通さず差し替える */
function buildProfile(service: ProfileService, hooks: Hooks, calls: PinnedCall[]): ProfileService {
  return {
    ...service,
    remove: async (name, options) => {
      const entry = record(calls, 'context.profile.remove', {
        name,
        ifMatch: options === undefined ? null : (options.ifMatch ?? null),
        options: options ?? null,
      });
      try {
        let result: ApplyProfileResult & { removed: boolean };
        switch (hooks.override) {
          case 'throw-string':
            // 非 Error を投げる枝を作る
            throw 'raw string failure';
          case 'input-error':
            throw new ProfileInputError('名前の形が不正\n二行目の理由');
          case 'stored-minimal':
            result = { removed: true, stored: true, clone: { ok: true }, runners: [] };
            break;
          case 'stored-other-entry':
            result = {
              removed: true,
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
            result = await service.remove(name, options);
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
      const found = createCloneTools(context).find((entry) => entry.name === 'profile_remove');
      if (!found) throw new Error('profile_remove が無い');

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

describe('profile_remove の出力と呼んだあとの状態の固定（場面ごとの出力の全文・行・日誌の行・呼びの並び）', () => {
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
    const removeCall = (key: string): PinnedCall | undefined =>
      step(key).calls.find((entry) => entry.op === 'context.profile.remove');

    const NO_PROFILE =
      'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。次の会話で外すこと。';
    const BAD_NAME = '行の名前の形が不正（^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$）。何も変えていない。';
    const pre = (name: string): string =>
      `実行環境プロファイルの行 ${name} を外そうとしている: FOO を外した`;
    const done = (name: string): string =>
      `実行環境プロファイルの行 ${name} を外した: FOO を外した`;
    const FAILED = (name: string): string =>
      `実行環境プロファイルの行 ${name} を外せなかった: FOO を外した`;
    const HALF = (name: string): string =>
      `実行環境プロファイルの行 ${name} の削除が途中で止まった（正本は新しい版のまま・クローンは前の版）: FOO を外した`;
    const MISSING = (name: string): string =>
      `実行環境プロファイルの行 ${name} は無かったので何も変えなかった: FOO を外した`;
    const PRE_GROUNDS = '人間から実行環境そのものを渡された（値は記録しない）';
    const TAIL_LINE =
      'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。';
    // 外す道具なので「置けなかった」ではなく「外せなかった」（#6506）
    const cantRemove = (name: string): string =>
      `実行環境プロファイルの行 ${name} を外せなかった（保存も配布もしていない）`;

    // 断り
    for (const key of ['no-profile#1', 'no-profile#2', 'no-profile#3']) {
      expect(text(key)).toBe(NO_PROFILE);
      expect(step(key).calls).toEqual([]);
    }
    for (let i = 1; i <= 10; i += 1) {
      expect(text(`name-invalid#${String(i)}`)).toBe(BAD_NAME);
      expect(step(`name-invalid#${String(i)}`).calls).toEqual([]);
    }

    // 先の日誌
    for (const key of ['journal-first-fails#1', 'journal-first-fails#2', 'journal-first-fails#3']) {
      expect(step(key).output.errorName).toBe('JournalNotRecordedError');
      expect(step(key).output.thrown).toBe(true);
      expect(text(key)).toContain('profile_remove');
      expect(ops(key)).toEqual(['journal.append']);
      expect(step(key).journal).toEqual([]);
    }
    expect(text('journal-first-fails#1')).toContain('理由: Error: 日誌が落ちた');
    expect(ops('journal-first-fails#4')).toContain('context.profile.remove');
    expect(step('journal-first-fails#4').journal).toHaveLength(2);

    // 無い名前
    for (const key of ['remove-missing#1', 'remove-missing#2', 'remove-missing#3']) {
      expect(step(key).output.isError).toBe(false);
      expect(text(key)).toMatch(/^プロファイルに行 \S+ は無い。何も変えていない。$/);
    }
    expect(text('remove-missing#1')).toBe('プロファイルに行 ghost は無い。何も変えていない。');
    expect(text('remove-missing#2')).toBe('プロファイルに行 RUST は無い。何も変えていない。');
    expect(decisions('remove-missing#1')).toEqual([pre('ghost'), MISSING('ghost')]);
    expect(groundsOf('remove-missing#1')).toEqual([
      PRE_GROUNDS,
      '外そうとしたが、その名前の行は置かれていなかった',
    ]);
    expect(removeCall('remove-missing#1')?.args).toMatchObject({ name: 'ghost', ifMatch: null });
    expect(ops('remove-missing#1')).toContain('stores.profile.remove');
    expect(ops('remove-missing#3')).not.toContain('applier.prepare');
    expect(text('remove-missing-empty#1')).toBe(
      'プロファイルに行 ghost は無い。何も変えていない。',
    );
    expect(text('remove-missing-empty#2')).toBe(
      'プロファイルに行 default は無い。何も変えていない。',
    );
    expect(step('remove-missing-journal-fails').output.thrown).toBe(false);
    expect(text('remove-missing-journal-fails')).toBe(
      'プロファイルに行 ghost は無い。何も変えていない。',
    );
    expect(step('remove-missing-journal-fails').journal).toHaveLength(1);
    expect(step('remove-missing-journal-fails').dropped).toHaveLength(1);

    // 外せる
    expect(text('remove-last-clone-only')).toBe(
      [
        '実行環境プロファイルを更新した（行 solo を外した）。',
        '合成後の指紋: クローン用 （掛かる行なし） / runner 用 （掛かる行なし）',
        '配った先: runner-a',
        TAIL_LINE,
      ].join('\n'),
    );
    expect(
      step('remove-last-clone-only').calls.filter((e) => e.op === 'runner.setProfile'),
    ).toMatchObject([{ args: { script: '' } }]);
    expect(step('remove-last-clone-only').profileRows).toEqual([]);
    expect(
      step('remove-last-clone-only').calls.find((e) => e.op === 'applier.prepare')?.args,
    ).toEqual({ script: '' });
    expect(text('remove-last-runner-only')).toContain(
      'クローン用 （掛かる行なし） / runner 用 （掛かる行なし）',
    );
    expect(text('remove-last-both')).toContain('配った先: runner-a');
    expect(text('remove-last-row')).not.toContain('配った先');
    expect(text('remove-last-row')).not.toContain('撒く先');
    expect(text('remove-last-two-runners')).toContain('配った先: runner-a, runner-b');
    expect(decisions('remove-last-row')).toEqual([pre('solo'), done('solo')]);
    expect(groundsOf('remove-last-row')).toEqual([PRE_GROUNDS, PRE_GROUNDS]);
    expect(step('remove-last-row').wrote).toBe('profile');
    expect(text('remove-others-remain#1')).toMatch(
      /クローン用 [0-9a-f]{12} \/ runner 用 [0-9a-f]{12}/,
    );
    expect(step('remove-others-remain#1').profileRows.map((r) => r.name)).not.toContain('rust');
    expect(step('remove-others-remain#1').profileRows).toHaveLength(6);
    expect(step('remove-others-remain#7').profileRows).toHaveLength(0);
    expect(text('remove-others-remain#6')).toContain('行 b');
    expect(text('remove-default-name')).toContain('行 default を外した');
    expect(decisions('remove-default-name')).toEqual([pre('default'), done('default')]);
    expect(decisions('summary-forms#1')).toEqual([
      '実行環境プロファイルの行 a を外そうとしている: ',
      '実行環境プロファイルの行 a を外した: ',
    ]);
    expect(decisions('summary-forms#2')[0]).toBe(
      '実行環境プロファイルの行 b を外そうとしている: 一行目\n二行目',
    );
    expect(decisions('summary-forms#3')[1]?.length).toBe(
      '実行環境プロファイルの行 c を外した: '.length + 600,
    );
    expect(text('summary-forms#3')).not.toContain('summary');

    // base_version
    expect(removeCall('base-version#1')?.args).toMatchObject({ ifMatch: null, options: null });
    expect(removeCall('base-version#2')?.args).toMatchObject({
      ifMatch: RUST_VERSION,
      options: { ifMatch: RUST_VERSION },
    });
    expect(text('base-version#2')).toContain('行 rust を外した');
    expect(text('base-version#3')).toBe(
      'プロファイルの行 rust は読んだ後に消されている（何も変えていない）。profile_read name=rust で読み直し、いまの base_version で判断し直すこと。',
    );
    expect(text('base-version#4')).toContain('読んだ後に消されている');
    expect(text('base-version#5')).toContain(
      '読んだ後に変わっている・作られている（何も変えていない）',
    );
    expect(text('base-version#6')).toContain('読んだ後に変わっている・作られている');
    expect(text('base-version#7')).toContain('行 sc を外した');
    expect(step('base-version#5').output.isError).toBe(false);
    expect(decisions('base-version#5')).toEqual([pre('sc'), FAILED('sc')]);
    expect(groundsOf('base-version#5')[1]).toBe(
      '外そうとしたが、状態の変更が失敗した: ProfileVersionMismatchError',
    );
    expect(step('base-version-journal-fails').output.thrown).toBe(false);
    expect(step('base-version-journal-fails').dropped).toHaveLength(1);
    expect(step('base-version-journal-fails').journal).toHaveLength(1);

    // remove が投げる
    expect(step('remove-store-throws#1').output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: '正本から外せない（test）',
    });
    expect(decisions('remove-store-throws#1')).toEqual([pre('rust'), FAILED('rust')]);
    expect(groundsOf('remove-store-throws#1')[1]).toBe(
      '外そうとしたが、状態の変更が失敗した: Error',
    );
    expect(groundsOf('remove-store-throws#2')[1]).toBe(
      '外そうとしたが、状態の変更が失敗した: TypeError',
    );
    expect(text('remove-store-throws#2')).toContain('params: PIN_PARAM_MARKER');
    expect(JSON.stringify(step('remove-store-throws#2').journal)).not.toContain('PIN_PARAM_MARKER');
    expect(ops('remove-store-throws#1')).toEqual([
      'journal.append',
      'context.profile.remove',
      'stores.profile.list',
      'applier.prepare',
      'stores.profile.remove',
      'applier.discard',
      'stores.profile.replaceAll',
      'journal.append',
    ]);
    expect(ops('remove-store-throws#3')).toContain('stores.profile.replaceAll');
    expect(step('remove-store-throws#4').calls.some((e) => e.op.startsWith('applier.'))).toBe(
      false,
    );
    expect(ops('remove-list-throws')).toEqual([
      'journal.append',
      'context.profile.remove',
      'stores.profile.list',
      'journal.append',
    ]);
    expect(text('remove-commit-throws#1')).toContain(
      'プロファイルをクローンへ反映できなかったので、正本も元へ戻した: ',
    );
    expect(ops('remove-commit-throws#1')).not.toContain('runner.setProfile');
    expect(decisions('remove-commit-throws#1')[1]).toBe(FAILED('rust'));
    expect(text('remove-commit-throws#2')).not.toContain(FAKE_ENV_VALUE);
    expect(step('remove-rollback-failed#1').output.errorName).toBe('ProfileRollbackFailedError');
    expect(decisions('remove-rollback-failed#1')[1]).toBe(HALF('rust'));
    expect(decisions('remove-rollback-failed#2')[1]).toBe(HALF('other'));
    expect(groundsOf('remove-rollback-failed#1')[1]).toBe(
      '外そうとしたが、状態の変更が失敗した: ProfileRollbackFailedError',
    );
    expect(decisions('remove-rollback-failed#1').join('')).not.toContain('外せなかった');
    expect(step('remove-rollback-failed#1').wrote).toBe('profile');
    expect(step('remove-throws-raw#1').output).toMatchObject({
      thrown: true,
      errorName: 'string',
      text: 'raw string failure',
    });
    expect(groundsOf('remove-throws-raw#1')[1]).toBe(
      '外そうとしたが、状態の変更が失敗した: string',
    );
    expect(step('remove-throws-raw#2').output.thrown).toBe(false);
    expect(text('remove-throws-raw#2')).toBe(
      'プロファイルの行を置けなかった（何も変えていない）: ProfileInputError: 名前の形が不正',
    );

    // 正本に書いた後の失敗（#6506 の修正後）: 書けた側を正にして、投げずに置けたと報告する。戻しもしない
    for (const key of [
      'remove-after-write-failures#1',
      'remove-after-write-failures#2',
      'remove-after-write-failures#3',
    ]) {
      expect(step(key).wrote, key).toBe('profile');
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).output.isError, key).toBe(false);
      expect(decisions(key)[1], key).not.toContain('外せなかった');
      expect(ops(key), key).toContain('stores.profile.remove');
      expect(ops(key), key).toContain('applier.commit');
      expect(ops(key), key).not.toContain('applier.discard');
      expect(ops(key), key).not.toContain('stores.profile.replaceAll');
    }
    expect(decisions('remove-after-write-failures#1')).toEqual([
      pre('rust'),
      '実行環境プロファイルの行 rust を外した（runner への配布は確かめられなかった）: FOO を外した',
    ]);
    expect(groundsOf('remove-after-write-failures#1')[1]).toBe(
      `${PRE_GROUNDS}。runner の一覧を読めず、配布を確かめられなかった: Error: runner の一覧が取れない（test）`,
    );
    expect(text('remove-after-write-failures#1')).toContain(
      'runner への配布を確かめられなかった（runner の一覧を読めない）: Error: runner の一覧が取れない（test）',
    );
    expect(decisions('remove-after-write-failures#2')).toEqual([pre('other'), done('other')]);
    expect(text('remove-after-write-failures#2')).toContain('合成後の指紋');
    expect(text('remove-after-write-failures#2')).not.toContain('確かめられなかった');
    expect(decisions('remove-after-write-failures#3')).toEqual([pre('third'), done('third')]);
    expect(text('remove-after-write-failures#3')).toContain('配った先: runner-a');
    expect(step('remove-after-write-failures#1').profileRows.map((r) => r.name)).toEqual([
      'other',
      'third',
    ]);

    // 結果の報告
    expect(text('runners-partial-fail')).toContain('配った先: runner-1, runner-6');
    expect(text('runners-partial-fail')).toContain('runner-3（理由不明）');
    expect(text('runners-partial-fail')).toContain('runner-4（Error: ネットワークが切れた）');
    expect(text('runners-partial-fail')).toContain('runner-5（一行目 二行目）');
    expect(text('runners-partial-fail')).not.toContain('出力は出ない');
    expect(decisions('runners-partial-fail')[1]).toBe(done('rust'));
    expect(text('runners-all-fail')).not.toContain('配った先');
    expect(text('runners-all-fail')).toContain(
      '配れなかった先: runner-1（評価が失敗した）, runner-2（Error: 接続できない）',
    );
    expect(text('runners-many#1')).toMatch(/配った先: .*…（\d+ 文字省略。全 \d+ 文字）/);
    expect(text('runners-many#2')).not.toMatch(/配った先: .*省略/);
    expect(text('runners-many#3')).toMatch(/配れなかった先: .*…（\d+ 文字省略。全 \d+ 文字）/);
    expect(step('journal-after-fails#1').output.thrown).toBe(false);
    expect(text('journal-after-fails#1')).toContain('行 rust を外した');
    expect(text('journal-after-fails#2')).toContain(cantRemove('other'));
    expect(step('journal-after-fails#3').output.thrown).toBe(true);
    expect(step('journal-after-fails#4').output.thrown).toBe(false);
    expect(step('journal-after-fails#5').output.errorName).toBe('ProfileRollbackFailedError');
    for (let i = 1; i <= 5; i += 1) {
      const key = `journal-after-fails#${String(i)}`;
      expect(step(key).journal, key).toHaveLength(1);
      expect(step(key).dropped, key).toHaveLength(1);
    }
    expect(text('applier-fail#1')).toBe(`${cantRemove('rust')}: 構文が壊れている`);
    expect(text('applier-fail#2')).toBe(
      `${cantRemove('rust')}: プロファイルの評価が失敗した（終了コード 2）\nline 3: 構文エラー`,
    );
    expect(text('applier-fail#3')).toBe(`${cantRemove('rust')}: 理由不明`);
    expect(text('applier-fail#4')).toBe(`${cantRemove('rust')}: 理由不明\n理由は無く出力だけ`);
    // 外す道具なので「差し替え」と書かない（#6506）
    expect(decisions('applier-fail#1')).toEqual([
      pre('rust'),
      '実行環境プロファイルの行 rust を外せなかった（読めなかった）: FOO を外した',
    ]);
    expect(groundsOf('applier-fail#1')[1]).toBe(
      '人間から実行環境そのものを渡されたが、評価で断られた（値は記録しない）',
    );
    expect(ops('applier-fail#2')).not.toContain('runners.list');
    expect(ops('applier-fail#2')).toContain('applier.discard');
    expect(ops('applier-fail#2')).not.toContain('stores.profile.remove');
    expect(step('applier-fail#1').output.isError).toBe(false);

    // 伏せ字
    for (let i = 1; i <= 5; i += 1) {
      expect(text(`applier-fail-redaction#${String(i)}`)).toContain(cantRemove('rust'));
    }
    expect(text('applier-fail-redaction#1')).toContain('[REDACTED]');
    expect(text('applier-fail-redaction#2')).toContain('PIN_FAKE_API_TOKEN=[REDACTED]');
    expect(text('applier-fail-redaction#3')).toContain('params: [REDACTED]');
    expect(text('applier-fail-redaction#3')).not.toContain('本文の断片');
    expect(text('applier-fail-redaction#4')).toContain('Error: 器が落ちた [REDACTED]');
    expect(text('applier-fail-redaction#5')).toContain('…（前略）\n');
    expect(text('runners-redaction')).toContain('runner-1（評価が失敗した [REDACTED]）');
    expect(text('runners-redaction')).toContain('runner-2（Error: 接続できない [REDACTED]）');
    expect(text('runners-redaction')).toContain('runner-3（PIN_FAKE_API_TOKEN=[REDACTED]）');
    expect(text('runners-redaction')).toContain('配った先: runner-4');

    // 本物のサービスが作れない戻り
    expect(text('return-minimal#1')).toBe(
      `実行環境プロファイルを更新した（行 rust を外した）。\n${TAIL_LINE}`,
    );
    expect(text('return-minimal#2')).toContain(
      '合成後の指紋: クローン用 abcdef012345 / runner 用 （掛かる行なし）',
    );
    expect(text('return-minimal#2')).toContain('配った先: runner-x');
    expect(text('return-minimal#2')).toContain('配れなかった先: runner-y（理由不明）');
    expect(text('return-minimal#2')).not.toContain('撒く先');
  });
});
