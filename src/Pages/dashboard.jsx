import { useState, useEffect, useMemo } from "react";
import { useNavigate } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth } from '../firebase-config';

const FUNCTIONS_REGION = 'us-central1';
const PERIODS = ["7 days", "30 days", "90 days"];

const STAT_STYLES = {
  votes: { label: "Total votes cast", icon: "↗", color: "bg-pink-50 text-pink-600" },
  competitions: { label: "Active competitions", icon: "◇", color: "bg-purple-50 text-purple-600" },
  artists: { label: "Registered artists", icon: "♙", color: "bg-orange-50 text-orange-600" },
  voters: { label: "Registered voters", icon: "♧", color: "bg-sky-50 text-sky-600" },
};

const BAR_COLORS = ["bg-pink-500", "bg-purple-500", "bg-orange-400", "bg-sky-500", "bg-emerald-500"];
const AVATAR_COLORS = [
  "bg-pink-100 text-pink-700",
  "bg-purple-100 text-purple-700",
  "bg-orange-100 text-orange-700",
  "bg-sky-100 text-sky-700",
];

const fmt = (n) => Number(n || 0).toLocaleString();

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

const timeAgo = (iso) => {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

const titleCase = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

const initialsOf = (name = "") =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const statusTone = (status) =>
  status === "Closing soon" || status === "Awaiting approval" ? "text-orange-600" : status === "Voting closed" ? "text-gray-400" : "text-emerald-600";

function Avatar({ name, src, className = "size-8 text-[10px]" }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={`shrink-0 rounded-full object-cover ${className}`} />;
  }
  return <span className={`grid shrink-0 place-items-center rounded-full font-[Manrope] font-extrabold ${className}`}>{initialsOf(name)}</span>;
}

function VotesChart({ series }) {
  const { path, area, max } = useMemo(() => {
    const values = series.map((p) => p.votes);
    const top = Math.max(...values, 1);
    if (values.length < 2) return { path: "", area: "", max: top };
    const pts = values.map((v, i) => [
      (i / (values.length - 1)) * 700,
      190 - (v / top) * 170,
    ]);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return { path: line, area: `${line} L700 200 L0 200 Z`, max: top };
  }, [series]);

  if (!path) {
    return <p className="mt-10 text-center text-xs text-[#948795]">No votes in this period yet.</p>;
  }

  return (
    <div className="mt-5">
      <div className="flex h-40 gap-3">
        <div className="flex flex-col justify-between text-[9px] text-[#948795]">
          <span>{fmt(max)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <svg viewBox="0 0 700 200" preserveAspectRatio="none" className="h-full w-full">
            <path d={area} fill="#e65aae" fillOpacity="0.08" />
            <path d={path} fill="none" stroke="#e65aae" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-7 text-[9px] text-[#948795]">
        <span>{series[0]?.label}</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function Dashboard({ backendStatus }) {
  const navigate = useNavigate();
  const [period, setPeriod] = useState("7 days");
  const [scope, setScope] = useState("mine");
  const [notice, setNotice] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { if (backendStatus) setNotice(backendStatus); }, [backendStatus]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    const getDashboardData = httpsCallable(getFunctions(auth.app, FUNCTIONS_REGION), "getDashboardData");
    getDashboardData({ period, scope })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => {
        console.error("Dashboard load error:", err?.code, err?.message);
        if (!cancelled) setError(err?.message || "Could not load dashboard data.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [period, scope]);

  const isAll = data?.scope === "all";
  const stats = data
    ? [
        { ...STAT_STYLES.votes, value: fmt(data.stats.totalVotes), change: data.stats.votesChange },
        { ...STAT_STYLES.competitions, value: String(data.stats.activeCompetitions).padStart(2, "0"), change: `${data.stats.activeCompetitions} accepting votes` },
        { ...STAT_STYLES.artists, label: isAll ? "Registered artists" : "Artists in your competitions", value: fmt(data.stats.artists), change: `+${fmt(data.stats.newArtists)} this period` },
        { ...STAT_STYLES.voters, label: isAll ? "Registered voters" : "Voters on your competitions", value: fmt(data.stats.voters), change: `+${fmt(data.stats.newVoters)} this period` },
      ]
    : Object.values(STAT_STYLES).map((s) => ({ ...s, value: "—", change: "" }));

  const authUser = auth.currentUser;
  const profile = data?.profile
    || (authUser ? { name: authUser.displayName || "", email: authUser.email || "", photoURL: authUser.photoURL || "" } : null);
  const owners = data?.owners || [];
  const competitions = data?.competitions || [];
  const activities = data?.activities || [];
  const series = data?.series || [];

  return (
    <div className="space-y-5">
      <section className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className="flex items-center gap-2 text-[9px] font-bold tracking-[1.7px] text-[#9c8195]">
            <span className="size-1.5 rounded-full bg-emerald-500" /> YOUR VOTING COMMAND CENTRE
          </p>
          <h2 className="mt-2 font-[Manrope] text-2xl font-extrabold sm:text-3xl">{greeting()}{profile?.name ? ", " : "."}{profile?.name && <span className="text-pink-600">{profile.name.split(" ")[0]}.</span>}</h2>
          <p className="mt-2 text-xs text-[#968996]">Here’s what’s happening across your competitions today.</p>
        </div>
        <div className="flex items-center gap-3">
          {profile?.isAdmin && (
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-label="Dashboard scope"
              className="rounded-lg border border-[#eee8ee] bg-white px-3 py-3 text-xs font-semibold text-[#6b5a6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400"
            >
              <option value="mine">My competitions</option>
              <option value="all">Whole platform</option>
            </select>
          )}
          <button onClick={() => navigate("/competition")} className="rounded-lg bg-[#45152f] px-4 py-3 text-xs font-bold text-white transition hover:bg-[#64214a]">＋ New competition</button>
        </div>
      </section>

      {profile && (
        <section className="flex items-center gap-4 rounded-xl border border-[#eee8ee] bg-white p-4">
          <Avatar name={profile.name || profile.email} src={profile.photoURL} className="size-12 bg-pink-100 text-sm text-[#4a1834]" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-[Manrope] text-sm font-extrabold">{profile.name || "Your profile"}</p>
            <p className="truncate text-xs text-[#948795]">
              {[profile.email, profile.phone, profile.location].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {profile.isAdmin && <span className="rounded-md bg-pink-50 px-2.5 py-1 text-[10px] font-bold text-pink-700">Admin</span>}
            {profile.role && <span className="rounded-md bg-purple-50 px-2.5 py-1 text-[10px] font-bold text-purple-700">{titleCase(profile.role)}</span>}
          </div>
        </section>
      )}

      {notice && <div className="flex items-center justify-between gap-3 rounded-lg border border-pink-100 bg-pink-50 p-3 text-xs text-pink-900">{notice} <button onClick={() => setNotice("")}>×</button></div>}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss">×</button>
        </div>
      )}

      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#351128] via-[#54183c] to-[#8e285f] p-6 text-white sm:p-8">
        <h2 className="mt-4 font-[Manrope] text-4xl font-extrabold leading-tight">Every vote tells<br/>a <em className="font-serif font-normal text-pink-300">story.</em></h2>
        <p className="mt-3 max-w-sm text-xs leading-6 text-pink-100/80">Discover your community’s favourites, follow the momentum, and make every vote count.</p>
        <button onClick={() => navigate("/dashboard")} className="mt-5 rounded-lg bg-pink-100 px-4 py-3 text-[10px] font-bold text-[#4a1834] hover:bg-white">Explore voting results ↗</button>
      </section>

      <section className={`grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 ${loading && !data ? "animate-pulse" : ""}`}>
        {stats.map(s => (
          <article key={s.label} className="rounded-xl border border-[#eee8ee] bg-white p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className={`grid size-9 place-items-center rounded-xl text-lg ${s.color}`}>{s.icon}</span>
              {s.change && <span className="rounded-md bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-700">{s.change}</span>}
            </div>
            <p className="text-[11px] text-[#948795]">{s.label}</p>
            <p className="mt-1 font-[Manrope] text-3xl font-extrabold">{s.value}</p>
          </article>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.7fr_0.9fr]">
        <article className="rounded-xl border border-[#eee8ee] bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-[Manrope] text-sm font-extrabold">Voting activity</h3>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              aria-label="Time period"
              className="rounded-md border border-[#eee8ee] bg-white px-2 py-1 text-[11px] text-[#6b5a6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400"
            >
              {PERIODS.map((p) => <option key={p} value={p}>Last {p}</option>)}
            </select>
          </div>
          {loading && !data ? (
            <p className="mt-10 text-center text-xs text-[#948795]">Loading…</p>
          ) : (
            <VotesChart series={series} />
          )}
        </article>

        <article className="rounded-xl border border-[#eee8ee] bg-white p-5">
          <h3 className="font-[Manrope] text-sm font-extrabold">Vote breakdown</h3>
          <div className="mt-4 space-y-4">
            {competitions.length === 0 && <p className="text-xs text-[#948795]">{loading ? "Loading…" : "No votes recorded yet."}</p>}
            {competitions.map(c => (
              <div key={c.id} className="flex justify-between gap-3 text-xs">
                <span className="truncate text-gray-500">{c.name}</span>
                <strong>{fmt(c.votes)}</strong>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.55fr_0.95fr]">
        <article className="rounded-xl border border-[#eee8ee] bg-white p-5">
          <h3 className="font-[Manrope] text-sm font-extrabold">Active competitions</h3>
          <div className="mt-4 space-y-5">
            {competitions.length === 0 && <p className="text-xs text-[#948795]">{loading ? "Loading…" : "You haven’t created a competition yet."}</p>}
            {competitions.map((c, i) => (
              <div key={c.id}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{c.name}</p>
                    <p className="text-[10px] text-[#948795]">{c.category} · {fmt(c.votes)} votes{c.owner?.name ? ` · by ${c.owner.name}` : ""}</p>
                  </div>
                  <strong className={`shrink-0 text-[11px] ${statusTone(c.status)}`}>{c.status}</strong>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#f3edf3]">
                  <div className={`h-full rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`} style={{ width: `${c.progress}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-xl border border-[#eee8ee] bg-white p-5">
          <h3 className="font-[Manrope] text-sm font-extrabold">Recent activity</h3>
          <div className="mt-4 space-y-4">
            {activities.length === 0 && <p className="text-xs text-[#948795]">{loading ? "Loading…" : "Nothing yet."}</p>}
            {activities.map((a, i) => (
              <div key={`${a.name}-${a.at}-${i}`} className="flex items-center gap-3 text-xs">
                <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[10px] font-bold ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>{initialsOf(a.name)}</span>
                <span className="min-w-0 flex-1"><strong className="font-semibold">{a.name}</strong> {a.detail}</span>
                <span className="shrink-0 text-gray-400">{timeAgo(a.at)}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      {isAll && (
      <section className="rounded-xl border border-[#eee8ee] bg-white p-5">
        <h3 className="font-[Manrope] text-sm font-extrabold">Competition owners</h3>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {owners.length === 0 && <p className="text-xs text-[#948795]">{loading ? "Loading…" : "No owners yet."}</p>}
          {owners.map((o, i) => (
            <article key={o.uid || o.email || i} className="flex items-center gap-3 rounded-lg border border-[#f3edf3] p-3">
              <Avatar name={o.name || o.email} src={o.photoURL} className={`size-10 text-xs ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`} />
              <div className="min-w-0 flex-1 text-xs">
                <p className="truncate font-semibold">{o.name || "Unnamed owner"}</p>
                <p className="truncate text-[10px] text-[#948795]">{[o.email, o.phone].filter(Boolean).join(" · ") || "No contact details"}</p>
                {o.location && <p className="truncate text-[10px] text-[#948795]">{o.location}</p>}
              </div>
              <span className="shrink-0 rounded-md bg-pink-50 px-2 py-1 text-[9px] font-bold text-pink-700">
                {o.competitions} {o.competitions === 1 ? "competition" : "competitions"}
              </span>
            </article>
          ))}
        </div>
      </section>
      )}

      <footer className="flex justify-between py-3 text-[9px] text-gray-400">
        <span>© 2026 VApp. Your voice. Your vote.</span>
      </footer>
    </div>
  );
}

export default Dashboard;