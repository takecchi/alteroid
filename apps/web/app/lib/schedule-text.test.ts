import { describe, expect, it } from 'vitest';

import { describeScheduleText } from './schedule-text';

describe('describeScheduleText', () => {
  it('queued / needs_decision と 発意 tick を画面の言葉にする', () => {
    expect(
      describeScheduleText(
        '60 分ごとに確かめ、動ける仕事（待ち行列の queued / needs_decision・旧台帳の未了）があるときと、直近24時間に発意 tick を回していないときだけ',
      ),
    ).toBe(
      '60 分ごとに確かめ、動ける仕事（待ち行列の順番待ち・判断待ち・旧台帳の未了）があるときと、直近24時間に発意のターンを回していないときだけ',
    );
  });

  it('当たらない文はそのまま返す', () => {
    expect(describeScheduleText('毎朝の日報')).toBe('毎朝の日報');
  });
});
