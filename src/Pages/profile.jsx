import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase-config'; // adjust the path to your Firebase setup

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const MAX_BIO = 300;
const enc = encodeURIComponent;

// After a refresh Firebase restores the session a moment later, so wait for it instead of failing.
function waitForUser() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => {
      stop();
      resolve(u);
    });
  });
}

async function api(path, init = {}) {
  const user = await waitForUser();
  if (!user) throw new Error('Sign in to see profiles.');
  const token = await user.getIdToken();
  const isForm = init.body instanceof FormData;

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  } catch {
    throw new Error('Network problem. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'Something went wrong. Try again.');
  }
  return data;
}

// Loads one URL and tracks loading / error, for the pop-up views.
function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    api(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => live && setState({ data: null, error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const fmtDateTime = (iso) => {
  const date = fmtDate(iso);
  if (!date) return null;
  const time = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
};

const money = (n) => `R${Number(n || 0).toFixed(2)}`;

const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

// Phone photos are huge. Shrink to 1024px and re-encode as JPEG before uploading (falls back to the original).
async function shrinkImage(file, max = 1024) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // transparent PNGs would turn black as JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

const TABS = [
  { key: 'artist_posts', label: 'Artist posts', icon: '🎤', private: false, empty: 'No artist posts yet.' },
  { key: 'competitions', label: 'Competitions', icon: '🏆', private: false, empty: 'No competitions yet.' },
  { key: 'current_competitions', label: 'Votes', icon: '♡', private: true, empty: 'You haven’t voted yet.' },
  { key: 'ticket_history', label: 'Tickets', icon: '🎟️', private: true, empty: 'No tickets yet.' },
];

const EMPTY_LISTS = { artist_posts: [], competitions: [], current_competitions: [], ticket_history: [] };

const VOTING_CHIP = {
  eligible: ['Voting open', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  waiting_top10_result: ['Voting paused', 'bg-amber-50 text-amber-800 ring-amber-200'],
  not_top10_finalist: ['Voting closed', 'bg-slate-100 text-slate-600 ring-slate-200'],
  general_voting_closed: ['Voting closed', 'bg-slate-100 text-slate-600 ring-slate-200'],
  eliminated: ['Eliminated', 'bg-rose-50 text-rose-700 ring-rose-200'],
};

const btnPrimary =
  'inline-flex items-center justify-center rounded-xl bg-[#543737] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#6e4d4d] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#543737]';
const btnGhost =
  'inline-flex items-center justify-center rounded-xl border border-[#e6dde2] bg-white px-4 py-2.5 text-sm font-bold text-[#543737] transition hover:bg-[#faf6f7] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#543737]';

// --------------------------------------------------------------------------- //
// Small pieces
// --------------------------------------------------------------------------- //

function Spinner({ className = 'h-5 w-5 border-[#543737]' }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-t-transparent ${className}`}
    />
  );
}

function Chip({ children, tone = 'bg-slate-100 text-slate-700 ring-slate-200' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold shadow-sm ring-1 ${tone}`}>
      {children}
    </span>
  );
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-extrabold tracking-tight text-[#281d28]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 grid h-8 w-8 flex-none place-items-center rounded-full text-xl leading-none text-[#8c7272] transition hover:bg-[#f6f0f2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#543737]"
          >
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function ModalSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden="true">
      <div className="h-48 w-full rounded-xl bg-[#f3eef0]" />
      <div className="h-4 w-2/3 rounded bg-[#f3eef0]" />
      <div className="h-4 w-1/2 rounded bg-[#f3eef0]" />
    </div>
  );
}

function ErrorText({ children }) {
  return (
    <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-800 ring-1 ring-rose-200">
      {children}
    </p>
  );
}

function Rows({ rows }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return (
    <dl className="mt-4 divide-y divide-[#f2edf0] overflow-hidden rounded-xl border border-[#f2edf0] bg-[#fdfbfc] text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-3.5 py-2.5">
          <dt className="text-[#8c7272]">{k}</dt>
          <dd className="text-right font-semibold text-[#281d28]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Hero({ src, alt }) {
  return src ? (
    <img src={src} alt={alt} className="h-56 w-full rounded-xl object-cover" />
  ) : (
    <div className="grid h-40 w-full place-items-center rounded-xl bg-gradient-to-br from-[#f3ecec] to-[#e9dede] text-4xl text-[#c9b9b9]">
      🎵
    </div>
  );
}

// One card used for artist posts, competitions and votes.
function ItemCard({ image, title, subtitle, chips, meta, onClick }) {
  return (
    <button
      onClick={onClick}
      className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[#eee8ee] bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#543737]"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#f3eef0]">
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-3xl text-[#c9b9b9]">🎵</div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/40 to-transparent" />
        {chips && <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">{chips}</div>}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3.5">
        <h3 className="truncate text-sm font-extrabold text-[#281d28]">{title}</h3>
        {subtitle && <p className="truncate text-xs font-semibold text-[#8c7272]">{subtitle}</p>}
        {meta && <p className="mt-auto pt-2 text-[11px] font-semibold text-slate-400">{meta}</p>}
      </div>
    </button>
  );
}

function TicketCard({ ticket }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-2xl border border-[#eee8ee] bg-white shadow-sm">
      <div className="relative hidden w-28 flex-none bg-[#f3eef0] min-[480px]:block">
        {ticket.imageUrl ? (
          <img src={ticket.imageUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-2xl text-[#c9b9b9]">🎟️</div>
        )}
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col justify-between gap-3 border-l border-dashed border-[#e6dde2] p-4">
        <span className="absolute -left-2 -top-2 hidden h-4 w-4 rounded-full bg-[#faf9fa] min-[480px]:block" />
        <span className="absolute -bottom-2 -left-2 hidden h-4 w-4 rounded-full bg-[#faf9fa] min-[480px]:block" />
        <div>
          <h4 className="truncate text-sm font-extrabold text-[#281d28] sm:text-base">{ticket.eventName}</h4>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-pink-600">{ticket.ticketType}</p>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-2 border-t border-dashed border-[#eee8ee] pt-2.5">
          <div className="flex gap-4 text-[11px] font-semibold text-slate-500">
            <p>
              <span className="font-black text-[#543737]">Qty</span> {ticket.quantityBought}
            </p>
            <p>
              <span className="font-black text-[#543737]">Total</span> {money(ticket.totalPaid)}
            </p>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {fmtDateTime(ticket.purchasedAt) ?? 'Processing…'}
          </p>
        </div>
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="min-h-screen bg-[#fcfbfc] px-3 py-4 sm:px-6 sm:py-8" aria-busy="true">
      <div className="mx-auto max-w-5xl animate-pulse overflow-hidden rounded-3xl border border-[#f0ebf0] bg-white shadow-sm">
        <div className="h-32 bg-[#eadfe0] sm:h-44" />
        <div className="-mt-12 flex flex-col items-center gap-4 px-6 pb-6 md:flex-row md:items-end">
          <div className="h-28 w-28 rounded-full border-4 border-white bg-[#e6dde2]" />
          <div className="space-y-2">
            <div className="h-6 w-44 rounded bg-[#eee8ee]" />
            <div className="h-4 w-64 rounded bg-[#f3eef0]" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 bg-[#faf9fa] p-6 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="aspect-[4/3] rounded-2xl bg-[#f0eaed]" />
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Pop-up views
// --------------------------------------------------------------------------- //

function ArtistView({ target, isSelf, onClose, onVote, onVoters }) {
  const { data, error, loading } = useApi(
    `/api/competitions/${enc(target.competitionId)}/artists/${enc(target.artistId)}/voting?source=${enc(target.source)}`,
  );
  const a = data?.artist;
  const chip = a && VOTING_CHIP[a.votingStatus];

  return (
    <Modal title={target.name || 'Artist'} onClose={onClose}>
      {loading && <ModalSkeleton />}
      {error && <ErrorText>{error}</ErrorText>}
      {a && (
        <>
          <Hero src={a.imageUrl} alt={a.artistName} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {chip && <Chip tone={chip[1]}>{chip[0]}</Chip>}
            {a.competitionName && <span className="text-sm font-semibold text-[#8c7272]">{a.competitionName}</span>}
          </div>
          <Rows
            rows={[
              ['Voting closes', fmtDateTime(a.votingClosingDateTime)],
              ['Top results', fmtDateTime(a.top10ClosingDateTime)],
            ]}
          />
          <div className="mt-5 flex flex-wrap gap-2">
            {a.votingStatus === 'eligible' && (
              <button onClick={() => onVote(a)} className={btnPrimary}>
                Vote now
              </button>
            )}
            {isSelf && a.canViewVoters && (
              <button onClick={() => onVoters(a)} className={btnGhost}>
                Top voters
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function CompetitionView({ target, isSelf, onClose, onArtists, onVoters }) {
  const { data, error, loading } = useApi(`/api/competitions/${enc(target.id)}/overview?source=${enc(target.source)}`);
  const c = data?.competition;

  return (
    <Modal title={target.name || 'Competition'} onClose={onClose}>
      {loading && <ModalSkeleton />}
      {error && <ErrorText>{error}</ErrorText>}
      {c && (
        <>
          <Hero src={c.imageUrl} alt={c.name} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {c.awaitingApproval ? (
              <Chip tone="bg-amber-50 text-amber-800 ring-amber-200">Awaiting approval</Chip>
            ) : c.votingClosed ? (
              <Chip tone="bg-slate-100 text-slate-600 ring-slate-200">Voting closed</Chip>
            ) : (
              <Chip tone="bg-emerald-50 text-emerald-700 ring-emerald-200">Open</Chip>
            )}
            {c.isOwner && <Chip tone="bg-[#f6eeee] text-[#543737] ring-[#e9dada]">You host this</Chip>}
          </div>
          {c.description && <p className="mt-3 text-sm leading-relaxed text-slate-600">{c.description}</p>}
          <Rows
            rows={[
              ['Artist registration fee', c.artistPrice ? money(c.artistPrice) : null],
              ['Registration closes', fmtDateTime(c.artistClosingDateTime)],
              ['Voting closes', fmtDateTime(c.votingClosingDateTime)],
              ['Top results', fmtDateTime(c.top10ClosingDateTime)],
              ['Places in the top', c.topCount],
            ]}
          />
          <div className="mt-5 flex flex-wrap gap-2">
            <button onClick={() => onArtists(c)} className={btnPrimary}>
              View artists
            </button>
            {isSelf && c.votingClosed && c.canViewVoters && (
              <button onClick={() => onVoters(c)} className={btnGhost}>
                Top voters
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

const MEDAL = ['🥇', '🥈', '🥉'];

function TopVotersView({ target, onClose }) {
  // With an artist id: that artist's voters. Without one: the whole competition's top voters.
  const path = target.id
    ? `/api/competitions/${enc(target.competitionId)}/artists/${enc(target.id)}/top-voters?source=${enc(target.source)}`
    : `/api/competitions/${enc(target.competitionId)}/top-voters?source=${enc(target.source)}`;
  const { data, error, loading } = useApi(path);
  const max = Math.max(1, ...(data?.voters ?? []).map((v) => v.votes));

  return (
    <Modal title={`Top voters${target.artistName ? ` for ${target.artistName}` : ''}`} onClose={onClose}>
      {loading && <ModalSkeleton />}
      {error && <ErrorText>{error}</ErrorText>}
      {data?.locked && (
        <div className="rounded-xl bg-amber-50 px-4 py-6 text-center text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          🔒 {data.message}
        </div>
      )}
      {data && !data.locked && (
        <>
          <div className="grid grid-cols-2 gap-3 text-center">
            <div className="rounded-xl bg-[#faf6f7] p-3">
              <p className="text-xl font-black text-[#543737]">{data.totalVotes}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#8c7272]">Votes</p>
            </div>
            <div className="rounded-xl bg-[#faf6f7] p-3">
              <p className="text-xl font-black text-[#543737]">{data.voterCount}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#8c7272]">Voters</p>
            </div>
          </div>
          {data.voters.length === 0 ? (
            <p className="py-8 text-center text-sm italic text-[#8c7272]">No votes yet.</p>
          ) : (
            <ol className="mt-4 space-y-2.5">
              {data.voters.map((v) => (
                <li key={v.rank} className="rounded-xl border border-[#f2edf0] p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2 font-bold text-[#281d28]">
                      <span className="w-6 flex-none text-center">{MEDAL[v.rank - 1] ?? v.rank}</span>
                      {v.imageUrl ? (
                        <img src={v.imageUrl} alt="" className="h-7 w-7 flex-none rounded-full object-cover" />
                      ) : (
                        <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-[#f3eef0] text-[10px] font-black text-[#543737]">
                          {initials(v.name)}
                        </span>
                      )}
                      <span className="truncate">{v.name}</span>
                    </span>
                    <span className="flex-none font-black text-[#543737]">
                      {v.votes} {v.votes === 1 ? 'vote' : 'votes'}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#f3eef0]">
                    <div className="h-full rounded-full bg-[#543737]" style={{ width: `${(v.votes / max) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export default function Profile() {
  const navigate = useNavigate();
  const { id } = useParams(); // /profile/:id shows someone else; no id shows your own profile
  const fileRef = useRef(null);

  const [profile, setProfile] = useState(null); // { uid, name, img, bio, isSelf }
  const [lists, setLists] = useState(EMPTY_LISTS);
  const [status, setStatus] = useState({ loading: true, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState('artist_posts');

  const [editingBio, setEditingBio] = useState(false);
  const [bioDraft, setBioDraft] = useState('');
  const [savingBio, setSavingBio] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState(null);

  // Pop-up views
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [selectedCompetition, setSelectedCompetition] = useState(null);
  const [selectedTopVoters, setSelectedTopVoters] = useState(null);

  useEffect(() => {
    let live = true;
    setStatus({ loading: true, error: null });
    api(`/api/profile/${enc(id ?? 'me')}`)
      .then((data) => {
        if (!live) return;
        const p = data.profile;
        setProfile({ uid: p.uid, name: p.name, img: p.imageUrl, bio: p.bio, isSelf: p.isSelf });
        setLists({ ...EMPTY_LISTS, ...data.lists });
        setStatus({ loading: false, error: null });
      })
      .catch((e) => live && setStatus({ loading: false, error: e.message }));
    return () => {
      live = false;
    };
  }, [id, reloadKey]);

  useEffect(() => {
    setTab('artist_posts');
    setEditingBio(false);
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ----- actions ------------------------------------------------------------

  const saveBio = async () => {
    setSavingBio(true);
    try {
      const data = await api('/api/profile/me', { method: 'PATCH', body: JSON.stringify({ bio: bioDraft }) });
      setProfile((p) => ({ ...p, bio: data.bio }));
      setEditingBio(false);
      setToast('Bio saved.');
    } catch (e) {
      setToast(e.message);
    } finally {
      setSavingBio(false);
    }
  };

  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setToast('Choose a JPG, PNG or WebP image.');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url); // show the new photo straight away
    setUploading(true);
    try {
      const blob = await shrinkImage(file);
      const form = new FormData();
      form.append('file', blob, 'profile.jpg');
      const data = await api('/api/profile/image', { method: 'POST', body: form });
      setProfile((p) => ({ ...p, img: data.imageUrl }));
      setToast('Profile photo updated.');
    } catch (err) {
      setToast(err.message);
    } finally {
      URL.revokeObjectURL(url);
      setPreview(null);
      setUploading(false);
    }
  };

  const goVote = (a) =>
    navigate(`/competitions/${enc(a.competitionId)}/artists/${enc(a.id)}/vote?source=${enc(a.source)}`);

  const openVoters = (a) => {
    setSelectedArtist(null);
    setSelectedTopVoters({
      id: a.id,
      competitionId: a.competitionId,
      source: a.source,
      artistName: a.artistName,
    });
  };

  const openCompetitionVoters = (c) => {
    setSelectedCompetition(null);
    setSelectedTopVoters({
      competitionId: c.id,
      source: c.source,
      artistName: c.name,
    });
  };

  const openArtists = (c) => navigate(`/artists?eventId=${enc(c.id)}&source=${enc(c.source)}`);

  // ----- loading / error ----------------------------------------------------

  if (status.loading) return <ProfileSkeleton />;

  if (status.error || !profile) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#fcfbfc] p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-[#eee8ee]">
          <h1 className="text-lg font-extrabold text-[#281d28]">We couldn’t load this profile</h1>
          <p className="mt-2 text-sm text-slate-600">{status.error ?? 'No profile data came back.'}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button onClick={() => setReloadKey((k) => k + 1)} className={btnPrimary}>
              Try again
            </button>
            <button onClick={() => navigate(-1)} className={btnGhost}>
              Go back
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ----- main view ----------------------------------------------------------

  const visibleTabs = TABS.filter((t) => !t.private || profile.isSelf);
  const activeTab = visibleTabs.find((t) => t.key === tab) ?? visibleTabs[0];
  const items = lists[activeTab.key] ?? [];
  const shownImg = preview ?? profile.img;

  const renderCard = (item) => {
    if (activeTab.key === 'artist_posts') {
      const chip = VOTING_CHIP[item.eliminated ? 'eliminated' : item.votingStatus];
      return (
        <ItemCard
          key={item.id}
          image={item.images?.[0]}
          title={item.name}
          subtitle={item.competitionName}
          chips={
            <>
              {chip && <Chip tone={chip[1]}>{chip[0]}</Chip>}
              {item.type === 'accepted_artist' && <Chip tone="bg-sky-50 text-sky-700 ring-sky-200">Accepted</Chip>}
            </>
          }
          meta={fmtDate(item.date)}
          onClick={() =>
            setSelectedArtist({
              competitionId: item.competitionId,
              artistId: item.artistId,
              source: item.source,
              name: item.name,
            })
          }
        />
      );
    }
    if (activeTab.key === 'competitions') {
      return (
        <ItemCard
          key={item.id}
          image={item.images?.[0]}
          title={item.name}
          subtitle={item.type === 'post_event' ? 'Hosted event' : 'Judged competition'}
          chips={
            item.awaitingApproval ? (
              <Chip tone="bg-amber-50 text-amber-800 ring-amber-200">Awaiting approval</Chip>
            ) : item.votingClosed ? (
              <Chip tone="bg-slate-100 text-slate-600 ring-slate-200">Voting closed</Chip>
            ) : (
              <Chip tone="bg-emerald-50 text-emerald-700 ring-emerald-200">Open</Chip>
            )
          }
          meta={item.votingClosesAt ? `Voting closes ${fmtDate(item.votingClosesAt)}` : fmtDate(item.date)}
          onClick={() => setSelectedCompetition({ id: item.id, source: item.source, name: item.name })}
        />
      );
    }
    // votes
    return (
      <ItemCard
        key={item.id}
        image={item.images?.[0]}
        title={item.name}
        subtitle={item.competitionName}
        chips={
          <Chip tone="bg-pink-50 text-pink-700 ring-pink-200">
            ♡ {item.totalVotes} {item.totalVotes === 1 ? 'vote' : 'votes'}
          </Chip>
        }
        meta={item.lastVotedAt ? `Last voted ${fmtDate(item.lastVotedAt)}` : null}
        onClick={
          item.competitionId
            ? () =>
                setSelectedArtist({
                  competitionId: item.competitionId,
                  artistId: item.artistId,
                  source: item.source,
                  name: item.name,
                })
            : undefined
        }
      />
    );
  };

  const stats = [
    ['Posts', lists.artist_posts.length],
    ['Comps', lists.competitions.length],
    ...(profile.isSelf
      ? [
          ['Votes', lists.current_competitions.length],
          ['Tickets', lists.ticket_history.length],
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-[#fcfbfc] px-3 py-4 text-[#281d28] sm:px-6 sm:py-8">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border border-[#f0ebf0] bg-white shadow-sm">
        {/* Cover */}
        <div className="relative h-32 overflow-hidden bg-gradient-to-tr from-[#543737] via-[#6e4d4d] to-[#8c7272] sm:h-44">
          <div className="absolute -right-10 -top-16 h-56 w-56 rounded-full bg-white/10" />
          <div className="absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-white/[0.07]" />
        </div>

        {/* Identity */}
        <div className="relative -mt-12 flex flex-col items-center justify-between gap-5 px-4 pb-6 text-center sm:-mt-14 sm:px-8 md:flex-row md:items-end md:text-left">
          <div className="flex flex-col items-center gap-4 md:flex-row md:items-end">
            <div className="relative z-10 h-24 w-24 flex-none sm:h-28 sm:w-28 lg:h-32 lg:w-32">
              <div className="relative h-full w-full overflow-hidden rounded-full border-4 border-white bg-[#f6f4f6] shadow-lg ring-1 ring-[#f0ebf0] md:rounded-3xl">
                {shownImg ? (
                  <img src={shownImg} alt={`${profile.name}’s profile`} className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center bg-gradient-to-br from-[#f3ecec] to-[#e9dede] text-3xl font-black text-[#543737]">
                    {initials(profile.name)}
                  </div>
                )}
                {uploading && (
                  <div className="absolute inset-0 grid place-items-center bg-black/40">
                    <Spinner className="h-6 w-6 border-white" />
                  </div>
                )}
              </div>
              {profile.isSelf && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={onPickImage}
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    aria-label="Change profile photo"
                    title="Change profile photo"
                    className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full bg-[#543737] text-sm text-white shadow-md ring-2 ring-white transition hover:bg-[#6e4d4d] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#543737]"
                  >
                    📷
                  </button>
                </>
              )}
            </div>

            <div className="mb-1 w-full max-w-md space-y-1.5">
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">{profile.name}</h1>

              {editingBio ? (
                <div className="w-full">
                  <textarea
                    value={bioDraft}
                    onChange={(e) => setBioDraft(e.target.value)}
                    maxLength={MAX_BIO}
                    rows={3}
                    autoFocus
                    aria-label="Bio"
                    className="w-full resize-none rounded-xl border border-[#e0d4d8] bg-white p-2.5 text-left text-sm text-[#281d28] outline-none focus:border-[#543737] focus:ring-2 focus:ring-[#543737]/20"
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-[#8c7272]">
                    <span>
                      {bioDraft.length}/{MAX_BIO}
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingBio(false)}
                        disabled={savingBio}
                        className="rounded-lg px-3 py-1.5 text-xs font-bold text-[#543737] hover:bg-[#f6f0f2] disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveBio}
                        disabled={savingBio}
                        className="rounded-lg bg-[#543737] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#6e4d4d] disabled:opacity-60"
                      >
                        {savingBio ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-center gap-1.5 md:justify-start">
                  <p className="line-clamp-3 max-w-xs text-xs font-semibold text-[#543737]/80 sm:text-sm md:max-w-md">
                    {profile.bio || (profile.isSelf ? 'Add a short bio so people know who you are.' : 'No bio yet.')}
                  </p>
                  {profile.isSelf && (
                    <button
                      onClick={() => {
                        setBioDraft(profile.bio);
                        setEditingBio(true);
                      }}
                      aria-label="Edit bio"
                      className="flex-none rounded-md px-1 text-xs opacity-70 transition hover:bg-[#f6f0f2] hover:opacity-100"
                    >
                      ✏️
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div
            className={`grid w-full gap-2 rounded-2xl border border-[#f5eff5] bg-[#fcf9fc] p-2 md:flex md:w-auto md:gap-6 md:p-3 ${
              stats.length === 4 ? 'grid-cols-4' : 'grid-cols-2'
            }`}
          >
            {stats.map(([label, value]) => (
              <div key={label} className="px-1 text-center sm:px-3">
                <span className="block text-base font-black text-[#543737]">{value}</span>
                <span className="text-[9px] font-bold uppercase tracking-wider text-[#8c7272]/85">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="border-y border-[#eee8ee] bg-[#fdfcfd] px-4 sm:px-8">
          <div role="tablist" className="scrollbar-none flex gap-2 overflow-x-auto py-3">
            {visibleTabs.map((t) => {
              const active = t.key === activeTab.key;
              const pink = t.key === 'current_competitions';
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className={`flex flex-none items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-xs font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#543737] ${
                    active
                      ? pink
                        ? 'bg-pink-600 text-white shadow-sm shadow-pink-100'
                        : 'bg-[#543737] text-white shadow-sm'
                      : pink
                        ? 'bg-pink-50/60 text-pink-600 hover:bg-pink-50'
                        : 'bg-gray-50 text-[#543737]/80 hover:bg-gray-100/70'
                  }`}
                >
                  <span aria-hidden="true">{t.icon}</span>
                  {t.label}
                  <span
                    className={`rounded-full px-1.5 py-px text-[10px] ${active ? 'bg-white/25' : 'bg-black/5'}`}
                  >
                    {lists[t.key].length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="bg-[#faf9fa] p-4 sm:p-8" role="tabpanel">
          {items.length === 0 ? (
            <div className="py-14 text-center">
              <div className="text-4xl opacity-60" aria-hidden="true">
                {activeTab.icon}
              </div>
              <p className="mt-3 text-sm font-bold italic text-[#8c7272]/80">{activeTab.empty}</p>
            </div>
          ) : activeTab.key === 'ticket_history' ? (
            <div className="grid grid-cols-1 gap-4 text-left lg:grid-cols-2">
              {items.map((t) => (
                <TicketCard key={t.id} ticket={t} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {items.map(renderCard)}
            </div>
          )}
        </div>
      </div>

      {selectedArtist && (
        <ArtistView
          target={selectedArtist}
          isSelf={profile.isSelf}
          onClose={() => setSelectedArtist(null)}
          onVote={goVote}
          onVoters={openVoters}
        />
      )}
      {selectedCompetition && (
        <CompetitionView
          target={selectedCompetition}
          isSelf={profile.isSelf}
          onClose={() => setSelectedCompetition(null)}
          onArtists={openArtists}
          onVoters={openCompetitionVoters}
        />
      )}
      {selectedTopVoters && <TopVotersView target={selectedTopVoters} onClose={() => setSelectedTopVoters(null)} />}

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl bg-[#543737] px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}