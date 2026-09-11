import { describe, expect, it } from 'vitest';

import { INBOX_BACKLOG_LOUD_THRESHOLD } from './inbox-backlog.js';
import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import {
  countManagerSituation,
  countRunnerStates,
  describeSituation,
  describeSituationUnavailable,
  describeTokenSituation,
} from './situation.js';

/**
 * ターンの入口へ載せる「いまの全体」（`situation.ts`）。
 *
 * **ここで測るのは数え方と字面である。** クローンのターンへ実際に載る配線は
 * `clone-situation-notice.test.ts` が別に測る——同じ歯で両方を見ると、片方が
 * 落ちたときにどちらが壊れたのか判別できない。
 */

function summary(
  id: string,
  status: JobStatus,
  live: boolean,
  awaitingBackground?: { tasks: number; withheldReports: number; breakdown: string; since: string },
): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
    ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
  };
}

const BG = {
  tasks: 3,
  withheldReports: 1,
  breakdown: 'local_agent×3',
  since: '2026-09-05T00:00:00.000Z',
};

describe('countManagerSituation', () => {
  /**
   * **この歯がこのファイルで最初に来る理由。** 「手が空いている」と「背景処理を
   * 待っている」の区別がこの節の存在理由そのもので、`status` はどちらも `'done'`
   * である（`manager.ts` の `case 'report'` が `record.job.status = event.status;`
   * を握り潰しの分岐より前に実行するため）。
   */
  it('done は「手が空いている」と「背景処理待ち」に割れる（status だけでは割れない）', () => {
    const counts = countManagerSituation([
      summary('a', 'done', true),
      summary('b', 'done', true, BG),
    ]);
    expect(counts.idle).toBe(1);
    expect(counts.awaitingBackground).toBe(1);
  });

  /** **背景処理待ちを `status` より先に見る**（後に見ると `idle` へ吸い込まれる）。 */
  it('背景処理待ちは running/waiting_human より先に数える', () => {
    const counts = countManagerSituation([
      summary('a', 'running', true, BG),
      summary('b', 'waiting_human', true, BG),
    ]);
    expect(counts.awaitingBackground).toBe(2);
    expect(counts.running).toBe(0);
    expect(counts.waitingHuman).toBe(0);
  });

  /**
   * ⭐ **6つの区分は分割である**——どのマネージャーもちょうど1つに入り、足すと
   * `total` になる。`JobStatus` の6値すべてを1度に通して確かめる。
   *
   * **区分は 5 → 6 になった（#688 で `lost` を `other` から分けた）。** この歯の
   * 本体は**合計が `total` に一致すること**で、区分を足すたびにここへ1項足す
   * ——足し忘れると合計が合わなくなって赤くなる（＝新しい区分が `total` の
   * どこから来たのか説明できない形で入るのを防ぐ）。
   *
   * **`reachable` はこの和に足さない**（横断する軸である。下の歯が持つ）。
   */
  it('⭐ 6つの区分は分割で、合計は total に一致する（JobStatus 6値すべてを通す）', () => {
    const statuses: JobStatus[] = ['running', 'waiting_human', 'done', 'failed', 'lost', 'stopped'];
    const managers = [
      ...statuses.map((status, index) => summary(`live-${index}`, status, true)),
      ...statuses.map((status, index) => summary(`dead-${index}`, status, false)),
      summary('bg', 'done', true, BG),
    ];
    const counts = countManagerSituation(managers);
    expect(counts.total).toBe(13);
    expect(
      counts.running +
        counts.waitingHuman +
        counts.awaitingBackground +
        counts.idle +
        counts.lost +
        counts.other,
    ).toBe(counts.total);
    // 内訳そのものも固定する（合計だけだと、区分どうしが入れ替わっても通る）。
    expect(counts.running).toBe(2);
    expect(counts.waitingHuman).toBe(2);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.idle).toBe(1);
    // **`lost` は `live` の有無に関わらず `lost` である**（`live-4` と `dead-4`）。
    expect(counts.lost).toBe(2);
    // failed / stopped が4本と、`done` かつ `live: false` の1本。
    // **`lost` の2本はもうここに入らない**（#688 で分けた。以前は 7 だった）。
    expect(counts.other).toBe(5);
  });

  /**
   * ⭐ **`lost` が `other` から分かれたこと**を、同じ入力の中で相補的に測る
   * （#688）。`other` が減って `lost` が増える——**片方だけを見ると、`lost` を
   * `other` に「足した」だけの実装でも通る。**
   */
  it('⭐ lost は other から分かれた（other が減り、lost が増える）', () => {
    const withoutLost = countManagerSituation([summary('a', 'failed', false)]);
    const withLost = countManagerSituation([
      summary('a', 'failed', false),
      summary('b', 'lost', false),
    ]);
    // 基準（`lost` が1本も無い入力）。
    expect(withoutLost.lost).toBe(0);
    expect(withoutLost.other).toBe(1);
    // `lost` を1本足しても `other` は増えない（＝ `else other += 1` へ落ちていない）。
    expect(withLost.other).toBe(1);
    expect(withLost.lost).toBe(1);
    expect(withLost.total).toBe(2);
  });

  /**
   * **`lost` の判定は背景処理待ちより後ろである**（`countManagerSituation` の doc）。
   * 握り潰しの印が立ったまま `lost` へ落ちた回で、握り潰しのほうが消えない。
   */
  it('背景処理待ちの印が立っていれば、lost でも「背景処理待ち」に数える', () => {
    const counts = countManagerSituation([summary('a', 'lost', false, BG)]);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.lost).toBe(0);
    // 分割の性質は崩れていない。
    expect(counts.awaitingBackground + counts.lost + counts.other).toBe(counts.total);
  });

  /**
   * **`reachable` は分割ではなく横断する軸である。** 走行中でも返事待ちでも
   * `live` は立ちうるので、5つの区分と足し合わせてはいけない——足し合わせられる
   * と読まれると、本数が二重に数えられる。
   */
  it('reachable は5つの区分と重なる（横断する軸である）', () => {
    const counts = countManagerSituation([
      summary('a', 'running', true),
      summary('b', 'waiting_human', true),
      summary('c', 'done', false),
    ]);
    expect(counts.reachable).toBe(2);
    expect(counts.idle).toBe(0);
  });

  it('1本も居なければ全部0で、total も0である', () => {
    const counts = countManagerSituation([]);
    expect(counts).toEqual({
      total: 0,
      running: 0,
      waitingHuman: 0,
      awaitingBackground: 0,
      idle: 0,
      lost: 0,
      other: 0,
      reachable: 0,
    });
  });
});

describe('countRunnerStates', () => {
  /** **6値を畳まない**（`manager.ts` の `RunnerOverview.state` の doc）。 */
  it('RunnerLiveness の6値をそれぞれ別に数える', () => {
    const states: RunnerLiveness[] = [
      'connecting',
      'connected',
      'connected',
      'unreachable',
      'unusable',
      'lost',
      'vacating',
    ];
    const byState = countRunnerStates(states.map((state) => ({ state })));
    expect(byState.get('connected')).toBe(2);
    expect(byState.get('connecting')).toBe(1);
    expect(byState.get('unreachable')).toBe(1);
    expect(byState.get('unusable')).toBe(1);
    expect(byState.get('lost')).toBe(1);
    expect(byState.get('vacating')).toBe(1);
    expect(byState.size).toBe(6);
  });

  it('居ない state は鍵ごと出さない（0 を作らない）', () => {
    const byState = countRunnerStates([{ state: 'connected' }]);
    expect(byState.has('lost')).toBe(false);
    expect([...byState.keys()]).toEqual(['connected']);
  });
});

describe('describeSituation', () => {
  /**
   * **委譲の行は 0 でも全部書く。** 5区分は同じ1回の数え上げの分割で、合計も
   * 並んでいるので「0 と書いた」を「数えていない」と読む余地が無い。そして
   * **「手が空いている」を落とすと、この節が在る理由そのものが消える**
   * （`describeInboxBacklog` が #562 で直したのと同じ形）。
   */
  it('委譲の5区分は 0 でも全部出る（とくに「手が空いている 0」を消さない）', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true)],
      runners: [{ state: 'connected' }],
    });
    expect(text).toContain('委譲 全 1 本');
    expect(text).toContain('走行中 1');
    expect(text).toContain('返事待ち 0');
    expect(text).toContain('背景処理待ち 0');
    expect(text).toContain('手が空いている 0');
    expect(text).toContain('その他 0');
    expect(text).toContain('話しかけられるのは 1 本');
  });

  /**
   * **5つの区分に、それぞれ違う本数を割り当てる。** 同じ数を2つの区分へ置くと、
   * その2つを取り違える変異が緑のまま通る——実際に踏んだ: `手が空いている
   * ${counts.idle}` を `${counts.other}` へ差し替える変異が、`idle === other === 1`
   * だったこの歯では生き残り、`clone-situation-notice.test.ts`（`idle: 1` /
   * `other: 0`）だけが殺していた（変異試験の実測。この歯はその後に直した形）。
   */
  it('数えた本数がそのまま出る（背景処理待ちと手が空いているを取り違えない）', () => {
    const text = describeSituation({
      managers: [
        summary('a', 'running', true),
        summary('b', 'running', true),
        summary('c', 'running', true),
        summary('d', 'waiting_human', true),
        summary('e', 'waiting_human', true),
        summary('f', 'waiting_human', true),
        summary('g', 'waiting_human', true),
        summary('h', 'done', true, BG),
        summary('i', 'done', true, BG),
        summary('j', 'done', true),
        // **`lost` を5本、`other` を6本にしてある（#688）。** 以前はどちらも
        // 1本で、上の「どの2つも同じ数にしない」を `lost` の追加で破っていた
        // ——`counts.lost` と `counts.other` を入れ替える変異が緑のまま通る。
        summary('k0', 'lost', false),
        summary('k1', 'lost', false),
        summary('k2', 'lost', false),
        summary('k3', 'lost', false),
        summary('k4', 'lost', false),
        summary('l0', 'failed', false),
        summary('l1', 'failed', false),
        summary('l2', 'failed', false),
        summary('l3', 'stopped', false),
        summary('l4', 'stopped', false),
        summary('l5', 'done', false),
      ],
      runners: [],
    });
    expect(text).toContain('委譲 全 21 本');
    // 走行中3 / 返事待ち4 / 背景処理待ち2 / 手が空いている1 / lost 5 / その他6
    // —— **どの2つも同じ数にしない**（同じ数だと、その2つを入れ替える変異が
    // 捕まらない）。
    expect(text).toContain('走行中 3');
    expect(text).toContain('返事待ち 4');
    expect(text).toContain('背景処理待ち 2');
    expect(text).toContain('手が空いている 1');
    expect(text).toContain('戻れなかった(lost) 5');
    expect(text).toContain('その他 6');
    expect(text).toContain('話しかけられるのは 10 本');
  });

  /**
   * ⭐ **`lost` の本数と、次に何を確かめるかが本文に出る**（#688）。
   *
   * **この節は `distill` 以外の全ターンの入口に載る**（`clone.ts` の
   * `#situationNoticeFor`）。⟹ **いちばん確実に読まれる場所で、いちばん判断が
   * 要る状態が畳まれていた**のが直した穴である。
   *
   * **到達口の綴りまで測る。** 本数だけ出ても名指しできない（一覧の本文は
   * `LIST_BUDGET` で切られる）ので、`status: ["lost"]` を渡せることが本文から
   * 読めなければ直っていない。
   */
  it('⭐ lost が在れば本数と、リモートを確かめる順序と、名指しの引き方が出る', () => {
    const text = describeSituation({
      managers: [summary('a', 'lost', false), summary('b', 'running', true)],
      runners: [],
    });
    expect(text).toContain('戻れなかった(lost) 1');
    // 「終わった」と読ませない（この行が在る理由そのもの）。
    expect(text).toContain('成果の有無は1度も観測していない');
    // 名指しで引く綴り（#689 で入った到達口）。
    expect(text).toContain('status: ["lost"]');
    // **確かめる前に起こし直させない**（同じ仕事が2本になる）。
    expect(text).toContain('`manager_start` で起こし直さないこと');
  });

  /**
   * ⭐ **`lost` が 0 のときは行が出ない**（#688。`describeManagerCounts` の作法）。
   *
   * **残りの5区分は 0 でも出る**——だから「行が無い」は「5つを足したら `total`
   * だった」＝ `lost` は 0、と*算術で*確定する（`describeSituation` の doc）。
   * ⟹ AGENTS.md の地雷「取れない軸に 0 の行を作る」を踏まない。
   */
  it('⭐ lost が 0 のときは行も断り書きも1文字も出ない（0 の行を作らない）', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true), summary('b', 'failed', false)],
      runners: [],
    });
    // 見出しそのものが1度も出ない（本数の欄も、断り書きの1行も）。
    expect(text).not.toContain('戻れなかった(lost)');
    expect(text).not.toContain('成果の有無は1度も観測していない');
    // **残りの5区分は 0 でも出ている**（この歯の前提。消えていたら
    // 「行が無い＝0」の算術が成り立たない）。
    expect(text).toContain('委譲 全 2 本');
    expect(text).toContain('走行中 1');
    expect(text).toContain('返事待ち 0');
    expect(text).toContain('背景処理待ち 0');
    expect(text).toContain('手が空いている 0');
    expect(text).toContain('その他 1');
  });

  /**
   * ⭐ **「その他」の説明文から `lost` を外した**（#688）。
   *
   * 畳んでいたあいだ、この一文が「`lost` は終端したものである」と読ませていた
   * ——`lost` は終端の値だが、**成果の有無を観測していないのはこれだけ**で、
   * `failed` / `stopped` と同じ袋に入れると「終わったもの」として読み飛ばされる。
   */
  it('⭐ 「その他」の説明文に lost が入っていない（failed / stopped だけを名指しする）', () => {
    const text = describeSituation({
      managers: [summary('a', 'failed', false)],
      runners: [],
    });
    // **対象をスコープして測る**（AGENTS.md「対象をスコープして特定する」）——
    // 全文で `not.toContain('lost')` を撃つと、`lost` の本数の行や器の state に
    // 当たって、測りたいものと別のところで落ちる。
    const note = text.split('\n').find((line) => line.includes('「その他」は終端したもの'));
    expect(note, '「その他」の説明文が見つからない').toBeDefined();
    expect(note).toContain('（failed / stopped）');
    expect(note).not.toContain('lost');
  });

  /**
   * **器の行は合計を必ず書き、0 の state は書かない。** 合計が在るので
   * 「数えていない」とは読めない（`describeManagerCounts` と同じ規則）。
   */
  it('器は台数を必ず出し、居ない state は出さない', () => {
    const text = describeSituation({
      managers: [],
      runners: [{ state: 'connected' }, { state: 'connected' }, { state: 'vacating' }],
    });
    // **器の行だけを取り出して測る。** 全文で `not.toContain('lost')` を撃つと、
    // 断り書きの「その他は終端したもの（failed / lost / stopped）」に当たって
    // 落ちる——測りたいのは「居ない state を器の行へ 0 として並べていないこと」
    // なので、対象を絞る（AGENTS.md「対象をスコープして特定する」）。
    const runnerLine = text.split('\n').find((line) => line.startsWith('器 '));
    expect(runnerLine).toBe('器 3 台: connected 2 / vacating 1。');
    for (const absent of ['lost', 'unreachable', 'unusable', 'connecting']) {
      expect(runnerLine, `居ない state（${absent}）が器の行に出ている`).not.toContain(absent);
    }
  });

  it('器が1台も無くても行を消さず「器 0 台」と書く', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text).toContain('器 0 台。');
  });

  /**
   * **「空き枠」を作らない**（north_star 禁止2。`runner-protocol.ts` が
   * `capacity` という語を避けているのと同じ線）。**「手が空いている」を
   * 「置ける」と読ませない断りが、数と一緒に出ていること**を固定する。
   */
  it('「空き枠」「あと何本置ける」を作らず、そう読ませない断りを添える', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [{ state: 'connected' }],
    });
    expect(text).toContain('「手が空いている」は「空き枠」ではない');
    expect(text).toContain('置けるかどうかはここでは答えていない');
    // **「枠」を数える語を1つも作らない。** 作った瞬間に、次に触る人がそれを
    // 上限として使い始める（`runner-protocol.ts` が `capacity` を避けている理由）。
    expect(text).not.toContain('あと何本');
    expect(text).not.toContain('空き枠は');
    expect(text).not.toContain('残り');
  });

  /**
   * **背景処理待ちは器が名乗った分だけである**（この欄を送らない古い runner が
   * 在る）。断りが無いと、0 が「待っているものは無い」と読まれる。
   */
  it('背景処理待ちが器の名乗り次第であることを断る', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text).toContain('「背景処理待ち」は器が名乗った分だけである');
  });

  /** **指図を書かない。** 何をするかはクローンが決める（材料だけを出す）。 */
  it('次に何をするかを1文字も指図しない', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true), summary('b', 'done', true)],
      runners: [{ state: 'connected' }],
    });
    for (const forbidden of ['始める', '置くこと', '委譲を出', 'べきである', 'しなさい']) {
      expect(text, `指図（${forbidden}）が混ざっている`).not.toContain(forbidden);
    }
    expect(text).toContain('ここから何をするかは決めない');
  });

  /** 節の末尾は `#commitmentNoticeFor` と同じ区切りで終わる（`#runTurn` の連結の形）。 */
  it('末尾は本文と区切られている（--- で終わる）', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text.endsWith('\n---\n')).toBe(true);
  });
});

describe('describeSituationUnavailable', () => {
  /**
   * **「数えられて0本」と「数えられなかった」を潰さない**
   * （`runner-swap-notice.ts` の `'none-affected'` と `'ledger-unreadable'` を
   * 型で分けているのと同じ理由）。0 で埋めると「全部片付いている」と読める。
   */
  it('0 で埋めず、数えられなかったと名乗る', () => {
    const text = describeSituationUnavailable(new Error('list() が壊れている'));
    expect(text).toContain('数えられなかった');
    expect(text).toContain('list() が壊れている');
    expect(text).toContain('「全部片付いている」ではなく');
    // 数えられた形（本数の行）は1つも出さない——出すとどちらか分からなくなる。
    expect(text).not.toContain('委譲 全 ');
    expect(text).not.toContain('手が空いている');
    expect(text).not.toContain('器 0 台');
  });

  it('行そのものは消えない（見出しは数えられたときと同じ語で始まる）', () => {
    const ok = describeSituation({ managers: [], runners: [] });
    const ng = describeSituationUnavailable(new Error('x'));
    expect(ok.startsWith('[system] いまの全体')).toBe(true);
    expect(ng.startsWith('[system] いまの全体')).toBe(true);
    // それでも本文は見分けが付く。
    expect(ng).not.toBe(ok);
  });
});

/**
 * **枠を理由に仕事を見送らせないための機構**（人間の決定 2026-09-07）。
 *
 * ## 何を固定するのか
 *
 * 実運用の事故: 巡回の番でクローンが**新しい委譲を1本も出さず**、こう書いた ——
 *
 * > 枠が JST 19:30 まで塞がっているので、出しても1手も始まらずに落ちます。
 *
 * **その 19:30 は、既に降りた鍵（`production`）の reset だった。** そのとき現役は
 * `staging` で、記録の上では `ready` だった。人間の逐語:
 * 「**馬鹿じゃないの？自分が動いているのに？**」「**枠を理由に実施しないという選択を
 * した clone がおろかです。仕組みとしてこれを防ぐ必要があります。**」
 *
 * ⟹ 直すのは判断ではなく**材料**である。この歯が測るのは「毎ターン、正しい材料が
 * 隣に在る」ことと、「**書ける状況では必ず偽**という不変条件が落ちない」ことである。
 */
describe('枠を理由に見送らせない（describeTokenSituation）', () => {
  const AT = Date.parse('2026-09-07T07:45:00.000Z');
  const row = (
    over: Partial<
      Parameters<typeof describeTokenSituation>[0]['tokens'] extends
        readonly (infer R)[] | undefined
        ? R
        : never
    > = {},
  ) => ({ id: 'tok-a', label: 'first', ...over });

  it('現役と、その記録上の状態を出す', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'tok-a', label: 'staging@example' })],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(line).toContain('現役は「staging@example」');
    expect(line).toContain('記録の上では 使える');
  });

  it('⭐ 冷却中でも「見送らない」の1行が付く（ここが事故の本体）', () => {
    // **記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない。**
    const line = describeTokenSituation({
      tokens: [row({ cooldownUntil: AT + 3 * 60 * 60 * 1000 })],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(line).toContain('記録の上では 冷却中');
    expect(line).toContain('冷却明けは 2026-09-07T10:45:00.000Z');
    // **不変条件が落ちていない。**
    expect(line).toContain('枠を理由に仕事を見送らないこと');
    expect(line).toContain('書ける状況では必ず偽');
    expect(line).toContain('見送りは選ばない');
  });

  it('過去の文言が降りた鍵のものでありうる、と名指しする', () => {
    // これが事故の前提そのもの（19:30 は降りた鍵の reset だった）。
    const line = describeTokenSituation({ tokens: [row()], active: null, at: AT });

    expect(line).toContain('既に降りた鍵についての事実でありうる');
  });

  it('本数を「いま使える / 冷却中 / 外されている」で分けて数える', () => {
    const line = describeTokenSituation({
      tokens: [
        row({ id: 'a', label: 'ready1' }),
        row({ id: 'b', label: 'ready2' }),
        row({ id: 'c', label: 'cool', cooldownUntil: AT + 1000 }),
        row({ id: 'd', label: 'off', disabledAt: '2026-08-25T00:00:00.000Z' }),
        row({ id: 'e', label: 'dead', invalidatedAt: '2026-08-25T00:00:00.000Z' }),
      ],
      active: { tokenId: 'a' },
      at: AT,
    });

    expect(line).toContain('プール 5 本: いま使える 2 / 冷却中 1 / 外されている 2');
  });

  it('指名がまだ無い回を「1本目が現役」と書かない', () => {
    const line = describeTokenSituation({ tokens: [row()], active: null, at: AT });

    expect(line).toContain('現役の指名は**まだ一度も無い**');
    expect(line).not.toContain('現役は「first」');
  });

  it('指名の先の行が消えていたら、そう書く', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'tok-b', label: 'other' })],
      active: { tokenId: 'tok-gone' },
      at: AT,
    });

    expect(line).toContain('現役として記録された行がプールに無い');
  });

  it('⭐ プールを読めなかった回も、不変条件の行は落とさない', () => {
    // **あれはプールの状態に依存しないので、読めなくても真である。**
    // ここを落とすと、読めなかった回だけ事故が再発しうる。
    for (const input of [
      { tokens: undefined, active: { tokenId: 'tok-a' }, at: AT },
      { tokens: [row()], active: undefined, at: AT },
    ] as const) {
      const line = describeTokenSituation(input);
      expect(line).toContain('プールを読めなかった');
      // **0 や「無し」で埋めていない。**
      expect(line).not.toContain('いま使える 0');
      expect(line).toContain('枠を理由に仕事を見送らないこと');
    }
  });

  it('「必ず通る」へ反転していない（確実性を作らない）', () => {
    const line = describeTokenSituation({ tokens: [row()], active: { tokenId: 'tok-a' }, at: AT });

    expect(line).not.toContain('必ず通る');
    expect(line).not.toContain('必ず始まる');
  });
});

describe('状況の1行に鍵が載る（describeSituation への配線）', () => {
  const AT = Date.parse('2026-09-07T07:45:00.000Z');

  it('材料を渡せば鍵の行が出る', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      tokens: [{ id: 'tok-a', label: 'staging@example' }],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(out).toContain('認証トークン: 現役は「staging@example」');
    expect(out).toContain('枠を理由に仕事を見送らないこと');
    // 既存の数え上げが消えていない。
    expect(out).toContain('委譲 全 0 本');
  });

  it('省略した呼びでは鍵の行が出ない（既存の呼び出しを壊さない）', () => {
    const out = describeSituation({ managers: [], runners: [] });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('認証トークン:');
  });
});

/**
 * 受信箱の滞留の1行（#783 段0）。**3つの状態**を測る——0件で行が無い /
 * 閾値以下で短い / 閾値超えで膨らむ。既存の `toContain` の作法に揃える
 * （スナップショットは使わない）。
 */
describe('状況の1行に受信箱の滞留が載る（#783 段0）', () => {
  /**
   * ⚠ **この節の入力を {@link INBOX_BACKLOG_LOUD_THRESHOLD} から導かない。**
   *
   * 導いた形（`count: INBOX_BACKLOG_LOUD_THRESHOLD + 1`）だと、閾値の値が
   * 変わったとき入力も一緒に動く——歯は「閾値より1つ大きければ膨らむ」という
   * *関係*しか固定しておらず、「その閾値が 50 である」ことは1文字も固定して
   * いない。実際その形では、定数を別の値へ変えてもここのふるまいの歯は緑の
   * ままで、赤くなるのは `inbox-backlog.test.ts` の
   * `expect(INBOX_BACKLOG_LOUD_THRESHOLD).toBe(50)` 1本だけだった。
   *
   * だから入力はリテラルで置き、**リテラルが定数と一致していること自体を
   * 別の1本（すぐ下）で固定する**。この形なら定数が動いた瞬間、50 と 51 が
   * 境界のどちら側に居るかが入れ替わって、ふるまいの歯が赤くなる。
   */
  const AT_THRESHOLD = 50;
  const ABOVE_THRESHOLD = 51;

  it('足場のリテラルは閾値そのものである（定数が動けばここで赤くなる）', () => {
    expect(AT_THRESHOLD).toBe(INBOX_BACKLOG_LOUD_THRESHOLD);
    expect(ABOVE_THRESHOLD).toBe(INBOX_BACKLOG_LOUD_THRESHOLD + 1);
  });

  it('省略した呼びでは行が出ない（既存の呼び出しを壊さない）', () => {
    const out = describeSituation({ managers: [], runners: [] });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('受信箱の未処理');
  });

  it('0件のときは行が出ない（backlog を渡しても count: 0 なら消える）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: 0 },
    });

    expect(out).not.toContain('受信箱の未処理');
  });

  /**
   * ⭐ **「省略（`undefined`）」と「読めなかった（`'unreadable'`）」を分ける。**
   *
   * レビュー前は両方を `undefined` に潰していて、「読めなかった」が「0件
   * だった」と出力上で見分けが付かなかった（`AGENTS.md` の地雷「取れない軸に
   * 0の行を作る」の裏返し。`describeSituationInboxBacklog` の doc）。
   * `'unreadable'` は**必ず専用の1行を出す**——⛔ `0` という数字を含まない
   * ことを確かめる（`toContain('0')` は他の行の数字に当たるので使わない）。
   */
  it('⭐ 読めなかった（`unreadable`）ときは、0件とは別の専用の1行が出る', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: 'unreadable',
    });

    expect(out).toContain('委譲 全 0 本');
    expect(out).toContain('受信箱の未処理を数えられなかった');
    // ⛔ 「0」という数字を含まない——0件だったと見分けが付かなくなるため。
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');
    expect(line).not.toContain('0');
  });

  it('省略（undefined）と unreadable は別の状態——省略は引き続き行が出ない', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: undefined,
    });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('受信箱の未処理');
  });

  it('1件以上・閾値以下は短い1行（⚠ も内訳への案内も付かない）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: AT_THRESHOLD, oldestAt: '2026-09-11T00:00:00.000Z' },
    });

    expect(out).toContain(`受信箱の未処理 ${AT_THRESHOLD} 件`);
    expect(out).toContain('2026-09-11T00:00:00.000Z');
    expect(out).not.toContain(`⚠ 受信箱の未処理 ${AT_THRESHOLD} 件`);
    // **`manager_list` という語自体は他の行（器の説明文）にも出るので、
    // 受信箱の行だけを取り出して確かめる**（他の行に引きずられて誤検出
    // しないように）。
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');
    expect(line).not.toContain('manager_list');
  });

  it('閾値を超えると ⚠ 付きで膨らみ、内訳を割る口の名前が付く', () => {
    const count = ABOVE_THRESHOLD;
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count, oldestAt: '2026-09-10T09:28:55.000Z' },
    });

    expect(out).toContain(`⚠ 受信箱の未処理 ${count} 件`);
    expect(out).toContain('2026-09-10T09:28:55.000Z');
    expect(out).toContain('manager_list');
  });

  it('指図を書かない（「〜せよ」の類が1文字も無い）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: ABOVE_THRESHOLD },
    });
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');

    expect(line).not.toContain('確認せよ');
    expect(line).not.toContain('対処せよ');
    expect(line).not.toContain('処理せよ');
  });
});
