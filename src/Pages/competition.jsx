// src/Pages/competition.jsx  (React + Vite + Tailwind CSS)
//
// Needs: react, react-router-dom, firebase (v9+ modular), Tailwind CSS.
// Images go straight to Firebase Storage; competition forms are submitted to your API.
// Anyone with an account can host a competition and anyone can enter one (no artist or host profile needed).
// The only rule: you can't enter a competition you host yourself.
// Tickets are written straight to the Firestore `tickets` collection (same shape as the ticket page).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, where } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytesResumable } from 'firebase/storage';
import { auth, db } from '../firebase-config'; // adjust to wherever your config lives

/* -------------------------------------------------------------------------- */
/*  Config – change these to match your app                                   */
/* -------------------------------------------------------------------------- */

// Base URL of your API (set VITE_API_URL in .env)
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// One endpoint per form.
const SUBMIT_ENDPOINTS = {
  judge: `${API_BASE_URL}/api/hoster-registration`, // judge competition
  hosted: `${API_BASE_URL}/api/hosted-registration`, // hosted competition
  artist: `${API_BASE_URL}/api/artist-registration`, // artist entering a competition
};

// Routes in your react-router setup.
const ROUTES = {
  // Voting page for one artist. Matches the return URL the API builds in start_vote_payment.
  vote: (competitionId, artistId, source) => `/competitions/${competitionId}/artists/${artistId}/vote?source=${source}`,
};

const HOSTER_FEE = 10; // R – fixed hoster registration fee
const TICKET_LISTING_FEE = 20; // R – always charged when tickets are listed, with or without a competition

const MAX_IMAGE_SIDE = 2000; // px – larger pictures are scaled down before upload

// Field names we look for when reading a competition's data. Each competition is
// checked at the top level and inside `judgeFormDetails`. Add your own names here
// if your documents use something different.
const REG_CLOSE_KEYS = [
  'artistClosingDateTime', // the field the artist form reads
  'artistRegClosingDate',
  'registrationClosingDate',
  'registrationCloseDate',
  'registrationDeadline',
  'closingDate',
];
const VOTING_CLOSE_KEYS = ['votingClosingDateTime', 'votingClosingDate'];
const TOP_CLOSE_KEYS = ['top10ClosingDateTime', 'top10closingDateTime', 'top10ClosingDate'];
const LOCATION_KEYS = ['location', 'venue'];

/* -------------------------------------------------------------------------- */
/*  Data helpers                                                              */
/* -------------------------------------------------------------------------- */

const toDate = (v) => {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
  if (v instanceof Date) return v;
  const d = new Date(v); // ISO string or millis
  return Number.isNaN(d.getTime()) ? null : d;
};

const pickDate = (data, keys) => {
  for (const k of keys) {
    const d = toDate(data[k]) || toDate(data.judgeFormDetails?.[k]);
    if (d) return d;
  }
  return null;
};

const pickValue = (data, key) => data[key] ?? data.judgeFormDetails?.[key] ?? null;

const pickText = (data, keys) => {
  for (const k of keys) {
    const v = pickValue(data, k);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

const isClosed = (date) => !!date && date.getTime() < Date.now();

const formatDateTime = (date) =>
  date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const formatDate = (date) => (date ? date.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

const SOURCES = {
  hosters: { collection: 'posts', type: 'Hosted competition', param: 'posts' },
  'judge-form': { collection: 'judge-form', type: 'Judge competition', param: 'judge-form' },
};

const normalizePost = (d) => {
  const data = d.data();
  if (!data.companyName) return null;
  return {
    key: `hosters:${d.id}`,
    id: d.id,
    source: 'hosters',
    title: data.companyName,
    ownerUid: data.hosterUid || data.ownerUid || data.registeredByUid || null, // the host
    location: pickText(data, LOCATION_KEYS),
    image: data.posterImage || data.companyLogoUrl || data.images?.[0] || data.judgeFormDetails?.images?.[0] || null,
    closesAt: pickDate(data, REG_CLOSE_KEYS),
    votingClosesAt: pickDate(data, VOTING_CLOSE_KEYS),
    topClosesAt: pickDate(data, TOP_CLOSE_KEYS),
    artistPrice: pickValue(data, 'artistPrice'),
    topCount: pickValue(data, 'topCount'),
    description: data.description || '',
    createdAt: toDate(data.registeredAt) || toDate(data.submissionTimestamp),
  };
};

const normalizeJudge = (d) => {
  const data = d.data();
  return {
    key: `judge-form:${d.id}`,
    id: d.id,
    source: 'judge-form',
    title: data.artistName || data.companyName || 'Unnamed competition',
    ownerUid:
      data.hosterUid || data.ownerUid || data.registeredByUid || data.judgeFormDetails?.registeredByUid || null, // the host
    location: pickText(data, LOCATION_KEYS),
    image: data.images?.[0] || data.judgeFormDetails?.images?.[0] || null,
    closesAt: pickDate(data, REG_CLOSE_KEYS),
    votingClosesAt: pickDate(data, VOTING_CLOSE_KEYS),
    topClosesAt: pickDate(data, TOP_CLOSE_KEYS),
    artistPrice: pickValue(data, 'artistPrice'),
    topCount: pickValue(data, 'topCount'),
    description: '',
    createdAt: toDate(data.submissionTimestamp),
  };
};

const fetchArtistCount = async (collectionName, id) => {
  try {
    const snap = await getDocs(collection(db, collectionName, id, 'registeredArtists'));
    return snap.size;
  } catch (error) {
    console.error(`Competitions: error fetching artist count for ${collectionName}/${id}:`, error);
    return -1;
  }
};

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/* -------------------------------------------------------------------------- */
/*  Shared UI (exported – other pages may import these)                       */
/* -------------------------------------------------------------------------- */

export const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]';

// Focus ring (same maroon outline as the Artists page)
const FOCUS_LIGHT = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45152f]';

export function Spinner({ className = 'h-8 w-8' }) {
  return (
    <div
      className={`animate-spin rounded-full border-2 border-[#45152f]/20 border-t-[#45152f] ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  const tone =
    toast.type === 'error'
      ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
      : 'bg-[#45152f] text-white';

  return (
    <div role="alert" className={`fixed right-4 top-4 z-[70] w-[calc(100%-2rem)] max-w-sm rounded-xl p-4 shadow-lg transition-all duration-300 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold">{toast.title}</p>
          {toast.message && <p className="mt-1 text-xs leading-relaxed opacity-90">{toast.message}</p>}
        </div>
        <button onClick={onClose} className={`rounded-lg px-2.5 py-1 text-xs font-semibold bg-black/10 hover:bg-black/20 transition-colors ${FOCUS}`}>
          Close
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Competition list + event page (shown on the white page)                   */
/* -------------------------------------------------------------------------- */

function Thumb({ image, title, className = '' }) {
  const initial = (title || '?').trim().charAt(0).toUpperCase();
  return (
    <div className={`overflow-hidden bg-slate-200 ${className}`}>
      {image ? (
        <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-[#45152f]">{initial}</div>
      )}
    </div>
  );
}

const TYPE_CHIP = {
  hosters: 'border-rose-200 bg-rose-50 text-[#45152f]',
  'judge-form': 'border-slate-300 bg-slate-100 text-slate-700',
};

function TypeChip({ source, className = '' }) {
  return (
    <span
      className={`inline-block rounded-full border px-3 py-1 text-xs font-semibold ${TYPE_CHIP[source]} ${className}`}
    >
      {SOURCES[source].type}
    </span>
  );
}

function CompetitionRow({ item, onClick }) {
  const closed = isClosed(item.closesAt);
  return (
    <button
      onClick={onClick}
      className={`grid w-full grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-slate-200 transition-colors hover:bg-slate-50 sm:grid-cols-[96px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-6 sm:p-4 ${FOCUS_LIGHT}`}
    >
      {/* Left: image */}
      <Thumb image={item.image} title={item.title} className="aspect-square w-full rounded-xl" />

      {/* Name with the location underneath */}
      <div className="min-w-0">
        <p className="line-clamp-2 text-base font-semibold text-slate-900">{item.title}</p>
        <p className="mt-0.5 truncate text-sm text-slate-500">{item.location || 'Location not provided'}</p>
        <TypeChip source={item.source} className="mt-2 sm:hidden" />
      </div>

      {/* Middle: type of competition */}
      <div className="hidden text-center sm:block">
        <TypeChip source={item.source} />
      </div>

      {/* Right: registration closing date */}
      <div className="max-w-[9rem] text-right sm:max-w-none">
        {closed ? (
          <p className="text-sm font-semibold text-rose-700">Registration closed</p>
        ) : item.closesAt ? (
          <>
            <p className="text-xs text-slate-500">Registration closes</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900">{formatDate(item.closesAt)}</p>
          </>
        ) : (
          <p className="text-sm text-slate-400">No closing date</p>
        )}
      </div>
    </button>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-3 last:border-b-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

function EventPage({ item, onBack, onViewArtists, onRegister }) {
  const [artistCount, setArtistCount] = useState(null);
  const closed = isClosed(item.closesAt);
  // The host of a competition can't enter it as an artist
  const isHost = !!item.ownerUid && auth.currentUser?.uid === item.ownerUid;

  useEffect(() => {
    let cancelled = false;
    setArtistCount(null);
    fetchArtistCount(SOURCES[item.source].collection, item.id).then((n) => {
      if (!cancelled) setArtistCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [item.source, item.id]);

  return (
    <div>
      <button
        onClick={onBack}
        className={`rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 ${FOCUS_LIGHT}`}
      >
        ← All competitions
      </button>

      <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,320px)_1fr]">
        <Thumb image={item.image} title={item.title} className="aspect-[3/4] w-full rounded-2xl border border-slate-200" />

        <div>
          <TypeChip source={item.source} />
          <h2 className="mt-2 text-3xl font-extrabold text-slate-900">{item.title}</h2>
          {item.location && <p className="mt-1 text-base text-slate-500">{item.location}</p>}

          <p
            className={`mt-3 inline-block rounded-full px-3 py-1 text-sm font-semibold ${
              closed ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {closed ? 'Registration closed' : item.closesAt ? 'Registration open' : 'No closing date set'}
          </p>

          {item.description && <p className="mt-4 text-sm leading-relaxed text-slate-600">{item.description}</p>}

          <dl className="mt-6 rounded-2xl bg-white px-5 shadow-sm ring-1 ring-slate-200">
            {item.location && <DetailRow label="Location" value={item.location} />}
            <DetailRow label="Registration closes" value={formatDateTime(item.closesAt)} />
            {item.votingClosesAt && <DetailRow label="Voting closes" value={formatDateTime(item.votingClosesAt)} />}
            {item.topClosesAt && <DetailRow label="Top artists announced" value={formatDateTime(item.topClosesAt)} />}
            {item.topCount != null && <DetailRow label="Number of top artists" value={item.topCount} />}
            {item.artistPrice != null && <DetailRow label="Artist charge" value={`R ${item.artistPrice}`} />}
            <DetailRow
              label="Registered artists"
              value={artistCount === null ? '…' : artistCount >= 0 ? artistCount : 'Unavailable'}
            />
          </dl>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={onRegister}
              disabled={closed || isHost}
              className={`rounded-full px-6 py-3 text-sm font-bold transition-colors disabled:cursor-not-allowed ${
                closed || isHost ? 'bg-slate-200 text-slate-500' : 'bg-[#45152f] text-white hover:bg-[#5b1d3e] disabled:opacity-60'
              } ${FOCUS_LIGHT}`}
            >
              {closed ? 'Registration is closed' : isHost ? 'You host this competition' : 'Register'}
            </button>
            <button
              onClick={onViewArtists}
              className={`rounded-full border border-[#45152f] bg-white px-6 py-3 text-sm font-bold text-[#45152f] transition-colors hover:bg-slate-100 ${FOCUS_LIGHT}`}
            >
              View registered artists
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Form building blocks (dark modal)                                         */
/* -------------------------------------------------------------------------- */

const CARD = 'mb-6 w-full rounded-2xl bg-slate-50 p-6 ring-1 ring-slate-200';
const SECTION_TITLE = 'mb-5 text-lg font-semibold text-slate-900';
const LABEL = 'mb-2 block text-sm font-medium text-slate-600';
const INPUT = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#45152f] focus:outline-none focus:ring-2 focus:ring-[#45152f]/20';

const emptyDateTime = { date: '', time: '' };

const toDateTime = ({ date, time }) => {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const digitsOnly = (setter) => (e) => setter(e.target.value.replace(/\D/g, ''));

const toJpegBlob = async (file) => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob || blob.size === 0) throw new Error('Blob is empty after conversion');
  return blob;
};

function TextField({ id, label, className = 'mb-5', ...props }) {
  return (
    <div className={className}>
      <label className={LABEL} htmlFor={id}>{label}</label>
      <input id={id} className={INPUT} {...props} />
    </div>
  );
}

function DateTimeRow({ prefix, value, onChange }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-4">
      <div>
        <label className={LABEL}>{prefix} Date</label>
        <input
          type="date"
          className={INPUT}
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
      </div>
      <div>
        <label className={LABEL}>{prefix} Time</label>
        <input
          type="time"
          className={INPUT}
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
        />
      </div>
    </div>
  );
}

function FeeRow({ artistPrice, setArtistPrice }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <span className={LABEL}>Hoster Registration Fee</span>
        <div className="flex items-center rounded-xl border border-slate-300 bg-white px-4 py-3">
          <span className="mr-1.5 font-bold text-slate-700">R</span>
          {/* Fixed value, used as the hosterRegistrationFee */}
          <span className="font-semibold text-slate-900">10</span>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="artistPrice">Artist Charge (your charge)</label>
        <div className="flex items-center rounded-xl border border-slate-300 bg-white px-4 focus-within:border-[#45152f] focus-within:ring-2 focus-within:ring-[#45152f]/20">
          <span className="mr-1.5 font-bold text-slate-700">R</span>
          <input
            id="artistPrice"
            className="w-full bg-transparent py-3 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none"
            placeholder="0.00"
            value={artistPrice}
            inputMode="decimal"
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^0-9.]/g, '');
              if (numericValue.split('.').length > 2) return;
              setArtistPrice(numericValue);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ---- Poster upload (shared by both competition forms and the ticket form) -- */

function usePosterUpload({ folder, notify }) {
  const fileInputRef = useRef(null);
  const [images, setImages] = useState([]); // { tempId, localUrl, uploading, progress, downloadURL, storagePath }
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Free blob: URLs when the form closes
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(
    () => () => imagesRef.current.forEach((img) => img.localUrl && URL.revokeObjectURL(img.localUrl)),
    []
  );

  const updateImage = useCallback((tempId, updates) => {
    setImages((prev) => prev.map((img) => (img.tempId === tempId ? { ...img, ...updates } : img)));
  }, []);

  const handleFile = async (file) => {
    if (!file) return;

    if (images.length >= 1) {
      notify({ type: 'error', title: 'Limit Reached', message: 'You can upload a maximum of 1 image.' });
      return;
    }
    if (!file.type.startsWith('image/')) {
      notify({ type: 'error', title: 'Wrong file type', message: 'Please choose an image file.' });
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      notify({ type: 'error', title: 'Upload Failed', message: 'User not authenticated for image upload.' });
      return;
    }

    setIsProcessing(true);
    const tempId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let localUrl = null;

    try {
      const blob = await toJpegBlob(file);
      localUrl = URL.createObjectURL(blob);
      setImages([{ tempId, localUrl, uploading: true, progress: 0 }]);

      const storagePath = `${folder}/${uid}/${tempId}.jpg`;
      const task = uploadBytesResumable(ref(getStorage(), storagePath), blob, {
        contentType: 'image/jpeg',
      });

      await new Promise((resolve, reject) => {
        task.on(
          'state_changed',
          (snap) => updateImage(tempId, { progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) }),
          reject,
          resolve
        );
      });

      const downloadURL = await getDownloadURL(task.snapshot.ref);
      updateImage(tempId, { uploading: false, progress: 100, downloadURL, storagePath });
      notify({ type: 'success', title: 'Success', message: 'Image uploaded successfully!' });
    } catch (error) {
      console.error('UPLOAD ERROR (Firebase Storage):', error);
      notify({
        type: 'error',
        title: 'Upload Failed',
        message: error?.message || 'Something went wrong while uploading the image.',
      });
      if (localUrl) URL.revokeObjectURL(localUrl);
      setImages((prev) => prev.filter((img) => img.tempId !== tempId));
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = (tempId) => {
    if (!window.confirm('Are you sure you want to remove this image?')) return;
    const img = images.find((i) => i.tempId === tempId);
    if (img?.localUrl) URL.revokeObjectURL(img.localUrl);
    setImages((prev) => prev.filter((i) => i.tempId !== tempId));
  };

  return {
    fileInputRef,
    images,
    isProcessing,
    isDragging,
    setIsDragging,
    handleFile,
    handleRemove,
    ready: images.every((img) => img.downloadURL && !img.uploading),
    imageUrl: images[0]?.downloadURL || null,
  };
}

function PosterUploader({ poster, notify, title = 'Event Poster Image', addLabel = '+ Add Poster Image' }) {
  const { fileInputRef, images, isProcessing, isDragging, setIsDragging, handleFile, handleRemove } = poster;
  return (
    <section className={CARD}>
      <h3 className={SECTION_TITLE}>{title}</h3>
      <p className="mb-4 text-sm text-slate-600">You can upload 1 image.</p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {images.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          className={`flex h-52 w-full flex-col items-center justify-center rounded-2xl border border-dashed text-base font-semibold text-slate-700 transition-colors ${
            isDragging ? 'border-[#45152f] bg-slate-100' : 'border-slate-300 bg-white hover:bg-slate-100'
          } ${FOCUS}`}
        >
          {isProcessing ? (
            <Spinner className="h-6 w-6" />
          ) : (
            <>
              <span>{addLabel}</span>
              <span className="mt-1 text-sm font-normal text-slate-500">Click to choose or drop a file here</span>
            </>
          )}
        </button>
      ) : (
        images.map((img) => (
          <div key={img.tempId} className="relative h-64 w-full overflow-hidden rounded-2xl bg-white">
            <img
              src={img.downloadURL || img.localUrl}
              alt="Poster preview"
              className="h-full w-full object-cover"
              onError={() =>
                notify({ type: 'error', title: 'Image Display Error!', message: 'Could not load the image preview.' })
              }
            />
            {img.uploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80">
                <Spinner />
                <p className="mt-2 text-xs text-[#45152f]">Uploading image… {img.progress ?? 0}%</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => handleRemove(img.tempId)}
              disabled={img.uploading}
              className={`absolute bottom-4 left-4 rounded-lg bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50 ${FOCUS}`}
            >
              X Remove
            </button>
          </div>
        ))
      )}
    </section>
  );
}

/* ---- Tickets (General / VIP / VVIP) --------------------------------------- */
// Tickets are switched off for now: both ticket buttons show "will be available soon".
// The forms and the functions below are kept, so they can be switched back on later.

const TICKET_TYPES = ['general', 'vip', 'vvip'];

const emptyTickets = () => ({
  general: { enabled: false, quantity: '', price: '' },
  vip: { enabled: false, quantity: '', price: '' },
  vvip: { enabled: false, quantity: '', price: '' },
});

// Validates the ticket inputs and returns { variants, eventDate } or { error }.
const prepareTickets = (tickets, eventDay) => {
  const eventDate = toDateTime(eventDay);
  if (!eventDate) return { error: 'Please set the event day date and time for the tickets.' };

  const variants = {};
  for (const type of TICKET_TYPES) {
    const t = tickets[type];
    if (!t.enabled) continue;
    const price = parseFloat(t.price);
    const qty = parseInt(t.quantity, 10);
    if (Number.isNaN(price) || price < 0 || Number.isNaN(qty) || qty < 1) {
      return { error: `Enter a valid price and quantity for the ${type.toUpperCase()} ticket.` };
    }
    variants[type] = { name: type.toUpperCase(), price, totalQuantity: qty };
  }
  if (Object.keys(variants).length === 0) {
    return { error: 'Tick at least one ticket type (General, VIP or VVIP).' };
  }
  return { variants, eventDate };
};

// Same document shape as the ticket page: one doc per event with nested variants.
const publishTickets = ({ user, eventName, eventDate, location, imageUrl, variants, competitionId = null }) =>
  addDoc(collection(db, 'tickets'), {
    eventName,
    eventDate: eventDate.toISOString(),
    location,
    imageUrl,
    variants,
    sellerUid: user.uid,
    competitionId,
    createdAt: serverTimestamp(),
  });

// Sent to the API together with a competition, so the server can charge the listing fee and publish the tickets.
const buildTicketListing = ({ variants, eventDate }, location, imageUrl) => ({
  fee: TICKET_LISTING_FEE,
  eventDate: eventDate.toISOString(),
  location,
  imageUrl,
  variants,
});

function TicketTypeFields({ idPrefix, tickets, setTickets }) {
  const update = (type, field, value) =>
    setTickets((prev) => ({ ...prev, [type]: { ...prev[type], [field]: value } }));

  return (
    <div className="space-y-4">
      {TICKET_TYPES.map((type) => {
        const t = tickets[type];
        return (
          <div
            key={type}
            className={`rounded-xl border p-4 ${t.enabled ? 'border-[#45152f] bg-white' : 'border-slate-200'}`}
          >
            <label className="flex cursor-pointer select-none items-center gap-3 text-sm font-semibold uppercase text-slate-800">
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={() => update(type, 'enabled', !t.enabled)}
                className="h-4 w-4 rounded border-slate-300 accent-[#45152f]"
              />
              {type} ticket
            </label>
            {t.enabled && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <label className={LABEL} htmlFor={`${idPrefix}-${type}-price`}>Price (R)</label>
                  <input
                    id={`${idPrefix}-${type}-price`}
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    className={INPUT}
                    value={t.price}
                    onChange={(e) => update(type, 'price', e.target.value)}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor={`${idPrefix}-${type}-qty`}>Quantity</label>
                  <input
                    id={`${idPrefix}-${type}-qty`}
                    type="number"
                    min="1"
                    placeholder="Qty"
                    className={INPUT}
                    value={t.quantity}
                    onChange={(e) => update(type, 'quantity', e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Shown inside the competition forms. Stays collapsed until "Add tickets" is clicked.
function TicketsSection({ open, onToggle, tickets, setTickets, eventDay, setEventDay }) {
  if (!open) {
    return (
      <div className="mb-6">
        <button
          type="button"
          onClick={() => alert('will be available soon')}
          // to switch tickets back on, use:  onClick={onToggle}
          className={`w-full rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-4 text-base font-semibold text-slate-700 transition-colors hover:bg-slate-100 ${FOCUS}`}
        >
          + Add tickets for the event day
        </button>
        <p className="mt-2 text-center text-xs text-slate-500">Optional. Sell tickets to people attending on the day. A R{TICKET_LISTING_FEE} listing fee applies.</p>
      </div>
    );
  }

  return (
    <section className={CARD}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-slate-900">Event Day Tickets</h3>
        <button
          type="button"
          onClick={onToggle}
          className={`rounded-lg px-2 py-1 text-sm font-semibold text-rose-700 hover:text-rose-800 ${FOCUS}`}
        >
          Remove tickets
        </button>
      </div>
      <p className="mb-5 text-sm text-slate-600">
        Tickets use this competition’s name, location and poster.
      </p>
      <DateTimeRow prefix="Event Day" value={eventDay} onChange={setEventDay} />
      <TicketTypeFields idPrefix="comp" tickets={tickets} setTickets={setTickets} />
      <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3">
        <span className="text-sm text-slate-700">Ticket listing fee (paid with this competition)</span>
        <span className="font-semibold text-slate-900">R {TICKET_LISTING_FEE.toFixed(2)}</span>
      </div>
    </section>
  );
}

/* ---- Submit helpers --------------------------------------------------------- */

// POSTs to the API. Returns the response data on success, or null after notifying the user.
async function postRegistration({ endpoint, payload, user, notify }) {
  try {
    const token = await user.getIdToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON response */
    }
    const serverMessage = data?.message || data?.detail || '';

    if (response.ok && data?.success !== false) return data || {};

    switch (response.status) {
      case 401:
        notify({ type: 'error', title: 'Authentication Required', message: 'You must be logged in to do this.' });
        break;
      case 403:
        notify({
          type: 'error',
          title: 'Not allowed',
          message: (typeof serverMessage === 'string' && serverMessage) || 'You do not have permission to perform this action.',
        });
        break;
      case 400:
      case 422:
        notify({
          type: 'error',
          title: 'Invalid Data',
          message: `There was an issue with the data provided: ${
            typeof serverMessage === 'string' ? serverMessage : JSON.stringify(serverMessage)
          }`,
        });
        break;
      case 503:
        notify({ type: 'error', title: 'Service Unavailable', message: 'The server is currently unavailable. Please try again later.' });
        break;
      default:
        notify({
          type: 'error',
          title: response.status >= 500 ? 'Server Error' : 'Submission Failed',
          message: `Server responded: ${
            (typeof serverMessage === 'string' && serverMessage) || response.statusText || 'An unknown error occurred on the server.'
          }. Please try again.`,
        });
    }
    return null;
  } catch (error) {
    console.error('Error during competition submission:', error);
    notify({
      type: 'error',
      title: 'Submission Failed',
      message: `Could not reach the server: ${error.message}. Please try again.`,
    });
    return null;
  }
}

// After the API accepts a competition, tell the user how it went (or send them to pay).
function finishSubmission({ data, name, withTickets, notify, onClose }) {
  if (data?.paymentUrl) {
    window.location.assign(data.paymentUrl);
    return;
  }
  const id = data?.hosterRegistrationId ?? 'n/a';
  notify({
    type: 'success',
    title: 'Submission Successful',
    message: `Your competition ${name} has been submitted (ID: ${id}). It is now live.${
      withTickets ? ' Your tickets were sent with it.' : ''
    }`,
  });
  onClose();
}

/* -------------------------------------------------------------------------- */
/*  Judge competition form                                                    */
/* -------------------------------------------------------------------------- */

function JudgeEventForm({ onClose, notify }) {
  const [companyName, setCompanyName] = useState('');
  const [location, setLocation] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [artistPrice, setArtistPrice] = useState('');
  const [topCount, setTopCount] = useState('');

  const [artistReg, setArtistReg] = useState(emptyDateTime);
  const [voting, setVoting] = useState(emptyDateTime);
  const [top10, setTop10] = useState(emptyDateTime);

  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [tickets, setTickets] = useState(emptyTickets);
  const [eventDay, setEventDay] = useState(emptyDateTime);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const poster = usePosterUpload({ folder: 'judge', notify });

  const handleSubmit = async () => {
    const user = auth.currentUser;
    if (!user) {
      notify({ type: 'error', title: 'Error', message: 'User not logged in. Please log in to submit a judge form.' });
      return;
    }

    const votingDate = toDateTime(voting);
    const artistRegDate = toDateTime(artistReg);
    const top10Date = toDateTime(top10);

    if (
      !companyName.trim() || !location.trim() || !accountNo || !artistPrice ||
      !votingDate || !artistRegDate || !top10Date || !topCount
    ) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please fill in all required fields.' });
      return;
    }
    if (poster.images.length === 0) {
      notify({ type: 'error', title: 'Missing Image', message: 'Please add at least one image of the poster.' });
      return;
    }
    if (!poster.ready) {
      notify({ type: 'error', title: 'Image Upload Incomplete', message: 'Please wait for all images to finish uploading before submitting.' });
      return;
    }

    const parsedArtistPrice = parseFloat(artistPrice);
    if (Number.isNaN(parsedArtistPrice) || parsedArtistPrice <= 0) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please enter a valid artist charge (must be a positive number).' });
      return;
    }
    const parsedTopCount = parseInt(topCount, 10);
    if (Number.isNaN(parsedTopCount) || parsedTopCount <= 0) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please enter a valid number of top artists (must be a positive number).' });
      return;
    }

    // Check the tickets before anything is sent, so we never save half of a submission.
    let prepared = null;
    if (ticketsOpen) {
      prepared = prepareTickets(tickets, eventDay);
      if (prepared.error) {
        notify({ type: 'error', title: 'Tickets', message: prepared.error });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const hosterData = {
        companyName: companyName.trim(),
        hosterUid: user.uid,
        registrationFee: HOSTER_FEE,
        email: user.email || 'unknown@example.com',
        description: `Judge Event Form Submission: ${companyName.trim()}`,
        judgeFormDetails: {
          location: location.trim(),
          accountNo,
          artistPrice: parsedArtistPrice,
          images: [poster.imageUrl],
          votingClosingDate: votingDate.toISOString(),
          artistRegClosingDate: artistRegDate.toISOString(),
          top10ClosingDate: top10Date.toISOString(),
          topCount: parsedTopCount,
          registeredByUid: user.uid,
          // submissionTimestamp is set by the server (a Firestore server timestamp can't be sent as JSON)
        },
      };

      if (prepared) hosterData.ticketListing = buildTicketListing(prepared, location.trim(), poster.imageUrl);

      const data = await postRegistration({ endpoint: SUBMIT_ENDPOINTS.judge, payload: { hosterData }, user, notify });
      if (!data) return;

      finishSubmission({ data, name: companyName.trim(), withTickets: !!prepared, notify, onClose });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-2">
      <h2 className="mb-2 text-center text-3xl font-extrabold text-slate-900">Judge Competition</h2>
      <p className="mb-8 text-center text-base text-slate-600">
        Enter event details and manage poster images.
      </p>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Event Details</h3>

        <TextField
          id="judge-name"
          label="Company/Event Name"
          placeholder="e.g., Summer Fest 2024"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="judge-location"
          label="Location"
          placeholder="e.g., Sandton Convention Centre, Johannesburg"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="judge-account"
          label="Account Number"
          placeholder="Enter Account Number"
          value={accountNo}
          onChange={digitsOnly(setAccountNo)}
          inputMode="numeric"
        />

        <FeeRow artistPrice={artistPrice} setArtistPrice={setArtistPrice} />
      </section>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Key Dates &amp; Times</h3>

        <DateTimeRow prefix="Artist Reg." value={artistReg} onChange={setArtistReg} />
        <DateTimeRow prefix="Voting Closes" value={voting} onChange={setVoting} />
        <DateTimeRow prefix="Top N Closes" value={top10} onChange={setTop10} />

        <TextField
          id="judge-topCount"
          label="Number of Top Artists (e.g., 10 or 20)"
          className=""
          placeholder="Enter number (e.g., 10)"
          value={topCount}
          onChange={digitsOnly(setTopCount)}
          inputMode="numeric"
          maxLength={2}
        />
      </section>

      <PosterUploader poster={poster} notify={notify} />

      <TicketsSection
        open={ticketsOpen}
        onToggle={() => setTicketsOpen((v) => !v)}
        tickets={tickets}
        setTickets={setTickets}
        eventDay={eventDay}
        setEventDay={setEventDay}
      />

      {ticketsOpen && (
        <p className="mb-4 text-center text-sm text-slate-700">
          Total to pay: R {(HOSTER_FEE + TICKET_LISTING_FEE).toFixed(2)} (R{HOSTER_FEE} registration + R{TICKET_LISTING_FEE} tickets)
        </p>
      )}

      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !poster.ready}
          className={`flex min-w-[250px] items-center justify-center rounded-full bg-[#45152f] px-8 py-4 text-lg font-extrabold text-white hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
        >
          {isSubmitting ? <Spinner className="h-5 w-5 border-white/30 border-t-white" /> : 'Register Judge Competition'}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hosted competition form                                                   */
/* -------------------------------------------------------------------------- */

function HostedEventForm({ onClose, notify }) {
  const [companyName, setCompanyName] = useState('');
  const [location, setLocation] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [artistPrice, setArtistPrice] = useState('');
  const [artistReg, setArtistReg] = useState(emptyDateTime);
  const [voting, setVoting] = useState(emptyDateTime);

  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [tickets, setTickets] = useState(emptyTickets);
  const [eventDay, setEventDay] = useState(emptyDateTime);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const poster = usePosterUpload({ folder: 'hosted', notify });

  const handleSubmit = async () => {
    const user = auth.currentUser;
    if (!user) {
      notify({ type: 'error', title: 'Error', message: 'User not logged in. Please log in to host a competition.' });
      return;
    }

    const artistRegDate = toDateTime(artistReg);
    const votingDate = toDateTime(voting);
    if (!companyName.trim() || !location.trim() || !accountNo || !artistPrice || !artistRegDate || !votingDate) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please fill in all required fields.' });
      return;
    }
    if (votingDate.getTime() <= Date.now()) {
      notify({ type: 'error', title: 'Check your dates', message: 'The voting closing date must be in the future.' });
      return;
    }
    if (votingDate.getTime() <= artistRegDate.getTime()) {
      notify({ type: 'error', title: 'Check your dates', message: 'Voting must close after registration closes.' });
      return;
    }
    if (poster.images.length === 0) {
      notify({ type: 'error', title: 'Missing Image', message: 'Please add an image of the poster.' });
      return;
    }
    if (!poster.ready) {
      notify({ type: 'error', title: 'Image Upload Incomplete', message: 'Please wait for the image to finish uploading before submitting.' });
      return;
    }

    const parsedArtistPrice = parseFloat(artistPrice);
    if (Number.isNaN(parsedArtistPrice) || parsedArtistPrice <= 0) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please enter a valid artist charge (must be a positive number).' });
      return;
    }

    let prepared = null;
    if (ticketsOpen) {
      prepared = prepareTickets(tickets, eventDay);
      if (prepared.error) {
        notify({ type: 'error', title: 'Tickets', message: prepared.error });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const hosterData = {
        companyName: companyName.trim(),
        hosterUid: user.uid,
        registrationFee: HOSTER_FEE,
        email: user.email || 'unknown@example.com',
        description: `Hosted Competition Submission: ${companyName.trim()}`,
        competitionType: 'hosted',
        location: location.trim(),
        accountNo,
        artistPrice: parsedArtistPrice,
        artistRegClosingDate: artistRegDate.toISOString(),
        artistClosingDateTime: artistRegDate.toISOString(), // the name the artist form reads
        votingClosingDate: votingDate.toISOString(),
        votingClosingDateTime: votingDate.toISOString(), // the name the voting page and artists list read
        posterImage: poster.imageUrl,
        images: [poster.imageUrl],
      };

      if (prepared) hosterData.ticketListing = buildTicketListing(prepared, location.trim(), poster.imageUrl);

      const data = await postRegistration({ endpoint: SUBMIT_ENDPOINTS.hosted, payload: { hosterData }, user, notify });
      if (!data) return;

      finishSubmission({ data, name: companyName.trim(), withTickets: !!prepared, notify, onClose });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-2">
      <h2 className="mb-2 text-center text-3xl font-extrabold text-slate-900">Hosted Competition</h2>
      <p className="mb-8 text-center text-base text-slate-600">
        Enter your competition details and add a poster.
      </p>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Competition Details</h3>

        <TextField
          id="hosted-name"
          label="Company/Event Name"
          placeholder="e.g., Summer Fest 2024"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="hosted-location"
          label="Location"
          placeholder="e.g., Sandton Convention Centre, Johannesburg"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="hosted-account"
          label="Account Number"
          placeholder="Enter Account Number"
          value={accountNo}
          onChange={digitsOnly(setAccountNo)}
          inputMode="numeric"
        />

        <FeeRow artistPrice={artistPrice} setArtistPrice={setArtistPrice} />
      </section>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Registration &amp; Voting</h3>
        <DateTimeRow prefix="Registration Closes" value={artistReg} onChange={setArtistReg} />
        <DateTimeRow prefix="Voting Closes" value={voting} onChange={setVoting} />
      </section>

      <PosterUploader poster={poster} notify={notify} />

      <TicketsSection
        open={ticketsOpen}
        onToggle={() => setTicketsOpen((v) => !v)}
        tickets={tickets}
        setTickets={setTickets}
        eventDay={eventDay}
        setEventDay={setEventDay}
      />

      {ticketsOpen && (
        <p className="mb-4 text-center text-sm text-slate-700">
          Total to pay: R {(HOSTER_FEE + TICKET_LISTING_FEE).toFixed(2)} (R{HOSTER_FEE} registration + R{TICKET_LISTING_FEE} tickets)
        </p>
      )}

      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !poster.ready}
          className={`flex min-w-[250px] items-center justify-center rounded-full bg-[#45152f] px-8 py-4 text-lg font-extrabold text-white hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
        >
          {isSubmitting ? <Spinner className="h-5 w-5 border-white/30 border-t-white" /> : 'Register Hosted Competition'}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stand-alone ticket form (the "+ Ticket" button)                           */
/* -------------------------------------------------------------------------- */

function TicketForm({ onClose, notify }) {
  const [eventName, setEventName] = useState('');
  const [location, setLocation] = useState('');
  const [eventDay, setEventDay] = useState(emptyDateTime);
  const [tickets, setTickets] = useState(emptyTickets);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const poster = usePosterUpload({ folder: 'ticket_images', notify });

  const handleSubmit = async () => {
    const user = auth.currentUser;
    if (!user) {
      notify({ type: 'error', title: 'Error', message: 'Please log in to sell tickets.' });
      return;
    }
    if (!eventName.trim() || !location.trim()) {
      notify({ type: 'error', title: 'Missing Information', message: 'Please enter the event name and location.' });
      return;
    }
    if (poster.images.length === 0) {
      notify({ type: 'error', title: 'Missing Image', message: 'Please add an event banner.' });
      return;
    }
    if (!poster.ready) {
      notify({ type: 'error', title: 'Image Upload Incomplete', message: 'Please wait for the image to finish uploading before submitting.' });
      return;
    }
    const prepared = prepareTickets(tickets, eventDay);
    if (prepared.error) {
      notify({ type: 'error', title: 'Tickets', message: prepared.error });
      return;
    }

    setIsSubmitting(true);
    try {
      await publishTickets({
        user,
        eventName: eventName.trim(),
        location: location.trim(),
        imageUrl: poster.imageUrl,
        ...prepared,
      });
      notify({ type: 'success', title: 'Tickets Published', message: `Tickets for ${eventName.trim()} are now listed.` });
      onClose();
    } catch (error) {
      console.error('Error publishing tickets:', error);
      notify({ type: 'error', title: 'Publishing Failed', message: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-2">
      <h2 className="mb-2 text-center text-3xl font-extrabold text-slate-900">Sell Tickets</h2>
      <p className="mb-8 text-center text-base text-slate-600">
        List General, VIP and VVIP tickets for your event.
      </p>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Event Details</h3>
        <TextField
          id="ticket-name"
          label="Event Name"
          placeholder="Enter event name"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="ticket-location"
          label="Location"
          placeholder="e.g., Sandton Convention Centre, Johannesburg"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          autoCapitalize="words"
        />
        <DateTimeRow prefix="Event Day" value={eventDay} onChange={setEventDay} />
      </section>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Ticket Types</h3>
        <TicketTypeFields idPrefix="solo" tickets={tickets} setTickets={setTickets} />
      </section>

      <PosterUploader poster={poster} notify={notify} title="Event Banner" addLabel="+ Add Event Banner" />

      <div className="mb-6 flex items-center justify-between rounded-2xl bg-slate-50 px-6 py-4 ring-1 ring-slate-200">
        <span className="text-sm font-medium text-slate-600">Publishing Fee</span>
        <span className="text-lg font-bold text-slate-900">R {TICKET_LISTING_FEE.toFixed(2)}</span>
      </div>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !poster.ready}
          className={`flex min-w-[250px] items-center justify-center rounded-full bg-[#45152f] px-8 py-4 text-lg font-extrabold text-white hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
        >
          {isSubmitting ? <Spinner className="h-5 w-5 border-white/30 border-t-white" /> : `Publish Tickets (R${TICKET_LISTING_FEE.toFixed(2)})`}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Modals                                                                    */
/* -------------------------------------------------------------------------- */

function Modal({ label, title, onClose, onBack, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 px-6 pb-2 pt-5">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className={`rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 ${FOCUS}`}
              >
                ← Back
              </button>
            )}
            <p className="text-lg font-semibold text-slate-900">{title}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`rounded-md px-2 text-xl leading-none text-slate-500 hover:bg-slate-100 ${FOCUS}`}
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const COMPETITION_CHOICES = [
  {
    kind: 'hosted',
    title: 'Hosted competition',
    text: 'You run the competition. Artists register with you before registration closes.',
  },
  {
    kind: 'judge',
    title: 'Judge competition',
    text: 'Artists register, voting opens, and the top artists are picked.',
  },
];

function CompetitionModal({ onClose, notify }) {
  const [kind, setKind] = useState(null); // null | 'hosted' | 'judge'

  return (
    <Modal
      label="New competition"
      title={kind ? 'New competition' : 'Choose a competition type'}
      onClose={onClose}
      onBack={kind ? () => setKind(null) : undefined}
    >
      {kind === 'hosted' && <HostedEventForm onClose={onClose} notify={notify} />}
      {kind === 'judge' && <JudgeEventForm onClose={onClose} notify={notify} />}
      {!kind && (
        <div className="mx-auto grid w-full max-w-2xl gap-4 px-5 pb-10 pt-4 sm:grid-cols-2">
          {COMPETITION_CHOICES.map((c) => (
            <button
              key={c.kind}
              onClick={() => setKind(c.kind)}
              className={`rounded-2xl bg-slate-50 p-6 text-left ring-1 ring-slate-200 transition hover:ring-[#45152f] ${FOCUS}`}
            >
              <p className="text-lg font-semibold text-slate-900">{c.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.text}</p>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function TicketModal({ onClose, notify }) {
  return (
    <Modal label="Sell tickets" title="New tickets" onClose={onClose}>
      <TicketForm onClose={onClose} notify={notify} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Registered artists popup (web version of the Artiststovotefor screen)     */
/* -------------------------------------------------------------------------- */

const STATUS_ORDER = { won: 0, approved: 1, next_level: 2, rejected: 3, eliminated: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

// - hosted ('posts'):  posts/{id}/registeredArtists
// - judge competition: accepted-artist where judgeFormId == id
// Same rules as the app: eliminated artists are hidden, artists stay hidden until the
// top-N closing time, winners and vote counts show 24 hours after voting closes.
function ArtistsModal({ item, onClose, onVote }) {
  const isJudge = item.source === 'judge-form';
  const parentCollection = SOURCES[item.source].collection;

  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revealMessage, setRevealMessage] = useState('');
  const [votingClosed, setVotingClosed] = useState(false);
  const [showVotes, setShowVotes] = useState(false);
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unsub = null;
    setLoading(true);
    setFailed(false);
    setRevealMessage('');
    setArtists([]);

    const start = async () => {
      try {
        const configSnap = await getDoc(doc(db, parentCollection, item.id));
        if (cancelled) return;
        if (!configSnap.exists()) {
          setRevealMessage('Competition not found. Artists cannot be displayed.');
          setLoading(false);
          return;
        }

        const config = configSnap.data();
        const topCount = parseInt(pickValue(config, 'topCount'), 10) || 10;
        const top10Close = pickDate(config, TOP_CLOSE_KEYS);
        const votingClose = pickDate(config, VOTING_CLOSE_KEYS);

        // Artists stay hidden until the top-N closing time has passed
        if (top10Close && Date.now() < top10Close.getTime()) {
          setRevealMessage(`Artists will be revealed on ${formatDateTime(top10Close)}.`);
          setLoading(false);
          return;
        }

        const source = isJudge
          ? query(collection(db, 'accepted-artist'), where('judgeFormId', '==', item.id))
          : collection(db, 'posts', item.id, 'registeredArtists');

        unsub = onSnapshot(
          source,
          async (snap) => {
            const rows = await Promise.all(
              snap.docs.map(async (d) => {
                const data = d.data();
                let artist;
                let postKey;
                if (isJudge) {
                  postKey = `judge-form_${data.judgeFormId}_${data.artistId}`;
                  artist = {
                    id: d.id,
                    uid: data.artistId,
                    artistName: data.artistName || 'Unnamed artist',
                    images: data.images || [],
                    date: toDate(data.acceptedAt),
                    status: data.isEliminated ? 'eliminated' : data.isNewlyAcceptedPendingReview ? 'next_level' : 'approved',
                    isTop10Finalist: data.isTop10Finalist,
                    top10Close: toDate(data.top10ClosingDateTime),
                  };
                } else {
                  postKey = `posts_${item.id}_${d.id}`;
                  artist = {
                    id: d.id,
                    uid: data.registeredByUid || d.id,
                    artistName: data.artistName || data.companyName || 'Unnamed artist',
                    images: data.images || [],
                    date: toDate(data.registeredAt),
                    status: data.status || 'approved',
                    isTop10Finalist: data.isTop10Finalist,
                    top10Close: toDate(data.top10ClosingDateTime),
                  };
                }

                // Votes (artist-post) and profile (artists) are read side by side
                const [postSnap, profileSnap] = await Promise.all([
                  getDoc(doc(db, 'artist-post', postKey)).catch(() => null),
                  artist.uid ? getDoc(doc(db, 'artists', artist.uid)).catch(() => null) : null,
                ]);
                artist.votes = postSnap?.exists() ? postSnap.data().totalVotesReceived || 0 : 0;
                artist.description = profileSnap?.exists() ? profileSnap.data().description || '' : '';
                artist.genres = profileSnap?.exists() ? profileSnap.data().genres || '' : '';
                return artist;
              })
            );
            if (cancelled) return;

            const now = Date.now();

            // Drop eliminated artists, and anyone who missed the top-N cut
            let list = rows.filter((a) => {
              if (a.status === 'eliminated') return false;
              if (a.top10Close && now >= a.top10Close.getTime() && a.isTop10Finalist !== true) return false;
              return true;
            });

            // Winners and vote counts go public 24h after voting closes
            const closed = !!votingClose && now > votingClose.getTime();
            const resultsPublic = !!votingClose && now > votingClose.getTime() + DAY_MS;
            if (resultsPublic && list.length) {
              const best = Math.max(...list.map((a) => a.votes));
              if (best > 0) list = list.map((a) => (a.votes === best ? { ...a, status: 'won' } : a));
            }

            // Keep the winners plus the top N by votes
            if (top10Close && now >= top10Close.getTime()) {
              const winners = list.filter((a) => a.status === 'won');
              const rest = list.filter((a) => a.status !== 'won').sort((a, b) => b.votes - a.votes);
              const slots = topCount - winners.length;
              list = [...winners, ...(slots > 0 ? rest.slice(0, slots) : [])];
            }

            list.sort(
              (a, b) =>
                (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99) ||
                a.artistName.localeCompare(b.artistName)
            );

            setVotingClosed(closed);
            setShowVotes(resultsPublic);
            setArtists(list);
            setLoading(false);
          },
          (error) => {
            console.error('Competitions: error loading artists:', error);
            if (!cancelled) {
              setFailed(true);
              setLoading(false);
            }
          }
        );
      } catch (error) {
        console.error('Competitions: error loading artists:', error);
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      }
    };

    start();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [item.id, parentCollection, isJudge, reloadKey]);

  const q = search.trim().toLowerCase();
  const visible = q
    ? artists.filter(
        (a) =>
          a.artistName.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.genres.toLowerCase().includes(q)
      )
    : artists;

  const refresh = () => setReloadKey((k) => k + 1);

  let body;
  if (loading) {
    body = (
      <div className="flex flex-col items-center py-12">
        <Spinner />
        <p className="mt-3 text-sm text-slate-600">Loading artists…</p>
      </div>
    );
  } else if (failed) {
    body = (
      <div className="rounded-2xl bg-rose-50 px-5 py-4 text-sm text-rose-800 ring-1 ring-rose-200">
        Couldn’t load the artists. Check your connection and try again.
        <button onClick={refresh} className={`ml-3 rounded-md border border-rose-200 bg-white px-3 py-1 font-semibold text-rose-800 ${FOCUS}`}>
          Retry
        </button>
      </div>
    );
  } else if (revealMessage && artists.length === 0) {
    body = (
      <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
        <p className="text-sm text-slate-700">{revealMessage}</p>
        <button onClick={refresh} className={`mt-4 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${FOCUS}`}>
          Refresh
        </button>
      </div>
    );
  } else if (artists.length === 0) {
    body = (
      <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
        <p className="text-sm text-slate-700">
          {isJudge ? 'No artists have been accepted for this competition yet.' : 'No artists are currently eligible for voting.'}
        </p>
        <p className="mt-1 text-xs text-slate-500">Check back later or register new artists!</p>
        <button onClick={refresh} className={`mt-4 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${FOCUS}`}>
          Refresh
        </button>
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
        <p className="text-sm text-slate-700">No artists match your search.</p>
        <button onClick={() => setSearch('')} className={`mt-4 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${FOCUS}`}>
          Clear search
        </button>
      </div>
    );
  } else {
    body = (
      <ul className="space-y-4">
        {visible.map((a) => {
          const won = a.status === 'won';
          const voteDisabled = won || votingClosed;
          return (
            <li
              key={a.id}
              className={`rounded-2xl p-4 ring-1 ${won ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-slate-200'}`}
            >
              <p className="text-lg font-semibold text-slate-900">
                {a.artistName}
                {won && <span className="ml-2 text-amber-700">(Winner!)</span>}
              </p>

              <div className="mt-3 flex gap-4">
                <div className="h-28 w-28 shrink-0 overflow-hidden rounded-2xl bg-slate-200">
                  {a.images[0] ? (
                    <img src={a.images[0]} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">No image</div>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1 text-sm text-slate-700">
                  {a.description && (
                    <p className="line-clamp-2">
                      <span className="font-semibold text-slate-900">Description: </span>
                      {a.description}
                    </p>
                  )}
                  {a.genres && (
                    <p>
                      <span className="font-semibold text-slate-900">Genres: </span>
                      {a.genres}
                    </p>
                  )}
                  {showVotes && (
                    <p>
                      <span className="font-semibold text-slate-900">Votes: </span>
                      {a.votes}
                    </p>
                  )}
                  <p className="text-slate-600">
                    {isJudge ? 'Accepted on:' : 'Registered:'} {a.date ? formatDate(a.date) : 'N/A'}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => onVote(a.uid)}
                  disabled={voteDisabled}
                  className={`rounded-full px-5 py-2 text-sm font-bold disabled:cursor-not-allowed ${
                    won
                      ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
                      : voteDisabled
                      ? 'bg-slate-100 text-slate-500'
                      : 'bg-[#45152f] text-white hover:bg-[#5b1d3e]'
                  } ${FOCUS}`}
                >
                  {won ? 'WINNER!' : votingClosed ? 'Voting Closed' : 'Vote Now'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Modal label="Registered artists" title={isJudge ? 'Accepted artists' : 'Registered artists'} onClose={onClose}>
      <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-2">
        <h2 className="text-2xl font-extrabold text-slate-900">{item.title}</h2>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search artists by name, description, or genres…"
          aria-label="Search artists"
          className={`${INPUT} mb-5 mt-4`}
        />
        {body}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Artist registration                                                       */
/* -------------------------------------------------------------------------- */

const ARTIST_DUPLICATE_STATUSES = ['payment_complete', 'pending_payment', 'payfast_pending'];

// Web version of the formArtist screen: same fields, same checks, then hands off to payment.
// Anyone logged in can use it (no artist profile needed), except the host of the competition.
function ArtistRegistrationForm({ item, onClose, notify }) {
  const [artistName, setArtistName] = useState('');
  const [idNo, setIdNo] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const poster = usePosterUpload({ folder: 'artist', notify });

  const parentCollection = SOURCES[item.source].collection;
  const fee = Number(item.artistPrice);
  const feeValid = Number.isFinite(fee) && fee > 0;

  const handleSubmit = async () => {
    const user = auth.currentUser;
    if (!user) {
      notify({ type: 'error', title: 'Authentication Required', message: 'You must be logged in to register as an artist.' });
      return;
    }
    if (item.ownerUid && item.ownerUid === user.uid) {
      notify({ type: 'error', title: 'Not allowed', message: "You host this competition, so you can't enter it as an artist." });
      return;
    }
    if (isClosed(item.closesAt)) {
      notify({ type: 'error', title: 'Registration Closed', message: 'Registration for this competition is closed.' });
      return;
    }
    if (!artistName.trim() || !idNo || !accountNo) {
      notify({ type: 'error', title: 'Missing Information', message: 'Fill in all required fields.' });
      return;
    }
    if (!feeValid) {
      notify({ type: 'error', title: 'Fee not set', message: 'This competition has no registration fee set yet.' });
      return;
    }
    if (poster.images.length === 0) {
      notify({ type: 'error', title: 'Missing Image', message: 'Upload an image of the artist.' });
      return;
    }
    if (!poster.ready) {
      notify({ type: 'error', title: 'Image Upload Incomplete', message: 'Please wait for the image to finish uploading.' });
      return;
    }

    setIsSubmitting(true);
    try {
      const duplicates = await getDocs(
        query(
          collection(db, parentCollection, item.id, 'artists'),
          where('idNo', '==', idNo),
          where('accountNo', '==', accountNo),
          where('status', 'in', ARTIST_DUPLICATE_STATUSES)
        )
      );
      if (!duplicates.empty) {
        const alreadyPaid = duplicates.docs[0].data().status === 'payment_complete';
        notify({
          type: 'error',
          title: alreadyPaid ? 'Already Registered' : 'Payment Pending',
          message: alreadyPaid ? 'This artist is already registered.' : 'Complete your previous payment first.',
        });
        return;
      }

      // The server fills in the timestamps (votingClosingDateTime, dateSentToHosters, …).
      const artistData = {
        artistName: artistName.trim(),
        idNo,
        accountNo,
        images: [poster.imageUrl],
        registrationFee: fee,
        registeredByUid: user.uid,
        status: 'pending_payment',
        associatedParentId: item.id,
        associatedParentCollection: parentCollection,
        eventId: item.source === 'hosters' ? item.id : null,
        judgeFormId: item.source === 'judge-form' ? item.id : null,
        companyName: item.title,
        totalVotesReceived: 0,
        eventArtistId: 1,
      };

      const data = await postRegistration({
        endpoint: SUBMIT_ENDPOINTS.artist,
        payload: { parentDocId: item.id, parentCollectionName: parentCollection, artistData, paymentGateway: 'PAYFAST' },
        user,
        notify,
      });
      if (!data) return;

      if (data.paymentUrl) {
        window.location.assign(data.paymentUrl);
      } else {
        notify({ type: 'error', title: 'Payment', message: data.message || 'No payment URL received.' });
      }
    } catch (error) {
      console.error('Error registering artist:', error);
      notify({ type: 'error', title: 'Registration Failed', message: error.message || 'Something went wrong.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-2">
      <h2 className="mb-2 text-center text-3xl font-extrabold text-slate-900">Register as an artist</h2>
      <p className="mb-8 text-center text-base text-slate-600">Entering {item.title}</p>

      <section className={CARD}>
        <h3 className={SECTION_TITLE}>Artist Details</h3>
        <TextField
          id="artist-name"
          label="Artist Name"
          placeholder="Enter artist name"
          value={artistName}
          onChange={(e) => setArtistName(e.target.value)}
          autoCapitalize="words"
        />
        <TextField
          id="artist-id"
          label="ID Number"
          placeholder="Enter ID Number"
          value={idNo}
          onChange={digitsOnly(setIdNo)}
          inputMode="numeric"
          maxLength={13}
        />
        <TextField
          id="artist-account"
          label="Account Number"
          placeholder="Enter Account Number"
          value={accountNo}
          onChange={digitsOnly(setAccountNo)}
          inputMode="numeric"
        />
        <div>
          <span className={LABEL}>Registration Fee</span>
          <div className="flex items-center rounded-xl border border-slate-300 bg-white px-4 py-3">
            <span className="mr-1.5 font-bold text-slate-700">R</span>
            <span className="font-semibold text-slate-900">{feeValid ? fee.toFixed(2) : '—'}</span>
          </div>
        </div>
      </section>

      <PosterUploader poster={poster} notify={notify} title="Artist Image" addLabel="+ Add Image" />

      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !poster.ready || !feeValid}
          className={`flex min-w-[250px] items-center justify-center rounded-full bg-[#45152f] px-8 py-4 text-lg font-extrabold text-white hover:bg-[#5b1d3e] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
        >
          {isSubmitting ? (
            <Spinner className="h-5 w-5 border-white/30 border-t-white" />
          ) : (
            `Pay & Register${feeValid ? ` (R${fee.toFixed(2)})` : ''}`
          )}
        </button>
      </div>
    </div>
  );
}

function ArtistRegisterModal({ item, onClose, notify }) {
  return (
    <Modal label="Register as an artist" title="Artist registration" onClose={onClose}>
      <ArtistRegistrationForm item={item} onClose={onClose} notify={notify} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function Competitions() {
  const navigate = useNavigate();
  const online = useOnline();

  const [posts, setPosts] = useState([]);
  const [judgeEntries, setJudgeEntries] = useState([]);
  const [postsLoaded, setPostsLoaded] = useState(false);
  const [judgeLoaded, setJudgeLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const [selectedKey, setSelectedKey] = useState(null);
  const [showCompetitionForm, setShowCompetitionForm] = useState(false);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [showArtists, setShowArtists] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = useCallback((t) => setToast(t), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  // Live listeners – everyone sees every competition (no login or uid filter).
  useEffect(() => {
    const onError = (label) => (error) => {
      console.error(`Competitions: error loading ${label}:`, error);
      setLoadError(true);
    };

    const unsubPosts = onSnapshot(
      collection(db, 'posts'),
      (snap) => {
        setPosts(snap.docs.map(normalizePost).filter(Boolean));
        setPostsLoaded(true);
        setLoadError(false);
      },
      onError('posts')
    );

    const unsubJudge = onSnapshot(
      collection(db, 'judge-form'),
      (snap) => {
        setJudgeEntries(snap.docs.map(normalizeJudge));
        setJudgeLoaded(true);
        setLoadError(false);
      },
      onError('judge-form')
    );

    return () => {
      unsubPosts();
      unsubJudge();
    };
  }, [retryKey]);

  // One mixed list, newest first
  const competitions = useMemo(
    () =>
      [...posts, ...judgeEntries].sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
      ),
    [posts, judgeEntries]
  );

  const selected = useMemo(
    () => competitions.find((c) => c.key === selectedKey) || null,
    [competitions, selectedKey]
  );

  const openEvent = (key) => {
    setSelectedKey(key);
    window.scrollTo({ top: 0 });
  };

  // Register button: anyone logged in may enter. No artist profile is needed.
  // The only rule: the host of a competition can't enter it.
  const handleRegister = (item) => {
    if (isClosed(item.closesAt)) return;
    const user = auth.currentUser;
    if (!user) {
      notify({ type: 'error', title: 'Log in required', message: 'Please log in to register for this competition.' });
      return;
    }
    if (item.ownerUid && item.ownerUid === user.uid) {
      notify({ type: 'error', title: 'Not allowed', message: "You host this competition, so you can't enter it as an artist." });
      return;
    }
    setShowRegister(true);
  };

  const requireLogin = (message, open) => {
    if (!auth.currentUser) {
      notify({ type: 'error', title: 'Log in required', message });
      return;
    }
    open();
  };

  // Anyone logged in can host a competition (no host profile needed).
  const openCompetitionForm = () =>
    requireLogin('Please log in to add a competition.', () => setShowCompetitionForm(true));
  // Tickets are switched off for now. To switch them back on, use this instead:
  // const openTicketForm = () =>
  //   requireLogin('Please log in to sell tickets.', () => setShowTicketForm(true));
  const openTicketForm = () => alert('will be available soon');
  const closeCompetitionForm = useCallback(() => setShowCompetitionForm(false), []);
  const closeTicketForm = useCallback(() => setShowTicketForm(false), []);
  const closeArtists = useCallback(() => setShowArtists(false), []);
  const closeRegister = useCallback(() => setShowRegister(false), []);

  const networkIssue = !online || loadError;
  const loaded = postsLoaded && judgeLoaded;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <div className="mx-auto max-w-4xl px-5 pb-16 pt-10">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900">Competitions</h1>
            <p className="mt-1 text-sm text-slate-500">Browse every competition and open one to see its details.</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={openCompetitionForm}
              className={`rounded-full bg-[#45152f] px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[#5b1d3e] ${FOCUS_LIGHT}`}
            >
              + Competition
            </button>
            <button
              onClick={openTicketForm}
              className={`rounded-full border border-[#45152f] bg-white px-5 py-2.5 text-sm font-bold text-[#45152f] transition-colors hover:bg-slate-100 ${FOCUS_LIGHT}`}
            >
              + Ticket
            </button>
          </div>
        </header>

        {/* Only shown when something is wrong with the connection */}
        {networkIssue && (
          <div
            role="status"
            className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 ring-1 ring-rose-200"
          >
            <div className="flex items-center gap-3">
              <Spinner className="h-5 w-5" />
              <p className="text-sm text-rose-800">
                {!online
                  ? 'You’re offline. Competitions will load when your connection is back.'
                  : 'Can’t reach the server right now. Check your connection and try again.'}
              </p>
            </div>
            {loadError && online && (
              <button
                onClick={() => {
                  setLoadError(false);
                  setRetryKey((k) => k + 1);
                }}
                className={`rounded-full bg-[#45152f] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#5b1d3e] ${FOCUS_LIGHT}`}
              >
                Try again
              </button>
            )}
          </div>
        )}

        <main className="mt-8">
          {selected ? (
            <EventPage
              item={selected}
              onBack={() => setSelectedKey(null)}
              onViewArtists={() => setShowArtists(true)}
              onRegister={() => handleRegister(selected)}
            />
          ) : competitions.length > 0 ? (
            <ul className="space-y-3">
              {competitions.map((item) => (
                <li key={item.key}>
                  <CompetitionRow item={item} onClick={() => openEvent(item.key)} />
                </li>
              ))}
            </ul>
          ) : loaded && !networkIssue ? (
            <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-12 text-center">
              <p className="text-sm text-slate-500">No competitions yet. Add the first one.</p>
              <button
                onClick={openCompetitionForm}
                className={`mt-4 rounded-full bg-[#45152f] px-6 py-2.5 text-sm font-bold text-white hover:bg-[#5b1d3e] ${FOCUS_LIGHT}`}
              >
                + Competition
              </button>
            </div>
          ) : null}
        </main>
      </div>

      {/* Mounted only while open, so each form starts fresh every time */}
      {showCompetitionForm && <CompetitionModal onClose={closeCompetitionForm} notify={notify} />}
      {showTicketForm && <TicketModal onClose={closeTicketForm} notify={notify} />}
      {selected && showArtists && (
        <ArtistsModal
          item={selected}
          onClose={closeArtists}
          onVote={(artistId) => {
            setShowArtists(false);
            navigate(ROUTES.vote(selected.id, artistId, SOURCES[selected.source].param));
          }}
        />
      )}
      {selected && showRegister && <ArtistRegisterModal item={selected} onClose={closeRegister} notify={notify} />}
    </div>
  );
}