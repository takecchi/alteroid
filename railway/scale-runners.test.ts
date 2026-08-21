/**
 * `railway/scale-runners.sh` が**既に動いているもの**をどう扱うかを固定する。
 *
 * `setup.sh` のテストと見ているものが違う。あちらは「役ごとにどの鍵が渡るか」で、
 * こちらは**触らないもの**である:
 *
 *   1. **既存の runner の変数に触らない** — 触れば器が入れ替わり、その中で手を
 *      動かしているマネージャーと作業者が死ぬ。しかも死んだことは「委譲が返って
 *      こない」という形でしか出ないので、気づくのは人間が待ったあとである
 *   2. **runner_id を写さない** — 写ると2台が同じ名前を名乗り、`RunnerRegistry#get`
 *      が線形一致で先に見つかった方を返す。`manager_send` が別の器へ届くのに、
 *      名簿は重複を検出しないので症状は「たまに噛み合わない」だけになる
 *   3. **記憶ストアの鍵を写さない** — 写せば runner の中のマネージャーが
 *      `/proc/1/environ` から取れる状態に戻り、器を割った意味が消える
 *
 * 偽の `railway` を PATH の先に置いて確かめる（足場は `railway/cli-stub.ts`）。
 * ネットワークにも本物の Railway にも触らない。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { type Run, runScript } from './cli-stub.js';

/** いま本番に在るもの（app / Postgres / runner の3つ）。 */
const EXISTING = [
  { id: 'id-app', name: 'app', source: { repo: 'takecchi/alteroid', image: null } },
  { id: 'id-Postgres', name: 'Postgres', source: { repo: null, image: 'postgres-ssl:18' } },
  { id: 'id-runner', name: 'runner', source: { repo: 'takecchi/alteroid', image: null } },
];

/**
 * 走っている `runner` が持っている変数。**`railway variable list` は Railway が
 * 注入するものも、`${{…}}` を解決した値も、まとめて返す**（実物と同じ形）。
 */
const RUNNER_VARS: Record<string, string> = {
  ALTEROID_RUNNER_TOKEN: 'deadbeef',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test',
  ALTEROID_RUNNER_BIND: '::',
  ALTEROID_RUNNER_PORT: '4518',
  ALTEROID_RUNNER_ID: 'runner-primary',
  ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518',
  GH_TOKEN: 'github_pat_test',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 't@example.com',
  TZ: 'Asia/Tokyo',
  ALTEROID_CLONE_MODEL: 'opus',
  RAILWAY_RUN_UID: '0',
  // Railway が器ごとに注入するもの（写すと嘘になる）
  RAILWAY_SERVICE_ID: '86301ce6-runner',
  RAILWAY_SERVICE_NAME: 'runner',
  RAILWAY_PRIVATE_DOMAIN: 'runner.railway.internal',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  RAILWAY_GIT_COMMIT_MESSAGE: 'feat: ALTEROID_DATABASE_URL について書いた行',
};

type Options = {
  total: number;
  runnerVars?: Record<string, string>;
  appVars?: Record<string, string>;
  services?: typeof EXISTING;
  args?: string[];
  allowFailure?: boolean;
};

function run(options: Options): Run {
  return runScript({
    script: 'scale-runners.sh',
    args: ['--yes', '--total', String(options.total), ...(options.args ?? [])],
    services: options.services ?? EXISTING,
    serviceVars: {
      runner: options.runnerVars ?? RUNNER_VARS,
      app: options.appVars ?? {},
    },
    allowFailure: options.allowFailure,
  });
}

describe('1台から3台へ増やすとき', () => {
  let r: Run;
  beforeAll(() => {
    r = run({ total: 3 });
  });

  it('成功したら 0 で終わる', () => {
    expect(r.exitCode).toBe(0);
  });

  it('既存の runner の変数には1文字も触らない（走行中の仕事を殺さない）', () => {
    // ここが破れると、増やす操作が「いま走っているマネージャーを畳む操作」になる
    expect(r.touched('id-runner')).toBe(false);
    // 既存 runner の再デプロイも起こさない
    expect(r.calls.some((c) => c.includes('redeploy') && c.includes('--service runner'))).toBe(
      false,
    );
    expect(r.calls.some((c) => c.startsWith('up') && c.includes('--service runner '))).toBe(false);
  });

  it('足りない2台だけを作る', () => {
    const added = r.calls.filter((c) => c.startsWith('add'));
    expect(added).toEqual(['add --service runner-2', 'add --service runner-3']);
  });

  it('runner_id は台ごとに違う（写さずに置き直す）', () => {
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_ID).toBe('runner-2');
    expect(r.vars('id-runner-3').ALTEROID_RUNNER_ID).toBe('runner-3');
  });

  it('鍵は走っている runner から写す（合鍵が食い違うと 401 で unusable になる）', () => {
    for (const id of ['id-runner-2', 'id-runner-3']) {
      const v = r.vars(id);
      expect(v.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
      expect(v.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-test');
      // 下＝外の世界へ手を伸ばす鍵と身元は伏せない（伏せると PR が出せなくなる）
      expect(v.GH_TOKEN).toBe('github_pat_test');
      expect(v.GIT_COMMITTER_EMAIL).toBe('t@example.com');
      // 層とモデル帯の対応（人間の承認の置き場）も同じものが降りる
      expect(v.ALTEROID_CLONE_MODEL).toBe('opus');
      expect(v.TZ).toBe('Asia/Tokyo');
      expect(v.ALTEROID_RUNNER_BIND).toBe('::');
      // 子プロセスを uid 1001 へ降ろすのに特権が要る
      expect(v.RAILWAY_RUN_UID).toBe('0');
    }
  });

  it('Railway が器ごとに注入するものは写さない', () => {
    // 写すと、新しい器が古い器の名前と private ドメインを名乗る
    for (const id of ['id-runner-2', 'id-runner-3']) {
      const names = Object.keys(r.vars(id));
      expect(names.filter((n) => n.startsWith('RAILWAY_'))).toEqual(['RAILWAY_RUN_UID']);
    }
  });

  it('委譲の宛先は写さない（app が読むもので、runner 自身は読まない）', () => {
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_RUNNER_URL');
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_RUNNER_URLS');
  });

  it('app には3台ぶんの宛先を置く（変数参照のまま）', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toBe(
      [
        'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
      ].join(','),
    );
    // app に足すのは宛先だけである（他の変数を巻き込むと、置き直すたびに差分が増える）
    expect(Object.keys(r.vars('id-app'))).toEqual(['ALTEROID_RUNNER_URLS']);
  });

  it('app を上げ直すのは最後（新しい器が上がってから宛先を教える）', () => {
    const appUpsert = r.upsertedServices.indexOf('id-app');
    const redeploy = r.calls.findIndex(
      (c) => c.includes('redeploy') && c.includes('--service app'),
    );
    expect(r.upsertedServices.slice(0, appUpsert)).toEqual(['id-runner-2', 'id-runner-3']);
    expect(redeploy).toBeGreaterThanOrEqual(0);
    // 変数を置いてから上げ直す（逆だと古い env のまま起き直す）
    const lastVarPut = r.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.includes('VariableCollectionUpsert'))
      .map(({ i }) => i)
      .pop();
    expect(lastVarPut).toBeLessThan(redeploy);
  });

  it('追記であって置き換えではない（Railway が注入する変数を消さない）', () => {
    for (const id of ['id-app', 'id-runner-2', 'id-runner-3']) {
      expect(r.upsert(id).replace).toBe(false);
      // 置いた瞬間に器を入れ替えない。順番はこちらで決める
      expect(r.upsert(id).skipDeploys).toBe(true);
    }
  });

  it('新しい runner も Config as Code を指す（指さないと役が決まらない）', () => {
    expect(r.apiLog.match(/\/railway\/runner\.json/g)).toHaveLength(2);
    // app の Config as Code は触らない（既に指してある）
    expect(r.apiLog).not.toContain('/railway/daemon.json');
  });

  it('繋ぐ枝は release/prod（1台だけ main を見ると、そこだけマージで畳まれる）', () => {
    const connects = r.calls.filter((c) => c.includes('source connect'));
    expect(connects).toHaveLength(2);
    for (const c of connects) expect(c).toContain('--branch release/prod');
  });

  it('秘密を引数で渡さない（プロセス一覧に出る）', () => {
    expect(r.apiLog).not.toContain('sk-ant-test');
    expect(r.apiLog).not.toContain('github_pat_test');
    expect(r.calls.join('\n')).not.toContain('sk-ant-test');
    expect(r.calls.join('\n')).not.toContain('github_pat_test');
  });
});

describe('記憶ストアの鍵が runner に在ったとき', () => {
  // **これは運用の間違いではなく実装のバグである。** 写して増やすと、割った意味が
  // 消えた状態が台数ぶん増える。だから写さないだけでなく、そこで止まる
  let r: Run;
  beforeAll(() => {
    r = run({
      total: 3,
      runnerVars: { ...RUNNER_VARS, ALTEROID_DATABASE_URL: 'postgres://user:pw@host/db' },
      allowFailure: true,
    });
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('1台も作らない', () => {
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
  });

  it('実装のバグとして扱えと言う', () => {
    expect(r.stderr).toContain('実装のバグ');
  });
});

describe('減らそうとしたとき', () => {
  // 台数を減らす操作は、その器で走っているマネージャーを移送できて初めて安全になる
  // （fencing → 移送。roadmap M5 PR4 → PR5）。**黙って何もしないのでも、勝手に
  // 消すのでもなく、できないと言う**
  let r: Run;
  beforeAll(() => {
    r = run({
      total: 1,
      services: [
        ...EXISTING,
        { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
      ],
      allowFailure: true,
    });
  });

  it('非0で終わり、何も投入しない', () => {
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('先に確かめる手順を出す（消すなら人間が仕事の無いことを見る）', () => {
    expect(r.stderr).toContain('/managers');
  });
});

describe('もう3台あるとき（回し直し）', () => {
  const attached = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
    { id: 'id-runner-3', name: 'runner-3', source: { repo: 'takecchi/alteroid', image: null } },
  ];

  it('app が既に3台を宛先にしているなら、上げ直さない', () => {
    // **回し直しても app を入れ替えない。** このスクリプトは「新しい器が上がらなかった
    // ら app に触らずに終わる」形なので、直して回し直すのが普通の使い方である。
    // 突き合わせるのは解決済みの値（`${{…}}` は展開されて返ってくる）
    const r = run({
      total: 3,
      services: attached,
      appVars: {
        ALTEROID_RUNNER_URLS:
          'http://runner.railway.internal:4518,http://runner-2.railway.internal:4518,http://runner-3.railway.internal:4518',
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('宛先が足りていなければ、器は作らず宛先だけ直す', () => {
    // 前回 app の手前で落ちた場合がこれである（器は3台在るのに宛先が1台のまま）
    const r = run({
      total: 3,
      services: attached,
      appVars: { ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS.split(',')).toHaveLength(3);
    expect(r.calls.some((c) => c.includes('redeploy') && c.includes('--service app'))).toBe(true);
  });
});

describe('--dry-run', () => {
  it('何も作らず、何をするかだけ出す', () => {
    const r = run({ total: 3, args: ['--dry-run'] });
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.stderr).toContain('runner-2');
    expect(r.stderr).toContain('runner-3');
    // 何が起きるかを黙らない（app が1度入れ替わる）
    expect(r.stderr).toContain('上げ直す');
  });
});

describe('runner Service が無いプロジェクトで回したとき', () => {
  it('setup.sh を使えと言って止まる（勝手に建てない）', () => {
    const r = run({
      total: 3,
      services: EXISTING.filter((s) => s.name !== 'runner'),
      allowFailure: true,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('setup.sh');
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
  });
});
