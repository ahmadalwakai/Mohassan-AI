import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MessageSquare, Search } from "lucide-react";
import type { ChatConversationList, ChatConversationSummary } from "@mohassan/contracts";
import styles from "./conversation-history.module.css";

type Page = Pick<ChatConversationList, "conversations" | "nextCursor">;
type HistoryPage = ChatConversationList & { expanded?: boolean };
type SearchResults = { query: string; page?: Page; error?: string };
type FetchPage = (options: { query?: string; cursor?: string; signal?: AbortSignal }) => Promise<ChatConversationList>;

const SEARCH_DELAY_MS = 250;
const empty: ChatConversationSummary[] = [];

function merge(first: ChatConversationSummary[], next: ChatConversationSummary[]) {
  const ids = new Set(first.map((item) => item.id));
  return [...first, ...next.filter((item) => !ids.has(item.id))];
}

export function refreshHistoryHead(history: HistoryPage | null, first: ChatConversationList): HistoryPage {
  const previousNewest = history?.conversations[0];
  const currentOldest = first.conversations.at(-1);
  if (!history?.expanded || !first.nextCursor || !previousNewest || !currentOldest) return first;
  const overlaps = currentOldest.updatedAt < previousNewest.updatedAt
    || first.conversations.some((item) => item.id === previousNewest.id && item.updatedAt === previousNewest.updatedAt);
  // A new first page can leap past the loaded range. In that case start from its cursor again.
  if (!overlaps) return first;
  const older = history.conversations.filter((item) => item.updatedAt <= currentOldest.updatedAt);
  return { ...first, conversations: merge(first.conversations, older), nextCursor: history.nextCursor, expanded: true };
}

export function useConversationHistory(fetchPage: FetchPage) {
  const [historyPage, setHistoryPage] = useState<HistoryPage | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<SearchResults | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const olderRequest = useRef<AbortController | null>(null);
  const headRequest = useRef(0);
  const removed = useRef(new Set<string>());
  const query = searchText.trim();
  const results = search?.query === query ? search : null;
  const page = query ? results?.page : historyPage;

  const withoutRemoved = useCallback(<T extends Page,>(page: T): T => ({
    ...page,
    conversations: page.conversations.filter((item) => !removed.current.has(item.id)),
  }), []);

  const refreshHistory = useCallback(async () => {
    const request = ++headRequest.current;
    try {
      const first = await fetchPage({});
      if (request === headRequest.current) {
        setHistoryPage((history) => refreshHistoryHead(history, withoutRemoved(first)));
        setHistoryError("");
      }
    } catch (error) {
      if (request === headRequest.current) setHistoryError("تعذر تحميل المحادثات.");
      throw error;
    }
  }, [fetchPage, withoutRemoved]);

  useEffect(() => () => {
    headRequest.current++;
    olderRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (!query) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      void fetchPage({ query, signal: request.signal }).then((page) => {
        if (!request.signal.aborted) setSearch({ query, page: withoutRemoved(page) });
      }).catch(() => {
        if (!request.signal.aborted) setSearch({ query, error: "تعذر البحث في المحادثات." });
      });
    }, SEARCH_DELAY_MS);
    return () => { clearTimeout(timer); request.abort(); };
  }, [fetchPage, query, searchAttempt, withoutRemoved]);

  function changeSearch(value: string) {
    setSearchText(value);
    if (value.trim() === query) return;
    olderRequest.current?.abort();
    olderRequest.current = null;
    setLoadingOlder(false);
    setOlderError("");
    setSearch(null);
  }

  function retry() {
    if (query) {
      setSearch(null);
      setSearchAttempt((attempt) => attempt + 1);
    } else {
      setHistoryError("");
      void refreshHistory().catch(() => {});
    }
  }

  async function loadOlder() {
    const cursor = page?.nextCursor;
    if (!cursor || olderRequest.current) return;
    const request = new AbortController();
    olderRequest.current = request;
    setLoadingOlder(true);
    setOlderError("");
    // A background refresh can replace the head while this page is in flight.
    if (!query) setHistoryPage((current) => current && { ...current, expanded: true });
    try {
      const next = await fetchPage({ query, cursor, signal: request.signal });
      if (request.signal.aborted) return;
      const append = <T extends Page,>(page: T): T => ({
        ...page,
        conversations: merge(page.conversations, withoutRemoved(next).conversations),
        nextCursor: next.nextCursor,
      });
      if (query) {
        setSearch((current) => current?.query === query && current.page?.nextCursor === cursor
          ? { query, page: append(current.page) } : current);
      } else {
        setHistoryPage((current) => current?.nextCursor === cursor ? append(current) : current);
      }
    } catch {
      if (!request.signal.aborted) setOlderError("تعذر تحميل محادثات أقدم.");
    } finally {
      if (olderRequest.current === request) {
        olderRequest.current = null;
        setLoadingOlder(false);
      }
    }
  }

  const remove = useCallback((id: string) => {
    removed.current.add(id);
    setHistoryPage((current) => current && withoutRemoved(current));
    setSearch((current) => current?.page ? { ...current, page: withoutRemoved(current.page) } : current);
  }, [withoutRemoved]);

  return {
    history: historyPage?.conversations ?? empty,
    configured: historyPage?.configured ?? null,
    capabilities: historyPage?.capabilities ?? null,
    items: page?.conversations ?? empty,
    searchText, changeSearch, refreshHistory, loadOlder, remove, retry,
    searching: Boolean(query),
    loading: query ? !results : !historyPage && !historyError,
    error: (query ? results?.error : historyError) ?? "",
    hasOlder: Boolean(page?.nextCursor),
    loadingOlder, olderError,
  };
}

type HistoryControls = ReturnType<typeof useConversationHistory>;

export function ConversationHistorySearch({ controls }: { controls: HistoryControls }) {
  return <label className={styles.search}>
    <Search size={16} aria-hidden="true" />
    <input type="search" dir="auto" aria-label="ابحث في المحادثات" placeholder="ابحث في المحادثات"
      value={controls.searchText} onChange={(event) => controls.changeSearch(event.target.value)} />
  </label>;
}

export function ConversationHistoryStatus({ controls }: { controls: HistoryControls }) {
  if (controls.loading) {
    return <p className={styles.status} role="status">{controls.searching ? "جارٍ البحث…" : "جارٍ تحميل المحادثات…"}</p>;
  }
  if (controls.error) {
    return <div className={styles.status}>
      <span role="alert">{controls.error}</span>
      <button type="button" className={styles.retry} onClick={controls.retry}>إعادة المحاولة</button>
    </div>;
  }
  if (controls.items.length || controls.hasOlder) return null;
  return <p className={styles.status} role="status">
    <MessageSquare size={16} aria-hidden="true" />
    {controls.searching ? "لا توجد محادثات مطابقة." : "ستظهر محادثاتك هنا."}
  </p>;
}

export function OlderConversations({ controls }: { controls: HistoryControls }) {
  return <>
    {controls.olderError ? <p className={styles.status} role="alert">{controls.olderError}</p> : null}
    {controls.hasOlder ? <button type="button" className={styles.older} disabled={controls.loadingOlder} onClick={() => void controls.loadOlder()}>
      <ChevronDown size={16} aria-hidden="true" />{controls.loadingOlder ? "جارٍ التحميل…" : "محادثات أقدم"}
    </button> : null}
  </>;
}
