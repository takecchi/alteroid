#!/usr/bin/env node
/**
 * claude.ai の利用状況スナップショットを1回だけ読んで生の JSON を出す。
 *
 * **これは持ち主（人間）が自分の端末で走らせるためのものである。** alteroid 本体は
 * 同じ control channel を `packages/core/src/usage-snapshot.ts` から読むが、
 * `rate_limits.extra_usage`（支出上限の残り）は**ログイン済みの claude.ai
 * サブスクリプションからしか観測できない**。CI もコンテナも未ログインなので、
 * そこの実物を確かめる手段はこのスクリプトしか無い。
 *
 * 性質:
 *  - **推論を走らせない。** プロンプトを1つも送らず、init と control channel だけを
 *    読んで abort する（実測 1 秒未満・トークン消費ゼロ）
 *  - **何も書かない。** ファイルも設定も触らない。標準出力に JSON を出すだけ
 *  - 依存は `@anthropic-ai/claude-agent-sdk` だけ
 *
 * 使い方（リポジトリ直下で `pnpm install` 済みなら）:
 *
 *   node packages/core/scripts/usage-probe.mjs
 *
 * `email` は既定で伏せる。出さないと困るときだけ `--with-email` を付ける。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
// グローバルの `process` / タイマーに頼らない（write-canon.mjs と同じ理由 —
// この形の素の Node スクリプトは lint の環境定義から外れている）。
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

// 同上。Node 22 では素のグローバルだが lint の環境定義には無い。
const { AbortController } = globalThis;

const TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

const withEmail = process.argv.includes('--with-email');

/**
 * 何も送らないプロンプト。**待ち続けることが「推論を走らせない」の実装である。**
 *
 * abort で解けるようにしておくこと。解決しない Promise にすると、この generator が
 * `.return()` を完了できず、読み終わって離れる側が永久に待つ。
 */
// yield が無いことがこの関数の要件そのものなので、その規則だけ外す。
// eslint-disable-next-line require-yield
async function* idlePrompt(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** 値・undefined のどちらかに必ず落ちる読み取り。片方の失敗で他方を捨てないため。 */
async function settleWithin(promise, ms, label) {
  if (promise === undefined) return { label, ok: false, reason: 'この SDK には無い口' };
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ label, ok: true, value }),
        (error) => ({ label, ok: false, reason: String(error?.message ?? error) }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ label, ok: false, reason: `${ms}ms で応答なし` }), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function redact(account) {
  if (!withEmail && account && typeof account === 'object' && 'email' in account) {
    return { ...account, email: '<redacted>' };
  }
  return account;
}

async function main() {
  const abortController = new AbortController();
  let timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  timer.unref?.();

  try {
    const handle = query({
      prompt: idlePrompt(abortController.signal),
      options: {
        cwd: process.cwd(),
        abortController,
        // probe は init と control channel しか読まない。user 層まで読むと
        // 走らせるたびに持ち主の hook が動く。
        settingSources: ['project'],
      },
    });

    const [account, usage] = await Promise.all([
      settleWithin(handle.accountInfo?.(), READ_TIMEOUT_MS, 'accountInfo'),
      settleWithin(
        handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(),
        READ_TIMEOUT_MS,
        'usage',
      ),
    ]);

    const out = {
      accountInfo: account.ok ? redact(account.value) : { error: account.reason },
      usage: usage.ok ? usage.value : { error: usage.reason },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

    // 見るべきところを名指しする。生 JSON だけ渡されても、どこが答えなのか
    // 分からないまま転記されると意味がない。
    const limits = usage.ok ? usage.value?.rate_limits : undefined;
    process.stderr.write('\n--- 読みかた ---\n');
    if (!usage.ok) {
      process.stderr.write(`usage が取れなかった: ${usage.reason}\n`);
    } else if (limits == null) {
      process.stderr.write(
        `rate_limits が null（rate_limits_available=${usage.value?.rate_limits_available}）。\n` +
          'claude.ai にログインしていない / API キー・Bedrock・Vertex 経由だと枠は来ない。\n' +
          'extra_usage も rate_limits の中にあるので、この状態では観測できない。\n',
      );
    } else if (limits.extra_usage == null) {
      process.stderr.write(
        'rate_limits は来たが extra_usage が無い（キー欠落か null）。\n' +
          'この形が「支出上限を設定していない環境」の姿である可能性がある。\n',
      );
    } else {
      process.stderr.write(`extra_usage: ${JSON.stringify(limits.extra_usage)}\n`);
    }
  } finally {
    clearTimeout(timer);
    // どの経路でもサブプロセスを畳む。常駐させない。
    abortController.abort();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`probe が失敗した: ${String(error?.stack ?? error)}\n`);
    process.exit(1);
  },
);
