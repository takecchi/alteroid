import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 「量の欄は単位を名乗る」という不変条件を、**将来足される欄**に対して守る歯
 * （`quantity.ts`。#804 案2）。
 *
 * ## ⚠️ この歯が守っているものと、守っていないもの(AGENTS.md「歯で型を測った
 * ことにしないこと」)
 *
 * **型そのもの**——`HeuristicChars` へ素の `number` を代入できない、
 * `HeuristicChars` を `ExactTokens` の欄へ代入できない、という主張——は
 * `tsc` が守る。ここでその再現はしない(vitest は型を落とすので、型が
 * 落ちること自体は vitest では測れない——この変更の報告に `tsc --noEmit`
 * の生出力を添えている)。
 *
 * **この歯が守るのはただ1点だけ**——`memory.ts` の `MemoryFloor` と
 * `self.ts` の `CloneRuntimeFacts` の**宣言そのものをソースから読み**、
 * 名前が `Chars`/`chars` で終わる欄が素の `number` で宣言されていないこと。
 * 新しく計測の欄を足した人が `HeuristicChars`(または他の `Quantity`)を
 * 通さず `number` のまま足したら、この歯が赤くなる——`tsc` は「新しい
 * `number` の欄」自体を咎めない(`number` は合法な型なので)、ここが
 * 埋める穴である。
 *
 * **ソースを正規表現で読む。** `ts-morph` 等で AST を組み立てて読む方法も
 * あるが、依存を増やさずに済む単純な形のほうが「何を測っているか」を
 * 追いやすい——ただしソースを文字列として読む以上、正規表現が的を
 * 外していないかは自分で確かめる必要がある。下の
 * `MemoryFloor に number の *Chars 欄を足すと、この歯は赤くなる(負の対照)`
 * が対照である(実際に赤くなることを実測してから、この行をこの形に
 * 戻した——`git diff` が空であることを確認済み)。
 */

const MEMORY_TS = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
const SELF_TS = readFileSync(fileURLToPath(new URL('./self.ts', import.meta.url)), 'utf8');

/**
 * `export interface <name> { ... }` の波括弧の中身をソースから抜き出す。
 *
 * **波括弧の深さを自分で数える。** `MemoryFloor.largestPremise` は
 * `{ slug: string; chars: HeuristicChars } | null` という inline object 型を
 * 持つので、最初に現れる `}` で止まると宣言の途中で切れる。
 */
function extractInterfaceBody(source: string, interfaceName: string): string {
  const marker = `interface ${interfaceName} {`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `interface ${interfaceName} が見つからない——ソースの形が変わった(この歯の前提が崩れている)`,
    );
  }
  const bodyStart = start + marker.length;
  let depth = 1;
  let index = bodyStart;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') depth -= 1;
    index += 1;
  }
  if (depth !== 0) {
    throw new Error(
      `interface ${interfaceName} の閉じ括弧が見つからない(波括弧の対応が崩れている)`,
    );
  }
  return source.slice(bodyStart, index - 1);
}

/**
 * interface 本文から、名前が `Chars`/`chars` で終わる欄の「型」だけを
 * 抜き出す(欄名 → 型文字列。空白は1個へ畳む)。
 *
 * **JSDoc コメントは見ない設計ではなく、単に当たらないだけ。** 正規表現は
 * `識別子: 型;` という形にしか当たらないので、コメント中の散文(コロンを
 * 含みうる)を拾わない——拾ってしまうかどうかは負の対照
 * (`MemoryFloor に number の *Chars 欄を足すと…`)と、既知の欄の集合を
 * 突き合わせる歯(`MemoryFloor の *Chars 欄の集合は…`)の両方で確かめてある。
 */
function charsFieldTypes(interfaceBody: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /(\w*[Cc]hars)\s*:\s*([^;]+);/g;
  for (const match of interfaceBody.matchAll(pattern)) {
    const name = match[1];
    const type = match[2];
    if (name === undefined || type === undefined) continue;
    found.set(name, type.replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('MemoryFloor の *Chars 欄は、どれも素の number で宣言されていない', () => {
  const body = extractInterfaceBody(MEMORY_TS, 'MemoryFloor');
  const fields = charsFieldTypes(body);

  it('抽出そのものが空でない(正規表現が的を外していない)', () => {
    expect(fields.size).toBeGreaterThan(0);
  });

  it('MemoryFloor の *Chars 欄の集合は、既知の5つと一致する(regex の的外れを検知する)', () => {
    // `premiseChars` / `indexedChars` / `tocChars` / `totalChars` の4つと、
    // `largestPremise` / `largestIndexed` の inline object 型が共有する
    // `chars`(名前が同じなので Map 上は1件に畳まれる)。
    expect([...fields.keys()].sort()).toEqual(
      ['chars', 'indexedChars', 'premiseChars', 'tocChars', 'totalChars'].sort(),
    );
  });

  it('どの欄も型が素の number そのものではない', () => {
    for (const [name, type] of fields) {
      expect(type, `${name}: ${type}`).not.toBe('number');
      expect(type, `${name}: ${type}`).toContain('HeuristicChars');
    }
  });

  it('件数の欄(premiseDocs 等)は、この歯の対象に入っていない(量ではなく件数だから)', () => {
    // `demotedPremiseDocs` は「そのうち何件が…」という件数で、量(HeuristicChars)
    // ではない——`MemoryFloor` の doc の判断をこの歯でも裏から確かめる。
    expect(fields.has('demotedPremiseDocs')).toBe(false);
    expect(fields.has('premiseDocs')).toBe(false);
  });
});

describe('CloneRuntimeFacts の *Chars 欄は、どれも素の number で宣言されていない', () => {
  const body = extractInterfaceBody(SELF_TS, 'CloneRuntimeFacts');
  const fields = charsFieldTypes(body);

  it('抽出そのものが空でない(正規表現が的を外していない)', () => {
    expect(fields.size).toBeGreaterThan(0);
  });

  it('CloneRuntimeFacts の *Chars 欄の集合は、既知の2つと一致する(regex の的外れを検知する)', () => {
    expect([...fields.keys()].sort()).toEqual(['injectedMemoryChars', 'systemPromptChars'].sort());
  });

  it('どの欄も型が素の number そのものではない', () => {
    for (const [name, type] of fields) {
      expect(type, `${name}: ${type}`).not.toBe('number');
      expect(type, `${name}: ${type}`).toContain('HeuristicChars');
    }
  });
});

/**
 * **負の対照(依頼者の明示指定)。** この歯自身が本当に「*Chars 欄が
 * 素の number である」ことを検出できるかを、実際に検出させて確かめる。
 *
 * ここでは `MemoryFloor` を書き換えず、**同じ抽出関数を模造の interface
 * ソースへ当てる**ことで対照を再現する——本物の `MemoryFloor` へ
 * `testOnlyChars: number;` を一時的に足して赤くなることは、実装時に
 * 手作業で1回確かめてある(この変更の報告に生出力を添えてある)。
 * その手作業を歯として残すと「一時的に足した」行が repo に残ってしまう
 * ので、ここでは同じ検出ロジックに対する恒久の負の対照として、模造の
 * ソース文字列で再現する。
 */
describe('負の対照——素の number の *Chars 欄が実際にあれば、この歯の検出ロジックは拾う', () => {
  it('模造の interface に number の *Chars 欄を足すと拾われる', () => {
    const fixture = [
      'export interface FixtureFloor {',
      '  premiseChars: HeuristicChars;',
      '  testOnlyChars: number;',
      '}',
    ].join('\n');
    const body = extractInterfaceBody(fixture, 'FixtureFloor');
    const fields = charsFieldTypes(body);

    expect(fields.get('testOnlyChars')).toBe('number');
    expect(() => {
      for (const [name, type] of fields) {
        expect(type, `${name}: ${type}`).not.toBe('number');
      }
    }).toThrow();
  });
});
