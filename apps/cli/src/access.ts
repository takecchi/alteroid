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
 * 叩けるのは**実行環境の持ち主**（`~/.alteroid/state/daemon.json` を読める者）と、
 * **alteroid を使う許可を得たアカウント**（2026-09-06 に同格にした）。
 *
 * **ただし「最初の1人」を通すのは必ず実行環境の持ち主である** — 誰も許可されて
 * いない状態では、許可されたアカウントという資格がそもそも存在しないからである。
 *
 * **許可できるアカウントの数に上限は無い**（2026-09-09 のオーナー決定。それ以前は
 * 高々1つで、2人目の grant は 409 だった）。同じ人間が複数の Google アカウントから
 * 入れる。**それでもマルチユーザーではない** — 利用者ごとにデータを分けないことが
 * 非ゴールの中身であり（docs/PRD.md「スコープ外」）、許可を持つ全員が同じ1組の
 * 記憶・日誌・会話を見る。使わせたくなくなったら `revoke` する。
 */

interface AccountView {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  grantedAt: string | null;
  /**
   * 誰が許可したか（`'operator'` か、許可を与えたアカウントの id）。表示は
   * `describeGrantedBy()` を通す。
   */
  grantedBy: string | null;
  granted: boolean;
  /**
   * 実行環境の持ち主として宣言された日時（issue #1198）。`null` なら未宣言。
   * 立てる／解くのは `alteroid access owner <id>` / `--revoke`
   * （`POST /access/:accountId/owner` / `.../owner/revoke`。`requireOperator`
   * で非伝播——許可されたアカウントからは叩けない）。宣言済みなら
   * `alteroid credential set` / `alteroid reset` が通る（`requireOwner`）。
   */
  ownerDeclaredAt: string | null;
  identities: { provider: string; email: string | null; lastLoginAt: string }[];
}

/**
 * `grantedBy` を人間が読む形にする。
 *
 * **Web UI の `describeGrantedBy()`（`apps/web/app/routes/access.tsx`）と同じ3分岐・
 * 同じ文言である。** 入口ごとに言い方が変わらないよう、片方を変えるならもう片方も
 * 変える（置き場所を共有するパッケージがまだ無いので、共通化はしていない）。
 * `'operator'` は実行環境の持ち主を表す固定の値で、それ以外は許可を与えた
 * アカウントの id である。id は名前へ解決しない——そのアカウントが一覧から既に
 * 消えていることがありうるため。
 */
function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
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
    // **宣言済みかどうかの印を足す**（issue #1198）。`[owner]` は
    // `ownerDeclaredAt !== null` のときだけ——`granted` とは独立の印である
    // （宣言は許可の上位互換ではなく別の資格なので、`[許可]` の隣に並べる）。
    stdout.write(
      `${account.granted ? '[許可]' : '[未許可]'}${account.ownerDeclaredAt !== null ? '[owner]' : ''} ${name}\n`,
    );
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
    // **誰が許可したかを日時の後ろに括弧で添える**（#1398 c7-3）。応答は元から
    // `grantedBy` を持っていて、Web UI（`apps/web/app/routes/access.tsx`）は
    // PR #1025 から同じ形で出している。ここが出していなかっただけである。
    if (account.grantedAt !== null) {
      stdout.write(
        `  許可した日時: ${account.grantedAt}（${describeGrantedBy(account.grantedBy)}）\n`,
      );
    }
    stdout.write(
      `  実行環境の持ち主として宣言: ${
        account.ownerDeclaredAt === null ? '（未宣言）' : account.ownerDeclaredAt
      }\n`,
    );
    stdout.write('\n');
  }

  const pending = accounts.filter((account) => !account.granted);
  if (pending.length > 0) {
    // ⚠️ **既に許可済みのアカウントが在るかで分岐しない。** 2026-09-09 のオーナー
    // 決定まで、ここは持ち主が居れば「許可できるアカウントは1つだけです。移すには
    // 先に取り消します」と案内していた（叩いてから 409 で知るのは遅いため）。
    // いまは何人でも通せるので、その案内は嘘になる。
    stdout.write(`許可するには: alteroid access grant ${pending[0]?.id ?? '<id>'}\n`);
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

/**
 * 実行環境の持ち主として宣言する／取り消す（issue #1198。本来の形）。
 *
 * **`POST /access/:accountId/owner`（宣言）/ `.../owner/revoke`（取り消し）
 * は `requireOperator`。** `grant` / `revoke` とは違い、許可されたアカウントの
 * トークンでは叩けない——旗を立てられる者を常にホストへ到達できる者へ限る
 * ことが「伝播しない」という性質そのものである（`apps/daemon/src/app.ts` の
 * `requireOwner` の doc）。だからここを実行するのは、デーモンが動いている
 * のと同じ環境（`docker compose exec app …`）だけである。
 *
 * 宣言できるのは対象のアカウントが**既に許可済み**のときだけ——未許可なら
 * サーバが 409 を返す（`AuthStore.setAccountOwner` の doc）。
 */
export async function accessOwnerCommand(
  accountId: string,
  options: { revoke?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  const path =
    options.revoke === true
      ? `/access/${encodeURIComponent(accountId)}/owner/revoke`
      : `/access/${encodeURIComponent(accountId)}/owner`;
  const { account } = (await request(target, path, { method: 'POST' })) as {
    account: AccountView;
  };
  const name = account.email ?? account.displayName ?? account.id;
  if (options.revoke === true) {
    stdout.write(`実行環境の持ち主としての宣言を取り消しました: ${name}\n`);
    stdout.write('（これで alteroid credential set / alteroid reset は通らなくなります）\n');
    return;
  }
  stdout.write(`実行環境の持ち主として宣言しました: ${name}\n`);
  stdout.write('（これで alteroid credential set / alteroid reset が通ります）\n');
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
      // ⚠️ **いまのデーモンはここを返さない**（2026-09-09 のオーナー決定で、許可
      // できるアカウントの上限が消えた）。**それでも残す** — `ALTEROID_URL` で
      // 繋ぐ先が古いデーモンなら、2人目の grant はいまも 409 で返る。消すと
      // その状況で「`/access/…/grant` が失敗しました (409)」という、原因も次の手も
      // 言わない文言に落ちる。本文はサーバが書いたものをそのまま見せる。
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        typeof body.error === 'string' ? body.error : '既に別のアカウントが許可されています',
      );
    }
    throw new Error(`${path} が失敗しました (${response.status})`);
  }
  return response.json();
}
