import { ApiError } from '@alteroid/swr';

/**
 * swr のフックが投げる、HTTP 404 の応答か。`status` を持つ値を投げるのは ApiError だけ（packages/swr）。
 * 型述語にしない: 偽のとき「ApiError ではない」へ絞られてしまい、409 などの ApiError の判定が型で壊れるため
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
