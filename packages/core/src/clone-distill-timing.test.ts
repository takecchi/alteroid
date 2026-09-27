import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  DISTILL_GAP_NOTICE_HEAD,
  DISTILL_SUCCEEDED_DECISION_PREFIX,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
} from './distill-gap.js';
import type { DistillGap } from './distill-gap.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ACTOR_ID } from './usage.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, wireEvents, waitFor, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — 蒸留が間に合わなかった区間の検出', () => {
  /** 「蒸留が成功で終わった」の印（`decision`）だけを拾う。 */
  async function distillSucceededEntries(stores: Stores): Promise<{ decision: string }[]> {
    const entries = (await stores.journal.list({ types: ['decision'] })) as { decision: string }[];
    return entries.filter((entry) => entry.decision.startsWith(DISTILL_SUCCEEDED_DECISION_PREFIX));
  }

  /** 蒸留を**始めた**印（`turnInputEntry` が書く `exchange`）だけを拾う。 */
  async function distillStartedEntries(stores: Stores): Promise<{ text: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return entries.filter((entry) => entry.text.startsWith('ターンの入力: distill'));
  }

  /**
   * 器を組み立てる前後に1ミリ秒以上の隙間を作る。
   *
   * **待ち合わせではなく境界の作り分けである。** 区間の上端は器が起きた時刻
   * （`JournalQuery.until`。境界を含む）なので、種を仕込んだ行と器の生成が
   * 同一ミリ秒に並ぶと、どちらの側に落ちるかが決まらない。実運用では起きない
   * （器はデーモンの起動時に組み立てられ、最初の合図は人間の速さで来る）が、
   * テストは同一ミリ秒に並びうるので明示的に離す。
   */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('1: 蒸留が成功で終わったら、日誌にその印が残る', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **`stop()` の前に測る。** この時点で印は下りているので、続く `stop()` の
    // 蒸留は正しく見送られ、印は増えない（歯Aの管轄。同じ作法が上の歯Dに在る）。
    const marks = await distillSucceededEntries(s.stores);
    expect(marks.length).toBe(1);
    expect(marks[0]?.decision).toContain('reason=conversation_end');

    await s.clone.stop();
  });

  it('2: 蒸留が失敗して終わったら、成功の印は残らない（開始の印は残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      // ターン0＝人間の発言、ターン1＝endConversation の蒸留。**蒸留のターンだけ**
      // を失敗させる（上の歯Cと同じ仕込み）。
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **開始の印は在る。** これが在るのに成功の印が無い、という組み合わせが
    // 「開始を使っていない」ことの証拠である（開始で数えていれば、この回も
    // 「蒸留した」と読まれてしまう）。
    expect((await distillStartedEntries(s.stores)).length).toBe(1);
    expect(await distillSucceededEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  it('3: ずれが在れば、次のセッションの最初のターンにだけ断り書きが載る', async () => {
    const stores = createMemoryStores();
    // 前のプロセスが蒸留し損ねた活動。**器を組み立てる前に仕込む**（器が起きた
    // 後に書かれた行は、定義上いまの会話の中に在るので数えない）。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけたが、蒸留される前に落ちた',
    });
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]).toContain(DISTILL_GAP_NOTICE_HEAD);

    // 2ターン目。`s.events` は conv-1 専用なので別の購読を張る（歯Bと同じ形）。
    const other = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('別件です', 'conv-2'));
    await waitForDone(other.events);

    expect((s.calls[0] as FakeCall).inputs[1]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('4: 正常に蒸留して落ちた器の次のセッションでは、断り書きは載らない（毎回鳴らない）', async () => {
    // **仕込みではなく、実際に蒸留を1本走らせて日誌を作る。** 蒸留そのものが
    // 日誌へ書く（開始の印・応答・消費・そして成功の印）うえ、`stop()` の
    // 見送りは**成功の印より後**に書かれる。素朴に「印より後に日誌の行が在るか」
    // で数えると、正常に蒸留して静かに落ちた器でも必ず真になる ＝ 断り書きが
    // 毎回鳴る。ここが偽陽性の本体である。
    const stores = createMemoryStores();
    // **累積を毎回増やす。** 固定値にすると増分が 0 になり、`turn_usage` の行が
    // 最初のターンぶんしか作られない（AGENTS.md「固定値を返すスタブはテストを
    // 緑にしたまま分岐を殺す」）。増やしておけば蒸留のターンぶんの行も出るので、
    // 「蒸留自身の `turn_usage`（`site: 'session'`）を数えていない」ことまで押せる。
    let nth = 0;
    const first = setup(undefined, stores, {
      modelUsage: () => {
        nth += 1;
        return {
          'claude-fable-5': {
            inputTokens: 10 * nth,
            outputTokens: 20 * nth,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5 * nth,
          },
        };
      },
    });

    first.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(first.events);
    await first.clone.endConversation('conv-1');
    await first.clone.stop();
    await tick();

    // 器の入れ替わり。**同じ日誌の上で**次のセッションを起こす。
    const second = setup(undefined, stores);
    await tick();

    second.clone.post(humanMessage('こんにちは'));
    await waitForDone(second.events);

    expect((second.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await second.clone.stop();
  });

  it('5: 成功の印と同じミリ秒に積まれた行を、印より後ろと数えない（境界）', async () => {
    // 活動 → その後に「成功で終わった」印、の順に仕込む。**`at` は器が埋めるので
    // この2行は同じミリ秒に並びうる。** 時刻で窓を切る（`since: 印の時刻`）と
    // 境界を含んでしまい、その蒸留がまさに移した活動を「移されなかった」と数える。
    // 窓は `id` を錨にする `after` で切ってある（`journal-order-with-contract.ts`
    // の契約9 —— 同じミリ秒に積んだ2行をまたいでも飛ばさず重複しない）。
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけた',
    });
    await stores.journal.append(distillSucceededEntry('shutdown'));
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('6: PreCompact のサイドセッションで蒸留が成功したら、reason=pre_compact の印が残る', async () => {
    // **受信箱を通らない別経路である。** `#handle` の `'distill'` 分岐にだけ印を
    // 置くと、「要約の直前に蒸留して、そのまま器が入れ替わった」回が「1度も蒸留
    // していない」と読まれる。
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-distill-gap-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const marks = await distillSucceededEntries(s.stores);
    expect(marks.map((mark) => mark.decision)).toEqual([
      `${DISTILL_SUCCEEDED_DECISION_PREFIX} reason=pre_compact`,
    ]);

    await s.clone.stop();
  });

  it('7: `site` が `session` でない `turn_usage` は活動として数えない（蒸留のサイドセッションの分）', async () => {
    // **導出（`deriveDistillGapFromJournal`）へ直に当てる歯である。** 上の6本は
    // クローンのループを通しているが、この条件だけはそこからは押せない ——
    // `site: 'distill'` を書くのは PreCompact のサイドセッションだけで、そこは
    // `#recordUsage` → 成功の印 の順に書くので、その行が**印より後ろ**に来る経路が
    // 器の側に無い（しかも `isSuccessResult` が偽なら両方とも書かれない）。
    // 順序が守ってくれている条件を、基準そのものの側でも1本押さえる。
    const usageEntry = (site: 'session' | 'distill'): JournalEntryInput => ({
      type: 'turn_usage',
      layer: 'clone',
      site,
      managerId: CLONE_ACTOR_ID,
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.5,
        },
      },
    });

    const stores = createMemoryStores();
    await stores.journal.append(distillSucceededEntry('pre_compact'));
    // 印より**後ろ**に置く。素朴に「印より後に日誌の行が在るか」で数えるなら、
    // これだけで「ずれが在る」になる。
    await stores.journal.append(usageEntry('distill'));
    await tick();

    expect(
      await deriveDistillGapFromJournal(stores.journal, { until: new Date().toISOString() }),
    ).toBeNull();

    // **逆向きも押す。** `site: 'session'` なら数える —— ここが無いと
    // 「`turn_usage` を丸ごと数えない」に変異させても緑のままになる。
    await stores.journal.append(usageEntry('session'));
    await tick();

    const gap = await deriveDistillGapFromJournal(stores.journal, {
      until: new Date().toISOString(),
    });
    expect(gap?.activityCount).toBe(1);
  });

  /**
   * 文面の自己矛盾（Issue #564 続き）。
   *
   * **`describeDistillGap` へ直に当てる歯である**（歯7と同じ当て方 —— この
   * 条件は日誌を仕込んで作るものではなく `DistillGap` の値そのものが決めるので、
   * クローンのループを通さず値を直に組み立てて渡せる）。
   *
   * `deriveDistillGapFromJournal` は窓の下端を `after: { id, at }`（`id` の
   * 錨）で切っているので、印と同じミリ秒に積まれた「印より後ろの行」が正しく
   * 区間の始まりに数えられることがあり、そのとき `firstActivityAt` は
   * `lastDistilledAt` と同じ値になる（`distill-gap.ts` の
   * `describeDistillGap` の doc）。素朴な文面は「それより後」と言いながら
   * 区間の始まりに同じ時刻を出し、読み手には実装が矛盾しているように見える。
   * ここで固定するのは、その場合だけ理由の1文が足されることである。
   */
  it('8: 区間の始まりが蒸留の時刻と同じミリ秒のとき、断り書きにその理由が載る', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.000Z',
      lastActivityAt: '2026-08-28T00:00:00.500Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).toContain(
      '**区間の始まりが蒸留の時刻と同じに見えるのは、日誌の時刻がミリ秒までしか' +
        '無いためである。**数えているのは時刻ではなく日誌の並びで、成功の印そのものより' +
        '後ろに積まれた行だけを数えている（印と同じミリ秒でも、印より前に積まれた行は' +
        '数えていない）。',
    );
  });

  /**
   * 上の歯8の裏 —— 時刻が違うときは、その1文が載らない（共通の場合の文面が
   * 太らないことの歯）。歯8を「常に足す」へ弱めて壊すと、この歯だけが落ちる。
   */
  it('9: 区間の始まりが蒸留の時刻と違うとき、その1文は載らない', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.500Z',
      lastActivityAt: '2026-08-28T00:00:01.000Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).not.toContain('区間の始まりが蒸留の時刻と同じに見えるのは');
  });
});

/**
 * ⭐ 定期の棚卸し（`reason: 'scheduled'` の蒸留。人間の指示 2026-09-08）。
 *
 * **測るのは3つで、いちばん重いのは (3) である。**
 *
 * 1. 的の一覧が実際にターンの入力へ載ること
 * 2. 会話終了の蒸留には載らないこと（本題を薄めない）
 * 3. **このターンが `kind: 'distill'` として走ること**
 *
 * ## (3) をどう測るか — 直接は測れないので、同じ `kind` が決める別の跡で測る
 *
 * 守りたい性質は「`ToolContext.memoryCause` が `'distill'` になること」である
 * （`'clone'` になると `guardFullReplace` が1行目で全部素通りし、人間が居ない
 * 場で人間の記憶を無条件に壊せる）。**しかしこの足場の偽 SDK は道具を1つも
 * 呼ばない**ので、`memoryCause` の値を実挙動から取り出せない。
 *
 * ⟹ **同じ `#turn.kind` が決めるもう1つの跡で測る。** 蒸留のターンには
 * 未了の台帳の断り（`#notices` の `commitment`）と「いまの全体」（`#notices` の
 * `situation`）が載らない。**両方とも `kind === 'distill'` かどうかだけで分岐する**ので、
 * これが載っていなければそのターンは `distill` である。
 *
 * **空振りしないことを同じ歯の中で確かめる** —— 直前の人間のターンには
 * 両方が載っていることを見る（載らない実装なら `not.toContain` は
 * どこでも真になり、何も測らなくなる）。
 */
describe('クローン — 定期の棚卸し（scheduled な蒸留）', () => {
  /** 節の目次が予算を超える premise（＝的になる文書）。 */
  const FAT = `---\ntype: premise\ndescription: 要旨\n---\n${Array.from(
    { length: 300 },
    (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
  ).join('\n')}`;

  const COMMITMENT_NOTICE = '[system] 引き受けたまま終わっていない仕事は';
  const SITUATION_NOTICE = '[system] いまの全体';

  function tidyEvent(): InboxEvent {
    return { type: 'distill', id: 'evt-tidy', at: new Date().toISOString(), reason: 'scheduled' };
  }

  it('⭐ 棚卸しの刻みでは、いま測った的の一覧がターンの入力に載る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('定期の棚卸しの刻みが来た');
    expect(input).toContain('- alteroid-work:');
    // 何をすればよいかまで載る（名指しだけで終わらせない）。
    expect(input).toContain('memory_section_move');

    await s.clone.stop();
  });

  it('会話終了の蒸留には的の一覧を載せない（本題を薄めない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await s.clone.endConversation('conv-1');

    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).toContain('記憶へ移すべきものがあるか確認せよ');
    // 語ではなくその実行で実際に流れた的の名前で測る（上の陽性の歯 `- alteroid-work:` と対）。
    // 語は散文の説明文にも出るため、語の不在では「載っていないこと」の証明にならない。
    expect(distill).not.toContain('- alteroid-work:');
    expect(distill).not.toContain('定期の棚卸しの刻みが来た');

    await s.clone.stop();
  });

  it('⭐⭐ 棚卸しのターンは distill として走る（記憶の守りが効く側）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const human = (s.calls[0] as FakeCall).inputs[0] ?? '';
    const tidy = (s.calls[0] as FakeCall).inputs[1] ?? '';

    // 空振り防止: 通常のターンには両方載っている。
    expect(human).toContain(COMMITMENT_NOTICE);
    expect(human).toContain(SITUATION_NOTICE);
    // 本体: 棚卸しのターンには載らない ＝ kind が 'distill' である
    // ＝ memoryCause が 'distill' になり、guardFullReplace が効く。
    expect(tidy).not.toContain(COMMITMENT_NOTICE);
    expect(tidy).not.toContain(SITUATION_NOTICE);

    await s.clone.stop();
  });

  /**
   * ⭐ 段2: 横断の蒸留（#1055）。同じ定期の棚卸しに相乗りする
   * （`appraisal.ts` の `describeAppraisalTargets`、`prompt.ts` の
   * `DistillPromptOptions.appraisalTargets`）。**測るのは `tidyTargets` と
   * 対になる2つだけ** —— 棚卸しの刻みには載ること、会話終了の蒸留には
   * 載らないこと（本題を薄めない、という同じ理由）。
   */
  it('⭐ 棚卸しの刻みでは、評定の束（段2）もターンの入力に載る', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'commit-appraised',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '評定つきの依頼',
    });
    await stores.commitments.appraise(
      'commit-appraised',
      '2026-08-01T00:00:00.000Z',
      'bad',
      'human',
      '間に合わなかった',
    );
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('commit-appraised');
    expect(input).toContain('うまくいかなかった');

    await s.clone.stop();
  });

  it('会話終了の蒸留には評定の束を載せない（本題を薄めない）', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'commit-appraised-2',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '評定つきの依頼2',
    });
    await stores.commitments.appraise(
      'commit-appraised-2',
      '2026-08-01T00:00:00.000Z',
      'bad',
      'human',
    );
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await s.clone.endConversation('conv-1');

    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).not.toContain('commit-appraised-2');

    await s.clone.stop();
  });

  /**
   * ⭐ 段4: やり方の候補の材料（#1055）。段2 と同じ定期の棚卸しに相乗りする
   * （`practice-candidates.ts` の `describePracticeCandidates`、`prompt.ts` の
   * `DistillPromptOptions.practiceCandidates`）。測るのは段2 と対になる3つ ——
   * 棚卸しの刻みには種類・いまのやり方が載ること、会話終了の蒸留には載らないこと、
   * **そして材料を読むだけで `practice_write` 相当の書き込みが起きないこと**
   * （やり方の版が増えていない）。
   */
  it('⭐ 棚卸しの刻みでは、やり方の候補の材料（段4）も載り、やり方は書き換わらない', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'commit-kind-bad',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '種類つきの依頼',
    });
    await stores.commitments.appraise(
      'commit-kind-bad',
      '2026-08-01T00:00:00.000Z',
      'bad',
      'clone',
      '出典を確かめなかった',
      '調査',
    );
    await stores.practices.write({
      slug: 'research-howto',
      kind: '調査',
      title: '調査のやり方',
      content: '一次資料を先に読む',
    });
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('### 種類「調査」');
    expect(input).toContain('やり方 research-howto「調査のやり方」（版 1 件');
    expect(input).toContain('一次資料を先に読む');
    expect(input).toContain('## 評定する側の較正の材料');
    // 材料を読んだだけで、やり方は1版も増えていない。
    expect(await stores.practices.listVersions('research-howto')).toHaveLength(1);

    await s.clone.stop();
  });

  it('会話終了の蒸留にはやり方の候補の材料を載せない（本題を薄めない）', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'commit-kind-bad-2',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '種類つきの依頼2',
    });
    await stores.commitments.appraise(
      'commit-kind-bad-2',
      '2026-08-01T00:00:00.000Z',
      'bad',
      'clone',
      undefined,
      '調査',
    );
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await s.clone.endConversation('conv-1');

    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).not.toContain('### 種類「調査」');
    expect(distill).not.toContain('評定する側の較正の材料');

    await s.clone.stop();
  });
});

/**
 * ⭐ 要約に潰された後、記憶の索引を丸ごと載せ直す（Issue #696）。
 *
 * ## 何が壊れていたか
 *
 * 記憶の焼き込みはセッションを組むときに1回だけ行われる。以後の変化は
 * **差分**として会話へ載るので「構築時点の索引 ＋ 差分 ＝ 現在」で揃っている
 * ——**compaction までは。** 要約に潰されると差分もその中へ畳まれ、確実に
 * 残るのは構築時点の索引だけになる。本番のクローンは6日間1セッションのまま
 * だったので、**6日前の索引を「現在の記憶」として読み続けていた。**
 *
 * ## 測るのは「潰された後に全体が載ること」と「その回だけであること」
 *
 * 全体が載るのは高い（索引は2万トークン級）ので、**毎ターン載ってはいけない。**
 * だから3本で挟む —— 載ること／次のターンには載らないこと／潰されていない
 * ときは差分のままであること。
 */
