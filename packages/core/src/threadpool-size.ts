/**
 * libuv のスレッドの枠（既定4本）を広げる（#4890）。**副作用だけのモジュールで、何も import しない。**
 * デーモンと runner の入口（`apps/daemon/src/index.ts`・`apps/runner/src/index.ts`）が、最初の import として
 * `import '@alteroid/core/threadpool-size';` と置く。
 *
 * ファイルの非同期の読み書き・`dns.lookup`（runner への fetch と PostgreSQL の接続の名前解決）・crypto の非同期は、同じ枠で回る。
 * 器の I/O が詰まって4本がふさがると、イベントループは空いたまま（使用率 0%）、名乗りの確認も PostgreSQL への接続もそろって待たされ、
 * runner を8台同時に失う形に化けた。
 *
 * **なぜ入口の本文ではなく、別のモジュールか。** libuv の枠の大きさは、枠を使う最初の処理の時点で決まる（その後に環境変数を変えても効かない）。
 * ESM の import は入口の本文より先に評価されるので、入口の本文で `process.env` へ入れると、先に評価された import の中で枠を使う処理が
 * 走っていた場合に遅れる。import は書かれた順に評価されるので、このモジュールを最初に置けば、他のどのモジュールの評価よりも先に効く。
 *
 * **なぜ入口のファイルの中に書かず、core の別の入口（package の exports）にしたか。** 入口はバンドルされ、外部のパッケージ
 * （`@alteroid/core`・hono・SDK など）の import は、バンドル内に取り込まれた自前のモジュールの本文より先に評価される（実測:
 * `apps/runner/dist/index.js` では自前の本文が先頭に見えるが、ESM の仕様では全ての import が本文より先に評価される）。
 * 外部の1本として最初に import させれば、バンドルの後でも順序が保たれる。
 *
 * 本命は器の起動スクリプト（`docker/alteroidd`・`docker/alteroid-runner`）で、Railway・compose はそこを通る。
 * こちらは、それを通らない起動（`alteroid daemon start` が起こす子・`node dist/index.js` の直叩き）のための保険である。
 *
 * 人間が置いた値は上書きしない（空文字は「置いていない」と読む: libuv は空を 0 と読み、既定の4へ戻るため）。
 */
export const DEFAULT_UV_THREADPOOL_SIZE = '16';

const current = process.env.UV_THREADPOOL_SIZE;
if (current === undefined || current === '') {
  process.env.UV_THREADPOOL_SIZE = DEFAULT_UV_THREADPOOL_SIZE;
}
