import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { localDate } from './schedule.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 「クローンのターンへ何が入力されたか」が日誌に残るか（Issue #243 / `turn-input.ts`）。
 *
 * ここで測るのは**その経路を通ったとき日誌に何が残るか**であって、プロンプトの
 * 文面ではない。とくに2つの向きを別々に固定する:
 *
 * 1. **digest 経路（`timer` / `self_initiative` / `daily_report`）では、digest の
 *    本文が日誌に入らないこと。** digest はこの日誌・台帳・承認待ちの記録を
 *    寄せ直したものなので、全文を写すと日誌が自分自身を再帰的に太らせる。
 *    残すのは形と材料の id と `chars=N` だけである。
 * 2. **人間の回答は全文が入ること。** そのターンへ入った形（質問・回答・宛先を
 *    1本にしたもの）は他のどこにも無い。
 *
 * **`not.toContain` は、その文字列が現れうる場所で測らないと空振りする。** だから
 * 1 の側は必ず対になる歯を持つ — **同じ文字列が、そのターンの入力（SDK へ渡った
 * 本文）には実際に載っている**ことを先に確かめてから、日誌に無いことを見る。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/**
 * SDK の代わり（`inbox-persistence.test.ts` の同名関数と同じ骨格の簡約版）。
 * ここで要るのは「入力の捕獲」と「ターンが終わること」だけなので、それ以外
 * （枠・システム通知・消費）は持たない。
 */
function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  // 解かない約束。タイマーを持たないので、これでテストの終了が遅れることはない。
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    // 委譲先も偽物にしておく（誤って本物の SDK を起こさない）。
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { ...fake, clone };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * ターンの入力が日誌に残っているかを、**壁時計に頼らずに**見る。
 *
 * **待つのは「日誌に行が出ること」ではなく「そのターンの本文が SDK へ渡ったこと」
 * である。** `#journal` はターンを回す前に `await` してあるので、SDK が本文を
 * 受け取った時点で日誌への追記は必ず終わっている。**この順序があるので、行が
 * 無いことは「まだ書かれていない」ではなく「書かれない」と読める。**
 *
 * 行の出現そのものを待つ形（時間切れで `throw`）にすると、`#journal` を落とす
 * 変異が**待ち切れ**として落ちる — それは混雑でも同じ落ち方をするので、歯が
 * あった証拠にならない（`.claude/skills/mutation-testing/`）。ここは待ちを
 * 分離して、判定は `expect` に撃たせる。
 *
 * **`with: 'self'` / `role: 'inbound'` で絞る** — 型を足さずに既存の `exchange`
 * で書いているので、絞らないと他の内部ターンの記録（`role: 'outbound'`）と
 * 混ざる。ここで絞れること自体が、`role` を分けている意味でもある。
 */
async function turnInputAfterTurn(
  stores: Stores,
  fake: Fake,
  needle: string,
  turns = 1,
): Promise<string> {
  await waitFor(() => fake.inputs.length >= turns, `${turns} 本目のターンの本文が SDK へ渡る`);
  const entries: JournalEntry[] = await stores.journal.list({ types: ['exchange'] });
  const hit = entries.find(
    (entry) =>
      entry.type === 'exchange' &&
      entry.with === 'self' &&
      entry.role === 'inbound' &&
      entry.text.includes(needle),
  );
  expect(hit, `日誌に self/inbound の「${needle}」の行が無い`).toBeDefined();
  return hit?.type === 'exchange' ? hit.text : '';
}

/**
 * digest へ載るマネージャーの直近の報告。
 *
 * **200字より長くしてある** — digest は `直近の報告:` を 200 字の抜粋
 * （`excerptLine`）で載せるので、短いと「全部載った / 抜粋された」の区別が
 * つかない。先頭の目印は抜粋の中に必ず入る。
 */
const REPORT_MARKER = 'MGR-REPORT-MARKER-9f3a';
const LAST_REPORT = `${REPORT_MARKER} 委譲した仕事の報告の本文。${'この文はマネージャーの報告を長くするために繰り返している。'.repeat(10)}`;

/** 直近の報告を持つマネージャーを1本置く。**`running` にして期間の外でも digest に載せる。** */
async function seedManagerReport(stores: Stores): Promise<void> {
  const now = new Date().toISOString();
  await stores.jobs.putJob({
    id: 'mgr-243',
    createdAt: now,
    updatedAt: now,
    // 走行中・返事待ちは期間の外で始まったものも digest に載る（`digest.ts`）。
    // 器の時間帯に依存させないため、この形で載せる。
    status: 'running',
    summary: 'テスト用の委譲',
    lastReport: LAST_REPORT,
  });
}

const AT = '2026-08-12T00:00:00.000Z';

interface DigestRoute {
  name: string;
  /** この経路を起こす合図。 */
  event: (stores: Stores) => Promise<InboxEvent>;
  /** 日誌の行を見つけるための頭。 */
  needle: string;
  /** 行に入っていなければならない、形と材料の id。 */
  expected: string[];
}

/**
 * digest がターンへ入る3経路。**同じ3本を「形が残る」と「本文が残らない」の
 * 両方から測る。**
 */
const DIGEST_ROUTES: DigestRoute[] = [
  {
    name: 'timer（定期ジョブ）',
    async event(stores) {
      await stores.schedules.put({
        kind: 'issue-round',
        spec: { type: 'daily', at: '09:00' },
        request: 'open issue を見て、着手できるものから進める',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      });
      return { type: 'timer', id: 'evt-timer', at: AT, kind: 'issue-round', cause: 'manual' };
    },
    needle: 'ターンの入力: timer',
    expected: ['kind=issue-round', 'cause=manual', 'request=yes', 'digest.chars='],
  },
  {
    name: 'self_initiative（発意 tick）',
    event: () =>
      Promise.resolve({
        type: 'self_initiative',
        id: 'evt-self',
        at: AT,
        reason: '定期 tick: 記憶にある目的から次にやることを決める',
      }),
    needle: 'ターンの入力: self_initiative',
    expected: ['reason=定期 tick: 記憶にある目的から次にやることを決める', 'digest.chars='],
  },
  {
    name: 'daily_report（日報）',
    event: () =>
      Promise.resolve({
        type: 'timer',
        id: 'evt-daily',
        at: new Date().toISOString(),
        kind: 'daily_report',
        // **その日の digest を引くので、対象日は器の時間帯で「今日」にする。**
        // 固定日にすると、`running` のマネージャーは載るが器の時間帯によって
        // 他の材料が入れ替わる。
        target: localDate(new Date()),
      }),
    needle: 'ターンの入力: daily_report',
    expected: [`date=${localDate(new Date())}`, 'digest.chars='],
  },
];

describe('ターンの入力を日誌に残す（#243）— digest 経路は形だけ', () => {
  for (const route of DIGEST_ROUTES) {
    it(`${route.name}: 形と材料の id と digest の文字数が日誌に残る`, async () => {
      const stores = createMemoryStores();
      await seedManagerReport(stores);
      const s = bootClone(stores);

      s.clone.post(await route.event(stores));
      const text = await turnInputAfterTurn(stores, s, route.needle);

      for (const fragment of route.expected) expect(text).toContain(fragment);
      // **`chars=0` で通してしまわないこと。** digest は必ず中身を持つ（期間の
      // 行だけでも数十字ある）ので、0 なら組み立てに失敗している。
      const chars = Number(/digest\.chars=(\d+)/u.exec(text)?.[1] ?? '0');
      expect(chars).toBeGreaterThan(0);

      await s.clone.stop();
    });

    it(`${route.name}: digest の本文（マネージャーの直近の報告）は日誌に入らない`, async () => {
      const stores = createMemoryStores();
      await seedManagerReport(stores);
      const s = bootClone(stores);

      s.clone.post(await route.event(stores));
      const text = await turnInputAfterTurn(stores, s, route.needle);

      // **先に、その文字列が現れうることを確かめる。** これが無いと下の
      // `not.toContain` は空振りで真になる（報告が digest へ載っていない世界でも
      // 通ってしまう）。
      await waitFor(() => s.inputs.some((input) => input.includes(REPORT_MARKER)), '報告の抜粋');
      expect(s.inputs.join('\n')).toContain('直近の報告:');

      // ここからが本題。**日誌には digest の本文が1文字も入らない。**
      expect(text).not.toContain(REPORT_MARKER);
      expect(text).not.toContain('直近の報告:');
      // 節の見出しごと写していないこと（報告の目印だけを避ける実装で通らせない）。
      expect(text).not.toContain('## マネージャー');
      expect(text).not.toContain('期間: ');

      await s.clone.stop();
    });
  }

  it('distill: reason と本文の長さだけが残り、蒸留の指示文そのものは残らない', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores);

    // セッションが無いと蒸留は起きない（`#handle` の `'distill'` 分岐）。
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    s.clone.post({ type: 'distill', id: 'evt-distill', at: AT, reason: 'shutdown' });
    const text = await turnInputAfterTurn(stores, s, 'ターンの入力: distill', 2);

    // **合図が運んできた reason をそのまま残す。** 文面は `conversation_end` と
    // 同じでも、どちらで起きたかは日誌にしか残らない。
    expect(text).toContain('reason=shutdown');
    const chars = Number(/prompt\.chars=(\d+)/u.exec(text)?.[1] ?? '0');
    expect(chars).toBeGreaterThan(100);

    // 指示文は定型なので写さない（現れうることは、ターンの入力の側で確かめる）。
    await waitFor(
      () => s.inputs.some((input) => input.includes('忘れる前に、記憶へ移すべきものがあるか')),
      '蒸留の指示文',
    );
    expect(text).not.toContain('忘れる前に、記憶へ移すべきものがあるか');

    await s.clone.stop();
  });
});

describe('ターンの入力を日誌に残す（#243）— 人間の回答は全文', () => {
  const ANSWER = 'HUMAN-ANSWER-MARKER-7c1e 進めてよい。ただし本番の鍵は触らないこと。';
  const QUESTION = 'HUMAN-QUESTION-MARKER-2b8d 本番のデータベースへ移行を当ててよいか';

  async function seedApproval(stores: Stores): Promise<void> {
    await stores.jobs.putApproval({
      id: 'apr-243',
      createdAt: AT,
      question: QUESTION,
      jobId: 'mgr-9',
      requestId: 'req-3',
    });
  }

  const answerEvent: InboxEvent = {
    type: 'human_answer',
    id: 'evt-answer',
    at: AT,
    approvalId: 'apr-243',
    answer: ANSWER,
  };

  it('人間の回答は、質問・回答・宛先の全文が日誌に残る', async () => {
    const stores = createMemoryStores();
    await seedApproval(stores);
    const s = bootClone(stores);

    s.clone.post(answerEvent);
    const text = await turnInputAfterTurn(stores, s, 'ターンの入力: human_answer');

    expect(text).toContain('approvalId=apr-243');
    // **全文。** 抜粋にしない — このターンへ入った形は他のどこにも無い。
    expect(text).toContain(ANSWER);
    expect(text).toContain(QUESTION);
    // 宛先（`managerId` / `requestId`）まで含めて、渡したものがそのまま残る。
    expect(text).toContain('managerId: "mgr-9"');
    expect(text).toContain('requestId: "req-3"');

    await s.clone.stop();
  });

  it('片付け済みの配り直しでは、回答の代わりに配った断り書きの全文が残る', async () => {
    const stores = createMemoryStores();
    await seedApproval(stores);

    // 器が落ちる形を作る（`inbox-persistence.test.ts` と同じ手 — `stop()` では
    // 片付けの経路しか通らない）。
    const dying = bootClone(stores, 'hang');
    dying.clone.post(answerEvent);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitFor(async () => (await stores.commitments.get('evt-answer')) !== null, '台帳の未了');
    expect(await stores.commitments.close('evt-answer', AT, 'もう対応済み')).toBe(true);

    const reborn = bootClone(stores);
    const text = await turnInputAfterTurn(stores, reborn, '片付け済みの配り直し');

    expect(text).toContain('approvalId=apr-243');
    // 断り書きは組み立てたきりどこにも保存されないので、全文で残す。
    expect(text).toContain('再起動後の配り直しである');
    expect(text).toContain('approvals_list');
    // 配ったのは断り書きであって回答ではない（配ったものと残すものを一致させる）。
    expect(text).not.toContain(ANSWER);

    await reborn.clone.stop();
  });
});
