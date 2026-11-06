import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import type { AttachmentMeta, AttachmentStore } from './attachment.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `attachment_fetch` の出力（全文と字数）と、呼んだあとの状態（写しの置き場のファイル・日誌へ足された行）・呼びの並び
// （`attachments.open`・その下の中身の読み（外部の置き場／控えの中）・開いた流れを閉じたか）を、
// 場面ごとにコミットした固定値（clone-tools-attachment-fetch-output-pin.json）と丸ごと比べる。
// `clone-tools-attach.ts` の `tool('attachment_fetch', …)`（`fetchAttachmentCopy` の結果ごとの文と、例外を「取り出せなかった」の文にする catch）と、
// `attachment-fetch.ts` の `fetchAttachmentCopy` を直す前の歯。固定値の側で値を伏せず、入力（時計・id・控え・中身・置き場の振る舞い）を固定して毎回同じにする。
//   - output: 道具の出力の全文（写しの置き場の絶対パスは `<copies>` に置き換える）と字数（isError・例外で返ったか・例外なら名前と文言）
//   - wrote: 呼ぶ前から変わったもの。none（写しの置き場が同じ。使い回しもここ）/ copy（ファイル・ディレクトリ・中身のどれかが変わった）。日誌と控えは変わらないことを場面ごとに確かめる
//   - copies: 呼んだあとの写しの置き場の全部（相対パス。ファイルは「大きさ・中身の sha256 の先頭」、ディレクトリは末尾 `/`）
//   - journal: 呼んだあとに日誌へ足された行（この道具は書かないので空のはず）
//   - dropped: 握った書き損じの跡（stderr。この道具は握らないので空のはず）
//   - streamDestroyed: 置き場が返した流れを、呼びが終わった時点で閉じていたか（開かなかった場面は null）
//   - calls: 呼びの並び（`attachments.open` と、中身の読み。結果・失敗付き）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_ATTACHMENT_FETCH_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-attachment-fetch-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-attachment-fetch-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、写し・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 添付の置き場は、控え・中身・外部の置き場の読みの失敗を作るため場面ごとに作る小さな偽の置き場（`open` だけが本物の振る舞いで、ほかは使わない）で差し替える。
// 写しの置き場は場面ごとの一時ディレクトリ（`context.attachmentCopiesDir`）で、試験の後に消す。パスは json に残さない（`<copies>` と相対パスだけ）。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 作れなかった分岐（理由）:
//   - 名前や id から「置き場所の外へ出る」ことによる unsafe（`attachment-fetch.ts` の `startsWith` の検査）: 名前は `normalizeAttachmentName` が区切り（`/` `\`）を `_` にし `..` `.` 空を `file` にするので、
//     id が `SAFE_ID`（英数と `_` `-` だけ・先頭は英数）を通れば外へ出る形は作れない。unsafe は `SAFE_ID` に通らない id を置き場が返した形だけで通る。
//   - 確かめてから印を付けるまでの間に掃除が写しを消した形（`utimes` か 2 度目の `stat` が落ちて書き直す枝）: 間の一瞬に別の手が消す競り合いで、偽の置き場からは起こせない。
//   - 本物の外部の置き場（S3 など）の失敗の中身: 偽の置き場の `external`（中身を別の読みとして記録する）で読みの並びだけを写す。本物の置き場の失敗は作らない。
//   - 引数の検査（id が空文字）: zod の検査はハンドラの外（SDK 側）にあり、ハンドラへ直接渡す本試験では通らない。空文字をそのまま渡した形は「見つからない」の場面に入れて、いまの振る舞いを固定した。
//   - 写しの path にディレクトリが在る形（rename が一時ファイル名を含む文で落ちる）: 一時ファイル名が毎回変わる乱数で、文言を固定できない。
//
// 秘密: 値は作りものだけ（`FAKE_NOT_A_REAL_VALUE_…`）。理由の文に作りものの値が入る場面は、いまの振る舞い（`reasonOf` の伏せ字）をそのまま固定する。
// そのため json にはその作りものの値が残りうる（本物ではない）。固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い文字列は「語＋空白」を繰り返して空白を挟む（`spaced`。間隔は語の長さ＋1 字で、この試験では 'longname'（8 字）で 9 字ごと）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み。none: 写しの置き場が同じ / copy: 写しのファイル・ディレクトリ・中身のどれかが変わった */
type Writes = 'none' | 'copy';

type OpenThrows = 'error' | 'string' | 'multiline' | 'fake-value' | 'fake-value-bare';
type StreamFails = 'at-start' | 'after-first-chunk' | 'string-after-first-chunk';

interface Hooks {
  /** `attachments.open` が投げる */
  openThrows: OpenThrows | null;
  /** 中身の流れが投げる */
  streamFails: StreamFails | null;
}

interface SeedAttachment {
  id: string;
  name: string;
  mediaType?: string;
  /** 置き場が返す中身（既定は固定の短い文） */
  content?: Buffer | string;
  /** 1 回の読みで返す大きさ（バイト）。既定 5 */
  chunk?: number;
  /** 外部の置き場に預けた中身（読みを別の呼びとして記録する） */
  external?: boolean;
  /** 期限切れ（置き場は「見つからない」を返す） */
  expired?: boolean;
  /** 控えの申告を、中身とずらす（mismatch・unsafe を作る） */
  meta?: { id?: string; size?: number; sha256?: string };
  /** 呼ぶ前から写しの置き場に在るファイル */
  copy?: { file: string; content: string };
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
  /** 呼ぶ前に、この id のディレクトリの場所へ普通のファイルを置く（写しのディレクトリを作れない形） */
  blockDirFor?: string;
}

interface Scenario {
  name: string;
  group: string;
  covers: string;
  seed?: SeedAttachment[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const CREATED_ISO = '2026-10-28T00:00:00.000Z';
const EXPIRES_ISO = '2026-11-27T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-attachment-fetch-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_ATTACHMENT_FETCH_PIN === '1';
const COPIES_MARK = '<copies>';

function callTime(index: number): number {
  return BASE_MS + index * 60_000;
}

/** 作りものの値（本物ではない）。理由の文に混ぜて、伏せられるかどうかをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

/** 長さ len の、「語＋空白」を繰り返した文字列（空白の間隔は語の長さ＋1 字。既定の語は 9 字で 10 字ごと、`'longname'` は 9 字ごと。末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function bytesOf(content: Buffer | string): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function shaOf(content: Buffer | string): string {
  return createHash('sha256').update(bytesOf(content)).digest('hex');
}

function d(id: string, extra: Args = {}): Args {
  return { id, ...extra };
}

function w(args: Args, writes: Writes, hooks?: Partial<Hooks>, blockDirFor?: string): Step {
  return {
    args,
    writes,
    ...(hooks === undefined ? {} : { hooks }),
    ...(blockDirFor === undefined ? {} : { blockDirFor }),
  };
}

// 作りものの中身（本物のファイルではない）
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff,
]);
const PDF_TEXT = '%PDF-1.4 fake body 1234567890 end';
const TEXT_JA = 'こんにちは、作りものの本文。\n二行目です。';
const LOG_TEXT = 'line one\nline two\nline three\n';
const MP4_BYTES = Buffer.from(Array.from({ length: 40 }, (_, i) => (i * 7) % 256));
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const BIG_BYTES = Buffer.alloc(100_000, 0x61);
const DEFAULT_CONTENT = 'fake content 0123456789';

const SCENARIOS: Scenario[] = [
  // ---- 取り出せる ----
  {
    name: 'fetch-kinds',
    group: '取り出せる',
    covers:
      '種類ごとの取り出し: 画像・PDF・多バイトのテキスト・複数行のログ・動画・全バイトの値・種類が空。出力は path・name・type・size（バイト数）・sha256（本物の値）。写しは `<id>/<名前>`。呼びは open → 中身の読み',
    seed: [
      { id: 'att-png', name: 'photo.png', mediaType: 'image/png', content: PNG_BYTES },
      { id: 'att-pdf', name: 'doc.pdf', mediaType: 'application/pdf', content: PDF_TEXT },
      {
        id: 'att-txt',
        name: 'note.txt',
        mediaType: 'text/plain; charset=utf-8',
        content: TEXT_JA,
      },
      { id: 'att-log', name: 'run.log', mediaType: 'text/x-log', content: LOG_TEXT },
      { id: 'att-mp4', name: 'clip.mp4', mediaType: 'video/mp4', content: MP4_BYTES },
      {
        id: 'att-bin',
        name: 'all.bin',
        mediaType: 'application/octet-stream',
        content: ALL_BYTES,
        chunk: 64,
      },
      { id: 'att-notype', name: 'no-type', mediaType: '', content: 'abc' },
    ],
    steps: [
      w(d('att-png'), 'copy'),
      w(d('att-pdf'), 'copy'),
      w(d('att-txt'), 'copy'),
      w(d('att-log'), 'copy'),
      w(d('att-mp4'), 'copy'),
      w(d('att-bin'), 'copy'),
      w(d('att-notype'), 'copy'),
    ],
  },
  {
    name: 'fetch-external',
    group: '取り出せる',
    covers:
      '外部の置き場に預けた中身: 読みは `externalBlob.read`（控えの中の中身は `inlineContent.read`）。10 万バイトの中身も取り出せる。同じ id をもう一度取ると使い回して、中身の読みは起きない（open だけ）',
    seed: [
      { id: 'att-ext-big', name: 'big.bin', content: BIG_BYTES, chunk: 8192, external: true },
      { id: 'att-ext-small', name: 'small.txt', content: 'ext small', external: true },
      { id: 'att-inline-small', name: 'inline.txt', content: 'inline small' },
    ],
    steps: [
      w(d('att-ext-big'), 'copy'),
      w(d('att-ext-small'), 'copy'),
      w(d('att-inline-small'), 'copy'),
      w(d('att-ext-big'), 'none'),
    ],
  },
  {
    name: 'fetch-empty',
    group: '取り出せる',
    covers:
      '大きさ 0 の中身: 取り出せて（size=0・空の中身の sha256）、空のファイルが置かれる。同じ id をもう一度取ると使い回す',
    seed: [{ id: 'att-empty', name: 'empty.txt', content: '' }],
    steps: [w(d('att-empty'), 'copy'), w(d('att-empty'), 'none')],
  },
  {
    name: 'fetch-names-multibyte',
    group: '取り出せる',
    covers:
      '多バイト文字・空白・絵文字の名前: 表示の name は正規化した名前のまま、path のファイル名も同じ。長い名前（日本語 120 字＋拡張子・ディスク上は 200 バイトに丸めて拡張子は残す。表示の name は丸めない）',
    seed: [
      { id: 'att-ja', name: '日本語のファイル名.txt' },
      { id: 'att-sp', name: '写真 2026年 春.png', mediaType: 'image/png' },
      { id: 'att-emoji', name: '😀.txt' },
      { id: 'att-longja', name: `${'日本語'.repeat(40)}.txt` },
      { id: 'att-longascii', name: spaced(300, 'longname') },
    ],
    steps: [
      w(d('att-ja'), 'copy'),
      w(d('att-sp'), 'copy'),
      w(d('att-emoji'), 'copy'),
      w(d('att-longja'), 'copy'),
      w(d('att-longascii'), 'copy'),
    ],
  },
  {
    name: 'fetch-names-special',
    group: '取り出せる',
    covers:
      '名前に `../`・区切り・空白・制御文字が入る: 控えの名前は取り出しのときも正規化し直す（`/` と `\\` と制御文字は `_`、前後の空白は落とす、`..`・`.`・空は `file`、NUL は消す）。写しは id のディレクトリの外へ出ない',
    seed: [
      { id: 'att-dots', name: '../../etc/passwd' },
      { id: 'att-dotdot', name: '..' },
      { id: 'att-dot', name: '.' },
      { id: 'att-blank', name: '' },
      { id: 'att-pad', name: '  padded name  ' },
      { id: 'att-back', name: 'a\\b.txt' },
      { id: 'att-ctrl', name: 'tab\tnew\nline.txt' },
      { id: 'att-nul', name: 'nul\u0000byte.txt' },
      { id: 'att-hidden', name: '.hidden' },
      { id: 'att-dash', name: '-leading dash' },
    ],
    steps: [
      w(d('att-dots'), 'copy'),
      w(d('att-dotdot'), 'copy'),
      w(d('att-dot'), 'copy'),
      w(d('att-blank'), 'copy'),
      w(d('att-pad'), 'copy'),
      w(d('att-back'), 'copy'),
      w(d('att-ctrl'), 'copy'),
      w(d('att-nul'), 'copy'),
      w(d('att-hidden'), 'copy'),
      w(d('att-dash'), 'copy'),
    ],
  },

  // ---- 使い回し ----
  {
    name: 'reuse',
    group: '使い回し',
    covers:
      '同じ id を続けて取る: 1 回目は書き出し、2 回目以降は「（既にあった写しを使い回した）」の印が付き、中身の読みは起きず、流れは閉じる。写しは変わらない',
    seed: [{ id: 'att-r', name: 'again.txt', content: 'again content' }],
    steps: [w(d('att-r'), 'copy'), w(d('att-r'), 'none'), w(d('att-r'), 'none')],
  },
  {
    name: 'reuse-prepared',
    group: '使い回し',
    covers:
      '呼ぶ前から在る写しの扱い: 大きさも sha256 も同じなら使い回す。同じ大きさで中身が違う・大きさが違う・空の写しは書き直して使い回しの印は付かない。名前が違う写しは残したまま、新しい名前で書く',
    seed: [
      {
        id: 'att-same',
        name: 'same.txt',
        content: 'same content',
        copy: { file: 'same.txt', content: 'same content' },
      },
      {
        id: 'att-samesize',
        name: 'samesize.txt',
        content: 'abcdefgh',
        copy: { file: 'samesize.txt', content: 'ABCDEFGH' },
      },
      {
        id: 'att-diffsize',
        name: 'diffsize.txt',
        content: 'longer content',
        copy: { file: 'diffsize.txt', content: 'short' },
      },
      {
        id: 'att-othername',
        name: 'new-name.txt',
        content: 'x',
        copy: { file: 'old-name.txt', content: 'x' },
      },
      {
        id: 'att-emptycopy',
        name: 'emptycopy.txt',
        content: 'abc',
        copy: { file: 'emptycopy.txt', content: '' },
      },
    ],
    steps: [
      w(d('att-same'), 'none'),
      w(d('att-samesize'), 'copy'),
      w(d('att-diffsize'), 'copy'),
      w(d('att-othername'), 'copy'),
      w(d('att-emptycopy'), 'copy'),
    ],
  },

  // ---- 見つからない ----
  {
    name: 'not-found',
    group: '見つからない',
    covers:
      '置き場が「無い」を返す id: 無い id・期限切れ（行は在るが置き場が返さない）・パスにできない id（`../x`・空白入り）・長い id・日本語の id・空文字。出力は「見つからない（保持期限が過ぎて消えた、または id の誤り）。人間に再送を頼む。」で、写しの置き場は何も作らず、中身の読みも起きない',
    seed: [
      { id: 'att-expired', name: 'expired.txt', expired: true },
      { id: 'att-other', name: 'other.txt' },
    ],
    steps: [
      w(d('att-ghost'), 'none'),
      w(d('att-expired'), 'none'),
      w(d('../x'), 'none'),
      w(d('a b'), 'none'),
      w(d(spaced(200, 'longid')), 'none'),
      w(d('添付の誤り'), 'none'),
      w(d(''), 'none'),
    ],
  },

  // ---- 中身が控えと合わない ----
  {
    name: 'mismatch',
    group: '中身が控えと合わない',
    covers:
      '置き場から読んだ中身が控えの大きさか sha256 と合わない: 短い（途中で切れた）・長い・同じ大きさで中身が違う・大きさは合うが sha256 が違う。「取り出せなかった（…写しは残していない。もう一度試すと直る場合がある）」で、写しのファイルは残らない（id のディレクトリだけが空で残る）。呼びが終わったとき流れは閉じる',
    seed: [
      { id: 'att-short', name: 'short.txt', content: 'abcde', meta: { size: 20 } },
      { id: 'att-long', name: 'long.txt', content: 'abcdefghij', meta: { size: 3 } },
      {
        id: 'att-corrupt',
        name: 'corrupt.txt',
        content: 'abcdefgh',
        meta: { sha256: shaOf('ABCDEFGH') },
      },
      {
        id: 'att-badsha',
        name: 'badsha.txt',
        content: 'abcdefgh',
        meta: { sha256: 'sha-fake-not-hex' },
      },
    ],
    steps: [
      w(d('att-short'), 'copy'),
      w(d('att-long'), 'copy'),
      w(d('att-corrupt'), 'copy'),
      w(d('att-badsha'), 'copy'),
    ],
  },
  {
    name: 'mismatch-stale-copy',
    group: '中身が控えと合わない',
    covers:
      '合わない中身のとき、先に在った別の中身の写しも消える（欠けた写しを残さない）。同じ id を続けて呼んでも 2 回とも合わない',
    seed: [
      {
        id: 'att-stale',
        name: 'stale.txt',
        content: 'abcde',
        meta: { size: 20 },
        copy: { file: 'stale.txt', content: 'old content' },
      },
    ],
    steps: [w(d('att-stale'), 'copy'), w(d('att-stale'), 'none')],
  },

  // ---- それ以外の理由（unsafe） ----
  {
    name: 'unsafe-id',
    group: '置き場所の外へ出る形',
    covers:
      '置き場が返した控えの id が `SAFE_ID` に通らない形（`../escape`・空・先頭が `-`・区切り入り・129 字）: 「取り出せない（置き場が返した id か名前が、置き場所の外へ出る形だった）」で、写しの置き場は何も作らず、中身の読みは起きず、流れは閉じる。出力の id は呼んだ id（控えの id ではない）',
    seed: [
      { id: 'att-u1', name: 'u1.txt', meta: { id: '../escape' } },
      { id: 'att-u2', name: 'u2.txt', meta: { id: '' } },
      { id: 'att-u3', name: 'u3.txt', meta: { id: '-lead' } },
      { id: 'att-u4', name: 'u4.txt', meta: { id: 'a/b' } },
      { id: 'att-u5', name: 'u5.txt', meta: { id: `a${'b'.repeat(128)}` } },
      { id: 'att-u6', name: 'u6.txt', meta: { id: `a${'b'.repeat(127)}` } },
    ],
    steps: [
      w(d('att-u1'), 'none'),
      w(d('att-u2'), 'none'),
      w(d('att-u3'), 'none'),
      w(d('att-u4'), 'none'),
      w(d('att-u5'), 'none'),
      w(d('att-u6'), 'copy'),
    ],
  },

  // ---- 例外 ----
  {
    name: 'open-throws',
    group: '読みの途中で例外',
    covers:
      '置き場の open が投げる: 「取り出せなかった: <理由>（もう一度試すと直る場合がある）」（isError ではない）。Error は `Error: message`・文字列は文字列そのまま・改行入りは最初の 1 行だけ。理由の `名前=値` と長い値だけの文は [REDACTED]。写しは作らない。次の呼び（投げない）は取り出せる',
    seed: [{ id: 'att-o', name: 'o.txt', content: 'open ok' }],
    steps: [
      w(d('att-o'), 'none', { openThrows: 'error' }),
      w(d('att-o'), 'none', { openThrows: 'string' }),
      w(d('att-o'), 'none', { openThrows: 'multiline' }),
      w(d('att-o'), 'none', { openThrows: 'fake-value' }),
      w(d('att-o'), 'none', { openThrows: 'fake-value-bare' }),
      w(d('att-o'), 'copy'),
    ],
  },
  {
    name: 'stream-throws',
    group: '読みの途中で例外',
    covers:
      '中身の読みの途中で投げる（最初の読みで・1 つ目の塊のあとで・文字列を投げる）: 一時ファイルは消え、写しのファイルは残らない（id のディレクトリだけ空で残る）。出力は「取り出せなかった: <理由>（…）」。先に在った写しは触らない。流れは閉じる',
    seed: [
      { id: 'att-s1', name: 's1.txt', content: 'stream content that is long enough' },
      { id: 'att-s2', name: 's2.txt', content: 'stream content that is long enough' },
      { id: 'att-s3', name: 's3.txt', content: 'stream content that is long enough' },
      {
        id: 'att-s4',
        name: 's4.txt',
        content: 'stream content that is long enough',
        copy: { file: 's4.txt', content: 'older copy' },
      },
    ],
    steps: [
      w(d('att-s1'), 'copy', { streamFails: 'at-start' }),
      w(d('att-s2'), 'copy', { streamFails: 'after-first-chunk' }),
      w(d('att-s3'), 'copy', { streamFails: 'string-after-first-chunk' }),
      w(d('att-s4'), 'none', { streamFails: 'after-first-chunk' }),
    ],
  },
  {
    name: 'retry-after-failure',
    group: '読みの途中で例外',
    covers:
      '失敗のあとにもう一度呼ぶと取り出せる（文言の「もう一度試すと直る」どおり）: 1 回目は読みの途中で投げ、2 回目は書き出す（空のディレクトリを使う）、3 回目は使い回す',
    seed: [{ id: 'att-retry', name: 'retry.txt', content: 'retry content is long enough' }],
    steps: [
      w(d('att-retry'), 'copy', { streamFails: 'after-first-chunk' }),
      w(d('att-retry'), 'copy'),
      w(d('att-retry'), 'none'),
    ],
  },
  {
    name: 'copies-blocked',
    group: '読みの途中で例外',
    covers:
      '写しの置き場に書けない（id のディレクトリの場所に普通のファイルが在る）: mkdir の失敗（EEXIST）が「取り出せなかった: …（…）」になる。文の中の絶対パスは `<copies>` に置き換える。中身の読みは起きず、流れは閉じる',
    seed: [{ id: 'att-blocked', name: 'blocked.txt', content: 'blocked content' }],
    steps: [w(d('att-blocked'), 'none', {}, 'att-blocked')],
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
  thrown: boolean;
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
  /** 呼んだあとの写しの置き場の全部（相対パス） */
  copies: string[];
  journal: Record<string, unknown>[];
  dropped: string[];
  /** 置き場が返した流れを、呼びが終わった時点で閉じていたか（開かなかった場面は null） */
  streamDestroyed: boolean | null;
  calls: PinnedCall[];
}

interface PinFile {
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function freshHooks(): Hooks {
  return { openThrows: null, streamFails: null };
}

function record(calls: PinnedCall[], op: string, args: unknown): PinnedCall {
  const entry: PinnedCall = { op, args: plain(args), outcome: '(まだ戻っていない)' };
  calls.push(entry);
  return entry;
}

interface Row {
  spec: SeedAttachment;
  content: Buffer;
}

/** `attachment_fetch` が使う口（open）だけを持つ偽の置き場。行と中身を持ち、呼びを記録する */
class FakeAttachments {
  readonly rows = new Map<string, Row>();
  hooks: Hooks = freshHooks();
  calls: PinnedCall[] = [];
  /** 呼びの中で最後に返した流れ */
  lastStream: Readable | null = null;

  /** 最後に返した流れを閉じていたか（返していなければ null） */
  streamDestroyed(): boolean | null {
    return this.lastStream === null ? null : this.lastStream.destroyed;
  }

  seed(spec: SeedAttachment): void {
    this.rows.set(spec.id, { spec, content: bytesOf(spec.content ?? DEFAULT_CONTENT) });
  }

  private metaOf(row: Row): AttachmentMeta {
    const { spec, content } = row;
    return {
      id: spec.meta?.id ?? spec.id,
      name: spec.name,
      mediaType: spec.mediaType ?? 'text/plain',
      size: spec.meta?.size ?? content.length,
      sha256: spec.meta?.sha256 ?? shaOf(content),
      createdAt: CREATED_ISO,
      expiresAt: EXPIRES_ISO,
    };
  }

  private streamOf(row: Row): Readable {
    const calls = this.calls;
    const hooks = this.hooks;
    const { spec, content } = row;
    const chunk = spec.chunk ?? 5;
    async function* generate(): AsyncGenerator<Buffer> {
      const entry = record(
        calls,
        spec.external === true ? 'externalBlob.read' : 'inlineContent.read',
        { id: spec.id },
      );
      let sent = 0;
      try {
        if (hooks.streamFails === 'at-start') throw new Error('置き場の読みが始まらない（test）');
        for (let at = 0; at < content.length; at += chunk) {
          const part = content.subarray(at, at + chunk);
          sent += part.length;
          yield part;
          if (hooks.streamFails === 'after-first-chunk') {
            throw new Error('置き場の読みが途中で切れた（test）');
          }
          if (hooks.streamFails === 'string-after-first-chunk') {
            // 非 Error を投げる枝を作る
            throw 'raw string failure';
          }
        }
        entry.outcome = `ok ${String(sent)} bytes`;
      } catch (error) {
        entry.outcome = `threw ${nameOf(error)} after ${String(sent)} bytes`;
        throw error;
      }
    }
    return Readable.from(generate(), { objectMode: false });
  }

  asStore(): AttachmentStore {
    const unused = async (): Promise<never> => {
      throw new Error('この試験では使わない');
    };
    return {
      put: unused,
      get: unused,
      putStream: unused,
      open: async (id: string) => {
        const entry = record(this.calls, 'attachments.open', { id });
        const mode = this.hooks.openThrows;
        if (mode !== null) {
          entry.outcome = mode === 'string' ? 'threw string' : 'threw Error';
          if (mode === 'string') throw 'raw string failure';
          if (mode === 'error') throw new Error('置き場に繋がらない（test）');
          if (mode === 'multiline') throw new Error('一行目\n\n   二行目');
          if (mode === 'fake-value') throw new Error(`接続できない TOKEN=${FAKE_VALUE}`);
          throw new Error(`接続できない ${FAKE_VALUE}`);
        }
        const row = this.rows.get(id);
        if (row === undefined || row.spec.expired === true) {
          entry.outcome = 'undefined';
          return undefined;
        }
        entry.outcome = 'found';
        const stream = this.streamOf(row);
        this.lastStream = stream;
        return { meta: this.metaOf(row), stream };
      },
      getMeta: unused,
      bind: unused,
      bindToExternalEvent: unused,
      bindToManagerReport: unused,
      unbind: unused,
      prune: unused,
      sweepOrphanBlobs: unused,
      setKept: unused,
      remove: unused,
      list: unused,
      usage: unused,
      clear: unused,
    } as unknown as AttachmentStore;
  }
}

function writeCopy(copiesDir: string, id: string, file: string, content: string): void {
  mkdirSync(join(copiesDir, id), { recursive: true });
  writeFileSync(join(copiesDir, id, file), content);
}

/** 写しの置き場の全部。ファイルは「相対パス（大きさ B・中身の sha256 の先頭 12 字）」、ディレクトリは末尾 `/` */
function listCopies(copiesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(copiesDir, full);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        out.push(
          `${rel} (${String(statSync(full).size)} B, sha256=${shaOf(readFileSync(full)).slice(0, 12)})`,
        );
      }
    }
  };
  walk(copiesDir);
  return out.sort();
}

interface Snapshot {
  copies: string[];
  journal: Record<string, unknown>[];
}

async function snapshot(stores: Stores, copiesDir: string): Promise<Snapshot> {
  return {
    copies: listCopies(copiesDir),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  // 掃除は vitest.setup.ts の afterAll が行う（直接 mkdtemp を呼ばない規則）
  const root = await makeTempDir('alteroid-attachment-fetch-pin-');
  const copiesDir = resolve(join(root, 'copies'));
  mkdirSync(copiesDir, { recursive: true });
  const base = createMemoryStores();
  const fake = new FakeAttachments();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const seed of scenario.seed ?? []) {
    fake.seed(seed);
    if (seed.copy !== undefined) writeCopy(copiesDir, seed.id, seed.copy.file, seed.copy.content);
  }
  const dropped: string[] = [];
  setStderrSinkForTesting((line) => {
    dropped.push(line);
  });
  const results: PinnedStep[] = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      fake.hooks = { ...freshHooks(), ...(step.hooks ?? {}) };
      const calls: PinnedCall[] = [];
      fake.calls = calls;
      fake.lastStream = null;
      dropped.length = 0;
      if (step.blockDirFor !== undefined) {
        writeFileSync(join(copiesDir, step.blockDirFor), 'a plain file, not a directory');
      }
      const stores: Stores = { ...base, attachments: fake.asStore() };
      const context: ToolContext = {
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        attachmentCopiesDir: copiesDir,
      };
      const found = createCloneTools(context).find((entry) => entry.name === 'attachment_fetch');
      if (!found) throw new Error('attachment_fetch が無い');

      const before = await snapshot(stores, copiesDir);
      vi.setSystemTime(new Date(callTime(index)));
      let output: PinnedOutput;
      // 例外の文の絶対パスは `reasonOf` が一部の区間を [REDACTED] に置き換える（一時ディレクトリの乱数の名前で変わる）ので、
      // 置き換えの前後どちらの形でも、引用符で囲まれたパスの `/copies` までを `<copies>` にそろえる
      const scrub = (text: string): string =>
        text
          .replaceAll(copiesDir, COPIES_MARK)
          .replaceAll(/'[^'\s]*\/copies(?=[/'])/gu, `'${COPIES_MARK}`);
      try {
        const result = await found.handler(step.args as never, {} as never);
        const text = scrub(
          (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
        );
        output = {
          length: text.length,
          text,
          isError: result.isError === true,
          thrown: false,
          errorName: null,
        };
      } catch (error) {
        const text = scrub(error instanceof Error ? error.message : String(error));
        output = {
          length: text.length,
          text,
          isError: true,
          thrown: true,
          errorName: nameOf(error),
        };
      }
      fake.hooks = freshHooks();
      const after = await snapshot(stores, copiesDir);
      const copiesChanged = JSON.stringify(before.copies) !== JSON.stringify(after.copies);
      const wrote: Writes = copiesChanged ? 'copy' : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 書き込みの有無が宣言（${step.writes}）と違う`).toBe(step.writes);
      expect(after.journal.length, `場面 ${key}: この道具が日誌へ行を足した`).toBe(
        before.journal.length,
      );
      results.push({
        output,
        wrote,
        copies: after.copies,
        journal: after.journal.slice(before.journal.length),
        dropped: [...dropped],
        streamDestroyed: fake.streamDestroyed(),
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

describe('attachment_fetch の出力と呼んだあとの状態の固定（場面ごとの出力の全文・写し・日誌の行・呼びの並び）', () => {
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

  it('書き込みの有無が、場面の宣言・固定値と同じ', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
        expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が宣言と違う`).toBe(
          step.writes,
        );
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

      it(`${key} の呼んだあとの写しと、流れを閉じたかが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.copies,
          `場面 ${key} の写しの置き場（ファイル・ディレクトリ・中身）が変わった`,
        ).toEqual(want?.copies);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
        expect(got?.streamDestroyed, `場面 ${key} の、置き場が返した流れを閉じたかが変わった`).toBe(
          want?.streamDestroyed,
        );
      });

      it(`${key} の日誌へ足された行と握った跡が固定値と同じ（この道具は書かない）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.journal, `場面 ${key} の日誌へ足された行が変わった`).toEqual(want?.journal);
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

  it('同じ入力で2回回すと、全場面で同じ出力・写し・日誌・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に写しの置き場の絶対パスが入っていない。作りものの値は、理由の場面にだけ在る', () => {
    expect(pinnedRaw).not.toContain('alteroid-attachment-fetch-pin-');
    expect(pinnedRaw).not.toContain(tmpdir());
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-/);
    for (const key of ALL_KEYS) {
      const whole = JSON.stringify(actual[key]);
      if (key === 'open-throws#4') continue;
      expect(whole.includes(FAKE_VALUE), `場面 ${key} の記録に作りものの値が入っている`).toBe(
        false,
      );
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);

    const FETCHED = (
      id: string,
      path: string,
      name: string,
      type: string,
      content: Buffer | string,
      reused = false,
    ): string =>
      `添付 ${id} を取り出した${reused ? '（既にあった写しを使い回した）' : ''}。Read で開ける。\npath=${COPIES_MARK}/${path}\nname=${name} type=${type} size=${String(bytesOf(content).length)} sha256=${shaOf(content)}`;
    const NOT_FOUND = (id: string): string =>
      `添付 ${id} は見つからない（保持期限が過ぎて消えた、または id の誤り）。人間に再送を頼む。`;
    const MISMATCH = (id: string): string =>
      `添付 ${id} は取り出せなかった（置き場から読んだ中身が、控えの大きさか sha256 と合わない。途中で切れたか壊れている。写しは残していない。もう一度試すと直る場合がある）。`;
    const UNSAFE = (id: string): string =>
      `添付 ${id} は取り出せない（置き場が返した id か名前が、置き場所の外へ出る形だった）。`;
    const FAILED = (id: string, reason: string): string =>
      `添付 ${id} を取り出せなかった: ${reason}（もう一度試すと直る場合がある）`;

    // 取り出せる
    expect(text('fetch-kinds#1')).toBe(
      FETCHED('att-png', 'att-png/photo.png', 'photo.png', 'image/png', PNG_BYTES),
    );
    expect(text('fetch-kinds#2')).toBe(
      FETCHED('att-pdf', 'att-pdf/doc.pdf', 'doc.pdf', 'application/pdf', PDF_TEXT),
    );
    expect(text('fetch-kinds#3')).toBe(
      FETCHED('att-txt', 'att-txt/note.txt', 'note.txt', 'text/plain; charset=utf-8', TEXT_JA),
    );
    expect(text('fetch-kinds#6')).toContain('size=256 ');
    expect(text('fetch-kinds#7')).toContain(' type= size=3 ');
    expect(ops('fetch-kinds#1')).toEqual(['attachments.open', 'inlineContent.read']);
    expect(step('fetch-kinds#1').calls[1]?.outcome).toBe(`ok ${String(PNG_BYTES.length)} bytes`);
    expect(step('fetch-kinds#1').copies).toEqual([
      'att-png/',
      `att-png/photo.png (${String(PNG_BYTES.length)} B, sha256=${shaOf(PNG_BYTES).slice(0, 12)})`,
    ]);
    expect(step('fetch-kinds#1').output.isError).toBe(false);
    expect(step('fetch-kinds#1').streamDestroyed).toBe(true);
    expect(ops('fetch-external#1')).toEqual(['attachments.open', 'externalBlob.read']);
    expect(step('fetch-external#1').calls[1]?.outcome).toBe('ok 100000 bytes');
    expect(text('fetch-external#1')).toContain('size=100000 ');
    expect(ops('fetch-external#3')).toEqual(['attachments.open', 'inlineContent.read']);
    expect(text('fetch-external#4')).toBe(
      FETCHED('att-ext-big', 'att-ext-big/big.bin', 'big.bin', 'text/plain', BIG_BYTES, true),
    );
    expect(ops('fetch-external#4')).toEqual(['attachments.open']);
    expect(text('fetch-empty#1')).toBe(
      FETCHED('att-empty', 'att-empty/empty.txt', 'empty.txt', 'text/plain', ''),
    );
    expect(text('fetch-empty#1')).toContain(' size=0 ');
    expect(step('fetch-empty#1').copies[1]).toContain('empty.txt (0 B');
    expect(text('fetch-empty#2')).toContain('（既にあった写しを使い回した）');
    expect(text('fetch-names-multibyte#1')).toContain(
      'path=<copies>/att-ja/日本語のファイル名.txt\n',
    );
    expect(text('fetch-names-multibyte#4')).toContain(`name=${'日本語'.repeat(40)}.txt `);
    expect(
      step('fetch-names-multibyte#4').copies.some((entry) => entry.startsWith('att-longja/日本語')),
    ).toBe(true);
    expect(text('fetch-names-special#1')).toContain('path=<copies>/att-dots/.._.._etc_passwd\n');
    expect(text('fetch-names-special#2')).toContain('path=<copies>/att-dotdot/file\n');
    expect(text('fetch-names-special#3')).toContain('path=<copies>/att-dot/file\n');
    expect(text('fetch-names-special#4')).toContain('path=<copies>/att-blank/file\n');
    expect(text('fetch-names-special#5')).toContain('path=<copies>/att-pad/padded name\n');
    expect(text('fetch-names-special#6')).toContain('path=<copies>/att-back/a_b.txt\n');
    expect(text('fetch-names-special#7')).toContain('path=<copies>/att-ctrl/tab_new_line.txt\n');
    expect(text('fetch-names-special#8')).toContain('path=<copies>/att-nul/nulbyte.txt\n');
    expect(text('fetch-names-special#10')).toContain('path=<copies>/att-dash/-leading dash\n');

    // 使い回し
    expect(text('reuse#1')).toBe(
      FETCHED('att-r', 'att-r/again.txt', 'again.txt', 'text/plain', 'again content'),
    );
    for (const key of ['reuse#2', 'reuse#3']) {
      expect(text(key), key).toBe(
        FETCHED('att-r', 'att-r/again.txt', 'again.txt', 'text/plain', 'again content', true),
      );
      expect(ops(key), key).toEqual(['attachments.open']);
      expect(step(key).streamDestroyed, key).toBe(true);
    }
    expect(text('reuse-prepared#1')).toContain('（既にあった写しを使い回した）');
    for (const key of [
      'reuse-prepared#2',
      'reuse-prepared#3',
      'reuse-prepared#4',
      'reuse-prepared#5',
    ]) {
      expect(text(key), key).not.toContain('使い回した');
      expect(ops(key), key).toEqual(['attachments.open', 'inlineContent.read']);
    }
    expect(step('reuse-prepared#4').copies).toContain(
      `att-othername/old-name.txt (1 B, sha256=${shaOf('x').slice(0, 12)})`,
    );
    expect(step('reuse-prepared#4').copies).toContain(
      `att-othername/new-name.txt (1 B, sha256=${shaOf('x').slice(0, 12)})`,
    );

    // 見つからない
    for (const [key, id] of [
      ['not-found#1', 'att-ghost'],
      ['not-found#2', 'att-expired'],
      ['not-found#3', '../x'],
      ['not-found#4', 'a b'],
      ['not-found#6', '添付の誤り'],
      ['not-found#7', ''],
    ] as const) {
      expect(text(key), key).toBe(NOT_FOUND(id));
      expect(ops(key), key).toEqual(['attachments.open']);
      expect(step(key).streamDestroyed, key).toBeNull();
      expect(step(key).output.isError, key).toBe(false);
      expect(step(key).copies, key).toEqual([]);
    }

    // 中身が控えと合わない
    for (const [key, id] of [
      ['mismatch#1', 'att-short'],
      ['mismatch#2', 'att-long'],
      ['mismatch#3', 'att-corrupt'],
      ['mismatch#4', 'att-badsha'],
    ] as const) {
      expect(text(key), key).toBe(MISMATCH(id));
      expect(step(key).output.isError, key).toBe(false);
      // 写しのファイルは残らず、id のディレクトリだけが空で残る（場面の中で積み上がる）
      expect(step(key).copies, key).toContain(`${id}/`);
      expect(
        step(key).copies.filter((entry) => !entry.endsWith('/')),
        key,
      ).toEqual([]);
      expect(step(key).streamDestroyed, key).toBe(true);
    }
    expect(ops('mismatch#1')).toEqual(['attachments.open', 'inlineContent.read']);
    expect(text('mismatch-stale-copy#1')).toBe(MISMATCH('att-stale'));
    expect(step('mismatch-stale-copy#1').copies).toEqual(['att-stale/']);
    expect(text('mismatch-stale-copy#2')).toBe(MISMATCH('att-stale'));

    // それ以外の理由
    for (const [key, id] of [
      ['unsafe-id#1', 'att-u1'],
      ['unsafe-id#2', 'att-u2'],
      ['unsafe-id#3', 'att-u3'],
      ['unsafe-id#4', 'att-u4'],
      ['unsafe-id#5', 'att-u5'],
    ] as const) {
      expect(text(key), key).toBe(UNSAFE(id));
      expect(ops(key), key).toEqual(['attachments.open']);
      expect(step(key).copies, key).toEqual([]);
      expect(step(key).streamDestroyed, key).toBe(true);
    }
    // 128 字（`a` + 127 字）の id は通る
    expect(text('unsafe-id#6')).toContain('を取り出した。');

    // 例外
    expect(text('open-throws#1')).toBe(FAILED('att-o', 'Error: 置き場に繋がらない（test）'));
    expect(text('open-throws#2')).toBe(FAILED('att-o', 'raw string failure'));
    expect(text('open-throws#3')).toBe(FAILED('att-o', 'Error: 一行目'));
    expect(text('open-throws#4')).toContain('TOKEN=[REDACTED]');
    expect(text('open-throws#4')).not.toContain(FAKE_VALUE);
    expect(text('open-throws#5')).toContain('接続できない [REDACTED]');
    expect(text('open-throws#5')).not.toContain(FAKE_VALUE);
    for (const key of [
      'open-throws#1',
      'open-throws#2',
      'open-throws#3',
      'open-throws#4',
      'open-throws#5',
    ]) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).output.isError, key).toBe(false);
      expect(ops(key), key).toEqual(['attachments.open']);
      expect(step(key).copies, key).toEqual([]);
    }
    expect(text('open-throws#6')).toContain('を取り出した。');
    expect(text('stream-throws#1')).toBe(
      FAILED('att-s1', 'Error: 置き場の読みが始まらない（test）'),
    );
    expect(text('stream-throws#2')).toBe(
      FAILED('att-s2', 'Error: 置き場の読みが途中で切れた（test）'),
    );
    expect(text('stream-throws#3')).toBe(FAILED('att-s3', 'raw string failure'));
    for (const [key, id] of [
      ['stream-throws#1', 'att-s1'],
      ['stream-throws#2', 'att-s2'],
      ['stream-throws#3', 'att-s3'],
    ] as const) {
      // 一時ファイルは消え、id のディレクトリだけが空で残る
      expect(step(key).copies, key).toContain(`${id}/`);
      expect(
        step(key).copies.filter((entry) => !entry.endsWith('/') && !entry.startsWith('att-s4/')),
        key,
      ).toEqual([]);
      expect(step(key).streamDestroyed, key).toBe(true);
    }
    expect(step('stream-throws#2').calls[1]?.outcome).toBe('threw Error after 5 bytes');
    expect(step('stream-throws#4').copies).toContain(
      `att-s4/s4.txt (10 B, sha256=${shaOf('older copy').slice(0, 12)})`,
    );
    expect(text('retry-after-failure#1')).toContain('を取り出せなかった: Error:');
    expect(text('retry-after-failure#2')).toContain('を取り出した。');
    expect(text('retry-after-failure#2')).not.toContain('使い回した');
    expect(text('retry-after-failure#3')).toContain('（既にあった写しを使い回した）');
    expect(text('copies-blocked')).toContain(
      `を取り出せなかった: Error: EEXIST: file already exists, mkdir '${COPIES_MARK}/att-blocked'`,
    );
    expect(ops('copies-blocked')).toEqual(['attachments.open']);
    expect(step('copies-blocked').streamDestroyed).toBe(true);
  });
});
