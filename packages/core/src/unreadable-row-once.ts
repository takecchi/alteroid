import { createHash } from 'node:crypto';

/**
 * 壊れた行（スキーマに合わずパースできなかった行）を、**ストアのインスタンス
 * ごとに1行につき1回だけ** stderr へ知らせるための追跡器（issue #2191）。
 *
 * ## 置き場所を `packages/core` にした理由
 *
 * fs（`packages/storage-fs`）・pg（`packages/storage-pg`）のどちらも既に
 * `@alteroid/core` に依存している（`permissionGrantSchema` を import 済み）が、
 * 逆方向の依存（`core` → `storage-fs` / `storage-pg`）は無い。**両方が既に
 * 持っている依存の向きに乗せれば、新しい依存を1本も増やさずに共有できる**
 * ——`storage-fs` と `storage-pg` を互いに依存させる（どちらかにもう一方が
 * 依存する）のは、実装（ファイル/ SQL）の詳細を跨いだ結合になり筋が悪い。
 * `apps/daemon` へ置く案もあったが、`apps/daemon` は fs・pg 両方に依存できる
 * 側であって**され**る側ではない——ストア自身（`packages/storage-*`）が
 * 使う道具を `apps/daemon` に置くと依存の向きが逆になる。
 *
 * ## なぜ `dropped-record.ts`（`noteDroppedJournalRow` 等）を流用しないか
 *
 * あちらの `Map<種別, 件数>` は**呼び出し1回ぶんのローカル変数**で、意図的に
 * プロセス／インスタンス単位では畳んでいない（`noteDroppedJournalRow` の
 * doc:「プロセス単位で畳むと、器が入れ替わって新しい書き手が同じ種別を
 * 吐き始めても『前に見たから』で黙る、という同じ穴を作る」）。だから
 * `list()` を呼ぶたびに毎回1行ずつ出る——今回の issue が問題にしている
 * 「同じ警告が積み上がり続ける」をそのまま再現する形であって、直り方には
 * ならない。**この issue が要る形はその逆**——`list()` / `get()` を何度
 * 呼んでも、同じ壊れた行には1回しか知らせない（インスタンスが生きている
 * 限り）。設計判断そのものが違うので、別の小さな道具として新設した。
 */
export interface UnreadableRowOnce {
  /**
   * この鍵の行がいま壊れていて読めなかった。**まだこの鍵を知らせていない
   * ときだけ `true`** を返し、以後「知らせた」側へ移す——呼び出し側は
   * この戻り値が `true` のときだけ stderr へ書くこと。既に知らせていれば
   * `false`（黙ってよい）。
   */
  sawUnreadable(key: string): boolean;

  /**
   * この鍵の行がいま読めた（直った）。次にまた壊れたら、もう一度知らせ
   * られるように「まだ知らせていない」側へ戻す。まだ知らせていない鍵に
   * 呼んでも何もしない（冪等）。
   *
   * **`list()` / `get()` が成功でパースできた行すべてに対して呼ぶこと。**
   * 呼び忘れると、直った後の行がもう一度壊れても再度は知らせられない
   * （知らせた側に居座ったまま）。
   */
  sawReadable(key: string): void;
}

/**
 * {@link UnreadableRowOnce} を1つ作る。**呼び出し元（ストアのコンストラクタ）
 * が自分のインスタンスフィールドとして1つ持つこと。** モジュールの
 * トップレベル変数へ置くとプロセス全体で共有され、別のストアインスタンス
 * （テストごとに作り直す・複数の dir/db を同時に開く、など）の壊れた行を
 * 「もう知らせた」と誤って黙らせてしまう。
 */
export function createUnreadableRowOnce(): UnreadableRowOnce {
  const notified = new Set<string>();
  return {
    sawUnreadable(key) {
      if (notified.has(key)) return false;
      notified.add(key);
      return true;
    },
    sawReadable(key) {
      notified.delete(key);
    },
  };
}

/**
 * 壊れた行を見分ける鍵を作る。
 *
 * **id が取れればそれを使う**（`id:` 接頭辞——後述の `fingerprint:` と
 * 名前空間を分け、たまたま同じ文字列になっても衝突しないようにする）。
 * **id が取れない行は、内容の指紋（sha256 の先頭16桁）を使う**——本文
 * そのものは鍵の材料にするだけで、どこへも出力しない（呼び出し側の
 * stderr の文言にはこの鍵を載せないこと）。
 *
 * **配列の位置（index）は鍵にしないこと。** 他の行が増減すると同じ壊れた
 * 行でも位置がずれる——位置を鍵にすると「直っていないのに新しい鍵に見えて
 * 再度知らせる」ことと「別の行なのに前の鍵と一致して黙る」ことの両方が
 * 起きうる。
 */
export function unreadableRowKey(id: string | undefined, raw: unknown): string {
  if (id !== undefined) return `id:${id}`;
  return `fingerprint:${fingerprintOf(raw)}`;
}

function fingerprintOf(raw: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? String(raw);
  } catch {
    serialized = String(raw);
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
}
