import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase-config'; // adjust the path to your Firebase setup

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const PAGE_SIZE = 10;

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
  if (!user) throw new Error('Sign in to see artists.');
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

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

const btnSm =
  'rounded-md px-3 py-1.5 text-sm font-medium transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]';
const btnPrimary =
  'rounded-lg bg-[#45152f] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]';
const inputCls =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#45152f] focus:outline-none focus:ring-2 focus:ring-[#45152f]/20';

const fmtDate = (iso) => {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString();
};

const fmtDateTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const STATUS = {
  won: { label: 'Winner', cls: 'bg-amber-100 text-amber-900 ring-amber-300' },
  accepted: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  pending: { label: 'Newly accepted', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  registered: { label: 'Registered', cls: 'bg-slate-100 text-slate-700 ring-slate-300' },
  eliminated: { label: 'Eliminated', cls: 'bg-rose-50 text-rose-800 ring-rose-200' },
};

const VOTE_LABEL = {
  eliminated: 'Eliminated',
  general_voting_closed: 'Voting closed',
  not_top10_finalist: 'Voting closed',
  waiting_top10_result: 'Voting paused',
};

// --------------------------------------------------------------------------- //
// Small pieces
// --------------------------------------------------------------------------- //

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 text-xl leading-none text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#45152f]"
          >
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Confirm({ title, text, action, danger, busy, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-slate-700">{text}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} disabled={busy} className={`${btnSm} border border-slate-200 text-slate-700`}>
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
            danger
              ? 'bg-rose-600 hover:bg-rose-700 focus-visible:outline-rose-600'
              : 'bg-[#45152f] hover:bg-[#5b1d3e] focus-visible:outline-[#45152f]'
          }`}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}

function DetailsModal({ artist, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api(`/api/competitions/${encodeURIComponent(artist.competitionId)}/artists/${encodeURIComponent(artist.artistId)}?source=${artist.source}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [artist]);

  const rowsList = data
    ? [
        ['Competition', data.competitionName],
        ['ID number', data.idNo || 'N/A'],
        ['Account number', data.accountNo || 'N/A'],
        ['Registration fee', data.registrationFee != null ? `R${Number(data.registrationFee).toFixed(2)}` : 'N/A'],
        ['Registered', fmtDate(data.registeredAt)],
      ]
    : [];

  return (
    <Modal title={artist.artistName} onClose={onClose}>
      {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      {data && (
        <>
          {data.images?.[0] && (
            <img src={data.images[0]} alt={data.artistName} className="mb-4 max-h-64 w-full rounded-lg object-cover" />
          )}
          <dl className="divide-y divide-slate-100 text-sm">
            {rowsList.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2">
                <dt className="text-slate-500">{k}</dt>
                <dd className="text-right font-medium text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Modal>
  );
}

function RegisterModal({ onClose }) {
  const [comps, setComps] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pick, setPick] = useState('');
  const [artistName, setArtistName] = useState('');
  const [idNo, setIdNo] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api('/api/competitions')
      .then((d) => live && setComps(d))
      .catch((e) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const chosen = comps?.find((c) => `${c.source}:${c.id}` === pick);

  const submit = async (e) => {
    e.preventDefault();
    if (!chosen || !file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('imageType', 'artist');
      const up = await api('/api/uploads/image', { method: 'POST', body: form });

      const reg = await api(`/api/competitions/${chosen.id}/register`, {
        method: 'POST',
        body: JSON.stringify({
          source: chosen.source,
          artistName: artistName.trim(),
          idNo,
          accountNo,
          images: [up.downloadURL],
          paymentGateway: 'PAYFAST',
        }),
      });
      window.location.href = reg.paymentUrl; // PayFast brings the artist back to /artists
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Register an artist" onClose={onClose}>
      {loadError && <p role="alert" className="text-sm text-rose-700">{loadError}</p>}
      {comps && comps.length === 0 && (
        <p className="text-sm text-slate-600">No competitions are open for registration right now.</p>
      )}
      {comps && comps.length > 0 && (
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Competition
            <select required value={pick} onChange={(e) => setPick(e.target.value)} className={inputCls}>
              <option value="">Choose a competition</option>
              {comps.map((c) => (
                <option key={`${c.source}:${c.id}`} value={`${c.source}:${c.id}`}>
                  {c.name} (R{Number(c.artistPrice).toFixed(2)})
                </option>
              ))}
            </select>
          </label>
          {chosen?.artistClosingDateTime && (
            <p className="-mt-2 text-xs text-slate-500">
              Registration closes {fmtDateTime(chosen.artistClosingDateTime)}.
            </p>
          )}
          <label className="block text-sm font-medium text-slate-700">
            Artist name
            <input required maxLength={100} value={artistName} onChange={(e) => setArtistName(e.target.value)} className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-slate-700">
              ID number
              <input
                required
                inputMode="numeric"
                pattern="\d{1,13}"
                title="Up to 13 digits"
                value={idNo}
                onChange={(e) => setIdNo(e.target.value.replace(/\D/g, ''))}
                className={inputCls}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Account number
              <input
                required
                inputMode="numeric"
                pattern="\d{1,32}"
                title="Up to 32 digits"
                value={accountNo}
                onChange={(e) => setAccountNo(e.target.value.replace(/\D/g, ''))}
                className={inputCls}
              />
            </label>
          </div>
          <label className="block text-sm font-medium text-slate-700">
            Poster image (JPG, PNG or WebP, up to 5 MB)
            <input
              required
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200"
            />
          </label>
          {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} disabled={busy} className={`${btnSm} border border-slate-200 text-slate-700`}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !chosen || !file} className={btnPrimary}>
              {chosen ? `Register and pay R${Number(chosen.artistPrice).toFixed(2)}` : 'Register and pay'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export default function Artists() {
  const navigate = useNavigate();
  // Optional filters: /artists?eventId=<competition id>&source=posts|judge-form
  const [params] = useSearchParams();
  const eventId = params.get('eventId');
  const sourceParam = params.get('source');

  const [rows, setRows] = useState([]);
  const [viewer, setViewer] = useState({ canRegister: false });
  const [loaded, setLoaded] = useState(false); // nothing is drawn for the list until the first answer
  const [error, setError] = useState(null); // only set when a request fails (e.g. network problem)

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [popup, setPopup] = useState(null); // { type: 'details' | 'register' | 'eliminate', artist? }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api('/api/artists');
      setRows(data.artists ?? []);
      setViewer(data.viewer ?? { canRegister: false });
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fetch again as soon as the connection comes back
  useEffect(() => {
    window.addEventListener('online', load);
    return () => window.removeEventListener('online', load);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Owner action (eliminate)
  const run = async (url, success) => {
    setBusy(true);
    try {
      await api(url, { method: 'POST' });
      setToast(success);
      setPopup(null);
      await load();
    } catch (e) {
      setToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  // One competition only, when the link carries eventId
  const scoped = useMemo(
    () => rows.filter((r) => !eventId || (r.competitionId === eventId && (!sourceParam || r.source === sourceParam))),
    [rows, eventId, sourceParam],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((r) =>
      [r.artistName, r.competitionName, r.genres, r.description].some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [scoped, search]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const shown = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

  const title = eventId ? `Artists in ${scoped[0]?.competitionName ?? 'this competition'}` : 'Artists';

  // Opens the voting page for exactly this artist in exactly this competition
  const goVote = (a) =>
    navigate(
      `/competitions/${encodeURIComponent(a.competitionId)}/artists/${encodeURIComponent(a.artistId)}/vote?source=${a.source}`,
    );

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-1 text-sm text-slate-600">Artists you can view and vote for.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className={`${btnSm} border border-slate-200 bg-white text-slate-700`}>
              Refresh
            </button>
            {viewer.canRegister && (
              <button onClick={() => setPopup({ type: 'register' })} className={btnPrimary}>
                Register an artist
              </button>
            )}
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
          >
            <span>{error}</span>
            <button onClick={load} className={`${btnSm} border border-rose-200 bg-white text-rose-800`}>
              Try again
            </button>
          </div>
        )}

        <div className="mt-5">
          <label htmlFor="artist-search" className="sr-only">Search artists</label>
          <input
            id="artist-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search by name, competition, genre or description"
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 focus:border-[#45152f] focus:outline-none focus:ring-2 focus:ring-[#45152f]/20"
          />
        </div>

        {loaded && (
        <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          {shown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Artist</th>
                    <th scope="col" className="px-4 py-3 font-medium">Competition</th>
                    <th scope="col" className="px-4 py-3 font-medium">Status</th>
                    <th scope="col" className="px-4 py-3 font-medium">Votes</th>
                    <th scope="col" className="px-4 py-3 font-medium">Date</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((a) => {
                    const st = STATUS[a.status] ?? STATUS.registered;
                    const canEliminate =
                      a.canManage && a.origin === 'accepted' && a.acceptedId && !a.votingClosed && a.status !== 'eliminated' && a.status !== 'won';
                    return (
                      <tr key={a.key} className={a.status === 'eliminated' ? 'bg-slate-50 text-slate-500' : a.isWinner ? 'bg-amber-50/60' : ''}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {a.images?.[0] ? (
                              <img src={a.images[0]} alt="" className="h-12 w-16 flex-none rounded-md object-cover" />
                            ) : (
                              <div className="flex h-12 w-16 flex-none items-center justify-center rounded-md bg-slate-200 text-xs text-slate-500">
                                No image
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-slate-900">{a.artistName}</p>
                              {a.genres && <p className="truncate text-xs text-slate-500">{a.genres}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{a.competitionName}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${st.cls}`}>
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-slate-700">
                          {a.votes ?? <span title="Shown after voting closes" className="text-slate-400">Hidden</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{fmtDate(a.date)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              onClick={() => setPopup({ type: 'details', artist: a })}
                              className={`${btnSm} border border-slate-200 text-slate-700`}
                            >
                              Details
                            </button>
                            {canEliminate && (
                              <button
                                onClick={() => setPopup({ type: 'eliminate', artist: a })}
                                className={`${btnSm} border border-rose-200 text-rose-700`}
                              >
                                Eliminate
                              </button>
                            )}
                            {a.canVote ? (
                              <button
                                onClick={() => goVote(a)}
                                aria-label={`Vote now for ${a.artistName}`}
                                className="rounded-md bg-[#45152f] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#5b1d3e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
                              >
                                Vote now
                              </button>
                            ) : (
                              <span className="px-2 py-1.5 text-sm text-slate-500">
                                {a.isWinner ? 'Winner' : VOTE_LABEL[a.votingStatus] ?? 'Voting closed'}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {shown.length === 0 && (
            <p className="p-10 text-center text-sm text-slate-500">
              {search ? 'No artists match your search.' : 'No artists yet. Registered and accepted artists will appear here.'}
            </p>
          )}

          <div className="flex items-center justify-between border-t border-slate-100 p-4 text-sm text-slate-500">
            <span>{filtered.length === 0 ? '0 artists' : `${cur * PAGE_SIZE + 1} to ${cur * PAGE_SIZE + shown.length} of ${filtered.length}`}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(cur - 1)} disabled={cur === 0} className={`${btnSm} border border-slate-200 text-slate-700`}>Previous</button>
              <button onClick={() => setPage(cur + 1)} disabled={cur >= pages - 1} className={`${btnSm} border border-slate-200 text-slate-700`}>Next</button>
            </div>
          </div>
        </section>
        )}
      </div>

      {popup?.type === 'details' && <DetailsModal artist={popup.artist} onClose={() => setPopup(null)} />}
      {popup?.type === 'register' && <RegisterModal onClose={() => setPopup(null)} />}
      {popup?.type === 'eliminate' && (
        <Confirm
          danger
          title="Eliminate artist"
          text={`Eliminate ${popup.artist.artistName} from ${popup.artist.competitionName}? They can't be voted for afterwards.`}
          action="Eliminate"
          busy={busy}
          onConfirm={() => run(`/api/accepted-artists/${popup.artist.acceptedId}/eliminate`, 'Artist eliminated.')}
          onClose={() => setPopup(null)}
        />
      )}

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#45152f] px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}