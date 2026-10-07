import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  compareRequiredStatusChecks,
  contextsFromProtection,
  contextsFromRules,
  formatComparison,
  isBranchNotProtected,
  resolveLiveRequiredChecks,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-required-status-checks-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Comparison {
  verdict: 'match' | 'drift' | 'unreadable';
  declared: string[];
  live?: string[];
  missing?: string[];
  extra?: string[];
  disagreement?: { contexts: string[]; checks: string[] } | null;
}

function protectionWith(names: string[], checkNames: string[] = names): unknown {
  return {
    required_status_checks: {
      strict: false,
      contexts: names,
      checks: checkNames.map((context) => ({ context, app_id: 15368 })),
    },
  };
}

const declaration = JSON.parse(
  readFileSync(path.join(ROOT, '.github/required-status-checks.json'), 'utf8'),
) as { contexts?: unknown; observedAt?: unknown };

describe('宣言の形（.github/required-status-checks.json）', () => {
  it('contexts が文字列の配列である', () => {
    expect(Array.isArray(declaration.contexts)).toBe(true);
    for (const name of declaration.contexts as unknown[]) {
      expect(typeof name).toBe('string');
    }
  });

  it('observedAt を持つ（いつ測った写しなのかが値自身から取れる）', () => {
    expect(typeof declaration.observedAt).toBe('string');
    expect(Number.isNaN(Date.parse(declaration.observedAt as string))).toBe(false);
  });
});

describe('protection の応答から required contexts を取り出す', () => {
  it('contexts と checks が揃っていれば取り出せる', () => {
    expect(contextsFromProtection(protectionWith(['ci', 'image']))).toEqual({
      names: ['ci', 'image'],
      disagreement: null,
    });
  });

  it('並び順が違っても同じものとして扱う（GitHub は順序を約束していない）', () => {
    expect(contextsFromProtection(protectionWith(['image', 'ci']))?.names).toEqual(['ci', 'image']);
  });

  it('contexts と checks が食い違っていたら、その食い違い自体を報告する', () => {
    const result = contextsFromProtection(protectionWith(['ci'], ['ci', 'image'])) as {
      names: string[];
      disagreement: { contexts: string[]; checks: string[] } | null;
    };
    expect(result.names).toEqual(['ci', 'image']);
    expect(result.disagreement).toEqual({ contexts: ['ci'], checks: ['ci', 'image'] });
  });

  it('required_status_checks が無ければ null（＝読めなかった）を返す', () => {
    expect(contextsFromProtection({})).toBeNull();
    expect(contextsFromProtection(null)).toBeNull();
  });

  it('required が空でも null にはしない（空は空という事実である）', () => {
    expect(contextsFromProtection(protectionWith([]))).toEqual({ names: [], disagreement: null });
  });
});

describe('宣言と protection の突き合わせ', () => {
  it('一致していれば match', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'image'])),
    ) as Comparison;
    expect(result.verdict).toBe('match');
    expect(formatComparison(result)).toContain('OK');
  });

  it('protection 側に増えていたら drift（宣言に無い側を名指しする）', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'image', 'lint'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.extra).toEqual(['lint']);
    expect(formatComparison(result)).toContain('protection に在って宣言に無い: lint');
  });

  it('protection 側から消えていたら drift（宣言に在る側を名指しする）', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.missing).toEqual(['image']);
    expect(formatComparison(result)).toContain('宣言に在って protection に無い: image');
  });

  it('名前が入れ替わっていたら、両方向を同時に名指しする', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'build'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.missing).toEqual(['image']);
    expect(result.extra).toEqual(['build']);
  });

  it('読めなかったら unreadable。match にも drift にもしない', () => {
    const result = compareRequiredStatusChecks(['ci', 'image'], null) as Comparison;
    expect(result.verdict).toBe('unreadable');
    const text = formatComparison(result);
    expect(text).toContain('判定できなかった');
    expect(text).toContain('これは「ずれていない」ではない');
    // 素の `OK` で見ない: 本文が `GITHUB_TOKEN` を含み `OK` の2文字が常に当たるため、接頭辞で見る。
    expect(text).not.toContain('OK — ');
    expect(text.startsWith('check-required-status-checks: 判定できなかった')).toBe(true);
  });
});

describe('赤の意味が、失敗の文そのものに書いてある', () => {
  it('drift の文は、どちらが正しいかを決めつけず「決める必要がある」と言う', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'])),
    ) as Comparison;
    const text = formatComparison(result);

    expect(text).toContain('【赤の意味】');
    expect(text).toContain('どちらが正しいかは、この検査には決められない');
    expect(text).toContain('どちらを直すかを人間が決めること');
    expect(text).toContain('宣言: ci / image');
    expect(text).toContain('protection: ci');
    expect(text).toContain('.github/required-status-checks.json');
    expect(text).toContain('リポジトリの設定');
  });

  it('contexts と checks の食い違いは、宣言を直す前にそちらを見ろと言う', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'], ['ci', 'image'])),
    ) as Comparison;
    const text = formatComparison(result);
    expect(text).toContain('contexts と checks が食い違っている');
    expect(text).toContain('宣言を直す前にそちらを見ること');
  });
});

const NOT_PROTECTED = { status: 'absent' } as const;
const rulesBody = (names: string[]): unknown => [
  { type: 'deletion', ruleset_id: 1 },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: names.map((context) => ({ context, integration_id: 15368 })),
    },
    ruleset_id: 24535054,
  },
];
const okRules = (names: string[]) => ({ status: 'ok', body: rulesBody(names) }) as const;
const okProtection = (names: string[]) => ({ status: 'ok', body: protectionWith(names) }) as const;
const DECLARED = ['ci', 'image', 'no-attribution-trailers'];

function verdictOf(protection: unknown, rules: unknown): Comparison & { reasons?: string[] } {
  const { live, reasons } = resolveLiveRequiredChecks(protection, rules);
  return compareRequiredStatusChecks(DECLARED, live, reasons);
}

describe('ruleset 由来の required を読む（#3052）', () => {
  it('rules/branches の応答から required_status_checks の context だけを取り出す', () => {
    expect(contextsFromRules(rulesBody(['image', 'ci']))).toEqual({ names: ['ci', 'image'] });
  });

  it('required_status_checks の規則が無い配列は空（読めた事実）。配列でなければ null', () => {
    expect(contextsFromRules([{ type: 'deletion' }])).toEqual({ names: [] });
    expect(contextsFromRules({ message: 'Not Found' })).toBeNull();
    expect(contextsFromRules(null)).toBeNull();
  });

  it('複数の ruleset が required を持てば和をとる（重複は1つにする）', () => {
    const rules = [
      ...(rulesBody(['ci']) as unknown[]),
      ...(rulesBody(['ci', 'image']) as unknown[]),
    ];
    expect(contextsFromRules(rules)).toEqual({ names: ['ci', 'image'] });
  });

  it('404 の見分け: 「Branch not protected」を伴う 404 だけが未保護。別の 404・403 は違う', () => {
    expect(isBranchNotProtected('gh: Branch not protected (HTTP 404)')).toBe(true);
    expect(isBranchNotProtected('gh: Not Found (HTTP 404)')).toBe(false);
    expect(isBranchNotProtected('gh: Resource not accessible by integration (HTTP 403)')).toBe(
      false,
    );
  });

  it('ruleset だけ（protection は 404）で宣言と一致すれば match。空とのずれにも読めなかったにもしない', () => {
    const result = verdictOf(NOT_PROTECTED, okRules(DECLARED));
    expect(result.verdict).toBe('match');
    const text = formatComparison(result);
    expect(text).toContain('OK — ');
    expect(text).toContain('未保護（404 Branch not protected）');
  });

  it('protection 404 で ruleset が宣言より少なければ drift（404 のせいで緑にならない）', () => {
    const result = verdictOf(NOT_PROTECTED, okRules(['ci', 'image']));
    expect(result.verdict).toBe('drift');
    expect(result.missing).toEqual(['no-attribution-trailers']);
  });

  it('protection 404 で ruleset にも required が無ければ drift（空は空という事実）', () => {
    const result = verdictOf(NOT_PROTECTED, { status: 'ok', body: [{ type: 'deletion' }] });
    expect(result.verdict).toBe('drift');
    expect(result.live).toEqual([]);
  });

  it('protection と ruleset の両方に在れば和をとる（片方だけでは足りない分を補い合う）', () => {
    expect(
      verdictOf(okProtection(['ci', 'image']), okRules(['no-attribution-trailers'])).verdict,
    ).toBe('match');
    const extra = verdictOf(
      okProtection(['ci', 'image', 'lint']),
      okRules(['no-attribution-trailers']),
    );
    expect(extra.verdict).toBe('drift');
    expect(extra.extra).toEqual(['lint']);
  });

  it('両方が同じ名前を持っていても一致（重複は1つ）', () => {
    expect(verdictOf(okProtection(DECLARED), okRules(DECLARED)).verdict).toBe('match');
  });

  it('protection が 403 など（404 以外）で読めなければ unreadable。ruleset が一致していても緑にしない', () => {
    const result = verdictOf(
      { status: 'error', detail: 'gh: Resource not accessible (HTTP 403)' },
      okRules(DECLARED),
    );
    expect(result.verdict).toBe('unreadable');
    const text = formatComparison(result);
    expect(text).toContain('旧来の protection: 読めなかった');
    expect(text).toContain('HTTP 403');
    expect(text).not.toContain('OK — ');
  });

  it('ruleset が読めなければ unreadable（protection 404 を「空」とみなして drift にもしない）', () => {
    const result = verdictOf(NOT_PROTECTED, {
      status: 'error',
      detail: 'gh: Server Error (HTTP 500)',
    });
    expect(result.verdict).toBe('unreadable');
    expect(formatComparison(result)).toContain('ruleset（rules/branches）: 読めなかった');
  });

  it('両方読めなければ、両方の理由を並べる', () => {
    const result = verdictOf(
      { status: 'error', detail: 'HTTP 403' },
      { status: 'error', detail: 'HTTP 500' },
    );
    expect(result.verdict).toBe('unreadable');
    const text = formatComparison(result);
    expect(text).toContain('HTTP 403');
    expect(text).toContain('HTTP 500');
  });

  it('ruleset の応答が規則の配列でなければ unreadable', () => {
    expect(verdictOf(NOT_PROTECTED, { status: 'ok', body: { message: 'x' } }).verdict).toBe(
      'unreadable',
    );
  });
});
