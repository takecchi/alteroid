import { BOOT_TOOL_SEARCH_EVENT_SOURCE, reasonOf, type Stores } from '@alteroid/core';

// 標準出力と日誌の両方に出す: 手元の器で ToolSearch が止まっていたかを、後から日誌だけで辿れるようにするため（#4269）
export async function reportBootToolSearch(
  stores: Pick<Stores, 'journal'>,
  line: string,
  out: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<void> {
  out.stdout(`alteroidd: ${line}\n`);
  await stores.journal
    .append({ type: 'external_event', source: BOOT_TOOL_SEARCH_EVENT_SOURCE, summary: line })
    .catch((error: unknown) => {
      out.stderr(`alteroidd: ToolSearch の見込みを日誌へ残せませんでした: ${reasonOf(error)}\n`);
    });
}
