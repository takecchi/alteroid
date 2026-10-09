import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MEMORY_TS = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
const SELF_TS = readFileSync(fileURLToPath(new URL('./self.ts', import.meta.url)), 'utf8');

/** 最初の `}` で止めない: `MemoryFloor.largestPremise` が inline object 型を持ち、途中で切れるため。 */
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
