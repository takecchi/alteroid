/**
 * `@alteroid/swr` —— Web UI から API を叩く層（`ApiProvider` と SWR の hooks）。
 *
 * 型と呼び出しの出どころは `@alteroid/api-client`（生成 spec）、画面の型と
 * 接続先・資格情報の置き場は `@alteroid/logic`。**見た目（`@alteroid/ui`）は
 * import しない。**
 *
 * 試験用の足場（`stubFetch` / `sse` / `Providers`）は `@alteroid/swr/test-support`。
 */
export * from './api';
export * from './login';
export * from './hooks/journal-feed';
export * from './hooks/mutations';
export * from './hooks/queries';
export * from './hooks/use-auth';
export * from './hooks/use-journal-live';
export * from './hooks/use-journal-window';
export * from './hooks/use-managers-window';
export * from './hooks/use-topology';
