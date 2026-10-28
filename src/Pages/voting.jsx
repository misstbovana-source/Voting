import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase-config'; // adjust the path to your Firebase setup

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// Minimum number of votes per purchase.
const MIN_VOTES = 5;

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
  if (!user) throw new Error('Sign in to vote.');
  const token = await user.getIdToken();

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'Something went wrong. Try again.');
  }
  return data;
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

const rand = (n) => `R${n.toFixed(2)}`;

const formatDateTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// votingStatus values: eligible | waiting_top10_result | not_top10_finalist | eliminated | general_voting_closed
const STATUS_COPY = {
  eligible: {
    label: 'Voting is open',
    detail: '',
    button: '',
    tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  },
  general_voting_closed: {
    label: 'Voting has closed',
    detail: 'This competition is no longer taking votes.',
    button: 'Voting closed',
    tone: 'bg-rose-50 text-rose-800 ring-rose-200',
  },
  waiting_top10_result: {
    label: 'Voting is paused',
    detail: 'Votes reopen once the top results are decided.',
    button: 'Voting paused',
    tone: 'bg-amber-50 text-amber-900 ring-amber-200',
  },
  not_top10_finalist: {
    label: 'Not in the top results',
    detail: 'This artist didn’t make the top count, so voting for them has ended.',
    button: 'Voting closed',
    tone: 'bg-slate-100 text-slate-700 ring-slate-300',
  },
  eliminated: {
    label: 'Eliminated',
    detail: 'This artist can’t receive more votes.',
    button: 'Eliminated',
    tone: 'bg-rose-50 text-rose-900 ring-rose-200',
  },
};

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export default function VotingPage() {
  const navigate = useNavigate();
  // Route: /competitions/:competitionId/artists/:artistId/vote?source=posts|judge-form
  // The ids can come from the path or from the query string (?competitionId=&artistId=&source=),
  // so the page works whichever way your router links to it.
  const params = useParams();
  const [search] = useSearchParams();
  const competitionId =
    params.competitionId ?? search.get('competitionId') ?? search.get('eventId') ?? search.get('hosterId');
  const artistId = params.artistId ?? search.get('artistId');
  const rawSource = search.get('source') ?? search.get('parentCollectionName');
  const source = rawSource === 'judge-form' ? 'judge-form' : 'posts'; // 'posts' and 'hosters' both mean a hosted competition

  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [quantity, setQuantity] = useState(MIN_VOTES);
  const [confirming, setConfirming] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);
  const [zoomed, setZoomed] = useState(false);

  const load = useCallback(async () => {
    if (!competitionId || !artistId) {
      setLoadError('This link is missing the artist or competition.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api(
        `/api/competitions/${encodeURIComponent(competitionId)}/artists/${encodeURIComponent(artistId)}/voting?source=${source}`,
      );
      setDetails(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load this artist.');
    } finally {
      setLoading(false);
    }
  }, [competitionId, artistId, source]);

  useEffect(() => {
    load();
  }, [load]);

  // Close the full-screen image with Escape
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e) => e.key === 'Escape' && setZoomed(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  const pricePerVote = details?.pricePerVote ?? 2;
  const maxVotes = Math.max(MIN_VOTES, details?.maxVotes ?? 1000);
  const total = useMemo(() => quantity * pricePerVote, [quantity, pricePerVote]);
  const belowMin = quantity < MIN_VOTES;

  const setQty = (n) => {
    setConfirming(false);
    setQuantity(Math.min(maxVotes, Math.max(1, Math.floor(n) || 1)));
  };

  const startPayment = async () => {
    if (!details) return;
    if (quantity < MIN_VOTES) {
      setPayError(`You must buy at least ${MIN_VOTES} votes.`);
      setConfirming(false);
      return;
    }
    setPaying(true);
    setPayError(null);
    try {
      const data = await api(
        `/api/competitions/${encodeURIComponent(details.artist.competitionId)}/artists/${encodeURIComponent(details.artist.id)}/vote`,
        {
          method: 'POST',
          body: JSON.stringify({
            source: details.artist.source,
            voteQuantity: quantity,
            paymentGateway: 'PAYFAST',
          }),
        },
      );
      window.location.href = data.paymentUrl; // PayFast sends the voter back here afterwards
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'Could not start the payment.');
      setPaying(false);
      setConfirming(false);
    }
  };

  // ----- loading / error states ---------------------------------------------

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="flex items-center gap-3 text-slate-600" role="status">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#45152f]" />
          Loading artist…
        </div>
      </main>
    );
  }

  if (loadError || !details) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
          <h1 className="text-lg font-semibold text-slate-900">We couldn’t load this artist</h1>
          <p className="mt-2 text-sm text-slate-600">{loadError ?? 'No artist data came back.'}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              onClick={load}
              className="rounded-lg bg-[#45152f] px-4 py-2 text-sm font-medium text-white hover:bg-[#5b1d3e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
            >
              Try again
            </button>
            <button
              onClick={() => navigate(-1)}
              className="rounded-lg bg-slate-200 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
            >
              Go back
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ----- main view ----------------------------------------------------------

  const { artist } = details;
  const status = artist.votingStatus;
  const copy = STATUS_COPY[status] ?? STATUS_COPY.general_voting_closed;
  const canVote = status === 'eligible';
  const canBuy = canVote && !belowMin;
  const closesAt = formatDateTime(artist.votingClosingDateTime);
  const top10At = formatDateTime(artist.top10ClosingDateTime);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col items-center">
        {/* Artist */}
        <button
          onClick={() => artist.imageUrl && setZoomed(true)}
          disabled={!artist.imageUrl}
          aria-label={`View ${artist.artistName}’s image full screen`}
          className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#45152f]"
        >
          {artist.imageUrl ? (
            <img
              src={artist.imageUrl}
              alt={artist.artistName}
              className="h-48 w-48 rounded-full border-4 border-white object-cover shadow-lg"
            />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-full border-4 border-white bg-slate-300 text-sm text-slate-600 shadow-lg">
              No image
            </div>
          )}
        </button>

        <h1 className="mt-6 text-center text-3xl font-bold tracking-tight text-slate-900">
          {artist.artistName}
        </h1>
        {artist.competitionName && (
          <p className="mt-1 text-center text-slate-600">{artist.competitionName}</p>
        )}

        {/* Status */}
        <div className={`mt-6 w-full rounded-xl px-4 py-3 text-center ring-1 ${copy.tone}`}>
          <p className="font-semibold">{copy.label}</p>
          {copy.detail && <p className="mt-0.5 text-sm">{copy.detail}</p>}
          {closesAt && (
            <p className="mt-1 text-sm opacity-80">
              {status === 'general_voting_closed' ? 'Closed' : 'Closes'} {closesAt}
            </p>
          )}
          {top10At && (status === 'waiting_top10_result' || status === 'not_top10_finalist') && (
            <p className="mt-1 text-sm opacity-80">Top results effective {top10At}</p>
          )}
        </div>

        {/* Vote picker */}
        <section className="mt-6 w-full rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-slate-600">Price per vote</h2>
            <p className="text-lg font-semibold text-slate-900">{rand(pricePerVote)}</p>
          </div>

          <div className="mt-5">
            <label htmlFor="vote-qty" className="text-sm font-medium text-slate-600">
              Number of votes
            </label>
            <div className="mt-2 flex items-center justify-center gap-3">
              <button
                onClick={() => setQty(quantity - 1)}
                disabled={!canVote || quantity <= 1}
                aria-label="Remove one vote"
                className="h-11 w-11 rounded-full bg-[#45152f] text-2xl font-semibold text-white transition hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
              >
                −
              </button>
              <input
                id="vote-qty"
                type="number"
                inputMode="numeric"
                min={1}
                max={maxVotes}
                value={quantity}
                disabled={!canVote}
                aria-invalid={canVote && belowMin}
                onChange={(e) => setQty(Number(e.target.value))}
                className="w-24 rounded-lg border border-[#45152f]/40 bg-slate-50 py-2 text-center text-2xl font-bold text-slate-900 focus:border-[#45152f] focus:outline-none focus:ring-2 focus:ring-[#45152f]/30 disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                onClick={() => setQty(quantity + 1)}
                disabled={!canVote || quantity >= maxVotes}
                aria-label="Add one vote"
                className="h-11 w-11 rounded-full bg-[#45152f] text-2xl font-semibold text-white transition hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
              >
                +
              </button>
            </div>

            {/* Alert when fewer than the minimum votes are selected */}
            {canVote && belowMin && (
              <p
                role="alert"
                className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-center text-sm font-medium text-amber-900 ring-1 ring-amber-200"
              >
                The minimum is {MIN_VOTES} votes. You’ve selected {quantity}. Add{' '}
                {MIN_VOTES - quantity} more to continue.
              </p>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4">
            <span className="font-semibold text-slate-900">Total to pay</span>
            <span className="text-2xl font-bold text-[#45152f]">{rand(total)}</span>
          </div>
        </section>

        {/* Pay */}
        <section className="mt-4 w-full rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          {payError && (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"
            >
              {payError}
            </p>
          )}

          {!confirming ? (
            <>
              <p className="mb-4 text-center font-semibold text-slate-900">
                Support {artist.artistName}
              </p>
              <button
                onClick={() => {
                  setPayError(null);
                  setConfirming(true);
                }}
                disabled={!canBuy}
                className="w-full rounded-xl bg-[#45152f] px-6 py-3.5 text-base font-semibold text-white shadow-md shadow-[#45152f]/25 transition hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
              >
                {!canVote
                  ? copy.button
                  : belowMin
                    ? `Select at least ${MIN_VOTES} votes to continue`
                    : `Buy ${quantity} ${quantity === 1 ? 'vote' : 'votes'} for ${rand(total)}`}
              </button>
            </>
          ) : (
            <div role="group" aria-label="Confirm your vote purchase">
              <p className="text-center text-slate-800">
                You’re buying <strong>{quantity}</strong> {quantity === 1 ? 'vote' : 'votes'} for{' '}
                <strong>{artist.artistName}</strong>
                {artist.competitionName ? ` in ${artist.competitionName}` : ''} for{' '}
                <strong>{rand(total)}</strong>. You’ll pay on PayFast next.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => setConfirming(false)}
                  disabled={paying}
                  className="flex-1 rounded-xl bg-slate-200 px-4 py-3 font-semibold text-slate-800 hover:bg-slate-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
                >
                  Cancel
                </button>
                <button
                  onClick={startPayment}
                  disabled={paying}
                  className="flex-1 rounded-xl bg-[#45152f] px-4 py-3 font-semibold text-white hover:bg-[#5b1d3e] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]"
                >
                  {paying ? 'Opening PayFast…' : 'Pay with PayFast'}
                </button>
              </div>
            </div>
          )}
        </section>

        <button
          onClick={() => navigate(-1)}
          className="mt-8 rounded-lg bg-slate-300 px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-400/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
        >
          Back to artists
        </button>
      </div>

      {/* Full-screen image */}
      {zoomed && artist.imageUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${artist.artistName} image`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setZoomed(false)}
        >
          <img
            src={artist.imageUrl}
            alt={artist.artistName}
            className="max-h-full max-w-full object-contain"
          />
          <button
            onClick={() => setZoomed(false)}
            aria-label="Close image"
            autoFocus
            className="absolute right-5 top-5 h-10 w-10 rounded-full bg-white/25 text-xl font-bold text-white hover:bg-white/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            ✕
          </button>
        </div>
      )}
    </main>
  );
}