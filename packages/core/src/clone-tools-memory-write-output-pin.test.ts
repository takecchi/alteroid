import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MEMORY_GUARD_ENV } from './clone-tools-memory.js';
import { measureMemoryFloor } from './memory.js';
import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import { memoryVersion } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `memory_write` の出力（全文と字数）と、呼んだあとの状態（記憶の本文・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-memory-write-output-pin.json）と丸ごと比べる。
// `clone-tools-memory.ts` の `tool('memory_write', …)`（約 77 行の式）を部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・記憶の本文）を固定して毎回同じにする。
// この道具は記憶を書き換えるので、出力だけでなく「呼んだあとの状態」と「ストアの呼びの並び」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - memory: 場面で触れた記憶を、呼んだあとにストアから読んだ形のまま（版 version・frontmatter・updatedAt を含む）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - calls: ストアの呼びの並び（persona.protectionStatus・persona.read・persona.documents・persona.write（渡した ifMatch）・journal.append）。
//     口（hooks）が土台を直に書き換える競合は記録に残らない
//   - wrote: 記憶か日誌のどれかが呼ぶ前から変わったか。断った・何もしなかった場面は false で、記憶が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MEMORY_WRITE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-memory-write-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-memory-write-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、記憶・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 記憶は場面の頭に基準時刻で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（updatedAt・日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 環境変数 ALTEROID_MEMORY_GUARD は呼びごとに `vi.stubEnv` で固定する（既定は未設定）。

type Writes = 'none' | 'some' | 'hook';
// none: 道具も口も何も書かない。some: 道具が記憶か日誌のどちらかを書く。hook: 道具は書かず、口が土台の記憶を書き換えた（競合）

interface SeedDoc {
  slug: string;
  content: string;
  /** 真なら人間が触った印（保護状態 human）を付ける */
  human?: boolean;
}

interface RaceSpec {
  slug: string;
  /** null なら消す。文字列なら、その内容へ書き換える */
  content: string | null;
}

/** 場面の中で呼びごとに差し替える口 */
interface Hooks {
  cause: 'clone' | 'distill';
  /** ALTEROID_MEMORY_GUARD の値。null は未設定 */
  guardEnv: string | null;
  /** persona.protectionStatus を差し替える */
  protection: 'unknown' | 'throw' | null;
  readThrows: boolean;
  /** persona.documents の何回目（1 が書く前・2 が書いた後）を投げさせるか */
  documentsThrowsAt: 1 | 2 | null;
  writeThrows: boolean;
  journalFails: boolean;
  /** その slug を最初に読んだ直後に、土台を直に書き換える（読んでから書くまでの間に変わる場面） */
  race: RaceSpec | null;
}

const DEFAULT_HOOKS: Hooks = {
  cause: 'clone',
  guardEnv: null,
  protection: null,
  readThrows: false,
  documentsThrowsAt: null,
  writeThrows: false,
  journalFails: false,
  race: null,
};

interface Step {
  slug: string;
  content: string;
  summary?: string;
  /**
   * current: 呼ぶ直前（外からの書き換えの後）の文書の版を渡す。stale: 外からの書き換えの前の版を渡す。none: 渡さない。raw: その文字列を渡す
   */
  base: 'current' | 'stale' | 'none' | { raw: string };
  writes: Writes;
  hooks?: Partial<Hooks>;
  /** 呼ぶ前に外から（人間・別のターンが）記憶を書き換える。呼ぶ前の状態に含める */
  externalEdit?: { slug: string; content: string };
}

type InjectedMemoryChars = number | 'equal';

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedDoc[];
  steps: Step[];
  /** 渡すと runtime（セッション構築時点に焼いた記憶の文字数）を持った器にする。'equal' は書いた後の床の総量と同じ値 */
  injectedMemoryChars?: InjectedMemoryChars;
  /** 記憶の記録に残す slug（既定は seed と呼びの slug）。多数の文書を seed する場面で絞る */
  watch?: string[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const HUMAN_ISO = '2026-10-28T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-memory-write-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MEMORY_WRITE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

// ---- 記憶の本文（入力） ----

const ABOUT = [
  '---',
  'description: 私について',
  'type: premise',
  '---',
  '# 私について',
  '芯である。',
  '',
  '## 事例',
  '事例の本文である。数値 42 と `id-7` が在る。',
  '',
  '## 次',
  '残る節である。',
  '',
].join('\n');

const FACT = '---\ntype: fact\ndescription: 事実の蓄積\n---\n# 事実\n本文 100\n';
const INDEXED = '---\ntype: indexed\ndescription: 特定の作業の記憶\n---\n# 作業\n本文\n';
const PLAIN = '# メモ\n本文\n';
const MALFORMED = '---\ndescription: 閉じが無い\n# 見出し\n本文\n';
const OTHER_PREMISE = [
  '---',
  'description: 別の前提',
  'type: premise',
  '---',
  '# 別の前提',
  '芯である。',
  '',
  '## 長い節',
  '長い節の本文である。'.repeat(8),
  '',
  '## もう1つ',
  '本文',
  '',
].join('\n');

const HEADS = [
  '---',
  'description: 見出しの多い文書',
  'type: premise',
  '---',
  '# 表紙',
  '芯である。',
  '',
  '## 節A',
  '本文A',
  '',
  '## 節B',
  '本文B',
  '',
  '## 節C',
  '本文C',
  '',
].join('\n');

const DUP = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';

const MED = [
  '---',
  'description: 中くらいの前提',
  'type: premise',
  '---',
  '# 中くらい',
  '芯である。',
  '',
  ...Array.from(
    { length: 8 },
    (_, index) => `## 節${String(index)}\n節${String(index)}の本文である。\n`,
  ),
].join('\n');

function sectionsOf(count: number, headingTail: string, body: string): string {
  return Array.from({ length: count }, (_, index) => {
    const pad = String(index).padStart(3, '0');
    return `# 節${pad}: ${headingTail}\n\n本文${pad}: ${body}\n`;
  }).join('\n');
}

const HEADING_TAIL = 'み'.repeat(60);
const BODY_TAIL = 'あ'.repeat(30);

/** 焼き込みの目次の予算（6,000字）に張り付く節数（premise） */
const BIG_TOC = `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${sectionsOf(100, HEADING_TAIL, BODY_TAIL)}`;
/** 節を10減らしても張り付いたまま（数だけ変わる） */
const BIG_TOC_TRIMMED = `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${sectionsOf(90, HEADING_TAIL, BODY_TAIL)}`;
/** 本文の1語だけ変えて、節の数も見出しも同じ */
const BIG_TOC_BODY_EDIT = BIG_TOC.replace('本文000: ', '本文000（直した）: ');
const SMALL_TOC = `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${sectionsOf(5, HEADING_TAIL, BODY_TAIL)}`;
const BIG_TOC_AS_FACT = BIG_TOC.replace('type: premise', 'type: fact');

/** 長い見出しを多数持つ文書（消えた見出しの一覧の予算 600 字を越える） */
const MANY_HEADINGS = `---\ndescription: 見出しが多い\ntype: premise\n---\n${sectionsOf(40, 'い'.repeat(30), 'う')}`;

const LONG_ASCII = `# 長い\n${'a'.repeat(1500)}\n`;

const NUM_RUN = Array.from({ length: 12 }, (_, index) => String(1001 + index)).join(' ');

function bigPremise(index: number): string {
  return BIG_TOC.replace('目次が予算に張り付いた文書', `大きい前提 ${String(index)}`);
}

const FILLER_SLUGS = Array.from({ length: 9 }, (_, index) => `big-${String(index)}`);
const RANK_SLUGS = Array.from({ length: 120 }, (_, index) => `r-${String(index).padStart(3, '0')}`);

function rankDoc(index: number): string {
  return `---\ndescription: 小\ntype: premise\n---\n# 小${String(index).padStart(3, '0')}\n本文\n`;
}

const SCENARIOS: Scenario[] = [
  // ---- スラッグの検査 ----
  {
    name: 'slug-invalid',
    covers:
      'スラッグが不正（英大文字と空白・空・先頭が `.`・`/` を含む・129 字）。どれも何も呼ばない。統合の走行（distill）でもスラッグの検査が先で、guard は読まない',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      { slug: 'Bad Slug', content: ABOUT, base: 'none', writes: 'none' },
      { slug: '', content: ABOUT, base: 'none', writes: 'none' },
      { slug: '.hidden', content: ABOUT, base: 'none', writes: 'none' },
      { slug: 'a/b', content: ABOUT, base: 'none', writes: 'none' },
      { slug: 'x'.repeat(129), content: ABOUT, base: 'none', writes: 'none' },
      {
        slug: 'Bad Slug',
        content: ABOUT,
        base: 'none',
        writes: 'none',
        hooks: { cause: 'distill' },
      },
    ],
  },
  // ---- 新規作成 ----
  {
    name: 'create-premise-first',
    covers:
      '新規作成（premise・frontmatter 付き）で記憶が空から。⭐ 新規作成の床の注記・最も大きい premise は自分・runtime 無しで現在値・トークンの差は出ない・消えた見出しの文は無い',
    seed: [],
    steps: [{ slug: 'about-me', content: ABOUT, base: 'none', writes: 'some', summary: '作った' }],
  },
  {
    name: 'create-premise-with-others',
    covers:
      '新規作成の premise が、既存のもっと大きい premise の在る記憶へ。最も大きい premise は既存側・順位の一覧に両方。床の増分（文字数の差）',
    seed: [
      { slug: 'other', content: OTHER_PREMISE },
      { slug: 'fact-doc', content: FACT },
    ],
    steps: [{ slug: 'about-me', content: ABOUT, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-fact',
    covers:
      '新規作成の fact（床は目次の1行だけ）。「新規作成: …（区分: fact）」の床の行・再注入の見込みは fact・目次1行。premise が無いので順位は変わらない（出ない）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [{ slug: 'facts', content: FACT, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-indexed',
    covers:
      '新規作成の indexed（要旨だけが焼かれる）。再注入の見込みは premise 扱いのカードの側へ倒れるかを含めて固定',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [{ slug: 'work', content: INDEXED, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-plain',
    covers: '新規作成で frontmatter 無し（premise として扱う安全側の既定）。⭐ の床の注記が出る',
    seed: [],
    steps: [{ slug: 'memo', content: PLAIN, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-malformed',
    covers:
      '新規作成で frontmatter が壊れている（閉じが無い。premise のまま・malformed の断り書きが付く）',
    seed: [],
    steps: [{ slug: 'broken', content: MALFORMED, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-content-forms',
    covers:
      '書いた本文の形: 末尾の改行が無い（ストアが足す・字数は足した後）・NUL を含む（ストアが除く）・空文字・多バイト文字（日誌の bytesAfter は字数と違う）・1,000 字以上（桁区切り）',
    seed: [],
    steps: [
      { slug: 'no-newline', content: '# 改行なし\n本文', base: 'none', writes: 'some' },
      { slug: 'with-nul', content: '# NUL\n本\u0000文\n', base: 'none', writes: 'some' },
      { slug: 'empty', content: '', base: 'none', writes: 'some' },
      { slug: 'multibyte', content: '# 日本語\nあいうえお 😀\n', base: 'none', writes: 'some' },
      { slug: 'long-ascii', content: LONG_ASCII, base: 'none', writes: 'some' },
    ],
  },
  {
    name: 'create-with-base-version',
    covers:
      '無い文書の新規作成に base_version を渡す: ifMatch にそのまま渡り、ストアが断る（読んだ時点でも無かったと言い、「読んだ後に消された」とは言わない・何も書かない。#6445）。そのあと版なしで作ると通る',
    seed: [],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT,
        base: { raw: memoryVersion(ABOUT) },
        writes: 'none',
      },
      { slug: 'about-me', content: ABOUT, base: 'none', writes: 'some' },
    ],
  },
  // ---- 版の前提 ----
  {
    name: 'update-needs-base',
    covers:
      '既存の文書に base_version が無い: 何も書かずに断る（ifMatch は渡らず write を呼ばない）。空文字の base_version は「無い」ではなく版の食い違いとして断られる。正しい版を渡すと通る',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る', '残らない'),
        base: 'none',
        writes: 'none',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('残る', '残らない'),
        base: { raw: '' },
        writes: 'none',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  // ---- 更新（文・消えた見出し・トークンの差） ----
  {
    name: 'update-same-content',
    covers:
      '中身が同じ更新（版は同じ・updatedAt だけ進む・日誌は書く）。字数の差は +0・消えた見出しは なし・トークンの差は出ない',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT,
        base: 'current',
        writes: 'some',
        summary: '何も変えない',
      },
    ],
  },
  {
    name: 'update-text-only',
    covers:
      '数字・識別子も見出しも動かない文章だけの更新（トークンの差は出ない・消えた見出しは なし）。縮む・伸びる',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '残る節の文を直した。'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '短い。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'update-tokens',
    covers:
      'トークンの差: 消えた・増えたの両方 / 増えただけ / 消えただけ / 11 件以上は10件で切って ほか N 件 / バッククォートで囲んだ識別子 / 差が無ければ出ない',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('42', '43').replace('`id-7`', '`id-8`'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('42', '43')
          .replace('`id-7`', '`id-8`')
          .replace('在る。', '在る。 99'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('42', '').replace('`id-7`', '`id-8`').replace('在る。', '在る。 99'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('42', '')
          .replace('`id-7`', '`id-8`')
          .replace('在る。', `在る。 99 ${NUM_RUN}`),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '文だけ直した。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'update-headings',
    covers:
      '消えた見出し: 1 件 / 2 件 / 見出しを足しただけ（なし）/ 見出しの名前を変えた（旧い名前が消えた）/ 階層を変えた（## → ###）。続けて同じ文書を更新する',
    seed: [{ slug: 'heads', content: HEADS }],
    steps: [
      {
        slug: 'heads',
        content: HEADS.replace('## 節C\n本文C\n', ''),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'heads',
        content: '---\ndescription: 見出しの多い文書\ntype: premise\n---\n# 表紙\n芯である。\n',
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'heads',
        content:
          '---\ndescription: 見出しの多い文書\ntype: premise\n---\n# 表紙\n芯である。\n\n## 新しい節\n本文\n',
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'heads',
        content:
          '---\ndescription: 見出しの多い文書\ntype: premise\n---\n# 表紙\n芯である。\n\n## 改めた節\n本文\n',
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'heads',
        content:
          '---\ndescription: 見出しの多い文書\ntype: premise\n---\n# 表紙\n芯である。\n\n### 改めた節\n本文\n',
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'update-headings-dup-stays',
    covers:
      '同じ見出しが他所に残る: 節を丸ごと1つ消しても「消えた見出し: なし」（見出しは集合で比べる）。残りの片方も消すと名指しされる',
    seed: [{ slug: 'dup', content: DUP }],
    steps: [
      {
        slug: 'dup',
        content: '# A\n本文\n\n# B\n終わり\n',
        base: 'current',
        writes: 'some',
      },
      { slug: 'dup', content: '# B\n終わり\n', base: 'current', writes: 'some' },
    ],
  },
  {
    name: 'update-headings-many',
    covers:
      '消えた見出しが多く、一覧の予算（600字）を越える（ほか N 件は省略・残りを見る手が無い旨）。1つ書き直して 40 → 1 節にする',
    seed: [{ slug: 'many', content: MANY_HEADINGS }],
    steps: [
      {
        slug: 'many',
        content: '---\ndescription: 見出しが多い\ntype: premise\n---\n# 新\n畳んだ\n',
        base: 'current',
        writes: 'some',
      },
    ],
  },
  // ---- 区分の変更と再注入の見込み ----
  {
    name: 'update-kind-changes',
    covers:
      '区分が変わる更新の連鎖: premise → fact（順位から落ちる・premise が無くなる）→ fact のまま更新（順位は出ない）→ indexed → premise（順位が出る）→ frontmatter 無し（premise 扱い）→ 壊れた frontmatter',
    seed: [
      { slug: 'about-me', content: ABOUT },
      { slug: 'other', content: OTHER_PREMISE },
    ],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('type: premise', 'type: fact'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: `${ABOUT.replace('type: premise', 'type: fact')}追記した\n`,
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('type: premise', 'type: indexed'),
        base: 'current',
        writes: 'some',
      },
      { slug: 'about-me', content: ABOUT, base: 'current', writes: 'some' },
      { slug: 'about-me', content: PLAIN, base: 'current', writes: 'some' },
      { slug: 'about-me', content: MALFORMED, base: 'current', writes: 'some' },
    ],
  },
  {
    name: 'update-only-premise',
    covers:
      '記憶に premise が1つだけの文書が fact に変わる（変更後は premise がまだ無い旨の順位）。fact の文書を fact のまま更新する（順位は前後で同じなので出ない）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('type: premise', 'type: fact'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: `${ABOUT.replace('type: premise', 'type: fact')}もう1行\n`,
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'update-premise-delta',
    covers:
      '再注入の見込みの内訳: 本文だけ変える（カードの変わった範囲だけ）/ 同じ内容（カード全体）/ 見出しを書き換える（変わった範囲＋消えた節の注記）/ ほぼ全部を書き換える（変わった範囲が大きすぎてカード全体）',
    seed: [{ slug: 'med', content: MED }],
    steps: [
      {
        slug: 'med',
        content: MED.replace('節3の本文である。', '節3の本文を直した。'),
        base: 'current',
        writes: 'some',
      },
      { slug: 'med', content: MED, base: 'current', writes: 'some' },
      {
        slug: 'med',
        content: MED.replace('## 節4', '## 改めた節4'),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'med',
        content:
          '---\ndescription: 中くらいの前提\ntype: premise\n---\n# 全部書き直し\n本文だけ\n\n## 完全に別\n別\n\n## もう1つ別\n別\n',
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'ranking-omitted',
    covers:
      '順位の一覧が予算（2,000字）を越える（premise が 120 件。ほか N 件は省略）。premise を書くので順位が出る',
    seed: RANK_SLUGS.map((slug, index) => ({ slug, content: rankDoc(index) })),
    watch: ['r-000'],
    steps: [
      {
        slug: 'r-000',
        content: rankDoc(0).replace('本文', '本文を伸ばした。'.repeat(3)),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  // ---- 床の注記 ----
  {
    name: 'floor-demoted',
    covers:
      'premise のカードの合計が予算（60,000字）を越えて落ちる: 書く前は収まっていて、書いた後に落ちる（⚠️ 蓋が効いた後の値）→ 続けて小さい文書を更新しても、落ちたままなので注記が出続ける',
    seed: [
      ...FILLER_SLUGS.map((slug, index) => ({ slug, content: bigPremise(index) })),
      { slug: 'small', content: ABOUT },
    ],
    watch: ['big-new', 'small'],
    steps: [
      { slug: 'big-new', content: bigPremise(99), base: 'none', writes: 'some' },
      {
        slug: 'small',
        content: ABOUT.replace('残る節である。', '残る節を直した。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'floor-outline',
    covers:
      '節の目次が予算（6,000字）に張り付いた premise を更新する連鎖: 本文だけ直す（節の数が同じなので注記なし）→ 節を10減らす（張り付いた領域の中の揺れ）→ 5 節へ縮める（切られなくなった）→ 100 節へ戻す（予算を越えた）→ fact に変える（切られなくなった）',
    seed: [{ slug: 'big-toc', content: BIG_TOC }],
    steps: [
      { slug: 'big-toc', content: BIG_TOC_BODY_EDIT, base: 'current', writes: 'some' },
      { slug: 'big-toc', content: BIG_TOC_TRIMMED, base: 'current', writes: 'some' },
      { slug: 'big-toc', content: SMALL_TOC, base: 'current', writes: 'some' },
      { slug: 'big-toc', content: BIG_TOC, base: 'current', writes: 'some' },
      { slug: 'big-toc', content: BIG_TOC_AS_FACT, base: 'current', writes: 'some' },
    ],
  },
  {
    name: 'floor-outline-create',
    covers:
      '目次が予算を越える premise を新規作成する（⭐ 新規作成と、予算を越えた注記の両方）。別の張り付いた文書は数が変わらないので名乗らない',
    seed: [{ slug: 'big-toc', content: BIG_TOC }],
    steps: [{ slug: 'big-new', content: bigPremise(1), base: 'none', writes: 'some' }],
  },
  // ---- runtime ----
  {
    name: 'runtime-grows',
    covers:
      'runtime（セッション構築時点の記憶の文字数）が在る器: 構築時点が書いた後の総量より小さい（増える見込み・割合）。更新と新規作成の両方',
    seed: [{ slug: 'about-me', content: ABOUT }],
    injectedMemoryChars: 100,
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '残る節を直した。'),
        base: 'current',
        writes: 'some',
      },
      { slug: 'facts', content: FACT, base: 'none', writes: 'some' },
    ],
  },
  {
    name: 'runtime-zero',
    covers: 'runtime の構築時点が0文字（割合は出せない旨）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    injectedMemoryChars: 0,
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '残る節を直した。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'runtime-shrinks',
    covers: 'runtime の構築時点が大きい（減る見込み・負の割合）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    injectedMemoryChars: 1_000_000,
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '残る節を直した。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  {
    name: 'runtime-equal',
    covers: 'runtime の構築時点が書いた後の総量と同じ（変わっていない旨）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    injectedMemoryChars: 'equal',
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.replace('残る節である。', '残る節を直した。'),
        base: 'current',
        writes: 'some',
      },
    ],
  },
  // ---- 誰の走行か・保護 ----
  {
    name: 'guard',
    covers:
      '統合の走行（distill）の歯: 人間の履歴つき（版が有っても無くても歯が先に断る）・clone-only は通る（日誌の cause は distill）・clone-only でも版が無ければ版の断り・履歴の無い新規スラッグは断る（unknown）・保護状態が unknown の既存は断る・clone の走行は歯を読まず通る・ALTEROID_MEMORY_GUARD=off は通る・on は断る・綴りの誤りは投げる・保護状態の読みが落ちると投げる',
    seed: [
      { slug: 'h1', content: ABOUT, human: true },
      { slug: 'h2', content: ABOUT, human: true },
      { slug: 'c1', content: ABOUT },
      { slug: 'c2', content: ABOUT },
      { slug: 'u1', content: ABOUT },
      { slug: 'h3', content: ABOUT, human: true },
      { slug: 'h4', content: ABOUT, human: true },
      { slug: 'h5', content: ABOUT, human: true },
      { slug: 'h6', content: ABOUT, human: true },
      { slug: 'c3', content: ABOUT },
    ],
    steps: [
      {
        slug: 'h1',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { cause: 'distill' },
      },
      {
        slug: 'h2',
        content: ABOUT.replace('残る', '残らない'),
        base: 'none',
        writes: 'none',
        hooks: { cause: 'distill' },
      },
      {
        slug: 'c1',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
        hooks: { cause: 'distill' },
        summary: '蒸留が書いた',
      },
      {
        slug: 'c2',
        content: ABOUT.replace('残る', '残らない'),
        base: 'none',
        writes: 'none',
        hooks: { cause: 'distill' },
      },
      {
        slug: 'new-by-distill',
        content: ABOUT,
        base: 'none',
        writes: 'none',
        hooks: { cause: 'distill' },
      },
      {
        slug: 'u1',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { cause: 'distill', protection: 'unknown' },
      },
      {
        slug: 'h3',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
        hooks: { cause: 'clone' },
        summary: '会話の中で書いた',
      },
      {
        slug: 'h4',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
        hooks: { cause: 'distill', guardEnv: 'off' },
      },
      {
        slug: 'h5',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { cause: 'distill', guardEnv: 'bogus' },
      },
      {
        slug: 'h6',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { cause: 'distill', guardEnv: 'on' },
      },
      {
        slug: 'c3',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { cause: 'distill', protection: 'throw' },
      },
    ],
  },
  // ---- 版の食い違い ----
  {
    name: 'conflict',
    covers:
      '版の食い違い: 外から書き換えた後の古い版（いまの版と字数を名乗って断る）・でたらめな版・空文字の版・読んだ直後に別の手が書いた（競合）・読んだ直後に別の手が消した（いまその文書は無い）。どれも道具は何も書かず、日誌も足さない。write には渡した ifMatch が残る',
    seed: [
      { slug: 'a1', content: ABOUT },
      { slug: 'a2', content: ABOUT },
      { slug: 'a3', content: ABOUT },
      { slug: 'a4', content: ABOUT },
    ],
    steps: [
      {
        slug: 'a1',
        content: ABOUT.replace('残る', '残らない'),
        base: 'stale',
        writes: 'none',
        externalEdit: { slug: 'a1', content: ABOUT.replace('残る', '人間が直した') },
      },
      {
        slug: 'a2',
        content: ABOUT.replace('残る', '残らない'),
        base: { raw: 'deadbeef' },
        writes: 'none',
      },
      {
        slug: 'a3',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'hook',
        hooks: { race: { slug: 'a3', content: ABOUT.replace('残る', '別のターンが書いた') } },
      },
      {
        slug: 'a4',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'hook',
        hooks: { race: { slug: 'a4', content: null } },
      },
    ],
  },
  // ---- 失敗 ----
  {
    name: 'failures',
    covers:
      '例外: persona.write が落ちる（更新・新規）・persona.read が落ちる・persona.documents が書く前に落ちる（何も書かない）・書いた後に落ちる（記憶も日誌も書けていて、応答はストアの例外。日誌を読み直しより先に書く。#6445）・日誌が書けない（記憶は書けているが日誌は空・「完了済み・未記録・やり直し禁止」の例外で、読み直しへは進まない。更新・新規）',
    seed: [
      { slug: 'f1', content: ABOUT },
      { slug: 'f2', content: ABOUT },
      { slug: 'f3', content: ABOUT },
      { slug: 'f4', content: ABOUT },
      { slug: 'f5', content: ABOUT },
    ],
    steps: [
      {
        slug: 'f1',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { writeThrows: true },
      },
      {
        slug: 'f-new',
        content: ABOUT,
        base: 'none',
        writes: 'none',
        hooks: { writeThrows: true },
      },
      {
        slug: 'f2',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { readThrows: true },
      },
      {
        slug: 'f3',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'none',
        hooks: { documentsThrowsAt: 1 },
      },
      {
        slug: 'f4',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
        hooks: { documentsThrowsAt: 2 },
      },
      {
        slug: 'f5',
        content: ABOUT.replace('残る', '残らない'),
        base: 'current',
        writes: 'some',
        hooks: { journalFails: true },
      },
      {
        slug: 'f-new-2',
        content: ABOUT,
        base: 'none',
        writes: 'some',
        hooks: { journalFails: true },
        summary: '日誌が落ちる新規',
      },
    ],
  },
  // ---- 日誌の行 ----
  {
    name: 'journal-fields',
    covers:
      '日誌の行（bytesBefore・bytesAfter・summary・cause）: 多バイト文字の文書を書き換える（バイト数は字数と違う）・要約に改行と長い文字列・新規作成は bytesBefore が 0',
    seed: [{ slug: 'jp', content: '# 日本語\nあいうえお 😀\n' }],
    steps: [
      {
        slug: 'jp',
        content: '# ascii\nabc\n',
        base: 'current',
        writes: 'some',
        summary: '多バイトから ascii へ',
      },
      {
        slug: 'jp',
        content: '# 日本語\nあ\n',
        base: 'current',
        writes: 'some',
        summary: `1行目\n2行目 ${'長'.repeat(300)}`,
      },
      { slug: 'jp-new', content: '# 日本語2\nあ\n', base: 'none', writes: 'some', summary: '新規' },
    ],
  },
  {
    name: 'update-normalized',
    covers:
      '更新で末尾の改行が無い本文・NUL を含む本文（書かれた本文と渡した本文が違う。差分・字数・版は書かれた側）',
    seed: [{ slug: 'about-me', content: ABOUT }],
    steps: [
      {
        slug: 'about-me',
        content: ABOUT.trimEnd(),
        base: 'current',
        writes: 'some',
      },
      {
        slug: 'about-me',
        content: ABOUT.replace('残る', '残\u0000る'),
        base: 'current',
        writes: 'some',
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
  /** 例外の名前（例外でなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: Record<string, unknown>;
  outcome: string;
}

/** ストアから読める形のまま（`persona.read` の中身）に、版（memoryVersion）を足したもの */
type PinnedDoc = Record<string, unknown> & { content: string; version: string };

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 場面で触れた記憶（呼んだあと）。無ければ null */
  memory: Record<string, PinnedDoc | null>;
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** ストアの呼びの並び（道具の呼びだけ。口が土台を直に書き換えた分は残らない） */
  calls: PinnedCall[];
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

/** 場面の記憶として読める slug（不正な slug は読まない） */
function watchedSlugs(scenario: Scenario): string[] {
  const slugs = new Set<string>(scenario.watch ?? scenario.seed.map((doc) => doc.slug));
  for (const step of scenario.steps) {
    if (/^[a-z0-9][a-z0-9._-]*$/.test(step.slug) && step.slug.length <= 128) slugs.add(step.slug);
  }
  return [...slugs].sort();
}

async function snapshot(
  stores: Stores,
  slugs: readonly string[],
): Promise<{ memory: Record<string, PinnedDoc | null>; all: string; journal: unknown[] }> {
  const memory: Record<string, PinnedDoc | null> = {};
  for (const slug of slugs) memory[slug] = await readDoc(stores, slug);
  return {
    memory,
    all: JSON.stringify(await stores.persona.documents()),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function failureOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `threw ${name}: ${error instanceof Error ? error.message : String(error)}`;
}

interface StepState {
  documentsCalls: number;
  raced: boolean;
  /** 書いた後（persona.documents の2回目）の床の総量。runtime の 'equal' が使う */
  lastFloorChars: number;
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗・競合を起こす。口の書き換えは土台を直に叩くので記録に残らない */
function withHooks(
  base: Stores,
  hooks: () => Hooks,
  state: () => StepState,
  calls: PinnedCall[],
): Stores {
  const persona: Stores['persona'] = {
    ...base.persona,
    protectionStatus: async (slug) => {
      const now = hooks();
      try {
        if (now.protection === 'throw') throw new Error('保護状態の読みが落ちた');
        const status =
          now.protection === 'unknown'
            ? ({ kind: 'unknown' } as const)
            : await base.persona.protectionStatus(slug);
        calls.push({ op: 'persona.protectionStatus', args: { slug }, outcome: status.kind });
        return status;
      } catch (error) {
        calls.push({ op: 'persona.protectionStatus', args: { slug }, outcome: failureOf(error) });
        throw error;
      }
    },
    read: async (slug) => {
      const now = hooks();
      try {
        if (now.readThrows) throw new Error('ストアが落ちた（read）');
        const doc = await base.persona.read(slug);
        calls.push({
          op: 'persona.read',
          args: { slug },
          outcome: doc === null ? 'null' : `doc ${memoryVersion(doc.content)}`,
        });
        const race = now.race;
        const current = state();
        if (race !== null && !current.raced && slug === race.slug) {
          current.raced = true;
          if (race.content === null) await base.persona.remove(race.slug);
          else await base.persona.write(race.slug, race.content);
        }
        return doc;
      } catch (error) {
        calls.push({ op: 'persona.read', args: { slug }, outcome: failureOf(error) });
        throw error;
      }
    },
    documents: async () => {
      const now = hooks();
      const current = state();
      current.documentsCalls += 1;
      const nth = current.documentsCalls;
      try {
        if (now.documentsThrowsAt === nth) throw new Error('ストアが落ちた（documents）');
        const docs = await base.persona.documents();
        if (nth === 2) current.lastFloorChars = measureMemoryFloor(docs).totalChars;
        calls.push({
          op: 'persona.documents',
          args: { nth },
          outcome: `${String(docs.length)} docs`,
        });
        return docs;
      } catch (error) {
        calls.push({ op: 'persona.documents', args: { nth }, outcome: failureOf(error) });
        throw error;
      }
    },
    write: async (slug, content, options) => {
      const now = hooks();
      const args = {
        slug,
        contentChars: content.length,
        contentVersion: memoryVersion(content),
        ifMatch: options?.ifMatch === undefined ? '(省略)' : options.ifMatch,
      };
      try {
        if (now.writeThrows) throw new Error('ストアが落ちた（write）');
        const written = await base.persona.write(slug, content, options);
        calls.push({ op: 'persona.write', args, outcome: `ok ${memoryVersion(written.content)}` });
        return written;
      } catch (error) {
        calls.push({ op: 'persona.write', args, outcome: failureOf(error) });
        throw error;
      }
    },
  };
  return {
    ...base,
    persona,
    journal: {
      ...base.journal,
      append: async (entry) => {
        const args = plain(entry);
        if (hooks().journalFails) {
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

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const doc of scenario.seed) {
    await base.persona.write(doc.slug, doc.content);
    if (doc.human === true) await base.persona.markHumanTouched(doc.slug, HUMAN_ISO);
  }
  let hooks: Hooks = { ...DEFAULT_HOOKS };
  let state: StepState = { documentsCalls: 0, raced: false, lastFloorChars: 0 };
  const calls: PinnedCall[] = [];
  const injected = scenario.injectedMemoryChars;
  const tools = createCloneTools({
    stores: withHooks(
      base,
      () => hooks,
      () => state,
      calls,
    ),
    emit: () => undefined,
    memoryCause: () => hooks.cause,
    conversationId: () => undefined,
    ...(injected === undefined
      ? {}
      : {
          runtime: () => ({
            ...RUNTIME_BASE,
            injectedMemoryChars: heuristicChars(
              injected === 'equal' ? state.lastFloorChars : injected,
            ),
          }),
        }),
  });
  const found = tools.find((entry) => entry.name === 'memory_write');
  if (!found) throw new Error('memory_write が無い');

  const slugs = watchedSlugs(scenario);
  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    let staleBase: string | undefined;
    if (step.base === 'stale') {
      const doc = await base.persona.read(step.slug);
      if (doc === null) throw new Error(`場面 ${stepKey(scenario, index)}: stale の版が取れない`);
      staleBase = memoryVersion(doc.content);
    }
    if (step.externalEdit !== undefined) {
      vi.setSystemTime(new Date(callTime(index)));
      await base.persona.write(step.externalEdit.slug, step.externalEdit.content);
    }
    let baseVersion: string | undefined;
    if (step.base === 'current') {
      const doc = await base.persona.read(step.slug);
      if (doc === null) throw new Error(`場面 ${stepKey(scenario, index)}: current の版が取れない`);
      baseVersion = memoryVersion(doc.content);
    } else if (step.base === 'stale') {
      baseVersion = staleBase;
    } else if (typeof step.base === 'object') {
      baseVersion = step.base.raw;
    }
    const args = {
      slug: step.slug,
      content: step.content,
      summary: step.summary ?? 'テストの書き込み',
      ...(baseVersion === undefined ? {} : { base_version: baseVersion }),
    };
    const before = await snapshot(base, slugs);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    state = { documentsCalls: 0, raced: false, lastFloorChars: 0 };
    calls.length = 0;
    vi.stubEnv(MEMORY_GUARD_ENV, hooks.guardEnv ?? undefined);
    vi.setSystemTime(new Date(callTime(index)));
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
        errorName: error instanceof Error ? error.name : typeof error,
      };
    }
    vi.unstubAllEnvs();
    hooks = { ...DEFAULT_HOOKS };
    const after = await snapshot(base, slugs);
    const wrote = before.all !== after.all || before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      memory: after.memory,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、記憶が呼ぶ前と同じで、日誌にも行が足されない
      expect(
        after.all === before.all,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、記憶が呼ぶ前から変わった`,
      ).toBe(true);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
    if (step.writes === 'hook') {
      // 口が土台を書き換えるだけで、道具は日誌に何も足さない
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は道具が何も書かないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
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

describe('memory_write の出力と呼んだあとの状態の固定（場面ごとの出力の全文・記憶の本文・日誌の行・ストアの呼び）', () => {
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

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes !== 'none',
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

      it(`${key} の呼んだあとに日誌へ足された行が固定値と同じ`, () => {
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
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} のストアの呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} のストアの呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び（渡した引数・結果）が固定値からずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・記憶・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const writeCall = (key: string): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === 'persona.write');
    const doc = (key: string, slug: string): string => actual[key]?.memory[slug]?.content ?? '';
    const READ_ALL = ['persona.read', 'persona.documents'];
    const WRITE_ALL = [
      'persona.read',
      'persona.documents',
      'persona.write',
      'journal.append',
      'persona.documents',
    ];

    // スラッグの検査: ストアを1つも呼ばない
    for (const key of ['slug-invalid#1', 'slug-invalid#2', 'slug-invalid#3', 'slug-invalid#4']) {
      expect(text(key), key).toContain('記憶のスラッグが不正');
      expect(ops(key), key).toEqual([]);
    }
    expect(text('slug-invalid#5')).toContain('記憶のスラッグが不正');
    expect(ops('slug-invalid#6')).toEqual([]);

    // 新規作成の文・床の注記
    expect(text('create-premise-first')).toContain('記憶 about-me を作った（105 文字）。');
    expect(text('create-premise-first')).toContain('⭐ 新規作成: about-me（区分: premise）');
    expect(text('create-premise-first')).toContain('いま最も大きい premise: about-me');
    expect(text('create-premise-first')).toContain('現在値である');
    expect(text('create-premise-first')).not.toContain('消えた見出し');
    expect(text('create-premise-first')).not.toContain('本文の数字・識別子の増減');
    expect(ops('create-premise-first')).toEqual(WRITE_ALL);
    expect(writeCall('create-premise-first')?.args.ifMatch).toBeNull();
    expect(journal('create-premise-first')[0]).toMatchObject({
      type: 'memory_update',
      action: 'write',
      cause: 'clone',
      bytesBefore: 0,
      summary: '作った',
    });
    expect(text('create-premise-with-others')).toContain('いま最も大きい premise: about-me');
    expect(text('create-fact')).toContain('新規作成: facts（区分: fact）。');
    expect(text('create-fact')).not.toContain('⭐');
    expect(text('create-fact')).toContain('facts（fact・目次1行）');
    expect(text('create-indexed')).toContain('新規作成: work（区分: indexed）。');
    expect(text('create-plain')).toContain('⭐ 新規作成: memo（区分: premise）');
    expect(text('create-malformed')).toContain('⭐ 新規作成: broken（区分: premise）');
    expect(text('create-content-forms#1')).toContain('記憶 no-newline を作った（10 文字）。');
    expect(doc('create-content-forms#2', 'with-nul')).not.toContain('\u0000');
    expect(text('create-content-forms#2')).toContain('記憶 with-nul を作った（9 文字）。');
    expect(journal('create-content-forms#4')[0]?.bytesAfter).toBe(
      Buffer.byteLength('# 日本語\nあいうえお 😀\n', 'utf8'),
    );
    expect(text('create-content-forms#5')).toContain('（1,506 文字）');

    // 版の前提
    // 読んだ時点でも無かった文書へ版を渡した: 「読んだ後に消された」とは言わない（#6445）
    expect(text('create-with-base-version#1')).toContain('は無い（読んだ時点でも無かった）');
    expect(text('create-with-base-version#1')).not.toContain('読んだ後に消された');
    expect(ops('create-with-base-version#1')).toEqual([
      'persona.read',
      'persona.documents',
      'persona.write',
    ]);
    expect(writeCall('create-with-base-version#1')?.args.ifMatch).toBe(memoryVersion(ABOUT));
    expect(ops('create-with-base-version#2')).toEqual(WRITE_ALL);
    expect(text('update-needs-base#1')).toContain('は既に在る。全文を書き直すには');
    expect(text('update-needs-base#1')).toContain('**何も書いていない。**');
    expect(ops('update-needs-base#1')).toEqual(READ_ALL);
    expect(text('update-needs-base#2')).toContain('その間に変わった');
    expect(writeCall('update-needs-base#2')?.args.ifMatch).toBe('');
    expect(writeCall('update-needs-base#3')?.args.ifMatch).toBe(memoryVersion(ABOUT));
    expect(text('update-needs-base#3')).toContain('記憶 about-me を更新した。');
    expect(text('update-needs-base#3')).not.toContain('⭐');

    // 更新の文・差分・トークンの差
    expect(text('update-same-content')).toContain('105 → 105 文字（+0）');
    expect(text('update-same-content')).toContain('消えた見出し: なし。');
    expect(text('update-same-content')).not.toContain('本文の数字・識別子の増減');
    expect(text('update-same-content')).toContain('about-me（premise・カード（要旨＋節の目次））');
    expect(text('update-text-only#1')).toContain('+3');
    expect(text('update-text-only#2')).toContain('-7');
    expect(text('update-text-only#2')).not.toContain('本文の数字・識別子の増減');
    expect(text('update-tokens#1')).toContain('消えた: 42 / `id-7`。増えた: 43 / `id-8`。');
    expect(text('update-tokens#2')).toContain('増えた: 99。');
    expect(text('update-tokens#2')).not.toContain('消えた:');
    expect(text('update-tokens#3')).toContain('消えた: 43。');
    expect(text('update-tokens#3')).not.toContain('増えた:');
    expect(text('update-tokens#4')).toContain('（ほか 2 件）');
    expect(text('update-tokens#5')).toContain('（ほか 4 件）');
    expect(text('update-headings#1')).toContain('消えた見出し（1 件）:\n- ## 節C');
    expect(text('update-headings#2')).toContain('消えた見出し（2 件）:');
    expect(text('update-headings#3')).toContain('消えた見出し: なし。');
    expect(text('update-headings#5')).toContain('- ## 改めた節');
    expect(text('update-headings-dup-stays#1')).toContain('消えた見出し: なし。');
    expect(text('update-headings-dup-stays#2')).toContain('消えた見出し（1 件）:\n- # A');
    expect(text('update-headings-many')).toContain('…ほか 25 件は省略');
    expect(text('update-headings-many')).toContain('**残りを見る手はここに無い**');
    expect(journal('update-text-only#1')[0]).toMatchObject({ bytesBefore: 187, bytesAfter: 196 });

    // 区分の変更・順位・再注入の見込み
    expect(text('update-kind-changes#1')).toContain('about-me（fact・目次1行）');
    expect(text('update-kind-changes#1')).toContain('1. other: 224 文字');
    expect(text('update-kind-changes#2')).not.toContain('premise の大きさの順位');
    expect(text('update-kind-changes#3')).toContain('（区分: indexed）');
    expect(text('update-kind-changes#3')).not.toContain('premise の大きさの順位');
    expect(text('update-kind-changes#4')).toContain('premise の大きさの順位（大きい順、全 2 件）');
    expect(text('update-kind-changes#5')).toContain('消えた見出し（3 件）');
    expect(text('update-kind-changes#6')).toContain('消えた見出し（1 件）:\n- # メモ');
    expect(text('update-only-premise#1')).toContain(
      'premise の大きさの順位: いま premise はまだ無い。',
    );
    expect(text('update-only-premise#2')).not.toContain('premise の大きさの順位');
    expect(text('update-premise-delta#1')).toContain('med（premise・カードの変わった範囲だけ）');
    expect(text('update-premise-delta#2')).toContain('med（premise・カードの変わった範囲だけ）');
    expect(text('update-premise-delta#3')).toContain('med（premise・カードの変わった範囲だけ）');
    expect(text('update-premise-delta#4')).toContain('med（premise・カード（要旨＋節の目次））');
    expect(text('ranking-omitted')).toContain(
      '…ほか 3 件は省略（大きい順に 117 件だけ出した。全 120 件。',
    );
    expect(ops('ranking-omitted')).toEqual(WRITE_ALL);

    // 床の注記
    expect(text('floor-demoted#1')).toContain('2 件が1行に落ちている');
    expect(text('floor-demoted#1')).toContain('⭐ 新規作成: big-new');
    expect(text('floor-demoted#2')).toContain('2 件が1行に落ちている');
    expect(text('floor-demoted#2')).not.toContain('⭐');
    expect(text('floor-outline#1')).not.toContain('張り付いている');
    expect(text('floor-outline#1')).not.toContain('切られなくなった');
    expect(text('floor-outline#2')).toContain('張り付いている');
    expect(text('floor-outline#2')).toContain('全 90 節のうち 68 節だけ');
    expect(text('floor-outline#3')).toContain('切られなくなった');
    expect(text('floor-outline#4')).toContain('予算 6,000 文字を越えた');
    expect(text('floor-outline#5')).toContain('切られなくなった');
    expect(text('floor-outline#5')).toContain('big-toc（fact・目次1行）');
    expect(text('floor-outline-create')).toContain('big-new の節の目次が1文書あたりの予算');
    expect(text('floor-outline-create')).not.toContain('big-toc の節の目次');

    // runtime
    expect(text('create-premise-first')).not.toContain('セッション構築時点との差）');
    expect(text('runtime-grows#1')).toContain('増える見込み');
    expect(text('runtime-grows#1')).toContain('+125%');
    expect(text('runtime-grows#2')).toContain('セッション構築時点 100 文字 → いま 332 文字');
    expect(text('runtime-zero')).toContain('割合は出せない');
    expect(text('runtime-shrinks')).toContain('減る見込み');
    expect(text('runtime-equal')).toContain('変わっていない。');

    // 誰の走行か・保護
    for (const key of ['guard#1', 'guard#2', 'guard#10']) {
      expect(text(key), key).toContain('保護状態: human');
      expect(ops(key), key).toEqual(['persona.protectionStatus']);
    }
    expect(journal('guard#3')[0]?.cause).toBe('distill');
    expect(ops('guard#3')).toEqual(['persona.protectionStatus', ...WRITE_ALL]);
    expect(ops('guard#4')).toEqual(['persona.protectionStatus', ...READ_ALL]);
    expect(text('guard#4')).toContain('は既に在る。全文を書き直すには');
    expect(text('guard#5')).toContain('保護状態: unknown');
    expect(text('guard#6')).toContain('保護状態: unknown');
    expect(ops('guard#7')).toEqual(WRITE_ALL);
    expect(journal('guard#7')[0]?.cause).toBe('clone');
    expect(ops('guard#8')).toEqual(WRITE_ALL);
    expect(journal('guard#8')[0]?.cause).toBe('distill');
    expect(actual['guard#9']?.output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: 'ALTEROID_MEMORY_GUARD の値が不正: bogus（使えるのは on / off。既定は on）',
    });
    expect(ops('guard#9')).toEqual([]);
    expect(actual['guard#11']?.output.text).toBe('保護状態の読みが落ちた');

    // 版の食い違い
    expect(text('conflict#1')).toContain('（109 文字）');
    expect(text('conflict#2')).toContain('（105 文字）');
    expect(text('conflict#3')).toContain('（112 文字）');
    expect(text('conflict#4')).toContain('いまその文書は無い（読んだ後に消された）');
    for (const key of ['conflict#1', 'conflict#2', 'conflict#3', 'conflict#4']) {
      expect(text(key), key).toContain('**何も書いていない**');
      expect(actual[key]?.calls.at(-1)?.outcome, key).toMatch(/^threw MemoryConflictError/);
      expect(journal(key), key).toEqual([]);
    }
    expect(writeCall('conflict#2')?.args.ifMatch).toBe('deadbeef');
    expect(doc('conflict#3', 'a3')).toContain('別のターンが書いた');
    expect(doc('conflict#4', 'a4')).toBe('');

    // 例外
    expect(actual['failures#1']?.output).toMatchObject({
      thrown: true,
      text: 'ストアが落ちた（write）',
    });
    expect(ops('failures#1')).toEqual(['persona.read', 'persona.documents', 'persona.write']);
    expect(actual['failures#2']?.output.thrown).toBe(true);
    expect(actual['failures#3']?.output.text).toBe('ストアが落ちた（read）');
    expect(actual['failures#4']?.output.text).toBe('ストアが落ちた（documents）');
    expect(doc('failures#4', 'f3')).toBe(ABOUT);
    expect(actual['failures#5']?.output.text).toBe('ストアが落ちた（documents）');
    expect(doc('failures#5', 'f4')).toBe(ABOUT.replace('残る', '残らない'));
    // 書いた後の読み直しが落ちても、日誌は先に書いてある（記憶と日誌が食い違わない。#6445）
    expect(journal('failures#5')).toHaveLength(1);
    expect(ops('failures#5')).toEqual(WRITE_ALL);
    for (const key of ['failures#6', 'failures#7']) {
      expect(actual[key]?.output.errorName, key).toBe('JournalNotRecordedError');
      expect(text(key).split('\n')[0], key).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(journal(key), key).toEqual([]);
      // 日誌が落ちたら読み直しへは進まない
      expect(ops(key), key).toEqual([
        'persona.read',
        'persona.documents',
        'persona.write',
        'journal.append',
      ]);
    }
    expect(doc('failures#6', 'f5')).toBe(ABOUT.replace('残る', '残らない'));

    // 日誌の行
    expect(journal('journal-fields#1')[0]).toMatchObject({ bytesBefore: 33, bytesAfter: 12 });
    expect(journal('journal-fields#2')[0]?.summary).toContain('\n2行目 ');
    expect(journal('journal-fields#3')[0]).toMatchObject({ bytesBefore: 0, summary: '新規' });
    expect(text('update-normalized#2')).toContain('105 → 105 文字（+0）');
    expect(writeCall('update-normalized#2')?.args.contentChars).toBe(106);
  });
});
