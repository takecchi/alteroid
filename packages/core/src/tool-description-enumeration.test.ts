import { describe, expect, it } from 'vitest';

import { CLONE_REMOVABLE_INBOX_EVENT_TYPES } from './inbox-backlog.js';
import { runnerLivenessSchema } from './runner-protocol.js';
import { commitmentOriginSchema } from './schema.js';
import { RESERVED_SCHEDULE_KINDS, RESERVED_SCHEDULE_KIND_ENV_KEYS } from './schedule.js';
import { CLONE_RUNTIME_ITEM_LABELS } from './self.js';
import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, USAGE_AXES, createCloneTools } from './tools.js';

interface EnumerationSubject {
  readonly tool: string;
  readonly label: string;
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
    tool: 'schedule_create',
    label: 'RESERVED_SCHEDULE_KIND_ENV_KEYS の値（packages/core/src/schedule.ts）',
    source: () => Object.values(RESERVED_SCHEDULE_KIND_ENV_KEYS),
  },
  {
    tool: 'commitment_close_many',
    label: 'commitmentOriginSchema の値（packages/core/src/schema.ts）',
    source: () => commitmentOriginSchema.options,
  },
  {
    tool: 'self_status',
    label: 'CLONE_RUNTIME_ITEM_LABELS（packages/core/src/self.ts）',
    source: () => CLONE_RUNTIME_ITEM_LABELS,
  },
  {
    tool: 'inbox_remove_many',
    label: 'CLONE_REMOVABLE_INBOX_EVENT_TYPES（packages/core/src/inbox-backlog.ts）',
    source: () => CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  },
];

interface Exemption {
  readonly tool: string;
  readonly why: string;
}

const EXEMPT: readonly Exemption[] = [
  {
    tool: 'attachment_fetch',
    why: '説明文が名乗る一覧（enum・配列）が無い。保持期限・写しの寿命は説明文の散文で、ふるまいの歯は attachment-fetch.test.ts が持つ',
  },
  {
    tool: 'memory_list',
    why: '説明文が名乗る一覧が実装側に配列として存在しない（保護状態の言い方は describeMemoryProtectionStatus が持つが、説明文はその値を列挙していない）。ふるまいの歯は tools.test.ts の memory_list の節が持つ',
  },
  {
    tool: 'progress_read',
    why: '説明文が名乗る一覧（enum・配列）が無い。窓の既定は引数の説明が DEFAULT_PROGRESS_WINDOW_HOURS から作る。ふるまいの歯は progress-read.test.ts が持つ',
  },
  {
    tool: 'github_observation_record',
    why: '説明文が名乗る一覧（enum・配列）が無い。入力は githubObservationInputSchema（日誌の枝から導く）が名乗る。ふるまいの歯は github-observation-record.test.ts が持つ',
  },
  {
    tool: 'commitment_close',
    why: '説明文が名乗る一覧（enum・配列）が無い（かつて数え直していた評定の値は、評定の仕組みごと #2699 で消えた）',
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
  {
    tool: 'conversation_post',
    why: '実装側に一覧が無い（宛先の会話 id と本文を受けるだけ）。ふるまいの歯は tools.test.ts に置いた（#1393）',
  },
  { tool: 'ask_human', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'approvals_list',
    why: '実装側に一覧が無い。並び順の主張（作成時刻の昇順か）はふるまいの歯を tools.test.ts に置いた',
  },
  {
    tool: 'approval_trace',
    why: '説明文が名乗る状態の言い方（まだ答えが無い／記録を始める前／記録が動いていない疑い）は approval-trace.ts の ApprovalTraceState の値だが、説明文は字面ではなく日本語で言う。ふるまいの歯は approval-trace.test.ts に置いた（#847）',
  },
  { tool: 'approval_withdraw', why: '実装側に、説明文が数え直すような一覧が無い（#963）' },
  {
    tool: 'request_permission',
    why: '説明文は区切り文字の一覧も定型文も数え直していない（検算は permission-rule.ts、ふるまいの歯は permission-rule.test.ts と tools.test.ts。#863）',
  },
  { tool: 'daily_report_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'schedule_remove', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'commitment_list',
    why: '台帳へ自動で載る出所は clone.ts の commitmentFor の switch が持ち、配列ではない。ふるまいを走らせる歯を tools.test.ts に置いた',
  },
  { tool: 'commitment_open', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'commitment_edit',
    why: '直せる行の条件（origin: self）は1値であって一覧ではない',
  },
  { tool: 'profile_read', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'profile_write', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'profile_remove', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'practice_list', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'practice_read', why: '実装側に、説明文が数え直すような一覧が無い' },
  {
    tool: 'practice_write',
    why: 'kind は自由文字列（enum ではない）。説明文の例示（実装・調査・相談…）は網羅の主張ではなく、実装側に数え直すべき配列・enum が存在しない',
  },
  { tool: 'practice_remove', why: '実装側に、説明文が数え直すような一覧が無い' },
  { tool: 'practice_history', why: '実装側に、説明文が数え直すような一覧が無い（#1309）' },
  {
    tool: 'token_list',
    why: '状態の語は実装が出す文言そのもので、説明文はそれを列挙していない',
  },
  {
    tool: 'permission_grant_list',
    why: '状態の語（有効 / 取り消し済み）は実装が出す文言そのもので、説明文はそれを列挙していない',
  },
  {
    tool: 'account_list',
    why: '状態の語（許可済み / 未許可）は実装が出す文言そのもので、説明文はそれを列挙していない',
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
  {
    tool: 'archive_remove_many',
    why: '実装側に、説明文が数え直すような一覧が無い（enum ではなく sessionIds / before / minStoredBytes という3つの絞り込み軸で、値の集合ではない）',
  },
];

function descriptionOf(tool: string): string {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return tools.find((entry) => entry.name === tool)?.description ?? '';
}

describe('実装が持つ一覧と、クローンへ渡る説明文', () => {
  describe.each(SUBJECTS)('$tool（出所: $label）', (subject) => {
    it('出所の全要素が説明文に現れる', () => {
      const values = subject.source();
      expect(values.length, `${subject.label} が空である。この歯は空振りしている`).toBeGreaterThan(
        0,
      );

      const description = descriptionOf(subject.tool);
      expect(description, `${subject.tool} の description が取れない`).not.toBe('');

      const missing = values.filter((value) => !description.includes(value));
      expect(
        missing,
        `【赤の意味】${subject.label} に在る値が、${subject.tool} の説明文に現れていない: ` +
          `${missing.join(' / ')}\n` +
          '一覧に値を足したが、説明文がその値を含んでいない。説明文を出所から導出しているか確かめること' +
          '（説明文の側で手で書き直すと、次に一覧が増えたときまた同じところが腐る）。\n' +
          '⚠️ この歯は「字面が現れるか」しか見ていない。値を並べただけで意味が合っていない説明文は、' +
          'ここでは捕まらない——直すときは説明文の文意も実装と合わせること。',
      ).toEqual([]);
    });
  });

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
