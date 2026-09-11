import { describe, expect, it } from 'vitest';

import {
  clearRecentTracesForTesting,
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  inboxEventShape,
  journalEntryShape,
  journalRowType,
  noteBackgroundFailure,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  noteDroppedRecord,
  noteManagerIdCollision,
  noteUncaught,
  noteUnreadableRecord,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
  runnerEventShape,
  type DroppedTraceOrigin,
} from './dropped-record.js';
import type { RunnerEvent } from './runner-protocol.js';
import { JOURNAL_ENTRY_TYPES, journalEntrySchema } from './schema.js';
import type { InboxEvent, JournalEntryInput, JournalEntryType } from './schema.js';
import { captureStderr } from './testing.js';

/**
 * 記録を落としたときの跡は stderr にしか出ない。ここで固定するのは2つ —
 * **跡が出ること**と、**その跡に本文が乗らないこと**である。
 *
 * 後者は「うるさいから消す」の反対方向の壊れ方をする。次に読む者が
 * 「情報が足りない」と思って本文を足すと、日誌にすら入らなかった秘密が
 * ホスティング先のログに出る（#52 と同じ形）。
 */
describe('落とした記録の跡', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('本文を出さずに、いつ・どの型か・なぜ失敗したかを残す', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord(
        '日誌',
        journalEntryShape({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[mgr-1] 鍵は ${secret} だった`,
        }),
        new Error('storage is closed'),
      );
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).not.toContain(secret);
    expect(line).toContain('日誌を記録できませんでした');
    expect(line).toContain('exchange with=manager role=inbound');
    expect(line).toContain('storage is closed');
    // 「いつ」。ホスティング先の付ける時刻に頼らない
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
    // 1行で終わる（後続の行を巻き込まない）
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
  });

  it('どの型の自由文も跡に乗らない', () => {
    const entries: JournalEntryInput[] = [
      { type: 'exchange', with: 'human', role: 'inbound', text: secret },
      { type: 'decision', decision: secret, grounds: secret },
      {
        type: 'escalation',
        question: secret,
        approvalId: 'ap-1',
        managerId: 'mgr-1',
        answer: secret,
      },
      { type: 'tool_use', actor: 'manager:mgr-1', tool: 'Bash', input: { command: secret } },
      { type: 'memory_update', slug: 'values', cause: 'clone', summary: secret },
      { type: 'daily_report', date: '2026-08-16', body: secret, unavailable: secret },
      { type: 'external_event', source: 'github', summary: secret },
      {
        type: 'token_rotation',
        event: 'not_rotated',
        label: secret,
        noticeText: secret,
        text: secret,
      },
    ];

    for (const entry of entries) {
      const shape = journalEntryShape(entry);
      expect(shape, entry.type).not.toContain(secret);
      // 型は必ず分かる（何を落としたのか辿れないと跡の意味が無い）
      expect(shape, entry.type).toContain(entry.type);
    }
  });

  /**
   * **`external_event.source` は「名前」に見えて、外から来る値である。**
   *
   * `POST /events/:source` の URL パスセグメントがそのまま入る（`app.ts` の
   * `source: z.string().min(1)` — 列挙でも長さ上限でもない）。`summary` では
   * ないから安全、と読むと #52 と同じ形が縮小して残る。
   */
  it('external_event の source は外から来る値なので、長さだけにする', () => {
    const shape = journalEntryShape({
      type: 'external_event',
      source: secret,
      summary: 'なんらかの通知',
    });

    expect(shape).not.toContain(secret);
    // 一部でも出さない（先頭64字を切って載せる、も駄目）
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain('external_event');
    expect(shape).toContain(`source.chars=${secret.length}`);
  });

  /**
   * Issue #823: 名簿の `size-unnamed` の歯（`dropped-record.test.ts` 内の
   * `journalEntryShape の名簿`）は `/(?:^| )chars=\d+/u` という正規表現で
   * 「無名の `size` 欄が出ているか」を判定している。**この判定は跡の文字列
   * 全体を検索しているだけで、どこに当たったのかを見ていない**——`tag()` は
   * 空白を1個に畳むだけで消さない（`clip(value.replaceAll(/\s+/gu, ' '), …)`。
   * `dropped-record.ts` の `tag()`）ので、`tag()` を通した値の中に
   * `chars=<数字>` がそのまま入っていれば、それが「本物の `summary` の
   * `size-unnamed`」と区別なく緑を出す。
   *
   * `external_event` は `tag()` を1回も呼ばない型なので、この型自身の欄が
   * 毒を運ぶことはできない（`journalEntryShape` の `external_event` ケースは
   * `size(entry.source, 'source')` と `size(entry.summary)` の2つだけで
   * 構成される）。**それでも、位置まで含めて丸ごと一致させる `toBe` を
   * ここに固定する**——`source`（名前付き）と `summary`（無名）を取り違えて
   * 実装しても、この歯だけは単独で落ちる（名簿の歯は「`source.chars=`」と
   * 「行頭/空白直後の `chars=`」を別々に見ているだけで、`source` と
   * `summary` の値そのものが入れ替わっても両方満たせてしまう）。
   */
  it('external_event は source と summary の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'external_event',
      source: 'github',
      summary: secret,
    });

    expect(shape).toBe(`external_event source.chars=6 chars=${secret.length}`);
  });

  /**
   * 型によって「長さを出す自由文」と「出さない自由文」が混じると、跡の読み方が
   * 型ごとに変わる。**空だったのか書けなかったのかを、どの型でも同じように
   * 判別できること。**
   */
  it('自由文が2つ以上ある型は、どれの長さかが分かる形で全部出す', () => {
    expect(journalEntryShape({ type: 'decision', decision: 'あ', grounds: 'いう' })).toBe(
      'decision decision.chars=1 grounds.chars=2',
    );
    expect(
      journalEntryShape({
        type: 'escalation',
        approvalId: 'ap-1',
        question: 'あ',
        answer: 'いう',
      }),
    ).toBe('escalation approvalId=ap-1 question.chars=1 answer.chars=2');
    // 未回答なら answer の欄自体が出ない（0 と「まだ無い」を混ぜない）
    expect(
      journalEntryShape({ type: 'escalation', approvalId: 'ap-1', question: 'あ' }),
    ).not.toContain('answer');
    expect(
      journalEntryShape({ type: 'memory_update', slug: 'values', cause: 'clone', summary: 'あ' }),
    ).toContain('chars=1');
  });

  /**
   * Issue #823（続き）: `exchange` も `memory_update` と同じく、名簿の
   * `size-unnamed` の歯（正規表現）1本にしか `text` の見分けを頼っていなかった
   * ——`daily_report`/`token_rotation`/`subagent_stall` には既にこの形の
   * `toBe` があるが（このファイルの他の `it`）、`exchange` には無かった。
   * ここでは丸ごと一致で固定する。**`with`/`role` は `journalEntrySchema` の
   * `z.enum(...)` から推論された TypeScript のリテラル合併型なので、
   * `pnpm typecheck` を通る限り、この2欄が任意の自由文（`chars=` を含む値）を
   * 持つことはできない**——だから `exchange` は最初からこの Issue の言う
   * 「毒」を仕込みようがない型である。それでも `toBe` を足すのは、値の取り違え
   * （`with` と `role` を逆に書く等）まで含めて、名簿の歯より強く固定するため。
   */
  it('exchange は with/role/text の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: secret,
    });

    expect(shape).toBe(`exchange with=manager role=inbound chars=${secret.length}`);
  });

  /**
   * Issue #823（本丸）: `memory_update.slug` は `memorySlugSchema`
   * （`^[a-z0-9][a-z0-9._-]*$`）で検査されるが、**それは書き込み前の実行時
   * 検査であって、`JournalEntryInput`（`schema.ts` の `DistributiveOmit<
   * JournalEntry, …>`）が TypeScript へ渡す型は素の `string` である。** その
   * うえ `journalEntryShape` が呼ばれるのはまさに `journal.append` が失敗した
   * *後*（`tools.ts` の `appendJournalOrThrow` 等）——失敗の理由が「この
   * `slug` がその検査を通らなかったから」であっても構造上おかしくない経路
   * である。**⟹ この欄が検査済みの値だけを持つとは限らない場所で、名簿の
   * 正規表現は判定している。**
   *
   * ここでは検査を通らない `slug`（空白入り）に `chars=999` という毒を
   * 仕込む。**本物の `summary` の長さ（`secret.length`）は 999 とは無関係な
   * 値にしてあるので**、`toBe` は毒の 999 では絶対に満たせない——`summary` の
   * `size()` 呼び出しが実装から落ちても、`toBe` は落ちた事実をそのまま拾う。
   *
   * ⚠️ **一方、名簿の歯が使う `/(?:^| )chars=\d+/u` はこの毒だけで満たせて
   * しまう**（`slug` の毒の直前が空白なので、`(?:^| )chars=\d+` に当たる）。
   * それを実際に確かめたのが下の1行——**この行は `summary` の実装を
   * 変異させても常に緑のままで、何も測っていない**（対照として残す。
   * 落ちるべきなのは直後の `toBe` のほうである）。
   */
  it('memory_update の summary は、slug に chars=<数字> を含む壊れた値が来ても、実際の長さで toBe が守る（Issue #823）', () => {
    const shape = journalEntryShape({
      type: 'memory_update',
      slug: 'values chars=999', // memorySlugSchema の検査を通らない値（空白入り）——実行時に落ちた後の跡を想定
      cause: 'clone',
      summary: secret, // 実際の長さは secret.length。999 とは異なる値にしてある
    });

    // ⚠️ 名簿と同じ緩い判定。これは対照——毒だけで常に満たせるので、
    // summary の size() を実装から落としても、この行は何も検出しない。
    expect(shape).toMatch(/(?:^| )chars=\d+/u);

    // 本命。位置と値の両方を固定するので、毒では満たせない。
    expect(shape).toBe(`memory_update slug=values chars=999 cause=clone chars=${secret.length}`);
  });

  /**
   * `unavailable` は自由文（「なぜ書けなかったか」）なので長さだけ出す。
   * この欄の**有無**が跡から読めることそのものに意味がある——
   * `isWrittenDailyReport`（`schema.ts`）がこの欄の有無で「本物の日報か」を
   * 判定するため、印が無いと再試行が死ぬ（`schema.ts` の
   * `daily_report.unavailable` の doc）。既存の `body` の出し方（無名）は
   * 変えていない。
   */
  it('daily_report は unavailable があれば長さだけ載せ、無ければ欄ごと出ない', () => {
    const unavailableValue = '上限に当たって日報を書けなかった';
    const withUnavailable = journalEntryShape({
      type: 'daily_report',
      date: '2026-08-20',
      body: '',
      unavailable: unavailableValue,
    });

    expect(withUnavailable).toBe(
      `daily_report date=2026-08-20 chars=0 unavailable.chars=${unavailableValue.length}`,
    );
    expect(withUnavailable).not.toContain(unavailableValue);

    const withoutUnavailable = journalEntryShape({
      type: 'daily_report',
      date: '2026-08-20',
      body: 'できた',
    });
    expect(withoutUnavailable).toBe('daily_report date=2026-08-20 chars=3');
    expect(withoutUnavailable).not.toContain('unavailable');
  });

  /**
   * `worker_wait` は自由文を1つも持たない — 全フィールドが runner 自身の
   * 数え上げ（整数・真偽値）である。値を決めるのは runner であって外の世界
   * ではないので、`tool_use` の `actor`/`tool` と同じ判定で数値をそのまま
   * 載せてよい（`size()` へ逃がす必要が無い）。
   *
   * ⚠️ **かつてこのテストは `worker_wait tasks=5 turns=41 toolless=38
   * settled=false` という4欄だけの期待値で、11欄中4欄しか出していなかった
   * 実装の欠陥をそのまま仕様として固定していた。** `openedAt`/`byCause`3欄/
   * `notifications`/`submits`/`sources` を実装へ足したのに合わせて、期待値を
   * 全欄へ伸ばした（`AGENTS.md`「現行の欠陥を仕様として固定しているテストは
   * 反転させてよい」— テストは消さず期待値だけ直し、経緯はこの追記で残す）。
   * `sources` は record（optional）なので、キー数だけ出る回と、欄自体が
   * 出ない回の両方を1本のテストで押さえる。
   */
  it('worker_wait は自由文が無いので数値をそのまま載せる', () => {
    // `byCause` の3値は必ず互いに異なる値にすること。キー↔値の結び付き
    // （`byCause.input` が本当に `input` の値を読んでいるか）は、3つの値が
    // 互いに違うときにしか測れない — 全部同じ値だと、結び付きを入れ替えても
    // 出力の文字列は1文字も変わらず、値を揃えるリファクタが将来入ったら
    // この歯が静かに抜ける。直下のアサーションで「互いに違うこと」自体を
    // 固定する。**そのうえで、値を揃えられても残る歯をこの it の末尾に
    // 置いてある**（「3欄を単独で固定する」）。
    const byCause = { input: 1, notification: 3, continuation: 37 };
    expect(new Set(Object.values(byCause)).size).toBe(3);

    const shape = journalEntryShape({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause,
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: false,
    });

    expect(shape).toBe(
      'worker_wait openedAt=2026-08-20T00:00:00.000Z tasks=5 turns=41 ' +
        'byCause.input=1 byCause.notification=3 byCause.continuation=37 toolless=38 ' +
        'notifications=3 submits=0 settled=false',
    );
    // `sources` を渡さない回では、欄自体が出ない
    expect(shape).not.toContain('sources');

    // `sources` は内訳ではなくキー数だけを出す（`turn_usage` の `models` と
    // 同じ判定基準）。キー名（`system`/`user`）も値（3/1）も跡に出ないこと。
    const withSources = journalEntryShape({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause,
      toolless: 38,
      notifications: 3,
      submits: 0,
      sources: { system: 3, user: 1 },
      settled: false,
    });

    expect(withSources).toBe(
      'worker_wait openedAt=2026-08-20T00:00:00.000Z tasks=5 turns=41 ' +
        'byCause.input=1 byCause.notification=3 byCause.continuation=37 toolless=38 ' +
        'notifications=3 submits=0 sources=2 settled=false',
    );
    expect(withSources).not.toContain('system');
    expect(withSources).not.toContain('user');

    // ---- 3欄を単独で固定する ----
    //
    // **ここまでの期待値は `byCause` の3値が互いに違うことに支えられている。**
    // 3値を揃えられると、キー↔値の結び付きを入れ替えても出力の文字列は1文字も
    // 変わらないので、上の `toBe` は結び付きについて何も測らなくなる。
    // 冒頭の注記とアサーションは「揃えるな」を守らせる側だが、**守らせるのでは
    // なく要らなくする側の歯を、ここに置く。**
    //
    // **ある欄にだけ印の値を置き、残り2欄を 0 にする。** 印はこの3本が自分で
    // 作るので、上のフィクスチャを将来どう揃えられても効き続ける。キー名と値の
    // 結び付きが入れ替わった実装では、印が別の欄に出る（＝その欄が 0 になる）
    // ので、3組とも落ちる。
    const causes = ['input', 'notification', 'continuation'] as const;
    const oneHotByCause = (marked: (typeof causes)[number], marker: number) => ({
      input: marked === 'input' ? marker : 0,
      notification: marked === 'notification' ? marker : 0,
      continuation: marked === 'continuation' ? marker : 0,
    });

    for (const marked of causes) {
      // 印は欄ごとに違う値にする（取り違えたまま偶然一致することが無いように）
      const marker = 11 * (causes.indexOf(marked) + 1);
      const oneHot = journalEntryShape({
        type: 'worker_wait',
        openedAt: '2026-08-20T00:00:00.000Z',
        tasks: 5,
        turns: 41,
        byCause: oneHotByCause(marked, marker),
        toolless: 38,
        notifications: 3,
        submits: 0,
        settled: false,
      });

      expect(oneHot).toContain(`byCause.${marked}=${marker}`);
      for (const other of causes) {
        if (other === marked) continue;
        expect(oneHot).toContain(`byCause.${other}=0`);
      }
    }
  });

  /**
   * `turn_usage` も自由文を持たない。`models` の内訳（トークン数・costUsd）は
   * SDK が数え上げた数値であって自由文ではないので、モデル id ごとの件数だけ
   * 載せる（`worker_wait` と同じ判定基準 — 「自由文かどうか」ではなく
   * 「値を誰が決めるか」）。
   */
  it('turn_usage は models の中身を出さず、件数と reset の有無だけを載せる', () => {
    const shape = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUsd: 1.2345,
        },
      },
    });

    expect(shape).toBe('turn_usage layer=clone site=session managerId=clone models=1');
    expect(shape).not.toContain('1.2345');

    const withReset = journalEntryShape({
      type: 'turn_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      models: {},
      reset: { fromCostUsd: 5, toCostUsd: 3 },
    });
    expect(withReset).toBe(
      'turn_usage layer=manager site=session managerId=mgr-1 models=0 reset=yes',
    );
  });

  /**
   * `sessionId` は SDK が決める値だが id である（`worker_wait` と同じ判定
   * 基準）ので `tag()` に載る——生ログへ降りる鍵（`schema.ts` の
   * `turn_usage.sessionId` の doc）。取れなかった回は欄ごと出ない。
   */
  it('turn_usage は sessionId を id として載せ、取れない回は欄ごと出ない', () => {
    const withSessionId = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      sessionId: 'sess-abc123',
      models: {},
    });
    expect(withSessionId).toBe(
      'turn_usage layer=clone site=session managerId=clone sessionId=sess-abc123 models=0',
    );

    const withoutSessionId = journalEntryShape({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {},
    });
    expect(withoutSessionId).toBe('turn_usage layer=clone site=session managerId=clone models=0');
    expect(withoutSessionId).not.toContain('sessionId');
  });

  /**
   * `subagent_stall`（Issue #357）は `agentId`/`ownedTaskCount`/
   * `sessionTaskCount`/`wakeupCount`/`outcome` を数値・列挙値・id として
   * そのまま載せ、自由文は `text` の1つだけを長さで出す。`agentType` は
   * `.claude/agents/*.md` が定義する小さい語彙（外部入力ではない）なので
   * `turn_usage` のモデル id と同じ扱いで `tag()` に載せる（`agentType` が
   * 無い回は欄自体が出ない——「取れない軸に0の行を作る」を跡でも守る）。
   */
  it('subagent_stall は数値・列挙値・id をそのまま載せ、text だけ長さにする', () => {
    const shape = journalEntryShape({
      type: 'subagent_stall',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: secret,
    });

    expect(shape).not.toContain(secret);
    expect(shape).toBe(
      'subagent_stall agentId=agent-1 agentType=worker ownedTaskCount=1 sessionTaskCount=2 ' +
        `wakeupCount=1 outcome=woken chars=${secret.length}`,
    );

    const withoutAgentType = journalEntryShape({
      type: 'subagent_stall',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 2,
      outcome: 'limit_reached',
      text: 'あ',
    });
    expect(withoutAgentType).not.toContain('agentType');
  });

  /**
   * `token_rotation`（Issue #393）も `subagent_stall` と同じ形——列挙値・id・
   * 数値は `tag()`/そのままで載せ、自由文（`label`/`noticeText`/`text`）だけを
   * `size()` で長さに潰す。`recoveredSource` は「誰が観測したか」を決める
   * のがこちら側の回し手であって外部入力ではないので、他の列挙値と同じ判定で
   * `tag()` に載る（#681 (1) の doc）。**13欄すべてが載る回を、跡が跡のままに
   * 保たれることごと固定する。**
   *
   * ⚠️ **この名前は元々「11欄すべてが載る」だったが、フィクスチャには
   * `reason` と `cooldownSource` が抜けており、schema 上13欄あるところ11欄
   * しか渡していなかった（名前と中身のずれ）。** 実装へ `reason`/
   * `cooldownSource` を足したのに合わせてフィクスチャと期待値を13欄へ伸ばした
   * ——既存のアサーションは1つも倒れず、覆う範囲が増えるだけなので反転では
   * ない。
   */
  it('token_rotation は tag 欄と size 欄が混在し、全欄が載ると跡もそれを反映する', () => {
    const labelValue = 'ラベルてすと';
    const noticeValue = '通知てすとぶんしょう';
    const shape = journalEntryShape({
      type: 'token_rotation',
      event: 'recovered',
      signal: 'reached',
      reason: 'turn_succeeded',
      freshness: 'current',
      tokenId: 'ap-1',
      fromTokenId: 'mgr-1',
      generation: 3,
      earliestAt: '2026-08-20T00:00:00.000Z',
      cooldownSource: 'quota_reset',
      recoveredSource: 'account_probe',
      label: labelValue,
      noticeText: noticeValue,
      text: secret,
    });

    expect(shape).toBe(
      'token_rotation event=recovered signal=reached reason=turn_succeeded ' +
        'freshness=current tokenId=ap-1 ' +
        'fromTokenId=mgr-1 generation=3 earliestAt=2026-08-20T00:00:00.000Z ' +
        'cooldownSource=quota_reset ' +
        `recoveredSource=account_probe label.chars=${labelValue.length} ` +
        `noticeText.chars=${noticeValue.length} chars=${secret.length}`,
    );
    // 自由文欄に入れた値そのものは跡に現れない
    expect(shape).not.toContain(labelValue);
    expect(shape).not.toContain(noticeValue);
    expect(shape).not.toContain(secret);
  });

  /**
   * optional 欄（`signal`/`reason`/`freshness`/`tokenId`/`fromTokenId`/
   * `generation`/`earliestAt`/`cooldownSource`/`recoveredSource`/`label`/
   * `noticeText`）が1つも無い回は、必須の `event`/`text` だけが載る——
   * 「取れない軸に0の行を作る」を跡でも守る（`subagent_stall` の
   * `agentType` 無し回と同じ判定基準）。
   */
  it('token_rotation は optional 欄が無ければ event と text だけを載せる', () => {
    const shape = journalEntryShape({
      type: 'token_rotation',
      event: 'not_rotated',
      text: 'あ',
    });

    expect(shape).toBe('token_rotation event=not_rotated chars=1');
    for (const field of [
      'signal',
      'reason',
      'freshness',
      'tokenId',
      'fromTokenId',
      'generation',
      'earliestAt',
      'cooldownSource',
      'recoveredSource',
      'label',
      'noticeText',
    ]) {
      expect(shape, field).not.toContain(field);
    }
  });

  it('理由は1行に切る（ドライバが本文を添えて返してくることがある）', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error(`connection lost\nDETAIL: 送った本文 ${secret}`));
    });

    const line = lines[0] as string;
    expect(line).toContain('connection lost');
    expect(line).not.toContain(secret);
  });

  it('長い理由は切り詰める', async () => {
    const lines = await captureStderr(() => {
      noteDroppedRecord('日誌', '', new Error('x'.repeat(5000)));
    });

    expect((lines[0] as string).length).toBeLessThan(400);
  });
});

/**
 * 受信箱が閉じた後に捨てた合図の見分け。
 *
 * ここを通る合図は7種類あり、**人間の発言・webhook の本文・マネージャーの報告が
 * 全部含まれる。** 判定基準は `journalEntryShape` と同じで、「自由文かどうか」
 * ではなく「値を誰が決めるか」である。
 */
describe('捨てた合図の見分け', () => {
  const secret = 'ghp_000000000000000000000000000000000000';
  const at = new Date(0).toISOString();

  it('どの起点でも本文が跡に乗らない（7種類すべて）', () => {
    const events: InboxEvent[] = [
      { type: 'human_message', id: 'e1', at, text: secret, conversationId: secret },
      { type: 'human_answer', id: 'e2', at, approvalId: 'ap-1', answer: secret },
      { type: 'distill', id: 'e3', at, reason: 'shutdown' },
      { type: 'timer', id: 'e4', at, kind: 'daily_report', target: '2026-08-16' },
      { type: 'external', id: 'e5', at, source: secret, payload: { body: secret } },
      { type: 'self_initiative', id: 'e6', at, reason: secret },
      {
        type: 'manager_message',
        id: 'e7',
        at,
        managerId: 'mgr-1',
        kind: 'report',
        text: secret,
        requestId: 'req-1',
      },
    ];

    // 7種類が同じ1行を通る以上、1つでも漏れれば経路ごと漏れる
    expect(events).toHaveLength(7);
    for (const event of events) {
      const shape = inboxEventShape(event);
      expect(shape, event.type).not.toContain(secret);
      // 何を捨てたのか辿れないと跡の意味が無い
      expect(shape, event.type).toContain(event.type);
    }
  });

  /**
   * **`external` の `source` は「名前」に見えて、外から来る値である。**
   * `POST /events/:source` の URL パスセグメントがそのまま入る。
   * `journalEntryShape` の `external_event` とここで判断を変えないこと。
   */
  it('external の source は外から来る値なので長さだけ、payload は有無だけ', () => {
    const shape = inboxEventShape({
      type: 'external',
      id: 'e1',
      at,
      source: secret,
      payload: { token: secret },
    });

    expect(shape).not.toContain(secret);
    // 一部でも出さない（先頭だけ載せる、も駄目）
    expect(shape).not.toContain(secret.slice(0, 8));
    expect(shape).toContain(`source.chars=${secret.length}`);
    expect(shape).toContain('payload=yes');
    // 中身が無い通知と区別が付く
    expect(inboxEventShape({ type: 'external', id: 'e2', at, source: 'github' })).toContain(
      'payload=none',
    );
  });

  it('誰から届いたかは残る（マネージャーの報告を突き合わせるため）', () => {
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e1',
        at,
        managerId: 'mgr-ff1a6c32',
        kind: 'report',
        text: 'あ',
      }),
    ).toBe('manager_message managerId=mgr-ff1a6c32 kind=report chars=1');
    // 返事待ちで止まっている1件かどうかも分かる
    expect(
      inboxEventShape({
        type: 'manager_message',
        id: 'e2',
        at,
        managerId: 'mgr-1',
        kind: 'question',
        text: 'あ',
        requestId: 'req-9',
      }),
    ).toContain('requestId=req-9');
  });

  /**
   * Issue #823（B）: `inboxEventShape` には `journalEntryShape` の名簿
   * （`JOURNAL_SHAPE_PLAN`）に相当するものが無い。**7型のうち `external` と
   * `manager_message` の2型だけが、上の2つの `it` で位置・値ごと `toBe`/
   * `toContain` で固定されている。残る5型（`human_message`/`human_answer`/
   * `distill`/`timer`/`self_initiative`）には、欄が出ているかを直接測る
   * アサーションが1本も無かった。** 共通ループ（このファイル上部の
   * 「どの起点でも本文が跡に乗らない（7種類すべて）」）は
   * `not.toContain(secret)` と `toContain(event.type)` の2本だけで、**どちらも
   * `size(event.text)` のような無名の呼び出しを実装から消しても真のままである**
   * ——`type` の文字列（`'human_message'` 等）は `inboxEventShape` の返り値の
   * 先頭に必ず出るので、`text`/`reason`/`answer` を出す `size()` 呼び出しを
   * まるごと削っても、この2本のアサーションはどちらも満たされ続ける。
   *
   * ここでは `journalEntryShape` の型別 `toBe`（このファイル上部）と同じ
   * 作りで、5型それぞれの丸ごと一致を固定する——欄の位置・値の両方を
   * 固定するので、どの欄を実装から落としても必ず落ちる。
   */
  it('human_message は text の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'human_message',
      id: 'e1',
      at,
      text: secret,
      conversationId: 'conv-1',
    });

    expect(shape).toBe(`human_message chars=${secret.length}`);
  });

  it('human_answer は approvalId/answer の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'human_answer',
      id: 'e2',
      at,
      approvalId: 'ap-1',
      answer: secret,
    });

    expect(shape).toBe(`human_answer approvalId=ap-1 answer.chars=${secret.length}`);
  });

  it('distill は reason の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'distill',
      id: 'e3',
      at,
      reason: 'shutdown',
    });

    expect(shape).toBe('distill reason=shutdown');
  });

  it('timer は kind/cause/target の位置ごと toBe で固定する（Issue #823）', () => {
    const withAll = inboxEventShape({
      type: 'timer',
      id: 'e4',
      at,
      kind: 'daily_report',
      cause: 'schedule_catchup',
      target: '2026-08-16',
    });
    expect(withAll).toBe('timer kind=daily_report cause=schedule_catchup target=2026-08-16');

    // optional の2欄（cause/target）が無い回は、必須の kind だけが載る
    // ——「取れない軸に0の行を作る」を跡でも守る（他の型と同じ判定基準）。
    const kindOnly = inboxEventShape({
      type: 'timer',
      id: 'e5',
      at,
      kind: 'memory_tidy',
    });
    expect(kindOnly).toBe('timer kind=memory_tidy');
  });

  it('self_initiative は reason の位置ごと toBe で固定する（Issue #823）', () => {
    const shape = inboxEventShape({
      type: 'self_initiative',
      id: 'e6',
      at,
      reason: secret,
    });

    expect(shape).toBe(`self_initiative chars=${secret.length}`);
  });
});

/**
 * 背景で起こした処理が落ちたときの跡（#438 案D）。**ここで固定するのは2つ。**
 *
 * 1. 跡が「どこで」を名指しすること —— プロセス全体の網（`uncaught-net.ts`）は
 *    出所を言えないので、この跡がその穴を埋める
 * 2. **その見分けに本文が乗らないこと** —— `runnerEventShape` は許可制で、
 *    `report` の `text` のような外から来る自由文を通さない
 */
describe('背景で落ちた処理の跡（#438）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('どこで落ちたかを名指しし、理由は reasonOf を通す', async () => {
    const lines = await captureStderr(() => {
      noteBackgroundFailure('クローンの受信箱のループ', '', new Error('boom'));
      noteBackgroundFailure(
        'runner からの合図の処理',
        'type=report managerId=mgr-1',
        new Error(`Failed query: select 1\nparams: ${secret}`),
      );
    });

    expect(lines).toHaveLength(2);
    const [plain, detailed] = lines as [string, string];
    expect(plain).toContain('クローンの受信箱のループが例外で終わりました: Error: boom');
    // 見分けが在れば括弧で添える。
    expect(detailed).toContain(
      'runner からの合図の処理が例外で終わりました（type=report managerId=mgr-1）',
    );
    // **2行目に添えられた値は跡へ出さない**（`reasonOf` が1行目だけを取る）。
    expect(detailed).not.toContain(secret);
  });

  it('runner の合図の見分けは、型とこちらが発行した id だけを載せる', () => {
    const report: RunnerEvent = {
      type: 'report',
      managerId: 'mgr-1',
      text: `鍵は ${secret} だった`,
      status: 'done',
    };
    const shape = runnerEventShape(report);

    expect(shape).toBe('type=report managerId=mgr-1');
    // **本文は長さすら出さない。** 跡に要るのは出所であって中身の量ではない。
    expect(shape).not.toContain(secret);
    expect(shape).not.toContain('chars');

    // `managerId` を持たない型でも落ちない（`hello` は runner の名乗り）。
    expect(runnerEventShape({ type: 'hello', runnerId: 'runner-primary' })).toBe('type=hello');
  });
});

/**
 * 日誌の読み出しでスキーマに合わない行を「飛ばすが、跡は残す」ための道具
 * （Issue #224）。`storage-fs` / `storage-pg` の `journal.ts` はここの
 * 関数を呼ぶだけで、stderr へ出す文言そのものはここに1本化されている。
 *
 * ここで固定するのは3つ——**跡が出ること**、**本文が乗らないこと**、
 * **同じ種別は初出だけその場に出て、量は呼び出しの終わりでまとめて出ること**
 * （`runner-client.ts` の `#noteDropped` と同じ形）。
 */
describe('日誌の読み出しで飛ばした行の跡（Issue #224）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('journalRowType は type だけを取り、本文には触れない', () => {
    expect(journalRowType({ type: 'future-type', summary: secret })).toBe('future-type');
    // 構造を持たない・type が無い・type が文字列でない、はどれも undefined
    // （埋め草を置かない——`'（不明）'` のような固定値にすると、それ自体が
    // 種別として数えられてしまう）。
    expect(journalRowType('not-an-object')).toBeUndefined();
    expect(journalRowType(null)).toBeUndefined();
    expect(journalRowType({ summary: secret })).toBeUndefined();
    expect(journalRowType({ type: 123 })).toBeUndefined();
  });

  it('初出はその場で1行、同じ種別の2回目以降は増やすだけで出さない', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 42);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 99);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 7);
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).toContain('初出');
    expect(line).toContain('type=future-type');
    expect(line).toContain('bytes=42');
    expect(dropped.get('unknown-shape:future-type')).toBe(3);
  });

  it('reason だけが違う・type だけが違う・type が無い、はそれぞれ別の種別として初出が出る', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'a', 1);
      noteDroppedJournalRow(dropped, 'unparsable', 'a', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'b', 1);
      noteDroppedJournalRow(dropped, 'unparsable', undefined, 1);
    });

    expect(lines).toHaveLength(4);
    expect(dropped.size).toBe(4);
  });

  it('本文は乗らない（type と bytes だけ）', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', journalRowType({ type: 'ok' }), 12);
    });

    const line = lines[0] as string;
    expect(line).not.toContain(secret);
  });

  it('summary は何も飛ばしていなければ何も出さない', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRowsSummary(dropped);
    });

    expect(lines).toHaveLength(0);
  });

  it('summary は呼び出しの終わりに、種別ごとの件数をまとめて1行で出す', async () => {
    const dropped = new Map<string, number>();
    const lines = await captureStderr(() => {
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unknown-shape', 'future-type', 1);
      noteDroppedJournalRow(dropped, 'unparsable', undefined, 1);
      noteDroppedJournalRowsSummary(dropped);
    });

    // 初出2行（future-type / unparsable）+ summary 1行
    expect(lines).toHaveLength(3);
    const summary = lines[2] as string;
    expect(summary).toContain('合計');
    expect(summary).toContain('unknown-shape:future-type×3');
    expect(summary).toContain('unparsable×1');
  });
});

/**
 * #242 — クローンが自分の跡を器の中から読み戻すための帳面。
 *
 * ここが測るのは `self_dropped`（`tools.ts`）の材料そのもの
 * （`recentDroppedTraces` / `clearRecentTracesForTesting`）。道具側の応答の
 * 組み立て（予算・`limit`）は `tools.test.ts` が持つ——ここは帳面そのものの
 * 契約（何が乗り、何が乗らず、上限に達したら何が起きるか）だけを見る。
 */
describe('直近の跡を器の中から読み戻す帳面（#242）', () => {
  it('note() 経由（noteDroppedRecord 等）の行は帳面にも積まれる', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteDroppedRecord(
        '日誌',
        'exchange with=human role=inbound chars=3',
        new Error('storage is closed'),
      );
    });

    const traces = recentDroppedTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain('日誌を記録できませんでした');
    expect(traces[0]).toContain('storage is closed');
    // stderr へ実際に書く行と同じ形（`alteroid: <iso時刻> ...`）。改行は持たない
    // （`renderListingFromEnd` が `\n` で連ねるので、ここに紛れ込むと1件が
    // 2行に化ける）。
    expect(traces[0]).toMatch(/^alteroid: \d{4}-\d{2}-\d{2}T[\d:.]+Z /u);
    expect(traces[0]?.includes('\n')).toBe(false);
  });

  it('noteUncaught（alteroidd / alteroid-runner）の行は帳面に積まれない', async () => {
    // **#242 が塞ぐのはクローン自身の跡（`alteroid:`）だけである。** デーモン／
    // runner のプロセス全体の網は別の接頭辞で、そちらは Railway 経由で人間から
    // 既に読めている（#242 のコメントの実測）ので、ここへ混ぜない。
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteUncaught('alteroidd', 'uncaughtException', new Error('boom'));
      noteUncaught('alteroid-runner', 'unhandledRejection', new Error('boom2'));
    });

    expect(recentDroppedTraces()).toHaveLength(0);
  });

  it('上限（RECENT_TRACE_LIMIT）を超えたら古い側から押し出される', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      for (let index = 0; index < RECENT_TRACE_LIMIT + 10; index += 1) {
        noteManagerIdCollision(`mgr-${index}`, 1);
      }
    });

    const traces = recentDroppedTraces();
    // **無制限に持たない。** 210件積んでも帳面には上限ぶんしか残らない。
    expect(traces).toHaveLength(RECENT_TRACE_LIMIT);
    // 先頭10件（mgr-0〜mgr-9）は押し出されている。
    expect(traces.some((line) => line.includes('managerId=mgr-0 '))).toBe(false);
    expect(traces.some((line) => line.includes('managerId=mgr-9 '))).toBe(false);
    // 直近（最後に積んだ1件）は残っている。
    expect(traces.some((line) => line.includes(`managerId=mgr-${RECENT_TRACE_LIMIT + 9} `))).toBe(
      true,
    );
  });

  it('recentDroppedTraces() は控えを返す（呼び手が触っても帳面は動かない）', async () => {
    clearRecentTracesForTesting();

    await captureStderr(() => {
      noteUnreadableRecord('runner のセッション一覧', 'runnerId=r-1', new Error('boom'));
    });

    const borrowed = recentDroppedTraces() as string[];
    borrowed.push('偽の行を差し込む');

    expect(recentDroppedTraces()).toHaveLength(1);
  });

  it('clearRecentTracesForTesting() で帳面を空にできる', async () => {
    clearRecentTracesForTesting();
    await captureStderr(() => {
      noteBackgroundFailure('probe', '', new Error('boom'));
    });
    expect(recentDroppedTraces().length).toBeGreaterThan(0);

    clearRecentTracesForTesting();

    expect(recentDroppedTraces()).toHaveLength(0);
  });
});

/**
 * 帳面が何の跡か・0件の読み方・保持のしかたを言う共有の字面（#242 の HTTP 面）。
 *
 * **`apps/daemon/src/app.ts` の `GET /dropped` と `packages/core/src/tools.ts`
 * の `self_dropped` の両方が、ここで測る3関数をそのまま使う。** 字面は
 * `apps/web` 側にも複製される見込みで（`describeSessionMissingKind` /
 * `describeSessionMissingKindNote` と同じ形）、揃っていることは規約ではなく
 * 歯（文字列一致）で守る——ここは core 側の生成元そのものを固定する。
 */
describe('帳面の字面（origin・0件の読み方・保持）', () => {
  it('describeDroppedTraceOrigin(undefined) は空文字（「不明」と書かない）', () => {
    expect(describeDroppedTraceOrigin(undefined)).toBe('');
  });

  /**
   * **`ALL_ORIGINS` を `Record` で持つのは、値が増えたときにここが型で
   * 落ちるため。** 配列だと2値目が足されても素通りする（＝新しい値の字面が
   * 測られないまま増える）。これはビルド時の網羅性であって、実行時に測って
   * いるのは下の非空チェックだけである（`managers.test.tsx` の
   * `ALL_KINDS` と同じ形）。
   */
  it('DroppedTraceOrigin の全ての値について、空でない文字列を返す', () => {
    const ALL_ORIGINS: Record<DroppedTraceOrigin, true> = { daemon: true };
    const origins = Object.keys(ALL_ORIGINS) as DroppedTraceOrigin[];
    // **空でないことを先に確かめる。** `Object.keys` が空なら下の forEach は
    // 1回も回らず、この歯は何も測らずに緑になる。
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(describeDroppedTraceOrigin(origin)).not.toBe('');
    }
  });

  it('describeDroppedTraceOrigin("daemon") は runner を除外する意味の文言を持つ', () => {
    const text = describeDroppedTraceOrigin('daemon');
    expect(text).toContain('デーモン');
    expect(text).toContain('runner');
  });

  /**
   * **上の2つの `toContain` だけでは足りない。** 文中の1文字を変えても
   * （末尾へ1文字足す等）どちらの部分文字列も壊れないので、変異が生き残る
   * （実測済み。手順は AGENTS.md「静かに失敗する道具」/
   * `.claude/skills/mutation-testing/`）。**全文の完全一致**を別に持つことで、
   * 1文字の変異でも赤くなるようにする。
   */
  it('describeDroppedTraceOrigin("daemon") は文字列として完全一致する', () => {
    expect(describeDroppedTraceOrigin('daemon')).toBe(
      'デーモンのプロセス（クローンを含む）が残した跡だけである。' +
        '別プロセスの runner が残した跡はここには出ない。',
    );
  });

  it('describeDroppedTraceEmpty() は「0件＝無事」とは読ませない', () => {
    const text = describeDroppedTraceEmpty();
    expect(text).not.toBe('');
    // 0件が「握り潰しが1件も無かった」ことを意味しない、という否定の形を持つ。
    expect(text).toContain('意味しない');
    // プロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える、という
    // 理由が付いている。
    expect(text).toContain('再起動');
  });

  it('describeDroppedTraceEmpty() は時刻を埋め込まない', () => {
    // ISO 8601 のタイムスタンプ（`2026-09-03T...` の形）が入っていないこと。
    // 時刻は面ごとに整形が違うので、埋め込むと字面一致の歯が面ごとの整形差で
    // 壊れる（このファイル冒頭 doc）。
    expect(describeDroppedTraceEmpty()).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it('describeDroppedTraceRetention(limit) は上限の件数を含み、押し出しと在り処を言う', () => {
    const text = describeDroppedTraceRetention(RECENT_TRACE_LIMIT);
    expect(text).toContain(String(RECENT_TRACE_LIMIT));
    expect(text).toContain('押し出される');
    expect(text).toContain('stderr');
  });
});

/**
 * `droppedTraceLedgerSince()` — 帳面が数え始めた時刻。
 */
describe('droppedTraceLedgerSince（帳面が数え始めた時刻）', () => {
  it('ISO 8601 の時刻を返す', () => {
    const since = droppedTraceLedgerSince();
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
    expect(Number.isNaN(Date.parse(since))).toBe(false);
  });

  it('clearRecentTracesForTesting() が呼ばれると取り直される', async () => {
    const before = droppedTraceLedgerSince();

    // **時刻の分解能（ミリ秒）より速く2回呼ぶと、取り直っても同じ値になり
    // うる。** 次の tick まで進めてから取り直す——`vi.useFakeTimers` は
    // このファイルの他のテストと歩調を揃えるため使わず、実時間を最小限
    // 待つ（1ms のビジーウェイトは待たない）。
    await new Promise((resolve) => setTimeout(resolve, 2));

    clearRecentTracesForTesting();
    const after = droppedTraceLedgerSince();

    expect(after).not.toBe(before);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

/**
 * `journalEntryShape` の名簿——schema に欄を足したのに、この関数へ足し忘れる
 * のを赤くする歯（PR #709 の再発防止。#709 自身はそのとき起きた分だけを直し、
 * 再発を止める歯を置かなかった）。
 *
 * **この歯が測るもの:**
 *
 * 1. 名簿（`JOURNAL_SHAPE_PLAN`）のキー集合が、`journalEntrySchema`
 *    （zod から機械的に引いた実装側の欄）と両方向に一致すること。**型でも
 *    測る**——`ShapedFieldsOf<T>` を使った `satisfies` で、schema に欄が
 *    増えると `pnpm typecheck` が落ちる。**実行時にも測る**——zod の
 *    discriminated union から実際の欄を毎回引き直すので、型を直さずに
 *    schema だけ変えても赤くなる。
 * 2. 名簿の各欄が言うとおりに `journalEntryShape` が振る舞うこと
 *    （`never` は出ない・`size`/`size-unnamed` は長さだけ出る・`tag`/`raw`
 *    は目印が出る）。全欄を埋めた `FULL_FIXTURES`（`Required<>` で optional
 *    も必須にしてある——ここでも schema に欄が増えると型が落ちる）に対して
 *    `journalEntryShape` を呼び、名簿どおりかを確かめる。
 * 3. 値が出ない欄（`size`/`size-unnamed`/`never`）に置いた自由文
 *    （`SECRET`）が、どの型の跡にも現れないこと。既存の「どの型の自由文も
 *    跡に乗らない」は8型（`exchange`/`decision`/`escalation`/`tool_use`/
 *    `memory_update`/`daily_report`/`external_event`/`token_rotation`）
 *    しか回っておらず、`worker_wait`/`turn_usage`/`subagent_stall` が入って
 *    いない——既存のテストは1文字も変えず、こちらを別の歯として足す。
 *
 * ⚠️ **この歯が守れないもの——3つ（次に読む人はここで立ち止まること）。**
 *
 * 1. **欄は出るが値が間違っていることは捕まえない。** ここが見るのは
 *    `tokenId=` のような目印が出るかどうかまでで、`tag(entry.tokenId)` を
 *    `tag(entry.fromTokenId)` と取り違えて書いても、この歯は緑のままである。
 *    値の正しさを持つのは各型別の `toBe`（このファイルの上のほう）のほうで、
 *    **この歯はそれを肩代わりしない。**
 * 2. **数えるのは第1階層の欄だけ。** `turn_usage.contextUsage` のような
 *    入れ子オブジェクトの中に、新しく自由文（例: `contextUsage.detail`）が
 *    足されても、**この歯は赤くならない。** 名簿もフィクスチャも
 *    `contextUsage` という1つの欄までしか見ていない。
 * 3. **13欄すべての保証は、いまも既存の `toBe` 1本が単独で持っている。**
 *    `token_rotation` の3つの変異（`recoveredSource` / `generation` /
 *    `noticeText` を落とす）で赤くなったのは、足場の印に反応した歯を差し引くと
 *    **同じ1本だけ**だった——`落とした記録の跡 > token_rotation は tag 欄と
 *    size 欄が混在し、全欄が載ると跡もそれを反映する`。**単独で殺せる歯が1本で、
 *    群でしか落ちない歯は0本である。** ⟹ **この名簿の歯は、そこを肩代わりしない**
 *    （名簿が見るのは目印が出るかまでで、13欄が*その順で・その値で*出ることは
 *    見ていない）。**この `toBe` が緩められた日に、13欄の保証が同時に消える。**
 * 4. **`size-unnamed` の判定（`/(?:^| )chars=\d+/u`）は、`tag()` を通した
 *    別の欄の値がたまたま（または実行時検査を通らない壊れた値として）
 *    `chars=<数字>` という文字列を運んでいると、それを本物の `size-unnamed`
 *    欄と区別できず緑になる（Issue #823。族は3にある「跡の文字列全体を
 *    検索して欄の存在を判定する」と同じ——ここでは「どの型のどの欄が」まで
 *    見ていない）。`tag()` は空白を1個に畳むだけで消さないので、`tag()` を
 *    通す欄が素の `string` 型（enum でも regex でも TypeScript レベルでは
 *    縛られていない）で、かつ `journalEntryShape` が呼ばれる経路（`journal.
 *    append` が失敗した*後*）では検査済みでない値が来てもおかしくない型
 *    （例: `memory_update.slug`）で、実際に構成できることを確かめた
 *    （`落とした記録の跡 > memory_update の summary は、slug に chars=<数字>
 *    を含む壊れた値が来ても…`）。**この名簿の歯は、そこを肩代わりしない**
 *    ——`size-unnamed` の欄を持つ6型（`exchange`/`memory_update`/
 *    `daily_report`/`external_event`/`token_rotation`/`subagent_stall`）の
 *    うち、`daily_report`/`token_rotation`/`subagent_stall` は既存の型別
 *    `toBe` が（この Issue と無関係に）既に丸ごと一致で守っており、この穴の
 *    影響を受けない。`exchange`/`memory_update`/`external_event` にはその
 *    `toBe` が無かったので、この PR で型別に追加した（このファイルの上の
 *    方、`落とした記録の跡` の中）。**この名簿の `size-unnamed` チェックは
 *    今回弱めていない**——役割は「欄を足し忘れていないかの目印」のままで、
 *    「どの値が出ているか」の保証は型別の `toBe` 側に一本化した。
 * 5. **（このPRで追記）上の4は PR #829 時点の状態の記録として残す——読み替え
 *    ない。この PR は名簿自身の `size-unnamed` 判定を強めた**（`journalEntryShape
 *    が plan どおりに振る舞う` の `case 'size-unnamed'`）。**「跡の文字列全体を
 *    検索する」から「無名の欄が実際の長さを、名前付き欄と取り違えられない
 *    形で持つか」（境界＋値）へ変えた**——旧来の `/(?:^| )chars=\d+/u` は
 *    どんな桁でも通したが、いまは `SECRET.length` という特定の桁でしか
 *    満たせない。`poisonableTagField` を持つ4型（`memory_update`/
 *    `daily_report`/`token_rotation`/`subagent_stall`）では、その欄を実際に
 *    poison した状態でも取り違えないことを都度確かめる。
 *    ⚠️ **それでも「位置」を完全には実現していない**——`tag()` は空白を
 *    畳むだけで消さないため、値が空白を含みうる欄をトークンの「位置」
 *    （何番目の空白区切りか）で当てにするのは本質的に無理がある（族その
 *    ものが、poison された tag 欄がトークン数を増減させることに由来する）。
 *    ⟹ 採ったのは「位置そのもの」ではなく「境界＋値」——名前付き欄との
 *    混同（位置的な取り違え）は塞ぎ、桁が一致する毒（最大限に意地悪な
 *    poison）までは塞いでいない。**この残りは、型別の `toBe`（すべて丸ごと
 *    一致——poison の桁が何であっても、欄が落ちれば必ず文字列全体が変わる
 *    ので取り違えようがない）が肩代わりする。** 6型すべてに型別 `toBe` が
 *    揃っている（`daily_report`/`token_rotation`/`subagent_stall` は既存、
 *    `exchange`/`external_event`/`memory_update` は PR #829、名簿自体の
 *    強化はこの PR）ので、実運用上のガードは既に二重にかかっている。
 */
describe('journalEntryShape の名簿（schema に足した欄の足し忘れを赤くする。PR #709）', () => {
  /**
   * 跡へ欄をどう出すか。**`never` には理由を必ず書く**——理由の無い除外は、
   * 次に「これも出すべきでは」と思った人が判断できない。
   */
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    | { readonly emit: 'raw'; readonly token: string }
    | { readonly emit: 'size'; readonly token: string }
    | {
        readonly emit: 'size-unnamed';
        /**
         * Issue #823（族対策）: 同じ型の中に、`tag()` を通す**素の string**
         * 欄（TypeScript のリテラル合併型ではなく実行時検査だけで縛られて
         * いるもの——`memory_update.slug` の `memorySlugSchema` のような形）が
         * 在るなら、その欄名をここへ書く。**書けば、下の振る舞いテストが
         * その欄を意図的に poison（` chars=<桁>` を仕込んだ値）にしたうえで、
         * この `size-unnamed` 欄の真の長さを見失わないかを実際に確かめる。**
         * 無ければ `undefined`——「この型には毒を運べる `tag()` 欄が無い」と
         * いう判定そのものを明記する（`never` の `why` と同じ扱い）。
         */
        readonly poisonableTagField?: string;
      }
    | { readonly emit: 'never'; readonly why: string };

  /** その型が schema で持つ欄（`type` は判別子なので除く。`id`/`at` は入力型に無い）。 */
  type ShapedFieldsOf<T extends JournalEntryType> = Exclude<
    keyof Extract<JournalEntryInput, { type: T }>,
    'type'
  >;

  const JOURNAL_SHAPE_PLAN = {
    exchange: {
      with: { emit: 'tag', token: 'with' },
      role: { emit: 'tag', token: 'role' },
      // poisonableTagField 無し: with/role は journalEntrySchema の
      // z.enum(...) から推論された TypeScript のリテラル合併型なので、
      // pnpm typecheck を通る限りこの2欄は任意の自由文（chars= を含む値）を
      // 持てない——この型自身には毒を運べる tag() 欄が無い（PR #829 の本文で
      // 確かめた内容と同じ）。
      text: { emit: 'size-unnamed' },
      conversationId: {
        emit: 'never',
        why:
          '欠落ではなく設計。呼び出し側が決める値（`app.ts` の `given ?? randomUUID()`）で、' +
          '`inboxEventShape` の doc が「同じ値の扱いを2か所で変えないこと」と縛っている' +
          "（逐語は `command grep -Fn -- '同じ値の扱いを2か所で' packages/core/src/dropped-record.ts`）。" +
          '足すなら2か所同時、`tag()` は禁止。',
      },
    },
    decision: {
      decision: { emit: 'size', token: 'decision' },
      grounds: { emit: 'size', token: 'grounds' },
    },
    escalation: {
      question: { emit: 'size', token: 'question' },
      approvalId: { emit: 'tag', token: 'approvalId' },
      managerId: { emit: 'tag', token: 'managerId' },
      answeredAt: {
        emit: 'never',
        why: 'PR #709 が「doc が『載せる』と言っていないので機能追加になる」として別判断へ回した欄。載せる判断をするならそこから。',
      },
      answer: { emit: 'size', token: 'answer' },
    },
    tool_use: {
      actor: { emit: 'tag', token: 'actor' },
      tool: { emit: 'tag', token: 'tool' },
      input: {
        emit: 'never',
        why:
          'この関数の doc が名指しする唯一の例外で、長さも出さない' +
          "（逐語は `command grep -Fn -- '唯一の例外は' packages/core/src/dropped-record.ts`）。" +
          '理由は2つ——(1) `z.unknown()` なので長さを出すには `JSON.stringify` が要るが、' +
          'この関数が走るのは日誌への書き込みが既に失敗した後の例外経路で、そこで循環参照や' +
          '巨大構造の直列化を新たに走らせるのは跡を残す仕組み自身を落としに行く形になる。' +
          '(2) ツール引数そのもの（`{ command: <シェル行> }` 等）で、この関数が扱う自由文の' +
          '中でもいちばん秘密が載りうる。',
      },
    },
    memory_update: {
      slug: { emit: 'tag', token: 'slug' },
      cause: { emit: 'tag', token: 'cause' },
      action: { emit: 'tag', token: 'action' },
      bytesBefore: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      bytesAfter: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      // slug は memorySlugSchema（実行時の正規表現）で縛られるが、
      // TypeScript の型は素の string——journalEntryShape が呼ばれるのは
      // journal.append が失敗した後の経路なので、検査を通らない値が来ても
      // 構造上おかしくない（Issue #823 の本丸）。
      summary: { emit: 'size-unnamed', poisonableTagField: 'slug' },
    },
    daily_report: {
      // date も z.string()（実行時の書式検査は無い）で TypeScript の型は
      // 素の string。同じ理由で毒を運べる。
      date: { emit: 'tag', token: 'date' },
      body: { emit: 'size-unnamed', poisonableTagField: 'date' },
      unavailable: { emit: 'size', token: 'unavailable' },
    },
    external_event: {
      source: { emit: 'size', token: 'source' },
      // poisonableTagField 無し: external_event は tag() を1回も呼ばない型
      // （source/summary はどちらも size() 経由）なので、この型自身の欄が
      // 毒を運ぶことはできない（PR #829 の本文で確かめた内容と同じ）。
      summary: { emit: 'size-unnamed' },
    },
    worker_wait: {
      openedAt: { emit: 'tag', token: 'openedAt' },
      tasks: { emit: 'raw', token: 'tasks' },
      turns: { emit: 'raw', token: 'turns' },
      byCause: { emit: 'raw', token: 'byCause.input' },
      toolless: { emit: 'raw', token: 'toolless' },
      notifications: { emit: 'raw', token: 'notifications' },
      submits: { emit: 'raw', token: 'submits' },
      sources: { emit: 'raw', token: 'sources' },
      settled: { emit: 'raw', token: 'settled' },
    },
    turn_usage: {
      layer: { emit: 'tag', token: 'layer' },
      site: { emit: 'tag', token: 'site' },
      managerId: { emit: 'tag', token: 'managerId' },
      sessionId: { emit: 'tag', token: 'sessionId' },
      models: { emit: 'raw', token: 'models' },
      reset: { emit: 'raw', token: 'reset' },
      contextUsage: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      compactions: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
      mainLoopUsage: {
        emit: 'never',
        why: 'PR #709 が別判断へ回した欄（上の `escalation.answeredAt` と同じ）。',
      },
    },
    token_rotation: {
      event: { emit: 'tag', token: 'event' },
      signal: { emit: 'tag', token: 'signal' },
      reason: { emit: 'tag', token: 'reason' },
      freshness: { emit: 'tag', token: 'freshness' },
      tokenId: { emit: 'tag', token: 'tokenId' },
      fromTokenId: { emit: 'tag', token: 'fromTokenId' },
      generation: { emit: 'raw', token: 'generation' },
      earliestAt: { emit: 'tag', token: 'earliestAt' },
      cooldownSource: { emit: 'tag', token: 'cooldownSource' },
      recoveredSource: { emit: 'tag', token: 'recoveredSource' },
      label: { emit: 'size', token: 'label' },
      noticeText: { emit: 'size', token: 'noticeText' },
      // tokenId は z.string().optional()——実行時の書式検査が無い素の
      // string なので毒を運べる（`memory_update.slug` と同じ判定基準）。
      text: { emit: 'size-unnamed', poisonableTagField: 'tokenId' },
    },
    subagent_stall: {
      agentId: { emit: 'tag', token: 'agentId' },
      agentType: { emit: 'tag', token: 'agentType' },
      ownedTaskCount: { emit: 'raw', token: 'ownedTaskCount' },
      sessionTaskCount: { emit: 'raw', token: 'sessionTaskCount' },
      wakeupCount: { emit: 'raw', token: 'wakeupCount' },
      outcome: { emit: 'tag', token: 'outcome' },
      // agentId は z.string()（実行時の書式検査は無い）なので毒を運べる。
      text: { emit: 'size-unnamed', poisonableTagField: 'agentId' },
    },
  } satisfies { [T in JournalEntryType]: Record<ShapedFieldsOf<T>, FieldPlan> };

  const SECRET = 'ghp_222222222222222222222222222222222222';

  /**
   * 全欄を埋めた見本。**`Required<>` で optional も必須になる**ので、schema に
   * 欄が増えると（このオブジェクトリテラルが `Required<>` を満たせなくなり）
   * ここでも型が落ちる。値が跡に出ない欄（`size`/`size-unnamed`/`never`）の
   * うち文字列型のものには `SECRET` を入れ、下の「値が出ない欄」テストで
   * 漏れないことを測る。`contextUsage`/`compactions`/`mainLoopUsage`
   * （構造化された `never` 欄）には秘密を仕込んでいない——この歯は第1階層
   * までしか見ないので、入れ子の中の自由文は別の限界として上のコメントに
   * 明記してある。
   */
  const FULL_FIXTURES: {
    [T in JournalEntryType]: Required<Extract<JournalEntryInput, { type: T }>>;
  } = {
    exchange: {
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: SECRET,
      conversationId: SECRET,
    },
    decision: {
      type: 'decision',
      decision: SECRET,
      grounds: SECRET,
    },
    escalation: {
      type: 'escalation',
      question: SECRET,
      approvalId: 'ap-1',
      managerId: 'mgr-1',
      answeredAt: '2026-08-20T00:00:00.000Z',
      answer: SECRET,
    },
    tool_use: {
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
      input: { command: SECRET },
    },
    memory_update: {
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 10,
      bytesAfter: 20,
      summary: SECRET,
    },
    daily_report: {
      type: 'daily_report',
      date: '2026-08-20',
      body: SECRET,
      unavailable: SECRET,
    },
    external_event: {
      type: 'external_event',
      source: SECRET,
      summary: SECRET,
    },
    worker_wait: {
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      sources: { system: 3, user: 1 },
      settled: false,
    },
    turn_usage: {
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUsd: 1.2345,
        },
      },
      reset: { fromCostUsd: 5, toCostUsd: 3 },
      contextUsage: { durationMs: 100 },
      compactions: [{ trigger: 'manual', preTokens: 1000 }],
      mainLoopUsage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    },
    token_rotation: {
      type: 'token_rotation',
      event: 'recovered',
      signal: 'reached',
      reason: 'turn_succeeded',
      freshness: 'current',
      tokenId: 'tok-1',
      fromTokenId: 'tok-0',
      generation: 3,
      earliestAt: '2026-08-20T00:00:00.000Z',
      cooldownSource: 'quota_reset',
      recoveredSource: 'account_probe',
      label: SECRET,
      noticeText: SECRET,
      text: SECRET,
    },
    subagent_stall: {
      type: 'subagent_stall',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: SECRET,
    },
  };

  it('名簿のキー集合は journalEntrySchema の実装側の欄と両方向に一致する（zod から機械的に引く）', () => {
    // 走査した種別の集合が JOURNAL_ENTRY_TYPES と一致することも確かめる——
    // 走査が空振りして0件のまま緑になる形を作らないため。
    const scannedTypes = journalEntrySchema.options.map((option) => option.shape.type.value);
    expect(new Set(scannedTypes)).toEqual(new Set(JOURNAL_ENTRY_TYPES));
    expect(scannedTypes.length).toBeGreaterThan(0);

    for (const option of journalEntrySchema.options) {
      const type = option.shape.type.value;
      const implementedFields = new Set(Object.keys(option.shape));
      implementedFields.delete('type');
      implementedFields.delete('id');
      implementedFields.delete('at');

      const plannedFields = new Set(Object.keys(JOURNAL_SHAPE_PLAN[type]));

      expect(plannedFields, type).toEqual(implementedFields);
    }
  });

  it('名簿の各欄について journalEntryShape が plan どおりに振る舞う（never は出ない・size 系は長さだけ・tag/raw は目印が出る）', () => {
    for (const type of JOURNAL_ENTRY_TYPES) {
      const shape = journalEntryShape(FULL_FIXTURES[type]);
      const plan: Record<string, FieldPlan> = JOURNAL_SHAPE_PLAN[type];

      for (const [field, fieldPlan] of Object.entries(plan)) {
        switch (fieldPlan.emit) {
          case 'never':
            expect(shape, `${type}.${field}`).not.toContain(field);
            break;
          case 'size':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}.chars=`);
            break;
          case 'size-unnamed': {
            // Issue #823（A）: 「跡の全体を検索して欄の存在を判定する」族を
            // 塞ぐ本体。**`toContain('chars=')` にしないこと**——同じ型に
            // 名前付きの `size` 欄が在ると、そちらの `<token>.chars=` に
            // 当たって緑になる（無名の欄が実装から落ちても気づけない。
            // PR #811 自身がこの穴を持ったまま入った実例——`external_event.
            // summary`/`daily_report.body`/`token_rotation.text` の3型で、
            // 同じ型の名前付き `size` 欄の `<token>.chars=` に紛れて偽陽性の
            // 緑を出した。変異試験で実測: `external_event` の無名欄を落として
            // も生存した）。
            //
            // ⟹ 「位置」（無名であること）と「値」（実際の長さ）の両方で
            // 絞る——`(?:^| )chars=<SECRET.length>(?:$| )` は、(1) 直前が
            // `.` の名前付き欄には当たらず（境界）、(2) 他のどんな桁の
            // `chars=<N>` にも当たらない（値そのものを固定）。旧来の
            // `/(?:^| )chars=\d+/u`（このケースの末尾に残したまま）は
            // (1) しか見ておらず、`\d+` がどんな桁でも通ってしまっていた——
            // それが Issue #823 の本丸（`tag()` を通した別の欄が
            // たまたま/壊れた値として `chars=<数字>` を運ぶと区別できない）
            // である。
            const realToken = `chars=${SECRET.length}`;
            const anchoredReal = new RegExp(`(?:^| )chars=${SECRET.length}(?:$| )`, 'u');

            expect(
              shape,
              `${type}.${field}: 無名の size 欄が実際の長さ（${SECRET.length}）を、` +
                '名前付き欄と取り違えられない形で持つこと（Issue #823・境界＋値の判定）',
            ).toMatch(anchoredReal);

            // ⚠️ **それでも、`tag()` を通した「別の」欄がたまたま／壊れた値
            // として *同じ桁数* の `chars=<SECRET.length>` を運べば、この
            // 判定も区別できない（Issue #823 の族そのもの。上のクラス
            // docstring の項目4）。** 「違う桁なら見分けられる」への改善は
            // 本物だが、「桁が一致する毒」までは閉じていない——これは無理に
            // 捻じ曲げず、次で実際に確かめる。
            if (fieldPlan.poisonableTagField !== undefined) {
              const poisonField = fieldPlan.poisonableTagField;
              // 桁を意図的に本物と変える（前方一致もしないことを下で
              // ガードする）。SECRET が将来変わってもこの歯が黙って
              // 無力化しないための実測ガードである。
              const poisonNumber = 1;
              const poisonToken = `chars=${poisonNumber}`;
              expect(poisonToken.startsWith(realToken)).toBe(false);
              expect(realToken.startsWith(poisonToken)).toBe(false);

              const poisonedFields: Record<string, unknown> = { ...FULL_FIXTURES[type] };
              poisonedFields[poisonField] = `poison ${poisonToken}`;
              // `poisonedFields` は `FULL_FIXTURES[type]` の複製に1つの
              // string 欄だけを別の string へ差し替えたもの——判別子
              // `type` はそのままなので、この cast は安全である。
              const poisonedShape = journalEntryShape(
                poisonedFields as unknown as JournalEntryInput,
              );

              // 対照: 旧来の緩い判定（この `case` の末尾にそのまま残して
              // ある）は、この毒だけで満たせてしまう——Issue #823 が指摘した
              // 族の実演であって、今回もここは直していない。
              expect(poisonedShape).toMatch(/(?:^| )chars=\d+/u);

              // 本命: 境界＋値の判定は、毒（桁違い）があっても真の長さを
              // 取り違えない。
              expect(
                poisonedShape,
                `${type}.${poisonField} に chars=<数字> を含む毒（${poisonToken}）を` +
                  `仕込んでも、${type}.${field} の真の長さ（${SECRET.length}）は` +
                  '取り違えられずに読み取れること（Issue #823）',
              ).toMatch(anchoredReal);
            }

            // 既存のまま（弱めていない）。役割は「欄の足し忘れの目印」に
            // 留める——役割の再定義は上のクラス docstring・PR 本文を見ること。
            expect(shape, `${type}.${field}`).toMatch(/(?:^| )chars=\d+/u);
            break;
          }
          case 'tag':
          case 'raw':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=`);
            break;
        }
      }
    }
  });

  it('値が出ない欄（size/size-unnamed/never）に置いた自由文は、どの型の跡にも現れない', () => {
    for (const type of JOURNAL_ENTRY_TYPES) {
      const shape = journalEntryShape(FULL_FIXTURES[type]);
      expect(shape, type).not.toContain(SECRET);
    }
  });
});
