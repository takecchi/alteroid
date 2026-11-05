import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `archive_remove` の出力（全文と字数）と、呼んだあとの状態（アーカイブの行・日誌へ足された行）・ストアへの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-archive-remove-output-pin.json）と丸ごと比べる。
// `clone-tools-ops.ts` の `tool('archive_remove', …)`（約 68 行・summary 検査 → guard の4通り → 日誌が先の削除 → 戻りごとの文の長い式）を
// 小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・session id・本文・時刻）を固定して毎回同じにする。
// この道具はアーカイブの本文を消す（tombstone。行そのものは残る）ので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。例外の文言は JournalNotRecordedError なら
//     「見出し（⚠⚠ …）」と「本文（tool 名・エントリの見分け・理由）」の2段に分かれる。全文をそのまま固定する
//   - archives: 呼んだあとのアーカイブの全行（`stores.archive.list()` の形のまま。消された行は removedAt / removedBytes が付いて storedBytes が 0 になる）
//   - journal: 呼んだあとに日誌へ足された行（先の行・後の行・打ち消しの行・「確かめられていない」行。種類・本文・grounds・id・at をそのまま）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: ストアへの呼びの並び（managers.runningManagerOwning・archive.list/read/remove・journal.append。引数と結果・失敗付き）
//   - wrote: アーカイブか日誌のどちらかが呼ぶ前から変わったか。断った場面は false で、アーカイブ・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_ARCHIVE_REMOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-archive-remove-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-archive-remove-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、アーカイブ・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// アーカイブの行は場面の頭に `stores.archive.archive()` で、基準の 2026-10-01 から分単位の時刻に時計を置いて積む
// （行の id は `<sessionId>-<時刻>.jsonl` なので毎回同じ）。呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（アーカイブか日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

/** 走行中のマネージャーの配線: 誰も使っていない / `runningManagerOwning` だけ / `runningManagerPinning` も持つ / `managers` が配線されていない */
type ManagersMode = 'idle' | 'owning' | 'pinning' | 'unwired';

interface SeedRow {
  /** 場面の中で行を指す名前 */
  label: string;
  session: string;
  /** 積む時刻（基準の 2026-10-01 から何分後か） */
  minute: number;
  body: string;
  /** 積んだあとに tombstone する（時刻は積んだ分と同じ） */
  removed?: boolean;
  /** `runningManagerOwning` が走行中のマネージャーを返す */
  owned?: boolean;
  /** `runningManagerPinning` が走行中のマネージャーを返す（`pinning` の配線のときだけ配線される。道具は第4引数を渡さないので効かない） */
  pinned?: boolean;
}

/** 呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** `journal.append` の何回目（この呼びの中・1 から。後の行・打ち消しの行も数える）を投げさせるか */
  journalFailsAt: number[];
  /** `archive.remove` が投げる */
  removeFails: boolean;
}

type IdOf = (label: string) => string;

interface Step {
  args: (idOf: IdOf) => Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedRow[];
  steps: Step[];
  managers?: ManagersMode;
  /** アーカイブに無い id を、走行中のマネージャーが使っていることにする */
  ghostOwned?: string[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const ROW_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const PIN_URL = new URL('./clone-tools-archive-remove-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_ARCHIVE_REMOVE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteMs(minute: number): number {
  return ROW_BASE + minute * 60_000;
}

function row(
  label: string,
  session: string,
  minute: number,
  body: string,
  extra: Partial<SeedRow> = {},
): SeedRow {
  return { label, session, minute, body, ...extra };
}

/** 行（label）を指す呼び。要約は既定の「片付けた」 */
function on(label: string, extra: Args = {}): (idOf: IdOf) => Args {
  return (idOf) => ({ archiveId: idOf(label), summary: '片付けた', ...extra });
}

/** 行に無い id（文字列そのまま）を指す呼び */
function lit(archiveId: string, extra: Args = {}): (idOf: IdOf) => Args {
  return () => ({ archiveId, summary: '片付けた', ...extra });
}

const GHOST = '居ない-2026-10-01T00-00-00-000Z.jsonl';
const LONG_SUMMARY = `長い要約。${'あ'.repeat(1_999)}`;
const LONG_ID = `${'長い'.repeat(150)}.jsonl`;

const SCENARIOS: Scenario[] = [
  // ---- summary の検査（guard より前に断る） ----
  {
    name: 'summary-errors',
    covers:
      'summary が空・空白だけ（半角・タブと改行・全角）は、guard・日誌・消す、のどれよりも前に断る。走行中の行・override つき・存在しない id でも同じ（managers.runningManagerOwning も呼ばない）。長さの検査が先で空白の検査が後',
    seed: [row('r1', 'sess-a', 1, 'BODY\n', { owned: true })],
    managers: 'owning',
    steps: [
      { args: on('r1', { summary: '' }), writes: 'none' },
      { args: on('r1', { summary: ' ' }), writes: 'none' },
      { args: on('r1', { summary: '   ' }), writes: 'none' },
      { args: on('r1', { summary: '\t\n' }), writes: 'none' },
      { args: on('r1', { summary: '　' }), writes: 'none' },
      { args: on('r1', { summary: '\u0000' }), writes: 'none' },
      { args: on('r1', { summary: '', overrideReason: '理由はある' }), writes: 'none' },
      { args: lit(GHOST, { summary: '  ' }), writes: 'none' },
    ],
  },
  // ---- guard: unknown ----
  {
    name: 'guard-unknown',
    covers:
      'managers が配線されていない内部ターン: 安全側に倒して拒む（unknown）。override の理由を渡しても同じ・存在しない id でも同じ・前から消された行でも同じ。何も書かない。summary の検査は guard より先',
    seed: [row('r1', 'sess-a', 1, 'BODY\n'), row('r2', 'sess-a', 2, 'BODY2\n', { removed: true })],
    managers: 'unwired',
    steps: [
      { args: on('r1'), writes: 'none' },
      { args: on('r1', { overrideReason: '内部ターンでも消したい' }), writes: 'none' },
      { args: lit(GHOST), writes: 'none' },
      { args: on('r2'), writes: 'none' },
      { args: on('r1', { summary: '  ' }), writes: 'none' },
    ],
  },
  // ---- guard: denied ----
  {
    name: 'guard-denied',
    covers:
      '走行中のマネージャーの退避は既定で拒む（denied。managerId を名指す）。overrideReason が省略・undefined・空・空白だけ（半角・全角・改行）でも拒む。前から消された走行中の行も拒む（already ではなく denied が先）。走行中でない存在しない id は通って missing（日誌に先の行と打ち消しの行）。走行中でない行は理由が空白だけでも通る（override の注は付かない）',
    seed: [
      row('r1', 'sess-run', 1, 'BODY\n', { owned: true }),
      row('r2', 'sess-idle', 2, 'BODY2\n'),
      row('r3', 'sess-run-removed', 3, 'BODY3\n', { owned: true, removed: true }),
    ],
    managers: 'owning',
    steps: [
      { args: on('r1'), writes: 'none' },
      { args: on('r1', { overrideReason: undefined }), writes: 'none' },
      { args: on('r1', { overrideReason: '' }), writes: 'none' },
      { args: on('r1', { overrideReason: '   ' }), writes: 'none' },
      { args: on('r1', { overrideReason: '　\n\t' }), writes: 'none' },
      { args: on('r3'), writes: 'none' },
      { args: lit(GHOST), writes: 'some' },
      { args: on('r2', { overrideReason: '  ' }), writes: 'some' },
    ],
  },
  // ---- guard: allowed-with-override ----
  {
    name: 'guard-override',
    covers:
      '走行中の行を overrideReason つきで消す（allowed-with-override）: 先の行の decision 末尾に override の注・grounds は「要約／注」・出力の末尾にも注。理由は trim して載る。前から消された行は出力に注が付かない（日誌の先の行・後の行には付く）。存在しない id は missing（先の行に注が付き、打ち消しの行が足される）',
    seed: [
      row('r1', 'sess-run', 1, 'BODY\n', { owned: true }),
      row('r2', 'sess-run-removed', 2, 'BODY2\n', { owned: true, removed: true }),
      row('r3', 'sess-run-trim', 3, 'BODY3\n', { owned: true }),
    ],
    ghostOwned: [GHOST],
    managers: 'owning',
    steps: [
      { args: on('r1', { overrideReason: '本番の都合' }), writes: 'some' },
      { args: on('r1', { overrideReason: '本番の都合' }), writes: 'some' },
      { args: on('r2', { overrideReason: '前から消えている' }), writes: 'some' },
      { args: lit(GHOST, { overrideReason: '居ない行を指した' }), writes: 'some' },
      {
        args: on('r3', { summary: '要約／に／スラッシュ', overrideReason: '  前後に空白  ' }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'guard-override-journal-fails',
    covers:
      'override で消すときに日誌が落ちる: 先の行が落ちれば何も消さず JournalNotRecordedError（act-not-performed。エントリの見分けは decision）。後の行だけ落ちれば応答は普通に返り（override の注つき）、先の行だけが残る',
    seed: [
      row('r1', 'sess-run', 1, 'BODY\n', { owned: true }),
      row('r2', 'sess-run-2', 2, 'BODY2\n', { owned: true }),
    ],
    managers: 'owning',
    steps: [
      {
        args: on('r1', { overrideReason: '先の日誌が落ちる' }),
        writes: 'none',
        hooks: { journalFailsAt: [1] },
      },
      {
        args: on('r1', { overrideReason: '後の日誌が落ちる' }),
        writes: 'some',
        hooks: { journalFailsAt: [2] },
      },
      { args: on('r2', { overrideReason: '戻った' }), writes: 'some' },
    ],
  },
  {
    name: 'guard-pinning-ignored',
    covers:
      'runningManagerPinning を持つ配線でも、この道具は第4引数（requireContainment）を渡さないので runningManagerOwning で判定する: owned だけの行は拒み、pinned だけの行は通る（runningManagerPinning は呼ばれない）',
    seed: [
      row('r1', 'sess-own', 1, 'BODY\n', { owned: true }),
      row('r2', 'sess-pin', 2, 'BODY2\n', { pinned: true }),
      row('r3', 'sess-both', 3, 'BODY3\n', { owned: true, pinned: true }),
    ],
    managers: 'pinning',
    steps: [
      { args: on('r1'), writes: 'none' },
      { args: on('r2'), writes: 'some' },
      { args: on('r3'), writes: 'none' },
      { args: on('r3', { overrideReason: '両方に使われている' }), writes: 'some' },
    ],
  },
  // ---- 通る（allowed）----
  {
    name: 'remove-basic',
    covers:
      '消せる（removed）: 先の行（decision・grounds=要約）と後の行（バイト数・「いま消した」）が日誌に1行ずつ・行は残る（storedBytes 0・removedAt・removedBytes）。続けて呼ぶと前から消されている（already）で先の行と後の行（「前から消されていたので今回は何も変わっていない」）が足される。走行中でない行に overrideReason を渡しても注は付かない（理由は無視される）。idle の配線',
    seed: [
      row('r1', 'sess-a', 1, 'BODY\n'),
      row('r2', 'sess-b', 2, 'こんにちは\n'),
      row('r3', 'sess-c', 3, 'BODY3\n'),
    ],
    managers: 'idle',
    steps: [
      { args: on('r1', { summary: 'もう要らないので消した' }), writes: 'some' },
      { args: on('r1', { summary: '2回目' }), writes: 'some' },
      { args: on('r2', { summary: '別の行' }), writes: 'some' },
      { args: on('r3', { overrideReason: '走行中ではないが理由を渡した' }), writes: 'some' },
    ],
  },
  {
    name: 'managers-omitted',
    covers:
      'ToolContext に managers を入れない（unwired）場面と、managers があって誰も走行中でない（idle）場面の違い: 配線なしは拒み、idle は通る',
    seed: [row('r1', 'sess-a', 1, 'BODY\n')],
    managers: 'unwired',
    steps: [{ args: on('r1'), writes: 'none' }],
  },
  // ---- missing ----
  {
    name: 'missing',
    covers:
      '存在しない id: 先の行を書いてから消そうとして missing になり、先の行は残したまま「効いていない（消していない）」の打ち消しの行を足す（先の行そのものは消さない）。応答は「存在しない」。続けて呼ぶと先の行と打ち消しの行がもう1組。override・走行中の配線でない idle',
    seed: [row('r1', 'sess-a', 1, 'BODY\n')],
    managers: 'idle',
    steps: [
      { args: lit(GHOST), writes: 'some' },
      { args: lit(GHOST), writes: 'some' },
      { args: lit(GHOST, { overrideReason: '走行中ではない id に理由を渡した' }), writes: 'some' },
    ],
  },
  {
    name: 'missing-journal-fails',
    covers:
      '存在しない id で日誌が落ちる: 先の行が落ちれば JournalNotRecordedError（remove は呼ばない）。打ち消しの行だけ落ちれば応答は普通に「存在しない」で、先の行だけが残る（stderr に跡）',
    seed: [row('r1', 'sess-a', 1, 'BODY\n')],
    steps: [
      { args: lit(GHOST), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: lit(GHOST), writes: 'some', hooks: { journalFailsAt: [2] } },
      { args: lit(GHOST), writes: 'none', hooks: { journalFailsAt: [1, 2] } },
    ],
  },
  {
    name: 'id-forms',
    covers:
      'archiveId の形（空文字・空白だけ・前後に空白・パスらしい文字・日本語・長い id）はどれも存在しない id として missing になり、先の行の decision に id がそのまま載る（検査は無い）。ストアの remove へ渡る id もそのまま',
    seed: [row('r1', 'sess-a', 1, 'BODY\n')],
    steps: [
      { args: lit(''), writes: 'some' },
      { args: lit('   '), writes: 'some' },
      { args: lit('  sess-a-2026-10-01T00-01-00-000Z.jsonl '), writes: 'some' },
      { args: lit('../etc/passwd'), writes: 'some' },
      { args: lit('あ.jsonl'), writes: 'some' },
      { args: lit(LONG_ID), writes: 'some' },
    ],
  },
  // ---- already ----
  {
    name: 'already',
    covers:
      '前から消されていた行（already）: 出力に消した時刻とバイト数（ja-JP の区切り）・単位の注・「何も変わっていない」。先の行と後の行は足される（後の行は「前から消されていた」）。アーカイブの行は変わらない（removedAt は最初に消した時刻のまま）',
    seed: [
      row('r1', 'sess-a', 1, 'BODY\n', { removed: true }),
      row('r2', 'sess-b', 2, 'a'.repeat(1_234), { removed: true }),
    ],
    steps: [
      { args: on('r1'), writes: 'some' },
      { args: on('r2'), writes: 'some' },
      { args: on('r1'), writes: 'some' },
    ],
  },
  {
    name: 'already-journal-fails',
    covers:
      '前から消されていた行で日誌が落ちる: 先の行が落ちれば JournalNotRecordedError（行為は起きていない）。後の行だけ落ちれば応答は「前から消されている」のまま、先の行だけが残る',
    seed: [row('r1', 'sess-a', 1, 'BODY\n', { removed: true })],
    steps: [
      { args: on('r1'), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: on('r1'), writes: 'some', hooks: { journalFailsAt: [2] } },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-first-fails',
    covers:
      '先の日誌が書けない: archive.remove を呼ばず（呼びの並びに無い）、JournalNotRecordedError（act-not-performed）を投げる。行はそのまま残る。次の呼びで日誌が戻れば消える。複数回落ちる指定でも1回目で止まる',
    seed: [row('r1', 'sess-a', 1, 'BODY\n'), row('r2', 'sess-b', 2, 'BODY2\n')],
    steps: [
      { args: on('r1'), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: on('r1'), writes: 'some' },
      { args: on('r2'), writes: 'none', hooks: { journalFailsAt: [1, 2] } },
      { args: on('r2'), writes: 'some' },
    ],
  },
  {
    name: 'after-journal-fails',
    covers:
      '後の日誌だけが書けない: 消した後なので応答は普通に返り（握る・stderr に跡）、日誌に残るのは先の行だけ（バイト数の行が無い）。続けて呼ぶと前から消されている（先の行と後の行が足される）',
    seed: [row('r1', 'sess-a', 1, 'BODY\n'), row('r2', 'sess-b', 2, 'BODY2\n')],
    steps: [
      { args: on('r1'), writes: 'some', hooks: { journalFailsAt: [2] } },
      { args: on('r1'), writes: 'some' },
      { args: on('r2'), writes: 'some', hooks: { journalFailsAt: [2, 3] } },
    ],
  },
  // ---- 消す側が落ちる ----
  {
    name: 'remove-throws',
    covers:
      'archive.remove が投げる: 先の行のあとに「結果は確かめられていない」の補いの行を足し、元の例外をそのまま投げる（JournalNotRecordedError ではない）。補いの行も落ちれば先の行だけが残り、元の例外が出る（stderr に跡）。直したあとの呼びは消える',
    seed: [row('r1', 'sess-a', 1, 'BODY\n'), row('r2', 'sess-b', 2, 'BODY2\n')],
    steps: [
      { args: on('r1'), writes: 'some', hooks: { removeFails: true } },
      { args: on('r2'), writes: 'some', hooks: { removeFails: true, journalFailsAt: [2] } },
      { args: on('r1'), writes: 'some' },
    ],
  },
  // ---- バイト数の表示 ----
  {
    name: 'bytes-format',
    covers:
      '出力のバイト数は toLocaleString("ja-JP")（千の位に区切り）・日誌の後の行は区切りなしの素の数字。本文の大きさ: 0・1・999（333 字の日本語）・1,000・1,002・4 バイト文字・1,234,567。前から消された行（already）の出力も同じ区切り',
    seed: [
      row('b0', 'sess-b0', 1, ''),
      row('b1', 'sess-b1', 2, 'x'),
      row('b999', 'sess-b999', 3, 'あ'.repeat(333)),
      row('b1000', 'sess-b1000', 4, 'a'.repeat(1_000)),
      row('b1002', 'sess-b1002', 5, 'あ'.repeat(334)),
      row('b12', 'sess-b12', 6, '😀'.repeat(3)),
      row('bbig', 'sess-bbig', 7, 'a'.repeat(1_234_567)),
    ],
    steps: [
      { args: on('b0'), writes: 'some' },
      { args: on('b1'), writes: 'some' },
      { args: on('b999'), writes: 'some' },
      { args: on('b1000'), writes: 'some' },
      { args: on('b1002'), writes: 'some' },
      { args: on('b12'), writes: 'some' },
      { args: on('bbig'), writes: 'some' },
      { args: on('bbig'), writes: 'some' },
      { args: on('b1000'), writes: 'some' },
    ],
  },
  // ---- 要約の形 ----
  {
    name: 'summary-forms',
    covers:
      '要約の形: 改行を含む・前後に空白（trim しない）・長い要約（上限は無い）・記号・1文字・NUL を含む（NUL は日誌で落ちる）。要約は先の行の decision と grounds にそのまま載り、出力には載らない',
    seed: [
      row('r1', 'sess-a', 1, 'BODY\n'),
      row('r2', 'sess-b', 2, 'BODY\n'),
      row('r3', 'sess-c', 3, 'BODY\n'),
      row('r4', 'sess-d', 4, 'BODY\n'),
      row('r5', 'sess-e', 5, 'BODY\n'),
      row('r6', 'sess-f', 6, 'BODY\n'),
    ],
    steps: [
      { args: on('r1', { summary: '一行目\n二行目' }), writes: 'some' },
      { args: on('r2', { summary: '  前後に空白  ' }), writes: 'some' },
      { args: on('r3', { summary: LONG_SUMMARY }), writes: 'some' },
      { args: on('r4', { summary: '**強調** `code` [x](y)' }), writes: 'some' },
      { args: on('r5', { summary: 'あ' }), writes: 'some' },
      { args: on('r6', { summary: '前\u0000後' }), writes: 'some' },
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
  /** 例外で返ったときの名前（例外でなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとのアーカイブの全行（`archive.list()` のまま） */
  archives: Record<string, unknown>[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 日誌の書き損じを握ったときに stderr へ残った跡 */
  dropped: string[];
  /** ストアへの呼びの並び */
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
  archives: Record<string, unknown>[];
  journal: Record<string, unknown>[];
}

async function snapshot(base: Stores): Promise<Snapshot> {
  return {
    archives: plain(await base.archive.list()) as unknown as Record<string, unknown>[],
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function failureOf(error: unknown): string {
  return `threw ${error instanceof Error ? error.constructor.name : typeof error}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

/** ストアへの呼びだけを `calls` へ記録し、口（hooks）で失敗を起こす */
function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  return {
    ...base,
    archive: {
      ...base.archive,
      list: async () => {
        const result = await base.archive.list();
        calls.push({ op: 'archive.list', args: {}, outcome: `${String(result.length)} rows` });
        return result;
      },
      read: async (id) => {
        const result = await base.archive.read(id);
        calls.push({ op: 'archive.read', args: { id }, outcome: result.kind });
        return result;
      },
      remove: async (id) => {
        try {
          if (hooks.removeFails) throw new Error('アーカイブの削除が落ちた');
          const result = await base.archive.remove(id);
          calls.push({ op: 'archive.remove', args: { id }, outcome: JSON.stringify(result) });
          return result;
        } catch (error) {
          calls.push({ op: 'archive.remove', args: { id }, outcome: failureOf(error) });
          throw error;
        }
      },
    },
    journal: {
      ...base.journal,
      append: async (entry) => {
        const journalCalls = calls.filter((c) => c.op === 'journal.append').length + 1;
        const args = plain(entry);
        if (hooks.journalFailsAt.includes(journalCalls)) {
          calls.push({ op: 'journal.append', args, outcome: 'threw Error: 日誌が落ちた' });
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(entry);
        calls.push({ op: 'journal.append', args, outcome: `ok ${written.id}` });
        return written;
      },
    },
  };
}

function freshHooks(): Hooks {
  return { journalFailsAt: [], removeFails: false };
}

async function seedRows(
  base: Stores,
  scenario: Scenario,
): Promise<{ ids: Map<string, string>; owned: Set<string>; pinned: Set<string> }> {
  const ids = new Map<string, string>();
  const owned = new Set<string>(scenario.ghostOwned ?? []);
  const pinned = new Set<string>();
  for (const seed of scenario.seed) {
    vi.setSystemTime(new Date(minuteMs(seed.minute)));
    const id = (await base.archive.archive(seed.session, seed.body)).id;
    ids.set(seed.label, id);
    if (seed.removed) await base.archive.remove(id);
    if (seed.owned) owned.add(id);
    if (seed.pinned) pinned.add(id);
  }
  return { ids, owned, pinned };
}

function buildManagers(
  mode: ManagersMode,
  owned: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
  calls: PinnedCall[],
): ManagerPool | undefined {
  const owning = (id: string): string | undefined => {
    const managerId = owned.has(id) ? 'mgr-running' : undefined;
    calls.push({
      op: 'managers.runningManagerOwning',
      args: { id },
      outcome: managerId ?? 'undefined',
    });
    return managerId;
  };
  switch (mode) {
    case 'unwired':
      return undefined;
    case 'idle':
      return {
        runningManagerOwning: (id: string) => {
          calls.push({ op: 'managers.runningManagerOwning', args: { id }, outcome: 'undefined' });
          return undefined;
        },
      } as unknown as ManagerPool;
    case 'owning':
      return { runningManagerOwning: owning } as unknown as ManagerPool;
    case 'pinning':
      return {
        runningManagerOwning: owning,
        runningManagerPinning: (id: string) => {
          const managerId = pinned.has(id) ? 'mgr-running' : undefined;
          calls.push({
            op: 'managers.runningManagerPinning',
            args: { id },
            outcome: managerId ?? 'undefined',
          });
          return managerId;
        },
      } as unknown as ManagerPool;
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  const seeded = await seedRows(base, scenario);
  const idOf: IdOf = (label) => {
    const id = seeded.ids.get(label);
    if (id === undefined) throw new Error(`場面 ${scenario.name}: 行 ${label} が無い`);
    return id;
  };
  const hooks = freshHooks();
  const calls: PinnedCall[] = [];
  const dropped: string[] = [];
  setStderrSinkForTesting((line) => {
    dropped.push(line);
  });
  const stores = withHooks(base, hooks, calls);
  const managers = buildManagers(scenario.managers ?? 'idle', seeded.owned, seeded.pinned, calls);
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === undefined ? {} : { managers }),
  };
  const found = createCloneTools(context).find((entry) => entry.name === 'archive_remove');
  if (!found) throw new Error('archive_remove が無い');

  const results: PinnedStep[] = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      Object.assign(hooks, freshHooks(), step.hooks ?? {});
      calls.length = 0;
      dropped.length = 0;
      const before = await snapshot(base);
      vi.setSystemTime(new Date(callTime(index)));
      let output: PinnedOutput;
      try {
        const result = await found.handler(step.args(idOf) as never, {} as never);
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
          errorName: error instanceof Error ? error.constructor.name : typeof error,
        };
      }
      Object.assign(hooks, freshHooks());
      const after = await snapshot(base);
      const wrote =
        JSON.stringify(before.archives) !== JSON.stringify(after.archives) ||
        before.journal.length !== after.journal.length;
      results.push({
        output,
        wrote,
        archives: after.archives,
        journal: after.journal.slice(before.journal.length),
        dropped: [...dropped],
        calls: plain(calls),
      });
      if (step.writes === 'none') {
        // 書き込みが起きなかった呼びは、アーカイブ・日誌が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
        expect(
          after.archives,
          `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、アーカイブが呼ぶ前から変わった`,
        ).toEqual(before.archives);
        expect(
          after.journal.length,
          `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
        ).toBe(before.journal.length);
      }
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

describe('archive_remove の出力と呼んだあとの状態の固定（場面ごとの出力の全文・アーカイブの行・日誌の行・ストアの呼び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

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
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
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

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some',
        );
      }
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

      it(`${key} の呼んだあとのアーカイブの行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.archives.map((entry) => entry.id),
          `場面 ${key} のアーカイブ: 行の並び（id）が変わった`,
        ).toEqual(want?.archives.map((entry) => entry.id));
        for (const [rowIndex, wantRow] of (want?.archives ?? []).entries()) {
          expect(
            got?.archives[rowIndex],
            `場面 ${key} のアーカイブの ${String(wantRow.id).slice(0, 40)}（${String(rowIndex)} 行目）が固定値からずれた（storedBytes・removedAt・removedBytes など）`,
          ).toEqual(wantRow);
        }
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

      it(`${key} のストアへの呼びの並びが固定値と同じ`, () => {
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

  it('同じ入力で2回回すと、全場面で同じ出力・アーカイブ・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const decisionOf = (key: string, at: number): string => {
      const entry = step(key).journal[at];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    const OWNING = 'managers.runningManagerOwning';
    const PREFIX = '退避済み生ログの本文を消す: ';
    const AFTER = '退避済み生ログの本文を消した結果: ';
    const RETRACT = '直前の退避済み生ログの本文を消す行は効いていない（消していない）: ';
    // summary の検査（guard・日誌・消すより前）
    expect(text('summary-errors#1')).toBe('summary は使えない（1文字以上のみ）。');
    expect(text('summary-errors#2')).toContain('空白だけの値は空と同じ');
    expect(text('summary-errors#7')).toBe('summary は使えない（1文字以上のみ）。');
    for (let n = 1; n <= 8; n += 1) {
      expect(step(`summary-errors#${String(n)}`).calls, `summary-errors#${String(n)}`).toEqual([]);
    }
    // guard: unknown（managers 配線なし。managers へは1度も聞かない）
    expect(text('guard-unknown#1')).toContain('委譲の道具が配線されていない内部ターン');
    expect(text('guard-unknown#2')).toContain('安全側に倒して拒む');
    expect(step('guard-unknown#5').output.text).toContain('summary は使えない');
    expect(step('guard-unknown#1').calls).toEqual([]);
    // guard: denied（走行中のマネージャーを名指す。日誌も消す呼びも無い）
    expect(text('guard-denied#1')).toContain('マネージャー mgr-running がいま走行中');
    expect(ops('guard-denied#1')).toEqual([OWNING]);
    expect(ops('guard-denied#4')).toEqual([OWNING]);
    expect(ops('guard-denied#5')).toEqual([OWNING]);
    expect(text('guard-denied#6')).toContain('消せない');
    expect(ops('guard-denied#8')).toEqual([
      OWNING,
      'journal.append',
      'archive.remove',
      'journal.append',
    ]);
    expect(text('guard-denied#8')).not.toContain('override');
    // guard: allowed-with-override（先の行・grounds・出力の末尾に注）
    expect(ops('guard-override#1')).toEqual([
      OWNING,
      'journal.append',
      'archive.remove',
      'journal.append',
    ]);
    expect(decisionOf('guard-override#1', 0)).toContain(
      '（⚠️ override — 走行中のマネージャー mgr-running の退避だが、理由「本番の都合」により消す）',
    );
    expect(step('guard-override#1').journal[0]?.grounds).toBe(
      '片付けた／（⚠️ override — 走行中のマネージャー mgr-running の退避だが、理由「本番の都合」により消す）',
    );
    expect(text('guard-override#1').endsWith('により消す）')).toBe(true);
    expect(text('guard-override#2')).toContain('前から消されている');
    expect(text('guard-override#2')).not.toContain('override');
    expect(decisionOf('guard-override#2', 0)).toContain('override');
    expect(text('guard-override#4')).toContain('存在しない');
    expect(decisionOf('guard-override#4', 0)).toContain('居ない行を指した');
    expect(text('guard-override#5')).toContain('理由「前後に空白」により消す');
    // 日誌の先の行・後の行
    expect(text('remove-basic#1')).toContain('の本文を消した（5 バイト（');
    expect(decisionOf('remove-basic#1', 0)).toBe(
      `${PREFIX}sess-a-2026-10-01T00-01-00-000Z.jsonl: もう要らないので消した`,
    );
    expect(decisionOf('remove-basic#1', 1)).toContain(
      `${AFTER}sess-a-2026-10-01T00-01-00-000Z.jsonl（5 バイト`,
    );
    expect(decisionOf('remove-basic#1', 1)).toContain('いま消した');
    expect(decisionOf('remove-basic#2', 1)).toContain(
      '前から消されていたので今回は何も変わっていない',
    );
    expect(text('remove-basic#4')).not.toContain('override');
    expect(ops('remove-basic#1')).toEqual([
      OWNING,
      'journal.append',
      'archive.remove',
      'journal.append',
    ]);
    // missing（先の行は残り、打ち消しの行が足される）
    expect(text('missing#1')).toContain('は存在しない（消せない。何も変わっていない）');
    expect(decisionOf('missing#1', 0).startsWith(PREFIX)).toBe(true);
    expect(decisionOf('missing#1', 1).startsWith(RETRACT)).toBe(true);
    expect(step('missing#1').calls.map((entry) => entry.outcome)).toContain('{"kind":"missing"}');
    expect(step('missing-journal-fails#1').output.errorName).toBe('JournalNotRecordedError');
    expect(ops('missing-journal-fails#1')).toEqual([OWNING, 'journal.append']);
    expect(step('missing-journal-fails#2').journal).toHaveLength(1);
    expect(step('missing-journal-fails#2').dropped).toHaveLength(1);
    expect(step('missing-journal-fails#2').dropped[0]).toContain(
      '退避済み生ログの削除の打ち消しの日誌',
    );
    // already
    expect(text('already#1')).toContain(
      'は前から消されている（2026-10-01T00:01:00.000Z に 5 バイトを落とした',
    );
    expect(text('already#2')).toContain('1,234 バイト');
    expect(step('already#1').journal).toHaveLength(2);
    expect(step('already-journal-fails#1').output.thrown).toBe(true);
    expect(step('already-journal-fails#2').output.thrown).toBe(false);
    expect(step('already-journal-fails#2').journal).toHaveLength(1);
    // 先の日誌が書けない（消す呼びは無い）
    expect(step('journal-first-fails#1').output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-first-fails#1')).toContain(
      '⚠⚠ 未記録・行為は起きていない・やり直してよい',
    );
    expect(text('journal-first-fails#1')).toContain(
      'archive_remove は、この記録に失敗した時点で副作用を1つも起こしていない',
    );
    expect(text('journal-first-fails#1')).toContain('理由: Error: 日誌が落ちた');
    expect(ops('journal-first-fails#1')).not.toContain('archive.remove');
    expect(ops('journal-first-fails#3')).toEqual([OWNING, 'journal.append']);
    expect(text('journal-first-fails#2')).toContain('の本文を消した');
    // 後の日誌だけが書けない（握る）
    expect(step('after-journal-fails#1').output.thrown).toBe(false);
    expect(text('after-journal-fails#1')).toContain('の本文を消した');
    expect(step('after-journal-fails#1').journal).toHaveLength(1);
    expect(step('after-journal-fails#1').dropped[0]).toContain(
      '退避済み生ログの削除結果の日誌を記録できませんでした',
    );
    expect(text('after-journal-fails#2')).toContain('前から消されている');
    // 消す側が落ちる（補いの行・元の例外）
    expect(step('remove-throws#1').output.errorName).toBe('Error');
    expect(text('remove-throws#1')).toBe('アーカイブの削除が落ちた');
    expect(decisionOf('remove-throws#1', 1)).toContain('結果は確かめられていない');
    expect(step('remove-throws#2').journal).toHaveLength(1);
    expect(step('remove-throws#2').dropped[0]).toContain('退避済み生ログの削除失敗の補いの日誌');
    expect(text('remove-throws#3')).toContain('の本文を消した');
    // バイト数の表示
    expect(text('bytes-format#1')).toContain('（0 バイト（');
    expect(text('bytes-format#3')).toContain('（999 バイト（');
    expect(text('bytes-format#4')).toContain('（1,000 バイト（');
    expect(text('bytes-format#5')).toContain('（1,002 バイト（');
    expect(text('bytes-format#6')).toContain('（12 バイト（');
    expect(text('bytes-format#7')).toContain('（1,234,567 バイト（');
    expect(decisionOf('bytes-format#7', 1)).toContain('（1234567 バイト（');
    expect(text('bytes-format#8')).toContain('に 1,234,567 バイトを落とした');
    // 要約の形
    expect(decisionOf('summary-forms#1', 0)).toContain('一行目\n二行目');
    expect(decisionOf('summary-forms#2', 0)).toContain(
      ': 片付けた'.replace('片付けた', '  前後に空白  '),
    );
    expect(decisionOf('summary-forms#3', 0)).toContain(LONG_SUMMARY);
    expect(text('summary-forms#3')).not.toContain('長い要約');
    // id の形
    expect(text('id-forms#1')).toBe('アーカイブ  は存在しない（消せない。何も変わっていない）。');
    expect(decisionOf('id-forms#4', 0)).toBe(`${PREFIX}../etc/passwd: 片付けた`);
    // pinning 配線でも runningManagerPinning は呼ばない
    for (const key of [
      'guard-pinning-ignored#1',
      'guard-pinning-ignored#2',
      'guard-pinning-ignored#3',
    ]) {
      expect(ops(key)).not.toContain('managers.runningManagerPinning');
    }
    expect(text('guard-pinning-ignored#1')).toContain('消せない');
    expect(text('guard-pinning-ignored#2')).toContain('の本文を消した');
    // 配線なしと idle の違い
    expect(text('managers-omitted')).toContain('内部ターン');
    expect(text('remove-basic#1')).not.toContain('内部ターン');
  });
});
