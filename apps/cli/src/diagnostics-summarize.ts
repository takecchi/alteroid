import { readFile } from 'node:fs/promises';

import {
  DIAGNOSTICS_SUMMARY_DEFAULT_TOP,
  DIAGNOSTICS_SUMMARY_MAX_BYTES,
  DIAGNOSTICS_SUMMARY_MAX_TOP,
  buildDiagnosticsSummary,
  jsonByteLength,
  parseJournalJsonl,
  resolveLedgerTimeZone,
} from '@alteroid/core';

import { stderr, stdout } from './terminal-out.js';

export interface DiagnosticsSummarizeOptions {
  journal?: string;
  usage?: string;
  ledgerTz?: string;
  top?: string;
}

function resolveTop(raw: string | undefined): number {
  if (raw === undefined) return DIAGNOSTICS_SUMMARY_DEFAULT_TOP;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > DIAGNOSTICS_SUMMARY_MAX_TOP) {
    throw new Error(`--top は 1〜${DIAGNOSTICS_SUMMARY_MAX_TOP} の整数で指定してください`);
  }
  return value;
}

async function readInput(label: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${label} を読めませんでした（${path}: ${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
}

/**
 * `diagnostics export` の出力（JSONL）と、任意で `usage --json` の出力から、別の alteroid へ送る要約の JSON を標準出力へ出す。
 * 通信しない。標準エラーに「この JSON が送る内容のすべて」の旨を出す。人が出力を見て、送ってよいか確かめられる。
 * 秘密らしい文字列が見つかったら、何も出さずに断る（`DiagnosticsSummarySecretError`）
 */
export async function diagnosticsSummarizeCommand(
  options: DiagnosticsSummarizeOptions,
): Promise<void> {
  if (options.journal === undefined) {
    throw new Error(
      '--journal <JSONL> が要ります（`alteroid diagnostics export > diag.jsonl` の出力）',
    );
  }
  const topN = resolveTop(options.top);
  let usage: unknown;
  if (options.usage !== undefined) {
    const text = await readInput('--usage', options.usage);
    try {
      usage = JSON.parse(text);
    } catch {
      throw new Error(
        `--usage が JSON として読めません（${options.usage}。usage --json の出力を渡す）`,
      );
    }
  }
  const zone = resolveLedgerTimeZone(usage, options.ledgerTz);
  if (zone.state === 'invalid') {
    throw new Error(`時間帯を使えません（${zone.given}）: ${zone.reason}`);
  }
  const journal = parseJournalJsonl(await readInput('--journal', options.journal));
  const summary = buildDiagnosticsSummary(
    { journal, usage },
    {
      topN,
      env: process.env,
      ...(options.ledgerTz === undefined ? {} : { ledgerTz: options.ledgerTz }),
    },
  );
  const json = JSON.stringify(summary);
  stdout.writeRaw(`${json}\n`);
  stderr.write(
    `この JSON が送る内容のすべて（${jsonByteLength(summary)} / ${DIAGNOSTICS_SUMMARY_MAX_BYTES} バイト。畳んだ節: ${
      summary.truncated.length === 0 ? 'なし' : summary.truncated.join(', ')
    }）。通信はしていない\n`,
  );
}
