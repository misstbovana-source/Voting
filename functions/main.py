import hashlib
import json
import os
import re
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Literal, Optional
from urllib.parse import quote, quote_plus

from firebase_admin import auth as fb_auth
from firebase_admin import firestore, initialize_app, storage
from firebase_functions import https_fn, options
from google.cloud.firestore_v1.base_query import FieldFilter
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

REGION = "us-central1"
options.set_global_options(region=REGION, max_instances=10)
initialize_app()

_db_client = None


def db():
    global _db_client
    if _db_client is None:
        _db_client = firestore.client()
    return _db_client


Code = https_fn.FunctionsErrorCode
Source = Literal["posts", "judge-form"]

JUDGE_FORM = "judge-form"
ACCEPTED = "accepted-artist"
ARTIST_POST = "artist-post"
PENDING_VOTES = "pending-votes"
PENDING_HOSTERS = "pending-hosters"
PENDING_STATES = ("pending_payment", "payfast_pending")

# These match the amounts shown on the website (R10 registration, R20 ticket listing).
# Change them with HOSTER_FEE / TICKET_FEE / VOTE_PRICE in functions/.env.
HOSTER_REGISTRATION_FEE = float(os.environ.get("HOSTER_FEE", "10"))
TICKET_LISTING_FEE = float(os.environ.get("TICKET_FEE", "20"))
PRICE_PER_VOTE = float(os.environ.get("VOTE_PRICE", "2"))
MAX_VOTES_PER_PURCHASE = 1000


def _err(code, message):
    return https_fn.HttpsError(code, message)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _need(name: str) -> str:
    value = _env(name)
    if not value:
        raise _err(Code.FAILED_PRECONDITION, f"Server setting {name} is missing.")
    return value


def _auth(req):
    if req.auth is None:
        raise _err(Code.UNAUTHENTICATED, "Please log in first.")
    return req.auth.uid, (req.auth.token or {})


def _invalid(e: ValidationError):
    parts = []
    for err in e.errors():
        print(f"[422] field={'.'.join(str(x) for x in err['loc'])} | {err['msg']}", flush=True)
        field = ".".join(str(p) for p in err["loc"] if p not in ("hosterData", "judgeFormDetails"))
        msg = err["msg"].replace("Value error, ", "")
        parts.append(f"{field}: {msg}" if field else msg)
    return _err(Code.INVALID_ARGUMENT, "; ".join(parts) or "Invalid data.")


def _iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_dt(d: dict, *names: str, time_key: Optional[str] = None):
    for src in (d, d.get("judgeFormDetails") or {}):
        for n in names:
            v = src.get(n)
            if isinstance(v, str) and v:
                if "T" not in v and time_key and src.get(time_key):
                    v = f"{v}T{src[time_key]}"
                try:
                    v = datetime.fromisoformat(v.replace("Z", "+00:00"))
                except ValueError:
                    continue
            if isinstance(v, datetime):
                return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return None


def artist_closing(p):
    return read_dt(p, "artistClosingDateTime", "artistRegClosingDate")


def voting_end(p):
    return read_dt(p, "votingClosingDateTime", "votingClosingDate", time_key="votingClosingTime")


def top10_end(p):
    return read_dt(p, "top10ClosingDateTime", "top10closingDateTime", "top10ClosingDate", time_key="top10ClosingTime")


def is_owner(uid: str, token: dict, parent: dict) -> bool:
    return token.get("admin") is True or uid in (parent.get("hosterUid"), parent.get("ownerUid"))


def hosts_competition(uid: str, comp: dict) -> bool:
    """True when this user created the competition (the host may not enter it as an artist)."""
    return uid in (comp.get("hosterUid"), comp.get("ownerUid"), comp.get("registeredByUid"))


def top_count(comp: dict) -> Optional[int]:
    """How many artists should be left at the end (the competition's topCount)."""
    v = comp.get("topCount") or (comp.get("judgeFormDetails") or {}).get("topCount")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
        return None
    return int(v)


def remaining_artists(cid: str) -> int:
    """Accepted artists of a judged competition who are still in (not eliminated)."""
    n = 0
    for s in db().collection(ACCEPTED).where(filter=FieldFilter("judgeFormId", "==", cid)).stream():
        d = s.to_dict() or {}
        if d.get("isEliminated") is not True and d.get("status") != "eliminated":
            n += 1
    return n


def can_eliminate(uid: str, token: dict, source: str, comp: dict, artist: dict, remaining: Optional[int]) -> bool:
    """Whether the Eliminate button should show for this artist."""
    if source != JUDGE_FORM or remaining is None or not is_owner(uid, token, comp):
        return False
    if artist.get("isEliminated") is True or artist.get("status") == "eliminated":
        return False
    end = voting_end(comp)
    if end and datetime.now(timezone.utc) >= end:
        return False
    top = top_count(comp)
    return top is not None and remaining > top


def get_parent(source: str, cid: str) -> dict:
    snap = db().collection(source).document(cid).get()
    if not snap.exists:
        print(f"[404 LOOKUP] competition missing: {source}/{cid}", flush=True)
        raise _err(Code.NOT_FOUND, "Competition not found.")
    return snap.to_dict() or {}


def has_artist_profile(uid: str) -> bool:
    return db().collection("artists").document(uid).get().exists


def find_voting_artist(source: str, cid: str, artist_id: str):
    parent = get_parent(source, cid)
    if source == "posts":
        snap = db().collection(source).document(cid).collection("registeredArtists").document(artist_id).get()
        if snap.exists:
            return snap.to_dict() or {}, parent
        snap = db().collection(ARTIST_POST).document(f"posts_{cid}_{artist_id}").get()
        if snap.exists:
            return snap.to_dict() or {}, parent
    snap = db().collection(ACCEPTED).document(f"{cid}_{artist_id}").get()
    if snap.exists:
        return snap.to_dict() or {}, parent
    print(f"[404 LOOKUP] voting artist missing: {source}/{cid}/{artist_id}", flush=True)
    raise _err(Code.NOT_FOUND, "Artist not found in this competition.")


def voting_status(artist: dict, parent: dict) -> str:
    if artist.get("isEliminated") is True or artist.get("status") == "eliminated":
        return "eliminated"
    now = datetime.now(timezone.utc)
    end = voting_end(parent) or voting_end(artist)
    if end and now >= end:
        return "general_voting_closed"
    top10 = top10_end(artist) or top10_end(parent)
    finalist = artist.get("isTop10Finalist")
    if top10:
        if now < top10:
            return "waiting_top10_result"
        return "eligible" if finalist is True else "not_top10_finalist"
    if finalist is False:
        return "not_top10_finalist"
    return "eligible"


def _pf_check():
    for name in ("PAYFAST_MERCHANT_ID", "PAYFAST_MERCHANT_KEY", "FRONTEND_URL"):
        _need(name)


def _notify_url() -> str:
    explicit = _env("PAYFAST_NOTIFY_URL")
    if explicit:
        return explicit
    project = os.environ.get("GCLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
    return f"https://{REGION}-{project}.cloudfunctions.net/payfastNotify"


def payfast_url(params: dict) -> str:
    qs = "&".join(f"{k}={quote_plus(str(v).strip())}" for k, v in params.items() if v not in ("", None))
    passphrase = _env("PAYFAST_PASSPHRASE")
    raw = f"{qs}&passphrase={quote_plus(passphrase)}" if passphrase else qs
    sandbox = _env("PAYFAST_SANDBOX", "true").lower() == "true"
    host = "sandbox.payfast.co.za" if sandbox else "www.payfast.co.za"
    print(f"[PAYFAST] sending customer to {host}; notify_url={params.get('notify_url')}", flush=True)
    return f"https://{host}/eng/process?{qs}&signature={hashlib.md5(raw.encode()).hexdigest()}"


def _pf_params(payment_id: str, amount: float, item_name: str, custom: str, back: str) -> dict:
    return {
        "merchant_id": _need("PAYFAST_MERCHANT_ID"),
        "merchant_key": _need("PAYFAST_MERCHANT_KEY"),
        "return_url": back,
        "cancel_url": back,
        "notify_url": _notify_url(),
        "m_payment_id": payment_id,
        "amount": f"{amount:.2f}",
        "item_name": item_name[:100],
        "custom_str1": custom,
    }


def _check_image_urls(urls: List[str]) -> List[str]:
    for url in urls:
        if not url.startswith("https://firebasestorage.googleapis.com/"):
            print(f"[IMAGE] rejected url={url!r}", flush=True)
            raise ValueError("The poster image must be uploaded through the app. Please upload it again.")
    return urls


# ------------------------------------------------------------------ tickets sold together with a competition
TICKET_KEYS = ("general", "vip", "vvip")


class TicketVariant(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, max_length=20)
    price: float = Field(ge=0, le=1_000_000)
    totalQuantity: int = Field(ge=1, le=100_000)


class TicketListing(BaseModel):
    model_config = ConfigDict(extra="ignore")

    eventDate: datetime
    location: Optional[str] = Field(default=None, max_length=200)
    imageUrl: Optional[str] = None
    variants: Dict[str, TicketVariant]

    @field_validator("variants")
    @classmethod
    def variants_ok(cls, v):
        if not v:
            raise ValueError("add at least one ticket type")
        bad = [k for k in v if k not in TICKET_KEYS]
        if bad:
            raise ValueError("unknown ticket type: " + ", ".join(bad))
        return v

    @field_validator("imageUrl")
    @classmethod
    def image_ok(cls, v):
        if v:
            _check_image_urls([v])
        return v


class JudgeFormDetails(BaseModel):
    model_config = ConfigDict(extra="ignore")

    idNo: Optional[str] = Field(default=None, pattern=r"^\d{1,13}$")
    location: Optional[str] = Field(default=None, max_length=200)
    accountNo: str = Field(pattern=r"^\d{1,32}$")
    artistPrice: float = Field(gt=0)
    images: List[str] = Field(min_length=1, max_length=1)
    votingClosingDate: datetime
    artistRegClosingDate: datetime
    top10ClosingDate: datetime
    topCount: int = Field(gt=0, le=99)

    @field_validator("images")
    @classmethod
    def images_ok(cls, urls: List[str]) -> List[str]:
        return _check_image_urls(urls)


class HosterData(BaseModel):
    """judge competition: companyName + judgeFormDetails{...}  -> judge-form
    hosted competition: companyName + flat fields below       -> posts"""
    model_config = ConfigDict(extra="ignore")

    companyName: str = Field(min_length=1, max_length=120)
    judgeFormDetails: Optional[JudgeFormDetails] = None
    location: Optional[str] = Field(default=None, max_length=200)
    accountNo: Optional[str] = Field(default=None, pattern=r"^\d{1,32}$")
    artistPrice: Optional[float] = Field(default=None, gt=0)
    artistRegClosingDate: Optional[datetime] = None
    votingClosingDate: Optional[datetime] = None
    images: Optional[List[str]] = Field(default=None, min_length=1, max_length=1)
    ticketListing: Optional[TicketListing] = None

    @field_validator("companyName")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("images")
    @classmethod
    def hosted_images_ok(cls, urls):
        return _check_image_urls(urls) if urls else urls

    @model_validator(mode="after")
    def need_hosted_fields(self):
        if self.judgeFormDetails is None:
            required = ("accountNo", "artistPrice", "artistRegClosingDate", "votingClosingDate", "images")
            missing = [n for n in required if not getattr(self, n)]
            if missing:
                raise ValueError("missing required fields: " + ", ".join(missing))
        return self


class SubmitRequest(BaseModel):
    hosterData: HosterData


def _create_hoster_payment(uid: str, token: dict, hoster: HosterData) -> dict:
    """Shared by the callable function and the website's /api/hoster-registration + /api/hosted-registration."""
    email = token.get("email") or "unknown@example.com"
    _pf_check()

    listing = hoster.ticketListing
    total = HOSTER_REGISTRATION_FEE + (TICKET_LISTING_FEE if listing else 0.0)

    details = hoster.judgeFormDetails
    if details is not None:
        target = JUDGE_FORM
        doc = {
            "companyName": hoster.companyName,
            "hosterUid": uid,
            "registeredByUid": uid,
            "images": details.images,
            "submissionTimestamp": firestore.SERVER_TIMESTAMP,
            "email": email,
            "description": f"Judge Event Form Submission: {hoster.companyName}",
            "registrationFee": HOSTER_REGISTRATION_FEE,
            "idNo": details.idNo or "",
            "location": details.location or "",
            "accountNo": details.accountNo,
            "artistPrice": details.artistPrice,
            "votingClosingDate": _iso_utc(details.votingClosingDate),
            "artistRegClosingDate": _iso_utc(details.artistRegClosingDate),
            "top10ClosingDate": _iso_utc(details.top10ClosingDate),
            "topCount": details.topCount,
        }
    else:
        target = "posts"
        artist_close = _iso_utc(hoster.artistRegClosingDate)
        vote_close = _iso_utc(hoster.votingClosingDate)
        doc = {
            "companyName": hoster.companyName,
            "hosterUid": uid,
            "registeredByUid": uid,
            "email": email,
            "description": f"Hosted Competition Submission: {hoster.companyName}",
            "competitionType": "hosted",
            "location": hoster.location or "",
            "images": hoster.images,
            "posterImage": hoster.images[0],
            "registrationFee": HOSTER_REGISTRATION_FEE,
            "accountNo": hoster.accountNo,
            "artistPrice": hoster.artistPrice,
            "artistRegClosingDate": artist_close,
            "artistClosingDateTime": artist_close,
            "votingClosingDate": vote_close,
            "votingClosingDateTime": vote_close,
            "submissionTimestamp": firestore.SERVER_TIMESTAMP,
        }

    doc["totalAmount"] = total
    if listing:
        # published to the `tickets` collection only after PayFast confirms the payment
        doc["ticketListing"] = {
            "eventDate": _iso_utc(listing.eventDate),
            "location": listing.location or doc.get("location") or "",
            "imageUrl": listing.imageUrl or (doc.get("images") or [None])[0],
            "variants": {k: v.model_dump() for k, v in listing.variants.items()},
            "fee": TICKET_LISTING_FEE,
        }

    ref = db().collection(PENDING_HOSTERS).document()
    ref.set({**doc, "targetCollection": target, "status": "pending_payment", "createdAt": firestore.SERVER_TIMESTAMP})
    print(f"[HOSTER] saved {PENDING_HOSTERS}/{ref.id} (-> {target}) uid={uid} total={total}, awaiting payment", flush=True)

    back = f"{_need('FRONTEND_URL')}/profile/me"
    return {
        "success": True,
        "message": "Hoster registration created. Awaiting payment.",
        "paymentUrl": payfast_url(_pf_params(
            ref.id, total, f"Hoster registration: {hoster.companyName}",
            f"{PENDING_HOSTERS}/{ref.id}", back,
        )),
        "hosterRegistrationId": ref.id,
    }


@https_fn.on_call()
def initiateHostersPayment(req: https_fn.CallableRequest) -> dict:
    uid, token = _auth(req)
    try:
        hoster = SubmitRequest.model_validate(req.data or {}).hosterData
    except ValidationError as e:
        raise _invalid(e)
    return _create_hoster_payment(uid, token, hoster)


class RegisterBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cid: str = Field(min_length=1)
    source: Source
    artistName: str = Field(min_length=1, max_length=100)
    idNo: str = Field(pattern=r"^\d{1,13}$")
    accountNo: str = Field(pattern=r"^\d{1,32}$")
    images: List[str] = Field(min_length=1, max_length=1)


def _create_artist_payment(uid: str, token: dict, body: RegisterBody) -> dict:
    """Shared by the callable function and the website's /api/artist-registration."""
    _pf_check()

    parent = get_parent(body.source, body.cid)
    # Anyone with an account may enter, except the person who hosts this competition.
    if hosts_competition(uid, parent):
        raise _err(Code.PERMISSION_DENIED, "You host this competition, so you can't enter it as an artist.")
    closes = artist_closing(parent)
    if closes and datetime.now(timezone.utc) > closes:
        raise _err(Code.FAILED_PRECONDITION, "Registration for this competition has closed.")

    fee = parent.get("artistPrice")
    if not isinstance(fee, (int, float)) or fee <= 0:
        raise _err(Code.FAILED_PRECONDITION, "This competition has no registration fee set yet.")

    image = body.images[0]
    if not image.startswith("https://firebasestorage.googleapis.com/") or f"%2F{uid}%2F" not in image:
        raise _err(Code.INVALID_ARGUMENT, "Upload the poster image again and retry.")

    artists = db().collection(body.source).document(body.cid).collection("artists")
    dupes = list(
        artists.where(filter=FieldFilter("idNo", "==", body.idNo))
        .where(filter=FieldFilter("accountNo", "==", body.accountNo))
        .where(filter=FieldFilter("status", "in", ["payment_complete", *PENDING_STATES]))
        .limit(1)
        .stream()
    )
    fields = {
        "artistName": body.artistName.strip(),
        "images": body.images,
        "registrationFee": fee,
    }
    if dupes:
        existing = dupes[0]
        if (existing.to_dict() or {}).get("status") == "payment_complete":
            raise _err(Code.ALREADY_EXISTS, "This artist is already registered.")
        # unpaid earlier attempt: reuse it and issue a fresh payment link
        ref = existing.reference
        ref.update(fields)
        print(f"[ARTIST] reusing unpaid registration {ref.path}", flush=True)
    else:
        ref = artists.document()
        ref.set({
            **fields,
            "idNo": body.idNo,
            "accountNo": body.accountNo,
            "registeredByUid": uid,
            "status": "pending_payment",
            "associatedParentId": body.cid,
            "associatedParentCollection": body.source,
            "companyName": parent.get("companyName", ""),
            "totalVotesReceived": 0,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        print(f"[ARTIST] saved {ref.path}, awaiting payment", flush=True)

    back = f"{_need('FRONTEND_URL')}/artists?eventId={body.cid}&source={body.source}"
    return {
        "success": True,
        "paymentUrl": payfast_url(_pf_params(
            ref.id, float(fee), f"Artist registration: {parent.get('companyName', 'competition')}",
            f"{body.source}/{body.cid}", back,
        )),
        "tempArtistId": ref.id,
    }


@https_fn.on_call()
def initiateArtistPayment(req: https_fn.CallableRequest) -> dict:
    uid, token = _auth(req)
    try:
        body = RegisterBody.model_validate(req.data or {})
    except ValidationError as e:
        raise _invalid(e)
    return _create_artist_payment(uid, token, body)


class VoteBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cid: str = Field(min_length=1)
    artistId: str = Field(min_length=1)
    source: Source = "posts"
    voteQuantity: int = Field(ge=1, le=MAX_VOTES_PER_PURCHASE)


def _create_vote_payment(uid: str, body: VoteBody) -> dict:
    """Shared by the callable function and the website's POST /api/competitions/<id>/artists/<id>/vote."""
    _pf_check()

    artist, parent = find_voting_artist(body.source, body.cid, body.artistId)
    status = voting_status(artist, parent)
    if status != "eligible":
        messages = {
            "eliminated": "This artist has been eliminated and can't receive more votes.",
            "general_voting_closed": "Voting for this competition has closed.",
            "waiting_top10_result": "Voting is paused while the top results are being decided.",
            "not_top10_finalist": "This artist didn't make the top count, so voting for them has ended.",
        }
        raise _err(Code.FAILED_PRECONDITION, messages.get(status, "Voting isn't available for this artist."))

    artist_name = artist.get("artistName") or "Unknown artist"
    total = body.voteQuantity * PRICE_PER_VOTE

    ref = db().collection(PENDING_VOTES).document()
    ref.set({
        "voterUid": uid,
        "artistId": body.artistId,
        "artistName": artist_name,
        "competitionId": body.cid,
        "source": body.source,
        "artistPostKey": f"{body.source}_{body.cid}_{body.artistId}",
        "voteQuantity": body.voteQuantity,
        "pricePerVote": PRICE_PER_VOTE,
        "totalAmount": total,
        "paymentGateway": "PAYFAST",
        "status": "pending_payment",
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    print(f"[VOTE] saved {PENDING_VOTES}/{ref.id} qty={body.voteQuantity}, awaiting payment", flush=True)

    back = f"{_need('FRONTEND_URL')}/competitions/{body.cid}/artists/{body.artistId}/vote?source={body.source}"
    return {
        "success": True,
        "message": "Payment started.",
        "orderId": ref.id,
        "paymentUrl": payfast_url(_pf_params(
            ref.id, total, f"{body.voteQuantity} vote(s) for {artist_name}",
            f"{PENDING_VOTES}/{ref.id}", back,
        )),
    }


@https_fn.on_call()
def initiateArtistVotingPayment(req: https_fn.CallableRequest) -> dict:
    uid, _ = _auth(req)
    try:
        body = VoteBody.model_validate(req.data or {})
    except ValidationError as e:
        raise _invalid(e)
    return _create_vote_payment(uid, body)


# ------------------------------------------------------------------ PayFast confirmation
def _itn_signature_ok(form) -> bool:
    pairs = [(k, v) for k, v in form.items(multi=True) if k != "signature"]
    qs = "&".join(f"{k}={quote_plus(str(v).strip())}" for k, v in pairs)
    passphrase = _env("PAYFAST_PASSPHRASE")
    if passphrase:
        qs += f"&passphrase={quote_plus(passphrase)}"
    return hashlib.md5(qs.encode()).hexdigest() == form.get("signature")


@firestore.transactional
def _settle(tx, ref, new_status, on_paid=None, amount_field=None, gross=None):
    """Marks a payment complete exactly once (PayFast may send the notification more than once)."""
    snap = ref.get(transaction=tx)
    if not snap.exists:
        return "document missing"
    data = snap.to_dict() or {}
    if data.get("status") not in PENDING_STATES:
        return "already processed"
    if amount_field:
        if gross is None:
            return "missing amount from PayFast"
        raw = data.get(amount_field)
        if raw is None and amount_field == "totalAmount":
            raw = data.get("registrationFee")  # older pending documents only stored the fee
        try:
            expected = float(raw)
        except (TypeError, ValueError):
            return "no expected amount stored"
        if abs(expected - gross) > 0.01:
            return f"amount mismatch (expected {expected}, PayFast says {gross})"
    tx.update(ref, {"status": new_status, "paidAt": firestore.SERVER_TIMESTAMP})
    if on_paid:
        on_paid(tx, data)
    return "ok"


def _vote_paid(tx, data):
    key = data.get("artistPostKey")
    if key:
        tx.set(
            db().collection(ARTIST_POST).document(key),
            {"totalVotesReceived": firestore.Increment(int(data.get("voteQuantity") or 0))},
            merge=True,
        )


def _hoster_paid(payment_id: str):
    def run(tx, data):
        target = data.get("targetCollection") or "posts"
        live = {k: v for k, v in data.items() if k not in ("targetCollection", "createdAt", "ticketListing")}
        live["status"] = "approved"  # paid, so the competition is live straight away
        live["paidAt"] = firestore.SERVER_TIMESTAMP
        tx.set(db().collection(target).document(payment_id), live)

        listing = data.get("ticketListing")
        if listing:
            # tickets were paid for together with the competition: publish them now
            tx.set(db().collection("tickets").document(), {
                "eventName": data.get("companyName"),
                "eventDate": listing.get("eventDate"),
                "location": listing.get("location") or data.get("location") or "",
                "imageUrl": listing.get("imageUrl"),
                "variants": listing.get("variants") or {},
                "sellerUid": data.get("hosterUid"),
                "competitionId": payment_id,
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
    return run


def _artist_paid(source: str, cid: str, payment_id: str):
    def run(tx, data):
        artist_id = data.get("registeredByUid") or payment_id
        tx.set(
            db().collection(source).document(cid).collection("registeredArtists").document(artist_id),
            {
                **data,
                "artistId": artist_id,
                "status": "payment_complete",
                "registeredAt": firestore.SERVER_TIMESTAMP,
                "paidAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        tx.set(
            db().collection(ARTIST_POST).document(f"{source}_{cid}_{artist_id}"),
            {
                "artistName": data.get("artistName"),
                "images": data.get("images", []),
                "registeredByUid": data.get("registeredByUid"),
                "registeredAt": firestore.SERVER_TIMESTAMP,
                "totalVotesReceived": firestore.Increment(0),
            },
            merge=True,
        )
    return run


@https_fn.on_request()
def payfastNotify(req: https_fn.Request) -> https_fn.Response:
    try:
        form = req.form
        payment_id = form.get("m_payment_id")
        custom = form.get("custom_str1") or ""
        pay_status = form.get("payment_status")
        print(f"[NOTIFY] received: id={payment_id} status={pay_status} custom={custom}", flush=True)

        if _env("PAYFAST_VERIFY", "true").lower() == "true" and not _itn_signature_ok(form):
            print("[NOTIFY] REJECTED: invalid signature (check PAYFAST_PASSPHRASE)", flush=True)
            return https_fn.Response("invalid signature", status=400)

        if pay_status != "COMPLETE" or not payment_id or "/" not in custom:
            print("[NOTIFY] IGNORED: not a completed payment", flush=True)
            return https_fn.Response("OK", status=200)

        try:
            gross = float(form.get("amount_gross"))
        except (TypeError, ValueError):
            gross = None

        col, parent_id = custom.split("/", 1)
        tx = db().transaction()

        if col == PENDING_VOTES:
            result = _settle(tx, db().collection(PENDING_VOTES).document(payment_id),
                             "payment_complete", _vote_paid, "totalAmount", gross)
        elif col == PENDING_HOSTERS:
            result = _settle(tx, db().collection(PENDING_HOSTERS).document(payment_id),
                             "payment_complete", _hoster_paid(payment_id), "totalAmount", gross)
        elif col in ("posts", JUDGE_FORM):
            ref = db().collection(col).document(parent_id).collection("artists").document(payment_id)
            result = _settle(tx, ref, "payment_complete", _artist_paid(col, parent_id, payment_id),
                             "registrationFee", gross)
        else:
            print(f"[NOTIFY] UNKNOWN custom_str1={custom!r}, nothing updated", flush=True)
            return https_fn.Response("OK", status=200)

        print(f"[NOTIFY] {col} payment {payment_id}: {result}", flush=True)
        return https_fn.Response("OK", status=200)
    except Exception:
        traceback.print_exc()
        return https_fn.Response("error", status=500)


# =====================================================================
# Admin dashboard
# =====================================================================
DASHBOARD_PERIODS = {"7 days": 7, "30 days": 30, "90 days": 90}
CLOSING_SOON = timedelta(days=3)
HIDDEN_STATES = ("pending_payment", "payfast_pending", "rejected")
IMAGE_KEYS = ("imageUrl", "photoURL", "photo", "avatar", "profileImage")


def _as_dt(v):
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return None


def _count(query) -> int:
    try:
        return int(query.count().get()[0][0].value)
    except Exception:
        traceback.print_exc()
        return 0


def _pct_change(current: int, previous: int) -> str:
    if previous == 0:
        return "New" if current > 0 else "0%"
    pct = (current - previous) / previous * 100
    return f"{pct:+.1f}%"


def _first(d: dict, *keys: str) -> str:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return str(v)
    return ""


def _person_name(u: dict, fallback: str = "") -> str:
    name = _first(u, "displayName", "fullName", "name", "username")
    if name:
        return name
    joined = " ".join(x for x in (_first(u, "firstName", "firstname"), _first(u, "lastName", "lastname", "surname")) if x)
    return joined or fallback


def _batch_docs(collection: str, ids) -> dict:
    """Reads many documents of one collection at once. Returns {doc id: data} for the ones that exist."""
    wanted = [i for i in dict.fromkeys(ids) if i]
    out = {}
    for start in range(0, len(wanted), 200):
        refs = [db().collection(collection).document(x) for x in wanted[start:start + 200]]
        try:
            for snap in db().get_all(refs):
                if snap.exists:
                    out[snap.id] = snap.to_dict() or {}
        except Exception:
            traceback.print_exc()
    return out


def _owner_profiles(uids) -> dict:
    """Looks up the profile (users/<uid>) of each competition owner in one batch."""
    return _batch_docs("users", uids)


def _owner_info(uid: str, profile: dict, comp: dict) -> dict:
    """Owner details for the dashboard; falls back to what the competition itself stored."""
    return {
        "uid": uid or "",
        "name": _person_name(profile, comp.get("companyName") or ""),
        "email": _first(profile, "email") or _first(comp, "email"),
        "phone": _first(profile, "phone", "phoneNumber", "cell", "mobile"),
        "photoURL": _first(profile, *IMAGE_KEYS),
        "role": _first(profile, "role"),
        "location": _first(profile, "location", "city") or _first(comp, "location"),
    }


# Admins are accounts with the `admin` custom claim, or whose email is listed in ADMIN_EMAILS (functions/.env).
ADMIN_EMAILS = {e.strip().lower() for e in _env("ADMIN_EMAILS").split(",") if e.strip()}


def _is_admin(token: dict) -> bool:
    if token.get("admin") is True:
        return True
    email = str(token.get("email") or "").strip().lower()
    return bool(email) and email in ADMIN_EMAILS


def _my_profile(uid: str, token: dict) -> dict:
    """The signed-in user's own profile, read straight from users/<uid> (no REST API needed)."""
    doc = _batch_docs("users", [uid]).get(uid, {})
    info = _owner_info(uid, doc, {})
    email = info["email"] or token.get("email") or ""
    info["email"] = email
    info["name"] = info["name"] or token.get("name") or (email.split("@")[0] if email else "")
    info["photoURL"] = info["photoURL"] or token.get("picture") or ""
    info["isAdmin"] = _is_admin(token)
    return info


def _chunks(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


@https_fn.on_call()
def getDashboardData(req: https_fn.CallableRequest) -> dict:
    """Dashboard numbers for the signed-in owner: only their own competitions, votes and artists.
    Admins may ask for {"scope": "all"} to see the whole platform."""
    uid, token = _auth(req)
    admin = _is_admin(token)
    asked = req.data or {}
    scope = "all" if (admin and asked.get("scope") == "all") else "mine"

    period = asked.get("period", "7 days")
    days = DASHBOARD_PERIODS.get(period, 7)
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    prev_start = start - timedelta(days=days)

    me = _my_profile(uid, token)

    # ---- competitions in scope (owner: where hosterUid == their uid)
    comps = []
    for source in ("posts", JUDGE_FORM):
        col = db().collection(source)
        query = col.limit(200) if scope == "all" else col.where(filter=FieldFilter("hosterUid", "==", uid)).limit(200)
        for snap in query.stream():
            d = snap.to_dict() or {}
            if d.get("status") in HIDDEN_STATES:
                continue
            comps.append((source, snap.id, d))

    # ---- paid votes in scope
    votes = []

    def add_vote(snap):
        d = snap.to_dict() or {}
        if d.get("status") != "payment_complete":
            return
        votes.append({
            "qty": int(d.get("voteQuantity") or 0),
            "at": _as_dt(d.get("paidAt")) or _as_dt(d.get("createdAt")),
            "cid": d.get("competitionId"),
            "artist": d.get("artistName") or "An artist",
            "voter": d.get("voterUid"),
        })

    if scope == "all":
        for snap in db().collection(PENDING_VOTES).where(filter=FieldFilter("status", "==", "payment_complete")).stream():
            add_vote(snap)
    else:
        for chunk in _chunks([cid for _, cid, _ in comps], 30):
            for snap in db().collection(PENDING_VOTES).where(filter=FieldFilter("competitionId", "in", chunk)).stream():
                add_vote(snap)

    total_votes = sum(v["qty"] for v in votes)
    in_period = sum(v["qty"] for v in votes if v["at"] and v["at"] >= start)
    in_previous = sum(v["qty"] for v in votes if v["at"] and prev_start <= v["at"] < start)

    first_day = (now - timedelta(days=days - 1)).date()
    buckets = [0] * days
    for v in votes:
        if v["at"]:
            i = (v["at"].date() - first_day).days
            if 0 <= i < days:
                buckets[i] += v["qty"]
    series = [
        {"label": (first_day + timedelta(days=i)).strftime("%d %b"), "votes": buckets[i]}
        for i in range(days)
    ]

    votes_by_comp = {}
    for v in votes:
        votes_by_comp[v["cid"]] = votes_by_comp.get(v["cid"], 0) + v["qty"]

    # ---- competition cards
    competitions = []
    for source, cid, d in comps:
        end = voting_end(d)
        closed = bool(end and end <= now)
        begin = _as_dt(d.get("paidAt")) or _as_dt(d.get("submissionTimestamp"))
        if closed:
            progress = 100
        elif begin and end and end > begin:
            progress = int(max(0, min(100, (now - begin) / (end - begin) * 100)))
        else:
            progress = 0

        if closed:
            status = "Voting closed"
        elif end and end - now <= CLOSING_SOON:
            status = "Closing soon"
        else:
            status = "Voting open"

        competitions.append({
            "id": f"{source}_{cid}",
            "name": d.get("companyName") or "Untitled competition",
            "category": "Judged competition" if source == JUDGE_FORM else "Hosted competition",
            "votes": votes_by_comp.get(cid, 0),
            "progress": progress,
            "status": status,
            "closed": closed,
            "_owner": d.get("hosterUid") or d.get("ownerUid") or d.get("registeredByUid") or "",
            "_doc": d,
        })

    active_count = sum(1 for c in competitions if not c["closed"])
    competitions.sort(key=lambda c: (c["closed"], -c["votes"]))
    top = competitions[:8]

    owners = {}
    competitions = []
    profiles = {}
    if scope == "all":
        profiles = _owner_profiles([c["_owner"] for c in top])
    for c in top:
        owner_uid = c.pop("_owner", "")
        doc = c.pop("_doc", {})
        c.pop("closed", None)
        if scope == "all":
            info = _owner_info(owner_uid, profiles.get(owner_uid, {}), doc)
            key = owner_uid or info["email"] or c["id"]
            if key not in owners:
                owners[key] = {**info, "competitions": 0}
            owners[key]["competitions"] += 1
        else:
            info = me
        c["owner"] = info
        competitions.append(c)

    # ---- artists and voters
    activities = []
    for v in sorted((v for v in votes if v["at"]), key=lambda v: v["at"], reverse=True)[:5]:
        activities.append({
            "name": v["artist"],
            "detail": f"received {v['qty']} new vote{'s' if v['qty'] != 1 else ''}",
            "at": _iso_utc(v["at"]),
        })

    if scope == "all":
        artists = _count(db().collection("artists"))
        new_artists = _count(db().collection("artists").where(filter=FieldFilter("createdAt", ">=", start)))
        voters = _count(db().collection("users").where(filter=FieldFilter("role", "==", "voter")))
        new_voters = _count(
            db().collection("users")
            .where(filter=FieldFilter("role", "==", "voter"))
            .where(filter=FieldFilter("createdAt", ">=", start))
        )
        recent = db().collection(ARTIST_POST).order_by("registeredAt", direction=firestore.Query.DESCENDING).limit(5)
        for snap in recent.stream():
            d = snap.to_dict() or {}
            at = _as_dt(d.get("registeredAt"))
            if at and d.get("artistName"):
                activities.append({"name": d["artistName"], "detail": "registered as an artist", "at": _iso_utc(at)})
    else:
        artist_rows = []
        for source, cid, _ in comps:
            if source == "posts":
                docs = db().collection("posts").document(cid).collection("registeredArtists").limit(1000).stream()
                time_key = "registeredAt"
            else:
                docs = db().collection(ACCEPTED).where(filter=FieldFilter("judgeFormId", "==", cid)).limit(1000).stream()
                time_key = "acceptedAt"
            for snap in docs:
                d = snap.to_dict() or {}
                artist_rows.append({"name": d.get("artistName"), "at": _as_dt(d.get(time_key))})
        artists = len(artist_rows)
        new_artists = sum(1 for a in artist_rows if a["at"] and a["at"] >= start)
        for a in sorted((a for a in artist_rows if a["at"] and a["name"]), key=lambda a: a["at"], reverse=True)[:5]:
            activities.append({"name": a["name"], "detail": "registered as an artist", "at": _iso_utc(a["at"])})

        first_vote = {}
        for v in votes:
            if v["voter"] and v["at"] and (v["voter"] not in first_vote or v["at"] < first_vote[v["voter"]]):
                first_vote[v["voter"]] = v["at"]
        voters = len({v["voter"] for v in votes if v["voter"]})
        new_voters = sum(1 for at in first_vote.values() if at >= start)

    activities.sort(key=lambda a: a["at"], reverse=True)

    return {
        "scope": scope,
        "profile": me,
        "stats": {
            "totalVotes": total_votes,
            "votesChange": _pct_change(in_period, in_previous),
            "activeCompetitions": active_count,
            "artists": artists,
            "newArtists": new_artists,
            "voters": voters,
            "newVoters": new_voters,
        },
        "series": series,
        "competitions": competitions,
        "owners": list(owners.values()),
        "activities": activities[:6],
    }


# =====================================================================
# REST API for the website
#   Every request carries  Authorization: Bearer <Firebase ID token>.
#
#   GET   /api/users/me                               -> the logged-in user's profile
#   POST  /api/users/profile                          -> create / update that profile
#   POST  /api/hoster-registration                    -> judge competition form  (returns paymentUrl)
#   POST  /api/hosted-registration                    -> hosted competition form (returns paymentUrl)
#   POST  /api/artist-registration                    -> artist registration     (returns paymentUrl)
#   GET   /api/artists                                -> the Artists page list
#   GET   /api/competitions                           -> competitions open for artist registration
#   GET   /api/competitions/<id>/artists/<artistId>   -> one artist's details
#   GET   /api/competitions/<id>/artists/<artistId>/voting     -> what the voting page / profile pop-up shows
#   POST  /api/competitions/<id>/artists/<artistId>/vote       -> start a vote payment (returns paymentUrl)
#   GET   /api/competitions/<id>/artists/<artistId>/top-voters -> that artist's top voters
#   GET   /api/competitions/<id>/overview             -> competition pop-up on the profile page
#   GET   /api/competitions/<id>/top-voters           -> the competition's top voters
#   POST  /api/competitions/<id>/register            -> artist registration from the Artists page
#   GET   /api/profile/<uid | me>                     -> profile page data
#   PATCH /api/profile/me                             -> save the bio
#   POST  /api/profile/image                          -> profile photo upload (multipart)
#   POST  /api/uploads/image                          -> image upload (multipart)
#   POST  /api/accepted-artists/<id>/eliminate        -> owner eliminates an artist
# Any route not listed is logged as "[API] UNKNOWN ..." so it can be added.
# =====================================================================
API_CORS = options.CorsOptions(
    cors_origins="*",
    cors_methods=["get", "post", "put", "patch", "delete", "options"],
)

# fields a user may never set on their own profile
PROFILE_BLOCKED = {"uid", "email", "admin", "createdAt", "updatedAt", "isAdmin"}
ALLOWED_ROLES = {"voter", "artist", "hoster", "judge", "user"}

IMAGE_FOLDERS = {"artist", "hosted", "judge", "ticket_images", "profile"}
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_BIO = 300
RESULTS_DELAY = timedelta(hours=24)  # winners and vote counts go public 24h after voting closes
STATUS_RANK = {"won": 0, "accepted": 1, "pending": 2, "registered": 3, "eliminated": 4}

# Where finished ticket purchases are stored. Change it with TICKET_PURCHASES in functions/.env.
TICKET_PURCHASES = _env("TICKET_PURCHASES", "ticket-purchases")

_STATUS_BY_CODE = {
    "invalid-argument": 400, "failed-precondition": 400, "out-of-range": 400,
    "unauthenticated": 401, "permission-denied": 403, "not-found": 404,
    "already-exists": 409, "aborted": 409, "resource-exhausted": 429,
    "unimplemented": 501, "unavailable": 503, "deadline-exceeded": 504,
}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _http_error(e: https_fn.HttpsError) -> ApiError:
    """Turns the errors the payment code raises into normal HTTP errors for the website."""
    code = str(getattr(e.code, "value", e.code))
    return ApiError(_STATUS_BY_CODE.get(code, 500), getattr(e, "message", None) or str(e))


def _json_default(v):
    if isinstance(v, datetime):
        return _iso_utc(v)
    return str(v)


def _json(data, status: int = 200) -> https_fn.Response:
    return https_fn.Response(json.dumps(data, default=_json_default), status=status, mimetype="application/json")


def _fail(status: int, message: str) -> https_fn.Response:
    return _json({"success": False, "detail": message, "message": message}, status)


def _api_user(req) -> dict:
    header = req.headers.get("Authorization", "")
    if not header.lower().startswith("bearer ") or not header[7:].strip():
        raise ApiError(401, "Please log in first.")
    try:
        return fb_auth.verify_id_token(header[7:].strip())
    except Exception as e:
        print(f"[API AUTH] bad token: {e}", flush=True)
        raise ApiError(401, "Your login has expired. Please log in again.")


def _body(req) -> dict:
    data = req.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError(400, "Invalid data.")
    return data


def _validate(model, data):
    try:
        return model.model_validate(data)
    except ValidationError as e:
        raise _http_error(_invalid(e))


def _text(v) -> str:
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v if x)
    return str(v) if v else ""


def _first_image(d: dict) -> Optional[str]:
    imgs = d.get("images")
    if isinstance(imgs, list) and imgs:
        return imgs[0]
    return _first(d, "posterImage", "imageUrl") or None


# ------------------------------------------------------------------ users
def _user_response(doc: dict) -> dict:
    # fields are returned both at the top level and under "user", so either shape works
    return {"success": True, **doc, "user": doc}


def _users_me(uid: str, token: dict) -> https_fn.Response:
    snap = db().collection("users").document(uid).get()
    if not snap.exists:
        raise ApiError(404, "User profile not found.")
    doc = snap.to_dict() or {}
    doc.setdefault("uid", uid)
    doc.setdefault("email", token.get("email"))
    # always give the website the same name fields, whichever one the profile was saved with
    name = _person_name(doc, token.get("name") or "")
    if name:
        doc["fullName"] = doc.get("fullName") or name
        doc.setdefault("name", name)
    photo = _first(doc, *IMAGE_KEYS)
    if photo:
        doc.setdefault("imageUrl", photo)
    doc["isAdmin"] = _is_admin(token)
    return _json(_user_response(doc))


def _users_profile(uid: str, token: dict, body: dict) -> https_fn.Response:
    data = {k: v for k, v in body.items() if k not in PROFILE_BLOCKED}
    if len(json.dumps(data, default=str)) > 20000:
        raise ApiError(400, "Profile data is too large.")
    role = data.get("role")
    if role is not None and str(role).lower() not in ALLOWED_ROLES:
        raise ApiError(400, "Invalid role.")

    ref = db().collection("users").document(uid)
    is_new = not ref.get().exists
    data["uid"] = uid
    data["email"] = token.get("email")
    data["updatedAt"] = firestore.SERVER_TIMESTAMP
    if is_new:
        data["createdAt"] = firestore.SERVER_TIMESTAMP
    ref.set(data, merge=True)
    print(f"[API] profile saved users/{uid} new={is_new}", flush=True)

    doc = ref.get().to_dict() or {}
    return _json(_user_response(doc), 201 if is_new else 200)


# ------------------------------------------------------------------ competition + artist registration
def _api_artist_registration(uid: str, token: dict, body: dict) -> dict:
    art = body.get("artistData") if isinstance(body.get("artistData"), dict) else {}
    reg = _validate(RegisterBody, {
        "cid": body.get("parentDocId"),
        "source": body.get("parentCollectionName"),
        "artistName": art.get("artistName"),
        "idNo": art.get("idNo"),
        "accountNo": art.get("accountNo"),
        "images": art.get("images"),
    })
    return _create_artist_payment(uid, token, reg)


def _api_register_from_artists_page(uid: str, token: dict, cid: str, body: dict) -> dict:
    reg = _validate(RegisterBody, {
        "cid": cid,
        "source": body.get("source"),
        "artistName": body.get("artistName"),
        "idNo": body.get("idNo"),
        "accountNo": body.get("accountNo"),
        "images": body.get("images"),
    })
    return _create_artist_payment(uid, token, reg)


# ------------------------------------------------------------------ competitions open for registration
def _open_competitions(uid: str, token: dict) -> list:
    now = datetime.now(timezone.utc)
    out = []
    for source in (JUDGE_FORM, "posts"):
        for snap in db().collection(source).limit(200).stream():
            d = snap.to_dict() or {}
            name = d.get("companyName") or d.get("artistName")
            if not name:
                continue
            fee = d.get("artistPrice")
            if fee is None:
                fee = (d.get("judgeFormDetails") or {}).get("artistPrice")
            if not isinstance(fee, (int, float)) or fee <= 0:
                continue
            closes = artist_closing(d)
            if closes and closes < now:
                continue
            if hosts_competition(uid, d):
                continue
            out.append({
                "id": snap.id,
                "source": source,
                "name": name,
                "artistPrice": fee,
                "artistClosingDateTime": _iso_utc(closes) if closes else None,
            })
    out.sort(key=lambda c: c["name"].lower())
    return out


# ------------------------------------------------------------------ the Artists page
def _artists_list(uid: str, token: dict) -> dict:
    now = datetime.now(timezone.utc)

    items = []
    for source in ("posts", JUDGE_FORM):
        for csnap in db().collection(source).limit(200).stream():
            comp = csnap.to_dict() or {}
            name = comp.get("companyName") or comp.get("artistName")
            if not name:
                continue
            cid = csnap.id
            if source == "posts":
                docs = db().collection("posts").document(cid).collection("registeredArtists").limit(300).stream()
            else:
                docs = db().collection(ACCEPTED).where(filter=FieldFilter("judgeFormId", "==", cid)).limit(300).stream()
            for d in docs:
                data = d.to_dict() or {}
                if source == "posts":
                    artist_id = d.id
                    owner_uid = data.get("registeredByUid") or d.id
                    vote_key = f"posts_{cid}_{artist_id}"
                else:
                    artist_id = data.get("artistId") or d.id
                    owner_uid = artist_id
                    vote_key = f"judge-form_{cid}_{artist_id}"
                items.append({
                    "source": source, "cid": cid, "comp": comp, "comp_name": name,
                    "doc_id": d.id, "data": data, "artist_id": artist_id,
                    "owner_uid": owner_uid, "vote_key": vote_key,
                })
                if len(items) >= 500:
                    break
            if len(items) >= 500:
                break

    vote_docs = _batch_docs(ARTIST_POST, [it["vote_key"] for it in items])
    profiles = _batch_docs("artists", [it["owner_uid"] for it in items])

    groups = {}
    for it in items:
        data = it["data"]
        it["votes_n"] = int((vote_docs.get(it["vote_key"]) or {}).get("totalVotesReceived") or 0)
        it["eliminated"] = data.get("isEliminated") is True or data.get("status") == "eliminated"
        groups.setdefault((it["source"], it["cid"]), []).append(it)

    rows = []
    for (source, cid), group in groups.items():
        comp = group[0]["comp"]
        end = voting_end(comp)
        results_public = bool(end and now > end + RESULTS_DELAY)
        can_manage = is_owner(uid, token, comp)
        best = max((it["votes_n"] for it in group if not it["eliminated"]), default=0)
        left = sum(1 for it in group if not it["eliminated"]) if source == JUDGE_FORM else None

        for it in group:
            data = it["data"]
            winner = results_public and best > 0 and not it["eliminated"] and it["votes_n"] == best
            vs = voting_status(data, comp)

            if it["eliminated"]:
                status = "eliminated"
            elif winner:
                status = "won"
            elif source == JUDGE_FORM:
                status = "pending" if data.get("isNewlyAcceptedPendingReview") else "accepted"
            else:
                status = "registered"

            profile = profiles.get(it["owner_uid"], {})
            when = _as_dt(data.get("acceptedAt")) if source == JUDGE_FORM else _as_dt(data.get("registeredAt"))

            rows.append({
                "key": f"{source}:{cid}:{it['artist_id']}",
                "artistId": it["artist_id"],
                "artistName": data.get("artistName") or data.get("companyName") or "Unnamed artist",
                "images": data.get("images") or [],
                "genres": _text(profile.get("genres")),
                "description": _text(profile.get("description")),
                "competitionId": cid,
                "competitionName": it["comp_name"],
                "source": source,
                "status": status,
                "votes": it["votes_n"] if (results_public or can_manage) else None,
                "date": _iso_utc(when) if when else None,
                "canManage": can_manage,
                "canVote": vs == "eligible" and not winner,
                "isWinner": winner,
                "votingClosed": bool(end and now >= end),
                "votingStatus": vs,
                "origin": "accepted" if source == JUDGE_FORM else "registered",
                "acceptedId": it["doc_id"] if source == JUDGE_FORM else None,
                "artistsLeft": left,
                "topCount": top_count(comp),
                "canEliminate": can_eliminate(uid, token, source, comp, data, left),
            })

    rows.sort(key=lambda r: (r["competitionName"].lower(), STATUS_RANK.get(r["status"], 99), r["artistName"].lower()))
    return {"success": True, "artists": rows, "viewer": {"canRegister": True}}


def _artist_details(uid: str, token: dict, cid: str, artist_id: str, source: str) -> dict:
    if source not in ("posts", JUDGE_FORM):
        raise ApiError(400, "Unknown competition type.")
    comp = get_parent(source, cid)
    comp_name = comp.get("companyName") or comp.get("artistName") or "Competition"

    if source == "posts":
        snap = db().collection("posts").document(cid).collection("registeredArtists").document(artist_id).get()
        if not snap.exists:
            raise ApiError(404, "Artist not found in this competition.")
        data = snap.to_dict() or {}
        reg = data
        registered_at = data.get("registeredAt")
    else:
        snap = db().collection(ACCEPTED).document(f"{cid}_{artist_id}").get()
        data = snap.to_dict() if snap.exists else None
        if data is None:
            found = list(
                db().collection(ACCEPTED)
                .where(filter=FieldFilter("judgeFormId", "==", cid))
                .where(filter=FieldFilter("artistId", "==", artist_id))
                .limit(1).stream()
            )
            if not found:
                raise ApiError(404, "Artist not found in this competition.")
            data = found[0].to_dict() or {}
        regs = db().collection(JUDGE_FORM).document(cid).collection("artists") \
            .where(filter=FieldFilter("registeredByUid", "==", artist_id)).limit(5).stream()
        reg = next(((r.to_dict() or {}) for r in regs if (r.to_dict() or {}).get("status") == "payment_complete"), {})
        registered_at = reg.get("paidAt") or reg.get("createdAt") or data.get("acceptedAt")

    # ID and account numbers are private: only the artist, the competition owner or an admin may see them
    private_ok = is_owner(uid, token, comp) or uid == artist_id
    return {
        "success": True,
        "artistName": data.get("artistName") or "Unnamed artist",
        "images": data.get("images") or [],
        "competitionName": comp_name,
        "idNo": reg.get("idNo") if private_ok else None,
        "accountNo": reg.get("accountNo") if private_ok else None,
        "registrationFee": reg.get("registrationFee"),
        "registeredAt": _as_dt(registered_at),
    }


def _eliminate_artist(uid: str, token: dict, accepted_id: str) -> dict:
    ref = db().collection(ACCEPTED).document(accepted_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError(404, "Artist not found.")
    data = snap.to_dict() or {}
    cid = data.get("judgeFormId")
    if not cid:
        raise ApiError(400, "This artist does not belong to a judged competition.")
    comp_snap = db().collection(JUDGE_FORM).document(cid).get()
    if not comp_snap.exists:
        raise ApiError(404, "Competition not found.")
    comp = comp_snap.to_dict() or {}
    if not is_owner(uid, token, comp):
        raise ApiError(403, "Only the competition owner can eliminate artists.")
    end = voting_end(comp)
    if end and datetime.now(timezone.utc) >= end:
        raise ApiError(400, "Voting has closed, so artists can no longer be eliminated.")
    if data.get("isEliminated") is True or data.get("status") == "eliminated":
        return {"success": True, "message": "Artist was already eliminated."}

    top = top_count(comp)
    if top is None:
        raise ApiError(400, "This competition has no top count set.")
    remaining = remaining_artists(cid)
    if remaining <= top:
        raise ApiError(400, f"Only {top} artists are left, so no more can be eliminated.")

    ref.update({"isEliminated": True, "status": "eliminated", "eliminatedAt": firestore.SERVER_TIMESTAMP})
    remaining -= 1
    reached = remaining <= top
    if reached:
        # the artists who are left are the finalists
        for s in db().collection(ACCEPTED).where(filter=FieldFilter("judgeFormId", "==", cid)).stream():
            d = s.to_dict() or {}
            if d.get("isEliminated") is not True and d.get("status") != "eliminated":
                s.reference.update({"isTop10Finalist": True})
    print(f"[API] eliminated {ACCEPTED}/{accepted_id} by {uid}; left={remaining}/{top}", flush=True)
    return {
        "success": True,
        "message": "Artist eliminated." + (" The top artists are now final." if reached else ""),
        "artistsLeft": remaining,
        "topCount": top,
        "reachedTop": reached,
    }


# ------------------------------------------------------------------ image upload
def _bucket():
    try:
        return storage.bucket()
    except ValueError:
        project = os.environ.get("GCLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
        return storage.bucket(f"{project}.firebasestorage.app")


def _upload_image(uid: str, req, kind: Optional[str] = None) -> dict:
    file = req.files.get("file")
    if file is None:
        raise ApiError(400, "No image was sent.")
    mime = (file.mimetype or "").lower()
    if mime not in IMAGE_TYPES:
        raise ApiError(400, "Please choose a JPG, PNG or WebP image.")
    data = file.read()
    if not data:
        raise ApiError(400, "The image is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(400, "The image must be 5 MB or smaller.")

    kind = (kind or req.form.get("imageType") or "artist").strip()
    folder = kind if kind in IMAGE_FOLDERS else "artist"
    path = f"{folder}/{uid}/{uuid.uuid4().hex}.{IMAGE_TYPES[mime]}"  # the uid in the path is what the artist check looks for
    download_token = uuid.uuid4().hex

    bucket = _bucket()
    blob = bucket.blob(path)
    blob.metadata = {"firebaseStorageDownloadTokens": download_token}
    blob.upload_from_string(data, content_type=mime)

    url = f"https://firebasestorage.googleapis.com/v0/b/{bucket.name}/o/{quote(path, safe='')}?alt=media&token={download_token}"
    print(f"[API] uploaded {path} ({len(data)} bytes)", flush=True)
    return {"success": True, "downloadURL": url, "storagePath": path}


# ------------------------------------------------------------------ profile page
def _competition_cache():
    cache = {}

    def get(source: str, cid: str):
        key = (source, cid)
        if key not in cache:
            snap = db().collection(source).document(cid).get()
            cache[key] = (snap.to_dict() or {}) if snap.exists else None
        return cache[key]

    return get


def _profile_artist_posts(pid: str, get_comp) -> list:
    out = []

    for snap in db().collection(ARTIST_POST).where(filter=FieldFilter("registeredByUid", "==", pid)).limit(100).stream():
        parts = snap.id.split("_", 2)
        if len(parts) != 3 or parts[0] not in ("posts", JUDGE_FORM):
            continue
        source, cid, artist_id = parts
        comp = get_comp(source, cid)
        if comp is None:
            continue
        d = snap.to_dict() or {}
        when = _as_dt(d.get("registeredAt"))
        out.append({
            "id": snap.id,
            "artistId": artist_id,
            "competitionId": cid,
            "source": source,
            "name": d.get("artistName") or "Unnamed artist",
            "competitionName": comp.get("companyName") or "",
            "images": d.get("images") or [],
            "votingStatus": voting_status(d, comp),
            "eliminated": d.get("isEliminated") is True,
            "type": "artist_post",
            "date": _iso_utc(when) if when else None,
        })

    for snap in db().collection(ACCEPTED).where(filter=FieldFilter("artistId", "==", pid)).limit(100).stream():
        d = snap.to_dict() or {}
        cid = d.get("judgeFormId")
        comp = get_comp(JUDGE_FORM, cid) if cid else None
        if comp is None:
            continue
        when = _as_dt(d.get("acceptedAt"))
        out.append({
            "id": f"{ACCEPTED}:{snap.id}",
            "artistId": pid,
            "competitionId": cid,
            "source": JUDGE_FORM,
            "name": d.get("artistName") or "Unnamed artist",
            "competitionName": comp.get("companyName") or "",
            "images": d.get("images") or [],
            "votingStatus": voting_status(d, comp),
            "eliminated": d.get("isEliminated") is True or d.get("status") == "eliminated",
            "type": "accepted_artist",
            "date": _iso_utc(when) if when else None,
        })

    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out


def _profile_competitions(pid: str, is_self: bool) -> list:
    now = datetime.now(timezone.utc)
    out = []
    for source in ("posts", JUDGE_FORM):
        for snap in db().collection(source).where(filter=FieldFilter("hosterUid", "==", pid)).limit(100).stream():
            d = snap.to_dict() or {}
            status = d.get("status")
            if not is_self and status in HIDDEN_STATES:
                continue
            end = voting_end(d)
            when = _as_dt(d.get("paidAt")) or _as_dt(d.get("submissionTimestamp"))
            out.append({
                "id": snap.id,
                "source": source,
                "name": d.get("companyName") or "Untitled competition",
                "images": d.get("images") or [],
                "type": "post_event" if source == "posts" else "judge_event",
                "votingClosed": bool(end and end <= now),
                "votingClosesAt": _iso_utc(end) if end else None,
                "date": _iso_utc(when) if when else None,
            })
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out


def _profile_votes(pid: str, get_comp) -> list:
    """Every artist this user has paid votes for. The vote count is only revealed once voting has closed."""
    grouped = {}
    query = (
        db().collection(PENDING_VOTES)
        .where(filter=FieldFilter("voterUid", "==", pid))
        .where(filter=FieldFilter("status", "==", "payment_complete"))
    )
    for snap in query.limit(1000).stream():
        d = snap.to_dict() or {}
        key = d.get("artistPostKey") or f"{d.get('source')}_{d.get('competitionId')}_{d.get('artistId')}"
        g = grouped.setdefault(key, {
            "id": key,
            "artistId": d.get("artistId"),
            "competitionId": d.get("competitionId"),
            "source": d.get("source") or "posts",
            "name": d.get("artistName") or "Unknown artist",
            "totalVotes": 0,
            "last": None,
        })
        g["totalVotes"] += int(d.get("voteQuantity") or 0)
        at = _as_dt(d.get("paidAt")) or _as_dt(d.get("createdAt"))
        if at and (g["last"] is None or at > g["last"]):
            g["last"] = at

    post_docs = _batch_docs(ARTIST_POST, [k for k, g in grouped.items() if g["source"] == "posts"])
    judge_docs = _batch_docs(
        ACCEPTED, [f"{g['competitionId']}_{g['artistId']}" for g in grouped.values() if g["source"] == JUDGE_FORM]
    )

    now = datetime.now(timezone.utc)
    out = []
    for key, g in grouped.items():
        art = post_docs.get(key) if g["source"] == "posts" else judge_docs.get(f"{g['competitionId']}_{g['artistId']}")
        comp = get_comp(g["source"], g["competitionId"]) if g["competitionId"] else None
        end = voting_end(comp or {}) or voting_end(art or {})
        closed = bool(end and now >= end)
        out.append({
            "id": key,
            "artistId": g["artistId"],
            "competitionId": g["competitionId"],
            "source": g["source"],
            "name": g["name"],
            "competitionName": (comp or {}).get("companyName") or "",
            "images": (art or {}).get("images") or [],
            "votingClosed": closed,
            "votingClosesAt": _iso_utc(end) if end else None,
            "votingStatus": voting_status(art or {}, comp or {}),
            # the number is only revealed after voting closes
            "totalVotes": g["totalVotes"] if closed else None,
            "lastVotedAt": _iso_utc(g["last"]) if g["last"] else None,
        })
    out.sort(key=lambda x: x["lastVotedAt"] or "", reverse=True)
    return out


def _profile_tickets(pid: str) -> list:
    out = []
    try:
        query = db().collection(TICKET_PURCHASES).where(filter=FieldFilter("buyerUid", "==", pid)).limit(100)
        for snap in query.stream():
            d = snap.to_dict() or {}
            when = _as_dt(d.get("purchasedAt")) or _as_dt(d.get("paidAt")) or _as_dt(d.get("createdAt"))
            out.append({
                "id": snap.id,
                "eventName": _first(d, "eventName", "companyName") or "Event",
                "ticketType": _first(d, "ticketType", "variantName", "variant") or "Ticket",
                "quantityBought": int(d.get("quantityBought") or d.get("quantity") or 0),
                "totalPaid": float(d.get("totalPaid") or d.get("totalAmount") or 0),
                "purchasedAt": _iso_utc(when) if when else None,
                "imageUrl": _first(d, "imageUrl") or None,
            })
    except Exception:
        traceback.print_exc()
    out.sort(key=lambda x: x["purchasedAt"] or "", reverse=True)
    return out


def _profile_get(uid: str, token: dict, target: str) -> dict:
    is_self = target in ("me", uid)
    pid = uid if is_self else target

    snap = db().collection("users").document(pid).get()
    doc = (snap.to_dict() or {}) if snap.exists else None
    if doc is None and not is_self:
        raise ApiError(404, "Profile not found.")
    doc = doc or {}

    own_fallback = (token.get("name") or (token.get("email") or "").split("@")[0]) if is_self else ""
    profile = {
        "uid": pid,
        "name": _person_name(doc, own_fallback) or "User",
        "imageUrl": _first(doc, *IMAGE_KEYS) or (token.get("picture") if is_self else None) or None,
        "bio": str(doc.get("bio") or ""),
        "isSelf": is_self,
    }

    get_comp = _competition_cache()
    lists = {
        "artist_posts": _profile_artist_posts(pid, get_comp),
        "competitions": _profile_competitions(pid, is_self),
        "current_competitions": _profile_votes(pid, get_comp) if is_self else [],
        "ticket_history": _profile_tickets(pid) if is_self else [],
    }
    return {"success": True, "profile": profile, "lists": lists}


def _profile_save_bio(uid: str, body: dict) -> dict:
    bio = str(body.get("bio") or "").strip()
    if len(bio) > MAX_BIO:
        raise ApiError(400, f"Your bio can be at most {MAX_BIO} characters.")
    db().collection("users").document(uid).set(
        {"uid": uid, "bio": bio, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return {"success": True, "bio": bio}


def _profile_save_image(uid: str, req) -> dict:
    uploaded = _upload_image(uid, req, kind="profile")
    url = uploaded["downloadURL"]
    db().collection("users").document(uid).set(
        {"uid": uid, "imageUrl": url, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return {"success": True, "imageUrl": url}


# ------------------------------------------------------------------ voting page + profile pop-ups
def _check_source(source: str) -> str:
    if source not in ("posts", JUDGE_FORM):
        raise ApiError(400, "Unknown competition type.")
    return source


def _artist_voting(uid: str, token: dict, cid: str, artist_id: str, source: str) -> dict:
    _check_source(source)
    artist, comp = find_voting_artist(source, cid, artist_id)
    end = voting_end(comp) or voting_end(artist)
    top10 = top10_end(artist) or top10_end(comp)
    remaining = remaining_artists(cid) if source == JUDGE_FORM else None
    return {
        "success": True,
        "artist": {
            "id": artist_id,
            "competitionId": cid,
            "source": source,
            "artistName": artist.get("artistName") or "Unnamed artist",
            "imageUrl": _first_image(artist),
            "images": artist.get("images") or [],
            "competitionName": comp.get("companyName") or "",
            "votingStatus": voting_status(artist, comp),
            "votingClosingDateTime": _iso_utc(end) if end else None,
            "top10ClosingDateTime": _iso_utc(top10) if top10 else None,
            "pricePerVote": PRICE_PER_VOTE,
            "maxVotes": MAX_VOTES_PER_PURCHASE,
            "canViewVoters": is_owner(uid, token, comp) or uid == artist_id,
            "acceptedId": f"{cid}_{artist_id}" if source == JUDGE_FORM else None,
            "artistsLeft": remaining,
            "topCount": top_count(comp),
            "canEliminate": can_eliminate(uid, token, source, comp, artist, remaining),
        },
    }


def _api_start_vote(uid: str, cid: str, artist_id: str, body: dict) -> dict:
    vote = _validate(VoteBody, {
        "cid": cid,
        "artistId": artist_id,
        "source": body.get("source") or "posts",
        "voteQuantity": body.get("voteQuantity") or body.get("quantity"),
    })
    return _create_vote_payment(uid, vote)


def _competition_overview(uid: str, token: dict, cid: str, source: str) -> dict:
    _check_source(source)
    comp = get_parent(source, cid)
    details = comp.get("judgeFormDetails") or {}
    now = datetime.now(timezone.utc)
    end = voting_end(comp)
    top10 = top10_end(comp)
    closes = artist_closing(comp)
    owner = is_owner(uid, token, comp)
    return {
        "success": True,
        "competition": {
            "id": cid,
            "source": source,
            "name": comp.get("companyName") or "Untitled competition",
            "imageUrl": _first_image(comp),
            "description": comp.get("description") or "",
            "artistPrice": comp.get("artistPrice") or details.get("artistPrice"),
            "artistClosingDateTime": _iso_utc(closes) if closes else None,
            "votingClosingDateTime": _iso_utc(end) if end else None,
            "top10ClosingDateTime": _iso_utc(top10) if top10 else None,
            "topCount": top_count(comp),
            "artistsLeft": remaining_artists(cid) if source == JUDGE_FORM else None,
            "votingClosed": bool(end and end <= now),
            "isOwner": owner,
            "canViewVoters": owner,
        },
    }


def _top_voters(uid: str, token: dict, cid: str, source: str, artist_id: Optional[str] = None) -> dict:
    _check_source(source)
    comp = get_parent(source, cid)
    if not (is_owner(uid, token, comp) or (artist_id and uid == artist_id)):
        raise ApiError(403, "Only the competition owner or the artist can see the top voters.")

    end = voting_end(comp)
    if end and datetime.now(timezone.utc) < end:
        return {"success": True, "locked": True, "message": "Top voters are shown after voting closes."}

    query = (
        db().collection(PENDING_VOTES)
        .where(filter=FieldFilter("competitionId", "==", cid))
        .where(filter=FieldFilter("status", "==", "payment_complete"))
    )
    if artist_id:
        query = query.where(filter=FieldFilter("artistId", "==", artist_id))

    totals = {}
    for snap in query.limit(5000).stream():
        d = snap.to_dict() or {}
        if (d.get("source") or "posts") != source:  # a posts id and a judge-form id can never mix
            continue
        voter = d.get("voterUid") or "unknown"
        totals[voter] = totals.get(voter, 0) + int(d.get("voteQuantity") or 0)

    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:10]
    profiles = _batch_docs("users", [v for v, _ in ranked])
    voters = []
    for i, (voter, count) in enumerate(ranked, start=1):
        p = profiles.get(voter, {})
        voters.append({
            "rank": i,
            "name": _person_name(p, "Anonymous voter"),
            "imageUrl": _first(p, *IMAGE_KEYS) or None,
            "votes": count,
        })

    return {
        "success": True,
        "locked": False,
        "totalVotes": sum(totals.values()),
        "voterCount": len(totals),
        "voters": voters,
    }


# =====================================================================
# Top search bar (Layout.jsx calls this with httpsCallable("searchApp"))
#   in : { q: "text" }          (at least 2 characters)
#   out: { competitions: [{id, source, name, category, location}],
#          artists:      [{id, source, competitionId, competitionName, name}] }
# =====================================================================
SEARCH_MAX_COMPETITIONS = 6
SEARCH_MAX_ARTISTS = 8
SEARCH_SCAN_LIMIT = 500  # documents looked at per collection, per search


@https_fn.on_call()
def searchApp(req: https_fn.CallableRequest) -> dict:
    _auth(req)
    q = str((req.data or {}).get("q") or "").strip().lower()
    if len(q) < 2:
        return {"competitions": [], "artists": []}

    competitions = []
    comp_names = {}  # (source, id) -> name, used for the artist rows
    for source in ("posts", JUDGE_FORM):
        for snap in db().collection(source).limit(200).stream():
            d = snap.to_dict() or {}
            name = d.get("companyName") or d.get("artistName")
            if not name:
                continue
            comp_names[(source, snap.id)] = name
            location = _first(d, "location", "venue") or _first(d.get("judgeFormDetails") or {}, "location", "venue")
            if len(competitions) < SEARCH_MAX_COMPETITIONS and (q in name.lower() or q in location.lower()):
                competitions.append({
                    "id": snap.id,
                    "source": source,
                    "name": name,
                    "category": "Judged competition" if source == JUDGE_FORM else "Hosted competition",
                    "location": location,
                })

    artists = []
    # hosted competitions: every paid artist has an artist-post document (key: posts_<competitionId>_<artistId>)
    for snap in db().collection(ARTIST_POST).limit(SEARCH_SCAN_LIMIT).stream():
        if len(artists) >= SEARCH_MAX_ARTISTS:
            break
        if not snap.id.startswith("posts_"):
            continue
        d = snap.to_dict() or {}
        name = d.get("artistName") or ""
        if q not in name.lower():
            continue
        cid, _, artist_id = snap.id[len("posts_"):].partition("_")
        if not cid or not artist_id:
            continue
        artists.append({
            "id": artist_id,
            "source": "posts",
            "competitionId": cid,
            "competitionName": comp_names.get(("posts", cid), ""),
            "name": name,
        })

    # judged competitions: only accepted artists can be voted for
    for snap in db().collection(ACCEPTED).limit(SEARCH_SCAN_LIMIT).stream():
        if len(artists) >= SEARCH_MAX_ARTISTS:
            break
        d = snap.to_dict() or {}
        name = d.get("artistName") or ""
        cid, artist_id = d.get("judgeFormId"), d.get("artistId")
        if d.get("isEliminated") is True or not cid or not artist_id or q not in name.lower():
            continue
        artists.append({
            "id": artist_id,
            "source": JUDGE_FORM,
            "competitionId": cid,
            "competitionName": comp_names.get((JUDGE_FORM, cid), ""),
            "name": name,
        })

    return {"competitions": competitions, "artists": artists}


# ------------------------------------------------------------------ router
_RE_ARTIST_DETAILS = re.compile(r"^/api/competitions/([^/]+)/artists/([^/]+)$")
_RE_ARTIST_VOTING = re.compile(r"^/api/competitions/([^/]+)/artists/([^/]+)/voting$")
_RE_ARTIST_VOTE = re.compile(r"^/api/competitions/([^/]+)/artists/([^/]+)/vote$")
_RE_ARTIST_VOTERS = re.compile(r"^/api/competitions/([^/]+)/artists/([^/]+)/top-voters$")
_RE_OVERVIEW = re.compile(r"^/api/competitions/([^/]+)/overview$")
_RE_COMP_VOTERS = re.compile(r"^/api/competitions/([^/]+)/top-voters$")
_RE_REGISTER = re.compile(r"^/api/competitions/([^/]+)/register$")
_RE_ELIMINATE = re.compile(r"^/api/accepted-artists/([^/]+)/eliminate$")
_RE_PROFILE = re.compile(r"^/api/profile/([^/]+)$")


@https_fn.on_request(cors=API_CORS)
def api(req: https_fn.Request) -> https_fn.Response:
    try:
        path = (req.path or "/").rstrip("/") or "/"
        method = req.method.upper()
        print(f"[API] {method} {path}", flush=True)

        if path in ("/", "/health", "/api/health"):
            return _json({"ok": True})

        token = _api_user(req)
        uid = token["uid"]
        source = req.args.get("source", "posts")

        # users
        if path == "/api/users/me" and method == "GET":
            return _users_me(uid, token)
        if path == "/api/users/profile" and method in ("POST", "PUT", "PATCH"):
            return _users_profile(uid, token, _body(req))

        # profile page
        if path == "/api/profile/image" and method == "POST":
            return _json(_profile_save_image(uid, req))
        m = _RE_PROFILE.match(path)
        if m and method == "GET":
            return _json(_profile_get(uid, token, m.group(1)))
        if m and m.group(1) == "me" and method in ("PATCH", "PUT", "POST"):
            return _json(_profile_save_bio(uid, _body(req)))

        # competition + artist registration (both return a PayFast paymentUrl)
        if path in ("/api/hoster-registration", "/api/hosted-registration") and method == "POST":
            hoster = _validate(SubmitRequest, _body(req)).hosterData
            return _json(_create_hoster_payment(uid, token, hoster))
        if path == "/api/artist-registration" and method == "POST":
            return _json(_api_artist_registration(uid, token, _body(req)))

        # Artists page
        if path == "/api/artists" and method == "GET":
            return _json(_artists_list(uid, token))
        if path == "/api/competitions" and method == "GET":
            return _json(_open_competitions(uid, token))  # a plain list, as the page expects

        # voting page and the pop-ups on the profile page
        m = _RE_ARTIST_VOTING.match(path)
        if m and method == "GET":
            return _json(_artist_voting(uid, token, m.group(1), m.group(2), source))
        m = _RE_ARTIST_VOTE.match(path)
        if m and method == "POST":
            body = req.get_json(silent=True)
            return _json(_api_start_vote(uid, m.group(1), m.group(2), body if isinstance(body, dict) else {}))
        m = _RE_ARTIST_VOTERS.match(path)
        if m and method == "GET":
            return _json(_top_voters(uid, token, m.group(1), source, m.group(2)))
        m = _RE_OVERVIEW.match(path)
        if m and method == "GET":
            return _json(_competition_overview(uid, token, m.group(1), source))
        m = _RE_COMP_VOTERS.match(path)
        if m and method == "GET":
            return _json(_top_voters(uid, token, m.group(1), source))

        m = _RE_ARTIST_DETAILS.match(path)
        if m and method == "GET":
            return _json(_artist_details(uid, token, m.group(1), m.group(2), source))
        m = _RE_REGISTER.match(path)
        if m and method == "POST":
            return _json(_api_register_from_artists_page(uid, token, m.group(1), _body(req)))
        if path == "/api/uploads/image" and method == "POST":
            return _json(_upload_image(uid, req))
        m = _RE_ELIMINATE.match(path)
        if m and method == "POST":
            return _json(_eliminate_artist(uid, token, m.group(1)))

        # not a known route yet: log what the website sent, so the route can be added
        if method in ("POST", "PUT", "PATCH"):
            body = req.get_json(silent=True)
            keys = sorted(body.keys()) if isinstance(body, dict) else type(body).__name__
            print(f"[API] UNKNOWN {method} {path} body_keys={keys}", flush=True)
        else:
            print(f"[API] UNKNOWN {method} {path} query={dict(req.args)}", flush=True)
        return _fail(404, f"Not found: {method} {path}")
    except ApiError as e:
        return _fail(e.status, e.message)
    except https_fn.HttpsError as e:
        err = _http_error(e)
        print(f"[API] error {err.status}: {err.message}", flush=True)
        return _fail(err.status, err.message)
    except Exception:
        traceback.print_exc()
        return _fail(500, "Server error. Please try again.")