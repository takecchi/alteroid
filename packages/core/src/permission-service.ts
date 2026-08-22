import { randomUUID } from 'node:crypto';

import type { PermissionRule } from './schema.js';
import type { Stores } from './store.js';

/**
 * 実行許可の台帳を**書き換えて効かせる**までの1本道。
 *
 * ## なぜ「1本道」でなければならないか
 *
 * 書き手が2人居る（`profile-service.ts` とまったく同じ形である）:
 *
 * - **人間** — `POST /permissions` / `DELETE /permissions/:id`（CLI・HTTP・Web の3入口）
 * - **クローン** — `permission_grant` / `permission_revoke`（自分の道具）
 *
 * どちらも「台帳を書く → 日誌へ残す → 走行中のセッションへ全量を流し込む」の3段を踏む。
 * これを直列化しないと、**取り消したはずの規則が生き返る**:
 *
 *     クローンが grant(B) → 台帳=[A,B] を読む → 人間が revoke(A) → 台帳=[B] を読む
 *       → 人間が [B] を流す → クローンが [A,B] を流す   ⇒ 走行中は A が効いたまま
 *
 * 台帳（正本）からは A が消えているので、人間の側からは取り消せたように見える。
 * **増やす口だけが片道で開く**という、この器がいちばん避けたい壊れ方である
 * （`PermissionStore.grant` の doc が同じ理由で重複を禁じている）。
 * クローンは自律ターン（時間起点・発意）からも動くので、人間が許可を外している最中に
 * クローンが別の規則を開けることは普通に起こりうる。
 *
 * ## この器は `allow` しか扱わない
 *
 * `deny` / `ask` のメソッドをここへ生やさないこと。理由は `permissionRuleSchema` の
 * 不変条件1（AGENTS.md の地雷表が禁じているのは「**確認が要る**行為の一覧」＝そちら側で、
 * 足した瞬間に権限境界が設定へ化ける）。
 *
 * ## 誰が開けたかは、呼び出し側が観測したものだけを渡す
 *
 * `grantedBy` をこの器が決めない。決められないからである — HTTP から来たものは
 * 「提示された資格」までしか分からず、クローンの道具から来たものは「クローンの
 * セッションから来た」ことが分かる。**観測できた側にしか書けない**（`permissionRuleSchema`
 * の `grantedBy` の doc）。
 */
export interface PermissionService {
  /** いま効いている許可の全量（許した順）。**件数で切らない。** */
  list(): Promise<PermissionRule[]>;

  /**
   * 1件許す。**台帳へ書き、日誌へ残し、走行中のセッションへ流し込むまでが1区間。**
   *
   * 同じ規則が既に在れば何もしない（`{ ok: false, reason: 'duplicate' }`）。
   */
  grant(request: PermissionGrantRequest): Promise<PermissionGrantOutcome>;

  /** 1件取り消す。**消した結果もその場で走行中のセッションへ効かせる。** */
  revoke(id: string, request: PermissionRevokeRequest): Promise<PermissionRevokeOutcome>;
}

export interface PermissionGrantRequest {
  /** SDK の許可規則そのもの（`Bash(gh pr merge:*)` など）。器は中身を解釈しない。 */
  rule: string;
  /**
   * **観測できた出所だけを書く。「誰が」ではない。**
   *
   * 人間の口からは提示された資格（`operator` / `account:<id>`）、クローンの道具からは
   * `clone`。呼び出し側が名乗りたい名前を名乗れる形にしないこと
   * （`permissionRuleSchema.grantedBy` の doc）。
   */
  grantedBy: string;
  /** なぜ許したか。台帳の行に残る（人間が後から読んで否定するためのもの）。 */
  note?: string;
  /**
   * 日誌に残す根拠。**クローンが自分で開けたときはここが本体である** —
   * 「記憶のどのやり取りに根拠があったか」がここに入る（PRD「権限境界」:
   * 聞かずに実行した判断は必ず日誌に残る）。
   */
  grounds: string;
}

export interface PermissionRevokeRequest {
  /** 観測できた出所（`grantedBy` と同じ作法）。 */
  revokedBy: string;
  grounds: string;
}

export type PermissionGrantOutcome =
  | {
      ok: true;
      entry: PermissionRule;
      /** `auto` で黙って効かない見込みのときの1行（{@link autoModeWarningFor}）。 */
      warning?: string;
      /**
       * 走行中のセッションへ流し込めなかった理由。
       *
       * **`ok: true` と両立する。** 台帳（正本）へは入っているので、次にセッションが
       * 開けば効く。**「開けたつもりで何も起きていない」と読ませないために、成功の側に
       * 添えて返す**（失敗にすると、人間もクローンも同じ規則をもう一度足しに来る）。
       */
      applyError?: string;
    }
  | { ok: false; reason: 'duplicate' };

export type PermissionRevokeOutcome =
  | {
      ok: true;
      /** 消した行（何を外したかを呼び出し側が言えるように）。読めなければ null。 */
      entry: PermissionRule | null;
      applyError?: string;
    }
  | { ok: false; reason: 'not_found' };

export interface PermissionServiceOptions {
  stores: Stores;
  /**
   * 走行中のクローンのセッションへ、**台帳の全量**を流し込み直す
   * （`CloneHost.applyPermissions`）。
   *
   * **差分を渡す口にしないこと。** SDK は後続の呼び出しが `permissions` を丸ごと
   * 置き換えると言っているので、全量を送る形にして初めて取り消しがその場で効く。
   */
  apply: () => Promise<void>;
  /** テストのための差し替え。既定は実時計と `randomUUID`。 */
  now?: () => string;
  newId?: () => string;
}

/**
 * `auto` が照合の前に候補から外す Bash 規則を見分ける（**助言であって判定ではない**）。
 *
 * 出荷されている判定実装を静的に読んだ結果（2026-08-22 観測、
 * `claude-agent-sdk-linux-x64@0.3.239` の `BOe` / `N1t` / `B4n`）、`permissionMode`
 * が `auto` のとき、**インタプリタ・遠隔実行系の Bash allow 規則は照合される前に
 * allow の候補から除外される。** 除外された規則は一致しようがないので、
 * **許可したつもりで一度も効かない。**
 *
 * **⚠️ この一覧は向こうの実装の写しであって、正本ではない。**
 * 向こうが増やせばここは黙って古くなる（この repo の「固定した数は固定した瞬間から
 * 腐り、腐ったことは読む側からは分からない」と同じ形）。だから:
 *
 * - **止めない。** 助言を返すだけで、許可そのものは通す（不変条件1 — ここに
 *   「何が通るか」を決める表を持たない。持った瞬間に権限の一覧になる）
 * - **「当たらなかった＝効く」と言わない。** 言えるのは「当たったなら効かない見込み」
 *   までである。設定 `autoMode.classifyAllShell` が真なら **Bash の allow 規則は
 *   全部**除外されるが、ここからその設定は読んでいないので判定できない
 * - 積み上がってからの検出は別に在る（`clone.ts` の `#noteDenial`）。**こちらは
 *   足す瞬間に言うためのもので、両方要る**
 */
const AUTO_EXCLUDED_BASH_HEADS = [
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'ssh',
  'scp',
  'kubectl',
  'docker',
  'eval',
  'sh',
  'bash',
  'zsh',
];

/**
 * 足そうとしている規則が `auto` で黙って効かない見込みなら、その旨の1行。
 * 当たらなければ `null`（**「効く」の意味ではない**。上の doc）。
 */
export function autoModeWarningFor(rule: string): string | null {
  const match = /^Bash\((.*)\)$/.exec(rule.trim());
  if (match === null) return null;
  const head = (match[1] ?? '').trim().split(/[\s:]/)[0]?.toLowerCase() ?? '';
  if (head.length === 0) return null;
  if (!AUTO_EXCLUDED_BASH_HEADS.includes(head)) return null;
  return (
    `⚠️ この規則は permissionMode が auto のとき、照合される前に候補から外される見込み` +
    `（${head} はインタプリタ・遠隔実行系として除外される）。` +
    `許可しても一度も効かない可能性が高い。` +
    `**この見分けは SDK 実装の写し（2026-08-22 観測）であって正本ではない。**`
  );
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const { stores, apply } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  /**
   * 直列化の実体（`profile-service.ts` の `serial` と同じもの）。
   *
   * **次の更新は前の更新の全段が終わってから始まる。** 前の失敗で列が止まらないよう、
   * 常に解決する形で繋ぐ（失敗は呼び出し側へ返るので列に残す必要は無い）。
   */
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 流し込みで落ちても、**台帳へ書けたことは取り消さない。**
   *
   * ここで投げると、呼び出し側は「開けられなかった」と読んで同じ規則をもう一度
   * 足しに来る（そして2度目は重複で弾かれる ＝ 何をしても開かないように見える）。
   * 正本は台帳なので、流し込めなくても次にセッションが開けば効く。**黙らせずに
   * 理由を返し、日誌にも残す。**
   */
  async function applyQuietly(): Promise<string | undefined> {
    try {
      await apply();
      return undefined;
    } catch (error) {
      return String(error);
    }
  }

  return {
    list: () => stores.permissions.list(),

    grant: (request) =>
      serial(async () => {
        const entry: PermissionRule = {
          id: newId(),
          rule: request.rule,
          grantedAt: now(),
          grantedBy: request.grantedBy,
          ...(request.note === undefined ? {} : { note: request.note }),
        };

        // **重ねない。** 同じ規則が2行あると、1行消しても規則は効いたままになり
        // 「消したのに効き続ける」＝ 増やす口だけが片道で開く形になる。
        if (!(await stores.permissions.grant(entry))) return { ok: false, reason: 'duplicate' };

        // **足す瞬間に言う。** 積み上がってから検出するより安い（`autoModeWarningFor`）。
        const warning = autoModeWarningFor(entry.rule);

        // **効かせる前に記録する。** 記録に残らない許可は、許可として成立していない
        // （人間が後から読んで否定できることが最終承認の実体である。north_star）。
        await stores.journal.append({
          type: 'decision',
          decision:
            `実行許可を開けた（${entry.id} / ${entry.grantedBy}）: ${entry.rule}` +
            `${entry.note === undefined ? '' : `（${entry.note}）`}` +
            `${warning === null ? '' : ` ${warning}`}`,
          grounds: request.grounds,
        });

        const applyError = await applyQuietly();
        if (applyError !== undefined) {
          await stores.journal.append({
            type: 'decision',
            decision:
              `実行許可 ${entry.id}（${entry.rule}）を走行中のセッションへ流し込めなかった。` +
              `台帳には入っているので、次にセッションが開けば効く: ${applyError}`,
            grounds: '流し込みの失敗を黙らせない（効いていない許可を効いていると読ませない）',
          });
        }

        return {
          ok: true,
          entry,
          ...(warning === null ? {} : { warning }),
          ...(applyError === undefined ? {} : { applyError }),
        };
      }),

    revoke: (id, request) =>
      serial(async () => {
        // 消す前に読む。**日誌に「何を」外したかを残すためである** — id だけ残しても、
        // 行が消えた後では何の規則だったか誰にも辿れない。
        const existing = await stores.permissions.get(id).catch(() => null);
        if (!(await stores.permissions.revoke(id))) return { ok: false, reason: 'not_found' };

        await stores.journal.append({
          type: 'decision',
          decision: `実行許可を取り消した（${id} / ${request.revokedBy}）: ${existing?.rule ?? '規則の記録なし'}`,
          grounds: request.grounds,
        });

        const applyError = await applyQuietly();
        if (applyError !== undefined) {
          await stores.journal.append({
            type: 'decision',
            decision:
              `実行許可 ${id}（${existing?.rule ?? '規則の記録なし'}）を走行中のセッションから外せなかった。` +
              `台帳からは消えているが、**次にセッションが開くまで効き続ける**: ${applyError}`,
            grounds: '外し損ねを黙らせない（消したのに効き続ける状態を見えなくしない）',
          });
        }

        return {
          ok: true,
          entry: existing,
          ...(applyError === undefined ? {} : { applyError }),
        };
      }),
  };
}
