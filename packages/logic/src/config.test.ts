// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeConnection,
  hasStoredApiBaseUrl,
  listEndpoints,
  looksLikeUrl,
  migrateSelectionIntoStoredEndpoints,
  parseBuildTimeEndpoints,
  readStoredEndpoints,
  resolveApiBaseUrl,
  resolveApiBaseUrlOrigin,
  SAME_ORIGIN_BASE_URL,
  sanitizeEndpoints,
  storeApiBaseUrl,
  storeEndpoints,
  upsertEndpoint,
  withoutEndpoint,
} from './config.js';

describe('describeConnection', () => {
  const PAGE = 'https://app.example.com/chat';

  it('名前の付いた接続先なら、その名前を出す（title は名前と URL）', () => {
    const endpoints = listEndpoints(
      [{ url: 'https://home.example.com:8787', label: '自宅' }],
      undefined,
      'https://home.example.com:8787',
    );
    expect(describeConnection(endpoints, 'https://home.example.com:8787', PAGE)).toEqual({
      name: '自宅',
      title: '自宅 — https://home.example.com:8787',
    });
  });

  it('名前が無ければホスト名（ポート込み）に倒す', () => {
    const endpoints = listEndpoints([], undefined, 'http://localhost:8787');
    expect(describeConnection(endpoints, 'http://localhost:8787', PAGE)).toEqual({
      name: 'localhost:8787',
      title: 'http://localhost:8787',
    });
  });

  it('一覧に載っていない接続先でもホスト名を出す', () => {
    expect(describeConnection([], 'https://other.example.com/', PAGE)).toEqual({
      name: 'other.example.com',
      title: 'https://other.example.com',
    });
  });

  it('同一オリジン（/api）は画面のホストを出す', () => {
    const endpoints = listEndpoints([], undefined, null);
    expect(describeConnection(endpoints, SAME_ORIGIN_BASE_URL, PAGE)).toEqual({
      name: 'app.example.com',
      title: 'https://app.example.com/api',
    });
  });

  it('ビルド時に名前の付いた既定の接続先も、その名前を出す', () => {
    const endpoints = listEndpoints([], '本番=https://api.example.com', null);
    expect(describeConnection(endpoints, 'https://api.example.com', PAGE).name).toBe('本番');
  });

  it('画面の場所が分からず相対の URL を解けないときは、URL をそのまま出す', () => {
    expect(describeConnection([], '/api', null)).toEqual({ name: '/api', title: '/api' });
  });

  it('既定では画面の場所（location.href）を基準に解く', () => {
    expect(describeConnection([], '/api').name).toBe(window.location.host);
  });
});

describe('resolveApiBaseUrl', () => {
  it('何も無ければ同一オリジンに落ちる', () => {
    expect(resolveApiBaseUrl(null, undefined)).toBe(SAME_ORIGIN_BASE_URL);
  });

  it('ビルド時の値を使う', () => {
    expect(resolveApiBaseUrl(null, 'https://api.example.com')).toBe('https://api.example.com');
  });

  it('人間が設定した値がビルド時の値に勝つ', () => {
    expect(resolveApiBaseUrl('http://127.0.0.1:4517', 'https://api.example.com')).toBe(
      'http://127.0.0.1:4517',
    );
  });

  it('末尾のスラッシュを落とす（経路の連結で // にしないため）', () => {
    expect(resolveApiBaseUrl('https://api.example.com/', undefined)).toBe(
      'https://api.example.com',
    );
  });

  it('空白だけの値は未設定として扱う', () => {
    expect(resolveApiBaseUrl('   ', 'https://api.example.com')).toBe('https://api.example.com');
    expect(resolveApiBaseUrl('   ', '  ')).toBe(SAME_ORIGIN_BASE_URL);
  });
});

describe('resolveApiBaseUrlOrigin', () => {
  it('何も無ければ同一オリジン（sameOrigin）', () => {
    expect(resolveApiBaseUrlOrigin(null, undefined)).toBe('sameOrigin');
  });

  it('ビルド時の値だけがあれば buildTime', () => {
    expect(resolveApiBaseUrlOrigin(null, 'https://api.example.com')).toBe('buildTime');
  });

  it('人間が設定した値があれば stored（ビルド時の値があっても勝つ）', () => {
    expect(resolveApiBaseUrlOrigin('http://127.0.0.1:4517', 'https://api.example.com')).toBe(
      'stored',
    );
  });

  it('空白だけの保存値は「未設定」として扱う（sameOrigin まで倒れる）', () => {
    expect(resolveApiBaseUrlOrigin('   ', undefined)).toBe('sameOrigin');
    expect(resolveApiBaseUrlOrigin('   ', 'https://api.example.com')).toBe('buildTime');
  });
});

describe('hasStoredApiBaseUrl / storeApiBaseUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('何も保存していなければ false', () => {
    expect(hasStoredApiBaseUrl()).toBe(false);
  });

  it('保存すると true になる', () => {
    storeApiBaseUrl('http://127.0.0.1:4517');
    expect(hasStoredApiBaseUrl()).toBe(true);
  });

  it('storeApiBaseUrl(null) で消える（「既定に戻す」の中身）', () => {
    storeApiBaseUrl('http://127.0.0.1:4517');
    expect(hasStoredApiBaseUrl()).toBe(true);

    storeApiBaseUrl(null);
    expect(hasStoredApiBaseUrl()).toBe(false);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
  });
});

describe('parseBuildTimeEndpoints', () => {
  it('未設定なら空（0件）', () => {
    expect(parseBuildTimeEndpoints(undefined)).toEqual([]);
    expect(parseBuildTimeEndpoints('')).toEqual([]);
    expect(parseBuildTimeEndpoints('   ')).toEqual([]);
  });

  it('1つだけの形は今までどおり（後方互換の本体）', () => {
    expect(parseBuildTimeEndpoints('https://api.example.com')).toEqual([
      { url: 'https://api.example.com' },
    ]);
  });

  it('カンマ区切りで複数。並べた順がそのまま優先順位になる', () => {
    expect(parseBuildTimeEndpoints('https://api.example.com,http://127.0.0.1:4517')).toEqual([
      { url: 'https://api.example.com' },
      { url: 'http://127.0.0.1:4517' },
    ]);
  });

  it('改行でも区切れる（ホスティングの複数行入力欄に貼れるように）', () => {
    expect(parseBuildTimeEndpoints('https://a.example.com\nhttps://b.example.com')).toEqual([
      { url: 'https://a.example.com' },
      { url: 'https://b.example.com' },
    ]);
  });

  it('`ラベル=URL` で名前を付けられる', () => {
    expect(
      parseBuildTimeEndpoints('本番=https://api.example.com,ローカル=http://127.0.0.1:4517'),
    ).toEqual([
      { url: 'https://api.example.com', label: '本番' },
      { url: 'http://127.0.0.1:4517', label: 'ローカル' },
    ]);
  });

  it('同一オリジンの経路（/ で始まる）にも名前を付けられる', () => {
    expect(parseBuildTimeEndpoints('手前のproxy=/api')).toEqual([
      { url: '/api', label: '手前のproxy' },
    ]);
  });

  it('URL に = が入っていても切らない（右側が URL に見えるときだけラベルとして読む）', () => {
    expect(parseBuildTimeEndpoints('https://api.example.com/?x=1')).toEqual([
      { url: 'https://api.example.com/?x=1' },
    ]);
  });

  it('空白と末尾のスラッシュを落とす（経路の連結で // にしないため）', () => {
    expect(parseBuildTimeEndpoints('  本番 = https://api.example.com/ ,  ')).toEqual([
      { url: 'https://api.example.com', label: '本番' },
    ]);
  });

  it('同じ URL が2度書かれていても1行にする（先に書いたほうが残る）', () => {
    expect(
      parseBuildTimeEndpoints('本番=https://api.example.com,別名=https://api.example.com'),
    ).toEqual([{ url: 'https://api.example.com', label: '本番' }]);
  });

  it('ビルド時の値が複数でも、既定になるのは先頭だけ（resolveApiBaseUrl と対）', () => {
    const raw = '本番=https://api.example.com,ローカル=http://127.0.0.1:4517';
    expect(resolveApiBaseUrl(null, raw)).toBe('https://api.example.com');
    expect(resolveApiBaseUrlOrigin(null, raw)).toBe('buildTime');
  });
});

describe('looksLikeUrl', () => {
  it('スキーム付きと、/ で始まる経路だけを受け入れる', () => {
    expect(looksLikeUrl('https://api.example.com')).toBe(true);
    expect(looksLikeUrl('http://127.0.0.1:4517')).toBe(true);
    expect(looksLikeUrl('/api')).toBe(true);
  });

  it('ホスト名だけ・空・ラベルらしきものは受け入れない', () => {
    expect(looksLikeUrl('example.com')).toBe(false);
    expect(looksLikeUrl('1')).toBe(false);
    expect(looksLikeUrl('')).toBe(false);
  });
});

describe('listEndpoints', () => {
  it('ビルド時 → 同一オリジン → このブラウザに保存、の順に並ぶ', () => {
    const entries = listEndpoints(
      [{ url: 'https://saved.example.com', label: '手で足した' }],
      '本番=https://api.example.com',
      null,
    );
    expect(entries).toEqual([
      { url: 'https://api.example.com', label: '本番', origin: 'buildTime' },
      { url: SAME_ORIGIN_BASE_URL, origin: 'sameOrigin' },
      { url: 'https://saved.example.com', label: '手で足した', origin: 'stored' },
    ]);
  });

  it('ビルド時の値が無くても、同一オリジンは必ず選択肢に在る', () => {
    expect(listEndpoints([], undefined, null)).toEqual([
      { url: SAME_ORIGIN_BASE_URL, origin: 'sameOrigin' },
    ]);
  });

  it('同じ URL は1行だけ。先に出た段（ビルド時）が勝つ', () => {
    const entries = listEndpoints(
      [{ url: 'https://api.example.com', label: '保存側の名前' }],
      '本番=https://api.example.com',
      null,
    );
    expect(entries).toEqual([
      { url: 'https://api.example.com', label: '本番', origin: 'buildTime' },
      { url: SAME_ORIGIN_BASE_URL, origin: 'sameOrigin' },
    ]);
  });

  it('一覧に無い接続先を選んでいても、その先が一覧に出る', () => {
    const entries = listEndpoints([], undefined, 'http://console-set.example');
    expect(entries).toEqual([
      { url: SAME_ORIGIN_BASE_URL, origin: 'sameOrigin' },
      { url: 'http://console-set.example', origin: 'stored' },
    ]);
  });

  it('選んでいる先が既に一覧に在れば、二重には出さない', () => {
    const entries = listEndpoints(
      [{ url: 'https://saved.example.com' }],
      undefined,
      'https://saved.example.com',
    );
    expect(entries.filter((entry) => entry.url === 'https://saved.example.com')).toHaveLength(1);
  });
});

describe('upsertEndpoint / withoutEndpoint', () => {
  it('新しい URL は末尾に足す', () => {
    expect(
      upsertEndpoint([{ url: 'https://a.example.com' }], { url: 'https://b.example.com' }),
    ).toEqual([{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }]);
  });

  it('同じ URL なら名前を差し替える。順番は変えない', () => {
    const list = [
      { url: 'https://a.example.com' },
      { url: 'https://b.example.com' },
      { url: 'https://c.example.com' },
    ];
    expect(upsertEndpoint(list, { url: 'https://b.example.com', label: '検証' })).toEqual([
      { url: 'https://a.example.com' },
      { url: 'https://b.example.com', label: '検証' },
      { url: 'https://c.example.com' },
    ]);
  });

  it('名前を空にすると label が消える（空文字を持ったままにしない）', () => {
    expect(
      upsertEndpoint([{ url: 'https://a.example.com', label: '本番' }], {
        url: 'https://a.example.com',
        label: '  ',
      }),
    ).toEqual([{ url: 'https://a.example.com' }]);
  });

  it('末尾のスラッシュ違いを別物として足さない', () => {
    expect(
      upsertEndpoint([{ url: 'https://a.example.com' }], { url: 'https://a.example.com/' }),
    ).toEqual([{ url: 'https://a.example.com' }]);
  });

  it('withoutEndpoint は末尾のスラッシュ違いでも落とせる', () => {
    expect(
      withoutEndpoint(
        [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
        'https://a.example.com/',
      ),
    ).toEqual([{ url: 'https://b.example.com' }]);
  });
});

describe('sanitizeEndpoints', () => {
  it('形の違う行を落とし、読めた行は残す', () => {
    expect(
      sanitizeEndpoints([
        { url: 'https://a.example.com', label: '本番' },
        { url: 42 },
        null,
        'https://string.example.com',
        { label: '名前だけ' },
        { url: '   ' },
        { url: 'https://b.example.com/', label: '   ' },
      ]),
    ).toEqual([{ url: 'https://a.example.com', label: '本番' }, { url: 'https://b.example.com' }]);
  });

  it('同じ URL を2行持たせない（片方を消しても消えたように見えないため）', () => {
    expect(
      sanitizeEndpoints([{ url: 'https://a.example.com' }, { url: 'https://a.example.com/' }]),
    ).toEqual([{ url: 'https://a.example.com' }]);
  });
});

describe('readStoredEndpoints / storeEndpoints', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('何も無ければ空', () => {
    expect(readStoredEndpoints()).toEqual([]);
  });

  it('書いたものが読める', () => {
    storeEndpoints([{ url: 'https://a.example.com', label: '本番' }]);
    expect(readStoredEndpoints()).toEqual([{ url: 'https://a.example.com', label: '本番' }]);
  });

  it('JSON として壊れていても投げない（空に倒れる）', () => {
    localStorage.setItem('alteroid.endpoints', '{壊れている');
    expect(readStoredEndpoints()).toEqual([]);
  });

  it('配列でないものが入っていても投げない', () => {
    localStorage.setItem('alteroid.endpoints', '{"url":"https://a.example.com"}');
    expect(readStoredEndpoints()).toEqual([]);
  });
});

describe('migrateSelectionIntoStoredEndpoints', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('選択だけがある状態から、一覧へ写す', () => {
    localStorage.setItem('alteroid.apiBaseUrl', 'http://console-set.example');
    migrateSelectionIntoStoredEndpoints();
    expect(readStoredEndpoints()).toEqual([{ url: 'http://console-set.example' }]);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('http://console-set.example');
  });

  it('何度呼んでも増えない（冪等。StrictMode が初期化子を2度呼ぶため）', () => {
    localStorage.setItem('alteroid.apiBaseUrl', 'http://console-set.example');
    migrateSelectionIntoStoredEndpoints();
    migrateSelectionIntoStoredEndpoints();
    migrateSelectionIntoStoredEndpoints();
    expect(readStoredEndpoints()).toEqual([{ url: 'http://console-set.example' }]);
  });

  it('既に一覧に在るものは写さない（名前を付けた行を無名で上書きしない）', () => {
    storeEndpoints([{ url: 'http://console-set.example', label: '手で足した' }]);
    localStorage.setItem('alteroid.apiBaseUrl', 'http://console-set.example');
    migrateSelectionIntoStoredEndpoints();
    expect(readStoredEndpoints()).toEqual([
      { url: 'http://console-set.example', label: '手で足した' },
    ]);
  });

  it('選択が無ければ何もしない', () => {
    migrateSelectionIntoStoredEndpoints();
    expect(localStorage.getItem('alteroid.endpoints')).toBeNull();
  });

  it('同一オリジンは写さない（一覧の別の段が持っている）', () => {
    localStorage.setItem('alteroid.apiBaseUrl', SAME_ORIGIN_BASE_URL);
    migrateSelectionIntoStoredEndpoints();
    expect(readStoredEndpoints()).toEqual([]);
  });
});
