import type { AgentPluginLoad } from './agent-events.js';
import { excerptLine } from './excerpt.js';

// プロバイダが既に件数・長さを切っている（`claude-provider.ts` の `pluginLoadOf`）が、日誌の1行はそれより短く締める: 失敗が並ぶ init を毎回そのまま写すと日誌が太るため
const JOURNAL_PLUGINS_MAX = 30;
const JOURNAL_ERRORS_MAX = 5;
const JOURNAL_FIELD_LIMIT = 120;
const JOURNAL_MESSAGE_LIMIT = 200;

/**
 * init の読み込み結果を日誌の1文へ畳む。同じ結果かどうかの指紋も返す（日誌は前回と変わったときだけ書く）。
 * 失敗の欄が無いこと（`errors: null`）は「失敗の報告は無い」までしか言わない: SDK は失敗が無いとき欄を省くが、
 * 省略は無事の断定ではないため。
 */
export function describePluginLoadForJournal(load: AgentPluginLoad): {
  text: string;
  digest: string;
} {
  const names = load.plugins.map((plugin) =>
    excerptLine(
      plugin.version === undefined ? plugin.name : `${plugin.name}@${plugin.version}`,
      JOURNAL_FIELD_LIMIT,
    ),
  );
  const shownNames = names.slice(0, JOURNAL_PLUGINS_MAX);
  const namesOmitted = names.length - shownNames.length;
  const loaded =
    names.length === 0
      ? 'なし'
      : `${shownNames.join(', ')}${namesOmitted > 0 ? `（ほか ${namesOmitted} 件）` : ''}`;

  const errors = load.errors ?? [];
  const shownErrors = errors
    .slice(0, JOURNAL_ERRORS_MAX)
    .map(
      (error) =>
        `${excerptLine(error.plugin, JOURNAL_FIELD_LIMIT)}（${excerptLine(error.type, JOURNAL_FIELD_LIMIT)}）: ` +
        excerptLine(error.message, JOURNAL_MESSAGE_LIMIT),
    );
  const errorsOmitted = errors.length - shownErrors.length + (load.errorsOmitted ?? 0);
  const failed =
    errors.length === 0 && (load.errorsOmitted ?? 0) === 0
      ? '失敗の報告は無い'
      : `失敗 ${errors.length + (load.errorsOmitted ?? 0)} 件 — ${shownErrors.join(' / ')}` +
        `${errorsOmitted > 0 ? `（ほか ${errorsOmitted} 件は省いた）` : ''}`;

  return {
    text: `init が知らせた plugin の読み込み結果: 読み込めた plugin: ${loaded}。読み込みの失敗: ${failed}`,
    digest: JSON.stringify([shownNames, namesOmitted, shownErrors, errorsOmitted]),
  };
}
