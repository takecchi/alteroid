import { describe, expect, it } from 'vitest';

import {
  emptyPluginSourceForm,
  parsePluginPrefill,
  parsePluginSource,
  type PluginSourceForm,
} from './plugin-source.js';

const SHA = 'a'.repeat(40);

function form(patch: Partial<PluginSourceForm>): PluginSourceForm {
  return { ...emptyPluginSourceForm(), ...patch };
}

describe('parsePluginSource（CLI の buildPreviewRequest と同じ規則）', () => {
  it('marketplace は plugin 名だけを送る', () => {
    expect(parsePluginSource(form({ kind: 'marketplace', plugin: ' demo-plugin ' }))).toEqual({
      ok: true,
      request: { kind: 'marketplace', plugin: 'demo-plugin' },
    });
  });

  it('marketplace に path / ref / sha は添えられない', () => {
    for (const patch of [{ path: 'a/b' }, { ref: 'main' }, { sha: SHA }]) {
      const result = parsePluginSource(form({ kind: 'marketplace', plugin: 'demo', ...patch }));
      expect(result.ok).toBe(false);
    }
  });

  it('marketplace の名前に URL・git@・owner/repo を入れると弾く', () => {
    for (const plugin of ['http://x/y', 'https://x/y', 'git@github.com:o/r', 'owner/repo', '']) {
      expect(parsePluginSource(form({ kind: 'marketplace', plugin })).ok).toBe(false);
    }
  });

  it('url は https だけ。path・ref・sha は入れたものだけ送る', () => {
    expect(
      parsePluginSource(
        form({ kind: 'url', url: 'https://example.com/o/r.git', path: 'plugins/a', ref: 'v1' }),
      ),
    ).toEqual({
      ok: true,
      request: { kind: 'url', url: 'https://example.com/o/r.git', path: 'plugins/a', ref: 'v1' },
    });
    expect(
      parsePluginSource(form({ kind: 'url', url: 'https://example.com/o/r', sha: SHA })),
    ).toEqual({ ok: true, request: { kind: 'url', url: 'https://example.com/o/r', sha: SHA } });
  });

  it('url に http・git@・owner/repo・空を入れると弾く', () => {
    for (const url of ['http://example.com/o/r', 'git@github.com:o/r.git', 'owner/repo', '']) {
      expect(parsePluginSource(form({ kind: 'url', url })).ok).toBe(false);
    }
  });

  it('sha は小文字40桁だけ（ブランチ・短縮・大文字は弾く）', () => {
    for (const sha of ['main', 'abc1234', SHA.toUpperCase(), `${SHA}0`]) {
      expect(parsePluginSource(form({ kind: 'url', url: 'https://example.com/o/r', sha })).ok).toBe(
        false,
      );
    }
  });
});

describe('parsePluginPrefill（クエリでの事前入力）', () => {
  it('何も無ければ null', () => {
    expect(parsePluginPrefill(new URLSearchParams(''))).toBeNull();
    expect(parsePluginPrefill(new URLSearchParams('foo=bar'))).toBeNull();
  });

  it('?marketplace= は marketplace の入力にする', () => {
    expect(parsePluginPrefill(new URLSearchParams('marketplace=demo'))).toEqual(
      form({ kind: 'marketplace', plugin: 'demo' }),
    );
  });

  it('?url=&path=&ref=&sha= は url の入力にする', () => {
    const query = new URLSearchParams({
      url: 'https://example.com/o/r',
      path: 'p',
      ref: 'main',
      sha: SHA,
    });
    expect(parsePluginPrefill(query)).toEqual(
      form({ kind: 'url', url: 'https://example.com/o/r', path: 'p', ref: 'main', sha: SHA }),
    );
  });

  it('事前入力の値も同じ検査に落ちる（検査を通さず送る道は無い）', () => {
    const bad = parsePluginPrefill(new URLSearchParams({ url: 'http://example.com/o/r' }));
    expect(bad).not.toBeNull();
    expect(parsePluginSource(bad ?? emptyPluginSourceForm()).ok).toBe(false);
    const mixed = parsePluginPrefill(new URLSearchParams('marketplace=demo&sha=' + SHA));
    expect(parsePluginSource(mixed ?? emptyPluginSourceForm()).ok).toBe(false);
  });
});
