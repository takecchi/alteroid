import type { PluginPreviewRequest } from './types.js';

// 形の検査の正本はデーモン（pluginRepoUrlSchema ほか）。ここは CLI（apps/cli/src/plugin.ts）と同じ
// 「何も送らずに弾く」手前の検査だけを持つ。@alteroid/core の値は Web から import できないため写してある。

export interface PluginSourceForm {
  kind: 'marketplace' | 'url';
  plugin: string;
  url: string;
  path: string;
  ref: string;
  sha: string;
}

export function emptyPluginSourceForm(): PluginSourceForm {
  return { kind: 'marketplace', plugin: '', url: '', path: '', ref: '', sha: '' };
}

export type PluginSourceParse =
  { ok: true; request: PluginPreviewRequest } | { ok: false; error: string };

const BAD_SOURCE =
  '取り元は https の URL か、公式 marketplace の plugin 名で指定すること（何も送っていない）';

export function parsePluginSource(form: PluginSourceForm): PluginSourceParse {
  const plugin = form.plugin.trim();
  const url = form.url.trim();
  const path = form.path.trim();
  const ref = form.ref.trim();
  const sha = form.sha.trim();

  if (form.kind === 'url') {
    if (!/^https:\/\//i.test(url)) return { ok: false, error: BAD_SOURCE };
    if (sha !== '' && !/^[0-9a-f]{40}$/.test(sha)) {
      return {
        ok: false,
        error:
          'sha は小文字40桁の commit SHA で指定すること。ブランチ・タグは ref で指定する（取得時に一度だけ SHA へ解決して固定する）',
      };
    }
    return {
      ok: true,
      request: {
        kind: 'url',
        url,
        ...(path === '' ? {} : { path }),
        ...(ref === '' ? {} : { ref }),
        ...(sha === '' ? {} : { sha }),
      },
    };
  }

  if (plugin === '' || /:\/\/|^git@|^[^\s]*\//.test(plugin)) {
    return { ok: false, error: BAD_SOURCE };
  }
  if (path !== '' || ref !== '' || sha !== '') {
    return {
      ok: false,
      error:
        'marketplace の plugin には path・sha・ref を添えられない（実体の取り元と SHA は marketplace の索引から解決する）',
    };
  }
  return { ok: true, request: { kind: 'marketplace', plugin } };
}

// 事前入力は欄を埋めるだけ: 検査も送信も、人が押したときに手で打った入力と同じ道を通すため
export function parsePluginPrefill(query: URLSearchParams): PluginSourceForm | null {
  const marketplace = query.get('marketplace');
  const url = query.get('url');
  if (marketplace === null && url === null) return null;
  return {
    kind: marketplace !== null ? 'marketplace' : 'url',
    plugin: marketplace ?? '',
    url: url ?? '',
    path: query.get('path') ?? '',
    ref: query.get('ref') ?? '',
    sha: query.get('sha') ?? '',
  };
}
