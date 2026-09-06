import { stdout } from 'node:process';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';

/**
 * `alteroid access` — 誰が alteroid を使えるかを決める。
 *
 * **持つのは許可されているか否かの2値だけである。** 「chat は可・記憶の編集は不可」
 * のような行為別のスコープを足したくなったら手を止める — それは PRD「権限境界」が
 * 禁じている「確認が要る行為の一覧」と同じ形であり、クローンが記憶で下すべき判断を
 * 設定で置き換えることになる。ここが決めるのは入口を通すか否かだけで、通った後に
 * 何を人間へ確認するかはクローンの判断のままである。
 *
 * 叩けるのは**実行環境の持ち主**（`~/.alteroid/state/daemon.json` を読める者）だけ。
 * これが「最初の1人を誰が通すか」の答えでもある。
 *
 * **許可できるアカウントは高々1つ。** alteroid は単一の持ち主のものであり、
 * マルチユーザー / チーム利用は非ゴールである（docs/PRD.md「スコープ外」）。
 * 持ち主を移すときは先に `revoke` する。
 */

interface AccountView {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  grantedAt: string | null;
  granted: boolean;
  identities: { provider: string; email: string | null; lastLoginAt: string }[];
}

export async function accessListCommand(): Promise<void> {
  const target = await resolveTarget();
  const { accounts } = (await request(target, '/access')) as { accounts: AccountView[] };

  if (accounts.length === 0) {
    stdout.write('まだ誰もログインしていません。\n');
    return;
  }

  for (const account of accounts) {
    const name = account.email ?? account.displayName ?? '(名前なし)';
    stdout.write(`${account.granted ? '[許可]' : '[未許可]'} ${name}\n`);
    stdout.write(`  id: ${account.id}\n`);
    // **作成（`createdAt`）を足す。** `AccountView` は元から持っていて（型に
    // 在る）、ここが出していなかっただけである（#214）。`createdAt` は必須
    // なので null チェックは要らない。
    stdout.write(`  作成: ${account.createdAt}\n`);
    const via = account.identities
      .map(
        (identity) =>
          `${identity.provider}${identity.email === null ? '' : ` (${identity.email})`}`,
      )
      .join(', ');
    if (via.length > 0) stdout.write(`  ログイン手段: ${via}\n`);
    if (account.lastLoginAt !== null) stdout.write(`  最終ログイン: ${account.lastLoginAt}\n`);
    if (account.grantedAt !== null) stdout.write(`  許可した日時: ${account.grantedAt}\n`);
    stdout.write('\n');
  }

  const owner = accounts.find((account) => account.granted);
  const pending = accounts.filter((account) => !account.granted);
  if (owner === undefined && pending.length > 0) {
    stdout.write(`許可するには: alteroid access grant ${pending[0]?.id ?? '<id>'}\n`);
  } else if (owner !== undefined && pending.length > 0) {
    // 「なぜ grant できないのか」を先に言う。叩いてから 409 で知るのは遅い。
    stdout.write(
      '許可できるアカウントは1つだけです（alteroid は単一の持ち主のもの）。\n' +
        `移すには先に取り消します: alteroid access revoke ${owner.id}\n`,
    );
  }
}

export async function accessGrantCommand(accountId: string): Promise<void> {
  const target = await resolveTarget();
  const { account } = (await request(target, `/access/${encodeURIComponent(accountId)}/grant`, {
    method: 'POST',
  })) as { account: AccountView };
  stdout.write(`許可しました: ${account.email ?? account.displayName ?? account.id}\n`);
}

export async function accessRevokeCommand(accountId: string): Promise<void> {
  const target = await resolveTarget();
  const { account } = (await request(target, `/access/${encodeURIComponent(accountId)}/revoke`, {
    method: 'POST',
  })) as { account: AccountView };
  stdout.write(`許可を取り消しました: ${account.email ?? account.displayName ?? account.id}\n`);
  // 発行済みトークンは消していないが、許可はリクエストごとに見ているので即座に
  // 通らなくなる。消し忘れたトークンが生き残らないのが要点。
  stdout.write('（発行済みのトークンは、この時点から通らなくなります）\n');
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    // 本文の無い POST もデーモンは application/json を要求する（ブラウザの
    // 単純リクエストで他人が許可を書き換えられないようにするため）。
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // **`target.remote` から推測しない。** 遠隔のデーモンでも、叩いているのが
    // 実行環境の持ち主でないという理由で 403 が返ることはある（`access grant`
    // 済みのアカウントを別の環境から使っている場合など）。`remote` で場合分け
    // すると、その状況でも「access grant してください」という直らない案内を
    // 出してしまう（`access grant` を打った本人に `access grant` を勧める形に
    // なる）。本文で判別する。
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_operator') {
        throw new Error(
          'このデーモンの実行環境の持ち主として認識されませんでした。\n' +
            'デーモンが動いているのと同じ環境（コンテナなら docker compose exec app …）で実行してください。',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // **⭐ `kind === 'unknown'`——本文からはどちらの理由かが判別できない。**
      // 「器の中で実行しろ」と「access grant しろ」は意味も解決策も正反対で、
      // どちらかを当てずっぽうで出せば半分の状況では必ず嘘になる。分からない
      // ときは、解決策を書かずに止める。
      throw new Error(
        'アクセス許可の操作が拒否されました（403）。理由を判別できなかったため、' +
          '次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    if (response.status === 404) throw new Error('該当するアカウントがありません');
    if (response.status === 409) {
      // 単一の持ち主という不変条件。人間には「次に何をすればよいか」まで見せる。
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        typeof body.error === 'string' ? body.error : '既に別のアカウントが許可されています',
      );
    }
    throw new Error(`${path} が失敗しました (${response.status})`);
  }
  return response.json();
}
