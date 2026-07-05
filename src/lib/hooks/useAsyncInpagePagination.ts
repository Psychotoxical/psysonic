import { useCallback, useEffect, useRef, useState } from 'react';

type UseAsyncInpagePaginationOptions = {
  /** Initial `loading` state (e.g. true when the first fetch runs on mount). */
  initialLoading?: boolean;
};

/** Sync guards for offset-based server pagination inside in-page scroll areas. */
export function useAsyncInpagePagination(
  pageSize: number,
  options?: UseAsyncInpagePaginationOptions,
) {
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(options?.initialLoading ?? false);
  const pageRef = useRef(0);
  const loadingRef = useRef(false);
  const loadPendingRef = useRef(false);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const isBlocked = useCallback(
    () => loadingRef.current || loadPendingRef.current,
    [],
  );

  const resetPage = useCallback(() => {
    pageRef.current = 0;
    loadPendingRef.current = false;
    setPage(0);
  }, []);

  const runLoad = useCallback(async (fn: () => Promise<void>) => {
    loadingRef.current = true;
    loadPendingRef.current = true;
    setLoading(true);
    try {
      await fn();
    } finally {
      loadingRef.current = false;
      loadPendingRef.current = false;
      setLoading(false);
    }
  }, []);

  const requestNextPage = useCallback(
    (onPage: (offset: number) => void | Promise<void>) => {
      if (isBlocked()) return false;
      loadPendingRef.current = true;
      const next = pageRef.current + 1;
      pageRef.current = next;
      setPage(next);
      void onPage(next * pageSize);
      return true;
    },
    [isBlocked, pageSize],
  );

  return {
    page,
    setPage,
    loading,
    setLoading,
    pageRef,
    loadingRef,
    loadPendingRef,
    isBlocked,
    resetPage,
    runLoad,
    requestNextPage,
  };
}
