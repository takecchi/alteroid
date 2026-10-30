import { afterEach, describe, expect, it } from 'vitest';

import { resolveBashShapeGuard } from './bash-guard-mode.js';
import { resolveRefusalAutoReopen } from './clone-refusal.js';
import { CLONE_HUMAN_PRIORITY_ENV_KEY, resolveCloneHumanPriority } from './clone.js';
import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import {
  clearTokenSavingNotesForTesting,
  resolveTokenSavingExcerpt,
} from './token-saving-switches.js';
import { resolveMemoryGuard } from './tools.js';

// 環境変数の on/off の読み方（5か所）の、受け付ける綴りと、知らない綴り・空・空白だけの扱いを縛る。
// 「揃えて変わる所」は新しい形で縛る（寄せる前のコードでは落ちる）。

afterEach(() => {
  clearRecentTracesForTesting();
  clearTokenSavingNotesForTesting();
});

const ON = ['on', '1', 'true', 'yes', 'enabled', 'ON', ' True ', '\t1\n'];
const OFF = ['off', '0', 'false', 'no', 'disabled', 'OFF', ' False ', '\t0\n'];

describe('クローンの人間優先（ALTEROID_CLONE_HUMAN_PRIORITY。既定は有効）', () => {
  const resolve = (raw: string | undefined): boolean =>
    resolveCloneHumanPriority({ [CLONE_HUMAN_PRIORITY_ENV_KEY]: raw });

  it.each(['0', 'false', 'off', 'no', 'OFF', ' False '])('無効の綴り %j（今のまま）', (raw) => {
    expect(resolve(raw)).toBe(false);
  });

  it.each(['on', '1', 'true', 'yes', 'enabled'])('有効の綴り %j（今のまま）', (raw) => {
    expect(resolve(raw)).toBe(true);
  });

  it.each([undefined, '', '   '])('未設定・空・空白は既定の有効（今のまま）%j', (raw) => {
    expect(resolve(raw)).toBe(true);
    expect(recentDroppedTraces()).toHaveLength(0);
  });

  it('知らない綴りは既定の有効のまま（今のまま）', () => {
    expect(resolve('maybe')).toBe(true);
  });

  // 揃って変わる所
  it('disabled は無効（前は知らない綴りとして有効のままだった）', () => {
    expect(resolve('disabled')).toBe(false);
    expect(resolve(' Disabled ')).toBe(false);
  });

  it('知らない綴りは stderr に1回だけ知らせる（前は黙っていた）', () => {
    expect(resolve('maybe')).toBe(true);
    expect(resolve('maybe')).toBe(true);
    const traces = recentDroppedTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain(CLONE_HUMAN_PRIORITY_ENV_KEY);
  });
});

describe('拒否の自動の開き直し（ALTEROID_REFUSAL_AUTO_REOPEN。既定は有効）', () => {
  const resolve = (raw: string | undefined) =>
    resolveRefusalAutoReopen({ ALTEROID_REFUSAL_AUTO_REOPEN: raw });

  it.each(OFF)('無効の綴り %j', (raw) => {
    expect(resolve(raw)).toEqual({ enabled: false });
  });

  it.each(ON)('有効の綴り %j', (raw) => {
    expect(resolve(raw)).toEqual({ enabled: true });
  });

  it.each([undefined, '', '   '])('未設定・空・空白は既定の有効 %j', (raw) => {
    expect(resolve(raw)).toEqual({ enabled: true });
  });

  it('知らない綴りは有効のまま、小文字にした綴りを返す（投げない）', () => {
    expect(resolve(' Maybe ')).toEqual({ enabled: true, unrecognized: 'maybe' });
  });
});

describe('トークン節約（ALTEROID_TOKEN_SAVING_EXCERPT。既定は有効）', () => {
  const resolve = (raw: string | undefined): boolean =>
    resolveTokenSavingExcerpt({ ALTEROID_TOKEN_SAVING_EXCERPT: raw });

  it.each(['on', '1', 'true', 'ON', ' True '])('有効の綴り %j（今のまま）', (raw) => {
    expect(resolve(raw)).toBe(true);
  });

  it.each(['off', '0', 'false', 'OFF', ' False '])('無効の綴り %j（今のまま）', (raw) => {
    expect(resolve(raw)).toBe(false);
  });

  it('知らない綴りは既定へ倒し、痕跡を1回だけ残す（今のまま）', () => {
    expect(resolve('maybe')).toBe(true);
    expect(resolve('maybe')).toBe(true);
    expect(recentDroppedTraces()).toHaveLength(1);
  });

  // 揃って変わる所
  it.each(['yes', 'enabled'])('有効の綴り %j が増える（前は知らない綴りで既定）', (raw) => {
    expect(resolve(raw)).toBe(true);
    expect(recentDroppedTraces()).toHaveLength(0);
  });

  it.each(['no', 'disabled'])('無効の綴り %j が増える（前は知らない綴りで既定の有効）', (raw) => {
    expect(resolve(raw)).toBe(false);
    expect(recentDroppedTraces()).toHaveLength(0);
  });
});

describe('門（寄せない。厳密な列挙のまま。綴り違いは落とす）', () => {
  it('メモリの歯: on / off と、未設定・空・空白は既定の on', () => {
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: 'off' })).toBe('off');
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: ' on ' })).toBe('on');
    expect(resolveMemoryGuard({})).toBe('on');
    expect(resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: '  ' })).toBe('on');
  });

  it.each(['OFF', 'false', '0', 'no', 'disabled'])('メモリの歯: %j は落とす（外れない）', (raw) => {
    expect(() => resolveMemoryGuard({ ALTEROID_MEMORY_GUARD: raw })).toThrow(/不正/);
  });

  it('Bash の形の歯: on / off と、未設定・空は既定の off', () => {
    expect(resolveBashShapeGuard({ ALTEROID_BASH_SHAPE_GUARD: 'on' })).toBe('on');
    expect(resolveBashShapeGuard({ ALTEROID_BASH_SHAPE_GUARD: ' off ' })).toBe('off');
    expect(resolveBashShapeGuard({})).toBe('off');
    expect(resolveBashShapeGuard({ ALTEROID_BASH_SHAPE_GUARD: '' })).toBe('off');
  });

  it.each(['ON', 'true', '1', 'yes'])('Bash の形の歯: %j は落とす', (raw) => {
    expect(() => resolveBashShapeGuard({ ALTEROID_BASH_SHAPE_GUARD: raw })).toThrow(/不正/);
  });
});
