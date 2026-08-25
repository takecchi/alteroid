// @vitest-environment jsdom
/**
 * `/tokens` — 認証トークンのプール一覧・回転の設定・回転の履歴を見る画面。
 *
 * ここで固定したいのは「読み取り専用」「値は絶対に出さない」「4状態を潰さない」
 * 「不明と、そもそも無いを混ぜない」「冷却は原文と絶対時刻の両方を出す」
 * 「403 に専用の文言がある」の各点。文言の細部より、この規律が壊れていないかを見る。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatDateTime } from '~/lib/format';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const DEFAULT_SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };

/**
 * `/tokens` と `/journal` の両方をまとめて配る。
 *
 * この画面は2つの経路（`GET /tokens` / `GET /journal?type=token_rotation`）を
 * 同時に叩くので、どちらも知らないと `stubFetch` が「知らない URL」として
 * reject してしまう。
 */
function stubScreen(options: {
  tokens?: unknown[];
  settings?: unknown;
  tokensStatus?: number;
  journalEntries?: unknown[];
}) {
  const {
    tokens = [],
    settings = DEFAULT_SETTINGS,
    tokensStatus = 200,
    journalEntries = [],
  } = options;
  return stubFetch((url) => {
    if (url.includes('/tokens')) {
      return tokensStatus === 200
        ? json({ tokens, settings })
        : json({ error: '実行環境の持ち主だけが操作できる' }, tokensStatus);
    }
    if (url.includes('/journal')) return json({ entries: journalEntries });
    return undefined;
  });
}

async function waitForPoolLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: 'プール一覧' });
}

describe('/tokens 画面 — プールの4状態', () => {
  it('使用可能・冷却中・無効化済み・失効を、それぞれ区別して出す', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    stubScreen({
      tokens: [
        { id: 't-ready', label: 'ready-token', order: 0, sha256: 'a'.repeat(12), source: 'stored' },
        {
          id: 't-cooling',
          label: 'cooling-token',
          order: 1,
          sha256: 'b'.repeat(12),
          source: 'stored',
          cooldownUntil: future,
        },
        {
          id: 't-disabled',
          label: 'disabled-token',
          order: 2,
          sha256: 'c'.repeat(12),
          source: 'stored',
          disabledAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 't-invalidated',
          label: 'invalidated-token',
          order: 3,
          sha256: 'd'.repeat(12),
          source: 'stored',
          invalidatedAt: '2026-08-02T00:00:00.000Z',
          invalidatedReason: 'account suspended',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    expect(screen.getByText('使用可能')).toBeTruthy();
    expect(screen.getByText('冷却中')).toBeTruthy();
    expect(screen.getByText('無効化済み（人間が外した。戻らない）')).toBeTruthy();
    expect(screen.getByText('失効（通らないと確定。人間が外すまで戻らない）')).toBeTruthy();
    // 4状態が4つとも別の label に付いていること（同じトークンに畳まれていない）。
    expect(screen.getByText('ready-token')).toBeTruthy();
    expect(screen.getByText('cooling-token')).toBeTruthy();
    expect(screen.getByText('disabled-token')).toBeTruthy();
    expect(screen.getByText('invalidated-token')).toBeTruthy();
  });
});

describe('/tokens 画面 — 値を絶対に出さない', () => {
  it('応答に value を混ぜても、画面のどこにも出ない', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-leak',
          label: 'leaky-token',
          order: 0,
          sha256: 'a'.repeat(12),
          source: 'stored',
          // **本来サーバは value を返さない。** それでも「返ってきたら画面が
          // うっかり描く」形になっていないかを、ここで直接確かめる。
          value: 'sk-ant-oat01-super-secret-value-should-never-render',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    expect(screen.queryByText(/sk-ant-oat01-super-secret-value-should-never-render/)).toBeNull();
    expect(document.body.textContent).not.toContain(
      'sk-ant-oat01-super-secret-value-should-never-render',
    );
  });
});

describe('/tokens 画面 — 不明と、そもそも無いを混ぜない', () => {
  it('source: env（sha256 無し）の行は「不明」ではなく「そもそも無い」と言う', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-env',
          label: 'env-token',
          order: 0,
          source: 'env',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    expect(screen.getByText(/環境変数由来のため指紋は無い/)).toBeTruthy();
    // 「不明」という言い方に潰していない（createdAt/updatedAt は与えてあるので
    // この行には他の理由で「不明」が出る余地も無い）。
    expect(screen.queryByText('不明')).toBeNull();
  });

  it('断られたことが一度も無い行は「断られた記録が無い」と言う（空文字や - で濁さない）', async () => {
    stubScreen({
      tokens: [{ id: 't-clean', label: 'clean-token', order: 0, sha256: 'e'.repeat(12) }],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();
    expect(screen.getByText('断られた記録が無い')).toBeTruthy();
  });
});

describe('/tokens 画面 — recovery（回復の見込み）を潰さない', () => {
  /**
   * `recovery: 'unknown'` は実装が持つ**正規の値**（「どちらとも言えない」）で
   * あって、「取れなかった」ではない。一方 `source: 'env'` の指紋欄は値を
   * 持たないので「そもそも無い」——こちらは PoolCard 側の別の理由による欠落
   * である。**この2つが将来同じ文言（例えば「不明」）へ潰れても、片方だけの
   * テストでは検知できない** ので、同じ描画の中に両方を置いて別々の文字列で
   * 出ることを見る。
   */
  it('recovery: unknown と source: env（指紋なし）が同じ描画の中で別々の文言のまま出る', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-recovery-unknown',
          label: 'recovery-unknown-token',
          order: 0,
          sha256: 'a'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'some previously unseen limit message',
          recovery: 'unknown',
        },
        {
          id: 't-env-2',
          label: 'env-token-2',
          order: 1,
          source: 'env',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    // **exact match。** 実装が「不明」のような共通の言い方へ潰すと、この
    // どちらの getByText も落ちる（見つからない、または曖昧に複数ヒットする）。
    const recoveryText = screen.getByText(
      '分類: どちらとも言えない（time でも action でもない。捨てる判断の根拠にしないこと）',
    );
    const fingerprintText = screen.getByText('（環境変数由来のため指紋は無い）');
    expect(recoveryText).toBeTruthy();
    expect(fingerprintText).toBeTruthy();
    // 別々の要素であること（1つのノードが両方の役目を兼ねていない）。
    expect(recoveryText).not.toBe(fingerprintText);
    // 潰れた合成文言（例:「不明」のような共通語だけ）に短縮されていないこと。
    expect(screen.queryByText('不明')).toBeNull();
  });

  it('time / action / unknown の3値が、それぞれ別の文言で出る', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-time',
          label: 'recovery-time-token',
          order: 0,
          sha256: 'b'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'resets in 5 hours',
          recovery: 'time',
        },
        {
          id: 't-action',
          label: 'recovery-action-token',
          order: 1,
          sha256: 'c'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'payment required',
          recovery: 'action',
        },
        {
          id: 't-unknown-2',
          label: 'recovery-unknown-token-2',
          order: 2,
          sha256: 'd'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'unrecognized message',
          recovery: 'unknown',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    expect(screen.getByText('分類: 時間で戻る見込み（リセットを待てば良い）')).toBeTruthy();
    expect(
      screen.getByText('分類: 人の対応が要る見込み（入金・管理者の設定・座席種別の変更など）'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '分類: どちらとも言えない（time でも action でもない。捨てる判断の根拠にしないこと）',
      ),
    ).toBeTruthy();
  });
});

describe('/tokens 画面 — 冷却は原文と絶対時刻の両方を出す', () => {
  it('cooldownUntil の絶対時刻と lastRejectedReason の原文が両方出る', async () => {
    // 実測で報告されている桁の食い違い（冷却は5時間なのに理由の原文は
    // 「weekly limit resets 5pm」）を再現する fixture。相対表現だけでは
    // この食い違いに気づけないので、絶対時刻が出ることを固定する。
    const cooldownUntil = Date.parse('2026-08-25T05:00:00.000Z');
    stubScreen({
      tokens: [
        {
          id: 't-mismatch',
          label: 'mismatch-token',
          order: 0,
          sha256: 'f'.repeat(12),
          cooldownUntil,
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'weekly limit resets 5pm',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitForPoolLoaded();

    const expectedAbsolute = formatDateTime(new Date(cooldownUntil).toISOString());
    expect(screen.getByText(new RegExp(expectedAbsolute.replace(/[/:]/g, '\\$&')))).toBeTruthy();
    expect(screen.getByText('weekly limit resets 5pm')).toBeTruthy();
  });
});

describe('/tokens 画面 — 空のプール', () => {
  it('プールが0件のとき、まだ1件も無いと言う（0件と未取得を混同しない）', async () => {
    stubScreen({ tokens: [] });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    expect(await screen.findByText(/登録された認証トークンがまだ1件も無い/)).toBeTruthy();
  });
});

describe('/tokens 画面 — 403', () => {
  it('実行環境の持ち主でなければ、専用の文言を出す（汎用のエラー表示に投げない）', async () => {
    stubScreen({ tokensStatus: 403 });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    expect(await screen.findByText(/実行環境の持ち主だけが見られる/)).toBeTruthy();
    expect(screen.getByText('alteroid token list')).toBeTruthy();
  });
});

describe('/tokens 画面 — 回転の履歴（エラー状況）', () => {
  it('journal の token_rotation が出る', async () => {
    stubScreen({
      tokens: [],
      journalEntries: [
        {
          type: 'token_rotation',
          id: 'jr-1',
          at: '2026-08-25T00:00:00.000Z',
          event: 'exhausted',
          earliestAt: '2026-08-25T05:00:00.000Z',
          text: '候補が無いので全層が止まった',
        },
      ],
    });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    expect(await screen.findByText('候補が無いので全層が止まった')).toBeTruthy();
    expect(screen.getByText('候補が無い（全層が止まる）')).toBeTruthy();
  });

  it('回転の記録が0件なら、その旨を言う', async () => {
    stubScreen({ tokens: [], journalEntries: [] });

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    expect(await screen.findByText('回転の記録がまだ1件も無い。')).toBeTruthy();
  });
});
