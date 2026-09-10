import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RESERVED_SCHEDULE_KINDS } from '@alteroid/core';

/**
 * **`apps/web` の注釈が、予約スケジュール kind を手で数え直さないことを測る歯。**
 *
 * ## 何のためにここが在るか
 *
 * `packages/core/src/schedule.ts` の `RESERVED_SCHEDULE_KIND_TUPLE`（実体は
 * `RESERVED_SCHEDULE_KINDS`）が、既定で仕込まれる定期ジョブの唯一の数え上げである
 * （2026-09-08 の PR #701 が `memory_tidy` を足したときのコメントが逐語で
 * そう言っている——`grep -Fn -- '散文で数え直さないこと' packages/core/src/schedule.ts`）。
 *
 * `packages/core/src/tool-description-enumeration.test.ts`（#756）は、この一覧を
 * **クローンへ渡る `description`** が数え直していないかを測るが、そちらが見るのは
 * `createCloneTools()` の返り値だけである——**JSDoc や JSX の注釈（人間が読むだけで
 * クローンには届かない散文）は対象外**（同ファイルの doc「JSDoc はクローンに届かない」）。
 *
 * `apps/web` の3箇所（`schedule.tsx` の JSX 注釈2つ・`mutations.ts` の JSDoc1つ）と
 * `schedule.test.tsx` の2箇所は、まさにその抜け穴を踏んでいた——「既定の仕込み
 * （日報・発意 tick）」と2つだけ数え直していて、`memory_tidy` が3つ目として
 * 足された後もそのまま残っていた（このファイルを追加した PR で直した）。
 *
 * ## 測っているもの
 *
 * `apps/web/app` 配下の全ソースを正規化（空白を1つに畳む）した文字列の中から、
 * 「既定」の近くに「・」で区切られた列挙が現れる箇所を探す。見つかったら、その
 * 近傍に `RESERVED_SCHEDULE_KINDS`（シンボル名そのもの）が無ければ赤くする——
 * **一覧を手で書き写さず、出所のシンボル名を指しているか**だけを見る。
 *
 * ## ⚠️ この歯が測っていないこと（正直に書く）
 *
 * - **「・」を使わない列挙**（例:「日報も発意 tick も」のような「〜も〜も」の並び）
 *   は検出しない。`schedule.tsx` の冒頭 doc がこの形で `daily_report` /
 *   `self_initiative` に触れているが、「既定で回っているものの例」であって
 *   「既定の全部」を名乗っていないと判断し、範囲外とした（PR 本文に明記）
 * - **`RESERVED_SCHEDULE_KINDS` という字面さえ近くにあれば通す。** その近くで
 *   なお列挙が続いていても（例:「既定の仕込み（日報・発意 tick。cf.
 *   RESERVED_SCHEDULE_KINDS）」）、この歯は字面の有無しか見ないので捕まらない
 * - **意味が合っているかは見ていない。** 数え上げが3つとも並んでいれば、隣の文が
 *   嘘でもここは緑になる（`tool-description-enumeration.test.ts` と同じ限界）
 */

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
/**
 * **このファイル自身は対象から除く。** ここに置いた過去の経緯の説明文と、検出に
 * 使う正規表現リテラルそのものが「既定」＋「・」を含むため、除かないと自分自身を
 * 誤検出する（自己参照）。除外は名前1つだけで、内容は測っていない。
 */
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

/** コメント記法（`/**` `*` `//` `{/*` 等）に関係なく、折り返しをまたいだ列挙も拾えるよう畳む。 */
function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/**
 * 「既定」の後ろ 40 文字以内に「・」で区切られた列挙が現れる箇所を検出する。
 * マッチ全体の前後 80 文字を「近傍」として、そこに `RESERVED_SCHEDULE_KINDS` が
 * 含まれているかを別に判定する（含まれていれば、シンボル名で指しているとみなし
 * 見逃す。含まれていなければ、一覧を手で書き写した疑いとして報告する）。
 */
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
