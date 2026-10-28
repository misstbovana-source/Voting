import React, { useState, useEffect, useMemo, useRef } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { signOut } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "../firebase-config";
import LOGO_URL from '../assets/Voting.logo.jpeg';


// const LOGO_URL = new URL("../assets/Voting.logo.jpeg", import.meta.url).href;

const LOGIN_PATH = "/login";
const FUNCTIONS_REGION = "us-central1";
const searchApp = httpsCallable(getFunctions(auth.app, FUNCTIONS_REGION), "searchApp");

const navigation = [
  { label: "Overview", icon: "◫", path: "/dashboard" },
  { label: "Competitions", icon: "◈", path: "/competition" },
  { label: "Artists", icon: "♙", path: "/artists" },
];

const searchablePages = [...navigation, { label: "My profile", icon: "☺", path: "/profile" }];

const EMPTY_REMOTE = { competitions: [], artists: [] };

function ResultGroup({ title, children }) {
  return (
    <div className="py-1">
      <p className="px-4 pb-1 pt-2 text-[9px] font-bold tracking-[1.7px] text-[#b2a5b1]">{title}</p>
      {children}
    </div>
  );
}

function ResultRow({ icon, title, subtitle, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs hover:bg-[#fbf4f9] focus-visible:bg-[#fbf4f9] focus-visible:outline-none"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-pink-50 text-sm text-pink-700">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-[#281d28]">{title}</span>
        {subtitle && <span className="block truncate text-[10px] text-[#948795]">{subtitle}</span>}
      </span>
    </button>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [remote, setRemote] = useState(EMPTY_REMOTE);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef(null);
  const inputRef = useRef(null);

  const trimmed = query.trim();

  const pageMatches = useMemo(() => {
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    return searchablePages.filter((p) => p.label.toLowerCase().includes(q));
  }, [trimmed]);

  useEffect(() => {
    if (trimmed.length < 2) {
      setRemote(EMPTY_REMOTE);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchApp({ q: trimmed });
        if (!cancelled) setRemote({ ...EMPTY_REMOTE, ...res.data });
      } catch (err) {
        console.error("Search error:", err?.code, err?.message);
        if (!cancelled) setRemote(EMPTY_REMOTE);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed]);

  useEffect(() => {
    const onMouseDown = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setSearchOpen(true);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const go = (path) => {
    navigate(path);
    setQuery("");
    setSearchOpen(false);
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await signOut(auth);
      navigate(LOGIN_PATH, { replace: true });
    } catch (err) {
      console.error("Logout error:", err?.message);
      setLoggingOut(false);
    }
  };

  const hasRemote = remote.competitions.length > 0 || remote.artists.length > 0;
  const hasResults = pageMatches.length > 0 || hasRemote;

  return (
    <div className="min-h-screen bg-[#faf8fa] text-[#281d28] flex">
      <aside className={`fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-[#eee8ee] bg-white px-4 py-6 transition-all duration-300 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full invisible w-0 p-0 border-r-0"
      }`}>
        <div className="mb-8 flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            {/* Kept the same size-10 rounded-xl shape, now displaying the image asset */}
          <img
  src={LOGO_URL}
  alt="VApp Logo"
  className="size-10 rounded-xl object-cover"
/>

            <div>
              <h1 className="font-extrabold text-lg">VApp</h1>
              <p className="text-[9px] font-bold tracking-[2.1px] text-[#a095a0]">VOTING PLATFORM</p>
            </div>
          </div>
        </div>

        <p className="mb-3 px-3 text-[9px] font-bold tracking-[1.7px] text-[#b2a5b1]">WORKSPACE</p>
        <nav className="flex flex-col gap-1">
          {navigation.map((item) => (
            <button key={item.label} onClick={() => navigate(item.path)} className={`flex items-center gap-3 rounded-lg px-3 py-3 text-xs transition ${
              location.pathname === item.path ? "bg-pink-50 font-bold text-pink-700" : "text-[#756a75] hover:bg-[#fbf4f9]"
            }`}>
              <span className="w-5 text-center text-lg">{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto border-t border-[#eee8ee] pt-4">
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-xs font-semibold text-[#756a75] transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400"
          >
            <span className="w-5 text-center text-lg">⎋</span>
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </aside>

      <div className={`flex-grow min-w-0 transition-all duration-300 ${sidebarOpen ? "md:ml-60" : "md:ml-0"}`}>
        <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between gap-4 border-b border-[#eee8ee] bg-white/95 px-4 backdrop-blur sm:px-8">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="shrink-0 text-xl p-2 rounded-lg hover:bg-gray-100 transition">
            {sidebarOpen ? "☰" : "Menu"}
          </button>

          <div ref={searchRef} className="relative min-w-0 max-w-xl flex-1">
            <label htmlFor="global-search" className="sr-only">Search the app</label>
            <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#b2a5b1]">⌕</span>
            <input
              id="global-search"
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search competitions, artists, pages…"
              autoComplete="off"
              className="w-full rounded-lg border border-[#eee8ee] bg-[#faf8fa] py-2.5 pl-9 pr-4 text-xs text-[#281d28] placeholder:text-[#b3a6b3] focus-visible:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400"
            />

            {searchOpen && trimmed && (
              <div className="absolute left-0 right-0 top-full mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-[#eee8ee] bg-white py-1 shadow-lg">
                {pageMatches.length > 0 && (
                  <ResultGroup title="PAGES">
                    {pageMatches.map((p) => (
                      <ResultRow key={p.path} icon={p.icon} title={p.label} onClick={() => go(p.path)} />
                    ))}
                  </ResultGroup>
                )}

                {remote.competitions.length > 0 && (
                  <ResultGroup title="COMPETITIONS">
                    {remote.competitions.map((c) => (
                      <ResultRow
                        key={`${c.source}_${c.id}`}
                        icon="◈"
                        title={c.name}
                        subtitle={[c.category, c.location].filter(Boolean).join(" · ")}
                        onClick={() => go(`/artists?eventId=${c.id}&source=${c.source}`)}
                      />
                    ))}
                  </ResultGroup>
                )}

                {remote.artists.length > 0 && (
                  <ResultGroup title="ARTISTS">
                    {remote.artists.map((a) => (
                      <ResultRow
                        key={`${a.source}_${a.competitionId}_${a.id}`}
                        icon="♙"
                        title={a.name}
                        subtitle={a.competitionName}
                        onClick={() => go(`/competitions/${a.competitionId}/artists/${a.id}/vote?source=${a.source}`)}
                      />
                    ))}
                  </ResultGroup>
                )}

                {trimmed.length < 2 && !hasResults && (
                  <p className="px-4 py-4 text-xs text-[#948795]">Type at least 2 characters to search.</p>
                )}
                {searching && <p className="px-4 py-3 text-xs text-[#948795]">Searching…</p>}
                {!searching && trimmed.length >= 2 && !hasResults && (
                  <p className="px-4 py-4 text-xs text-[#948795]">No results for “{trimmed}”.</p>
                )}
              </div>
            )}
          </div>

          <button onClick={() => navigate('/profile')} className="grid size-8 shrink-0 place-items-center rounded-full bg-pink-100 text-xs font-bold text-pink-800 hover:bg-pink-200 transition cursor-pointer">
            TB
          </button>
        </header>

        <div className="mx-auto max-w-[1600px] p-6 sm:p-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
