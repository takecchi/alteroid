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

/**
 * `cn` は tailwind-merge の**既定の設定の部分集合**（`tailwindMergeConfig`）で動く。
 * 部分集合にしたのは bundle を減らすためで、**`cn` の結果は既定の `twMerge` と1文字も違ってはならない**。
 * それを3つの形で測る。
 *
 * 1. 構造: slim の各グループ・`conflictingClassGroups` などが、既定から1文字も変えずに写されている。
 * 2. 網羅: repo で使われている class の token が属するグループが、全て slim に在る。
 *    **新しい class を使い始めて slim に無ければここが落ちる**（何を足すかはメッセージに出す）。
 * 3. 差分: token の組み合わせの集まりで、既定の `twMerge` と slim の `cn` が完全に一致する。
 *
 * 既定の設定を参照してよいのはこのテストだけである（本番コードが参照すると bundle へ戻る）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

// Tailwind に class を拾わせている根（`packages/ui/src/styles.css` の `@source` と apps/web）に、
// class 文字列を返しうる `packages/logic` / `packages/swr` を足したもの。
const SCAN_ROOTS = ['packages/ui/src', 'apps/web/app', 'packages/logic/src', 'packages/swr/src'];
// この設定自身とこのテストは走査しない（設定の語彙が「使われている」ことにならないように）。
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

/**
 * class の候補 token を広く拾う。Tailwind v4 の scanner と同じく、文字列かどうかも文脈も見ず、
 * 空白・引用符・区切り記号で切った全ての断片を候補にする（散文の語も混じるが、既定が知らない
 * 語はグループを持たないので害は無い）。引用符は切らず残す版も足し、`content-['']` や
 * `[&_[data-x]]` のような任意値を含む形を落とさない。
 */
function candidateTokens(text: string): string[] {
  const out: string[] = [];
  for (const separators of [/[\s"'`]+/, /[\s"'`{}<>;,=]+/, /[\s`{}<>;,=]+/, /[\s"'`{}<>;,=()]+/]) {
    for (const raw of text.split(separators)) {
      // 引用符を残した切り方では、リテラルの縁の引用符（`'p-4'` の両端）が付いたまま来る
      const piece = raw.replace(/^["'`]+|["'`]+$/g, '');
      if (!piece) continue;
      out.push(piece);
      const trimmed = piece.replace(/^[.:!(]+|[.,:;)]+$/g, '');
      if (trimmed && trimmed !== piece) out.push(trimmed);
    }
  }
  return out;
}

/** `hover:data-[a:b]:!p-4!` → `p-4`。修飾子と重要度の印を外した、class 本体だけを返す。 */
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

/**
 * 既定の設定で、class 本体がどのグループに属するかを求める。tailwind-merge はそれを公開して
 * いないので、**挙動で測る**: 既定の全グループに1本ずつ「探り針」のグループ（`zzprobe<n>` という
 * class）を足し、グループ G が衝突する先に G の探り針を足す。探り針を全部並べた後ろへ測りたい
 * class を置いて `twMerge` にかけると、その class が属するグループの探り針だけが消える。
 * 既定が知らない class は何も消さない（= `undefined`）。
 */
const probeClasses = fullGroupIds.map((_, index) => `zzprobe${index}`);
const probeMerge = (() => {
  const classGroups: Config<string, string>['classGroups'] = { ...fullConfig.classGroups };
  const conflictingClassGroups: Config<string, string>['conflictingClassGroups'] = {
    ...fullConfig.conflictingClassGroups,
  };
  fullGroupIds.forEach((id, index) => {
    classGroups[`probe${index}`] = [`zzprobe${index}`];
    conflictingClassGroups[id] = [
      ...(fullConfig.conflictingClassGroups[id] ?? []),
      `probe${index}`,
    ];
  });
  return { classGroups, conflictingClassGroups };
})();
const probeTwMerge = createTailwindMerge(() => ({ ...fullConfig, ...probeMerge }));
const probePrefix = probeClasses.join(' ');

function fullGroupOf(baseToken: string): string | undefined {
  const kept = new Set(probeTwMerge(`${probePrefix} ${baseToken}`).split(' '));
  const gone = probeClasses.flatMap((probe, index) =>
    kept.has(probe) ? [] : [fullGroupIds[index]],
  );
  return gone[0];
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
    // 探り針の自己検査: 既知の class が既知のグループに落ちる
    expect(fullGroupOf('px-4')).toBe('px');
    expect(fullGroupOf('-mt-2')).toBe('mt');
    expect(fullGroupOf('text-sm')).toBe('font-size');
    expect(fullGroupOf('text-muted-foreground')).toBe('text-color');
    expect(fullGroupOf('not-a-tailwind-class')).toBeUndefined();
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
        '(グループ: 例の class)',
      ].join('\n'),
    ).toEqual([]);
  });

  describe('構造: 既定から1文字も変えずに写されている', () => {
    // `fromTheme` が毎回新しい関数を作るので、参照ではなく themeKey で比べる。
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
      // 既定での並びを保っている（同じ class が複数のグループに当たるとき、先に定義された方が勝つ）
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

    // repo の文字列リテラルと `cn(...)` の呼び出し
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
      // 隣り合うリテラル同士（後勝ちの向きを両方）
      const list = [...callArgs];
      const adjacent: string[] = [];
      for (let i = 0; i + 1 < list.length; i += 1) {
        adjacent.push(`${list[i]} ${list[i + 1]}`, `${list[i + 1]} ${list[i]}`);
      }
      expectSame(adjacent, '隣り合う cn の引数');
    });

    // グループごとの代表 class（repo で実際に使われているもの）。各グループから最大3本、
    // 短いもの・長いもの・任意値を含むものが入るようにばらす。
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
    // repo に無くても、既定が別々のグループへ振る形を確かめたい class
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
    // slim が持たないグループの class は「使われていない」ので、ここでは比べない（上の網羅の検査が
    // 「使われていれば slim に在る」を持つ）。既定が知らない class は比べる。
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
      ];
      const important = ['', '!'];
      // 衝突しうる組（同じグループ・衝突するグループ）の代表だけを修飾子と掛け合わせる
      const basics = [
        'p-4',
        'px-2',
        'py-1',
        'pt-2',
        'inset-0',
        'top-1',
        'inset-x-0',
        'left-0',
        'text-sm',
        'text-red-500',
        'text-left',
        'leading-4',
        'text-sm/6',
        'bg-card',
        'bg-[#fff]',
        'border',
        'border-2',
        'border-t',
        'border-red-500',
        'rounded',
        'rounded-t-md',
        'size-4',
        'w-4',
        'h-4',
        'flex',
        'hidden',
        'overflow-hidden',
        'overflow-x-auto',
        'line-clamp-2',
        'gap-2',
        'gap-x-1',
        'opacity-50',
        'shadow-md',
        'shadow-red-500',
        'p-[3px]',
        'font-bold',
        'font-mono',
      ];
      const inputs: string[] = [];
      for (const m1 of modifiers) {
        for (const m2 of modifiers) {
          for (const i1 of important) {
            for (const i2 of important) {
              for (const a of basics) {
                for (const b of basics) {
                  inputs.push(`${m1}${i1}${a} ${m2}${i2}${b}`);
                }
              }
            }
          }
        }
      }
      // 上の総当たりは大きいので、間引いて走らせる（決定的に、全ての修飾子の組が残る間引き方）
      const stride = Math.max(1, Math.floor(inputs.length / 250000));
      const sampled = inputs.filter((_, index) => index % stride === 0);
      expect(expectSame(sampled, '修飾子付き')).toBeGreaterThan(50000);
      // 末尾の `!`（v3 形式）と、repo の実際の修飾子付き token 自身とその本体の組
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
