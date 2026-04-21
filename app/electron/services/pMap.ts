/**
 * 并发执行器:给 fn 传入 workerId(0..concurrency-1),保持输入顺序返回结果
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, idx: number, workerId: number) => Promise<R>,
  concurrency = 3
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const size = Math.min(concurrency, items.length);
  const workers = Array.from({ length: size }, (_, workerId) =>
    (async () => {
      while (next < items.length) {
        const cur = next++;
        results[cur] = await fn(items[cur], cur, workerId);
      }
    })()
  );
  await Promise.all(workers);
  return results;
}
