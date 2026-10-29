import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

// 現在の検索パラメータの写しを `edit` で書き換え、履歴を積まず（replace: true）URL へ書き戻す。
export function useReplaceSearchParams(): readonly [
  searchParams: URLSearchParams,
  replaceParams: (edit: (params: URLSearchParams) => void) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const replaceParams = useCallback(
    (edit: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          edit(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return [searchParams, replaceParams];
}
