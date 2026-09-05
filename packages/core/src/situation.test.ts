import { describe, expect, it } from 'vitest';

import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import {
  countManagerSituation,
  countRunnerStates,
  describeSituation,
  describeSituationUnavailable,
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
   * **5つの区分は分割である**——どのマネージャーもちょうど1つに入り、足すと
   * `total` になる。`JobStatus` の6値すべてを1度に通して確かめる。
   */
  it('5つの区分は分割で、合計は total に一致する（JobStatus 6値すべてを通す）', () => {
    const statuses: JobStatus[] = ['running', 'waiting_human', 'done', 'failed', 'lost', 'stopped'];
    const managers = [
      ...statuses.map((status, index) => summary(`live-${index}`, status, true)),
      ...statuses.map((status, index) => summary(`dead-${index}`, status, false)),
      summary('bg', 'done', true, BG),
    ];
    const counts = countManagerSituation(managers);
    expect(counts.total).toBe(13);
    expect(
      counts.running + counts.waitingHuman + counts.awaitingBackground + counts.idle + counts.other,
    ).toBe(counts.total);
    // 内訳そのものも固定する（合計だけだと、区分どうしが入れ替わっても通る）。
    expect(counts.running).toBe(2);
    expect(counts.waitingHuman).toBe(2);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.idle).toBe(1);
    // failed / lost / stopped が6本と、`done` かつ `live: false` の1本。
    expect(counts.other).toBe(7);
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
        summary('k', 'lost', false),
        summary('l', 'failed', false),
      ],
      runners: [],
    });
    expect(text).toContain('委譲 全 12 本');
    // 走行中3 / 返事待ち4 / 背景処理待ち2 / 手が空いている1 / その他2 —— **どの2つも
    // 同じ数にしない**（同じ数だと、その2つを入れ替える変異が捕まらない）。
    expect(text).toContain('走行中 3');
    expect(text).toContain('返事待ち 4');
    expect(text).toContain('背景処理待ち 2');
    expect(text).toContain('手が空いている 1');
    expect(text).toContain('その他 2');
    expect(text).toContain('話しかけられるのは 10 本');
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
