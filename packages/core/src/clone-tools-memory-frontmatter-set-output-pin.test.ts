import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import { memoryVersion, MemoryConflictError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `memory_frontmatter_set` の出力（全文と字数）と、呼んだあとの状態（記憶の本文・日誌へ足された行・ストアの書き込み口の呼び）を、
// 場面ごとにコミットした固定値（clone-tools-memory-frontmatter-set-output-pin.json）と丸ごと比べる。
// `clone-tools-memory.ts` の `tool('memory_frontmatter_set', …)`（約 150 行・入れ子 5 段の式）を部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・記憶の本文）を固定して毎回同じにする。
// この道具は記憶を書き換えるので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - memory: 場面で触れた記憶を、呼んだあとにストアから読んだ形のまま（版 version・frontmatter・updatedAt を含む）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - storeCalls: 記憶のストアの書き込み口（persona.write）の呼びの並び（slug・本文・版の照合の引数 ifMatch・結果）
//   - wrote: 記憶か日誌のどれかが呼ぶ前から変わったか。断った・何もしなかった場面は false で、記憶と日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MEMORY_FRONTMATTER_SET_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-memory-frontmatter-set-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-memory-frontmatter-set-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、記憶・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 記憶は場面の頭に基準時刻で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（updatedAt・日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
//
// 作れない分岐:
//   - 日誌が書けない「行為の前」: この道具は記憶を書いたあとにだけ日誌を書く（'act-completed' 固定）ので、行為の前に日誌が落ちる経路が無い
//   - キーを消す: この道具は「渡したキーを差し替える・足す」だけで、キーを消す口が無い（空文字を渡すと `key: ` の行が残る）
//   - 保護状態 unknown を実際のストアで作る: インメモリの器は書き込み済みの文書を unknown にできないので、`protectionStatus` を差し替えて作る

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（記憶か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

interface SeedDoc {
  slug: string;
  content: string;
  /** 真なら人間が触った印（保護状態 human）を付ける */
  human?: boolean;
}

/** 場面の中で呼びごとに差し替える口（器の振る舞いと「誰の走行か」） */
interface Hooks {
  cause: 'clone' | 'distill';
  /** この slug への persona.write だけ投げる */
  failWriteSlug: string | null;
  /** この slug の persona.read だけ投げる */
  failReadSlug: string | null;
  /** この slug を最初に読んだ直後に、別の内容を書き込む（content が null なら消す）。読んでから書くまでの間に変わる場面 */
  raceOnRead: { slug: string; content: string | null } | null;
  /** persona.documents() のこの呼びの n 回目（1 から）を投げさせる */
  failDocumentsAt: number | null;
  /** protectionStatus を差し替える */
  protection: 'unknown' | null;
  /** 環境変数 ALTEROID_MEMORY_GUARD の値（null なら未設定） */
  guardEnv: string | null;
}

/** 呼ぶ時点でストアにある文書の版へ置き換える印 */
const AUTO = '<auto>';

interface Step {
  args: Args;
  writes: Writes;
  /** 呼ぶ直前に器の口を設定する */
  before?: (hooks: Hooks) => void;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedDoc[];
  steps: Step[];
  /** journal.append の何回目（場面の通し・1 から）を投げさせるか */
  journalFailsAt?: number[];
  /** 渡すと runtime（セッション構築時点に焼いた記憶の文字数）を持った器にする */
  injectedMemoryChars?: number;
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const HUMAN_ISO = '2026-10-28T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-memory-frontmatter-set-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MEMORY_FRONTMATTER_SET_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

// ---- 記憶の本文（入力） ----

const BODY = [
  '# 価値観',
  '',
  '## 判断の基準',
  '',
  '本文1行目。',
  '本文2行目。',
  '',
  '## 好み',
  '',
  '- 箇条書き1',
  '- 箇条書き2',
  '',
  '### 細目',
  '',
  '最後の段落。',
  '',
].join('\n');

const NONE_DOC = BODY;
const PREMISE_DOC = `---\ndescription: 元の要旨\ntype: premise\n---\n${BODY}`;
const FACT_DOC = `---\ndescription: 元の要旨\ntype: fact\n---\n${BODY}`;
const INDEXED_DOC = `---\ndescription: 元の要旨\ntype: indexed\n---\n${BODY}`;
const FULL_DOC = `---\ndescription: 元の要旨\ntype: fact\nparent: root\n---\n${BODY}`;
const DESC_ONLY_DOC = `---\ndescription: 元の要旨\n---\n${BODY}`;
const REORDER_DOC = `---\nparent: root\ntype:  fact\ndescription:   元の要旨  \n---\n${BODY}`;
const DUPKEY_DOC = `---\ndescription: 先\ndescription: 後\n---\n${BODY}`;
const EMPTY_FM_DOC = `---\n---\n${BODY}`;
const EMPTY_BODY_DOC = '---\ndescription: 元の要旨\n---\n';
const CRLF_DOC = '---\r\ndescription: 元の要旨\r\ntype: premise\r\n---\r\n# 表紙\r\n本文\r\n';
const RULE_BODY_DOC =
  '---\ndescription: 元の要旨\n---\n# 表紙\n---\n本文の中の区切り\n---\n終わり\n';
const NONE_RULE_DOC = '# 表紙\n---\n本文の中の区切り\n';
const WEIRD_TYPE_DOC = `---\ndescription: 旧\ntype: weird\n---\n${BODY}`;
const SPACED_DELIM_DOC = `--- \ndescription: 元の要旨\n---  \n${BODY}`;
const MAL_UNCLOSED = '---\ndescription: 閉じが無い\n# 見出し\n本文\n';
const MAL_NOCOLON = '---\nno colon here\n---\n本文\n';
const MAL_UNKNOWN_KEY = '---\ndescription: x\nauthor: me\n---\n本文\n';

const OTHER_PREMISE = '---\ndescription: 別の前提\ntype: premise\n---\n# 別\n## 節\n本文\n';
const OTHER_FACT = '---\ndescription: 別の事実\ntype: fact\n---\n# 事実\n本文\n';

function sectionsOf(count: number, headingTail: string, body: string): string {
  return Array.from({ length: count }, (_, index) => {
    const pad = String(index).padStart(3, '0');
    return `# 節${pad}: ${headingTail}\n\n本文${pad}: ${body}\n`;
  }).join('\n');
}

/** 焼き込みの目次の予算に張り付く節数の premise（床の注記が動く） */
const BIG_TOC = `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${sectionsOf(100, 'み'.repeat(60), 'あ'.repeat(30))}`;

const LONG_VALUE_BEFORE = 'あ'.repeat(30);
const LONG_VALUE_AFTER = 'い'.repeat(30);

/** 版つきの呼び（版は呼ぶ時点のストアの文書から取る） */
function fm(slug: string, extra: Args = {}, summary = '直した'): Args {
  return { slug, summary, base_version: AUTO, ...extra };
}

const STALE_VERSION = memoryVersion('読んだときの内容とは別');

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      'slug が不正（英大文字・空白・空）・キーを1つも渡さない（既存の文書・無い文書・不正な slug）。検査の優先順（slug → キーが無い）。どれも何も変わらない',
    seed: [{ slug: 'values', content: DESC_ONLY_DOC }],
    steps: [
      { args: fm('Bad Slug', { description: '要旨' }), writes: 'none' },
      { args: fm('', { description: '要旨' }), writes: 'none' },
      { args: fm('Bad/Slug'), writes: 'none' },
      { args: fm('values'), writes: 'none' },
      { args: fm('nope'), writes: 'none' },
      { args: fm('values', { base_version: undefined }), writes: 'none' },
    ],
  },
  {
    name: 'line-breaks',
    covers:
      '改行を含む値は入口で断る: description・type・parent それぞれ（\\n・単独の \\r・\\r\\n）・位置と抜粋（先頭・前後の省略記号つき）・複数のキーが悪いときは description → type → parent の順・type の不正より先・無い文書／版なしでもストアを読む前に断る',
    seed: [{ slug: 'values', content: DESC_ONLY_DOC }],
    steps: [
      { args: fm('values', { description: 'a\n---\nb' }), writes: 'none' },
      { args: fm('values', { description: 'a\rb' }), writes: 'none' },
      { args: fm('values', { description: 'a\r\nb' }), writes: 'none' },
      { args: fm('values', { type: 'fact\n' }), writes: 'none' },
      { args: fm('values', { parent: 'root\ndescription: hijacked' }), writes: 'none' },
      { args: fm('values', { parent: '\r' }), writes: 'none' },
      { args: fm('values', { description: '\n先頭' }), writes: 'none' },
      { args: fm('values', { description: 'x\n', type: 'fact', parent: 'y\n' }), writes: 'none' },
      { args: fm('values', { description: 'ok', type: 'fact\n', parent: 'p\n' }), writes: 'none' },
      { args: fm('values', { description: 'ok', type: 'Bad', parent: 'p\n' }), writes: 'none' },
      {
        args: fm('values', { description: `${LONG_VALUE_BEFORE}\n${LONG_VALUE_AFTER}` }),
        writes: 'none',
      },
      { args: fm('nope', { description: 'a\nb' }), writes: 'none' },
      { args: { slug: 'values', summary: '版なし', description: 'a\nb' }, writes: 'none' },
    ],
  },
  {
    name: 'type-invalid',
    covers:
      'type が premise・indexed・fact 以外（綴り違い・大文字・空文字・前後の空白・未知の値）は断る・無い文書でもストアを読む前に断る・正しい type なら無い文書は「存在しない」へ進む',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    steps: [
      { args: fm('values', { type: 'Fact' }), writes: 'none' },
      { args: fm('values', { type: '' }), writes: 'none' },
      { args: fm('values', { type: 'premise ' }), writes: 'none' },
      { args: fm('values', { type: 'weird', description: '要旨' }), writes: 'none' },
      { args: fm('nope', { type: 'Fact' }), writes: 'none' },
      { args: fm('nope', { type: 'fact' }), writes: 'none' },
    ],
  },
  // ---- 文書の有無・読めない ----
  {
    name: 'doc-missing',
    covers:
      '文書が無い（版つき・版なし・distill から）。作らない。存在の確認は人間の歯・版の検査より先',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    steps: [
      { args: fm('nope', { description: '要旨' }), writes: 'none' },
      {
        args: { slug: 'nope', summary: '版なし', description: '要旨' },
        writes: 'none',
      },
      {
        args: fm('nope', { description: '要旨' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
    ],
  },
  {
    name: 'read-fails',
    covers:
      '文書を読むところで例外（ストアが落ちた）。例外のまま呼び手へ返る・何も書かない（日誌も）。別の slug の読みは落ちない',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'other', content: OTHER_FACT },
    ],
    steps: [
      {
        args: fm('values', { description: '要旨' }),
        writes: 'none',
        before: (hooks) => {
          hooks.failReadSlug = 'values';
        },
      },
      {
        args: fm('other', { description: '別の要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.failReadSlug = 'values';
        },
      },
    ],
  },
  // ---- 人間の歯（distill） ----
  {
    name: 'guard-distill',
    covers:
      'distill からは human（人間が触った印）・unknown（確認できない）の文書に断る（4要素の文言・action は「frontmatter の更新」）。断りは版の検査より先・clone-only は通る・clone からは human でも通る（日誌の cause）',
    seed: [
      { slug: 'human-doc', content: DESC_ONLY_DOC, human: true },
      { slug: 'unknown-doc', content: DESC_ONLY_DOC },
      { slug: 'clone-doc', content: DESC_ONLY_DOC },
    ],
    steps: [
      {
        args: fm('human-doc', { description: '蒸留が書き換えたい要旨' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
      {
        args: { slug: 'human-doc', summary: '版なし', description: '蒸留' },
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
      {
        args: fm('unknown-doc', { description: '蒸留' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
          hooks.protection = 'unknown';
        },
      },
      {
        args: fm('clone-doc', { description: '蒸留が付けた要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
      {
        args: fm('human-doc', { description: '会話の中で直した要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'clone';
        },
      },
    ],
  },
  {
    name: 'guard-env',
    covers:
      '歯の環境変数 ALTEROID_MEMORY_GUARD: off なら distill でも human に通る・綴り違いは例外（黙って既定へ倒さない）・on 相当（未設定）は断る',
    seed: [{ slug: 'human-doc', content: DESC_ONLY_DOC, human: true }],
    steps: [
      {
        args: fm('human-doc', { description: 'off にしたので通る' }),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'distill';
          hooks.guardEnv = 'off';
        },
      },
      {
        args: fm('human-doc', { description: '綴り違い' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
          hooks.guardEnv = 'maybe';
        },
      },
      {
        args: fm('human-doc', { description: '未設定' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
    ],
  },
  // ---- 版 ----
  {
    name: 'version',
    covers:
      '版: 版なし（断る・読み直しを求める）・空文字の版・古い版（衝突。いまの版と字数を名乗る）・正しい版。版なしの検査は壊れた frontmatter の検査より先',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'broken', content: MAL_NOCOLON },
    ],
    steps: [
      { args: { slug: 'values', summary: '版なし', description: '要旨' }, writes: 'none' },
      { args: fm('values', { description: '要旨', base_version: '' }), writes: 'none' },
      { args: fm('values', { description: '要旨', base_version: STALE_VERSION }), writes: 'none' },
      { args: { slug: 'broken', summary: '版なし', description: '要旨' }, writes: 'none' },
      { args: fm('values', { description: '正しい版で通る' }), writes: 'some' },
    ],
  },
  {
    name: 'version-race',
    covers:
      '読んだ後・書く前に誰かが書き換えた（版の食い違い。書き換えた人の内容のまま・日誌は空）・消した（いまその文書は無い）。割り込んだ側の書き込みだけが状態の変化',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'gone', content: FACT_DOC },
    ],
    steps: [
      {
        args: fm('values', { description: '道具の要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.raceOnRead = {
            slug: 'values',
            content: PREMISE_DOC.replace('元の要旨', '人間が直した要旨'),
          };
        },
      },
      {
        args: fm('gone', { description: '道具の要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.raceOnRead = { slug: 'gone', content: null };
        },
      },
    ],
  },
  // ---- frontmatter が壊れている ----
  {
    name: 'malformed',
    covers:
      '壊れた frontmatter（閉じが無い・コロンの無い行・未知のキー）は clone でも distill（clone-only）でも断り何も書かない。本文は触らない',
    seed: [
      { slug: 'unclosed', content: MAL_UNCLOSED },
      { slug: 'nocolon', content: MAL_NOCOLON },
      { slug: 'unknown-key', content: MAL_UNKNOWN_KEY },
    ],
    steps: [
      { args: fm('unclosed', { description: '直したい' }), writes: 'none' },
      { args: fm('nocolon', { type: 'fact' }), writes: 'none' },
      { args: fm('unknown-key', { parent: 'root' }), writes: 'none' },
      {
        args: fm('nocolon', { description: '蒸留' }),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
    ],
  },
  // ---- frontmatter が無い ----
  {
    name: 'patch-none',
    covers:
      'frontmatter が無い文書に先頭へ新しく作って足す: description だけ（区分は premise のまま）・type だけ（fact へ変わる）・parent だけ・3つ全部・本文に --- の区切りが在っても本文は無傷',
    seed: [
      { slug: 'a', content: NONE_DOC },
      { slug: 'b', content: NONE_DOC },
      { slug: 'c', content: NONE_DOC },
      { slug: 'd', content: NONE_DOC },
      { slug: 'e', content: NONE_RULE_DOC },
    ],
    steps: [
      { args: fm('a', { description: '新しい要旨' }), writes: 'some' },
      { args: fm('b', { type: 'fact' }), writes: 'some' },
      { args: fm('c', { parent: 'root' }), writes: 'some' },
      { args: fm('d', { description: '要旨', type: 'indexed', parent: 'root' }), writes: 'some' },
      { args: fm('e', { description: '要旨' }), writes: 'some' },
    ],
  },
  // ---- frontmatter が在る ----
  {
    name: 'patch-parsed',
    covers:
      '在る frontmatter の差し替え: description だけ・type だけ・parent だけ（渡さなかったキーは既存のまま）・空文字（キーの行が `key: ` で残る。消す口は無い）・正規化（キーの順序・空白・重複キー・空の frontmatter）',
    seed: [
      { slug: 'full', content: FULL_DOC },
      { slug: 'reorder', content: REORDER_DOC },
      { slug: 'dupkey', content: DUPKEY_DOC },
      { slug: 'empty-fm', content: EMPTY_FM_DOC },
    ],
    steps: [
      { args: fm('full', { description: '新しい要旨' }), writes: 'some' },
      { args: fm('full', { type: 'indexed' }), writes: 'some' },
      { args: fm('full', { parent: 'other-root' }), writes: 'some' },
      { args: fm('full', { description: '' }), writes: 'some' },
      { args: fm('full', { parent: '' }), writes: 'some' },
      { args: fm('reorder', { description: '直した' }), writes: 'some' },
      { args: fm('dupkey', { type: 'fact' }), writes: 'some' },
      { args: fm('empty-fm', { description: '要旨' }), writes: 'some' },
    ],
  },
  {
    name: 'patch-shapes',
    covers:
      '値の形・文書の形の各種: 本文が空・CRLF の文書・本文に --- の行・区切りの後ろに空白・未知の type（premise 扱い）を premise にする',
    seed: [
      { slug: 'empty-body', content: EMPTY_BODY_DOC },
      { slug: 'crlf', content: CRLF_DOC },
      { slug: 'rule-body', content: RULE_BODY_DOC },
      { slug: 'spaced', content: SPACED_DELIM_DOC },
      { slug: 'weird', content: WEIRD_TYPE_DOC },
    ],
    steps: [
      { args: fm('empty-body', { type: 'fact' }), writes: 'some' },
      { args: fm('crlf', { description: '新しい要旨' }), writes: 'some' },
      { args: fm('rule-body', { type: 'indexed' }), writes: 'some' },
      { args: fm('spaced', { description: '要旨' }), writes: 'some' },
      { args: fm('weird', { type: 'premise' }), writes: 'some' },
    ],
  },
  {
    name: 'patch-values',
    covers:
      '値の中身: 記号・--- を含む1行・絵文字・前後の空白（保存時はそのまま書き、読むと trim される）・長い要旨（約400字）・コロンを含む値',
    seed: [{ slug: 'values', content: DESC_ONLY_DOC }],
    steps: [
      { args: fm('values', { description: 'a---b（1行のまま）' }), writes: 'some' },
      { args: fm('values', { description: '  前後に空白  ' }), writes: 'some' },
      { args: fm('values', { description: '要旨: コロンを含む: 値' }), writes: 'some' },
      {
        args: fm('values', {
          description: '⭐ ⚠ ⟹ ／ 〜 長い要旨のための繰り返し文である。'.repeat(20),
        }),
        writes: 'some',
      },
    ],
  },
  // ---- 区分の変化 ----
  {
    name: 'kind-changes',
    covers:
      '区分の変化の注記: premise → fact → indexed → premise → indexed（変わるたびに「区分が変わった」と次のターンからの載り方）・同じ区分へ（indexed → indexed。注記なし）。他の文書（premise・fact）が在るので順位・床が動く',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'other-premise', content: OTHER_PREMISE },
      { slug: 'other-fact', content: OTHER_FACT },
    ],
    steps: [
      { args: fm('values', { type: 'fact' }), writes: 'some' },
      { args: fm('values', { type: 'indexed' }), writes: 'some' },
      { args: fm('values', { type: 'premise' }), writes: 'some' },
      { args: fm('values', { type: 'indexed' }), writes: 'some' },
      { args: fm('values', { type: 'indexed' }), writes: 'some' },
    ],
  },
  {
    name: 'kind-from-none',
    covers:
      '区分の元が無い（frontmatter 無し・type 無し）の文書: premise と書く（区分は同じで注記なし）・fact へ',
    seed: [
      { slug: 'plain', content: NONE_DOC },
      { slug: 'desc-only', content: DESC_ONLY_DOC },
    ],
    steps: [
      { args: fm('plain', { type: 'premise' }), writes: 'some' },
      { args: fm('desc-only', { type: 'fact' }), writes: 'some' },
    ],
  },
  // ---- 変わらない ----
  {
    name: 'unchanged',
    covers:
      '同じ値を渡す（実質の変更なし）: それでも書き込み・日誌が起きる（更新時刻・版は同じ内容なので変わらない）・渡したキーが既存と同じ・正規化だけが起きる文書（キーの順序・空白）',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'reorder', content: REORDER_DOC },
    ],
    steps: [
      { args: fm('values', { description: '元の要旨' }), writes: 'some' },
      { args: fm('values', { description: '元の要旨', type: 'premise' }), writes: 'some' },
      {
        args: fm('reorder', { description: '元の要旨', type: 'fact', parent: 'root' }),
        writes: 'some',
      },
    ],
  },
  // ---- 床・順位・runtime ----
  {
    name: 'floor-big',
    covers:
      '焼き込みの目次の予算に張り付いた premise を fact へ（床が大きく減る）・もう一度 premise へ（床が増える）・description だけ直す（変化なし）',
    seed: [
      { slug: 'big-toc', content: BIG_TOC },
      { slug: 'other-premise', content: OTHER_PREMISE },
    ],
    steps: [
      { args: fm('big-toc', { description: '直した' }), writes: 'some' },
      { args: fm('big-toc', { type: 'fact' }), writes: 'some' },
      { args: fm('big-toc', { type: 'premise' }), writes: 'some' },
    ],
  },
  {
    name: 'runtime-grows',
    covers:
      'runtime（セッション構築時点の記憶の文字数）が在る器: 構築時点が書いた後の総量より小さい（増える見込み・割合）',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    injectedMemoryChars: 100,
    steps: [{ args: fm('values', { description: '要旨を長くした'.repeat(5) }), writes: 'some' }],
  },
  {
    name: 'runtime-zero',
    covers: 'runtime の構築時点が0文字（割合は出せない旨）',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    injectedMemoryChars: 0,
    steps: [{ args: fm('values', { description: '要旨' }), writes: 'some' }],
  },
  {
    name: 'runtime-shrinks',
    covers: 'runtime の構築時点が大きい（減る見込み）',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    injectedMemoryChars: 1_000_000,
    steps: [{ args: fm('values', { description: '要旨' }), writes: 'some' }],
  },
  // ---- 書き込み・日誌が落ちる ----
  {
    name: 'write-fails',
    covers:
      'ストアの書き込みが例外（版の衝突ではない一般の例外。例外のまま返る・記憶も日誌も変わらない）→ 直して同じ呼びをやり直すと通る',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    steps: [
      {
        args: fm('values', { description: '要旨' }),
        writes: 'none',
        before: (hooks) => {
          hooks.failWriteSlug = 'values';
        },
      },
      {
        args: fm('values', { description: '要旨' }),
        writes: 'some',
        before: (hooks) => {
          hooks.failWriteSlug = null;
        },
      },
    ],
  },
  {
    name: 'documents-fails',
    covers:
      '書き込みの前後に取る記憶の一覧が落ちる: 書く前（何も書かない）・書いた後（記憶は書き換わったが日誌は無く、例外で返る）',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    steps: [
      {
        args: fm('values', { description: '要旨A' }),
        writes: 'none',
        before: (hooks) => {
          hooks.failDocumentsAt = 1;
        },
      },
      {
        args: fm('values', { description: '要旨B' }),
        writes: 'some',
        before: (hooks) => {
          hooks.failDocumentsAt = 2;
        },
      },
    ],
  },
  {
    name: 'journal-fails',
    covers:
      '日誌（act-completed。記憶を書いた後にだけ日誌を書く）が書けない: 記憶は書き換わっている・日誌は空・やり直し禁止の応答 → 日誌が戻ってから同じ呼び（版が進んだので版は取り直し）',
    seed: [{ slug: 'values', content: PREMISE_DOC }],
    journalFailsAt: [1],
    steps: [
      { args: fm('values', { description: '要旨' }), writes: 'some' },
      { args: fm('values', { description: '要旨' }), writes: 'some' },
    ],
  },
  {
    name: 'journal-row',
    covers:
      '日誌の行: summary がそのまま載る・bytesBefore／bytesAfter は UTF-8 のバイト数（日本語で字数と違う）・cause（clone／distill）・日本語の要約の長い値',
    seed: [
      { slug: 'values', content: PREMISE_DOC },
      { slug: 'clone-doc', content: DESC_ONLY_DOC },
    ],
    steps: [
      { args: fm('values', { description: '短い' }, '要旨を短くした'), writes: 'some' },
      {
        args: fm('clone-doc', { type: 'fact' }, '区分を fact にした。'.repeat(10)),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
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

/** ストアから読める形のまま（`persona.read` の中身）に、版（memoryVersion）を足したもの */
type PinnedDoc = Record<string, unknown> & { content: string; version: string };

interface PinnedStoreCall {
  slug: string;
  content: string;
  ifMatch: string | null | undefined;
  outcome: 'ok' | 'conflict' | 'threw';
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 場面で触れた記憶（呼んだあと）。無ければ null */
  memory: Record<string, PinnedDoc | null>;
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 記憶のストアの書き込み口（persona.write）の、この呼びの中での呼びの並び。割り込みの書き込みは含まない */
  storeCalls: PinnedStoreCall[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

const RUNTIME_BASE: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: [],
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readDoc(stores: Stores, slug: string): Promise<PinnedDoc | null> {
  const doc = await stores.persona.read(slug);
  if (doc === null) return null;
  return plain({ ...doc, version: memoryVersion(doc.content) }) as PinnedDoc;
}

/** 場面で記憶として読める slug（不正な slug は読まない） */
function watchedSlugs(scenario: Scenario): string[] {
  const slugs = new Set<string>(scenario.seed.map((doc) => doc.slug));
  for (const step of scenario.steps) {
    const value = step.args.slug;
    if (typeof value === 'string' && /^[a-z0-9._-]+$/.test(value)) slugs.add(value);
  }
  return [...slugs].sort();
}

async function snapshot(
  stores: Stores,
  slugs: readonly string[],
): Promise<{ memory: Record<string, PinnedDoc | null>; all: unknown; journal: unknown[] }> {
  const memory: Record<string, PinnedDoc | null> = {};
  for (const slug of slugs) memory[slug] = await readDoc(stores, slug);
  return {
    memory,
    all: plain(await stores.persona.documents()),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

interface Wired {
  stores: Stores;
  /** この呼びの中での persona.write の呼びの並び（呼びごとに空にする） */
  calls: PinnedStoreCall[];
  resetCounters: () => void;
}

function withHooks(base: Stores, hooks: Hooks, failJournalAt: readonly number[]): Wired {
  let journalCalls = 0;
  let documentsCalls = 0;
  const calls: PinnedStoreCall[] = [];
  // 呼びごとに仕込む割り込みを、その呼びの中で1度だけ起こす
  let raced: Hooks['raceOnRead'] = null;
  const persona: Stores['persona'] = {
    ...base.persona,
    read: async (slug) => {
      if (hooks.failReadSlug === slug) throw new Error('ストアの読みが落ちた');
      const doc = await base.persona.read(slug);
      const race = hooks.raceOnRead;
      if (race !== null && raced !== race && slug === race.slug) {
        raced = race;
        if (race.content === null) await base.persona.remove(race.slug);
        else await base.persona.write(race.slug, race.content);
      }
      return doc;
    },
    write: async (slug, content, options) => {
      if (hooks.failWriteSlug === slug) {
        calls.push({ slug, content, ifMatch: options?.ifMatch, outcome: 'threw' });
        throw new Error('ストアが落ちた');
      }
      try {
        const written = await base.persona.write(slug, content, options);
        calls.push({ slug, content, ifMatch: options?.ifMatch, outcome: 'ok' });
        return written;
      } catch (error) {
        calls.push({
          slug,
          content,
          ifMatch: options?.ifMatch,
          outcome: error instanceof MemoryConflictError ? 'conflict' : 'threw',
        });
        throw error;
      }
    },
    documents: async () => {
      documentsCalls += 1;
      if (hooks.failDocumentsAt === documentsCalls) throw new Error('記憶の一覧が落ちた');
      return base.persona.documents();
    },
    protectionStatus: async (slug) =>
      hooks.protection === 'unknown' ? { kind: 'unknown' } : base.persona.protectionStatus(slug),
  };
  return {
    stores: {
      ...base,
      persona,
      journal: {
        ...base.journal,
        append: (entry) => {
          journalCalls += 1;
          if (failJournalAt.includes(journalCalls)) {
            return Promise.reject(new Error('日誌が落ちた'));
          }
          return base.journal.append(entry);
        },
      },
    },
    calls,
    resetCounters: () => {
      documentsCalls = 0;
      calls.length = 0;
    },
  };
}

/** 呼ぶ時点の文書の版（AUTO の置き換え）。文書が無ければ版は渡さない */
async function resolveArgs(base: Stores, args: Args): Promise<Args> {
  const resolved: Args = { ...args };
  if (resolved.base_version === AUTO) {
    const slug = String(resolved.slug);
    const doc = /^[a-z0-9._-]+$/.test(slug) ? await base.persona.read(slug) : null;
    if (doc === null) delete resolved.base_version;
    else resolved.base_version = memoryVersion(doc.content);
  }
  if (resolved.base_version === undefined) delete resolved.base_version;
  return resolved;
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const doc of scenario.seed) {
    await base.persona.write(doc.slug, doc.content);
    if (doc.human === true) await base.persona.markHumanTouched(doc.slug, HUMAN_ISO);
  }
  const hooks: Hooks = {
    cause: 'clone',
    failWriteSlug: null,
    failReadSlug: null,
    raceOnRead: null,
    failDocumentsAt: null,
    protection: null,
    guardEnv: null,
  };
  const wired = withHooks(base, hooks, scenario.journalFailsAt ?? []);
  const injected = scenario.injectedMemoryChars;
  const tools = createCloneTools({
    stores: wired.stores,
    emit: () => undefined,
    memoryCause: () => hooks.cause,
    conversationId: () => undefined,
    ...(injected === undefined
      ? {}
      : {
          runtime: () => ({ ...RUNTIME_BASE, injectedMemoryChars: heuristicChars(injected) }),
        }),
  });
  const found = tools.find((entry) => entry.name === 'memory_frontmatter_set');
  if (!found) throw new Error('memory_frontmatter_set が無い');

  const slugs = watchedSlugs(scenario);
  const results: PinnedStep[] = [];
  const guardBefore = process.env.ALTEROID_MEMORY_GUARD;
  try {
    for (const [index, step] of scenario.steps.entries()) {
      // 前の呼びの口を持ち越さない（この呼びの `before` が設定したものだけが効く）
      hooks.failWriteSlug = null;
      hooks.failReadSlug = null;
      hooks.raceOnRead = null;
      hooks.failDocumentsAt = null;
      hooks.protection = null;
      hooks.guardEnv = null;
      hooks.cause = 'clone';
      step.before?.(hooks);
      if (hooks.guardEnv === null) delete process.env.ALTEROID_MEMORY_GUARD;
      else process.env.ALTEROID_MEMORY_GUARD = hooks.guardEnv;
      wired.resetCounters();
      const before = await snapshot(base, slugs);
      const args = await resolveArgs(base, step.args);
      vi.setSystemTime(new Date(callTime(index)));
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
      const storeCalls = plain(wired.calls);
      // 後の確認（snapshot）で口が働かないようにする
      hooks.failReadSlug = null;
      hooks.failDocumentsAt = null;
      hooks.raceOnRead = null;
      const after = await snapshot(base, slugs);
      const wrote =
        JSON.stringify(before.all) !== JSON.stringify(after.all) ||
        before.journal.length !== after.journal.length;
      results.push({
        output,
        wrote,
        memory: after.memory,
        journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
        storeCalls,
      });
      if (step.writes === 'none') {
        // 書き込みが起きなかった呼びは、記憶と日誌が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
        expect(
          after.all,
          `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、記憶が呼ぶ前から変わった`,
        ).toEqual(before.all);
        expect(
          after.journal,
          `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌が呼ぶ前から変わった`,
        ).toEqual(before.journal);
      }
    }
  } finally {
    if (guardBefore === undefined) delete process.env.ALTEROID_MEMORY_GUARD;
    else process.env.ALTEROID_MEMORY_GUARD = guardBefore;
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

describe('memory_frontmatter_set の出力と呼んだあとの状態の固定（場面ごとの出力の全文・記憶の本文・日誌の行・ストアの書き込み口の呼び）', () => {
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
  });

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
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
      });

      it(`${key} の呼んだあとの記憶が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          Object.keys(got?.memory ?? {}),
          `場面 ${key} の記憶: 見ている slug の並びが変わった`,
        ).toEqual(Object.keys(want?.memory ?? {}));
        for (const [slug, wantDoc] of Object.entries(want?.memory ?? {})) {
          const gotDoc = got?.memory[slug] ?? null;
          expect(gotDoc === null, `場面 ${key} の記憶 ${slug}: 文書が有る／無いが変わった`).toBe(
            wantDoc === null,
          );
          if (wantDoc === null || gotDoc === null) continue;
          expect(
            gotDoc.content.length,
            `場面 ${key} の記憶 ${slug} の本文の字数が変わった: 固定値 ${String(wantDoc.content.length)} 字 → いま ${String(gotDoc.content.length)} 字`,
          ).toBe(wantDoc.content.length);
          expect(
            gotDoc.content,
            `場面 ${key} の記憶 ${slug} の本文が固定値からずれた（字数は ${String(gotDoc.content.length)} 字で同じ）`,
          ).toBe(wantDoc.content);
          expect(
            gotDoc,
            `場面 ${key} の記憶 ${slug} の本文以外（版・frontmatter・updatedAt など）が固定値からずれた`,
          ).toEqual(wantDoc);
        }
      });

      it(`${key} の呼んだあとに日誌へ足された行・ストアの書き込み口の呼びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(
          got?.storeCalls.length,
          `場面 ${key} のストアの書き込み口の呼びの数が変わった: 固定値 ${String(want?.storeCalls.length)} 回 → いま ${String(got?.storeCalls.length)} 回`,
        ).toBe(want?.storeCalls.length);
        expect(
          got?.storeCalls,
          `場面 ${key} のストアの書き込み口の呼び（slug・本文・版の照合 ifMatch・結果）が固定値からずれた`,
        ).toEqual(want?.storeCalls);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・記憶・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const doc = (key: string, slug: string): string => actual[key]?.memory[slug]?.content ?? '';
    const calls = (key: string): PinnedStoreCall[] => actual[key]?.storeCalls ?? [];
    const outcomes = (key: string): string[] => calls(key).map((call) => call.outcome);

    expect(text('arg-errors#1')).toContain('記憶のスラッグが不正: Bad Slug');
    expect(text('arg-errors#2')).toContain('記憶のスラッグが不正: （');
    expect(text('arg-errors#3')).toContain('記憶のスラッグが不正: Bad/Slug');
    expect(text('arg-errors#4')).toContain('少なくとも1つを渡すこと');
    expect(text('arg-errors#5')).toContain('記憶 nope の frontmatter を直すには');
    expect(text('line-breaks#1')).toContain('description に改行');
    expect(text('line-breaks#1')).toContain('全 7 文字、2 文字目に \\n が在る');
    expect(text('line-breaks#2')).toContain('2 文字目に \\r が在る');
    expect(text('line-breaks#3')).toContain('2 文字目に \\r が在る');
    expect(text('line-breaks#3')).toContain('"a\\r\\nb"');
    expect(text('line-breaks#4')).toContain('type に改行');
    expect(text('line-breaks#5')).toContain('parent に改行');
    expect(text('line-breaks#7')).toContain('1 文字目に \\n が在る');
    expect(text('line-breaks#8')).toContain('description に改行');
    expect(text('line-breaks#9')).toContain('type に改行');
    expect(text('line-breaks#10')).toContain('parent に改行');
    expect(text('line-breaks#11')).toContain('…');
    expect(text('line-breaks#12')).toContain('記憶 nope の frontmatter を更新できない');
    expect(text('type-invalid#1')).toContain('type に渡せるのは premise か fact か indexed');
    expect(text('type-invalid#2')).toContain('渡された値: ""');
    expect(text('type-invalid#5')).toContain('type に渡せるのは');
    expect(text('type-invalid#6')).toContain('は存在しない');
    expect(text('doc-missing#1')).toContain('は存在しない');
    expect(text('read-fails#1')).toBe('ストアの読みが落ちた');
    expect(actual['read-fails#1']?.output.thrown).toBe(true);
    expect(text('read-fails#2')).toContain('記憶 other の frontmatter を更新した');
    expect(text('guard-distill#1')).toContain('人間の書き込みの履歴が在る（保護状態: human）');
    expect(text('guard-distill#1')).toContain('ask_human');
    expect(text('guard-distill#1')).toContain('代わりにならない');
    expect(text('guard-distill#2')).toContain('断った');
    expect(text('guard-distill#3')).toContain('保護状態: unknown');
    expect(text('guard-distill#4')).toContain('更新した');
    expect(journal('guard-distill#4').map((row) => row.cause)).toEqual(['distill']);
    expect(journal('guard-distill#5').map((row) => row.cause)).toEqual(['clone']);
    expect(journal('guard-env#1').map((row) => row.cause)).toEqual(['distill']);
    expect(text('guard-env#2')).toContain('ALTEROID_MEMORY_GUARD の値が不正: maybe');
    expect(text('guard-env#3')).toContain('断った');
    expect(text('version#1')).toContain('base_version をこの呼び出しの base_version に渡すこと');
    expect(text('version#1')).toContain('**何も書いていない。**');
    expect(calls('version#1')).toEqual([]);
    expect(text('version#2')).toContain('その間に変わった');
    expect(outcomes('version#2')).toEqual(['conflict']);
    expect(calls('version#2')[0]?.ifMatch).toBe('');
    expect(text('version#3')).toContain('**書かなかった**');
    expect(text('version#3')).toContain(`base_version=${memoryVersion(PREMISE_DOC)}`);
    expect(calls('version#3')[0]?.ifMatch).toBe(STALE_VERSION);
    expect(text('version#4')).toContain('先に memory_read slug=broken で読み');
    expect(text('version#5')).toContain('更新した');
    expect(calls('version#5')[0]?.ifMatch).toBe(memoryVersion(PREMISE_DOC));
    expect(text('version-race#1')).toContain('その間に変わった');
    expect(doc('version-race#1', 'values')).toContain('人間が直した要旨');
    expect(journal('version-race#1')).toEqual([]);
    expect(text('version-race#2')).toContain('いまその文書は無い（読んだ後に消された）');
    expect(doc('version-race#2', 'gone')).toBe('');
    expect(actual['version-race#2']?.memory.gone).toBeNull();
    expect(text('malformed#1')).toContain('malformed');
    expect(text('malformed#4')).toContain('malformed');
    expect(doc('malformed#2', 'nocolon')).toBe(MAL_NOCOLON);
    expect(text('patch-none#1')).toContain('更新: a（区分: premise');
    expect(text('patch-none#1')).not.toContain('区分が変わった');
    expect(doc('patch-none#1', 'a')).toBe(`---\ndescription: 新しい要旨\n---\n${NONE_DOC}`);
    expect(text('patch-none#2')).toContain('区分が変わった: premise');
    expect(doc('patch-none#4', 'd')).toBe(
      `---\ndescription: 要旨\ntype: indexed\nparent: root\n---\n${NONE_DOC}`,
    );
    expect(doc('patch-none#5', 'e')).toBe(`---\ndescription: 要旨\n---\n${NONE_RULE_DOC}`);
    expect(doc('patch-parsed#1', 'full')).toBe(
      `---\ndescription: 新しい要旨\ntype: fact\nparent: root\n---\n${BODY}`,
    );
    expect(doc('patch-parsed#4', 'full')).toContain('description: \n');
    expect(doc('patch-parsed#5', 'full')).toContain('parent: \n');
    expect(doc('patch-parsed#6', 'reorder')).toBe(
      `---\ndescription: 直した\ntype: fact\nparent: root\n---\n${BODY}`,
    );
    expect(doc('patch-parsed#7', 'dupkey')).toBe(`---\ndescription: 後\ntype: fact\n---\n${BODY}`);
    expect(doc('patch-parsed#8', 'empty-fm')).toBe(`---\ndescription: 要旨\n---\n${BODY}`);
    expect(doc('patch-shapes#1', 'empty-body')).toBe(
      '---\ndescription: 元の要旨\ntype: fact\n---\n',
    );
    expect(doc('patch-shapes#2', 'crlf')).toBe(
      '---\ndescription: 新しい要旨\ntype: premise\n---\n# 表紙\r\n本文\r\n',
    );
    expect(doc('patch-shapes#3', 'rule-body')).toContain('---\n本文の中の区切り\n---\n終わり\n');
    expect(text('patch-shapes#5')).not.toContain('区分が変わった');
    expect(doc('patch-shapes#5', 'weird')).toContain('type: premise\n');
    expect(doc('patch-values#2', 'values')).toContain('description:   前後に空白  \n');
    expect(text('kind-changes#1')).toContain('区分が変わった: premise');
    expect(text('kind-changes#1')).toContain('次のターンから、この文書は目次の1行だけになる');
    expect(text('kind-changes#2')).toContain('→ indexed（要旨だけが載る');
    expect(text('kind-changes#3')).toContain('→ premise（要旨＋節の目次が載る）');
    expect(text('kind-changes#5')).not.toContain('区分が変わった');
    expect(text('kind-from-none#1')).not.toContain('区分が変わった');
    expect(text('kind-from-none#2')).toContain('区分が変わった');
    expect(outcomes('unchanged#1')).toEqual(['ok']);
    expect(doc('unchanged#1', 'values')).toBe(PREMISE_DOC);
    expect(journal('unchanged#1')).toHaveLength(1);
    expect(doc('unchanged#3', 'reorder')).toBe(
      `---\ndescription: 元の要旨\ntype: fact\nparent: root\n---\n${BODY}`,
    );
    expect(text('floor-big#2')).toContain('区分が変わった');
    expect(text('runtime-grows')).toContain('増える見込み');
    expect(text('runtime-zero')).toContain('割合は出せない');
    expect(text('runtime-shrinks')).toContain('減る見込み');
    expect(text('write-fails#1')).toBe('ストアが落ちた');
    expect(outcomes('write-fails#1')).toEqual(['threw']);
    expect(journal('write-fails#1')).toEqual([]);
    expect(outcomes('write-fails#2')).toEqual(['ok']);
    expect(text('documents-fails#1')).toBe('記憶の一覧が落ちた');
    expect(calls('documents-fails#1')).toEqual([]);
    expect(text('documents-fails#2')).toBe('記憶の一覧が落ちた');
    expect(outcomes('documents-fails#2')).toEqual(['ok']);
    expect(journal('documents-fails#2')).toEqual([]);
    expect(doc('documents-fails#2', 'values')).toContain('description: 要旨B');
    expect(text('journal-fails#1').split('\n')[0]).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(journal('journal-fails#1')).toEqual([]);
    expect(doc('journal-fails#1', 'values')).toContain('description: 要旨');
    expect(journal('journal-fails#2')).toHaveLength(1);
    expect(journal('journal-row#1')[0]).toMatchObject({
      type: 'memory_update',
      action: 'describe',
      cause: 'clone',
      summary: '要旨を短くした',
      bytesBefore: Buffer.byteLength(PREMISE_DOC, 'utf8'),
    });
    expect(journal('journal-row#2')[0]).toMatchObject({ cause: 'distill', action: 'describe' });
    expect(Buffer.byteLength(PREMISE_DOC, 'utf8')).toBeGreaterThan(PREMISE_DOC.length);
  });
});
