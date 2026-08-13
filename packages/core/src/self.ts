/**
 * クローンの自己認識 — 「自分は何で出来ていて、いまどう走っているか」。
 *
 * **なぜこれが要るのか。** クローンは人間の写像であり、人間は自分が使っている
 * 道具が何であるかを知っている（知らなければ調べられる）。自分の実装・自分の
 * 実行環境・自分にいま何ができて何ができないかを把握できないクローンは、
 * その一点で人間の代替になっていない（north_star 禁止1）。
 *
 * **書き方の約束。** ここに alteroid の要約を手書きしないこと。書けば docs と
 * 二重管理になり、必ずずれる — ずれた瞬間、クローンは自分について間違ったことを
 * 確信する。したがってこのモジュールが持つのは次の2つだけである。
 *
 * 1. **正典そのもの**（`docs/*.md` の全文。ビルド時に焼き込む → `generated/canon.ts`）
 * 2. **実行時の事実**（記憶の器・作業ディレクトリ・委譲先・モデル帯。live な値なので
 *    ずれようがない）
 *
 * 判断や運用スタイルは書かない。材料を渡し、どうするかはクローンに残す
 * （prompt.ts 冒頭の約束と同じ）。
 */

import { CANON_DOCUMENTS, CANON_REVISION, type CanonDocument } from './generated/canon.js';

export { CANON_DOCUMENTS, CANON_REVISION, type CanonDocument };

/**
 * 実装の在り処。
 *
 * **正典の写しはビルド時点のものである**以上、「いまのコード」が要る場面は必ず
 * 来る。そのときの行き先をクローンが知らないと、自分のことを調べる手段が
 * 焼き込んだ写しだけになる。
 */
export const REPOSITORY_URL = 'https://github.com/takecchi/alteroid';

/** `self_read` に渡せる名前の一覧（正典の優先順位の順）。 */
export function canonNames(): string[] {
  return CANON_DOCUMENTS.map((doc) => doc.name);
}

/** 正典を1つ引く。無ければ `undefined`。 */
export function canonDocument(name: string): CanonDocument | undefined {
  const key = name.trim().toLowerCase();
  return CANON_DOCUMENTS.find((doc) => doc.name === key);
}

/**
 * いまクローンが走っている環境の事実。
 *
 * **鍵を入れないこと。** ここはそのままシステムプロンプトへ載る。載せてよいのは
 * 「どこに何があるか」までで、そこへ到達する鍵ではない（記憶ストアの接続文字列は
 * `storage` の時点で伏せ字になっている — apps/daemon の `safeTarget`）。
 */
export interface SelfFacts {
  /** 記憶の置き場の説明（ローカルのパス、または `PostgreSQL（host/db）`）。 */
  storage: string;
  /**
   * ローカルの置き場（`ALTEROID_HOME`）と、**そこに何が入っているか**。
   *
   * パスだけを渡してはいけない。pg 構成でローカルに残るのは state（接続先と
   * プロセス id）だけで**記憶ではない**（apps/daemon/src/storage.ts）。
   * 「記憶: PostgreSQL」と「人格データの根: /data/alteroid」が並ぶと、
   * クローンは矛盾する2つの事実を同時に確信する。
   */
  local: string;
  /** マネージャーの既定の作業ディレクトリ（`ALTEROID_WORKSPACE`）。 */
  workspace: string;
  /** 委譲先の器（別プロセスの manager-runner か、同一プロセスか）。 */
  runner: string;
  /**
   * 人間からの入口。**待ち受けアドレスではない。**
   *
   * `ALTEROID_BIND=0.0.0.0` は「どこで待つか」であって人間が叩く先ではないし、
   * TLS を手前で終端する構成では scheme も変わる。デーモンは
   * `authPlan.publicBaseUrl`（`ALTEROID_PUBLIC_URL`、既定は 127.0.0.1）を渡す。
   */
  entrypoint: string;
  /** 入口の認証の状態（`planAuth` の一行説明）。 */
  auth: string;
  /** 実際に走っているモデル帯。既定から差し替えられていればその値。 */
  models: { clone: string; manager: string; worker: string };
}

/**
 * システムプロンプトへ載せる自己認識の節。
 *
 * `facts` が無いときは実行環境の節を落とす（プロンプト単体のテストや、
 * デーモンの外で組み立てる場合）。**無い事実を埋めないこと** — 埋めた瞬間、
 * クローンは自分の環境について嘘を確信する。
 */
export function buildSelfKnowledge(facts?: SelfFacts): string {
  const lines = [
    '# あなた自身（alteroid）',
    '',
    'あなたを走らせているのは alteroid というプロダクトであり、**あなたはその外から使われる部品ではなく、実装の最上位に居る当事者である。**',
    'alteroid は「人間が PC の前に座り、Claude Code に作業を依頼して物事を進める」を、人間の代わりにあなたが行うためのツールである。',
    '',
    `- 実装は公開されている: ${REPOSITORY_URL}`,
    '- 実行基盤は Claude Agent SDK のラッパで、外部サービスへの接続は MCP。人間からの入口は CLI・HTTP API・Web UI の3つで、どれも同じ API の上に乗っている',
  ];

  if (facts === undefined) {
    lines.push(
      `- 層の対応: あなた（クローン）→ マネージャー → 作業者。あなたが \`manager_start\` で起こすのがマネージャーで、その下に作業者が居る`,
    );
  } else {
    lines.push(
      `- 層の対応: あなた（クローン / ${facts.models.clone}）→ マネージャー（${facts.models.manager}）→ 作業者（${facts.models.worker}）。あなたが \`manager_start\` で起こすのがマネージャーで、その下に作業者が居る`,
      '',
      '## いまのあなたが走っている環境',
      '',
      `- 記憶（あなたの同一性が宿る場所）: ${facts.storage}`,
      `- ローカルの置き場: ${facts.local}`,
      `- マネージャーの既定の作業ディレクトリ: ${facts.workspace}`,
      `- 委譲先: ${facts.runner}`,
      `- 人間からの入口: ${facts.entrypoint}（${facts.auth}）`,
    );
  }

  lines.push(
    '',
    '## 自分のことを調べる',
    '',
    '`self_read` で正典を全文読める。矛盾したら上が勝つ。',
    '',
    ...CANON_DOCUMENTS.map((doc, index) => `${index + 1}. \`${doc.name}\` — ${doc.summary}`),
    '',
    `**正典と実装が食い違ったら、バグなのは実装である。** ただしここにあるのはビルド時点の写し（リビジョン: ${CANON_REVISION.length > 0 ? CANON_REVISION : '不明'}）なので、実装の方が先に進んでいることもある。`,
    'コードそのものや最新の状態が要るなら、`manager_start` でリポジトリを読ませること（マネージャーは実際に `git` と `gh` を持っている）。',
    '自分について分かったこと・人間と決めた自分の扱いは、他のことと同じように記憶へ移す。',
  );

  return lines.join('\n');
}
