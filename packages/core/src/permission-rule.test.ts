import { describe, expect, it } from 'vitest';

import {
  containsShellMetacharacters,
  describePermissionRuleBreadth,
  matchPermissionRule,
  parsePermissionRule,
  validatePermissionRequest,
} from './permission-rule.js';

describe('parsePermissionRule', () => {
  it('完全一致（Bash(<文字列>)）を解く', () => {
    const parsed = parsePermissionRule('Bash(gh pr view)');
    expect(parsed).toEqual({ ok: true, kind: 'exact', command: 'gh pr view' });
  });

  it('前方一致（Bash(<文字列>:*)）を解く', () => {
    const parsed = parsePermissionRule('Bash(gh release edit:*)');
    expect(parsed).toEqual({ ok: true, kind: 'prefix', command: 'gh release edit' });
  });

  it('Bash(...) の形でなければ不正', () => {
    expect(parsePermissionRule('gh pr view').ok).toBe(false);
    expect(parsePermissionRule('bash(gh pr view)').ok).toBe(false);
    expect(parsePermissionRule('Bash[gh pr view]').ok).toBe(false);
  });

  it('中身が空なら不正', () => {
    expect(parsePermissionRule('Bash()').ok).toBe(false);
    expect(parsePermissionRule('Bash(:*)').ok).toBe(false);
  });

  it.each([
    ['セミコロン', 'Bash(gh pr view; rm -rf /)'],
    ['&', 'Bash(gh pr view && rm -rf /)'],
    ['パイプ', 'Bash(gh pr view | cat)'],
    ['ドル記号', 'Bash(echo $HOME)'],
    ['バッククォート', 'Bash(echo `whoami`)'],
    ['丸括弧', 'Bash(echo (a))'],
    ['不等号 <', 'Bash(echo a < b)'],
    ['不等号 >', 'Bash(echo a > b)'],
    ['改行', `Bash(echo a${'\n'}b)`],
    ['CR', `Bash(echo a${'\r'}b)`],
    ['バックスラッシュ', 'Bash(echo a\\ b)'],
  ])('規則の中身に区切り・展開文字（%s）を含むと不正', (_label, rule) => {
    expect(parsePermissionRule(rule).ok).toBe(false);
  });
});

describe('containsShellMetacharacters', () => {
  it.each([';', '&', '|', '$', '`', '(', ')', '<', '>', '\\', '\n', '\r'])(
    '%s を含む文字列は真',
    (ch) => {
      expect(containsShellMetacharacters(`gh pr view${ch}x`)).toBe(true);
    },
  );

  it('区切り文字を含まない普通のコマンドは偽', () => {
    expect(containsShellMetacharacters('gh release edit --draft')).toBe(false);
  });
});

describe('matchPermissionRule', () => {
  it('完全一致は、ちょうど同じ文字列にだけ一致する', () => {
    expect(matchPermissionRule('Bash(gh pr view)', 'gh pr view')).toBe(true);
    expect(matchPermissionRule('Bash(gh pr view)', 'gh pr view extra')).toBe(false);
    expect(matchPermissionRule('Bash(gh pr view)', 'gh pr vie')).toBe(false);
  });

  it('前方一致は、規則そのものと、後ろに空白＋語が続く形に一致する', () => {
    expect(matchPermissionRule('Bash(gh release edit:*)', 'gh release edit')).toBe(true);
    expect(matchPermissionRule('Bash(gh release edit:*)', 'gh release edit --draft')).toBe(true);
  });

  it('前方一致は語境界で切る——続く語の一部には一致しない', () => {
    expect(matchPermissionRule('Bash(gh release edit:*)', 'gh release editfoo')).toBe(false);
  });

  it('コマンド側が区切り・展開文字を持てば、規則が何であれ一致しない', () => {
    expect(matchPermissionRule('Bash(gh release edit:*)', 'gh release edit; rm -rf /')).toBe(false);
    expect(matchPermissionRule('Bash(gh release edit:*)', 'gh release edit && rm -rf /')).toBe(
      false,
    );
    expect(matchPermissionRule('Bash(gh pr view)', 'gh pr view; echo done')).toBe(false);
  });

  it('規則が不正なら常に不一致', () => {
    expect(matchPermissionRule('gh pr view', 'gh pr view')).toBe(false);
    expect(matchPermissionRule('Bash()', 'anything')).toBe(false);
  });
});

describe('validatePermissionRequest', () => {
  const BASE = {
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit', 'gh release edit --draft'],
    denies: ['gh release edit; rm -rf /'],
  };

  it('allows が全部通り denies が1件も通らないなら合格', () => {
    expect(validatePermissionRequest(BASE)).toEqual({ ok: true });
  });

  it('denies が空なら拒否', () => {
    const result = validatePermissionRequest({ ...BASE, denies: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('denies');
  });

  it('allows が空なら拒否', () => {
    const result = validatePermissionRequest({ ...BASE, allows: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('allows');
  });

  it('allows の例が規則に一致しないなら拒否', () => {
    const result = validatePermissionRequest({ ...BASE, allows: ['gh issue edit'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('gh issue edit');
  });

  it('denies の例が規則に一致してしまうなら拒否', () => {
    const result = validatePermissionRequest({ ...BASE, denies: ['gh release edit --draft'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('gh release edit --draft');
  });

  it('規則そのものが不正なら拒否', () => {
    const result = validatePermissionRequest({ ...BASE, rule: 'gh release edit' });
    expect(result.ok).toBe(false);
  });
});

describe('describePermissionRuleBreadth', () => {
  it('完全一致は常に exact（先頭語数を持たない）', () => {
    expect(describePermissionRuleBreadth('Bash(gh pr view)')).toEqual({ level: 'exact' });
  });

  it('前方一致は、固定された先頭の語数が多いほど狭い（Issue #863 の例: gh pr merge / gh / *）', () => {
    // `Bash(gh pr merge:*)` 相当（3語）——issue が「狭い」側の例として挙げた形。
    expect(describePermissionRuleBreadth('Bash(gh pr merge:*)')).toEqual({
      level: 'narrow',
      prefixWordCount: 3,
    });
    // `Bash(gh *)` 相当（このリポジトリの書式では `Bash(gh:*)`。1語）——
    // issue が「広い」側の例として挙げた形。
    expect(describePermissionRuleBreadth('Bash(gh:*)')).toEqual({
      level: 'broad',
      prefixWordCount: 1,
    });
  });

  it('2語の前方一致は medium', () => {
    expect(describePermissionRuleBreadth('Bash(gh release:*)')).toEqual({
      level: 'medium',
      prefixWordCount: 2,
    });
  });

  it('境界値: 3語で narrow、2語で medium、1語で broad', () => {
    expect(describePermissionRuleBreadth('Bash(a b c:*)').level).toBe('narrow');
    expect(describePermissionRuleBreadth('Bash(a b:*)').level).toBe('medium');
    expect(describePermissionRuleBreadth('Bash(a:*)').level).toBe('broad');
  });

  it('語数の多い前方一致（4語以上）も narrow のまま（narrow は下限であって上限ではない）', () => {
    expect(describePermissionRuleBreadth('Bash(gh release edit --draft:*)')).toEqual({
      level: 'narrow',
      prefixWordCount: 4,
    });
  });

  it('不正な規則は invalid（黙って broad 等に倒さない）', () => {
    expect(describePermissionRuleBreadth('gh pr view')).toEqual({ level: 'invalid' });
    expect(describePermissionRuleBreadth('Bash()')).toEqual({ level: 'invalid' });
    expect(describePermissionRuleBreadth('Bash(gh pr view; rm -rf /)')).toEqual({
      level: 'invalid',
    });
  });

  it('matchPermissionRule と同じ語境界の意味論を使う——連続する空白も1つの区切りとして数える', () => {
    // parsePermissionRule はここで空白を畳まないが、split(/\s+/) 側で畳んで
    // 数えるので、見た目上の語数と一致する。
    expect(describePermissionRuleBreadth('Bash(gh  release:*)')).toEqual({
      level: 'medium',
      prefixWordCount: 2,
    });
  });
});
