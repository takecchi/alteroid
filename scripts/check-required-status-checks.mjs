#!/usr/bin/env node
/**
 * `.github/required-status-checks.json` の宣言と、main のブランチ保護が実際に
 * required にしている status check を突き合わせる（#836）。
 *
 * **判定ロジックはここに置かない。** `check-required-status-checks-core.mjs` が
 * 正本で、なぜこれが `pnpm test` の中ではなく別コマンドなのか（offline とトークン
 * 権限の2つ）もあちらの doc に書いてある。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 宣言と protection の required contexts が一致しているか。
 *   食い違っていれば、両側の値を並べて出す。
 * - **言えないこと**: **どちらが正しいか。** 宣言が古いのか protection が意図せず
 *   変わったのかは、この道具からは分からない（`formatComparison` の doc）。
 * - **書き換えない。** 読むだけである。protection にも宣言にも1バイトも書かない。
 *
 * ## 終了コード
 *
 * | | |
 * |---|---|
 * | 0 | 一致した |
 * | 1 | ずれている |
 * | 1 | 読めなかった（権限・ネットワーク） |
 *
 * **ずれと「読めなかった」を同じ 1 にしてあるが、出力の文言は別である。**
 * どちらも「緑ではない」ことが要点なので終了コードは分けず、**何が起きたかは
 * 必ず1行目で名乗る**（AGENTS.md「静かに失敗する道具」）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  compareRequiredStatusChecks,
  contextsFromProtection,
  formatComparison,
} from './check-required-status-checks-core.mjs';

const ROOT = join(import.meta.dirname, '..');
const DECLARATION_PATH = join(ROOT, '.github', 'required-status-checks.json');
const PROTECTION_PATH = 'repos/takecchi/alteroid/branches/main/protection';

// `console` に頼らない理由は他の check スクリプトと同じ（`scripts/verify.mjs` に
// 揃えて `process.std{out,err}.write` を使う）。
function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/**
 * ブランチ保護を読む。読めなければ `null` を返す。
 *
 * **例外を握り潰して `null` にするが、握り潰した中身は捨てない** —— 読めなかった
 * 理由（401 / 403 / ネットワーク）は、次の一手を決める材料そのものである。
 */
function fetchProtection() {
  try {
    const stdout = execFileSync('gh', ['api', PROTECTION_PATH], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { protection: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { protection: null, error: detail };
  }
}

function main() {
  let declared;
  try {
    const raw = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'));
    if (!Array.isArray(raw.contexts) || raw.contexts.some((n) => typeof n !== 'string')) {
      logError(
        `check-required-status-checks: ${DECLARATION_PATH} の contexts が文字列の配列でない`,
      );
      process.exitCode = 1;
      return;
    }
    declared = raw.contexts;
  } catch (error) {
    logError(`check-required-status-checks: ${DECLARATION_PATH} を読めない: ${error}`);
    process.exitCode = 1;
    return;
  }

  const { protection, error } = fetchProtection();
  const live = protection === null ? null : contextsFromProtection(protection);
  const result = compareRequiredStatusChecks(declared, live);

  if (result.verdict === 'match') {
    log(formatComparison(result));
    return;
  }

  logError(formatComparison(result));
  // **読めなかった理由は必ず添える。** 「読めなかった」だけだと、権限の問題なのか
  // ネットワークなのかが分からず、次の一手が決まらない。
  if (result.verdict === 'unreadable' && error !== null) {
    logError(`  gh の出力: ${error}`);
  }
  process.exitCode = 1;
}

main();
