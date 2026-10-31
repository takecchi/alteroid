// `exactOptionalPropertyTypes` のもとで、未指定の項目を `undefined` で渡さずキーごと省く（受け手は `in` ではなく値で見るが、型が `x?: T` で `undefined` を許さないため）
export function definedProps<T extends object>(
  props: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
