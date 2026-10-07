import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RESERVED_SCHEDULE_KINDS } from '@alteroid/core';

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
// このファイル自身を対象に含めない: 検出に使う正規表現リテラルが「既定」＋「・」を含み、自分自身を誤検出するため
const SELF = fileURLToPath(import.meta.url);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && full !== SELF) out.push(full);
  }
  return out;
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

function findUnreferencedEnumerations(normalized: string): string[] {
  const findings: string[] = [];
  const anchor = /既定[^・]{0,40}・/g;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(normalized)) !== null) {
    const start = match.index;
    const neighborhoodStart = Math.max(0, start - 80);
    const neighborhoodEnd = Math.min(normalized.length, start + match[0].length + 80);
    const neighborhood = normalized.slice(neighborhoodStart, neighborhoodEnd);
    if (!neighborhood.includes('RESERVED_SCHEDULE_KINDS')) {
      findings.push(neighborhood.trim());
    }
  }
  return findings;
}

describe('apps/web の注釈は予約スケジュール kind を手で数え直さない', () => {
  it('出所（RESERVED_SCHEDULE_KINDS）が空ではない（この歯が空振りしていないこと）', () => {
    expect(
      RESERVED_SCHEDULE_KINDS.length,
      'RESERVED_SCHEDULE_KINDS が空である。この歯は何も測れていない',
    ).toBeGreaterThan(0);
  });

  it('「既定」の近くの「・」列挙は、必ず RESERVED_SCHEDULE_KINDS を伴っている', () => {
    const files = collectSourceFiles(APP_DIR);
    expect(files.length, 'apps/web/app のソースが1件も見つからない').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const findings = findUnreferencedEnumerations(normalize(raw));
      for (const finding of findings) {
        offenders.push(`${path.relative(APP_DIR, file)}: …${finding}…`);
      }
    }

    expect(
      offenders,
      '【赤の意味】次の箇所が「既定」の近くで「・」区切りの列挙をしているのに、' +
        `RESERVED_SCHEDULE_KINDS（packages/core/src/schedule.ts。いま ${RESERVED_SCHEDULE_KINDS.length} 件）` +
        'を字面で伴っていない:\n' +
        offenders.join('\n') +
        '\n一覧を手で書き写すと、予約 kind が増えたときにここだけ取り残される' +
        '（#701 / #756、そしてこのファイルが直した apps/web の5箇所と同じ形）。' +
        '列挙をやめてシンボル名（`RESERVED_SCHEDULE_KINDS`）で指すこと。',
    ).toEqual([]);
  });
});
