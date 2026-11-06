import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttachmentPutInput } from './attachment.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 添付の id は `randomUUID()` で付くので、この試験の中だけ連番の作りものに差し替える（場面ごとに 1 から振り直す）
const fakeUuid = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` =>
    `00000000-0000-4000-8000-${String(fakeUuid.next++).padStart(12, '0')}`;
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

// `file_list` の出力（全文と字数）と、ストアの呼びの並び（日誌の会話の読み・`attachments.list` に渡した絞り込み・`attachments.usage`）を、
// 場面ごとにコミットした固定値（clone-tools-file-list-output-pin.json）と丸ごと比べる。
// `clone-tools-attach.ts` の `tool('file_list', …)`（conversationId の解決（ambiguous は断る・prefix は読み替えて注記を先頭へ）→ `listFiles`（絞り込みを
// 渡した分だけ載せて置き場を読む → 使用量 → 一覧（予算で切れたら cursor）→ 例外は「置き場の一覧を読めなかった」））を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・添付・会話）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）。この道具は例外を握って文にするので、ふつう thrown は false
//   - calls: ストアの呼びの並び。日誌の会話の読み（`journal.listPage`・`journal.conversationIdsWithPrefix`）・`attachments.list`（渡した絞り込みと、返した件数・
//     次の cursor の有無）・`attachments.usage`。道具が呼ぶのはこれだけで、添付の書き込み口・中身を読む口・日誌の書き込みを呼べば記録に出る（下で別に確かめる）
//   - wrote: 添付（控えの全件）か日誌が、呼ぶ前から変わったか。この道具は読むだけなので、どの場面も false
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_FILE_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-file-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-file-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。添付は場面の頭に SEED_ISO から 1 分ずつ進めて置き（作成の時刻が互いに違い、新しい順が決まる）、
// 呼びは CALL_ISO（呼びごとに 1 分ずつ進む。期限切れの場面だけ `at` で指す）で呼ぶ。添付の id は上の連番の作りもの（`00000000-0000-4000-8000-0000000000NN`）。
// 日誌の会話は人間との往復を 1 行ずつ入れて作る（`resolveConversationId` が見る）。
//
// 作り方の注記:
//   - 予算（FILE_LIST_BUDGET = 6,000 字）と 1 回に取る件数（FILE_LIST_PAGE = 50）はこの試験の側に値を持つ（道具の定数を import しない）。
//     1 件の行は id が 36 字あるので 50 件で 6,000 字に収まらず、予算が先に効く。だから「予算で切れていない（…まだある）」の分岐は作れない（報告に書く）
//   - 長い文字列を作る `spaced(len)` は、語（既定は 9 字の `abcdefghi`）と空白の繰り返しで、空白は語の長さ＋1 字ごと（この試験は既定の語だけを使うので 10 字ごと）
//
// 秘密: 値は作りものだけ（名前・会話 id・鍵の id は `integration:key-a` などの作りもの）。この道具は中身を読まず、控えの名前・種類・大きさ・出所の分類だけを出す。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い名前は `spaced` で空白を挟む。

type Args = Record<string, unknown>;

type Fail = 'plain' | null;

interface Hooks {
  /** `attachments.list` を失敗させる */
  listFails: Fail;
  /** `attachments.usage` を失敗させる */
  usageFails: Fail;
  /** 日誌の会話の読み（`journal.listPage`）を失敗させる */
  journalFails: Fail;
}

const DEFAULT_HOOKS: Hooks = { listFails: null, usageFails: null, journalFails: null };

interface SeedFile {
  name: string;
  mediaType: string;
  /** 中身の大きさ（バイト）。中身は 0 埋め */
  size: number;
  uploadedBy?: string;
  conversationId?: string;
  kept?: boolean;
}

interface SeedConversation {
  id: string;
  text: string;
}

interface Step {
  args?: Args | ((previous: string) => Args);
  hooks?: Partial<Hooks>;
  /** この呼びの時刻（省略すると CALL_ISO から 1 分ずつ） */
  at?: string;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  files: SeedFile[];
  conversations?: SeedConversation[];
  steps: Step[];
}

const SEED_ISO = '2026-10-01T00:00:00.000Z';
const CALL_ISO = '2026-10-10T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-file-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_FILE_LIST_PIN === '1';

const FILE_LIST_BUDGET = 6_000;
const FILE_LIST_PAGE = 50;

function seedTime(index: number): string {
  return new Date(Date.parse(SEED_ISO) + index * 60_000).toISOString();
}

function callTime(index: number): string {
  return new Date(Date.parse(CALL_ISO) + index * 60_000).toISOString();
}

/** 長さ len の、語（既定は 9 字の `abcdefghi`）と空白の繰り返し。空白は語の長さ＋1 字ごと（既定で 10 字ごと）。末尾は空白にしない */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function f(name: string, extra: Partial<SeedFile> = {}): SeedFile {
  return { name, mediaType: 'text/plain', size: 10, ...extra };
}

/** 前の出力の「続きは file_list cursor=… 」から cursor を取り出して、渡した絞り込みと一緒に返す */
function follow(filters: Args = {}): (previous: string) => Args {
  return (previous) => {
    const found = /続きは file_list cursor=(\S+) /u.exec(previous);
    if (found === null || found[1] === undefined) throw new Error('前の出力に cursor の案内が無い');
    return { ...filters, cursor: found[1] };
  };
}

const CONV_A = 'c1a2b3c4-0000-4000-8000-000000000001';
const CONV_D1 = 'd5e6f7a8-0000-4000-8000-000000000001';
const CONV_D2 = 'd5e6f7a8-0000-4000-8000-000000000002';
const CONVERSATIONS: SeedConversation[] = [
  { id: CONV_A, text: '一つ目の会話' },
  { id: CONV_D1, text: '二つ目の会話' },
  { id: CONV_D2, text: '三つ目の会話' },
];

/** 出所の各分類・保存中・未結び付け・会話つき・多バイトの名前を含む標準の 8 件 */
const MIX: SeedFile[] = [
  f('human-report.pdf', {
    mediaType: 'application/pdf',
    size: 2 * 1024 * 1024 + 51_200,
    uploadedBy: 'operator',
    conversationId: CONV_A,
  }),
  f('レポート 😀.txt', { size: 1_536, uploadedBy: 'account:acc-1', kept: true }),
  f('clone-output.zip', { mediaType: 'application/zip', size: 900, uploadedBy: 'clone' }),
  f('manager-log.txt', { size: 1_023, uploadedBy: 'manager:mgr-001', conversationId: CONV_D1 }),
  f('integration-dump.json', {
    mediaType: 'application/json',
    size: 1_024,
    uploadedBy: 'integration:key-a',
    conversationId: CONV_D1,
  }),
  f('unknown-origin.bin', { mediaType: 'application/octet-stream', size: 1 }),
  f('other-origin.txt', { size: 5, uploadedBy: 'something-else', conversationId: CONV_A }),
  f(spaced(120), { size: 7 }),
];

const SCENARIOS: Scenario[] = [
  {
    name: 'empty',
    covers:
      '添付が無い: 「置き場の使用量: 0 件 0 B」＋「（この条件に合う添付は無い）」。絞り込みを付けても同じ。控えだけの説明の行は付かない',
    files: [],
    steps: [{}, { args: { kept: true } }, { args: { query: 'x', from: 'human' } }],
  },
  {
    name: 'few',
    covers:
      '数件（新しい順）: 1 件ずつ id・名前（80 字で切る）・種類・大きさ（B / KiB / MiB の境目）・出所の分類（人間・クローン・マネージャー・連携・不明。operator と account: は人間、知らない形は不明）・保存中（期限なし）か未結び付け（消える時刻つき）か期限つき・作成と更新。使用量（合計と出所ごと・連携の鍵ごと）が先に付く。多バイト文字と絵文字の名前',
    files: MIX,
    steps: [{}],
  },
  {
    name: 'usage',
    covers:
      '使用量の行: 合計＋0 でない出所だけの内訳＋連携の鍵ごとの内訳（鍵が複数）。件数 0 の出所は出ない。大きさの単位（B・KiB・MiB）',
    files: [
      f('a', { size: 100, uploadedBy: 'operator' }),
      f('b', { size: 2_000, uploadedBy: 'operator' }),
      f('c', { size: 3 * 1024 * 1024, uploadedBy: 'integration:key-a' }),
      f('d', { size: 10, uploadedBy: 'integration:key-b' }),
      f('e', { size: 20, uploadedBy: 'integration:key-b' }),
    ],
    steps: [{}, { args: { from: 'human' } }, { args: { from: 'clone' } }],
  },
  {
    name: 'filters-kept',
    covers:
      'kept=true は保存中だけ・kept=false は保存していないものだけ。使用量は絞り込みに関わらず置き場の全体',
    files: MIX,
    steps: [{ args: { kept: true } }, { args: { kept: false } }],
  },
  {
    name: 'filters-from',
    covers:
      'from の各値（human・clone・manager・integration・unknown）だけに絞る。0 件の絞り込みは「この条件に合う添付は無い」',
    files: MIX,
    steps: [
      { args: { from: 'human' } },
      { args: { from: 'clone' } },
      { args: { from: 'manager' } },
      { args: { from: 'integration' } },
      { args: { from: 'unknown' } },
    ],
  },
  {
    name: 'filters-query',
    covers:
      'query は名前の部分一致（大文字小文字を問わない・多バイト・絵文字・空白入り）。一致が無ければ 0 件。種類（mediaType）には当たらない',
    files: MIX,
    steps: [
      { args: { query: 'report' } },
      { args: { query: 'REPORT' } },
      { args: { query: 'レポート' } },
      { args: { query: '😀' } },
      { args: { query: 'abcdefghi abcdefghi' } },
      { args: { query: 'no-such-name' } },
      { args: { query: 'application' } },
    ],
  },
  {
    name: 'filters-combined',
    covers:
      '絞り込みの組み合わせ: kept ＋ from・from ＋ query・kept ＋ query ＋ conversationId（完全な id）。渡した欄だけを aggregate ならぬ list に渡す',
    files: MIX,
    conversations: CONVERSATIONS,
    steps: [
      { args: { kept: false, from: 'human' } },
      { args: { from: 'integration', query: 'dump' } },
      { args: { kept: false, query: 'txt', conversationId: CONV_A } },
      { args: { kept: true, from: 'clone' } },
    ],
  },
  {
    name: 'conversation',
    covers:
      'conversationId: 完全な id はそのまま絞る（注記なし）・8 文字以上で1つに決まる先頭は読み替えて「（会話 id の先頭 … を、それで始まる唯一の会話 … と読んだ）」を先頭へ添える・当たりが複数は「置き場の一覧は読んでいない。… で始まる会話が複数在るので、どれか決められない」（置き場を読まない）・当たらない id はそのまま絞って 0 件・7 文字以下はたとえ1つに決まっても読み替えず 0 件',
    files: MIX,
    conversations: CONVERSATIONS,
    steps: [
      { args: { conversationId: CONV_A } },
      { args: { conversationId: 'c1a2b3c4' } },
      { args: { conversationId: 'c1a2b3c4-0000' } },
      { args: { conversationId: 'd5e6f7a8' } },
      { args: { conversationId: CONV_D1 } },
      { args: { conversationId: 'zzzzzzzz' } },
      { args: { conversationId: 'no-such-conversation' } },
      { args: { conversationId: 'c1a2b3c' } },
      { args: { conversationId: 'd5e6f7a' } },
    ],
  },
  {
    name: 'conversation-prefix-with-filters',
    covers:
      '読み替えた先頭の会話に他の絞り込みを重ねる: 注記が先頭に付いたまま、読み替えた完全な id で list を呼ぶ（calls の conversationId は完全な id）。読み替えても 0 件なら注記＋「この条件に合う添付は無い」',
    files: MIX,
    conversations: CONVERSATIONS,
    steps: [
      { args: { conversationId: 'c1a2b3c4', from: 'human' } },
      { args: { conversationId: 'c1a2b3c4', query: 'no-such' } },
    ],
  },
  {
    name: 'budget-and-cursor',
    covers:
      '予算（6,000 字）で切れて cursor が出る: 60 件を新しい順に出し、「…ほか N 件は省略（この呼び出しで 50 件取り、新しい順に M 件だけ出した）。続きは file_list cursor=… （同じ絞り込みで渡す）」。その cursor を同じ絞り込みで渡して最後まで読む（残りが予算に収まれば省略の文は付かない）。件数の合計は 60 件',
    files: Array.from({ length: 60 }, (_, i) =>
      f(`bulk-${String(i + 1).padStart(3, '0')}.txt`, { size: 100 + i, uploadedBy: 'operator' }),
    ),
    steps: [{}, { args: follow() }],
  },
  {
    name: 'budget-and-cursor-filters',
    covers:
      '絞り込みを付けたまま cursor で続ける: 絞り込み（from・query）を同じに渡すと続きが読め、注記・使用量は毎回付く',
    files: [
      ...Array.from({ length: 70 }, (_, i) =>
        f(`bulk-${String(i + 1).padStart(3, '0')}.txt`, { size: 100 + i, uploadedBy: 'operator' }),
      ),
      f('other.txt', { uploadedBy: 'clone' }),
    ],
    steps: [
      { args: { from: 'human', query: 'bulk' } },
      { args: follow({ from: 'human', query: 'bulk' }) },
      { args: follow({ from: 'human', query: 'bulk' }) },
    ],
  },
  {
    name: 'cursor-refused',
    covers:
      'cursor が読めない（壊れている・空でない別物）: 「cursor が読めない。前回の応答の「続きは file_list cursor=…」をそのまま渡す（自分で組み立てない）。」。使用量は読まない。例外ではない',
    files: MIX,
    steps: [
      { args: { cursor: 'garbage' } },
      { args: { cursor: '!!!' } },
      { args: { cursor: Buffer.from('not json', 'utf8').toString('base64url') } },
    ],
  },
  {
    name: 'expired',
    covers:
      '期限切れのものは出ない（保持 30 日）: 31 日後の呼びでは期限つきの添付は一覧にも使用量にも出ず、保存中のものだけが残る。全部期限切れなら 0 件。保存中は残る',
    files: [
      f('kept.txt', { uploadedBy: 'operator', kept: true }),
      f('bound.txt', { uploadedBy: 'operator', conversationId: CONV_A }),
      f('unbound.txt', { uploadedBy: 'clone' }),
    ],
    conversations: CONVERSATIONS,
    steps: [
      {},
      { at: '2026-11-05T00:00:00.000Z' },
      { at: '2026-11-05T00:00:00.000Z', args: { kept: false } },
    ],
  },
  {
    name: 'read-fails',
    covers:
      '読みで例外（握って文にする）: `attachments.list` が投げる・`attachments.usage` が投げる・日誌の会話の読みが投げる（conversationId を渡した呼び）、のどれも「置き場の一覧を読めなかった: <理由>（もう一度試すと直る場合がある）」。例外では返らず isError でもない。conversationId の無い呼びは日誌を読まないので journalFails は効かない。そのあと口を外すと普通に読める',
    files: [f('a.txt', { uploadedBy: 'operator' })],
    conversations: CONVERSATIONS,
    steps: [
      { hooks: { listFails: 'plain' } },
      { hooks: { usageFails: 'plain' } },
      { args: { conversationId: CONV_A }, hooks: { journalFails: 'plain' } },
      { hooks: { journalFails: 'plain' } },
      {},
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

interface PinnedStep {
  output: PinnedOutput;
  /** 添付か日誌が呼ぶ前から変わったか。この道具は読むだけなので常に false */
  wrote: boolean;
  /** ストアの呼びの並び（道具の呼びだけ） */
  calls: PinnedCall[];
}

interface PinFile {
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 添付の控えの全件（期限切れも含めず `list` が返す分）・使用量・日誌の全行を、そのまま JSON にしたもの。呼ぶ前後で比べる */
async function snapshot(stores: Stores): Promise<string> {
  const page = await stores.attachments.list({ limit: 1_000 });
  return JSON.stringify({
    items: page.items,
    usage: await stores.attachments.usage(),
    journal: await stores.journal.list({ order: 'asc' }),
  });
}

function failureOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `threw ${name}: ${error instanceof Error ? error.message : String(error)}`;
}

/** 道具の呼びを `calls` へ記録し、口（hooks）で失敗を起こす。想定した読み以外の口を呼ぶと、そのまま記録に残る */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  const attachments: Stores['attachments'] = Object.create(
    base.attachments,
  ) as Stores['attachments'];
  const guarded = new Proxy(attachments, {
    get(target, prop, receiver) {
      if (prop === 'list') {
        return async (query: Parameters<Stores['attachments']['list']>[0]) => {
          const args: Record<string, unknown> = plain(query) as unknown as Record<string, unknown>;
          try {
            if (hooks().listFails === 'plain') throw new Error('置き場が落ちた（list）');
            const page = await base.attachments.list(query);
            calls.push({
              op: 'attachments.list',
              args,
              outcome: `${String(page.items.length)} items / nextCursor ${page.nextCursor === undefined ? 'なし' : 'あり'}`,
            });
            return page;
          } catch (error) {
            calls.push({ op: 'attachments.list', args, outcome: failureOf(error) });
            throw error;
          }
        };
      }
      if (prop === 'usage') {
        return async () => {
          try {
            if (hooks().usageFails === 'plain') throw new Error('置き場が落ちた（usage）');
            const usage = await base.attachments.usage();
            calls.push({
              op: 'attachments.usage',
              args: {},
              outcome: `${String(usage.count)} 件`,
            });
            return usage;
          } catch (error) {
            calls.push({ op: 'attachments.usage', args: {}, outcome: failureOf(error) });
            throw error;
          }
        };
      }
      const member = Reflect.get(base.attachments, prop, receiver) as unknown;
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        calls.push({ op: `attachments.${String(prop)}`, args: {}, outcome: 'called' });
        return (member as (...a: unknown[]) => unknown).apply(base.attachments, args);
      };
    },
  });
  return {
    ...base,
    attachments: guarded,
    journal: {
      ...base.journal,
      listPage: async (query) => {
        const args = plain(query) as Record<string, unknown>;
        try {
          if (hooks().journalFails === 'plain') throw new Error('日誌が落ちた（listPage）');
          const page = await base.journal.listPage(query);
          calls.push({
            op: 'journal.listPage',
            args,
            outcome: `${String(page.entries.length)} entries`,
          });
          return page;
        } catch (error) {
          calls.push({ op: 'journal.listPage', args, outcome: failureOf(error) });
          throw error;
        }
      },
      conversationIdsWithPrefix: async (query) => {
        const args = plain(query) as Record<string, unknown>;
        try {
          const ids = await base.journal.conversationIdsWithPrefix(query);
          calls.push({
            op: 'journal.conversationIdsWithPrefix',
            args,
            outcome: `${String(ids.length)} ids`,
          });
          return ids;
        } catch (error) {
          calls.push({ op: 'journal.conversationIdsWithPrefix', args, outcome: failureOf(error) });
          throw error;
        }
      },
      append: async (entry) => {
        calls.push({ op: 'journal.append', args: plain(entry), outcome: 'called' });
        return base.journal.append(entry);
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  fakeUuid.next = 1;
  const base = createMemoryStores();
  for (const [index, entry] of scenario.files.entries()) {
    vi.setSystemTime(new Date(seedTime(index)));
    const input: AttachmentPutInput = {
      name: entry.name,
      mediaType: entry.mediaType,
      bytes: new Uint8Array(entry.size),
      ...(entry.uploadedBy === undefined ? {} : { uploadedBy: entry.uploadedBy }),
      ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
      ...(entry.kept === true ? { kept: true } : {}),
    };
    await base.attachments.put(input);
  }
  for (const [index, conversation] of (scenario.conversations ?? []).entries()) {
    vi.setSystemTime(new Date(seedTime(index)));
    await base.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: conversation.text,
      conversationId: conversation.id,
    });
  }
  let hooks: Hooks = { ...DEFAULT_HOOKS };
  const calls: PinnedCall[] = [];
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'file_list');
  if (!found) throw new Error('file_list が無い');

  const results: PinnedStep[] = [];
  let previous = '';
  for (const [index, step] of scenario.steps.entries()) {
    vi.setSystemTime(new Date(step.at ?? callTime(index)));
    const before = await snapshot(base);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    calls.length = 0;
    const args = typeof step.args === 'function' ? step.args(previous) : (step.args ?? {});
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
    previous = output.text;
    hooks = { ...DEFAULT_HOOKS };
    const toolCalls = plain(calls);
    const after = await snapshot(base);
    results.push({ output, wrote: before !== after, calls: toolCalls });
    // 読むだけ: 添付も日誌も、呼ぶ前と1文字も変わらない
    expect(
      after === before,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、添付か日誌が呼ぶ前から変わった`,
    ).toBe(true);
    // 道具が呼ぶのは日誌の会話の読み・attachments.list・attachments.usage だけ
    for (const call of toolCalls) {
      expect(
        [
          'journal.listPage',
          'journal.conversationIdsWithPrefix',
          'attachments.list',
          'attachments.usage',
        ],
        `場面 ${stepKey(scenario, index)} が ${call.op} を呼んだ`,
      ).toContain(call.op);
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

describe('file_list の出力と呼びの並びの固定（場面ごとの出力の全文・ストアの呼び・読むだけであること）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CALL_ISO));
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

  it('どの場面も読むだけ（添付・日誌が呼ぶ前と同じ）で、固定値もそう記録している', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 読むだけの道具が書き込みを起こした`).toBe(false);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が false でない`).toBe(false);
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

      it(`${key} の呼びの並び（日誌の会話の読み・list に渡した絞り込み・usage）が固定値と同じ`, () => {
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

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・id・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（json に鍵らしい形と絶対パスが無い）', () => {
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-|ghp_|github_pat_|AKIA|xox[abp]-/);
    expect(pinnedRaw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
    expect(pinnedRaw).not.toContain('/tmp/');
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const listArgs = (key: string): unknown =>
      step(key).calls.find((entry) => entry.op === 'attachments.list')?.args;
    const entryNames = (key: string): string[] =>
      text(key)
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).split(' ').slice(1).join(' '));
    const itemCount = (key: string): number =>
      text(key)
        .split('\n')
        .filter((line) => line.startsWith('- 00000000-')).length;
    const EMPTY = '（この条件に合う添付は無い）';
    const READ_FAILED = (reason: string): string =>
      `置き場の一覧を読めなかった: ${reason}（もう一度試すと直る場合がある）`;
    const LIST_OPS = ['attachments.list', 'attachments.usage'];

    // 空
    expect(text('empty#1')).toBe(`置き場の使用量: 0 件 0 B\n${EMPTY}`);
    expect(text('empty#2')).toBe(text('empty#1'));
    expect(text('empty#3')).toBe(text('empty#1'));
    expect(ops('empty#1')).toEqual(LIST_OPS);
    expect(listArgs('empty#1')).toEqual({ limit: FILE_LIST_PAGE });
    expect(listArgs('empty#2')).toEqual({ limit: FILE_LIST_PAGE, kept: true });
    expect(listArgs('empty#3')).toEqual({ limit: FILE_LIST_PAGE, from: 'human', q: 'x' });

    // 数件
    const few = text('few');
    expect(few).toContain('置き場の使用量: 8 件 ');
    expect(few).toContain('出所別: ');
    expect(few).toContain('連携の鍵別: key-a 1 件 1.0 KiB');
    expect(few).toContain(
      '（控えだけ。更新は保存の印を付け外しした時刻で、一度も変えていなければ作成と同じ。',
    );
    expect(itemCount('few')).toBe(8);
    expect(few.indexOf(spaced(80).slice(0, 20))).toBeLessThan(few.indexOf('human-report.pdf'));
    expect(few).toContain('出所:人間');
    expect(few).toContain('出所:クローン');
    expect(few).toContain('出所:マネージャー');
    expect(few).toContain('出所:連携');
    expect(few).toContain('出所:不明');
    expect(few).toContain('保存中（期限なし）');
    expect(few).toContain('未結び付け（');
    expect(few).toContain('期限 2026-10-31');
    expect(few).toContain('2.0 MiB');
    expect(few).toContain('1.5 KiB');
    expect(few).toContain('1023 B');
    expect(few).toContain('1.0 KiB');
    expect(few).toContain('レポート 😀.txt');
    expect(few).toContain('…（');

    // 使用量
    expect(text('usage#1')).toContain('置き場の使用量: 5 件 ');
    expect(text('usage#1')).toContain('人間 2 件 2.1 KiB / 連携 3 件 3.0 MiB');
    expect(text('usage#1')).toContain('連携の鍵別: key-a 1 件 3.0 MiB / key-b 2 件 30 B');
    expect(text('usage#1')).not.toContain('クローン ');
    expect(text('usage#2')).toContain('置き場の使用量: 5 件 ');
    expect(text('usage#3')).toContain(EMPTY);

    // 絞り込み
    expect(listArgs('filters-kept#1')).toEqual({ limit: FILE_LIST_PAGE, kept: true });
    expect(entryNames('filters-kept#1')).toEqual(['レポート 😀.txt']);
    expect(listArgs('filters-kept#2')).toEqual({ limit: FILE_LIST_PAGE, kept: false });
    expect(itemCount('filters-kept#2')).toBe(7);
    expect(text('filters-kept#1')).toContain('置き場の使用量: 8 件 ');
    for (const [n, from] of ['human', 'clone', 'manager', 'integration', 'unknown'].entries()) {
      expect(listArgs(`filters-from#${String(n + 1)}`)).toEqual({ limit: FILE_LIST_PAGE, from });
    }
    expect(itemCount('filters-from#1')).toBe(2);
    expect(itemCount('filters-from#2')).toBe(1);
    expect(itemCount('filters-from#3')).toBe(1);
    expect(itemCount('filters-from#4')).toBe(1);
    expect(itemCount('filters-from#5')).toBe(3);
    expect(text('filters-query#1')).toContain('human-report.pdf');
    expect(text('filters-query#1')).toContain('レポート 😀.txt'.slice(0, 0));
    expect(entryNames('filters-query#1').length).toBe(itemCount('filters-query#1'));
    expect(itemCount('filters-query#2')).toBe(itemCount('filters-query#1'));
    expect(entryNames('filters-query#3')).toEqual(['レポート 😀.txt']);
    expect(entryNames('filters-query#4')).toEqual(['レポート 😀.txt']);
    expect(itemCount('filters-query#5')).toBe(1);
    expect(text('filters-query#6')).toContain(EMPTY);
    expect(text('filters-query#7')).toContain(EMPTY);
    expect(listArgs('filters-query#2')).toEqual({ limit: FILE_LIST_PAGE, q: 'REPORT' });
    expect(listArgs('filters-combined#1')).toEqual({
      limit: FILE_LIST_PAGE,
      kept: false,
      from: 'human',
    });
    expect(listArgs('filters-combined#2')).toEqual({
      limit: FILE_LIST_PAGE,
      from: 'integration',
      q: 'dump',
    });
    expect(listArgs('filters-combined#3')).toEqual({
      limit: FILE_LIST_PAGE,
      kept: false,
      conversationId: CONV_A,
      q: 'txt',
    });

    // 会話
    expect(text('conversation#1').startsWith('置き場の使用量')).toBe(true);
    expect(listArgs('conversation#1')).toEqual({ limit: FILE_LIST_PAGE, conversationId: CONV_A });
    expect(itemCount('conversation#1')).toBe(2);
    expect(
      text('conversation#2').startsWith(
        `（会話 id の先頭 c1a2b3c4 を、それで始まる唯一の会話 ${CONV_A} と読んだ）\n置き場の使用量`,
      ),
    ).toBe(true);
    expect(listArgs('conversation#2')).toEqual({ limit: FILE_LIST_PAGE, conversationId: CONV_A });
    expect(text('conversation#3').startsWith('（会話 id の先頭 c1a2b3c4-0000 を、')).toBe(true);
    expect(text('conversation#4')).toBe(
      `置き場の一覧は読んでいない。d5e6f7a8 で始まる会話が複数在るので、どれか決められない: ${CONV_D2}, ${CONV_D1}。どれかの完全な id を渡すこと。`,
    );
    expect(ops('conversation#4')).not.toContain('attachments.list');
    expect(ops('conversation#4')).not.toContain('attachments.usage');
    expect(text('conversation#5').startsWith('置き場の使用量')).toBe(true);
    expect(itemCount('conversation#5')).toBe(2);
    expect(text('conversation#6')).toContain(EMPTY);
    expect(text('conversation#6').startsWith('置き場の使用量')).toBe(true);
    expect(listArgs('conversation#6')).toEqual({
      limit: FILE_LIST_PAGE,
      conversationId: 'zzzzzzzz',
    });
    expect(listArgs('conversation#7')).toEqual({
      limit: FILE_LIST_PAGE,
      conversationId: 'no-such-conversation',
    });
    expect(text('conversation#8')).toContain(EMPTY);
    expect(listArgs('conversation#8')).toEqual({
      limit: FILE_LIST_PAGE,
      conversationId: 'c1a2b3c',
    });
    // 7 文字以下でも、当たりが複数なら（短くても）断る。置き場は読まない
    expect(text('conversation#9')).toBe(
      `置き場の一覧は読んでいない。d5e6f7a で始まる会話が複数在るので、どれか決められない: ${CONV_D2}, ${CONV_D1}。どれかの完全な id を渡すこと。`,
    );
    expect(ops('conversation#9')).not.toContain('attachments.list');
    expect(
      text('conversation-prefix-with-filters#1').startsWith('（会話 id の先頭 c1a2b3c4 を、'),
    ).toBe(true);
    expect(listArgs('conversation-prefix-with-filters#1')).toEqual({
      limit: FILE_LIST_PAGE,
      from: 'human',
      conversationId: CONV_A,
    });
    expect(text('conversation-prefix-with-filters#2')).toContain(`と読んだ）\n置き場の使用量`);
    expect(text('conversation-prefix-with-filters#2')).toContain(EMPTY);

    // 予算と cursor
    const FOLLOW = '続きは file_list cursor=';
    expect(text('budget-and-cursor#1')).toContain(FOLLOW);
    expect(text('budget-and-cursor#1')).toMatch(
      /…ほか \d+ 件は省略（この呼び出しで 50 件取り、新しい順に \d+ 件だけ出した）。続きは file_list cursor=\S+ （同じ絞り込みで渡す）/u,
    );
    // 続きは残りが予算に収まる（省略の文も cursor も付かない）。2 回で 60 件ぜんぶ
    expect(text('budget-and-cursor#2')).not.toContain(FOLLOW);
    expect(text('budget-and-cursor#2')).not.toContain('省略');
    expect(itemCount('budget-and-cursor#1')).toBeLessThan(50);
    expect(itemCount('budget-and-cursor#1') + itemCount('budget-and-cursor#2')).toBe(60);
    expect(step('budget-and-cursor#2').calls[0]?.args).toMatchObject({ limit: FILE_LIST_PAGE });
    expect(step('budget-and-cursor#2').calls[0]?.args).toHaveProperty('cursor');
    expect(text('budget-and-cursor#1').length).toBeGreaterThan(FILE_LIST_BUDGET);
    expect(entryNames('budget-and-cursor#1')[0]).toBe('bulk-060.txt');
    expect(text('budget-and-cursor#1')).not.toContain('…まだある');
    expect(text('budget-and-cursor-filters#2')).toContain('置き場の使用量: 71 件');
    expect(step('budget-and-cursor-filters#2').calls[0]?.args).toMatchObject({
      from: 'human',
      q: 'bulk',
    });
    expect(text('budget-and-cursor-filters#1')).not.toContain('other.txt');

    // cursor の断り
    for (const n of [1, 2, 3]) {
      const key = `cursor-refused#${String(n)}`;
      expect(text(key), key).toBe(
        'cursor が読めない。前回の応答の「続きは file_list cursor=…」をそのまま渡す（自分で組み立てない）。',
      );
      expect(ops(key), key).toEqual(['attachments.list']);
      expect(step(key).output.isError, key).toBe(false);
    }

    // 期限切れ
    expect(itemCount('expired#1')).toBe(3);
    expect(itemCount('expired#2')).toBe(1);
    expect(text('expired#2')).toContain('置き場の使用量: 1 件 ');
    expect(text('expired#2')).toContain('kept.txt');
    expect(text('expired#2')).toContain('保存中（期限なし）');
    expect(text('expired#3')).toContain(EMPTY);
    expect(text('expired#3')).toContain('置き場の使用量: 1 件 ');

    // 読みの失敗
    // 理由は reasonOf（「Error: 」＋ message）
    expect(text('read-fails#1')).toBe(READ_FAILED('Error: 置き場が落ちた（list）'));
    expect(text('read-fails#2')).toBe(READ_FAILED('Error: 置き場が落ちた（usage）'));
    expect(text('read-fails#3')).toBe(READ_FAILED('Error: 日誌が落ちた（listPage）'));
    expect(ops('read-fails#3')).toEqual(['journal.listPage']);
    expect(text('read-fails#4')).toContain('置き場の使用量');
    expect(text('read-fails#5')).toContain('a.txt');
    for (const key of ['read-fails#1', 'read-fails#2', 'read-fails#3']) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(step(key).output.isError, key).toBe(false);
    }
    expect(step('read-fails#1').calls).toEqual([
      {
        op: 'attachments.list',
        args: { limit: FILE_LIST_PAGE },
        outcome: 'threw Error: 置き場が落ちた（list）',
      },
    ]);
  });
});
