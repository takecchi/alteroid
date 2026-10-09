import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Markdown の画像のうち「いま接続しているデーモンの添付」だけを、認証付きで取り出して見せる口。
 * `packages/ui` は `packages/swr` に依存しないので、取り出し方は外（apps/web）から context で渡す。
 * 渡していない画面では何もしない（今までどおり `<img src>` か、読めなければ文字とリンク）。
 */
export interface DaemonImages {
  /**
   * `src` がいま接続しているデーモンの添付の URL なら、その id を返す。それ以外は `undefined`。
   * 資格を送ってよいかの判定はすべてここで決まる: 呼ぶ側（ui）は、返った id にだけ `fetch` を呼ぶ。
   */
  match(src: string): string | undefined;
  fetch(id: string, signal: AbortSignal): Promise<Blob>;
}

const DaemonImagesContext = createContext<DaemonImages | undefined>(undefined);

export function DaemonImagesProvider({
  value,
  children,
}: {
  value: DaemonImages;
  children: ReactNode;
}) {
  return <DaemonImagesContext.Provider value={value}>{children}</DaemonImagesContext.Provider>;
}

export function useDaemonImages(): DaemonImages | undefined {
  return useContext(DaemonImagesContext);
}
