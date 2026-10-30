import {
  PLUGIN_NAME_PATTERN,
  PLUGIN_NAME_RULE,
  PLUGIN_SHA_PATTERN,
  PLUGIN_SHA_RULE,
  validatePluginFilePath,
  validatePluginRepoUrl,
  validatePluginSourceRef,
} from '@alteroid/core/plugin-source-input';
import type { PluginPreviewRequest } from '@alteroid/logic';

// plugin の取り元の指定を送る前に、daemon の zod スキーマが組まれている元の規則（core の plugin-source-input）で、欄ごとに形を見る。
// 規則そのもの（名前の字種・URL・path・ref・SHA）は web に写さない。ここが作るのは、どの欄がどう違うかの文だけ。
// 欄の名前は画面の欄の名前にそろえる。core の理由の文（日本語）は、そのまま添える
const FIELD = {
  plugin: { label: 'plugin 名', usable: '公式 marketplace の plugin 名を、そのまま書く' },
  url: { label: 'リポジトリの URL', usable: 'https の URL で、資格・クエリ・# を含めずに書く' },
  path: { label: 'path', usable: 'リポジトリの中のディレクトリを、/ 区切りの相対パスで書く' },
  ref: { label: 'ref', usable: 'ブランチ・タグの名前を、空白や先頭の - を含めずに書く' },
  sha: { label: 'sha', usable: '小文字40桁の commit SHA を書く（ブランチ・タグは ref へ）' },
};

function say(field: keyof typeof FIELD, reason: string): string {
  const { label, usable } = FIELD[field];
  return `「${label}」が使えない形: ${reason}。${usable}（何も送っていない）`;
}

// 送らずに止めるときの直し方の文。形に合っていれば undefined
export function describePluginSourceProblem(request: PluginPreviewRequest): string | undefined {
  if (request.kind === 'marketplace') {
    return PLUGIN_NAME_PATTERN.test(request.plugin) ? undefined : say('plugin', PLUGIN_NAME_RULE);
  }
  const url = validatePluginRepoUrl(request.url);
  if (url !== null) return say('url', url);
  if (request.path !== undefined) {
    const path = validatePluginFilePath(request.path);
    if (path !== null) return say('path', path);
  }
  if (request.ref !== undefined) {
    const ref = validatePluginSourceRef(request.ref);
    if (ref !== null) return say('ref', ref);
  }
  if (request.sha !== undefined && !PLUGIN_SHA_PATTERN.test(request.sha)) {
    return say('sha', PLUGIN_SHA_RULE);
  }
  return undefined;
}
