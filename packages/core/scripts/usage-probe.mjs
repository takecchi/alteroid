#!/usr/bin/env node
import { query } from '@anthropic-ai/claude-agent-sdk';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const { AbortController } = globalThis;

const TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

const withEmail = process.argv.includes('--with-email');

// 解決しない Promise にしない: generator が `.return()` を完了できず、離れる側が永久に待つため
// eslint-disable-next-line require-yield
async function* idlePrompt(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

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
        // user 層を読まない: 走らせるたびに持ち主の hook が動くため
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
