import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import {
  AttachmentContentRemoveError,
  type AttachmentMeta,
  type AttachmentStore,
} from './attachment.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `file_delete` の出力（全文と字数）と、呼んだあとの状態（添付の控えの行・中身・取り出した写しのファイル・日誌へ足された行）・呼びの並び
// （`journal.append`・`attachments.getMeta`・`attachments.remove`・その下の外部の置き場の削除）を、
// 場面ごとにコミットした固定値（clone-tools-file-delete-output-pin.json）と丸ごと比べる。
// `clone-tools-attach.ts` の `tool('file_delete', …)`（`deleteFile` の呼びと、`JournalNotRecordedError` は投げ直し・ほかは「消せなかった」の文にする catch）と、
// `file-tools.ts` の `deleteFile` を直す前の歯。固定値の側で値を伏せず、入力（時計・id・控え・置き場の振る舞い）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - wrote: 呼ぶ前から変わったもの。none（日誌も添付も写しも同じ）/ journal（日誌だけ）/ attachment（控え・中身・写しのどれか。日誌も足されうる）。場面ごとの宣言と実際が合うことも確かめる
//   - attachments: 呼んだあとの控えの全行（置き場の行のまま）と、外部の置き場に残った中身の id
//   - copies: 呼んだあとの写しの置き場（`attachmentCopiesDir`）に残ったファイル（相対パス）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・id・at）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: 呼びの並び（`journal.append` の引数と結果・`attachments.getMeta/remove`・外部の置き場の削除。結果・失敗付き）
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_FILE_DELETE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-file-delete-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-file-delete-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、控え・写し・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。
// 添付の置き場は、id・外部の置き場の失敗を作るため場面ごとに作る小さな偽の置き場（getMeta / remove だけが本物の振る舞いで、ほかは使わない）で差し替える。
// 写しの置き場は場面ごとの一時ディレクトリ（`context.attachmentCopiesDir`）で、試験の後に消す。パスは json に残さない（相対パスだけ）。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 作れなかった分岐（理由）:
//   - 本物の外部の置き場（S3 など）に中身を預けた形: 偽の置き場の `external` で「中身を先に消し、消せたら行を消す」順を写す。本物の置き場の失敗の中身は作らない。
//   - `deleteFile` の引数 `beforeRemove` などを渡さない呼び方: 道具は必ず3つとも渡すので、道具の試験では通らない（`file-tools.test.ts` の領分）。
//   - 引数の検査（id が空文字）: zod の検査はハンドラの外（SDK 側）にあり、ハンドラへ直接渡す本試験では通らない。
//
// 秘密: 値は作りものだけ（`FAKE_NOT_A_REAL_VALUE_…`）。理由の文に作りものの値が入る場面は、いまの振る舞い（`reasonOf` は伏せない）をそのまま固定する。
// そのため json にはその作りものの値が残る（本物ではない）。固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み。none: 何も変わらない / journal: 日誌だけ足された / attachment: 控え・中身・写しのどれかが変わった */
type Writes = 'none' | 'journal' | 'attachment';

type RemoveMode =
  | { kind: 'ok' }
  | { kind: 'content-error'; reason: string }
  | { kind: 'throws-error'; message: string }
  | { kind: 'throws-string'; value: string };

interface Hooks {
  /** `journal.append` の何回目（この呼びの中・1 から）を投げさせるか */
  journalFailsAt: number[];
  /** `attachments.getMeta` が投げる */
  getMetaThrows: boolean;
  remove: RemoveMode;
  /** `getMeta` が控えを返した直後に、別の手が行を消す（控えを読んだ後に消えていた回） */
  raceAfterGetMeta: boolean;
}

interface SeedAttachment {
  id: string;
  name: string;
  size?: number;
  mediaType?: string;
  uploadedBy?: string;
  kept?: boolean;
  conversationId?: string;
  /** 外部の置き場に中身を預けた（中身を先に消す） */
  external?: boolean;
  /** 取り出した写しが写しの置き場に在る */
  copy?: boolean;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
  /** 呼ぶ前に、行の無い id の写しだけを置く（本体が先に消えて取り残された写し） */
  strayCopies?: string[];
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
const KEPT_ISO = '2026-10-28T06:00:00.000Z';
const EXPIRES_ISO = '2026-11-27T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-file-delete-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_FILE_DELETE_PIN === '1';

function callTime(index: number): number {
  return BASE_MS + index * 60_000;
}

/** 作りものの値（本物ではない）。理由の文に混ぜて、伏せられるかどうかをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function d(id: string, extra: Args = {}): Args {
  return { id, ...extra };
}

function w(args: Args, writes: Writes, hooks?: Partial<Hooks>, strayCopies?: string[]): Step {
  return {
    args,
    writes,
    ...(hooks === undefined ? {} : { hooks }),
    ...(strayCopies === undefined ? {} : { strayCopies }),
  };
}

const SCENARIOS: Scenario[] = [
  // ---- 消せる ----
  {
    name: 'delete-ok',
    group: '消せる',
    covers:
      '消せる: 保存の印あり・なし、写しあり・なし。先の日誌（控えの要約）→ 行を消す → 写しを消す。出力は名前・id・大きさと「日誌に残る」の一文。保存の印があっても消える。他の添付は残る',
    seed: [
      {
        name: 'kept-with-copy.png',
        id: 'att-kept-copy',
        kept: true,
        copy: true,
        uploadedBy: 'operator',
        mediaType: 'image/png',
        size: 2048,
      },
      { name: 'plain.txt', id: 'att-plain', uploadedBy: 'clone', size: 12 },
      {
        name: 'kept-no-copy.pdf',
        id: 'att-kept',
        kept: true,
        uploadedBy: 'account:acc-1',
        size: 500,
      },
      {
        name: 'plain-copy.txt',
        id: 'att-plain-copy',
        copy: true,
        conversationId: 'conv-1',
        uploadedBy: 'manager:mgr-1',
        size: 7,
      },
      { name: 'untouched.txt', id: 'att-untouched', size: 1 },
    ],
    steps: [
      w(d('att-kept-copy'), 'attachment'),
      w(d('att-plain'), 'attachment'),
      w(d('att-kept'), 'attachment'),
      w(d('att-plain-copy'), 'attachment'),
    ],
  },
  {
    name: 'delete-external',
    group: '消せる',
    covers:
      '外部の置き場に預けた中身がある: 置き場の中身を先に消し、消せたら控えの行を消す。写しもあれば消える。呼びの並びは getMeta → 外部の削除 → remove。置き場の中身の無い添付は外部の削除を呼ばない',
    seed: [
      {
        name: 'big.bin',
        id: 'att-ext',
        external: true,
        copy: true,
        size: 5_000_000,
        uploadedBy: 'integration:key-1',
      },
      { name: 'small.bin', id: 'att-inline', size: 3 },
    ],
    steps: [w(d('att-ext'), 'attachment'), w(d('att-inline'), 'attachment')],
  },
  {
    name: 'delete-twice',
    group: '消せる',
    covers:
      '同じ id を続けて消す: 1 回目は消せる。2 回目は控えが読めず「無い」（日誌には何も書かない）',
    seed: [{ name: 'twice.txt', id: 'att-twice', copy: true, size: 4 }],
    steps: [w(d('att-twice'), 'attachment'), w(d('att-twice'), 'none')],
  },

  // ---- 無い id ----
  {
    name: 'missing',
    group: '無い id',
    covers:
      '控えが読めない id（期限切れで消えた・id の誤り）: 「無い」と返り、日誌には何も書かない（先の行も打ち消しの行も無い）。remove は呼ぶ。他の添付は残る。パスにできない id（`../x`）でも同じ文',
    seed: [{ name: 'other.txt', id: 'att-other', size: 1 }],
    steps: [w(d('att-ghost'), 'none'), w(d('../x'), 'none'), w(d('a b'), 'none')],
  },
  {
    name: 'missing-stray-copy',
    group: '無い id',
    covers:
      '控えは無いが取り残された写しが在る: 「無い」と返り、写しは消える（日誌は書かない。写しの後始末は本体が無くても行う）。パスにできない id の写しは触らない',
    steps: [w(d('att-stray'), 'attachment', {}, ['att-stray']), w(d('att-stray'), 'none')],
  },
  {
    name: 'get-meta-throws',
    group: '無い id',
    covers:
      '控えの読みが落ちる: 先の日誌も remove も呼ばず、「消せなかった（もう一度試すと直る場合がある）」の文（isError ではない）。何も変わらない',
    seed: [{ name: 'a.txt', id: 'att-a', copy: true, size: 1 }],
    steps: [w(d('att-a'), 'none', { getMetaThrows: true })],
  },

  // ---- 先の日誌 ----
  {
    name: 'journal-first-fails',
    group: '先の日誌',
    covers:
      '先の日誌が書けない: 何も消さず（remove も写しの削除も呼ばない）、JournalNotRecordedError（act-not-performed）を投げ直す。控え・写しは残る。2 回目も落ちる指定でも 1 回目で止まる。外部の置き場の中身も残る。日誌が戻れば次の呼びは消せる',
    seed: [
      { name: 'keep-me.txt', id: 'att-keep', copy: true, kept: true, size: 9 },
      { name: 'ext.bin', id: 'att-ext', external: true, size: 99 },
    ],
    steps: [
      w(d('att-keep'), 'none', { journalFailsAt: [1] }),
      w(d('att-ext'), 'none', { journalFailsAt: [1, 2] }),
      w(d('att-keep'), 'attachment'),
    ],
  },
  {
    name: 'journal-first-fails-missing',
    group: '先の日誌',
    covers: '無い id では先の日誌は呼ばれない（日誌が落ちる指定でも「無い」が返る）',
    steps: [w(d('att-ghost'), 'none', { journalFailsAt: [1] })],
  },

  // ---- 外部の置き場から消せない ----
  {
    name: 'content-refused',
    group: '外部の置き場から消せない',
    covers:
      '外部の置き場から消せない（AttachmentContentRemoveError）: 「消していない（控えも残した）」と理由を返し（isError ではない）、控えも写しも残る。日誌は先の行と断りの行（appendJournalOrDrop）。もう一度呼ぶと再試行して消せる。控えが無い id では起きない',
    seed: [{ name: 'ext.bin', id: 'att-ext', external: true, copy: true, size: 10 }],
    steps: [
      w(d('att-ext'), 'journal', {
        remove: { kind: 'content-error', reason: '置き場が応答しない' },
      }),
      w(d('att-ext'), 'attachment'),
    ],
  },
  {
    name: 'content-refused-journal-fails',
    group: '外部の置き場から消せない',
    covers:
      '外部の置き場から消せず、断りの行も落ちる: 断りの結果は変わらず（握る）、日誌には先の行だけが残り、stderr に跡が 1 つ',
    seed: [{ name: 'ext.bin', id: 'att-ext', external: true, size: 10 }],
    steps: [
      w(d('att-ext'), 'journal', {
        journalFailsAt: [2],
        remove: { kind: 'content-error', reason: '置き場が応答しない' },
      }),
    ],
  },

  // ---- 控えを読んだ後に消えていた ----
  {
    name: 'already-gone',
    group: '控えを読んだ後に消えていた',
    covers:
      '控えを読んだ後に別の手で消えていた（remove が false）: 先の「消す」の行のあとに打ち消しの行（appendJournalOrDrop）。出力は「無い」。写しは本体が無くても消える',
    seed: [{ name: 'gone.txt', id: 'att-gone', copy: true, kept: true, size: 6 }],
    steps: [w(d('att-gone'), 'attachment', { raceAfterGetMeta: true })],
  },
  {
    name: 'already-gone-journal-fails',
    group: '控えを読んだ後に消えていた',
    covers:
      '同じで、打ち消しの行も落ちる: 「無い」の結果は変わらず（握る）、先の行だけが残り、stderr に跡',
    seed: [{ name: 'gone.txt', id: 'att-gone', copy: true, size: 6 }],
    steps: [w(d('att-gone'), 'attachment', { raceAfterGetMeta: true, journalFailsAt: [2] })],
  },

  // ---- ほかの例外 ----
  {
    name: 'remove-throws',
    group: 'ほかの例外',
    covers:
      '`remove` がほかの例外（ストアの失敗）を投げる: 断りの行も打ち消しの行も足さない（先の行だけが残る）。写しも消さない。出力は「消せなかった（もう一度試すと直る場合がある）」（isError ではない）。Error の message（reasonOf）・文字列を投げた場合',
    seed: [{ name: 'a.txt', id: 'att-a', copy: true, size: 1 }],
    steps: [
      w(d('att-a'), 'journal', {
        remove: { kind: 'throws-error', message: '行を消せない（test）' },
      }),
      w(d('att-a'), 'journal', { remove: { kind: 'throws-string', value: 'raw string failure' } }),
      w(d('att-a'), 'attachment'),
    ],
  },
  {
    name: 'remove-throws-multiline',
    group: 'ほかの例外',
    covers:
      '例外の message に改行を含む: reasonOf は最初の 1 行だけを使う（二行目以降は出ない）。先の日誌が落ちる指定は無関係（先の行は通る）',
    seed: [{ name: 'a.txt', id: 'att-a', size: 1 }],
    steps: [
      w(d('att-a'), 'journal', {
        remove: { kind: 'throws-error', message: '一行目\n\n   二行目' },
      }),
    ],
  },

  // ---- 秘密らしい値 ----
  {
    name: 'reason-with-value',
    group: '理由の文に値が入る',
    covers:
      '理由の文に作りものの値が入る（いまの振る舞いのまま固定）: 置き場が返した理由（AttachmentContentRemoveError.reason）は伏せずに、出力にも断りの行の grounds にもそのまま入る。投げられた例外の message は reasonOf を通り、`名前=値` も長い値だけの文も [REDACTED] になる。日誌の先の行（控えの要約）は値を含まない',
    seed: [
      { name: 'ext.bin', id: 'att-ext', external: true, size: 10 },
      { name: 'a.txt', id: 'att-a', size: 1 },
    ],
    steps: [
      w(d('att-ext'), 'journal', {
        remove: { kind: 'content-error', reason: `認証に失敗した export TOKEN=${FAKE_VALUE}` },
      }),
      w(d('att-a'), 'journal', {
        remove: { kind: 'throws-error', message: `接続できない TOKEN=${FAKE_VALUE}` },
      }),
      w(d('att-a'), 'journal', {
        remove: { kind: 'throws-error', message: `接続できない ${FAKE_VALUE}` },
      }),
    ],
  },

  // ---- 名前・種類・大きさの境目 ----
  {
    name: 'meta-forms',
    group: '控えの文（名前・種類・大きさ）',
    covers:
      '日誌の控えの文（describeAttachmentForJournal）と出力の大きさの表記の境目: 1 字の名前・長い名前（300 字）・日本語の名前・空の種類・大きさ 0 / 1023 / 1024 / 1048576（B → KiB → MiB の境）。出所の分類（clone / human / manager / integration / 不明）。保存中の時刻の入り方',
    seed: [
      { name: 'a', id: 'att-m1', size: 0, uploadedBy: 'clone' },
      { name: spaced(300, 'longname'), id: 'att-m2', size: 1023, uploadedBy: 'operator' },
      {
        name: '日本語のファイル名.txt',
        id: 'att-m3',
        size: 1024,
        uploadedBy: 'manager:mgr-1',
        kept: true,
      },
      {
        name: 'no-type',
        id: 'att-m4',
        size: 1_048_576,
        mediaType: '',
        uploadedBy: 'integration:key-1',
      },
      { name: 'unknown-from', id: 'att-m5', size: 1_048_575, uploadedBy: 'something-else' },
      { name: 'name with  spaces', id: 'att-m6', size: 1536, kept: true, conversationId: 'conv-1' },
    ],
    steps: [
      w(d('att-m1'), 'attachment'),
      w(d('att-m2'), 'attachment'),
      w(d('att-m3'), 'attachment'),
      w(d('att-m4'), 'attachment'),
      w(d('att-m5'), 'attachment'),
      w(d('att-m6'), 'attachment'),
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
  /** 呼んだあとの控えの全行 */
  attachments: Record<string, unknown>[];
  /** 外部の置き場に残った中身の id */
  externalBlobs: string[];
  /** 呼んだあとに写しの置き場に残ったファイル（相対パス） */
  copies: string[];
  journal: Record<string, unknown>[];
  dropped: string[];
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
  return {
    journalFailsAt: [],
    getMetaThrows: false,
    remove: { kind: 'ok' },
    raceAfterGetMeta: false,
  };
}

function record(calls: PinnedCall[], op: string, args: unknown): PinnedCall {
  const entry: PinnedCall = { op, args: plain(args), outcome: '(まだ戻っていない)' };
  calls.push(entry);
  return entry;
}

function countOf(calls: PinnedCall[], op: string): number {
  return calls.filter((entry) => entry.op === op).length;
}

interface Row {
  meta: AttachmentMeta;
  external: boolean;
}

/** `file_delete` が使う口（getMeta / remove）だけを持つ偽の置き場。行と外部の置き場の中身を持ち、呼びを記録する */
class FakeAttachments {
  readonly rows = new Map<string, Row>();
  readonly externalBlobs = new Set<string>();
  hooks: Hooks = freshHooks();
  calls: PinnedCall[] = [];

  seed(spec: SeedAttachment): void {
    const meta: AttachmentMeta = {
      id: spec.id,
      name: spec.name,
      mediaType: spec.mediaType ?? 'text/plain',
      size: spec.size ?? 10,
      sha256: `sha-fake-${spec.id}`,
      ...(spec.conversationId === undefined ? {} : { conversationId: spec.conversationId }),
      ...(spec.uploadedBy === undefined ? {} : { uploadedBy: spec.uploadedBy }),
      createdAt: CREATED_ISO,
      ...(spec.kept === true ? { keptAt: KEPT_ISO } : { expiresAt: EXPIRES_ISO }),
    };
    this.rows.set(spec.id, { meta, external: spec.external === true });
    if (spec.external === true) this.externalBlobs.add(spec.id);
  }

  asStore(): AttachmentStore {
    const unused = async (): Promise<never> => {
      throw new Error('この試験では使わない');
    };
    return {
      put: unused,
      get: unused,
      putStream: unused,
      open: unused,
      getMeta: async (id: string) => {
        const entry = record(this.calls, 'attachments.getMeta', { id });
        if (this.hooks.getMetaThrows) {
          entry.outcome = 'threw Error';
          throw new Error('控えが読めない（test）');
        }
        const row = this.rows.get(id);
        entry.outcome = row === undefined ? 'undefined' : 'found';
        if (row !== undefined && this.hooks.raceAfterGetMeta) {
          // 別の手が、控えを読んだ直後に行を消す（呼びには残さない）
          this.rows.delete(id);
          this.externalBlobs.delete(id);
        }
        return row?.meta;
      },
      bind: unused,
      bindToExternalEvent: unused,
      bindToManagerReport: unused,
      unbind: unused,
      prune: unused,
      sweepOrphanBlobs: unused,
      setKept: unused,
      remove: async (id: string) => {
        const entry = record(this.calls, 'attachments.remove', { id });
        const mode = this.hooks.remove;
        if (mode.kind === 'throws-error') {
          entry.outcome = 'threw Error';
          throw new Error(mode.message);
        }
        if (mode.kind === 'throws-string') {
          entry.outcome = 'threw string';
          // 非 Error を投げる枝を作る
          throw mode.value;
        }
        const row = this.rows.get(id);
        if (row === undefined) {
          entry.outcome = 'false';
          return false;
        }
        if (row.external) {
          const blob = record(this.calls, 'externalBlob.delete', { id });
          if (mode.kind === 'content-error') {
            blob.outcome = 'threw AttachmentContentRemoveError';
            entry.outcome = 'threw AttachmentContentRemoveError';
            throw new AttachmentContentRemoveError(id, mode.reason);
          }
          this.externalBlobs.delete(id);
          blob.outcome = 'ok';
        } else if (mode.kind === 'content-error') {
          entry.outcome = 'threw AttachmentContentRemoveError';
          throw new AttachmentContentRemoveError(id, mode.reason);
        }
        this.rows.delete(id);
        entry.outcome = 'true';
        return true;
      },
      list: unused,
      usage: unused,
      clear: unused,
    } as unknown as AttachmentStore;
  }
}

function writeCopy(copiesDir: string, id: string, name: string): void {
  mkdirSync(join(copiesDir, id), { recursive: true });
  writeFileSync(join(copiesDir, id, name), 'COPY');
}

function listCopies(copiesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(copiesDir, full));
    }
  };
  walk(copiesDir);
  return out.sort();
}

interface Snapshot {
  attachments: Record<string, unknown>[];
  externalBlobs: string[];
  copies: string[];
  journal: Record<string, unknown>[];
}

async function snapshot(
  fake: FakeAttachments,
  stores: Stores,
  copiesDir: string,
): Promise<Snapshot> {
  return {
    attachments: plain(
      [...fake.rows.values()].map((row) => ({ ...row.meta, external: row.external })),
    ),
    externalBlobs: [...fake.externalBlobs].sort(),
    copies: listCopies(copiesDir),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  // 掃除は vitest.setup.ts の afterAll が行う（直接 mkdtemp を呼ばない規則）
  const root = await makeTempDir('alteroid-file-delete-pin-');
  const copiesDir = join(root, 'copies');
  mkdirSync(copiesDir, { recursive: true });
  const base = createMemoryStores();
  const fake = new FakeAttachments();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const seed of scenario.seed ?? []) {
    fake.seed(seed);
    if (seed.copy === true)
      writeCopy(copiesDir, seed.id, seed.name.replaceAll(/\s+/gu, '_').slice(0, 40));
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
      dropped.length = 0;
      for (const id of step.strayCopies ?? []) writeCopy(copiesDir, id, 'stray.txt');
      const stores: Stores = {
        ...base,
        attachments: fake.asStore(),
        journal: {
          ...base.journal,
          append: async (input) => {
            const entry = record(calls, 'journal.append', input);
            if (fake.hooks.journalFailsAt.includes(countOf(calls, 'journal.append'))) {
              entry.outcome = 'threw Error: 日誌が落ちた';
              throw new Error('日誌が落ちた');
            }
            const written = await base.journal.append(input);
            entry.outcome = `ok ${written.id}`;
            return written;
          },
        },
      };
      const context: ToolContext = {
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        attachmentCopiesDir: copiesDir,
      };
      const found = createCloneTools(context).find((entry) => entry.name === 'file_delete');
      if (!found) throw new Error('file_delete が無い');

      const before = await snapshot(fake, stores, copiesDir);
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
      fake.hooks = freshHooks();
      const after = await snapshot(fake, stores, copiesDir);
      const attachmentChanged =
        JSON.stringify([before.attachments, before.externalBlobs, before.copies]) !==
        JSON.stringify([after.attachments, after.externalBlobs, after.copies]);
      const journalChanged = before.journal.length !== after.journal.length;
      const wrote: Writes = attachmentChanged ? 'attachment' : journalChanged ? 'journal' : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 書き込みの有無が宣言（${step.writes}）と違う`).toBe(step.writes);
      if (step.writes === 'none') {
        expect(after.journal.length, `場面 ${key}: 変えないはずが日誌へ行が足された`).toBe(
          before.journal.length,
        );
      }
      results.push({
        output,
        wrote,
        attachments: after.attachments,
        externalBlobs: after.externalBlobs,
        copies: after.copies,
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

describe('file_delete の出力と呼んだあとの状態の固定（場面ごとの出力の全文・控え・写し・日誌の行・呼びの並び）', () => {
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

      it(`${key} の呼んだあとの控え・中身・写しが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.attachments, `場面 ${key} の添付の控えの行が変わった`).toEqual(
          want?.attachments,
        );
        expect(got?.externalBlobs, `場面 ${key} の外部の置き場の中身が変わった`).toEqual(
          want?.externalBlobs,
        );
        expect(got?.copies, `場面 ${key} の写しのファイルが変わった`).toEqual(want?.copies);
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

  it('同じ入力で2回回すと、全場面で同じ出力・控え・写し・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に写しの置き場の絶対パスが入っていない。作りものの値は、伏せない振る舞いのとおり理由の場面にだけ在る', () => {
    expect(pinnedRaw).not.toContain('alteroid-file-delete-pin-');
    expect(pinnedRaw).not.toContain(tmpdir());
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-/);
    for (const key of ALL_KEYS) {
      const whole = JSON.stringify(actual[key]);
      if (key === 'reason-with-value#1') continue;
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
    const decisions = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.decision));
    const groundsOf = (key: string): string[] =>
      step(key).journal.map((entry) => String(entry.grounds));

    const MISSING = (id: string): string =>
      `添付 ${id} は無い（保持期限が過ぎて消えた、または id の誤り）。取り出していた写しがあれば消した。`;
    const RETRY = (id: string, reason: string): string =>
      `添付 ${id} は消していない（控えも残した）。中身を置き場から消せなかった。理由: ${reason}。もう一度 file_delete を呼ぶと再試行する。`;
    const FAILED = (id: string, reason: string): string =>
      `添付 ${id} を消せなかった: ${reason}（もう一度試すと直る場合がある）`;
    const DELETED_TAIL =
      ' の中身を消した。保存の印があっても消えている。attachment_fetch で取り出した写しも消した。取り戻せない。消す前の控え（名前・種類・大きさ・sha256・出所）は日誌に残る。';
    const PRE = (name: string, id: string): string => `添付の中身と控えを消す: ${name}（id=${id}）`;

    // 消せる
    expect(text('delete-ok#1')).toBe(
      `kept-with-copy.png（id=att-kept-copy、2.0 KiB）${DELETED_TAIL}`,
    );
    expect(text('delete-ok#2')).toBe(`plain.txt（id=att-plain、12 B）${DELETED_TAIL}`);
    expect(decisions('delete-ok#1')).toEqual([PRE('kept-with-copy.png', 'att-kept-copy')]);
    expect(groundsOf('delete-ok#1')[0]).toBe(
      `消す前の控え: id=att-kept-copy name=kept-with-copy.png type=image/png size=2048 sha256=sha-fake-att-kept-copy 出所=人間 保存中だった（${KEPT_ISO} から）`,
    );
    expect(groundsOf('delete-ok#2')[0]).toContain('出所=クローン 保存していなかった');
    expect(ops('delete-ok#1')).toEqual([
      'attachments.getMeta',
      'journal.append',
      'attachments.remove',
    ]);
    expect(step('delete-ok#1').copies).toEqual(['att-plain-copy/plain-copy.txt']);
    expect(step('delete-ok#4').copies).toEqual([]);
    expect(step('delete-ok#4').attachments.map((row) => row.id)).toEqual(['att-untouched']);
    expect(step('delete-ok#1').output.isError).toBe(false);
    expect(ops('delete-external#1')).toEqual([
      'attachments.getMeta',
      'journal.append',
      'attachments.remove',
      'externalBlob.delete',
    ]);
    expect(step('delete-external#1').externalBlobs).toEqual([]);
    expect(ops('delete-external#2')).not.toContain('externalBlob.delete');
    expect(text('delete-external#1')).toContain('（id=att-ext、4.8 MiB）');
    expect(text('delete-twice#2')).toBe(MISSING('att-twice'));
    expect(step('delete-twice#2').journal).toEqual([]);

    // 無い id
    for (const key of ['missing#1', 'missing#2', 'missing#3']) {
      expect(step(key).journal, key).toEqual([]);
      expect(ops(key), key).toEqual(['attachments.getMeta', 'attachments.remove']);
      expect(step(key).output.isError, key).toBe(false);
    }
    expect(text('missing#1')).toBe(MISSING('att-ghost'));
    expect(text('missing#2')).toBe(MISSING('../x'));
    expect(text('missing-stray-copy#1')).toBe(MISSING('att-stray'));
    expect(step('missing-stray-copy#1').wrote).toBe('attachment');
    expect(step('missing-stray-copy#1').copies).toEqual([]);
    expect(text('get-meta-throws')).toBe(FAILED('att-a', 'Error: 控えが読めない（test）'));
    expect(ops('get-meta-throws')).toEqual(['attachments.getMeta']);
    expect(step('get-meta-throws').output.thrown).toBe(false);

    // 先の日誌
    for (const key of ['journal-first-fails#1', 'journal-first-fails#2']) {
      expect(step(key).output.errorName, key).toBe('JournalNotRecordedError');
      expect(step(key).output.thrown, key).toBe(true);
      expect(text(key), key).toContain('file_delete');
      expect(ops(key), key).toEqual(['attachments.getMeta', 'journal.append']);
      expect(step(key).journal, key).toEqual([]);
      expect(step(key).wrote, key).toBe('none');
    }
    expect(step('journal-first-fails#2').externalBlobs).toEqual(['att-ext']);
    expect(ops('journal-first-fails#3')).toContain('attachments.remove');
    expect(step('journal-first-fails#3').journal).toHaveLength(1);
    expect(text('journal-first-fails-missing')).toBe(MISSING('att-ghost'));
    expect(ops('journal-first-fails-missing')).not.toContain('journal.append');

    // 外部の置き場から消せない
    expect(text('content-refused#1')).toBe(RETRY('att-ext', '置き場が応答しない'));
    expect(step('content-refused#1').output.isError).toBe(false);
    expect(decisions('content-refused#1')).toEqual([
      PRE('ext.bin', 'att-ext'),
      '添付の中身を置き場から消せなかったので、消していない（控えも残した）: ext.bin（id=att-ext）',
    ]);
    expect(groundsOf('content-refused#1')[1]).toBe(
      '理由: 置き場が応答しない。直前の「消す」の行は実行されていない。もう一度 file_delete で再試行できる。',
    );
    expect(step('content-refused#1').copies).toEqual(['att-ext/ext.bin']);
    expect(step('content-refused#1').externalBlobs).toEqual(['att-ext']);
    expect(text('content-refused#2')).toContain('ext.bin（id=att-ext、10 B）');
    expect(step('content-refused#2').copies).toEqual([]);
    expect(text('content-refused-journal-fails')).toBe(RETRY('att-ext', '置き場が応答しない'));
    expect(step('content-refused-journal-fails').journal).toHaveLength(1);
    expect(step('content-refused-journal-fails').dropped).toHaveLength(1);

    // 控えを読んだ後に消えていた
    expect(text('already-gone')).toBe(MISSING('att-gone'));
    expect(decisions('already-gone')).toEqual([
      PRE('gone.txt', 'att-gone'),
      '直前の添付の削除の行は効いていない（この呼びでは消していない）: gone.txt（id=att-gone）',
    ]);
    expect(groundsOf('already-gone')[1]).toBe(
      '消す直前に、添付が置き場から無くなっていた（期限切れ・別の手で消された）',
    );
    expect(step('already-gone').copies).toEqual([]);
    expect(text('already-gone-journal-fails')).toBe(MISSING('att-gone'));
    expect(step('already-gone-journal-fails').journal).toHaveLength(1);
    expect(step('already-gone-journal-fails').dropped).toHaveLength(1);

    // ほかの例外
    expect(text('remove-throws#1')).toBe(FAILED('att-a', 'Error: 行を消せない（test）'));
    expect(text('remove-throws#2')).toBe(FAILED('att-a', 'raw string failure'));
    for (const key of ['remove-throws#1', 'remove-throws#2']) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).journal, key).toHaveLength(1);
      expect(step(key).copies, key).toEqual(['att-a/a.txt']);
    }
    expect(text('remove-throws#3')).toContain('の中身を消した');
    expect(text('remove-throws-multiline')).toBe(FAILED('att-a', 'Error: 一行目'));

    // 理由の文の値は伏せない（いまの振る舞い）
    expect(text('reason-with-value#1')).toContain(FAKE_VALUE);
    expect(groundsOf('reason-with-value#1')[1]).toContain(FAKE_VALUE);
    // 例外の message は reasonOf の伏せ字を通る（`名前=値` も、長い値だけの文も伏せる）
    expect(text('reason-with-value#2')).toContain('TOKEN=[REDACTED]');
    expect(text('reason-with-value#2')).not.toContain(FAKE_VALUE);
    expect(text('reason-with-value#3')).toContain('接続できない [REDACTED]');
    expect(text('reason-with-value#3')).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(step('reason-with-value#1').journal[0])).not.toContain(FAKE_VALUE);

    // 控えの文
    expect(text('meta-forms#1')).toContain('（id=att-m1、0 B）');
    expect(text('meta-forms#2')).toContain('、1023 B）');
    expect(text('meta-forms#3')).toContain('、1.0 KiB）');
    expect(text('meta-forms#4')).toContain('、1.0 MiB）');
    expect(text('meta-forms#5')).toContain('、1024.0 KiB）');
    expect(groundsOf('meta-forms#3')[0]).toContain('出所=マネージャー 保存中だった（');
    expect(groundsOf('meta-forms#4')[0]).toContain('type= ');
    expect(groundsOf('meta-forms#4')[0]).toContain('出所=連携');
    expect(groundsOf('meta-forms#5')[0]).toContain('出所=不明');
    expect(groundsOf('meta-forms#1')[0]).toContain('name=a type=text/plain size=0');
    expect(decisions('meta-forms#2')[0]).toContain(spaced(300, 'longname'));
  });
});
