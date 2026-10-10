import { describe, expect, it } from 'vitest';

import {
  createRunnerLostNotice,
  describeRunnerLost,
  RUNNER_LOST_COALESCE_MS,
} from './runner-lost-notice.js';

/** 偽の時計: 発火は `advance` でだけ起きる。 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: (): number => timers.size,
  };
}

function setup() {
  const clock = fakeClock();
  const sent: string[] = [];
  const notice = createRunnerLostNotice({
    send: (text) => sent.push(text),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, sent, notice };
}

const NAMES = [
  'runner-primary',
  'runner-2',
  'runner-3',
  'runner-4',
  'runner-5',
  'runner-6',
  'runner-7',
  'runner-8',
];

describe('createRunnerLostNotice', () => {
  it('窓の長さは HEARTBEAT_LOST_MS と同じ 30 秒', () => {
    expect(RUNNER_LOST_COALESCE_MS).toBe(30_000);
  });

  it('1: 1台だけ → 窓が閉じたとき、今と同じ文面で1通', () => {
    const { clock, sent, notice } = setup();
    const entry = { label: 'http://r1:7000', runnerId: 'runner-1', reason: 'heartbeat が途絶えた' };
    notice.add(entry);
    clock.advance(RUNNER_LOST_COALESCE_MS - 1);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual([
      'runner (http://r1:7000 / runner-1) が名乗らなくなりました。新しい委譲の宛先からは外します。そこで走っていた委譲は、貸し出しの期限（既定では、この器が最後に名乗ってから10分30秒）が切れてから別の器へ移し、それまでに名乗り直せば移しません（貸し出しを持たない委譲は、すぐに移します）: heartbeat が途絶えた',
    ]);
    expect(sent[0]).toBe(describeRunnerLost(entry));
  });

  it('1: runnerId が無い1台は label だけ（今の文面と同じ）', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'http://r1:7000', reason: 'x' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^runner \(http:\/\/r1:7000\) が名乗らなくなりました。/);
    expect(sent[0]).toMatch(/: x$/);
  });

  it('2: 8台が窓の中に来る → 1通。台数・全台の名指し・「8 台とも同じ」理由', () => {
    const { clock, sent, notice } = setup();
    for (const name of NAMES) {
      notice.add({ label: `http://${name}:7000`, runnerId: name, reason: '同じ理由' });
      clock.advance(1_000);
    }
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(1);
    const text = sent[0] ?? '';
    expect(text).toContain('runner 8 台が名乗らなくなりました（' + NAMES.join('・') + '）');
    for (const name of NAMES) expect(text).toContain(`${name}（http://${name}:7000）`);
    expect(text).toContain('理由（8 台とも同じ）: 同じ理由');
    expect(text.match(/同じ理由/g)).toHaveLength(1);
  });

  it('2: 窓は延長しない（最初の1台から 30 秒で閉じる）', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'a', runnerId: 'a', reason: 'r' });
    clock.advance(20_000);
    notice.add({ label: 'b', runnerId: 'b', reason: 'r' });
    clock.advance(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('runner 2 台');
  });

  it('3: 理由が違う台が混ざる → 台ごとの理由が並ぶ', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'http://a', runnerId: 'runner-a', reason: '理由A' });
    notice.add({ label: 'http://b', runnerId: 'runner-b', reason: '理由B' });
    notice.add({ label: 'http://c', reason: '理由C' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(1);
    const text = sent[0] ?? '';
    expect(text).toContain('runner 3 台が名乗らなくなりました（runner-a・runner-b・http://c）');
    expect(text).toContain('- runner-a（http://a）: 理由A');
    expect(text).toContain('- runner-b（http://b）: 理由B');
    expect(text).toContain('- http://c: 理由C');
    expect(text).not.toContain('とも同じ');
  });

  it('4: 窓が閉じた後に来た台 → 新しい窓で別の1通', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'a', runnerId: 'a', reason: 'r' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(1);
    notice.add({ label: 'b', runnerId: 'b', reason: 'r' });
    clock.advance(RUNNER_LOST_COALESCE_MS - 1);
    expect(sent).toHaveLength(1);
    clock.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('runner (b / b)');
    expect(sent[1]).not.toContain('runner (a / a)');
  });

  it('5: flush は窓の中の分をすぐ送り、タイマーを止める', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'a', runnerId: 'a', reason: 'r' });
    notice.add({ label: 'b', runnerId: 'b', reason: 'r' });
    notice.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('runner 2 台');
    expect(clock.pending()).toBe(0);
    clock.advance(RUNNER_LOST_COALESCE_MS * 2);
    expect(sent).toHaveLength(1);
  });

  it('5: flush は空なら何も送らない', () => {
    const { clock, sent, notice } = setup();
    notice.flush();
    expect(sent).toEqual([]);
    notice.add({ label: 'a', reason: 'r' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    notice.flush();
    expect(sent).toHaveLength(1);
  });

  it('5: flush の後に来た台は新しい窓を開く', () => {
    const { clock, sent, notice } = setup();
    notice.add({ label: 'a', reason: 'r' });
    notice.flush();
    notice.add({ label: 'b', reason: 'r' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(2);
  });
});

describe('送る時点で、名乗り直した器を言う（#4449）', () => {
  function setupWithBack(back: ReadonlySet<string>, throws = false) {
    const clock = fakeClock();
    const sent: string[] = [];
    const asked: string[] = [];
    const notice = createRunnerLostNotice({
      send: (text) => sent.push(text),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      isBackNow: (entry) => {
        asked.push(entry.label);
        if (throws) throw new Error('名簿を読めなかった（テスト）');
        return back.has(entry.label);
      },
    });
    return { clock, sent, asked, notice };
  }

  const STILL_TRIED =
    '貸し出しのある委譲は、期限が切れる前に名乗り直したので移していない' +
    '（移したとすれば貸し出しを持たない委譲だけで、移し終えた委譲は元の器へ戻らない）。';

  it('1台が窓のうちに名乗り直した → 今の文面の後に「名乗り直している」と移送の事実を足す（捨てない）', () => {
    const { clock, sent, notice } = setupWithBack(new Set(['http://r1:7000']));
    const entry = { label: 'http://r1:7000', runnerId: 'runner-1', reason: 'heartbeat が途絶えた' };
    notice.add(entry);
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toEqual([
      `${describeRunnerLost(entry)}\n送る時点では、この器は名乗り直している（connected）。${STILL_TRIED}`,
    ]);
  });

  it('8台とも名乗り直した → 「8 台とも名乗り直している」', () => {
    const labels = NAMES.map((name) => `http://${name}:4518`);
    const { clock, sent, notice } = setupWithBack(new Set(labels));
    NAMES.forEach((name, i) => {
      notice.add({
        label: labels[i] as string,
        runnerId: name,
        reason: '5000ms 以内に名乗りが返らなかった',
      });
    });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('runner 8 台が名乗らなくなりました');
    expect(sent[0]).toContain(
      `\n送る時点では、8 台とも名乗り直している（connected）。${STILL_TRIED}`,
    );
  });

  it('一部だけ名乗り直した → 戻った台を名指しする', () => {
    const { clock, sent, notice } = setupWithBack(new Set(['b']));
    notice.add({ label: 'a', runnerId: 'runner-a', reason: 'r' });
    notice.add({ label: 'b', runnerId: 'runner-b', reason: 'r' });
    notice.add({ label: 'c', runnerId: 'runner-c', reason: 'r' });
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent[0]).toContain(
      `\n送る時点では、うち 1 台（runner-b）が名乗り直している（connected）。${STILL_TRIED}`,
    );
  });

  it('1台も戻っていなければ、今の文面と1文字も変わらない', () => {
    const { clock, sent, notice } = setupWithBack(new Set());
    const entry = { label: 'http://r1:7000', runnerId: 'runner-1', reason: 'heartbeat が途絶えた' };
    notice.add(entry);
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toEqual([describeRunnerLost(entry)]);
  });

  it('名簿は窓が閉じて送る時点で読む（台を受けた時点では読まない）', () => {
    const { clock, asked, notice } = setupWithBack(new Set());
    notice.add({ label: 'a', reason: 'r' });
    notice.add({ label: 'b', reason: 'r' });
    expect(asked).toEqual([]);
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(asked).toEqual(['a', 'b']);
  });

  it('名簿の読み取りが投げたら、戻っていない側に倒して今の文面で送る', () => {
    const { clock, sent, notice } = setupWithBack(new Set(['a']), true);
    const entry = { label: 'a', reason: 'r' };
    notice.add(entry);
    clock.advance(RUNNER_LOST_COALESCE_MS);
    expect(sent).toEqual([describeRunnerLost(entry)]);
  });

  it('flush（デーモンの停止）でも送る時点で照らす', () => {
    const { sent, notice } = setupWithBack(new Set(['a']));
    notice.add({ label: 'a', reason: 'r' });
    notice.flush();
    expect(sent[0]).toContain('送る時点では、この器は名乗り直している');
  });
});
