import {
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_OBSERVED_EVENT_SOURCE,
  reasonOf,
  type Stores,
  writeStderrLine,
} from '@alteroid/core';

type Out = { stdout: (text: string) => void; stderr: (text: string) => void };

const PROCESS_OUT: Out = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => writeStderrLine(text),
};

// 標準出力と日誌の両方に出す: 手元の器で ToolSearch が止まっていたかを、後から日誌だけで辿れるようにするため（#4269）
async function report(
  stores: Pick<Stores, 'journal'>,
  source: string,
  line: string,
  out: Out,
): Promise<void> {
  out.stdout(`alteroidd: ${line}\n`);
  await stores.journal
    .append({ type: 'external_event', source, summary: line })
    .catch((error: unknown) => {
      out.stderr(`alteroidd: ToolSearch の行を日誌へ残せませんでした: ${reasonOf(error)}\n`);
    });
}

export async function reportBootToolSearch(
  stores: Pick<Stores, 'journal'>,
  line: string,
  out: Out = PROCESS_OUT,
): Promise<void> {
  await report(stores, BOOT_TOOL_SEARCH_EVENT_SOURCE, line, out);
}

// 起動時の1行（見込み）の隣に、最初のターンの観測（実際）を並べて探せるようにする（#4921）。出し方は同じ
export async function reportBootToolSearchObserved(
  stores: Pick<Stores, 'journal'>,
  line: string,
  out: Out = PROCESS_OUT,
): Promise<void> {
  await report(stores, BOOT_TOOL_SEARCH_OBSERVED_EVENT_SOURCE, line, out);
}
