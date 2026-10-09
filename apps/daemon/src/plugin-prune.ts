import {
  PLUGIN_SCOPES_FOR_CLONE,
  pruneExtractedPluginsAgainstStore,
  reasonOf,
  type Stores,
} from '@alteroid/core';

/** 失敗しても投げない: 片づけの失敗で daemon が起きなくなると、古い版が残るだけの問題がクローン全体の停止になる。 */
export async function pruneExtractedPluginsOnBoot(options: {
  root: string;
  store: Stores['plugins'];
  write?: (text: string) => void;
}): Promise<void> {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  try {
    const result = await pruneExtractedPluginsAgainstStore(
      options.root,
      options.store,
      PLUGIN_SCOPES_FOR_CLONE,
    );
    for (const failed of result.failed) {
      write(
        `alteroidd: 展開済み plugin の片づけに失敗しました（${failed.entry}）: ${failed.message}\n`,
      );
    }
  } catch (error) {
    write(
      `alteroidd: 展開済み plugin の片づけをしませんでした（何も消していません）: ${reasonOf(error)}\n`,
    );
  }
}
