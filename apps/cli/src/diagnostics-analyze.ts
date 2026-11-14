import { readFile } from 'node:fs/promises';

import {
  analyzeDiagnostics,
  parseJournalJsonl,
  renderDiagnosticsAnalysis,
  resolveLedgerTimeZone,
} from '@alteroid/core';

import { stdout } from './terminal-out.js';

export interface DiagnosticsAnalyzeOptions {
  journal?: string;
  usage?: string;
  ledgerTz?: string;
  top?: string;
  json?: boolean;
}

function resolveTop(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('--top は 1〜1000 の整数で指定してください');
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
 * `diagnostics export` の出力（JSONL）と、任意で `usage --json` の出力を読んで、トークンの使い方の事実を並べる。
 * 入力ファイルは読むだけで書き換えない。通信しない。集計の本体は `@alteroid/core` の純関数。
 */
export async function diagnosticsAnalyzeCommand(options: DiagnosticsAnalyzeOptions): Promise<void> {
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
  // 不正な IANA 名は黙って捨てずに断る（台帳が申告した名前が使われる場合は、その不正も同じ口で出る）
  const zone = resolveLedgerTimeZone(usage, options.ledgerTz);
  if (zone.state === 'invalid') {
    throw new Error(`時間帯を使えません（${zone.given}）: ${zone.reason}`);
  }
  const journal = parseJournalJsonl(await readInput('--journal', options.journal));
  const analysis = analyzeDiagnostics(journal, {
    usage,
    ...(options.ledgerTz === undefined ? {} : { ledgerTz: options.ledgerTz }),
    topN,
  });
  if (options.json === true) {
    // `writeRaw`: 端末向けの掃除は JSON の中身を変えるため
    stdout.writeRaw(`${JSON.stringify(analysis)}\n`);
    return;
  }
  stdout.write(`${renderDiagnosticsAnalysis(analysis)}\n`);
}
