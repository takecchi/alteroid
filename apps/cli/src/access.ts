import { stdout } from './terminal-out.js';

import { describeUnreadableRowsList, formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';

/**
 * 許可の有無の2値だけを持つ。「chat は可・記憶の編集は不可」のような行為別のスコープを足さない:
 * PRD「権限境界」が禁じる「確認が要る行為の一覧」と同じ形になり、クローンが記憶で下す判断を設定で置き換えるため。
 */

interface AccountView {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
  granted: boolean;
  ownerDeclaredAt: string | null;
  identities: { provider: string; email: string | null; lastLoginAt: string }[];
}

/**
 * Web UI の `describeGrantedBy()`（`apps/web/app/routes/access.tsx`）と同じ3分岐・同じ文言。
 * 片方を変えるならもう片方も変える。id は名前へ解決しない: そのアカウントが一覧から既に消えていることがありうるため。
 */
function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
}

export async function accessListCommand(now: number = Date.now()): Promise<void> {
  const target = await resolveTarget();
  const { accounts, rowsUnreadable } = (await request(target, '/access')) as {
    accounts: AccountView[];
    rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
  };
  stdout.write(
    describeUnreadableRowsList({
      noun: 'アカウント',
      removeCommand: 'alteroid access remove-unreadable',
      file: 'auth.json',
      rowsUnreadable,
    }),
  );

  if (accounts.length === 0) {
    if (rowsUnreadable !== undefined) {
      stdout.write('読めたアカウントは無い（誰もログインしていない、とは言えない）。\n');
      return;
    }
    stdout.write('まだ誰もログインしていません。\n');
    return;
  }

  for (const account of accounts) {
    const name = account.email ?? account.displayName ?? '(名前なし)';
    stdout.write(
      `${account.granted ? '[許可]' : '[未許可]'}${account.ownerDeclaredAt !== null ? '[owner]' : ''} ${name}\n`,
    );
    stdout.write(`  id: ${account.id}\n`);
    stdout.write(`  作成: ${account.createdAt}（${formatElapsedAgo(account.createdAt, now)}）\n`);
    const via = account.identities
      .map(
        (identity) =>
          `${identity.provider}${identity.email === null ? '' : ` (${identity.email})`}`,
      )
      .join(', ');
    if (via.length > 0) stdout.write(`  ログイン手段: ${via}\n`);
    if (account.lastLoginAt !== null) stdout.write(`  最終ログイン: ${account.lastLoginAt}\n`);
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
    // 既に許可済みのアカウントが在るかで分岐しない: 許可できる数に上限は無いので、「1つだけ」と案内すると嘘になる。
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

/**
 * 確認する: 許可に乗っていた「実行環境の持ち主」の宣言は一緒に落ち、再 grant しても戻らないため。
 */
export async function accessRevokeCommand(
  accountId: string,
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  // 読めない行（`rowsUnreadable`）に在る id は「無い」と言わない: 確認へ進み、POST の 409 の案内に任せる。
  const { accounts, rowsUnreadable } = (await request(target, '/access')) as {
    accounts: AccountView[];
    rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
  };
  const exists =
    accounts.some((account) => account.id === accountId) ||
    (rowsUnreadable?.rows.some((row) => row.id === accountId) ?? false);
  if (!exists) throw new Error('該当するアカウントがありません');
  await confirmIrreversible(
    `アカウント ${accountId} の許可を取り消します。発行済みのトークンはその場から通らなくなり、` +
      '許可に乗っていた「実行環境の持ち主」の宣言も落ちます（許可し直しても宣言は戻りません）。',
    options,
    io,
  );
  const { account } = (await request(target, `/access/${encodeURIComponent(accountId)}/revoke`, {
    method: 'POST',
  })) as { account: AccountView };
  stdout.write(`許可を取り消しました: ${account.email ?? account.displayName ?? account.id}\n`);
  stdout.write('（発行済みのトークンは、この時点から通らなくなります）\n');
}

/** 行の中身は出さない（id と件数だけ）。id が取れない行はこの口では消せない（`auth.json` を手で直す）。 */
export async function accessRemoveUnreadableCommand(
  ids: readonly string[],
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(
    `読めないアカウントの行（id: ${ids.join(', ')}）を消します。壊れた行は消すと残りません。`,
    options,
  );
  const result = (await request(
    target,
    '/access/unreadable/remove',
    { method: 'POST', body: JSON.stringify({ ids }) },
    '指した id が、読めないアカウントの行にありません（何も消していません。id は alteroid access list の「読めないアカウントの行」で確かめます。id が取れない行はこの口では消せません）',
  )) as { removedIds: string[] };
  stdout.write(
    `読めないアカウントの行を ${String(result.removedIds.length)} 行消しました（id: ${result.removedIds.join(', ')}）\n`,
  );
}

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
    stdout.write('（宣言の記録を取り消しただけです。資格の判断には使っていません）\n');
    return;
  }
  stdout.write(`実行環境の持ち主として宣言しました: ${name}\n`);
  stdout.write('（宣言を記録しただけです。資格の判断には使っていません）\n');
}

async function request(
  target: Target,
  path: string,
  init: RequestInit = {},
  notFoundMessage = '該当するアカウントがありません',
): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    // 本文の無い POST もデーモンは application/json を要求する（ブラウザの単純リクエストで許可を書き換えられないようにするため）。
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // `target.remote` から推測しない: 遠隔でも持ち主でないという理由の 403 はあり、その場合に直らない「access grant してください」を案内してしまう。
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
      // 理由が判別できないときは解決策を書かない: 「器の中で実行しろ」と「access grant しろ」は正反対で、当てずっぽうだと半分は嘘になる。
      throw new Error(
        'アクセス許可の操作が拒否されました（403）。理由を判別できなかったため、' +
          '次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    if (response.status === 404) throw new Error(notFoundMessage);
    if (response.status === 409) {
      // 409 の意味は経路ごとに違うので、サーバの `error` 文字列をそのまま見せる。代替文言は、どの経路でも嘘にならないよう競合したことだけを言う。
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        typeof body.error === 'string'
          ? redactError(body.error)
          : `${path} が競合しました (409)。デーモンから理由が返りませんでした`,
      );
    }
    throw new Error(await withErrorReason(`${path} が失敗しました (${response.status})`, response));
  }
  return response.json();
}
