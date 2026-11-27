import { useCallback, useEffect, useRef, useState } from "react";

export function useAssistantNavigation(sidebarEscapeBlocked: boolean) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const sidebarClose = useRef<HTMLButtonElement>(null);
  const account = useRef<HTMLDivElement>(null);
  const profile = useRef<HTMLButtonElement>(null);

  const closeAccount = useCallback(() => {
    setMenuOpen(false);
    profile.current?.focus({ preventScroll: true });
  }, []);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    setMenuOpen(false);
    sidebarTrigger.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (sidebarOpen) sidebarClose.current?.focus({ preventScroll: true });
  }, [sidebarOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function outsideClick(event: MouseEvent) {
      // Click follows the browser's pointer focus, so the restored focus stays on the profile.
      if (event.target instanceof Node && !account.current?.contains(event.target)) closeAccount();
    }
    document.addEventListener("click", outsideClick);
    return () => document.removeEventListener("click", outsideClick);
  }, [menuOpen, closeAccount]);

  useEffect(() => {
    if (!menuOpen && (!sidebarOpen || sidebarEscapeBlocked)) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (menuOpen) closeAccount();
      else closeSidebar();
      event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, sidebarOpen, sidebarEscapeBlocked, closeAccount, closeSidebar]);

  return { sidebarOpen, setSidebarOpen, sidebarTrigger, sidebarClose, closeSidebar,
    menuOpen, setMenuOpen, account, profile, closeAccount };
}
