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
import { describeBuildRevision, type BuildRevision } from './revision.js';

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
  /**
   * **クローン自身の**カレントディレクトリ（自分の手が既定で立つ場所）。
   *
   * 道具を全部持つようになった（#32）ので、ここが分からないことが実害になった —
   * 唯一書いてあるのが `workspace`（＝マネージャーの作業場所で、構成によっては
   * クローンの器から見えない）だと、クローンは相対パスの `ls` や `Read` を
   * 「ワークスペースに居るつもり」で撃つ。**それは推測であって観測ではない。**
   */
  cwd: string;
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
 * いまクローンがどう走っているか — SDK が実際に報告してきた値と、alteroid 側の
 * 宣言（環境変数・既定）を並べたもの。
 *
 * **{@link SelfFacts} とは別物である。** あちらはシステムプロンプトへ焼き込む
 * 静的な事実で、セッションを組み立てた時点で確定する。こちらは走行中に SDK から
 * 届く値なので、init が来る前・effort が一度も報告される前は `null` のままである。
 * **`null` を既定値や宣言値で埋めないこと** — 埋めた瞬間、まだ観測していない値を
 * 確信することになる（`self_status` の存在理由そのものが壊れる）。
 *
 * **鍵を入れないこと。** `apiKeySource` は SDK が返す「出所の名前」だけであって
 * 値そのものではない。ここに「鍵が設定されているか否か」を足したくなっても、
 * この型はそれを持たない（`self.ts` 冒頭の約束と同じ理由）。
 */
export interface CloneRuntimeFacts {
  /**
   * **いま自分が走っているコードそのものの版**（`resolveBuildRevision()` の結果）。
   *
   * **正典の写しの版（`CANON_REVISION`）とは別物である。** あちらはビルド時に
   * 焼き込まれた `docs/*.md` の写しが「いつのものか」で、こちらは「このプロセスの
   * コードがどのコミットか」——焼き込みが空でも実行時の環境変数から取れることが
   * あり、そのとき2つは食い違う。**片方だけを出すと、クローンは自分が走っている
   * コードを写しの版で言い換えることになる。**
   *
   * 取れなかったときに埋めないのは `BuildRevision` 側の仕事なので、ここは
   * その値をそのまま持つ（`null` を既定値へ倒さない）。
   */
  revision: BuildRevision;
  /** 宣言されたモデル帯（`ALTEROID_CLONE_MODEL` があればその値、無ければ既定）。 */
  declaredModel: string;
  /**
   * 人間が `ALTEROID_CLONE_MODEL` に値を**置いたか**。
   *
   * **「既定と違うか」ではない。** 置いた値がたまたま既定と同じ
   * （`ALTEROID_CLONE_MODEL=fable`）でも真である — ここが答えるのは
   * 「差し替えの承認が置かれているか」であって、値の比較ではない
   * （`clone.ts` の `placedCloneModel`）。
   */
  modelOverridden: boolean;
  /** 差し替えの置き場（環境変数の名前）。 */
  modelEnvKey: string;
  /** SDK が init で報告した実際のモデル id。まだ init が来ていなければ `null`。 */
  sdkModel: string | null;
  /**
   * SDK が報告した effort の実効値（フックが運ぶ値）。
   *
   * **このセッションで最初の道具呼び出しでは `null` になる**（前の道具呼び出しの
   * 結果として観測するため）。モデルが effort に対応していなければずっと `null`。
   */
  effort: string | null;
  /** alteroid が `options.effort` を明示的に渡しているか（渡していなければ `null`）。 */
  requestedEffort: string | null;
  /** SDK が init で報告した Claude Code の版。まだ init が来ていなければ `null`。 */
  claudeCodeVersion: string | null;
  /**
   * SDK が init で報告した認証の出所（`user` / `oauth` など）。
   *
   * **値そのものではない。** `null` は「まだ報告されていない」であって「鍵が無い」
   * ではない。
   */
  apiKeySource: string | null;
  /** SDK が init で報告した許可モード。`null` なら未報告。 */
  permissionMode: string | null;
  /**
   * alteroid が `options.permissionMode` に渡した値。
   *
   * **上の `permissionMode`（観測）と対で持つ。** `requestedEffort` が `null` なのは
   * 渡していないからで、こちらは必ず渡している（`clone.ts` の `#permissionMode`）。
   * 頼んだ値と報告された値が食い違うことはありうるので、片方だけを出すと
   * 「どちらが効いているのか」を答えられない。
   */
  requestedPermissionMode: string;
  /**
   * SDK が init で報告した MCP サーバの名前と状態。
   *
   * **`null` は「まだ init を観測していない」、`[]` は「init を観測して、
   * 連携が1本も無いと報告された」——別の事実である（#324）。** 隣の
   * `claudeCodeVersion` / `apiKeySource` / `permissionMode` と同じ形にしてある。
   * `[]` を「未観測」の代わりに使うと、**観測できた「0本」という事実そのものが
   * 出力から消える** — MCP は外部サービス接続の唯一の手段（PRD）なので、0本は
   * それ自体が業務範囲について言う値であって、取れなかったのではない。
   */
  mcpServers: Array<{ name: string; status: string }> | null;
  /**
   * いまの SDK セッション id。まだ init が来ていなければ `null`。
   *
   * **これは本セッション（クローン本体）で観測した値である。** 蒸留のサイド
   * クエリは別の SDK セッションだが、そちらへ渡す `runtime` もこの値をそのまま
   * 運ぶ（サイドクエリ自身の init は見ていない）。
   */
  sessionId: string | null;
  /** resume で引き継いだセッション id。新規に開いたなら `null`。 */
  resumedFrom: string | null;
  /** システムプロンプトへ焼き込んだ記憶の文字数（このセッションを組み立てた時点）。 */
  injectedMemoryChars: number;
  /** システムプロンプト全体の文字数（毎ターン払っている入力の土台）。 */
  systemPromptChars: number;
}

/** まだ観測していない値の言い方。埋めるのではなく、取れていない理由を言う。 */
function unknownBecause(reason: string): string {
  return `まだ分からない（${reason}）`;
}

const INIT_NOT_OBSERVED = 'init 未観測';

/**
 * {@link CloneRuntimeFacts} の整形。
 *
 * **alteroid の説明文をここに書かない**（モジュール冒頭の約束）。判断や運用
 * スタイルも書かない。出すのは観測した値と、値が取れていないときの理由だけ。
 */
export function describeCloneRuntime(facts: CloneRuntimeFacts): string {
  // **`null`（未観測）と `[]`（観測できた0本）を別文言にする（#324）。** どちらも
  // かつては同じ `unknownBecause(INIT_NOT_OBSERVED)` に畳まれていて、「MCP 連携が
  // 1本も無い」という取れた事実が「まだ分からない」に化けていた。0本は黙って
  // 空欄にもしない — 読み手が「0本である」と分かる文言にする。
  const mcpServers =
    facts.mcpServers === null
      ? unknownBecause(INIT_NOT_OBSERVED)
      : facts.mcpServers.length === 0
        ? '0本（init は観測済み）'
        : facts.mcpServers.map((server) => `${server.name}(${server.status})`).join(', ');

  return [
    '## いまどう走っているか',
    '',
    // **最初に版を出す。** 自分が何で走っているかを答える節で、いちばん外側の
    // 事実がこれである（モデル帯より外側 — モデルは差し替えられるが、コードの版は
    // このプロセスの正体そのもの）。**「正典の写しの版」ではなく「このプロセスの
    // コードの版」であることを言葉で区別する** — 2つは食い違いうる
    // （`CloneRuntimeFacts.revision` の doc）。
    `- 自分がいま走っているコードの${describeBuildRevision(facts.revision)}`,
    // **「既定と同じ値か」ではなく「置かれているか」を言う。** 人間が
    // \`ALTEROID_CLONE_MODEL=fable\` を明示的に置いた場合、前者では「既定のまま」と
    // 嘘になる（承認が置かれている事実が消える）。
    `- 宣言されたモデル帯: ${facts.declaredModel}（` +
      (facts.modelOverridden
        ? `人間が \`${facts.modelEnvKey}\` に置いた値`
        : `既定。\`${facts.modelEnvKey}\` は置かれていない`) +
      '）',
    `- SDK が実際に報告したモデル id: ${facts.sdkModel ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- effort（実効値）: ${
      facts.effort ??
      unknownBecause('このセッションで最初の道具呼び出しか、モデルが effort に対応していない')
    }`,
    `- effort（alteroid が明示的に渡したもの）: ${facts.requestedEffort ?? '渡していない（SDK の既定に任せている）'}`,
    `- Claude Code の版: ${facts.claudeCodeVersion ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- 認証の出所（値ではなく名前）: ${facts.apiKeySource ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- 許可モード（SDK が報告した実効値）: ${facts.permissionMode ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- 許可モード（alteroid が渡したもの）: ${facts.requestedPermissionMode}`,
    `- MCP サーバ: ${mcpServers}`,
    `- SDK セッション id（クローン本体のセッションで観測した値。蒸留のサイドクエリは別セッションなのでここには出ない）: ${facts.sessionId ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- resume 元のセッション id: ${facts.resumedFrom ?? '（新規に開いた。前のセッションを引き継いでいない）'}`,
    `- システムプロンプトへ焼き込んだ記憶の文字数（このセッションを組み立てた時点）: ${facts.injectedMemoryChars.toLocaleString('en-US')} 文字`,
    `- システムプロンプト全体の文字数（毎ターン払っている入力の土台）: ${facts.systemPromptChars.toLocaleString('en-US')} 文字`,
  ].join('\n');
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
      // **自分の手が立つ場所と、委譲先の作業場所を並べて出す。** 片方だけだと
      // 「相対パスがどこを指すか」をクローンが推測することになる（構成によっては
      // マネージャーの作業場所はこの器から見えない）。
      `- あなた自身の作業ディレクトリ（自分の手で相対パスを使うときの基準）: ${facts.cwd}`,
      `- マネージャーの既定の作業ディレクトリ（あなたの器から見えるとは限らない）: ${facts.workspace}`,
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
    // **ここの版は「写しがいつのものか」であって「いま走っているコードの版」では
    // ない。** 焼き込みが空でも実行時の環境変数から後者だけが取れることがあるので、
    // 同じ語で言うとクローンは片方をもう片方の答えとして使う。後者の在り処
    // （`self_status`）をこの行から指しておく。
    `**正典と実装が食い違ったら、バグなのは実装である。** ただしここにあるのはビルド時点の写し（写しの焼き込み時のリビジョン: ${CANON_REVISION.length > 0 ? CANON_REVISION : '不明'}）なので、実装の方が先に進んでいることもある。いま自分が走っているコードそのものの版は \`self_status\` が名乗る（写しの版と食い違うことがある）。`,
    'コードそのものや最新の状態が要るなら、`manager_start` でリポジトリを読ませること（マネージャーは実際に `git` と `gh` を持っている）。',
    '自分について分かったこと・人間と決めた自分の扱いは、他のことと同じように記憶へ移す。',
  );

  return lines.join('\n');
}
