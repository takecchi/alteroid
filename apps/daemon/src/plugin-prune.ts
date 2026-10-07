import { pruneExtractedPluginsAgainstStore, reasonOf, type Stores } from '@alteroid/core';

/** クローン（daemon）へ撒く plugin の scope。`runner` はマネージャー側が持つ。 */
export const PLUGIN_SCOPES_FOR_CLONE = ['all', 'app'] as const;

/**
 * 起動時に、ストアに無い版の展開済みディレクトリと `.tmp-*` を消す。
 *
 * **失敗しても投げない。** 片づけが出来ないことで daemon が起きなくなると、古い版が残るだけの
 * 問題がクローン全体の停止になる（`applyAppScopedEnvVars` と同じ扱い）。`list` が読めなかった
 * ときは何も消さない（`pruneExtractedPluginsAgainstStore` の約束）。
 */
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
