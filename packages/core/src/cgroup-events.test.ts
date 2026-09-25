import { describe, expect, it } from 'vitest';

import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  cgroupEventsDeltaOf,
  cgroupEventsDeltaSchema,
  formatCgroupEventsNote,
  withCgroupEventsNote,
} from './cgroup-events.js';

/**
 * `cgroupEventsDeltaOf`（開いたとき・畳んだときの2点から差分を作る）と、
 * それを人が読む一文へ整形する `formatCgroupEventsNote` / `withCgroupEventsNote`
 * を測る（Issue #1517「最小の形」1〜3）。
 *
 * **固定する4つ**（マネージャーの依頼が明示したもの）:
 *
 * 1. 差分が出る
 * 2. 読めないときは欄が無い
 * 3. 古い runner（欄なし）の `closed` が通る——`runner-protocol.test.ts` 側で測る
 * 4. 知らせの文言に数が出る
 */
describe('cgroupEventsDeltaOf（差分の計算。#1517）', () => {
  it('1. 差分が出る（開いたときとの2点から、増えた分だけを返す）', () => {
    const delta = cgroupEventsDeltaOf({ pidsMax: 1, oomKill: 0 }, { pidsMax: 4, oomKill: 2 });
    expect(delta).toEqual({ pidsMaxDelta: 3, oomKillDelta: 2 });
  });

  it('両方 0 のまま変わらない回も、0 の差分として出る（起きなかったことが言える）', () => {
    const delta = cgroupEventsDeltaOf({ pidsMax: 0, oomKill: 0 }, { pidsMax: 0, oomKill: 0 });
    expect(delta).toEqual({ pidsMaxDelta: 0, oomKillDelta: 0 });
  });

  it('2. 開いたときの値が無ければ、欄ごと出さない（runner の再起動をまたいだ等）', () => {
    expect(cgroupEventsDeltaOf(undefined, { pidsMax: 4, oomKill: 2 })).toBeUndefined();
  });

  it('2. 畳んだときに読めなければ、欄ごと出さない', () => {
    expect(cgroupEventsDeltaOf({ pidsMax: 1, oomKill: 0 }, undefined)).toBeUndefined();
  });

  it('片方の軸だけ読めなくても、もう片方は独立に出す', () => {
    const delta = cgroupEventsDeltaOf({ pidsMax: 1 }, { pidsMax: 4, oomKill: 2 });
    expect(delta).toEqual({ pidsMaxDelta: 3 });
    expect(Object.hasOwn(delta as object, 'oomKillDelta')).toBe(false);
  });

  it('カウンタが逆行していたら、その軸は出さない（負の差分より判定を諦める側へ倒す）', () => {
    const delta = cgroupEventsDeltaOf({ pidsMax: 5, oomKill: 1 }, { pidsMax: 2, oomKill: 3 });
    // pids は逆行（5→2）——出さない。oom は増えている（1→3）——出す。
    expect(delta).toEqual({ oomKillDelta: 2 });
    expect(Object.hasOwn(delta as object, 'pidsMaxDelta')).toBe(false);
  });

  it('両方の軸が出せなければ undefined（欄そのものを出さない）', () => {
    expect(cgroupEventsDeltaOf({}, {})).toBeUndefined();
  });
});

describe('formatCgroupEventsNote / withCgroupEventsNote（知らせの文言。#1517）', () => {
  it('4. 両方 0 のときは、断定してよい強い言い方をする', () => {
    const text = formatCgroupEventsNote({ pidsMaxDelta: 0, oomKillDelta: 0 });
    expect(text).toContain('起きていなかった');
    expect(text).not.toMatch(/\d/); // 数を出さずに済む（0 と 0 は言葉に畳んである）
  });

  it('4. 正の値があれば、数がそのまま文言に出る', () => {
    const text = formatCgroupEventsNote({ pidsMaxDelta: 3, oomKillDelta: 2 });
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('片方だけ読めなかったときは、読めた分だけ数を出し、読めていない軸はそう名乗る', () => {
    const text = formatCgroupEventsNote({ pidsMaxDelta: 5 });
    expect(text).toContain('5');
    expect(text).toContain('判定できなかった');
  });

  it('withCgroupEventsNote は base を1文字も変えず、末尾に1行足す', () => {
    const base = '（何らかの理由で落ちた）';
    const withNote = withCgroupEventsNote(base, { pidsMaxDelta: 0, oomKillDelta: 0 });
    expect(withNote.startsWith(base)).toBe(true);
    expect(withNote).toContain('起きていなかった');
  });

  it('欄そのものが無ければ D（判定できなかった）の定型文が付く。0 とは混ぜない', () => {
    const withNote = withCgroupEventsNote('（何らかの理由で落ちた）', undefined);
    expect(withNote).toContain(CGROUP_EVENTS_UNKNOWN_NOTE);
    expect(withNote).not.toMatch(/\d/);
  });
});

describe('cgroupEventsDeltaSchema（版ずれへの備え。#1517）', () => {
  it('両方の欄が無い `{}` も受け入れる（構造上のゆるさで、生成側は空を送らない）', () => {
    const parsed = cgroupEventsDeltaSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('片方だけの欄も受け入れる', () => {
    const parsed = cgroupEventsDeltaSchema.safeParse({ pidsMaxDelta: 1 });
    expect(parsed.success).toBe(true);
  });

  it('負の値は拒む（累計は減らない）', () => {
    const parsed = cgroupEventsDeltaSchema.safeParse({ pidsMaxDelta: -1 });
    expect(parsed.success).toBe(false);
  });
});
