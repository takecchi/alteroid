import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// 実装の目印を `const … = true` の定数で固定せず現物から読む: 固定すると、「着地した」前提が巻き戻っても歯が気づけないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

export function isFencingLanded(leaseSourceText: string): boolean {
  // `.includes` の素の部分一致は使わない: `judgeLeaseRenamed` のように改名しても一致し続け、目印が巻き戻っても false にならないため。
  return (
    /export function judgeLease\(/.test(leaseSourceText) &&
    /export function mayClaim\(/.test(leaseSourceText)
  );
}

export function isRelocationLanded(managerSourceText: string, daemonSourceText: string): boolean {
  return (
    managerSourceText.includes('relocateFrom(runnerId: string): void {') &&
    daemonSourceText.includes('relocateOnLost(runnerId)')
  );
}

export interface StaleLandedClaimCheck {
  readonly feature: string;
  readonly isLanded: boolean;
  readonly forbidden: readonly RegExp[];
  readonly redMeaning: string;
}

export type StaleLandedClaimViolation = {
  file: string;
  line: number;
  feature: string;
  pattern: string;
  text: string;
  redMeaning: string;
};

// `isLanded` が false の check は測らない: 着地していない機能を「待ち」「無い」と書くのは嘘ではないため。
export function findStaleLandedClaims(
  entries: readonly { file: string; text: string }[],
  checks: readonly StaleLandedClaimCheck[],
): StaleLandedClaimViolation[] {
  const out: StaleLandedClaimViolation[] = [];
  for (const check of checks) {
    if (!check.isLanded) continue;
    for (const { file, text } of entries) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const pattern of check.forbidden) {
          if (pattern.test(line)) {
            out.push({
              file,
              line: i + 1,
              feature: check.feature,
              pattern: pattern.source,
              text: line.trim(),
              redMeaning: check.redMeaning,
            });
          }
        }
      }
    }
  }
  return out;
}

// 走査対象から自分を除く: 自分の doc / fixture が引っかかるため。
const SELF_FILE = 'scripts/stale-landed-claims.test.ts';

// `git ls-files -z` を使わない: 追跡済みだけだと、未 `git add` の新規ファイルの「待ち」が手元の verify で緑のまま CI で初めて赤くなるため。
export function listScannableFiles(root: string = ROOT): string[] {
  return (listGitScannableFiles({ cwd: root }) as string[]).filter((p) => p !== SELF_FILE);
}

const FENCING_FORBIDDEN: readonly RegExp[] = [
  /fencing[^。\n]{0,30}待ち/,
  /fencing(?:（[^）]{0,40}）)?が無い/,
  /fencing[^。\n]{0,10}(?:が|は)[^。\n]{0,20}入って(?:から)/,
  /のは fencing[^。\n]{0,20}である/,
  /貸し出し期限（lease）が揃って初めて/,
];

const RELOCATION_FORBIDDEN: readonly RegExp[] = [/移送は[^。\n]{0,30}fencing[^。\n]{0,30}の後/];

describe('着地した機能を「待ち」と言い続けている散文（fencing / 移送）', () => {
  const leaseText = readRepoFile('packages/core/src/lease.ts');
  const managerText = readRepoFile('packages/core/src/manager.ts');
  const daemonText = readRepoFile('apps/daemon/src/index.ts');

  it('目印: lease.ts が judgeLease / mayClaim を export している（fencing 着地の確認）', () => {
    // 先に目印が true であることを確かめる: false だと下の回帰テストは該当 check を測らず、何も測っていない緑になるため。
    expect(isFencingLanded(leaseText)).toBe(true);
  });

  it('目印: ManagerPool#relocateFrom の実装と apps/daemon の onLost 経路が在る（移送着地の確認）', () => {
    expect(isRelocationLanded(managerText, daemonText)).toBe(true);
  });

  it('陽性対照: 目印が在るとき（isLanded=true）、禁じた言い回しは検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '二重実行を止める仕組みは roadmap M5 PR4 の fencing 待ちの既知のギャップである。',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 目印が無いとき（isLanded=false）、同じ言い回しは許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '二重実行を止める仕組みは roadmap M5 PR4 の fencing 待ちの既知のギャップである。',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 「のは fencing…である」形（"待ち"を含まない）も検出される（railway/README.md「既知のざらつき」6番の原文）', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '片側だけで言える形にするのは fencing（roadmap M5 PR4）である',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 「のは fencing…である」形も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '片側だけで言える形にするのは fencing（roadmap M5 PR4）である',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 「貸し出し期限（lease）が揃って初めて」形（onSwap / onLost の元の文言）も検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '貸し出し期限（lease）が揃って初めて引き取りの契機にできる。この口が出すのは知らせだけである。',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 「貸し出し期限（lease）が揃って初めて」形も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '貸し出し期限（lease）が揃って初めて引き取りの契機にできる。この口が出すのは知らせだけである。',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 移送も同様に、目印が在れば検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '減らす操作は、移送は fencing の後（roadmap M5 PR4 → PR5）でしかできない。',
        },
      ],
      [
        {
          feature: '移送（合成）',
          isLanded: true,
          forbidden: RELOCATION_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 移送も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '減らす操作は、移送は fencing の後（roadmap M5 PR4 → PR5）でしかできない。',
        },
      ],
      [
        {
          feature: '移送（合成・未着地のふり）',
          isLanded: false,
          forbidden: RELOCATION_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('本物: 追跡ファイルのどこにも、着地済み機能を「待ち」と言う散文が残っていない（回帰）', () => {
    const files = listScannableFiles();
    expect(files.length).toBeGreaterThan(100);

    const entries: { file: string; text: string }[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readRepoFile(file);
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      entries.push({ file, text });
    }

    const violations = findStaleLandedClaims(entries, [
      {
        feature: 'fencing（#160。二重実行を止める貸し出し期限）',
        isLanded: isFencingLanded(leaseText),
        forbidden: FENCING_FORBIDDEN,
        redMeaning:
          'fencing は #160 で着地済み。同名2台の併存も #209 が貸し出しの引き取り側で ' +
          '塞ぎ、Issue #200 は CLOSED——ただし Registry#get 自身の一意性はいまも未解決 ' +
          '（主張は残し、住所を #160・#200・#209・#485 へ倒すこと）。',
      },
      {
        feature: '移送（relocation。#485 PR-2 / apps/daemon の onLost ハンドラ）',
        isLanded: isRelocationLanded(managerText, daemonText),
        forbidden: RELOCATION_FORBIDDEN,
        redMeaning:
          '移送は #485 PR-2（`POST /runners/vacate` / `ManagerPool#relocateFrom`）と ' +
          '`apps/daemon` の `onLost` ハンドラで着地済み。「まだ fencing 待ち」ではなく、' +
          '「どの器を空けるかの判断はクローンの仕事で、このスクリプトはまだその口を呼ばない」' +
          'が正しい理由である。',
      },
    ]);

    expect(
      violations.map(
        (v) =>
          `${v.file}:${v.line} [${v.feature}] /${v.pattern}/ ← "${v.text}"\n  赤の意味: ${v.redMeaning}`,
      ),
    ).toEqual([]);
  });
});

describe('listScannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('stale-landed-claims-1817-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(path.join(dir, 'tracked.md'), 'tracked\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(path.join(dir, 'new-untracked.md'), 'new\n');
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.md');
  });

  it('🟢（直した後）: listScannableFiles は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const files = listScannableFiles(dir);
    expect(files).toContain('new-untracked.md');
    expect(files).toContain('tracked.md');
  });
});
