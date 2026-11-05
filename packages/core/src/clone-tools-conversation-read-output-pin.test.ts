import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { encodeConversationCursor } from './conversation.js';
import { UnreadableJournalEntryError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores, dropLastRowPerPage } from './testing.js';
import { createCloneTools } from './tools.js';

// `conversation_read` の出力（全文と字数）を、場面ごとにコミットした固定値（clone-tools-conversation-read-output-pin.json）と丸ごと比べる。
// `clone-tools-attach.ts` の `tool('conversation_read', …)`（約 502 行の式）を出力の部分ごとの小さな関数へ分けるとき、
// 出力が1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_CONVERSATION_READ_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-conversation-read-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-conversation-read-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの部分が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 日誌の `at` は発言を足す直前に Date を進めて決める（足した順に増える）。id はインメモリの日誌の採番（id-1, id-2, …）で、場面ごとに作り直すので毎回同じ。

type Args = Record<string, unknown>;
type PreviousTexts = readonly string[];
type Anchor = { id: string; at: string };
type Anchors = Record<string, Anchor>;
type Append = Parameters<Stores['journal']['append']>[0];

interface Seeder {
  stores: Stores;
  /** 基準時刻から minute 分後の `at` で1行足す */
  put: (minute: number, entry: Append) => Promise<Anchor>;
}

interface Step {
  args?: Args | ((previous: PreviousTexts, anchors: Anchors) => Args);
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  /** 日誌へ入れる行。返した値は steps の args から使える（cursor・id） */
  seed?: (seeder: Seeder) => Promise<Anchors | void>;
  /** 種を入れた後で器を差し替える（読めない行・印の読みの失敗など） */
  wrap?: (stores: Stores) => Stores;
  steps: Step[];
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-conversation-read-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_CONVERSATION_READ_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 26, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

function ex(
  conversationId: string | undefined,
  role: 'inbound' | 'outbound',
  text: string,
  extra: Record<string, unknown> = {},
): Append {
  return {
    type: 'exchange',
    with: 'human',
    role,
    text,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...extra,
  } as Append;
}

/** 取り下げの印の行（`Clone#interruptTurn` が足す形） */
function withdrawnMark(conversationId: string, clientMessageId: string): Append {
  return {
    type: 'exchange',
    with: 'self',
    role: 'outbound',
    text: `[判断] 人間の求めで、順番待ちだった発言（clientMessageId ${clientMessageId}）を取り下げた。`,
    conversationId,
    withdrawnClientMessageId: clientMessageId,
  } as Append;
}

const PNG = {
  id: 'att-1',
  name: 'screenshot.png',
  mediaType: 'image/png',
  size: 2048,
  sha256: 'a'.repeat(64),
};
const LOG = {
  id: 'att-2',
  name: `${'とても長い名前のログ-'.repeat(12)}.log`,
  mediaType: 'text/plain',
  size: 123_456,
  sha256: 'b'.repeat(64),
};

async function turn(
  s: Seeder,
  minute: number,
  conversationId: string,
  inbound: string,
  outbound: string,
): Promise<void> {
  await s.put(minute, ex(conversationId, 'inbound', inbound));
  await s.put(minute + 1, ex(conversationId, 'outbound', outbound));
}

// 往復が何本かある会話 conv-a と、別の会話・マネージャーとの往復・内部ターン（数えられない）
async function seedBasic(s: Seeder): Promise<Anchors> {
  const first = await s.put(0, ex('conv-a', 'inbound', 'デプロイの手順を教えて。'));
  await s.put(1, ex('conv-a', 'outbound', 'まず build を回してから push します。'));
  await s.put(
    2,
    ex('conv-a', 'inbound', 'スクリーンショットとログを添えます。Deploy が止まる。', {
      attachments: [PNG, LOG],
    }),
  );
  await s.put(3, ex('conv-a', 'outbound', 'ログを見ます。\n改行を含む返答です。'));
  await s.put(4, ex('conv-b', 'inbound', '別の会話の質問トマト'));
  await s.put(5, ex('conv-b', 'outbound', '別の会話の返答'));
  await s.put(6, { type: 'exchange', with: 'manager', role: 'inbound', text: '委譲の往復' });
  await s.put(7, { type: 'exchange', with: 'self', role: 'outbound', text: '内部ターン' });
  const last = await s.put(8, ex(undefined, 'inbound', '会話 id の無い人間の発言 Deploy'));
  return { first, last };
}

// 編集で畳まれた版のある会話
async function seedEdited(s: Seeder): Promise<void> {
  const original = await s.put(0, ex('conv-edit', 'inbound', '元の質問'));
  await s.put(1, ex('conv-edit', 'outbound', '元の回答'));
  await s.put(2, ex('conv-edit', 'inbound', '直した質問', { supersedes: original.id }));
  await s.put(3, ex('conv-edit', 'outbound', '直した回答'));
}

// 取り下げた発言のある会話 conv-w
async function seedWithdrawn(s: Seeder): Promise<Anchors> {
  const withdrawn = await s.put(
    0,
    ex('conv-w', 'inbound', '本番の X を消して', {
      clientMessageId: 'cm-withdrawn',
      attachments: [PNG],
    }),
  );
  await s.put(1, withdrawnMark('conv-w', 'cm-withdrawn'));
  const live = await s.put(
    2,
    ex('conv-w', 'inbound', 'やっぱり Y を確認して', { clientMessageId: 'cm-live' }),
  );
  await s.put(3, ex('conv-w', 'outbound', 'Y を確認します'));
  return { withdrawn, live };
}

const LONG_BODY = '長い発言本文。'.repeat(40);

// 予算（8,000字）を越える会話。いちばん古い行と新しい行を取り下げる（うち表示 k 件）
async function seedBig(s: Seeder): Promise<Anchors> {
  const rows: Anchor[] = [];
  for (let i = 0; i < 60; i += 1) {
    const withdrawn = i === 0 || i === 59;
    rows.push(
      await s.put(
        i,
        ex('conv-big', 'inbound', `[msg-${String(i)}] ${LONG_BODY}`, {
          clientMessageId: `cm-${String(i)}`,
        }),
      ),
    );
    if (withdrawn) await s.put(i, withdrawnMark('conv-big', `cm-${String(i)}`));
  }
  return { oldest: rows[0]!, newest: rows[59]! };
}

const FULL_ID = 'c60b1940-93d2-4f22-b2dc-9fd99662d4f3';

async function seedMany(s: Seeder, count: number, previewBody: string): Promise<Anchors> {
  let first: Anchor | undefined;
  for (let i = 0; i < count; i += 1) {
    const row = await s.put(
      i * 2,
      ex(`conv-${String(i).padStart(3, '0')}`, 'inbound', `[${String(i)}] ${previewBody}`),
    );
    first ??= row;
    // 一覧の抜粋は会話のいちばん新しい発言なので、予算を食わせる本文は返答の側にも置く
    await s.put(
      i * 2 + 1,
      ex(`conv-${String(i).padStart(3, '0')}`, 'outbound', `返答 ${String(i)} ${previewBody}`),
    );
  }
  return { first: first! };
}

function cursorOf(text: string | undefined): string {
  const found = /conversation_read cursor=(\S+)/.exec(text ?? '');
  if (found?.[1] === undefined) throw new Error('出力に続きの cursor が無い');
  return found[1];
}

function offsetOf(text: string | undefined): number {
  const found = /offset=(\d+)/.exec(text ?? '');
  if (found?.[1] === undefined) throw new Error('出力に続きの offset が無い');
  return Number(found[1]);
}

const failingWithdrawn = (stores: Stores): Stores => {
  stores.journal.withdrawnClientMessageIds = async () => {
    throw new Error('印の読みが落ちた');
  };
  return stores;
};

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査・since/until ----
  {
    name: 'arg-errors',
    covers:
      'scan・limit・offset の範囲の外／整数でない・since／until が読めない（会話は読んでいない）',
    steps: [
      { args: { scan: 0 } },
      { args: { scan: 10_001 } },
      { args: { scan: 1.5 } },
      { args: { limit: 0 } },
      { args: { limit: 201 } },
      { args: { offset: -1 } },
      { args: { id: 'id-1', offset: -5 } },
      { args: { since: 'not-a-datetime' } },
      { args: { until: 'not-a-datetime' } },
    ],
  },
  // ---- id（1発言を全文で読む） ----
  {
    name: 'id-single',
    covers:
      'id で1発言（添付つき・短い）・人間の発言／クローンの発言の見出し・取り下げの印を引いて無い',
    seed: seedBasic,
    steps: [
      { args: { id: 'id-3' } },
      { args: { id: 'id-4' } },
      { args: { id: 'id-1', offset: 5 } },
      { args: { id: 'id-1', offset: 500 } },
    ],
  },
  {
    name: 'id-paged',
    covers: '長い発言の頁（offset 0・続き・最後の頁・範囲外）・続きの案内',
    seed: async (s) => {
      const row = await s.put(
        0,
        ex(
          'conv-long',
          'inbound',
          `先頭の目印${'あ'.repeat(10_000)}末尾の目印${'い'.repeat(9000)}`,
        ),
      );
      return { row };
    },
    steps: [
      { args: (_p, a) => ({ id: a.row!.id }) },
      { args: (p, a) => ({ id: a.row!.id, offset: offsetOf(p[0]) }) },
      { args: (p, a) => ({ id: a.row!.id, offset: offsetOf(p[1]) }) },
      { args: (_p, a) => ({ id: a.row!.id, offset: 99_999 }) },
    ],
  },
  {
    name: 'id-withdrawn',
    covers: 'id で読む取り下げた発言（見出しの印・単数の注記・添付）と、取り下げていない発言',
    seed: seedWithdrawn,
    steps: [
      { args: (_p, a) => ({ id: a.withdrawn!.id }) },
      { args: (_p, a) => ({ id: a.live!.id }) },
    ],
  },
  {
    name: 'id-withdrawn-unknown',
    covers: 'id で読むとき印を引く口が落ちた回（判定できなかった・単数の言い方）',
    seed: seedWithdrawn,
    wrap: failingWithdrawn,
    steps: [{ args: (_p, a) => ({ id: a.withdrawn!.id }) }],
  },
  {
    name: 'id-not-found',
    covers: '無い id／会話の発言ではない id（マネージャーとの往復）',
    seed: async (s) => {
      await s.put(0, {
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: '委譲の往復本文',
      });
      await s.put(1, {
        type: 'decision',
        decision: '決めたこと',
        grounds: '根拠',
      } as Append);
    },
    steps: [{ args: { id: 'no-such-id' } }, { args: { id: 'id-1' } }, { args: { id: 'id-2' } }],
  },
  {
    name: 'id-unreadable',
    covers: '在るが読めない行（UnreadableJournalEntryError）と、無い id',
    wrap: (stores) => ({
      ...stores,
      journal: {
        ...stores.journal,
        get: (id: string) =>
          id === 'bad-1'
            ? Promise.reject(new UnreadableJournalEntryError({ id }))
            : stores.journal.get(id),
      },
    }),
    steps: [{ args: { id: 'bad-1' } }, { args: { id: 'no-such-id' } }],
  },
  {
    name: 'id-ignores-others',
    covers: 'id を渡したときは他の条件（conversationId・q・since の不正）を無視する',
    seed: seedBasic,
    steps: [{ args: { id: 'id-1', conversationId: 'nope', q: 'x', since: 'not-a-datetime' } }],
  },
  // ---- conversationId（1つの会話を古い順に） ----
  {
    name: 'conv-basic',
    covers:
      '会話の中身（古い順・添付行・抜粋・改行・先頭に届いている）・speaker human／clone／both・q の絞り・since／until の窓・scan が小さい回・会話 id の無い発言・他の会話は混ざらない',
    seed: seedBasic,
    steps: [
      { args: { conversationId: 'conv-a' } },
      { args: { conversationId: 'conv-a', speaker: 'human' } },
      { args: { conversationId: 'conv-a', speaker: 'clone' } },
      { args: { conversationId: 'conv-a', q: 'DEPLOY' } },
      { args: { conversationId: 'conv-a', q: 'DEPLOY', speaker: 'clone' } },
      { args: { conversationId: 'conv-a', since: iso(1) } },
      { args: { conversationId: 'conv-a', until: iso(1) } },
      {
        args: { conversationId: 'conv-a', since: '2026-10-26T00:02Z', until: '2026-10-26T00:03Z' },
      },
      { args: { conversationId: 'conv-a', scan: 1 } },
      { args: { conversationId: 'conv-a', scan: 2, q: '存在しない語' } },
      { args: { conversationId: 'conv-b' } },
    ],
  },
  {
    name: 'conv-empty',
    covers:
      '会話が無い（遡り切れている）・since があるときの「無い」・当たる発言が無い（q）・speaker で全て外れる',
    seed: seedBasic,
    steps: [
      { args: { conversationId: 'conv-nope' } },
      { args: { conversationId: 'conv-nope', since: iso(0) } },
      { args: { conversationId: 'conv-a', q: '存在しない語' } },
      { args: { conversationId: 'conv-a', since: '2099-01-01T00:00:00.000Z' } },
    ],
  },
  {
    name: 'conv-cursor-ignored',
    covers: 'conversationId と cursor の併用（cursor は使っていない旨の注記）',
    seed: seedBasic,
    steps: [{ args: { conversationId: 'conv-a', cursor: 'whatever' } }],
  },
  {
    name: 'conv-edited',
    covers:
      '編集で畳まれた版（既定は注記だけ・includeSuperseded で含めて表示・supersededBy の印・speaker と併用・q と併用）',
    seed: seedEdited,
    steps: [
      { args: { conversationId: 'conv-edit' } },
      { args: { conversationId: 'conv-edit', includeSuperseded: true } },
      { args: { conversationId: 'conv-edit', includeSuperseded: true, speaker: 'human' } },
      { args: { conversationId: 'conv-edit', q: '質問' } },
    ],
  },
  {
    name: 'conv-withdrawn',
    covers:
      '取り下げた発言の注記（conversationId・q）・取り下げていない発言・印の見出し・添付つきの取り下げ',
    seed: seedWithdrawn,
    steps: [
      { args: { conversationId: 'conv-w' } },
      { args: { q: '本番の X' } },
      { args: { q: 'やっぱり Y' } },
      { args: { conversationId: 'conv-w', speaker: 'clone' } },
    ],
  },
  {
    name: 'conv-withdrawn-fast-lookup',
    covers: '印だけを引く口（withdrawnClientMessageIds）を持つ器での注記',
    seed: seedWithdrawn,
    wrap: (stores) => {
      stores.journal.withdrawnClientMessageIds = async () => ['cm-withdrawn'];
      return stores;
    },
    steps: [{ args: { conversationId: 'conv-w' } }, { args: { q: '本番の X' } }],
  },
  {
    name: 'conv-withdrawn-unknown',
    covers: '印を引く口が落ちた回（判定できなかった・件数つき）の conversationId・q',
    seed: seedWithdrawn,
    wrap: failingWithdrawn,
    steps: [{ args: { conversationId: 'conv-w' } }, { args: { q: '本番の X' } }],
  },
  {
    name: 'conv-budget',
    covers:
      '予算（8,000字）を越える会話（古い側の省略・新しい側から出す・うち表示 k 件の取り下げ注記）・q の予算超過（新しい順・古い側の省略）',
    seed: seedBig,
    steps: [
      { args: { conversationId: 'conv-big' } },
      { args: { q: '長い発言' } },
      { args: { conversationId: 'conv-big', speaker: 'human', q: 'msg-5' } },
    ],
  },
  {
    name: 'conv-prefix',
    covers:
      '会話 id の先頭 8 文字の読み替え（名乗る行・q と併用・当たる発言が無い回にも名乗る）・2つ以上に当たる先頭・当たらない id',
    seed: async (s) => {
      await s.put(0, ex(FULL_ID, 'inbound', '先頭で読める発言'));
      await s.put(1, ex(`${FULL_ID.slice(0, 8)}-x-1`, 'inbound', '別の会話の発言'));
      await s.put(2, ex('c60b1941-aaaa', 'inbound', '前置きが重ならない会話'));
    },
    steps: [
      { args: { conversationId: FULL_ID } },
      { args: { conversationId: 'c60b1941' } },
      { args: { conversationId: 'c60b1941', q: '存在しない語' } },
      { args: { conversationId: 'c60b1940' } },
      { args: { conversationId: 'c60b1940', q: '先頭で' } },
      { args: { conversationId: 'c60b194' } },
      { args: { conversationId: 'zzzzzzzz' } },
    ],
  },
  {
    name: 'conv-prefix-ambiguous',
    covers: '2つ以上に当たる先頭は読まずに候補を返す',
    seed: async (s) => {
      await s.put(0, ex(`${FULL_ID}-a`, 'inbound', 'a'));
      await s.put(1, ex(`${FULL_ID}-b`, 'inbound', 'b'));
    },
    steps: [{ args: { conversationId: 'c60b1940' } }],
  },
  // ---- q（会話をまたぐ検索） ----
  {
    name: 'q-search',
    covers:
      'q の検索（新しい順・conversation= の行・会話 id の無い発言は (無し)・添付行・speaker 絞り・since／until・scan が小さい回）',
    seed: seedBasic,
    steps: [
      { args: { q: 'deploy' } },
      { args: { q: 'deploy', speaker: 'human' } },
      { args: { q: 'deploy', speaker: 'clone' } },
      { args: { q: '返答' } },
      { args: { q: 'deploy', since: iso(1) } },
      { args: { q: 'deploy', until: iso(3) } },
      { args: { q: 'deploy', scan: 1 } },
      { args: { q: '' } },
    ],
  },
  {
    name: 'q-empty',
    covers: '当たる発言が無い（遡り切れている）・since つき・窓に届かない（判定できない）',
    seed: seedBasic,
    steps: [
      { args: { q: '存在しない語' } },
      { args: { q: '存在しない語', scan: 1 } },
      { args: { q: '存在しない語', since: '2099-01-01T00:00:00.000Z' } },
      { args: { q: 'トマト', cursor: 'whatever' } },
    ],
  },
  {
    name: 'q-edited',
    covers: 'q は畳まれた版も人間との往復として拾う（会話をまたぐ検索は畳み込みの対象ではない）',
    seed: seedEdited,
    steps: [{ args: { q: '質問' } }],
  },
  // ---- 一覧 ----
  {
    name: 'list-basic',
    covers:
      '会話の一覧（新しい順・件数・抜粋・先頭に届いている・固定の案内）・speaker を渡した注記・マネージャーとの往復は数えない',
    seed: seedBasic,
    steps: [
      { args: {} },
      { args: { speaker: 'human' } },
      { args: { speaker: 'clone', scan: 100, limit: 5 } },
    ],
  },
  {
    name: 'list-empty',
    covers: '会話がまだ無い（遡り切れている）・窓に届かない（since が新しすぎる）・since つきで空',
    seed: async (s) => {
      await s.put(0, { type: 'exchange', with: 'manager', role: 'inbound', text: '委譲の往復' });
    },
    steps: [{ args: {} }, { args: { since: '2099-01-01T00:00:00.000Z' } }],
  },
  {
    name: 'list-window',
    covers:
      'since／until・scan の窓の注記（since より新しい範囲は出し切った・窓より古いものは見ていない）',
    seed: seedBasic,
    steps: [
      { args: { since: iso(1) } },
      { args: { until: iso(3) } },
      { args: { scan: 1 } },
      { args: { since: iso(1), until: iso(4), scan: 3 } },
    ],
  },
  {
    name: 'list-limit-hidden',
    covers:
      'limit で落ちた会話の件数（予算にはまだ余りがある・limit を増やせば出る）・limit が既定の20',
    seed: async (s) => {
      for (let i = 0; i < 30; i += 1) {
        await turn(
          s,
          i * 2,
          `conv-${String(i).padStart(2, '0')}`,
          `短い質問${String(i)}`,
          `短い返答${String(i)}`,
        );
      }
    },
    steps: [{ args: {} }, { args: { limit: 29 } }, { args: { limit: 30 } }],
  },
  {
    name: 'list-paging',
    covers:
      'cursor の頁送り（since・until・scan・limit を続きの呼びへ引き継ぐ）・最後の頁（続きの行が出ない）・いちばん古い発言を指す cursor（この cursor より古い会話は無い）',
    seed: async (s) => seedMany(s, 7, '頁送りの質問'),
    steps: [
      { args: { limit: 2, scan: 100, since: '2026-10-25T00:00Z', until: '2026-10-28T00:00Z' } },
      {
        args: (p) => ({
          limit: 2,
          scan: 100,
          since: '2026-10-25T00:00Z',
          until: '2026-10-28T00:00Z',
          cursor: cursorOf(p[0]),
        }),
      },
      { args: (p) => ({ limit: 2, scan: 100, cursor: cursorOf(p[1]) }) },
      { args: (p) => ({ limit: 2, cursor: cursorOf(p[2]) }) },
      { args: (_p, a) => ({ cursor: encodeConversationCursor(a.first!) }) },
      { args: (_p, a) => ({ cursor: encodeConversationCursor(a.first!), since: iso(-60) }) },
    ],
  },
  {
    name: 'list-cursor-errors',
    covers: 'cursor が壊れている・cursor が指す発言が無い（InvalidConversationCursorError）',
    seed: seedBasic,
    steps: [
      { args: { cursor: 'garbage' } },
      { args: { cursor: encodeConversationCursor({ id: 'id-9999', at: iso(0) }) } },
    ],
  },
  {
    name: 'list-budget',
    covers:
      '予算（8,000字）で切れた一覧（ほか N 件は省略に limit で落ちた分も足す・古い側・cursor）と、その cursor で読む続き・予算に収まる limit',
    seed: async (s) => seedMany(s, 150, '一覧の質問。'.repeat(30)),
    steps: [
      { args: { limit: 100 } },
      { args: (p) => ({ limit: 100, cursor: cursorOf(p[0]) }) },
      { args: { limit: 200, scan: 10_000 } },
      { args: { limit: 5 } },
    ],
  },
  {
    name: 'list-window-short',
    covers: '読めない行を捨てて頁が短くなった窓（ストアが続きを言っている）の一覧・会話・q',
    seed: async (s) => {
      await turn(s, 0, 'conv-old', '古い発言', '古い返答');
      await turn(s, 2, 'conv-new', '新しい発言', '新しい返答');
    },
    wrap: dropLastRowPerPage,
    steps: [
      { args: { scan: 100 } },
      { args: { conversationId: 'conv-old', q: '存在しない語', scan: 100 } },
      { args: { q: '存在しない語', scan: 100 } },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

async function runScenario(scenario: Scenario): Promise<string[]> {
  const base = createMemoryStores();
  const seeder: Seeder = {
    stores: base,
    put: async (minute, entry) => {
      vi.setSystemTime(new Date(iso(minute)));
      const row = await base.journal.append(entry);
      return { id: row.id, at: row.at };
    },
  };
  const anchors = (await scenario.seed?.(seeder)) ?? {};
  vi.setSystemTime(new Date(FROZEN_NOW));
  const stores = scenario.wrap === undefined ? base : scenario.wrap(base);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'conversation_read');
  if (!found) throw new Error('conversation_read が無い');
  const outputs: string[] = [];
  for (const step of scenario.steps) {
    const args = typeof step.args === 'function' ? step.args(outputs, anchors) : (step.args ?? {});
    const result = await found.handler(args as never, {});
    outputs.push(
      (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
    );
  }
  return outputs;
}

interface PinnedOutput {
  length: number;
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    const texts = await runScenario(scenario);
    for (const [index, text] of texts.entries()) {
      out[stepKey(scenario, index)] = { length: text.length, text };
    }
  }
  return out;
}

describe('conversation_read の出力の固定（場面ごとの全文と字数）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1])),
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
      expect(actual[key]?.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1]));
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.length);
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
          got?.text.length,
          `場面 ${key} の字数が変わった: 固定値 ${String(want?.length)} 字 → いま ${String(got?.text.length)} 字`,
        ).toBe(want?.length);
        expect(
          got?.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.text.length)} 字で同じ）`,
        ).toBe(want?.text);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    expect(text('arg-errors#1')).toContain('scan');
    expect(text('id-single#1')).toContain('[添付 2件]');
    expect(text('id-paged#1')).toContain('ここで切れている');
    expect(text('id-withdrawn#1')).toContain('取り下げた発言。クローンへは届いていない');
    expect(text('id-withdrawn-unknown')).toContain('取り下げの有無を判定できなかった');
    expect(text('id-not-found#1')).toContain('は無い');
    expect(text('id-not-found#2')).toContain('journal_read id=');
    expect(text('id-unreadable#1')).toContain('在るが読めない');
    expect(text('conv-basic#1')).toContain('先頭に届いている');
    expect(text('conv-basic#9')).toContain('この窓より古いものは見ていない');
    expect(text('conv-basic#6')).toContain('出し切ったが');
    expect(text('conv-empty#1')).toContain('に当たる発言は無い');
    expect(text('conv-cursor-ignored')).toContain('cursor は会話の一覧のときだけ効く');
    expect(text('conv-edited#1')).toContain('畳まれた版が 2 件ある');
    expect(text('conv-edited#2')).toContain('畳み込み済み');
    expect(text('conv-withdrawn#1')).toContain('取り下げた発言が 1 件ある');
    expect(text('conv-withdrawn-unknown#1')).toContain('判定できなかった');
    expect(text('conv-budget#1')).toContain('古い側');
    expect(text('conv-budget#1')).toContain('うち表示');
    expect(text('conv-budget#2')).toContain('当たり、新しい順に');
    expect(text('conv-prefix#2')).toContain('と読んだ');
    expect(text('conv-prefix-ambiguous')).toContain('会話は読んでいない');
    expect(text('q-search#1')).toContain('conversation=(無し)');
    expect(text('q-empty#1')).toContain('に当たる発言は無い');
    expect(text('q-empty#2')).toContain('判定できない');
    expect(text('list-basic#2')).toContain('speaker=human');
    expect(text('list-empty#1')).toContain('会話はまだ無い');
    expect(text('list-limit-hidden#1')).toContain('limit を増やせば出る');
    expect(text('list-paging#1')).toContain('続きを読むには');
    expect(text('list-paging#5')).toContain('この cursor より古い会話は無い');
    expect(text('list-cursor-errors#1')).toContain('cursor が壊れている');
    expect(text('list-cursor-errors#2')).toContain('cursor が使えない');
    expect(text('list-budget#1')).toContain('limit を増やしても出てこない');
    expect(text('list-window-short#1')).toContain('この窓より古いものは見ていない');
  });
});
