import { useCallback, useEffect, useRef, useState } from 'react';

export const PAGE_SIZE = 30;

/**
 * Offset-based infinite scroll over a paged fetcher.
 *
 * `fetchPage(offset)` returns one page (array). `deps` are the active filters —
 * when they change the list resets to offset 0 and re-fetches page 1.
 *
 * Robustness:
 *  - hasMore = last page had exactly PAGE_SIZE rows (empty page ⇒ no more).
 *  - a request TOKEN guards against a slow page of an OLD filter appending onto a
 *    new list after reset.
 *  - the sentinel is attached via a ref CALLBACK so the IntersectionObserver always
 *    observes the live node (the list can unmount/remount, e.g. modal/mode switch).
 */
export function useInfiniteList<T>(
  fetchPage: (offset: number) => Promise<T[]>,
  deps: unknown[],
) {
  const [items, setItems] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const offsetRef = useRef(0);
  const reqIdRef = useRef(0);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const loadPage = useCallback(async (reset: boolean) => {
    if (loadingRef.current) return;
    if (!reset && !hasMoreRef.current) return;
    const token = ++reqIdRef.current;
    loadingRef.current = true;
    setLoadingMore(true);
    const offset = reset ? 0 : offsetRef.current;
    try {
      const page = await fetchRef.current(offset);
      if (token !== reqIdRef.current) return; // superseded by a newer request/reset
      offsetRef.current = offset + page.length;
      const more = page.length === PAGE_SIZE;
      hasMoreRef.current = more;
      setHasMore(more);
      setItems((prev) => (reset ? page : [...prev, ...page]));
    } catch {
      if (token !== reqIdRef.current) return;
      hasMoreRef.current = false;
      setHasMore(false);
    } finally {
      if (token === reqIdRef.current) { loadingRef.current = false; setLoadingMore(false); }
    }
  }, []);

  const reset = useCallback(() => {
    reqIdRef.current++;          // invalidate in-flight requests
    loadingRef.current = false;
    offsetRef.current = 0;
    hasMoreRef.current = true;
    setHasMore(true);
    setItems([]);
    void loadPage(true);
  }, [loadPage]);

  // Reset + load page 1 whenever the filters change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reset(); }, deps);

  // IntersectionObserver via ref callback so it tracks the live sentinel node.
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    if (!node) return;
    observerRef.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMoreRef.current && !loadingRef.current) {
        void loadPage(false);
      }
    }, { root: null, rootMargin: '200px' });
    observerRef.current.observe(node);
  }, [loadPage]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { items, hasMore, loadingMore, sentinelRef, reset, setItems };
}
