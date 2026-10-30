import { pluginPreviewRequestSchema } from '@alteroid/core/plugin-source-input';
import type { PluginPreviewRequest } from '@alteroid/logic';

// plugin の取り元の指定を送る前に、daemon が使うのと同じ core のスキーマ（pluginPreviewRequestSchema）で形を見る。
// 規則は core のスキーマそのもの（名前の字種・URL・path・ref・SHA の規則を web に写さない）。ここが作るのは、どの欄がどう違うかの文だけ。
// 欄の名前は画面の欄の名前（PluginSourceForm の入力欄の表示）にそろえる。core の理由の文（日本語）は、そのまま添える
const FIELD_LABEL: Record<string, { label: string; usable: string }> = {
  plugin: { label: 'plugin 名', usable: '公式 marketplace の plugin 名を、そのまま書く' },
  url: { label: 'リポジトリの URL', usable: 'https の URL で、資格・クエリ・# を含めずに書く' },
  path: { label: 'path', usable: 'リポジトリの中のディレクトリを、/ 区切りの相対パスで書く' },
  ref: { label: 'ref', usable: 'ブランチ・タグの名前を、空白や先頭の - を含めずに書く' },
  sha: { label: 'sha', usable: '小文字40桁の commit SHA を書く（ブランチ・タグは ref へ）' },
};

// 送らずに止めるときの直し方の文。形に合っていれば undefined
export function describePluginSourceProblem(request: PluginPreviewRequest): string | undefined {
  const result = pluginPreviewRequestSchema.safeParse(request);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  const key = issue?.path[0];
  const field = typeof key === 'string' ? FIELD_LABEL[key] : undefined;
  if (issue === undefined || field === undefined) {
    return '取り元の指定が使えない形（何も送っていない）';
  }
  return `「${field.label}」が使えない形: ${issue.message}。${field.usable}（何も送っていない）`;
}
