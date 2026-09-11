import { describe, expect, it } from 'vitest';

import { runnerLivenessSchema } from './runner-protocol.js';
import { commitmentOriginSchema } from './schema.js';
import { RESERVED_SCHEDULE_KINDS, RESERVED_SCHEDULE_KIND_ENV_KEYS } from './schedule.js';
import { CLONE_RUNTIME_ITEM_LABELS } from './self.js';
import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, USAGE_AXES, createCloneTools } from './tools.js';

/**
 * **族の歯（#701 の穴に対する仕掛け）。**
 *
 * ## 何のためにここが在るか
 *
 * 実装が一覧（配列・enum）を持ち、その一覧のことをクローンへ渡る `description`
 * が**別々の散文で数え直している**という形が、この repo には繰り返し現れる。
 * 2026-09-08 の PR #701 は同じ日に2つ開け、片方（`memory_section_move`）を
 * #739 が手で直したが、**もう片方（予約 kind）は今日まで腐ったままだった。**
 * #733 / #739 はどちらも**その道具1本のための手書きの歯**で、族に対する仕掛けは
 * 無かった。ここがそれである。
 *
 * ## 測っているもの
 *
 * 「実装が持つ一覧の**全要素が、その道具の `description` に字面として現れる**」
 * ——それだけである。`source` は実装の出所そのものを呼ぶ（値をベタ書きしない）
 * ので、**一覧に値を1つ足せば、説明文を直すまでここが赤いままになる。**
 *
 * ## ⚠️ この歯が測っていないこと（正直に書く）
 *
 * - **説明文の日本語が実装のふるまいと一致しているかは測っていない。**
 *   測っているのは一覧の要素が**字面として現れること**だけである。要素が
 *   全部並んでいれば、その周りに書かれた説明が嘘でもここは緑になる
 *   （例: 予約 kind が3つ全部並んでいて、隣の文が「これは外せる」と嘘を
 *   書いていても通る）。ふるまいの側は道具ごとの歯（`tools.test.ts`）が持つ
 * - **要素が「意味のある文脈で」現れているかも測っていない。** 別の話題の
 *   途中に同じ語が偶然入っていれば通る（`token` のような短い語ほど起きやすい）
 * - **説明文がクローンのシステムプロンプトへ実際に載る配線は測っていない**
 *   （そちらは `prompt.test.ts` の側）
 * - **`description` 以外の面（応答の文言・`describe()` の引数説明・OpenAPI の
 *   description）は見ていない。** ここが見るのは `createCloneTools()` が返す
 *   `description` だけである
 *
 * ## なぜ `createCloneTools()` の返り値を見るのか
 *
 * **JSDoc はクローンに届かない。** 届くのはここが読んでいる `description`
 * だけである（#733 / #739 の歯も同じ形で書かれている）。
 */

/** 一覧の出所と、それを名乗る道具の対。**`source` は実装を呼ぶ。値を写さない。** */
interface EnumerationSubject {
  /** `CLONE_TOOL_NAMES` に在る道具名。 */
  readonly tool: string;
  /** 失敗メッセージに出す、その一覧の呼び名。 */
  readonly label: string;
  /** **実装の出所そのもの。** ここに配列リテラルを書いたら、この歯は3枚目の写しになる。 */
  readonly source: () => readonly string[];
}

const SUBJECTS: readonly EnumerationSubject[] = [
  {
    tool: 'schedule_list',
    label: 'RESERVED_SCHEDULE_KINDS（packages/core/src/schedule.ts）',
    source: () => RESERVED_SCHEDULE_KINDS,
  },
  {
    tool: 'schedule_create',
    label: 'RESERVED_SCHEDULE_KINDS（packages/core/src/schedule.ts）',
    source: () => RESERVED_SCHEDULE_KINDS,
  },
  {
    tool: 'runner_list',
    label: 'runnerLivenessSchema の値（packages/core/src/runner-protocol.ts）',
    source: () => runnerLivenessSchema.options,
  },
  {
    tool: 'usage_read',
    label: 'USAGE_AXES（packages/core/src/tools.ts）',
    source: () => USAGE_AXES,
  },
  {
    // **断り文言が案内する環境変数の名前も、同じ族である。** #701 以前ここは
    // `memory_tidy` を打ったクローンへ**実在しない対応**を案内していた。
    tool: 'schedule_create',
    label: 'RESERVED_SCHEDULE_KIND_ENV_KEYS の値（packages/core/src/schedule.ts）',
    source: () => Object.values(RESERVED_SCHEDULE_KIND_ENV_KEYS),
  },
  {
    // **この道具の説明文は「在る起点を全部並べた呼びは断る」と名乗る。** その
    // 「在る起点」は `commitmentOriginSchema` そのものなので、**起点が1つ増えた
    // 瞬間に説明文は嘘になる**（クローンは増えた起点を並べてよいのか判断できない）。
    // ⟹ EXEMPT ではなく SUBJECTS 側である。`commitment_list` が EXEMPT なのは、
    // あちらの説明文が起点を数え直していないからで、線引きはそこに在る。
    tool: 'commitment_close_many',
    label: 'commitmentOriginSchema の値（packages/core/src/schema.ts）',
    source: () => commitmentOriginSchema.options,
  },
  {
    tool: 'self_status',
    label: 'CLONE_RUNTIME_ITEM_LABELS（packages/core/src/self.ts）',
    source: () => CLONE_RUNTIME_ITEM_LABELS,
  },
];

/**
 * 表に載せない道具と、その理由。
 *
 * **`why` は非空でなければならない**（下の歯が測る）。「あとで書く」を空文字で
 * 表せると、免除表は数合わせの場所になる。
 */
interface Exemption {
  readonly tool: string;
  readonly why: string;
}

const EXEMPT: readonly Exemption[] = [
  {
    tool: 'memory_list',
    why: '説明文が名乗る一覧が実装側に配列として存在しない（保護状態の言い方は describeMemoryProtectionStatus が持つが、説明文はその値を列挙していない）。ふるまいの歯は tools.test.ts の memory_list の節が持つ',
  },
  { tool: 'memory_read', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'memory_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'memory_append', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'memory_delete', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'memory_frontmatter_set',
    why: '直せるキー（description / type / parent）は zod の引数定義そのものが名乗るので、説明文と引数説明の二重管理にはなっていない',
  },
  { tool: 'memory_outline', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'memory_section_read',
    why: '読めなかった理由の3値（古い / 曖昧 / 無い）は MemorySectionLookup の判別子だが、説明文はその字面ではなく日本語で言う。ふるまいの歯が tools.test.ts に在る',
  },
  {
    tool: 'memory_section_move',
    why: '断りの列挙が実装側に配列として存在しない（ハンドラの early return が出所）。この歯では捕まらないので、ふるまいを実際に走らせる歯を tools.test.ts に置いた（「出どころの文書がそもそも存在しない」の断り）',
  },
  { tool: 'journal_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'journal_read',
    why: '日誌の種別は zod の引数定義（journalEntryTypeSchema）が名乗るので、説明文が数え直していない',
  },
  {
    tool: 'conversation_read',
    why: '実装側に一覧が無い。approvals_list との線引き（答えの本文を持つか）はふるまいの歯を tools.test.ts に置いた',
  },
  { tool: 'ask_human', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'approvals_list',
    why: '実装側に一覧が無い。並び順の主張（作成時刻の昇順か）はふるまいの歯を tools.test.ts に置いた',
  },
  { tool: 'daily_report_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'schedule_remove', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'commitment_list',
    why: '台帳へ自動で載る出所は clone.ts の commitmentFor の switch が持ち、配列ではない。ふるまいを走らせる歯を tools.test.ts に置いた',
  },
  { tool: 'commitment_open', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'commitment_close', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'commitment_edit',
    why: '直せる行の条件（origin: self）は1値であって一覧ではない',
  },
  { tool: 'profile_read', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'profile_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'token_list',
    why: '状態の語は実装が出す文言そのもので、説明文はそれを列挙していない',
  },
  {
    tool: 'self_read',
    why: '読める正典の名前は canonNames() から引数説明を組み立てており、既に導出されている',
  },
  { tool: 'self_dropped', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'manager_start', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'manager_send', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'manager_stop',
    why: 'outcome の3値（stopped / not_stopped / unknown）は説明文が字面で列挙していない（日本語で言う）',
  },
  {
    tool: 'manager_list',
    why: '状態の字面は digest.ts の describeManagerState が組み立てており配列ではない。背景処理待ちの N が何かはふるまいを走らせる歯を tools.test.ts に置いた',
  },
  { tool: 'manager_report', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'manager_transcript', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'archive_remove', why: '実装側に、説明文が数え直すような一覧が無い' },
];

function descriptionOf(tool: string): string {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
  });
  return tools.find((entry) => entry.name === tool)?.description ?? '';
}

describe('実装が持つ一覧と、クローンへ渡る説明文', () => {
  describe.each(SUBJECTS)('$tool（出所: $label）', (subject) => {
    it('出所の全要素が説明文に現れる', () => {
      const values = subject.source();
      // 出所そのものが空なら、この歯は何も測っていない（空振り）。
      expect(values.length, `${subject.label} が空である。この歯は空振りしている`).toBeGreaterThan(
        0,
      );

      const description = descriptionOf(subject.tool);
      expect(description, `${subject.tool} の description が取れない`).not.toBe('');

      const missing = values.filter((value) => !description.includes(value));
      expect(
        missing,
        // 🔴 赤の意味。**名前に依存しない測り方が実在しないなら、名前への依存は
        // 測定手段そのものである。赤を消せないなら、赤の意味をここに書く。**
        `【赤の意味】${subject.label} に在る値が、${subject.tool} の説明文に現れていない: ` +
          `${missing.join(' / ')}\n` +
          '一覧に値を足したが、説明文がその値を含んでいない。説明文を出所から導出しているか確かめること' +
          '（説明文の側で手で書き直すと、次に一覧が増えたときまた同じところが腐る）。\n' +
          '⚠️ この歯は「字面が現れるか」しか見ていない。値を並べただけで意味が合っていない説明文は、' +
          'ここでは捕まらない——直すときは説明文の文意も実装と合わせること。',
      ).toEqual([]);
    });
  });

  /**
   * **網羅の歯。** 37本目の道具を足した人は、上の表か免除表のどちらかへ書くまで
   * CI が赤いままになる。
   *
   * ⚠️ **この歯が測っていないこと**: 免除の `why` が**正しいか**は測っていない。
   * 非空の文字列が在ることしか見ない——「一覧が無い」と書いてあるのに実は在る、
   * という嘘はここでは捕まらない。捕まるのは「何も書かずに素通りさせること」だけである。
   */
  describe('網羅（CLONE_TOOL_NAMES の全部が、表か免除表のどちらかに在る）', () => {
    it('どちらにも載っていない道具が無い', () => {
      const covered = new Set([...SUBJECTS.map((s) => s.tool), ...EXEMPT.map((e) => e.tool)]);
      const uncovered = CLONE_TOOL_NAMES.filter((name) => !covered.has(name));
      expect(
        uncovered,
        `【赤の意味】次の道具が、一覧の歯の表にも免除表にも載っていない: ${uncovered.join(' / ')}\n` +
          '道具を足したら、この2つのどちらかへ入れること。\n' +
          '- 実装が一覧（配列・enum）を持ち、その一覧を説明文が数え直しているなら SUBJECTS へ' +
          '（source は実装の出所そのものを呼ぶこと。値をベタ書きしない）\n' +
          '- そうでないなら EXEMPT へ、なぜ表に載せないのかを why に書くこと' +
          '（`packages/core/src/tool-description-enumeration.test.ts`）',
      ).toEqual([]);
    });

    it('両方に載っている道具が無い（どちらで測っているのかが決まらない）', () => {
      const exempt = new Set(EXEMPT.map((e) => e.tool));
      const both = SUBJECTS.filter((s) => exempt.has(s.tool)).map((s) => s.tool);
      expect(
        both,
        `【赤の意味】次の道具が表と免除表の両方に在る: ${both.join(' / ')}。どちらか一方にすること`,
      ).toEqual([]);
    });

    it('表にも免除表にも、CLONE_TOOL_NAMES に無い名前が載っていない', () => {
      const known = new Set<string>(CLONE_TOOL_NAMES);
      const unknown = [...SUBJECTS.map((s) => s.tool), ...EXEMPT.map((e) => e.tool)].filter(
        (name) => !known.has(name),
      );
      expect(
        unknown,
        `【赤の意味】CLONE_TOOL_NAMES に無い名前が載っている: ${unknown.join(' / ')}。` +
          '道具の名前が変わった（または消えた）のに、こちらが追随していない',
      ).toEqual([]);
    });

    it('免除の理由（why）が全部、非空である', () => {
      const blank = EXEMPT.filter((e) => e.why.trim().length === 0).map((e) => e.tool);
      expect(
        blank,
        `【赤の意味】免除の理由が空である: ${blank.join(' / ')}。` +
          'なぜ一覧の歯に載せないのかを書くこと（空欄を許すと、免除表は数合わせの場所になる）',
      ).toEqual([]);
    });
  });
});
