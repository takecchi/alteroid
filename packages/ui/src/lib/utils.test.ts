import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clsx } from 'clsx';
import {
  createTailwindMerge,
  getDefaultConfig,
  twMerge as fullTwMerge,
  type Config,
} from 'tailwind-merge';
import { describe, expect, it } from 'vitest';

import { cn, tailwindMergeConfig } from './utils';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

const SCAN_ROOTS = ['packages/ui/src', 'apps/web/app', 'packages/logic/src', 'packages/swr/src'];
// この設定自身とこのテストは走査しない: 設定の語彙が「使われている」ことにならないため
const SCAN_EXCLUDE = new Set(['packages/ui/src/lib/utils.ts', 'packages/ui/src/lib/utils.test.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((root) => sourceFiles(path.join(repoRoot, root))).filter(
  (file) => !SCAN_EXCLUDE.has(path.relative(repoRoot, file).split(path.sep).join('/')),
);
const sources = files.map((file) => readFileSync(file, 'utf8'));

function candidateTokens(text: string): string[] {
  const out: string[] = [];
  for (const separators of [/[\s"'`]+/, /[\s"'`{}<>;,=]+/, /[\s`{}<>;,=]+/, /[\s"'`{}<>;,=()]+/]) {
    for (const raw of text.split(separators)) {
      const piece = raw.replace(/^["'`]+|["'`]+$/g, '');
      if (!piece) continue;
      out.push(piece);
      const trimmed = piece.replace(/^[.:!(]+|[.,:;)]+$/g, '');
      if (trimmed && trimmed !== piece) out.push(trimmed);
    }
  }
  return out;
}

function endsWithDash(base: string): boolean {
  let end = base.length;
  const open = { ')': 0, ']': 0 };
  for (const ch of base) {
    if (ch === '(') open[')'] += 1;
    else if (ch === '[') open[']'] += 1;
  }
  const closed = { ')': 0, ']': 0 };
  for (const ch of base) {
    if (ch === ')' || ch === ']') closed[ch] += 1;
  }
  while (end > 0) {
    const ch = base[end - 1];
    if (ch === '.' || ch === ',' || ch === ':' || ch === ';') end -= 1;
    else if ((ch === ')' || ch === ']') && closed[ch] > open[ch]) {
      closed[ch] -= 1;
      end -= 1;
    } else break;
  }
  return base[end - 1] === '-';
}

// `-` で終わる本体は空文字を返して候補から外す: Tailwind v4 はそれを class と認めず、走査は文脈を見ないので `to--;` のようなデクリメントが `to-*` のグループに当たるため
function baseClass(token: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === ':' && depth === 0) start = i + 1;
  }
  let base = token.slice(start);
  if (base.startsWith('!')) base = base.slice(1);
  if (base.endsWith('!')) base = base.slice(0, -1);
  if (endsWithDash(base)) return '';
  return base;
}

const allTokens = new Set<string>();
for (const text of sources) for (const token of candidateTokens(text)) allTokens.add(token);
const baseTokens = new Set<string>();
for (const token of allTokens) {
  const base = baseClass(token);
  if (base) baseTokens.add(base);
}

const fullConfig: Config<string, string> = getDefaultConfig();
const fullGroupIds = Object.keys(fullConfig.classGroups);
const slimGroupIds = new Set(Object.keys(tailwindMergeConfig.classGroups));

// グループを挙動（探り針）で測る: tailwind-merge は class 本体の属するグループを公開していないため
const probeBits = Math.ceil(Math.log2(fullGroupIds.length + 1));
const probeClasses = Array.from({ length: probeBits }, (_, bit) => `zzprobe${bit}`);
const probeMerge = (() => {
  const classGroups: Config<string, string>['classGroups'] = { ...fullConfig.classGroups };
  const conflictingClassGroups: Config<string, string>['conflictingClassGroups'] = {
    ...fullConfig.conflictingClassGroups,
  };
  probeClasses.forEach((probe, bit) => {
    classGroups[`probe${bit}`] = [probe];
  });
  fullGroupIds.forEach((id, index) => {
    const number = index + 1;
    const bits = probeClasses.flatMap((_, bit) => (number & (1 << bit) ? [`probe${bit}`] : []));
    conflictingClassGroups[id] = [...(fullConfig.conflictingClassGroups[id] ?? []), ...bits];
  });
  return { classGroups, conflictingClassGroups };
})();
const probeTwMerge = createTailwindMerge(() => ({ ...fullConfig, ...probeMerge }));
const probePrefix = probeClasses.join(' ');

function fullGroupOf(baseToken: string): string | undefined {
  const kept = new Set(probeTwMerge(`${probePrefix} ${baseToken}`).split(' '));
  let number = 0;
  probeClasses.forEach((probe, bit) => {
    if (!kept.has(probe)) number |= 1 << bit;
  });
  return number === 0 ? undefined : fullGroupIds[number - 1];
}

const groupTokens = new Map<string, string[]>();
for (const base of baseTokens) {
  const group = fullGroupOf(base);
  if (group === undefined) continue;
  const list = groupTokens.get(group) ?? [];
  list.push(base);
  groupTokens.set(group, list);
}

describe('cn の tailwind-merge 設定（slim）', () => {
  it('走査が空の集合で緑にならない（token・グループの下限）', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(allTokens.size).toBeGreaterThan(10000);
    expect(groupTokens.size).toBeGreaterThan(100);
    expect(fullGroupOf('px-4')).toBe('px');
    expect(fullGroupOf('-mt-2')).toBe('mt');
    expect(fullGroupOf('text-sm')).toBe('font-size');
    expect(fullGroupOf('text-muted-foreground')).toBe('text-color');
    expect(fullGroupOf('not-a-tailwind-class')).toBeUndefined();
  });

  describe('走査: コードを class と誤検出しない（#2350）', () => {
    const groupsOf = (code: string): (string | undefined)[] =>
      candidateTokens(code)
        .map(baseClass)
        .filter(Boolean)
        .map(fullGroupOf)
        .filter((group) => group !== undefined);

    it('`to--;` `from--` `via--` のようなデクリメントは、どのグループにも当たらない', () => {
      expect(groupsOf('to--;')).toEqual([]);
      expect(groupsOf('while (to--) { from--; via-- }')).toEqual([]);
      expect(groupsOf('const x = [to--, from--, via--];')).toEqual([]);
    });

    it('対照: 本物の class は今までどおり拾う', () => {
      const groups = groupsOf(
        '<div className="to-red-500 from-blue-500 via-green-500 -mt-2 p-4!" />',
      );
      expect(groups).toEqual(
        expect.arrayContaining(['gradient-to', 'gradient-from', 'gradient-via', 'mt', 'p']),
      );
      expect(groupsOf("cn('to-[#fff]', `from-(--x)`)")).toEqual(
        expect.arrayContaining(['gradient-to', 'gradient-from']),
      );
    });
  });

  it('使われている class のグループが slim に在る', () => {
    const missing = [...groupTokens]
      .filter(([group]) => !slimGroupIds.has(group))
      .map(([group, tokens]) => `  ${group}: ${tokens.slice(0, 5).join(' ')}`);
    expect(
      missing,
      [
        'repo が使っている class のグループが、cn の slim 設定（packages/ui/src/lib/utils.ts の',
        'tailwindMergeConfig）に無い。**このままだと cn がその class の衝突を解かなくなる。**',
        '足すもの: 下のグループの定義を tailwind-merge の getDefaultConfig() の classGroups',
        '（node_modules/tailwind-merge/dist/bundle-mjs.mjs）から同じ並びの位置へ写し、必要なら',
        'conflictingClassGroups の該当の行も写す。使う scale* / theme が utils.ts に無ければ足す。',
        '**足す前に、例の class が本当に class か確かめる** — 走査は文脈を見ないので `to--;` のようなコードも拾う（#2350）。',
        '確かめ方: 例の token を grep -rn で探し、class の文字列の中か（コードの式でないか）を見る。誤検出なのに足すと、使わないグループが bundle に戻る。',
        '(グループ: 例の class)',
      ].join('\n'),
    ).toEqual([]);
  });

  describe('構造: 既定から1文字も変えずに写されている', () => {
    // 参照ではなく themeKey で比べる: `fromTheme` が毎回新しい関数を作るため
    const normalize = (value: unknown): unknown => {
      if (typeof value === 'function') {
        const getter = value as { isThemeGetter?: boolean; themeKey?: string };
        return getter.isThemeGetter ? `theme:${getter.themeKey}` : value;
      }
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, inner]) => [key, normalize(inner)]),
        );
      }
      return value;
    };

    it('classGroups: slim の各グループが既定と同じで、並びも同じ', () => {
      const slimIds = Object.keys(tailwindMergeConfig.classGroups);
      expect(slimIds.filter((id) => !fullGroupIds.includes(id))).toEqual([]);
      expect(slimIds).toEqual(fullGroupIds.filter((id) => slimGroupIds.has(id)));
      for (const id of slimIds) {
        expect(normalize(tailwindMergeConfig.classGroups[id]), id).toEqual(
          normalize(fullConfig.classGroups[id]),
        );
      }
    });

    it('conflictingClassGroups: slim のグループ同士の分が、過不足なく既定と同じ', () => {
      const expected: Record<string, string[]> = {};
      for (const [id, targets] of Object.entries(fullConfig.conflictingClassGroups)) {
        if (!slimGroupIds.has(id)) continue;
        const kept = (targets ?? []).filter((target) => slimGroupIds.has(target));
        if (kept.length > 0) expected[id] = kept;
      }
      expect(tailwindMergeConfig.conflictingClassGroups).toEqual(expected);
    });

    it('conflictingClassGroupModifiers / orderSensitiveModifiers / cacheSize: 既定と同じ', () => {
      expect(tailwindMergeConfig.conflictingClassGroupModifiers).toEqual(
        Object.fromEntries(
          Object.entries(fullConfig.conflictingClassGroupModifiers).filter(([id]) =>
            slimGroupIds.has(id),
          ),
        ),
      );
      expect(tailwindMergeConfig.orderSensitiveModifiers).toEqual(
        fullConfig.orderSensitiveModifiers,
      );
      expect(tailwindMergeConfig.cacheSize).toBe(fullConfig.cacheSize);
    });

    it('postfixLookupClassGroups: 既定のうち slim に在るグループだけ', () => {
      expect(tailwindMergeConfig.postfixLookupClassGroups).toEqual(
        (fullConfig.postfixLookupClassGroups ?? []).filter((id) => slimGroupIds.has(id)),
      );
    });

    it('theme: slim が持つキーは既定と同じ。使うグループが引くキーは全部在る', () => {
      const slimTheme = tailwindMergeConfig.theme as Record<string, unknown>;
      const fullTheme = fullConfig.theme as Record<string, unknown>;
      for (const [key, value] of Object.entries(slimTheme)) {
        expect(normalize(value), key).toEqual(normalize(fullTheme[key]));
      }
      const used = new Set<string>();
      const collect = (value: unknown): void => {
        if (typeof value === 'function') {
          const getter = value as { isThemeGetter?: boolean; themeKey?: string };
          if (getter.isThemeGetter && getter.themeKey) used.add(getter.themeKey);
        } else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      collect(tailwindMergeConfig.classGroups);
      expect([...used].filter((key) => !(key in slimTheme))).toEqual([]);
    });
  });

  describe('差分: 既定の twMerge と cn が完全に一致する', { timeout: 180_000 }, () => {
    const expectSame = (corpus: Iterable<string>, label: string): number => {
      let count = 0;
      const mismatches: string[] = [];
      for (const input of corpus) {
        count += 1;
        const expected = fullTwMerge(clsx(input));
        const actual = cn(input);
        if (actual !== expected && mismatches.length < 10) {
          mismatches.push(`${input}\n    既定: ${expected}\n    slim: ${actual}`);
        }
      }
      expect(mismatches, `${label}: 既定と結果が違う入力`).toEqual([]);
      return count;
    };

    const literals = new Set<string>();
    const callArgs = new Set<string>();
    for (const text of sources) {
      for (const match of text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g)) {
        const body = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
        if (body.trim().length > 0) literals.add(body);
      }
      for (const call of text.matchAll(/\bcn\(/g)) {
        let depth = 1;
        let i = (call.index ?? 0) + call[0].length;
        const begin = i;
        while (i < text.length && depth > 0) {
          if (text[i] === '(') depth += 1;
          else if (text[i] === ')') depth -= 1;
          i += 1;
        }
        const args = text.slice(begin, i - 1);
        const parts = [...args.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g)].map((m) =>
          (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '),
        );
        if (parts.length > 0) callArgs.add(parts.join(' '));
      }
    }

    it('repo の文字列リテラルと、cn(...) の引数のリテラルを連ねたもの', () => {
      expect(callArgs.size).toBeGreaterThan(200);
      expect(literals.size).toBeGreaterThan(1000);
      expectSame(literals, 'リテラル');
      expectSame(callArgs, 'cn の引数');
      const list = [...callArgs];
      const adjacent: string[] = [];
      for (let i = 0; i + 1 < list.length; i += 1) {
        adjacent.push(`${list[i]} ${list[i + 1]}`, `${list[i + 1]} ${list[i]}`);
      }
      expectSame(adjacent, '隣り合う cn の引数');
    });

    const representatives: string[] = [];
    for (const [group, tokens] of groupTokens) {
      if (!slimGroupIds.has(group)) continue;
      const sorted = [...new Set(tokens)]
        .filter((token) => !token.startsWith('zzprobe'))
        .sort((a, b) => a.length - b.length);
      const pick = new Set<string>(sorted.slice(0, 1).concat(sorted.slice(-1)));
      const arbitrary = sorted.find((token) => /[[(]/.test(token));
      if (arbitrary) pick.add(arbitrary);
      const slash = sorted.find((token) => token.includes('/'));
      if (slash) pick.add(slash);
      for (const token of pick) representatives.push(token);
    }
    const synthetic = [
      'p-[3px]',
      'px-[var(--x)]',
      'py-(--y)',
      'pt-px',
      'pl-0.5',
      'm-auto',
      '-mx-4',
      '-mt-1',
      'mb-[calc(1rem+var(--safe-bottom))]',
      'inset-0',
      'inset-x-0',
      'inset-y-[1px]',
      'top-1/2',
      'left-(--x)',
      '-right-2',
      'bottom-full',
      'size-4',
      'size-[10px]',
      'w-4',
      'h-4',
      'w-1/2',
      'min-w-0',
      'max-w-[90vw]',
      'max-w-screen-md',
      'text-sm',
      'text-sm/6',
      'text-[11px]',
      'text-[color:var(--x)]',
      'text-(length:--x)',
      'text-red-500',
      'text-red-500/50',
      'text-left',
      'text-balance',
      'leading-4',
      'leading-[1.2]',
      'font-bold',
      'font-[600]',
      'font-mono',
      'font-[family-name:var(--f)]',
      'bg-red-500',
      'bg-[#fff]',
      'bg-[url(/a.png)]',
      'border',
      'border-2',
      'border-[3px]',
      'border-red-500',
      'border-t',
      'border-t-2',
      'border-l-red-500',
      'border-dashed',
      'border-collapse',
      'rounded',
      'rounded-md',
      'rounded-t-lg',
      'rounded-[2px]',
      'ring',
      'ring-2',
      'ring-red-500',
      'outline',
      'outline-2',
      'outline-none',
      'outline-red-500',
      'shadow',
      'shadow-md',
      'shadow-[0_1px_2px_black]',
      'shadow-red-500',
      'flex',
      'flex-1',
      'flex-col',
      'flex-wrap',
      'basis-1/2',
      'grow',
      'shrink-0',
      'gap-2',
      'gap-x-2',
      'gap-y-[3px]',
      'grid',
      'grid-cols-2',
      'grid-cols-[auto_1fr]',
      'col-span-2',
      'row-span-2',
      'overflow-hidden',
      'overflow-x-auto',
      'overflow-y-scroll',
      'line-clamp-2',
      'hidden',
      'block',
      'truncate',
      'opacity-50',
      'translate-x-1',
      '-translate-y-1/2',
      'rotate-45',
      'transition',
      'transition-colors',
      'duration-200',
      'ease-out',
      'animate-spin',
      'cursor-pointer',
      'pointer-events-none',
      'select-none',
      'container',
      '@container/card',
      'sr-only',
      'underline',
      'decoration-red-500',
      'underline-offset-4',
      '[mask-type:alpha]',
      '[&>svg]:size-4',
    ];
    const inSlimOrUnknown = (token: string): boolean => {
      const group = fullGroupOf(baseClass(token));
      return group === undefined || slimGroupIds.has(group);
    };
    const pool = [...new Set([...representatives, ...synthetic.filter(inSlimOrUnknown)])];

    it('全ての代表の2本の組（向きも両方）。同一グループ・衝突グループを含む', () => {
      expect(pool.length).toBeGreaterThan(300);
      const pairs: string[] = [];
      for (const a of pool) for (const b of pool) pairs.push(`${a} ${b}`);
      expect(expectSame(pairs, '2本の組')).toBeGreaterThan(90000);
    });

    it('衝突する2グループ（conflictingClassGroups）の全 class の組', () => {
      const pairs: string[] = [];
      for (const [group, targets] of Object.entries(
        tailwindMergeConfig.conflictingClassGroups ?? {},
      )) {
        const left = groupTokens.get(group) ?? [];
        for (const target of targets ?? []) {
          const right = groupTokens.get(target) ?? [];
          for (const a of left) {
            for (const b of right) pairs.push(`${a} ${b}`, `${b} ${a}`, `${a} ${b} ${a}`);
          }
        }
      }
      expect(pairs.length).toBeGreaterThan(1000);
      expectSame(pairs, '衝突グループ');
    });

    it('同じグループの class 同士の全ての組', () => {
      const pairs: string[] = [];
      for (const [group, tokens] of groupTokens) {
        if (!slimGroupIds.has(group)) continue;
        const unique = [...new Set(tokens)].slice(0, 60);
        for (const a of unique) for (const b of unique) pairs.push(`${a} ${b}`);
      }
      expect(pairs.length).toBeGreaterThan(5000);
      expectSame(pairs, '同一グループ');
    });

    it('修飾子付き（hover: / data-[...]: / md: / ! / 任意値 / 順序に敏感な修飾子）', () => {
      const modifiers = [
        ...new Set([
          '',
          'hover:',
          'md:',
          'md:hover:',
          'hover:md:',
          'dark:',
          'focus-visible:',
          'group-hover:',
          'peer-checked:',
          'data-[state=open]:',
          'data-[state=open]:hover:',
          'aria-invalid:',
          'aria-[sort=ascending]:',
          'supports-[display:grid]:',
          '[&>svg]:',
          '[&_svg:not([class*=size-])]:',
          '*:',
          '**:',
          'before:',
          'after:',
          'file:',
          'placeholder:',
          'selection:',
          'marker:',
          'backdrop:',
          'first-line:',
          'before:hover:',
          'hover:before:',
          'after:[&>svg]:',
          '[&>svg]:after:',
          'min-[400px]:',
          'max-md:',
          '@md:',
          'has-[>svg]:',
          'not-hover:',
          ...fullConfig.orderSensitiveModifiers.map((modifier) => `${modifier}:`),
        ]),
      ];
      const important = ['', '!'];
      // 全 class の総当たりにしない: 修飾子の効き方は class のグループではなく修飾子の種類で決まり、総当たりにしても通る分岐は増えないため
      const basicPairs: [string, string][] = [
        ['p-4', 'p-2'],
        ['p-4', 'px-2'],
        ['px-2', 'p-4'],
        ['p-4', 'm-2'],
        ['inset-0', 'inset-y-0'],
        ['inset-y-0', 'inset-0'],
        ['text-sm/6', 'leading-4'],
        ['leading-4', 'text-sm/6'],
        ['text-sm', 'text-red-500'],
        ['p-[3px]', 'p-4'],
        ['border-t', 'border-red-500'],
        ['not-a-tailwind-class', 'p-4'],
      ];
      const inputs: string[] = [];
      for (const m1 of modifiers) {
        for (const m2 of modifiers) {
          for (const i1 of important) {
            for (const i2 of important) {
              for (const [a, b] of basicPairs) {
                inputs.push(`${m1}${i1}${a} ${m2}${i2}${b}`);
              }
            }
          }
        }
      }
      expect(expectSame(inputs, '修飾子付き')).toBeGreaterThan(50000);
      const real: string[] = [];
      for (const token of allTokens) {
        const base = baseClass(token);
        if (token === base || !groupTokens.has(fullGroupOf(base) ?? '')) continue;
        real.push(`${base} ${token}`, `${token} ${base}`, `${token} ${token}`);
      }
      expect(real.length).toBeGreaterThan(1000);
      expectSame(real, '実際の修飾子付き token');
      expectSame(
        ['p-4! px-2!', 'px-2! p-4!', 'hover:p-4! hover:px-2', '!p-4 p-2', 'p-2 !p-4', '!p-4 !px-2'],
        '重要度',
      );
    });

    it('clsx の形（配列・オブジェクト・falsy）を通しても一致する', () => {
      const cases: Parameters<typeof cn>[] = [
        ['p-4', false, null, undefined, 'px-2'],
        [['p-4', ['px-2']], { 'py-1': true, 'pt-2': false }],
        ['text-sm', { 'text-red-500': true }, 'text-xs'],
        ['', '  ', 'flex   flex-col ', 'flex-row'],
      ];
      for (const args of cases) expect(cn(...args)).toBe(fullTwMerge(clsx(args)));
    });
  });
});
