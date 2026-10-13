import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function InfiniteListEnd({
  active = true,
  hasMore,
  isFetching,
  error,
  loadMore,
  root,
}: {
  active?: boolean;
  hasMore: boolean;
  isFetching: boolean;
  error?: Error | null;
  loadMore: () => Promise<unknown>;
  root?: RefObject<HTMLElement | null>;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !hasMore || isFetching || error || !endRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root: root?.current || null, rootMargin: "0px 0px 160px 0px" },
    );
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [active, hasMore, isFetching, error, loadMore, root]);

  return (
    <div
      ref={endRef}
      className="min-h-2 py-2 text-center text-sm text-muted-foreground"
    >
      {error ? (
        <div role="alert" className="space-y-2 text-destructive">
          <p>{error.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadMore();
            }}
          >
            Qayta urinish
          </Button>
        </div>
      ) : isFetching && hasMore ? (
        <div role="status" className="flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Yuklanmoqda…
        </div>
      ) : hasMore ? (
        <span>Davomini ko‘rish uchun pastga scroll qiling</span>
      ) : null}
    </div>
  );
}
