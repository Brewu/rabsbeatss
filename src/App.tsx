import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ApiAvailabilitySlot, type ApiBooking, type ApiNotification, type ApiPack, type ApiTelegramDelivery, type ClientBeatInteraction, type ClientBooking, type ClientOrder, type PushSubscriptionPayload } from "./api";

type Beat = {
  id: number;
  title: string;
  producer: string;
  genre: string;
  mood: string;
  bpm: number;
  key: string;
  price: number;
  cover: string;
  tag?: string;
  tiktokUrl?: string;
  tiktokThumbnailUrl?: string;
};

type Pack = ApiPack;

type BeatCartItem = {
  id: string;
  productType: "beat";
  beat: Beat;
  licenseId: "mp3" | "wav";
  licenseName: string;
  price: number;
};

type PackCartItem = {
  id: string;
  productType: "pack";
  pack: Pack;
  licenseName: string;
  price: number;
};

type CartItem = BeatCartItem | PackCartItem;

const packPrice = 200;
const beatLicenses = [
  { id: "mp3" as const, name: "MP3 Lease", price: 150, description: "Tagged MP3 · Up to 5,000 streams" },
  { id: "wav" as const, name: "WAV Lease", price: 350, description: "WAV + tagged MP3 · Up to 50,000 streams" },
];

const beatGenres = ["Afrobeats", "Afro-fusion", "Amapiano", "Dancehall", "Drill", "Gospel", "Hip-hop", "Pop", "R&B", "Soul", "Trap"];
const beatMoods = ["Aggressive", "Confident", "Dreamy", "Focused", "Hopeful", "Late night", "Melancholic", "Romantic", "Reflective", "Uplifting", "Warm"];
const musicalKeys = [
  "A♭ maj", "A maj", "B♭ maj", "B maj", "C maj", "C♯ maj", "D♭ maj", "D maj", "E♭ maj", "E maj", "F maj", "F♯ maj", "G♭ maj", "G maj",
  "A♭ min", "A min", "B♭ min", "B min", "C min", "C♯ min", "D♭ min", "D min", "E♭ min", "E min", "F min", "F♯ min", "G♭ min", "G min",
];

const sessionSlots = [
  { id: "morning", label: "9:00 AM – 1:00 PM" },
  { id: "afternoon", label: "3:00 PM – 7:00 PM" },
];

const formatCedis = (amount: number | null | undefined) =>
  `GH₵${(Number.isFinite(amount) ? (amount as number) : 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function minimumBookingDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date;
}

function getTikTokVideoId(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(url.hostname.toLowerCase())) return null;
    return url.pathname.match(/^\/@[^/]+\/video\/(\d+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function getMonday(date: Date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return monday;
}

function getWeekdays(monday: Date) {
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return date;
  });
}

const sessionPackages = [
  { name: "Artist Brings Own Beat", price: 300, description: "A 4-hour recording session. You supply the instrumental; the engineer handles tracking and a rough mix." },
  { name: "Custom Beat Making", price: 350, description: "A 4-hour session with a custom beat made to your brief. Beat files are delivered at the end of the session." },
  { name: "Custom Beatmaking + Recording", price: 600, description: "A custom beat produced and your full vocal recording completed in the same 4-hour session." },
  { name: "Song Mixing Session Only", price: 300, description: "Bring your stems or vocals for a 4-hour mixing session. Recording and beatmaking are not included." },
];

const filters = ["All beats", "Afrobeats", "Hip-hop", "R&B", "Trap", "Soul"];
const waveHeights = [15, 23, 34, 18, 30, 43, 22, 38, 17, 28, 46, 26, 34, 17, 41, 24, 32, 19, 44, 27, 35, 18, 29, 42, 22, 34, 16, 39, 25, 32, 19, 45, 28, 36, 20, 31, 43, 24, 33, 17, 40, 26];
const beatInteractionStorageKey = "rabsbeats:beat-interactions";

function readBeatInteractions(): Record<number, number> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(beatInteractionStorageKey) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).flatMap(([id, count]) => {
      const beatId = Number(id);
      return Number.isInteger(beatId) && beatId > 0 && typeof count === "number" && Number.isInteger(count) && count > 0
        ? [[beatId, count]]
        : [];
    }));
  } catch {
    return {};
  }
}

function Icon({ name, size = 18 }: { name: "arrow" | "play" | "pause" | "search" | "plus" | "menu" | "close" | "cart" | "chevron" | "download" | "dots" | "headphones"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths = {
    arrow: <><path d="M5 12h14" /><path d="m13 5 7 7-7 7" /></>,
    play: <path d="m8 5 12 7-12 7V5Z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5h3v14H8z" fill="currentColor" stroke="none" /><path d="M15 5h3v14h-3z" fill="currentColor" stroke="none" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    cart: <><path d="M3 4h2l2.2 11.1a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 1.9-1.5L21 8H6" /><circle cx="10" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    dots: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    headphones: <><path d="M3 13v-1a9 9 0 0 1 18 0v1" /><path d="M5 13h2v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z" /><path d="M19 13h-2v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2Z" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`brand${light ? " brand-light" : ""}`} href="#home" aria-label="RabsBeats home">
      <span className="brand-mark"><span /><span /><span /><span /><span /></span>
      <span className="brand-name">RABS<span>BEATS</span></span>
    </a>
  );
}

function BeatCard({ beat, onPreview, onChooseLicense, onWatchTikTok, playbackKey, playing, isTikTokPlaying }: { beat: Beat; onPreview: (id: number) => void; onChooseLicense: (beat: Beat) => void; onWatchTikTok: (beat: Beat, playbackKey: string) => void; playbackKey: string; playing: boolean; isTikTokPlaying: boolean }) {
  const videoId = getTikTokVideoId(beat.tiktokUrl);
  const togglePreview = () => {
    if (videoId) onWatchTikTok(beat, playbackKey);
    else onPreview(beat.id);
  };
  return (
    <article className="beat-card">
      <div className={`beat-art ${beat.cover}${isTikTokPlaying ? " beat-art-playing-video" : ""}`}>
        {isTikTokPlaying && videoId
          ? <iframe className="beat-tiktok-player" src={`https://www.tiktok.com/player/v1/${videoId}?controls=1&description=0&music_info=0&autoplay=1`} title={`${beat.title} TikTok promo video`} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
          : <>
            <span className="art-index">RB — {String(beat.id).padStart(2, "0")}</span>
            {beat.tiktokThumbnailUrl
              ? <img className="beat-tiktok-thumbnail" src={beat.tiktokThumbnailUrl} alt={`TikTok promo thumbnail for ${beat.title}`} loading="lazy" />
              : <><div className="art-letter">{beat.title.split(" ").map((word) => word[0]).join("")}</div><div className="art-lines" /></>}
            {beat.tag && <span className="beat-tag">{beat.tag}</span>}
            <button className={`preview-button${playing ? " is-playing" : ""}`} onClick={togglePreview} aria-label={`${videoId ? "Play TikTok video for" : playing ? "Pause" : "Play"} ${beat.title} preview`}>
              <Icon name={playing ? "pause" : "play"} size={16} />
            </button>
          </>}
      </div>
      <div className="beat-info">
        <div className="beat-title-row"><div><h3>{beat.title}</h3><span>{beat.producer}</span></div><strong>From GH₵150</strong></div>
        <div className="beat-meta"><span>{beat.genre}</span><span>{beat.bpm} BPM</span><span>{beat.key}</span></div>
        {videoId && <button className="tiktok-preview-button" onClick={() => onWatchTikTok(beat, playbackKey)}><Icon name={isTikTokPlaying ? "pause" : "play"} size={12} /> {isTikTokPlaying ? "Stop TikTok preview" : "Watch TikTok preview"}</button>}
        <button className="beat-select-button" onClick={() => onChooseLicense(beat)}>Choose license <Icon name="arrow" size={14} /></button>
      </div>
    </article>
  );
}

function PackCard({ pack, onAdd }: { pack: Pack; onAdd: (pack: Pack) => void }) {
  const initials = pack.title.split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  return (
    <article className="pack-product-card">
      <div className={`pack-artwork ${pack.cover}`}>
        <div className="pack-artwork-top"><span>RABSBEATS <i> / </i> SOUND LIBRARY</span><span>ZIP · AES</span></div>
        <div className="pack-artwork-orbit pack-orbit-outer" />
        <div className="pack-artwork-orbit pack-orbit-inner" />
        <div className="pack-artwork-disc"><span>{initials}</span></div>
        <div className="pack-artwork-copy"><span>DRUM KIT + SAMPLES</span><strong>{pack.title}</strong></div>
        <div className="pack-waveform" aria-hidden="true">{[14, 25, 18, 38, 29, 48, 21, 34, 52, 28, 43, 19, 37, 24, 46, 30, 18, 39].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
        <span className="pack-artwork-index">RB — 001</span>
      </div>
      <div className="pack-product-info">
        <div className="pack-product-heading"><div><span className="pack-product-kicker">THE PRODUCER TOOLKIT</span><h3>{pack.title}</h3></div><strong>{formatCedis(pack.price)}</strong></div>
        <p>Drum kit and samples, packed together for your next session.</p>
        <div className="pack-product-details"><span><i>01</i> One protected ZIP</span><span><i>02</i> Instant delivery</span></div>
        <button className="pack-add-button" onClick={() => onAdd(pack)}><span>Add pack to cart</span><Icon name="arrow" size={15} /></button>
      </div>
    </article>
  );
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function decodeApplicationServerKey(value: string) {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getSubscriptionPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("The browser returned an incomplete notification subscription.");
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

function AppSetupPrompts() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(() => {
    try {
      return !window.localStorage.getItem("rabsbeats:install-dismissed")
        && !window.matchMedia("(display-mode: standalone)").matches;
    } catch {
      return !window.matchMedia("(display-mode: standalone)").matches;
    }
  });
  const [installHelp, setInstallHelp] = useState(false);
  const [pushStatus, setPushStatus] = useState<"loading" | "available" | "subscribed" | "disabled" | "blocked" | "unsupported">("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");
  const [pushRegistration, setPushRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setShowInstall(false);
      setInstallPrompt(null);
      try { window.localStorage.setItem("rabsbeats:install-dismissed", "1"); } catch { /* Storage is optional. */ }
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    if (window.matchMedia("(display-mode: standalone)").matches) setShowInstall(false);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const initializePush = async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setPushStatus("unsupported");
        return;
      }
      try {
        await navigator.serviceWorker.register("/sw.js");
        const [registration, config] = await Promise.all([
          navigator.serviceWorker.ready,
          api.pushConfig(),
        ]);
        if (!active) return;
        setPushRegistration(registration);
        setPushPublicKey(config.publicKey);
        if (!config.enabled || !config.publicKey) {
          setPushStatus("disabled");
          return;
        }
        if (Notification.permission === "denied") {
          setPushStatus("blocked");
          return;
        }
        const subscription = await registration.pushManager.getSubscription();
        if (!active) return;
        setPushStatus(subscription ? "subscribed" : "available");
      } catch (reason) {
        if (active) {
          setPushStatus("disabled");
          setPushMessage(reason instanceof Error ? reason.message : "Could not prepare beat alerts.");
        }
      }
    };
    void initializePush();
    return () => { active = false; };
  }, []);

  const installApp = async () => {
    setInstallHelp(false);
    if (!installPrompt) {
      setInstallHelp(true);
      return;
    }
    await installPrompt.prompt();
    const result = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (result.outcome === "accepted") {
      setShowInstall(false);
      try { window.localStorage.setItem("rabsbeats:install-dismissed", "1"); } catch { /* Storage is optional. */ }
    }
  };

  const dismissInstall = () => {
    setShowInstall(false);
    try { window.localStorage.setItem("rabsbeats:install-dismissed", "1"); } catch { /* Storage is optional. */ }
  };

  const enablePush = async () => {
    if (!pushRegistration || !pushPublicKey || pushBusy) return;
    setPushBusy(true);
    setPushMessage("");
    let createdSubscription: PushSubscription | null = null;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushStatus(permission === "denied" ? "blocked" : "available");
        setPushMessage(permission === "denied"
          ? "Notifications are blocked. Allow them for this site in your browser settings."
          : "Allow notifications to receive new-beat alerts.");
        return;
      }
      const existing = await pushRegistration.pushManager.getSubscription();
      const subscription = existing ?? await pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(pushPublicKey) as BufferSource,
      });
      if (!existing) createdSubscription = subscription;
      await api.savePushSubscription(getSubscriptionPayload(subscription));
      setPushStatus("subscribed");
      setPushMessage("Beat alerts are on for this device.");
    } catch (reason) {
      if (createdSubscription) await createdSubscription.unsubscribe().catch(() => false);
      setPushMessage(reason instanceof Error ? reason.message : "Could not enable beat alerts.");
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    if (!pushRegistration || pushBusy) return;
    setPushBusy(true);
    setPushMessage("");
    try {
      const subscription = await pushRegistration.pushManager.getSubscription();
      if (subscription) {
        await api.removePushSubscription(getSubscriptionPayload(subscription));
        await subscription.unsubscribe();
      }
      setPushStatus("available");
      setPushMessage("Beat alerts are off for this device.");
    } catch (reason) {
      setPushMessage(reason instanceof Error ? reason.message : "Could not turn off beat alerts.");
    } finally {
      setPushBusy(false);
    }
  };

  return <section className="app-setup-strip" aria-label="RabsBeats app and notification settings">
    {showInstall && <div className="app-setup-card install-setup-card">
      <img src="/icon.svg" alt="" width="42" height="42" />
      <div className="app-setup-copy"><strong>Take RabsBeats with you</strong><span>Save the store to your phone’s home screen like an app.</span>{installHelp && <small>{/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Tap Share, then choose Add to Home Screen." : "Open your browser menu and choose Install app or Add to Home screen."}</small>}</div>
      <button className="setup-action-button" onClick={() => void installApp()}>{installPrompt ? "Add app" : "Add to home screen"}</button>
      <button className="setup-dismiss-button" onClick={dismissInstall} aria-label="Dismiss install suggestion">×</button>
    </div>}
    {pushStatus !== "unsupported" && <div className="app-setup-card push-setup-card">
      <div className="push-setup-mark" aria-hidden="true">♫</div>
      <div className="app-setup-copy"><strong>{pushStatus === "subscribed" ? "Beat alerts are on" : "Get new-beat alerts"}</strong><span>{pushStatus === "loading" ? "Checking this browser’s alert settings…" : pushStatus === "disabled" ? "Notifications are being configured." : pushStatus === "blocked" ? "Allow notifications for this site in your browser settings." : "Opt in to a browser notification when RabsBeats posts a new beat."}</span>{pushMessage && <small role="status">{pushMessage}</small>}</div>
      {pushStatus === "available" && <button className="setup-action-button" onClick={() => void enablePush()} disabled={pushBusy}>{pushBusy ? "Enabling…" : "Enable alerts"}</button>}
      {pushStatus === "subscribed" && <button className="setup-secondary-button" onClick={() => void disablePush()} disabled={pushBusy}>{pushBusy ? "Saving…" : "Turn off"}</button>}
    </div>}
  </section>;
}

type PaymentNextSteps = {
  title: string;
  steps: string[];
};

async function playConfirmationChime() {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) throw new Error("Audio is not supported in this browser.");
  const context = new AudioContextConstructor();
  try {
    await context.resume();
    [659.25, 880].forEach((frequency, index) => {
      const start = context.currentTime + index * 0.18;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.33);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
  } finally {
    await context.close();
  }
}

function Storefront({ beats, packs, onAdmin, onAccount, accountSignedIn, paymentMessage, paymentPending, paymentNextSteps, soundPlayed, soundStatus, onPlaySound }: { beats: Beat[]; packs: Pack[]; onAdmin: () => void; onAccount: () => void; accountSignedIn: boolean; paymentMessage: string; paymentPending: boolean; paymentNextSteps: PaymentNextSteps | null; soundPlayed: boolean; soundStatus: string; onPlaySound: () => void }) {
  const [filter, setFilter] = useState("All beats");
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [packSearch, setPackSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return window.localStorage.getItem("rabsbeats:theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [selectedBeatForLicense, setSelectedBeatForLicense] = useState<Beat | null>(null);
  const [playingTikTokKey, setPlayingTikTokKey] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [bookingPackage, setBookingPackage] = useState("");
  const [bookingDate, setBookingDate] = useState("");
  const [bookingSlot, setBookingSlot] = useState("");
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date(minimumBookingDate())));
  const [bookingFeedback, setBookingFeedback] = useState("");
  const [bookingBusy, setBookingBusy] = useState(false);
  const [availabilitySlots, setAvailabilitySlots] = useState<ApiAvailabilitySlot[]>([]);
  const [availabilityError, setAvailabilityError] = useState("");
  const [browserInteractions, setBrowserInteractions] = useState<Record<number, number>>(readBeatInteractions);
  const [accountInteractions, setAccountInteractions] = useState<Record<number, number>>({});
  const [personalizationNotice, setPersonalizationNotice] = useState("");
  const visibleBeats = useMemo(() => beats.filter((beat) =>
    (filter === "All beats" || beat.genre === filter) &&
    `${beat.title} ${beat.genre} ${beat.mood}`.toLowerCase().includes(search.toLowerCase()),
  ), [beats, filter, search]);
  const visiblePacks = useMemo(() => packs.filter((pack) =>
    pack.title.toLowerCase().includes(packSearch.toLowerCase()),
  ), [packs, packSearch]);

  const trackBeatInteraction = (beatId: number) => {
    const interactionCount = Math.min(Math.max(browserInteractions[beatId] ?? 0, accountInteractions[beatId] ?? 0) + 1, 1000);
    const nextInteractions = { ...browserInteractions, [beatId]: interactionCount };
    setBrowserInteractions(nextInteractions);
    try {
      window.localStorage.setItem(beatInteractionStorageKey, JSON.stringify(nextInteractions));
    } catch {
      setPersonalizationNotice("Personalized suggestions could not be saved in this browser.");
    }
    if (accountSignedIn) {
      api.recordBeatInteraction(beatId, interactionCount)
        .then(({ interaction }) => {
          setAccountInteractions((current) => ({
            ...current,
            [beatId]: Math.max(current[beatId] ?? 0, interaction.interactionCount),
          }));
          setPersonalizationNotice("");
        })
        .catch(() => setPersonalizationNotice("Your recommendations are saved on this browser, but could not sync to your account."));
    }
  };
  const togglePreview = (id: number) => {
    if (playingId !== id) trackBeatInteraction(id);
    setPlayingId((current) => current === id ? null : id);
  };
  const toggleTikTokPreview = (beat: Beat, playbackKey: string) => {
    if (playingTikTokKey !== playbackKey) trackBeatInteraction(beat.id);
    setPlayingTikTokKey((current) => current === playbackKey ? null : playbackKey);
    setPlayingId(null);
  };
  const chooseBeatLicense = (beat: Beat) => {
    trackBeatInteraction(beat.id);
    setSelectedBeatForLicense(beat);
  };
  const closeMenu = () => setMenuOpen(false);
  const openCart = () => {
    setCheckout(false);
    setCartOpen(true);
    setMenuOpen(false);
  };
  const addCartItem = (license: typeof beatLicenses[number]) => {
    if (!selectedBeatForLicense) return;
    setCartItems((current) => [...current, {
      id: `${selectedBeatForLicense.id}-${license.id}-${Date.now()}-${Math.random()}`,
      productType: "beat",
      beat: selectedBeatForLicense,
      licenseId: license.id,
      licenseName: license.name,
      price: license.price,
    }]);
    setSelectedBeatForLicense(null);
    setCartOpen(true);
  };
  const addPackCartItem = (pack: Pack) => {
    setCartItems((current) => [...current, {
      id: `${pack.beatId}-pack-${Date.now()}-${Math.random()}`,
      productType: "pack",
      pack,
      licenseName: "Drum Kit & Samples Pack",
      price: pack.price,
    }]);
    setCartOpen(true);
  };
  const removeCartItem = (id: string) => setCartItems((current) => current.filter((item) => item.id !== id));
  const cartTotal = cartItems.reduce((total, item) => total + item.price, 0);
  const minBookingDate = minimumBookingDate();
  const minBookingDateValue = `${minBookingDate.getFullYear()}-${String(minBookingDate.getMonth() + 1).padStart(2, "0")}-${String(minBookingDate.getDate()).padStart(2, "0")}`;
  const selectedSession = sessionPackages.find((item) => item.name === bookingPackage);
  const weekDays = getWeekdays(weekStart);
  const weekFrom = dateKey(weekStart);
  const weekTo = dateKey(weekDays[4]);
  const bookedSlotsByDate = new Map<string, Set<string>>();
  availabilitySlots.forEach(({ date, timeSlot }) => {
    const slots = bookedSlotsByDate.get(date) ?? new Set<string>();
    slots.add(timeSlot);
    bookedSlotsByDate.set(date, slots);
  });
  const selectedDateSlots = bookingDate ? bookedSlotsByDate.get(bookingDate) ?? new Set<string>() : new Set<string>();
  const interactionCounts = { ...browserInteractions };
  Object.entries(accountInteractions).forEach(([id, count]) => {
    const beatId = Number(id);
    interactionCounts[beatId] = Math.max(interactionCounts[beatId] ?? 0, count);
  });
  const genrePreferences = new Map<string, number>();
  const moodPreferences = new Map<string, number>();
  beats.forEach((beat) => {
    const count = interactionCounts[beat.id] ?? 0;
    if (!count) return;
    genrePreferences.set(beat.genre, (genrePreferences.get(beat.genre) ?? 0) + count);
    moodPreferences.set(beat.mood, (moodPreferences.get(beat.mood) ?? 0) + count);
  });
  const interactedBeatIds = new Set(Object.keys(interactionCounts).filter((id) => interactionCounts[Number(id)] > 0).map(Number));
  const recommendedBeats = beats
    .filter((beat) => !interactedBeatIds.has(beat.id))
    .map((beat) => ({
      beat,
      score: (genrePreferences.get(beat.genre) ?? 0) * 2
        + (moodPreferences.get(beat.mood) ?? 0)
        + beats.reduce((tempoScore, interactedBeat) => tempoScore
          + (interactionCounts[interactedBeat.id] ?? 0) * Math.max(0, 20 - Math.abs(beat.bpm - interactedBeat.bpm)) / 20, 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ beat }) => beat);
  useEffect(() => {
    let active = true;
    api.availability(weekFrom, weekTo)
      .then(({ slots }) => {
        if (active) {
          setAvailabilitySlots(slots);
          setAvailabilityError("");
        }
      })
      .catch((error: unknown) => {
        if (active) setAvailabilityError(error instanceof Error ? error.message : "Could not load studio availability.");
      });
    return () => { active = false; };
  }, [weekFrom, weekTo]);
  useEffect(() => {
    if (!accountSignedIn) {
      setAccountInteractions({});
      return;
    }
    let active = true;
    const syncGuestInteractions = Promise.all(Object.entries(browserInteractions).map(([beatId, interactionCount]) =>
      api.recordBeatInteraction(Number(beatId), interactionCount),
    ));
    Promise.all([api.accountInteractions(), syncGuestInteractions])
      .then(([{ interactions }, syncedInteractions]) => {
        if (active) {
          const counts = Object.fromEntries(interactions.map((interaction) => [interaction.beatId, interaction.interactionCount]));
          syncedInteractions.forEach(({ interaction }) => {
            counts[interaction.beatId] = Math.max(counts[interaction.beatId] ?? 0, interaction.interactionCount);
          });
          setAccountInteractions(counts);
          setPersonalizationNotice("");
        }
      })
      .catch(() => {
        if (active) setPersonalizationNotice("Could not load your saved beat preferences. This browser's recommendations are still available.");
      });
    return () => { active = false; };
  }, [accountSignedIn]);
  const goToPreviousWeek = () => {
    const previous = new Date(weekStart);
    previous.setDate(previous.getDate() - 7);
    if (previous >= getMonday(minBookingDate)) setWeekStart(previous);
  };
  const goToNextWeek = () => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + 7);
    setWeekStart(next);
  };
  const submitBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bookingBusy || !selectedSession || !bookingDate || !bookingSlot) {
      setBookingFeedback("Choose a session package, an available date, and a session time.");
      return;
    }
    if (selectedDateSlots.has(bookingSlot)) {
      setBookingFeedback("That session time has just been booked. Please choose another available time.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    setBookingBusy(true);
    setBookingFeedback("");
    try {
      const { authorizationUrl } = await api.createBooking({
        artistName: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        packageName: selectedSession.name,
        date: bookingDate,
        timeSlot: bookingSlot,
      });
      window.location.assign(authorizationUrl);
    } catch (error) {
      setBookingFeedback(error instanceof Error ? error.message : "Could not start booking payment.");
      try {
        const { slots } = await api.availability(weekFrom, weekTo);
        setAvailabilitySlots(slots);
      } catch {
        setAvailabilityError("Availability could not be refreshed. Reload the page before trying again.");
      }
    } finally {
      setBookingBusy(false);
    }
  };
  const submitCheckout = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checkoutBusy || cartItems.length === 0) return;
    const formData = new FormData(event.currentTarget);
    setCheckoutBusy(true);
    try {
      const { authorizationUrl } = await api.createOrder({
        email: String(formData.get("email") ?? ""),
        items: cartItems.map((item) => item.productType === "beat"
          ? { type: "beat" as const, beatId: item.beat.id, licenseId: item.licenseId }
          : { type: "pack" as const, beatId: item.pack.beatId }),
      });
      window.location.assign(authorizationUrl);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not start checkout.");
      setCheckoutBusy(false);
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem("rabsbeats:theme", theme);
    } catch {
      // Theme selection still applies for this visit if storage is unavailable.
    }
  }, [theme]);
  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  return (
    <div className="storefront-shell" data-theme={theme}>
      <div className="announcement"><span>MADE FOR THE MOMENT.</span> Original sounds for independent artists <a href="#beats">Explore the catalog <Icon name="arrow" size={13} /></a></div>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <nav className={`main-nav${menuOpen ? " nav-open" : ""}`} aria-label="Main navigation">
            <a href="#beats" onClick={closeMenu}>Beats</a>
            <a href="#packs" onClick={closeMenu}>Packs</a>
            <a href="#licenses" onClick={closeMenu}>Licensing</a>
            <a href="#sessions" onClick={closeMenu}>Sessions</a>
            <a href="#about" onClick={closeMenu}>Our sound</a>
            <button className="nav-admin" onClick={() => { closeMenu(); onAccount(); }}>{accountSignedIn ? "My account & orders" : "Client account"}</button>
            <button className="nav-admin" onClick={() => { closeMenu(); onAdmin(); }}>Studio</button>
            <button className="theme-toggle mobile-theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}</button>
            <button className="cart-button mobile-cart" onClick={openCart} aria-label={`Open cart, ${cartItems.length} items`}><Icon name="cart" size={18} /><span>Cart ({cartItems.length})</span></button>
          </nav>
          <div className="header-actions">
            <button className="theme-toggle desktop-theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? "☀" : "☾"}<span>{theme === "dark" ? "Light" : "Dark"}</span></button>
            <button className="client-account-link" onClick={onAccount}>{accountSignedIn ? "My account & orders" : "Account"}</button>
            <button className="cart-button" onClick={openCart} aria-label={`Open cart, ${cartItems.length} items`}><Icon name="cart" size={18} /><span>{cartItems.length}</span></button>
            <a className="button button-dark header-cta" href="#beats">Find your beat <Icon name="arrow" size={15} /></a>
          </div>
          <button className="mobile-menu" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Close menu" : "Open menu"}><Icon name={menuOpen ? "close" : "menu"} /></button>
        </div>
      </header>
      <AppSetupPrompts />

      <main>
        {paymentMessage && <section className={`payment-return-message${paymentNextSteps ? " payment-return-success" : ""}`} role="status" aria-live="polite">
          <div className="payment-return-heading"><span className="payment-return-check" aria-hidden="true">{paymentNextSteps ? "✓" : "i"}</span><div><strong>{paymentNextSteps?.title ?? paymentMessage}</strong>{paymentNextSteps && <p>{paymentMessage}</p>}</div></div>
          {paymentNextSteps && <ol>{paymentNextSteps.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
          {paymentNextSteps && <div className="payment-return-actions">
            {(soundPlayed || soundStatus) && <span className="payment-sound-status" role="status">{soundStatus || "Confirmation sound played."}</span>}
            <button type="button" className="payment-sound-button" onClick={onPlaySound}>{soundPlayed ? "Play sound again" : "Play confirmation sound"}</button>
            <span className="payment-contact">Need help? <a href="mailto:brewurichard95@gmail.com">brewurichard95@gmail.com</a> · <a href="https://wa.me/233537327722" target="_blank" rel="noreferrer">WhatsApp: 0537327722</a></span>
          </div>}
          {paymentPending && <button onClick={() => window.location.reload()}>Check payment status</button>}
        </section>}
        <section className="hero" id="home">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> INDEPENDENT SOUND. NO SHORTCUTS.</div>
            <h1>Make it sound<br />like <em>you.</em></h1>
            <p className="hero-description">Original beats for the ones with something to say. Find the sound that turns a thought into a record.</p>
            <div className="hero-buttons"><a className="button button-lime" href="#beats">Explore beats <Icon name="arrow" size={16} /></a><a className="text-link" href="#about">Meet the studio <span>↗</span></a></div>
            <div className="hero-proof"><div className="avatar-stack"><span>J</span><span>M</span><span>A</span><span>+</span></div><div><strong>For artists building their own lane</strong><small>Independent by design since day one</small></div></div>
          </div>
          <div className="hero-visual" aria-label="Featured beat artwork">
            <div className="hero-grid" />
            <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
            <div className="hero-sleeve">
              <span className="sleeve-label">RABSBEATS<br />ORIGINALS</span>
              <div className="sleeve-title">FIND<br /><i>YOUR</i><br />FREQUENCY</div>
              <span className="sleeve-stamp">INDEPENDENT<br />SOUND</span>
              <div className="sleeve-sun" />
            </div>
            <div className="hero-track-pill"><div className="pill-play"><Icon name="arrow" size={12} /></div><div><small>RABSBEATS</small><strong>Original sound, your way</strong></div><div className="mini-wave">{waveHeights.slice(0, 15).map((height, index) => <i key={index} style={{ height }} />)}</div></div>
            <div className="visual-caption">ORIGINAL SOUND <span>MADE WITH INTENTION</span></div>
          </div>
          <div className="hero-index">RB <span>/</span> STUDIO</div>
        </section>

        <div className="ticker" aria-label="Artist-first licenses, instant downloads, made with intention">
          <div className="ticker-track">{Array.from({ length: 4 }, (_, i) => <span key={i}>ARTIST-FIRST LICENSES <b>✳</b> INSTANT DOWNLOADS <b>✳</b> MADE WITH INTENTION <b>✳</b></span>)}</div>
        </div>

        <section className="catalog section-wrap" id="beats">
          <div className="section-heading">
            <div><span className="section-kicker">01 — THE BEAT CATALOG</span><h2>Find your next <em>something.</em></h2></div>
            <p>Original beats to make<br />your sound your own.</p>
          </div>
          {beats.length > 0 ? <>
            <div className="catalog-tools">
              <div className="filter-list" role="tablist" aria-label="Filter beats by genre">
                {filters.map((item) => <button key={item} className={filter === item ? "filter-active" : ""} onClick={() => setFilter(item)} role="tab" aria-selected={filter === item}>{item}</button>)}
              </div>
              <label className="search-field"><Icon name="search" size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search beats" aria-label="Search beats" /></label>
            </div>
            <div className="beat-grid">
              {visibleBeats.map((beat) => <BeatCard key={beat.id} beat={beat} playbackKey={`catalog-${beat.id}`} onPreview={togglePreview} onChooseLicense={chooseBeatLicense} onWatchTikTok={toggleTikTokPreview} playing={playingId === beat.id} isTikTokPlaying={playingTikTokKey === `catalog-${beat.id}`} />)}
              {visibleBeats.length === 0 && <div className="empty-results">No beats match that search. Try another title or genre.</div>}
            </div>
            <div className="catalog-foot"><span>SHOWING {String(visibleBeats.length).padStart(2, "0")} OF {String(beats.length).padStart(2, "0")} BEATS</span><span>MORE SOUNDS ON THE WAY <i>↗</i></span></div>
            <p className="preview-disclaimer">Preview controls are interface placeholders; connect audio files when wiring up the backend.</p>
          </> : <div className="catalog-empty"><span className="section-kicker">THE NEXT DROP</span><h3>New beats are on the way.</h3><p>The catalog is being updated. Check back soon, or get in touch about an exclusive.</p><a href="mailto:brewurichard95@gmail.com">Contact RabsBeats <Icon name="arrow" size={14} /></a></div>}
        </section>

        <section className="catalog section-wrap" id="packs">
          <div className="section-heading">
            <div><span className="section-kicker">02 — THE PACKS</span><h2>Build your <em>toolkit.</em></h2></div>
            <p>Drum kits and samples<br />together in one protected ZIP.</p>
          </div>
          {packs.length > 0 ? <>
            <div className="catalog-tools pack-catalog-tools">
              <span>One combined drum kit and sample pack · GH₵200 each.</span>
              <label className="search-field"><Icon name="search" size={17} /><input value={packSearch} onChange={(event) => setPackSearch(event.target.value)} placeholder="Search packs" aria-label="Search packs" /></label>
            </div>
            <div className="beat-grid">
              {visiblePacks.map((pack) => <PackCard key={pack.beatId} pack={pack} onAdd={addPackCartItem} />)}
              {visiblePacks.length === 0 && <div className="empty-results">No packs match that search. Try another name.</div>}
            </div>
            <div className="catalog-foot"><span>SHOWING {String(visiblePacks.length).padStart(2, "0")} OF {String(packs.length).padStart(2, "0")} PACKS</span><span>NEW SOUNDS FOR YOUR NEXT SESSION <i>↗</i></span></div>
          </> : <div className="catalog-empty"><span className="section-kicker">THE NEXT DROP</span><h3>Drum kits and samples are on the way.</h3><p>Combined, password-protected ZIP packs will appear here as they are added to the catalog.</p></div>}
        </section>

        {recommendedBeats.length > 0 && <section className="recommendations-section section-wrap">
          <div className="recommendations-heading"><div><span className="section-kicker">PICKED FOR YOU</span><h2>More like your <em>sound.</em></h2></div><p>Based on beats you preview or choose a license for. Your activity helps tune these suggestions.</p></div>
          <div className="beat-grid">{recommendedBeats.map((beat) => <BeatCard key={beat.id} beat={beat} playbackKey={`recommended-${beat.id}`} onPreview={togglePreview} onChooseLicense={chooseBeatLicense} onWatchTikTok={toggleTikTokPreview} playing={playingId === beat.id} isTikTokPlaying={playingTikTokKey === `recommended-${beat.id}`} />)}</div>
          {personalizationNotice && <p className="personalization-notice" role="status">{personalizationNotice}</p>}
        </section>}

        <section className="license-section" id="licenses">
          <div className="license-inner">
            <div className="license-intro"><span className="section-kicker">02 — KEEP IT MOVING</span><h2>Your sound.<br /><em>Your terms.</em></h2><p>Clear, artist-friendly licenses that let you focus on making something real. Choose what fits where you are right now.</p><a className="text-link light-link" href="#beats">Browse all beats <span>↗</span></a></div>
            <div className="license-cards">
              <article className="license-card"><div className="license-top"><span>01 / START HERE</span><span className="license-symbol">↗</span></div><h3>MP3 Lease</h3><p>For demos, socials, and your next independent release.</p><strong className="license-price">GH₵150 <small>GHS / beat</small></strong><ul><li>Tagged MP3 file</li><li>Up to 5,000 streams</li><li>Music video use</li></ul><a href="#beats" className="button button-outline">Explore beats <Icon name="arrow" size={15} /></a></article>
              <article className="license-card license-featured"><div className="license-top"><span>02 / MOST FLEXIBLE</span><span className="license-symbol">✳</span></div><h3>WAV Lease</h3><p>More room to grow. A high-quality file, ready for release.</p><strong className="license-price">GH₵350 <small>GHS / beat</small></strong><ul><li>WAV + tagged MP3</li><li>Up to 50,000 streams</li><li>Radio + video use</li></ul><a href="#beats" className="button button-lime">Find a beat <Icon name="arrow" size={15} /></a></article>
              <article className="license-card"><div className="license-top"><span>03 / YOURS, FULL STOP</span><span className="license-symbol">∞</span></div><h3>Exclusive</h3><p>Make it yours. One artist, one record, unlimited possibilities.</p><strong className="license-price">Let's talk</strong><ul><li>Full trackouts included</li><li>Unlimited distribution</li><li>Beat removed from store</li></ul><a href="mailto:brewurichard95@gmail.com" className="button button-outline">Email about exclusives <Icon name="arrow" size={15} /></a><a href="https://wa.me/233537327722" className="exclusive-whatsapp" target="_blank" rel="noreferrer">Or WhatsApp 0537327722</a></article>
            </div>
            <p className="license-note">License terms shown are example content for this frontend. Final terms will be supplied by the studio.</p>
          </div>
        </section>

        <section className="sessions-section" id="sessions">
          <div className="sessions-inner">
            <div className="sessions-heading">
              <span className="section-kicker">03 — IN THE STUDIO</span>
              <div className="sessions-heading-row"><div><h2>Make something <em>real.</em></h2><p>Book a focused four-hour studio session with RabsBeats. Sessions are available Monday to Friday by advance booking.</p></div><span className="sessions-days">MON — FRI<br /><b>4 HOURS / SESSION</b></span></div>
            </div>
            <div className="session-packages">
              {sessionPackages.map((session, index) => (
                <article className="session-package" key={session.name}>
                  <span className="session-package-index">0{index + 1} / SESSION PACKAGE</span>
                  <h3>{session.name}</h3>
                  <p>{session.description}</p>
                  <strong>{formatCedis(session.price)} <small>GHS / 4-hour session</small></strong>
                  <a className="button button-outline" href="#booking-form" onClick={() => setBookingPackage(session.name)}>Choose package <Icon name="arrow" size={14} /></a>
                </article>
              ))}
            </div>
            <p className="session-pricing-note">Prices cover studio time and the engineer/producer service for the 4-hour block. Mastering is not included.</p>

            <div className="session-details-grid">
              <section className="booking-panel" id="booking-form">
                <span className="section-kicker">REQUEST A SESSION</span>
                <h3>Start with a date.</h3>
                <p>Choose an available weekday and 4-hour slot. A 50% non-refundable deposit is required in advance to reserve the time.</p>
                <form className="booking-form" onSubmit={submitBooking}>
                  <label>Your name<input name="name" autoComplete="name" placeholder="Artist name" required /></label>
                  <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>
                  <label>Session package<select name="package" value={bookingPackage} onChange={(event) => setBookingPackage(event.target.value)} required><option value="" disabled>Choose a package</option>{sessionPackages.map((session) => <option key={session.name} value={session.name}>{session.name} — {formatCedis(session.price)}</option>)}</select></label>
                  <div className="booking-form-row">
                    <fieldset className="availability-calendar">
                      <legend>Choose an available weekday</legend>
                      <div className="calendar-week-heading">
                        <span>{weekStart.toLocaleDateString("en-GH", { month: "long", year: "numeric" })}</span>
                        <div>
                          <button type="button" onClick={goToPreviousWeek} disabled={weekStart <= getMonday(minBookingDate)} aria-label="Previous week">←</button>
                          <button type="button" onClick={goToNextWeek} aria-label="Next week">→</button>
                        </div>
                      </div>
                      <div className="calendar-days">
                        {weekDays.map((date) => {
                          const key = dateKey(date);
                          const bookedCount = bookedSlotsByDate.get(key)?.size ?? 0;
                          const isFullyBooked = bookedCount >= sessionSlots.length;
                          const isTooSoon = key < minBookingDateValue;
                          const isSelected = bookingDate === key;
                          return (
                            <button
                              className={`calendar-day${isSelected ? " calendar-day-selected" : ""}${isFullyBooked ? " calendar-day-booked" : ""}`}
                              type="button"
                              key={key}
                              disabled={isFullyBooked || isTooSoon}
                              onClick={() => { setBookingDate(key); setBookingSlot(""); setBookingFeedback(""); }}
                              aria-pressed={isSelected}
                              aria-label={`${date.toLocaleDateString("en-GH", { weekday: "long", day: "numeric", month: "long" })}${isFullyBooked ? ", fully booked" : bookedCount ? `, ${bookedCount} session slot booked` : isTooSoon ? ", advance booking required" : ", available"}`}
                            >
                              <small>{date.toLocaleDateString("en-GH", { weekday: "short" })}</small>
                              <strong>{date.getDate()}</strong>
                              <i>{isFullyBooked ? "Full" : bookedCount ? "1 slot booked" : isTooSoon ? "Past" : "Open"}</i>
                            </button>
                          );
                        })}
                      </div>
                      <span className="calendar-legend"><i className="legend-open" /> Available <i className="legend-taken" /> Booked session</span>
                      {availabilityError && <span className="calendar-preview-note" role="alert">{availabilityError}</span>}
                      <input type="hidden" name="date" value={bookingDate} />
                    </fieldset>
                    <fieldset className="session-slot-fieldset">
                      <legend>Choose a session time</legend>
                      <p className="slot-instructions">{bookingDate ? "Each session is 4 hours. Booked and temporarily reserved slots are unavailable." : "Select a weekday to see available times."}</p>
                      <div className="booking-slot-list">
                        {sessionSlots.map((slot) => {
                          const isBooked = selectedDateSlots.has(slot.id);
                          const isSelected = bookingSlot === slot.id;
                          return (
                            <button
                              className={`booking-slot${isSelected ? " booking-slot-selected" : ""}${isBooked ? " booking-slot-booked" : ""}`}
                              type="button"
                              key={slot.id}
                              disabled={!bookingDate || isBooked}
                              onClick={() => { setBookingSlot(slot.id); setBookingFeedback(""); }}
                              aria-pressed={isSelected}
                            >
                              <span><strong>{slot.label}</strong><small>4-hour session</small></span>
                              <i>{isBooked ? "Booked" : isSelected ? "Selected" : "Available"}</i>
                            </button>
                          );
                        })}
                      </div>
                      <input type="hidden" name="timeSlot" value={bookingSlot} />
                    </fieldset>
                  </div>
                  {selectedSession && <div className="deposit-summary"><span>Session total <b>{formatCedis(selectedSession.price)}</b></span><span>50% booking deposit <b>{formatCedis(selectedSession.price / 2)}</b></span></div>}
                  <p className="booking-preview-note">Your slot is held for 20 minutes while you complete the deposit payment. Booking confirmation and email are sent after payment is verified.</p>
                  <button className="button button-dark" type="submit" disabled={bookingBusy}>{bookingBusy ? "Starting secure payment…" : "Pay 50% deposit" } <Icon name="arrow" size={15} /></button>
                  {bookingFeedback && <p className="booking-feedback" role="status">{bookingFeedback}</p>}
                </form>
              </section>
              <section className="booking-checklist">
                <span className="section-kicker">BEFORE YOU BOOK</span>
                <h3>Your quick checklist</h3>
                <ol>
                  <li>Choose your session package.</li>
                  <li>Pay the 50% non-refundable deposit to confirm your slot.</li>
                  <li>Send your beat, or a brief for your custom beat.</li>
                  <li>Share 1–2 reference tracks.</li>
                  <li>Confirm clean or explicit, plus your target platform.</li>
                  <li>Arrive on time with your lyrics ready.</li>
                </ol>
                <div className="booking-terms">
                  <h4>Booking terms</h4>
                  <ul>
                    <li>Sessions run Monday–Friday and last 4 hours.</li>
                    <li>Late arrival does not extend the session; the clock starts at the booked time.</li>
                    <li>Reschedule with at least 24 hours’ notice or the deposit is forfeited.</li>
                    <li>Session files are kept for 30 days. Back up your deliverables.</li>
                  </ul>
                </div>
              </section>
            </div>

            <details className="mastering-details">
              <summary><span><span className="section-kicker">DELIVERY GUIDE</span><strong>Song master requirements</strong></span><span className="mastering-summary-note">What to prepare for a release-ready master <Icon name="chevron" size={16} /></span></summary>
              <div className="mastering-content">
                <div><h4>Audio files</h4><ul><li>For mixing, provide stems or multitracks (WAV, 24-bit preferred), not one mixed stereo file.</li><li>For recording, track clean vocals with no clipping or background noise and a consistent mic distance.</li><li>Label files clearly, e.g. <code>Lead_Vox_01.wav</code> and <code>Beat.wav</code>.</li></ul></div>
                <div><h4>Session specs</h4><ul><li>44.1 kHz or 48 kHz sample rate; 24-bit WAV.</li><li>Leave -6 dB headroom on the mix bus before mastering.</li><li>Do not limit the mix submitted for mastering.</li></ul></div>
                <div><h4>References & brief</h4><ul><li>Provide 1–2 reference tracks that match your target sound.</li><li>Specify Spotify, Apple Music, Audiomack, YouTube, or your target platform.</li><li>Confirm whether you need clean and/or explicit versions.</li></ul></div>
                <div><h4>Revisions & delivery</h4><ul><li>Two free revisions per master; additional revisions are billed separately.</li><li>Written final approval by email or WhatsApp is required before file release.</li><li>WAV (24-bit) and MP3 (320 kbps) delivered 48–72 hours after mix approval, unless agreed otherwise.</li><li>Instrumental and acapella versions are available on request.</li></ul></div>
              </div>
              <p className="mastering-exclusion">Mastering is not included in the session package prices above.</p>
            </details>
          </div>
        </section>

        <section className="about-section section-wrap" id="about">
          <div className="about-image"><div className="about-poster"><span>FIELD NOTES / 001</span><div>KEEP<br />THE<br /><i>FEELING.</i></div><small>MADE BY RABSBEATS<br />PLAYED EVERYWHERE</small></div><div className="about-image-label">A LITTLE LESS POLISHED. A LOT MORE YOU.</div></div>
          <div className="about-copy"><span className="section-kicker">03 — THE STUDIO</span><h2>Good music<br />isn't supposed<br />to <em>behave.</em></h2><p>RabsBeats is an independent beat studio making space for the honest, the unexpected, and the still-figuring-it-out. No algorithm to please. No lane to stay in. Just sounds made to go somewhere.</p><a className="text-link" href="mailto:brewurichard95@gmail.com">Say hello <span>↗</span></a><div className="about-signoff">RABSBEATS, ALWAYS.<b>RB®</b></div></div>
        </section>

        <section className="cta-band"><div><span className="section-kicker">YOUR NEXT RECORD STARTS HERE</span><h2>What are you<br /><em>waiting to say?</em></h2></div><a className="button button-lime" href="#beats">Find your sound <Icon name="arrow" size={16} /></a><div className="cta-decoration">RB<br />.</div></section>
      </main>
      <footer className="site-footer"><div className="footer-main"><Brand light /><p>For the ones with something to say.</p><div className="footer-links"><a href="#beats">Beats</a><a href="#packs">Packs</a><a href="#licenses">Licensing</a><a href="#sessions">Sessions</a><a href="#about">About</a><a href="mailto:brewurichard95@gmail.com">Contact</a><a href="https://wa.me/233537327722" target="_blank" rel="noreferrer">WhatsApp</a><button onClick={onAccount}>Client account</button><button onClick={onAdmin}>Studio</button></div><nav className="footer-socials" aria-label="Social media"><a href="https://www.tiktok.com/@rabsbeats" target="_blank" rel="noreferrer">TikTok ↗</a><a href="https://x.com/rabsbeats" target="_blank" rel="noreferrer">X ↗</a><a href="https://www.youtube.com/@rabsbeats" target="_blank" rel="noreferrer">YouTube ↗</a></nav></div><div className="footer-bottom"><span>© 2025 RABSBEATS</span><span>INDEPENDENT SOUND FOR INDEPENDENT ARTISTS</span><a href="#home">BACK TO TOP ↑</a></div></footer>
      {selectedBeatForLicense && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedBeatForLicense(null); }}><section className="store-modal" role="dialog" aria-modal="true" aria-labelledby="license-modal-title"><div className="store-modal-header"><div><span className="section-kicker">CHOOSE A LICENSE</span><h2 id="license-modal-title">{selectedBeatForLicense.title}</h2><p>Select the license that fits your release.</p></div><button className="icon-action" onClick={() => setSelectedBeatForLicense(null)} aria-label="Close"><Icon name="close" /></button></div><div className="license-choice-list">{beatLicenses.map((license) => <button className="license-choice" key={license.id} onClick={() => addCartItem(license)}><span><strong>{license.name}</strong><small>{license.description}</small></span><b>{formatCedis(license.price)}</b><Icon name="arrow" size={15} /></button>)}</div><p className="exclusive-contact">Need an exclusive? <a href="mailto:brewurichard95@gmail.com">Email RabsBeats</a> or <a href="https://wa.me/233537327722" target="_blank" rel="noreferrer">WhatsApp 0537327722</a> to discuss availability.</p></section></div>}
      {cartOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false); }}><section className="store-modal cart-modal" role="dialog" aria-modal="true" aria-labelledby="cart-modal-title"><div className="store-modal-header"><div><span className="section-kicker">{checkout ? "SECURE CHECKOUT" : "YOUR CART"}</span><h2 id="cart-modal-title">{checkout ? "Review your order." : `Your beats (${cartItems.length})`}</h2><p>{checkout ? "Enter your email to receive your order confirmation." : "Choose a license for each beat."}</p></div><button className="icon-action" onClick={() => setCartOpen(false)} aria-label="Close"><Icon name="close" /></button></div>
        {cartItems.length === 0
          ? <div className="cart-empty"><p>Your cart is empty. Find a beat and choose a license to get started.</p><button className="button button-dark" onClick={() => { setCartOpen(false); document.getElementById("beats")?.scrollIntoView({ behavior: "smooth" }); }}>Browse beats <Icon name="arrow" size={14} /></button></div>
          : <>
            <div className="cart-items-list">{cartItems.map((item) => {
              const title = item.productType === "beat" ? item.beat.title : item.pack.title;
              const cover = item.productType === "beat" ? item.beat.cover : item.pack.cover;
              return <article className="cart-item" key={item.id}><span className={`cart-item-art ${cover}`}>{title.slice(0, 1)}</span><div className="cart-item-details"><strong>{title}</strong><span>{item.licenseName}</span></div><b>{formatCedis(item.price)}</b>{!checkout && <button className="remove-cart-item" onClick={() => removeCartItem(item.id)} aria-label={`Remove ${title} from cart`}>Remove</button>}</article>;
            })}</div>
            <div className="cart-total"><span>{checkout ? "Order total" : "Subtotal"}</span><strong>{formatCedis(cartTotal)}</strong></div>
            {checkout
              ? <form className="checkout-form" onSubmit={submitCheckout}><label>Email for your receipt<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label><p>Payment is handled securely by Paystack. Beat files will be arranged by RabsBeats after payment.</p>{checkoutError && <p className="booking-feedback" role="alert">{checkoutError}</p>}<button className="button button-dark" type="submit" disabled={checkoutBusy}>{checkoutBusy ? "Opening Paystack…" : `Pay ${formatCedis(cartTotal)}`} <Icon name="arrow" size={14} /></button><button type="button" className="button button-quiet" onClick={() => { setCheckout(false); setCheckoutError(""); }}>Back to cart</button></form>
              : <div className="cart-actions"><p>Continue to secure checkout to pay with Paystack.</p><button className="button button-dark" onClick={() => { setCheckoutError(""); setCheckout(true); }}>Continue to checkout <Icon name="arrow" size={14} /></button></div>}
          </>}
        </section></div>}
    </div>
  );
}

function Admin({ beats, onBack, onBeatAdded, onCatalogUpdated }: { beats: Beat[]; onBack: () => void; onBeatAdded: (beat: Beat, pack: Pack | null) => void; onCatalogUpdated: (beats: Beat[]) => void }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"Bookings" | "Notifications" | "Catalog">("Bookings");
  const [bookings, setBookings] = useState<ApiBooking[]>([]);
  const [notifications, setNotifications] = useState<ApiNotification[]>([]);
  const [telegramDelivery, setTelegramDelivery] = useState<ApiTelegramDelivery | null>(null);
  const [telegramLinks, setTelegramLinks] = useState<Record<number, string>>({});
  const [tiktokLinks, setTiktokLinks] = useState<Record<number, string>>({});
  const [deliveryPasswords, setDeliveryPasswords] = useState<Record<string, string>>({});
  const [packLinks, setPackLinks] = useState<Record<number, string>>({});
  const [packPasswords, setPackPasswords] = useState<Record<number, string>>({});
  const [deliveryNotice, setDeliveryNotice] = useState("");
  const [newBeat, setNewBeat] = useState({ title: "", genre: "", mood: "", bpm: "100", key: "", telegramUrl: "", tiktokUrl: "", mp3Password: "", wavPassword: "", packIncluded: false, packTelegramUrl: "", packPassword: "" });
  const [integrations, setIntegrations] = useState<{ paymentsEnabled: boolean; emailEnabled: boolean; pushEnabled: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const [bookingResult, notificationResult, health] = await Promise.all([api.adminBookings(), api.adminNotifications(), api.health()]);
      setBookings(bookingResult.bookings);
      setNotifications(notificationResult.notifications);
      setIntegrations(health);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load studio data.");
    }
  };
  const refreshTelegramDelivery = async () => {
    try {
      const delivery = await api.adminDelivery();
      setTelegramDelivery(delivery);
      setTelegramLinks(Object.fromEntries(delivery.beats.map((beat) => [beat.beatId, beat.telegramUrl])));
      setTiktokLinks(Object.fromEntries(delivery.beats.map((beat) => [beat.beatId, beat.tiktokUrl])));
      setPackLinks(Object.fromEntries(delivery.packs.map((pack) => [pack.beatId, pack.telegramUrl])));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Telegram delivery settings.");
    }
  };
  useEffect(() => {
    let active = true;
    api.adminSession()
      .then(({ authenticated: isAuthenticated }) => {
        if (active) setAuthenticated(isAuthenticated);
      })
      .catch((reason: unknown) => {
        if (active) {
          setAuthenticated(false);
          setError(reason instanceof Error ? reason.message : "Could not connect to studio sign-in.");
        }
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (authenticated !== true) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [authenticated]);
  useEffect(() => {
    if (authenticated === true && activeTab === "Catalog") void refreshTelegramDelivery();
  }, [authenticated, activeTab]);

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setError("");
    try {
      await api.login(password);
      setAuthenticated(true);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.");
    } finally {
      setLoginBusy(false);
    }
  };
  const signOut = async () => {
    try {
      await api.logout();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out.");
    } finally {
      setAuthenticated(false);
      setBookings([]);
      setNotifications([]);
      setIntegrations(null);
    }
  };
  const cancelBooking = async (id: string) => {
    setBusy(true);
    try {
      await api.cancelBooking(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not cancel the reservation.");
    } finally {
      setBusy(false);
    }
  };
  const retryNotifications = async () => {
    setBusy(true);
    try {
      await api.retryNotifications();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry notifications.");
    } finally {
      setBusy(false);
    }
  };
  const saveTelegramDelivery = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDeliveryNotice("");
    try {
      const passwords = Object.entries(deliveryPasswords).flatMap(([key, value]) => {
        if (!value) return [];
        const [beatId, licenseId] = key.split(":");
        return [{ beatId: Number(beatId), licenseId: licenseId as "mp3" | "wav", password: value }];
      });
      const deliveryBeats = Object.entries(telegramLinks).map(([beatId, telegramUrl]) => ({
        beatId: Number(beatId),
        telegramUrl: telegramUrl.trim(),
        tiktokUrl: tiktokLinks[Number(beatId)]?.trim() ?? "",
      }));
      const packDelivery = (telegramDelivery?.packs ?? []).map((pack) => ({
        beatId: pack.beatId,
        telegramUrl: packLinks[pack.beatId]?.trim() ?? "",
        password: packPasswords[pack.beatId] ?? "",
      }));
      const delivery = await api.saveAdminDelivery({ beats: deliveryBeats, passwords, packs: packDelivery });
      const failedPasswords = passwords.filter((password) => !delivery.passwords.some((saved) =>
        saved.beatId === password.beatId && saved.licenseId === password.licenseId && saved.configured,
      ));
      if (failedPasswords.length > 0) {
        throw new Error("The server did not confirm every password was saved. Your entries are still in the form; try saving again.");
      }
      const failedPackPasswords = packDelivery.filter((pack) => pack.password
        && !delivery.packPasswords.some((saved) => saved.beatId === pack.beatId && saved.configured));
      if (failedPackPasswords.length > 0) {
        throw new Error("The server did not confirm every pack password was saved. Your entries are still in the form; try saving again.");
      }
      setTelegramDelivery(delivery);
      setTelegramLinks(Object.fromEntries(delivery.beats.map((beat) => [beat.beatId, beat.telegramUrl])));
      setTiktokLinks(Object.fromEntries(delivery.beats.map((beat) => [beat.beatId, beat.tiktokUrl])));
      setPackLinks(Object.fromEntries(delivery.packs.map((pack) => [pack.beatId, pack.telegramUrl])));
      setDeliveryPasswords({});
      setPackPasswords({});
      const deliveryByBeatId = new Map(delivery.beats.map((beat) => [beat.beatId, beat]));
      onCatalogUpdated(beats.map((beat) => {
        const updatedDelivery = deliveryByBeatId.get(beat.id);
        return updatedDelivery
          ? {
            ...beat,
            tiktokUrl: updatedDelivery.tiktokUrl || undefined,
            tiktokThumbnailUrl: updatedDelivery.tiktokThumbnailUrl || undefined,
          }
          : beat;
      }));
      setDeliveryNotice(delivery.beats.some((beat) => beat.tiktokUrl && !beat.tiktokThumbnailUrl)
        ? "Delivery settings saved. TikTok video is saved, but TikTok did not provide its thumbnail yet; try saving again later."
        : "Delivery settings saved. Passwords are stored encrypted and are never returned to the browser.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save Telegram delivery settings.");
    } finally {
      setBusy(false);
    }
  };
  const addBeat = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDeliveryNotice("");
    if (newBeat.mp3Password === newBeat.wavPassword) {
      setError("MP3 and WAV archive passwords must be different.");
      setBusy(false);
      return;
    }
    try {
      const result = await api.addCatalogBeat({
        title: newBeat.title,
        genre: newBeat.genre,
        mood: newBeat.mood,
        bpm: Number(newBeat.bpm),
        key: newBeat.key,
        telegramUrl: newBeat.telegramUrl,
        tiktokUrl: newBeat.tiktokUrl,
        mp3Password: newBeat.mp3Password,
        wavPassword: newBeat.wavPassword,
        packIncluded: newBeat.packIncluded,
        packTelegramUrl: newBeat.packTelegramUrl,
        packPassword: newBeat.packPassword,
      });
      onBeatAdded(result.beat, result.pack);
      setNewBeat({ title: "", genre: "", mood: "", bpm: "100", key: "", telegramUrl: "", tiktokUrl: "", mp3Password: "", wavPassword: "", packIncluded: false, packTelegramUrl: "", packPassword: "" });
      setDeliveryNotice(result.pack
        ? `${result.beat.title} and ${result.pack.title} are live. Their separate delivery links and passwords are saved.`
        : `${result.beat.title} is now in the storefront. Its Telegram link and both license passwords are saved.`);
      await refreshTelegramDelivery();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the beat.");
    } finally {
      setBusy(false);
    }
  };

  if (authenticated !== true) {
    return <main className="admin-login-page">
      <section className="admin-login-card">
        <Brand />
        <span className="section-kicker">OWNER ACCESS</span>
        <h1>Studio sign in</h1>
        <p>Sign in to view bookings and delivery notifications.</p>
        {error && <p className="admin-error" role="alert">{error}</p>}
        {authenticated === null
          ? <p className="admin-login-loading">Checking studio access…</p>
          : <form onSubmit={signIn}>
            <label>Studio password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button className="button button-dark" type="submit" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in"}</button>
          </form>}
        <button className="button button-quiet" onClick={onBack}>Return to storefront</button>
        <small>Owner-only access is enforced by the server, not by hiding this page.</small>
      </section>
    </main>;
  }

  const pendingCount = bookings.filter((booking) => booking.status === "pending_payment").length;
  const pendingNotifications = notifications.filter((notification) => notification.status === "pending").length;
  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand-row"><Brand light /><button onClick={onBack} aria-label="Close studio"><Icon name="close" /></button></div>
      <span className="admin-label">WORKSPACE</span>
      <nav className="admin-nav" aria-label="Studio navigation">
        {(["Bookings", "Notifications", "Catalog"] as const).map((item) => <button key={item} className={activeTab === item ? "admin-nav-active" : ""} onClick={() => setActiveTab(item)}><span className="admin-nav-icon">{item === "Bookings" ? "▣" : item === "Notifications" ? "↗" : "♫"}</span>{item}{item === "Bookings" && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}{item === "Notifications" && pendingNotifications > 0 && <span className="nav-count">{pendingNotifications}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom"><span className="sidebar-avatar">RB</span><div><strong>RabsBeats</strong><small>Studio owner</small></div><button onClick={() => void signOut()} aria-label="Sign out"><Icon name="close" /></button></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div className="admin-breadcrumb">Studio <span>/</span> {activeTab}</div><div className="admin-top-actions"><span className="preview-status"><i /> SERVER CONNECTED</span><button className="view-store" onClick={onBack}>View storefront <Icon name="arrow" size={14} /></button></div></header>
      <div className="admin-content">
        <div className="admin-title-row"><div><div className="section-kicker">RABSBEATS STUDIO</div><h1>{activeTab}</h1><p>{activeTab === "Bookings" ? "Confirmed sessions and outstanding deposit reservations." : activeTab === "Notifications" ? "Email delivery attempts." : "Beat delivery setup and storefront catalog."}</p></div><button className="button button-quiet" onClick={() => { void refresh(); if (activeTab === "Catalog") void refreshTelegramDelivery(); }} disabled={busy}>Refresh</button></div>
        <div className="security-notice"><span>i</span><p><strong>Protected studio data.</strong> Sign-in is checked by the server. Booking slots are confirmed only after verified deposit payment; the browser cannot manually confirm a booking.</p></div>
        {integrations && <div className="integration-status" aria-label="Integration status">
          {[["Paystack payments", integrations.paymentsEnabled], ["Artist email", integrations.emailEnabled], ["New-beat push alerts", integrations.pushEnabled]].map(([label, enabled]) => <span className={enabled ? "integration-ready" : "integration-disabled"} key={String(label)}><i />{String(label)}: {enabled ? "configured" : "not configured"}</span>)}
        </div>}
        {error && <p className="admin-error" role="alert">{error}</p>}
        {activeTab === "Bookings" && <section className="admin-panel session-requests-panel">
          <div className="panel-heading"><div><h2>Studio sessions</h2><p>{pendingCount} awaiting payment · {bookings.filter((booking) => booking.status === "confirmed").length} confirmed</p></div></div>
          {bookings.length === 0
            ? <p className="no-booking-requests">No studio bookings have been recorded.</p>
            : <div className="session-requests-list">{bookings.map((booking) => <article className="session-request-row" key={booking.id}>
              <div className="session-request-main">
                <strong>{booking.artistName} <span className={`booking-status booking-status-${booking.status}`}>{booking.status.replace(/_/g, " ")}</span></strong>
                <span>{booking.packageName} · {formatCedis(booking.depositPesewas / 100)} deposit of {formatCedis(booking.totalPesewas / 100)}</span>
                <small>{new Date(`${booking.date}T12:00:00`).toLocaleDateString("en-GH", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · {sessionSlots.find((slot) => slot.id === booking.timeSlot)?.label ?? booking.timeSlot} · {booking.email}</small>
              </div>
              {booking.status === "pending_payment" && <button className="confirm-booking-button" disabled={busy} onClick={() => void cancelBooking(booking.id)}>Cancel unpaid hold</button>}
            </article>)}</div>}
        </section>}
        {activeTab === "Notifications" && <section className="admin-panel session-requests-panel">
          <div className="panel-heading"><div><h2>Notification outbox</h2><p>Email messages queued after verified payments.</p></div><button className="button button-quiet" onClick={() => void retryNotifications()} disabled={busy}>{busy ? "Retrying…" : "Retry pending"}</button></div>
          {notifications.length === 0
            ? <p className="no-booking-requests">No payment notifications have been queued yet.</p>
            : <div className="session-requests-list">{notifications.map((notification) => <article className="session-request-row" key={notification.id}>
              <div className="session-request-main">
                <strong>Email <span className={`booking-status booking-status-${notification.status}`}>{notification.status}</span></strong>
                <span>{notification.recipient} · {notification.attempts} attempt(s)</span>
                <small>{new Date(`${notification.createdAt.replace(" ", "T")}Z`).toLocaleString("en-GH")}{notification.lastError ? ` · ${notification.lastError}` : ""}</small>
              </div>
            </article>)}</div>}
        </section>}
        {activeTab === "Catalog" && <>
          <section className="admin-panel delivery-settings-panel">
            <div className="panel-heading"><div><h2>Add a beat and optional pack</h2><p>Upload the password-protected archives to Telegram first. Drum kits and samples are sold together in one ZIP; the pack name and GH₵200 price are set automatically.</p></div></div>
            <form className="catalog-beat-form" onSubmit={addBeat}>
              <label>Beat title<input required maxLength={100} value={newBeat.title} onChange={(event) => setNewBeat((current) => ({ ...current, title: event.target.value }))} placeholder="Beat title" /></label>
              <label>Genre<select required value={newBeat.genre} onChange={(event) => setNewBeat((current) => ({ ...current, genre: event.target.value }))}><option value="" disabled>Select a genre</option>{beatGenres.map((genre) => <option key={genre} value={genre}>{genre}</option>)}</select></label>
              <label>Mood<select required value={newBeat.mood} onChange={(event) => setNewBeat((current) => ({ ...current, mood: event.target.value }))}><option value="" disabled>Select a mood</option>{beatMoods.map((mood) => <option key={mood} value={mood}>{mood}</option>)}</select></label>
              <label>BPM<input type="number" required min={40} max={240} step={1} value={newBeat.bpm} onChange={(event) => setNewBeat((current) => ({ ...current, bpm: event.target.value }))} /></label>
              <label>Musical key<select required value={newBeat.key} onChange={(event) => setNewBeat((current) => ({ ...current, key: event.target.value }))}><option value="" disabled>Select a key</option>{musicalKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
              <label className="catalog-beat-link">Telegram link to the beat archive<input type="url" required value={newBeat.telegramUrl} onChange={(event) => setNewBeat((current) => ({ ...current, telegramUrl: event.target.value }))} placeholder="https://t.me/channel/123" /></label>
              <label className="catalog-beat-link">TikTok promo video URL (optional)<input type="url" value={newBeat.tiktokUrl} onChange={(event) => setNewBeat((current) => ({ ...current, tiktokUrl: event.target.value }))} placeholder="https://www.tiktok.com/@username/video/1234567890" /></label>
              <label>Tagged MP3 WinRAR password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newBeat.mp3Password} onChange={(event) => setNewBeat((current) => ({ ...current, mp3Password: event.target.value }))} /></label>
              <label>WAV WinRAR password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newBeat.wavPassword} onChange={(event) => setNewBeat((current) => ({ ...current, wavPassword: event.target.value }))} /></label>
              <div className="catalog-pack-fields">
                <div className="catalog-pack-heading"><div><strong>Add a combined drum kit &amp; samples pack (optional)</strong><small>Both are delivered together as one password-protected ZIP in the Drum Kits &amp; Samples tab.</small></div><b>{formatCedis(packPrice)}</b></div>
                <label className="catalog-pack-toggle"><input type="checkbox" checked={newBeat.packIncluded} onChange={(event) => setNewBeat((current) => ({ ...current, packIncluded: event.target.checked }))} /> Include a combined drum kit and samples ZIP</label>
                {newBeat.packIncluded && <>
                  <p className="catalog-pack-name">Pack listing name: <strong>{newBeat.title.trim() ? `${newBeat.title.trim()} Pack` : "Beat name Pack"}</strong></p>
                  <label className="catalog-beat-link">Telegram link to the password-protected pack ZIP<input type="url" required value={newBeat.packTelegramUrl} onChange={(event) => setNewBeat((current) => ({ ...current, packTelegramUrl: event.target.value }))} placeholder="https://t.me/channel/123" /></label>
                  <label>Pack ZIP WinRAR password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newBeat.packPassword} onChange={(event) => setNewBeat((current) => ({ ...current, packPassword: event.target.value }))} /></label>
                  <p className="catalog-pack-note">Pack password is saved separately from the beat’s MP3 and WAV passwords. Buyers who select the pack receive only its ZIP link and password.</p>
                </>}
              </div>
              <p className="catalog-beat-note">Use the password that protects each exact WinRAR archive. Passwords must be at least 8 characters and the MP3 and WAV passwords must be different.</p>
              <button className="button button-dark" type="submit" disabled={busy}>{busy ? "Adding products…" : newBeat.packIncluded ? "Add beat and pack" : "Add beat and delivery details"}</button>
            </form>
          </section>
          <section className="admin-panel delivery-settings-panel">
            <div className="panel-heading"><div><h2>Edit delivery details</h2><p>Update Telegram links and independent archive passwords for listed beats and packs.</p></div></div>
            <div className="delivery-warning"><strong>Per-beat delivery:</strong> each beat gets its own Telegram file link. Enter the password used to archive that exact MP3 or WAV version. MP3 should be your tagged beat file. MP3 and WAV passwords must be different; any “Must differ” warning needs to be corrected before that beat can be purchased. Buyers receive only the links and passwords for licenses they paid for.</div>
            <form className="delivery-config-form" onSubmit={saveTelegramDelivery}>
              <div className="delivery-password-grid">{beats.map((beat) => <article className="delivery-beat-card" key={beat.id}>
                <div className="delivery-beat-title"><span className={`track-thumb ${beat.cover}`}><span>{beat.title.slice(0, 1)}</span></span><div><strong>{beat.title}</strong><small>{beat.genre} · {beat.bpm} BPM</small></div></div>
                <label className="delivery-channel-field">Telegram link to this beat<input type="url" required={false} value={telegramLinks[beat.id] ?? ""} onChange={(event) => setTelegramLinks((current) => ({ ...current, [beat.id]: event.target.value }))} placeholder="https://t.me/channel/123" /></label>
                <label className="delivery-channel-field">TikTok promo video URL (optional)<input type="url" value={tiktokLinks[beat.id] ?? ""} onChange={(event) => setTiktokLinks((current) => ({ ...current, [beat.id]: event.target.value }))} placeholder="https://www.tiktok.com/@username/video/1234567890" /></label>
                {(["mp3", "wav"] as const).map((licenseId) => {
                  const key = `${beat.id}:${licenseId}`;
                  const status = telegramDelivery?.passwords.find((entry) => entry.beatId === beat.id && entry.licenseId === licenseId);
                  const configured = status?.configured ?? false;
                  const conflicting = status?.conflicting ?? false;
                  return <label className="delivery-password-field" key={licenseId}>{licenseId.toUpperCase()} WinRAR password <span className={conflicting ? "delivery-conflict" : configured ? "delivery-configured" : "delivery-missing"}>{conflicting ? "Must differ" : configured ? "Saved" : "Required"}</span><input type="password" autoComplete="new-password" value={deliveryPasswords[key] ?? ""} onChange={(event) => setDeliveryPasswords((current) => ({ ...current, [key]: event.target.value }))} placeholder={conflicting ? "Enter a different archive password" : configured ? "Leave blank to keep saved password" : "Enter archive password"} minLength={8} maxLength={128} /></label>;
                })}
              </article>)}</div>
              {telegramDelivery?.packs.length ? <div className="delivery-pack-list">
                <h3>Combined drum kit &amp; samples ZIP delivery</h3>
                {telegramDelivery.packs.map((pack) => {
                  const passwordConfigured = telegramDelivery.packPasswords.some((entry) => entry.beatId === pack.beatId && entry.configured);
                  return <article className="delivery-beat-card" key={pack.beatId}>
                    <div className="delivery-beat-title"><span className={`track-thumb ${beats.find((beat) => beat.id === pack.beatId)?.cover ?? "cover-new"}`}><span>{pack.title.slice(0, 1)}</span></span><div><strong>{pack.title}</strong><small>Drum kit &amp; samples · one ZIP · {formatCedis(packPrice)}</small></div></div>
                    <label className="delivery-channel-field">Telegram link to pack ZIP<input type="url" required value={packLinks[pack.beatId] ?? ""} onChange={(event) => setPackLinks((current) => ({ ...current, [pack.beatId]: event.target.value }))} placeholder="https://t.me/channel/123" /></label>
                    <label className="delivery-password-field">Pack ZIP WinRAR password <span className={passwordConfigured ? "delivery-configured" : "delivery-missing"}>{passwordConfigured ? "Saved" : "Required"}</span><input type="password" autoComplete="new-password" value={packPasswords[pack.beatId] ?? ""} onChange={(event) => setPackPasswords((current) => ({ ...current, [pack.beatId]: event.target.value }))} placeholder={passwordConfigured ? "Leave blank to keep saved password" : "Enter pack archive password"} minLength={8} maxLength={128} /></label>
                  </article>;
                })}
              </div> : null}
              {deliveryNotice && <p className="delivery-saved-notice" role="status">{deliveryNotice}</p>}
              <button className="button button-dark" type="submit" disabled={busy || !telegramDelivery}>{busy ? "Saving…" : "Save delivery settings"}</button>
            </form>
            <p className="delivery-security-note">Use WinRAR AES-256 encryption with “Encrypt file names” enabled. The server encrypts saved Telegram links, archive passwords, and notification email bodies using SESSION_SECRET. Keep that secret unchanged and private. Email delivery must be configured before buyers receive links and passwords.</p>
          </section>
          <section className="admin-panel tracks-panel"><div className="panel-heading"><div><h2>Storefront beats</h2><p>Beat licenses and GHS pricing.</p></div></div><div className="tracks-table-wrap"><table className="tracks-table"><thead><tr><th>TRACK</th><th>GENRE</th><th>MP3</th><th>WAV</th></tr></thead><tbody>{beats.map((beat) => <tr key={beat.id}><td><div className="track-cell"><span className={`track-thumb ${beat.cover}`}><span>{beat.title.slice(0, 1)}</span></span><div><strong>{beat.title}</strong><small>{beat.bpm} BPM · {beat.key}</small></div></div></td><td>{beat.genre}</td><td>{formatCedis(150)}</td><td>{formatCedis(350)}</td></tr>)}</tbody></table></div></section>
        </>}
        <div className="admin-footer"><span>RABSBEATS STUDIO</span><span>YOUR STORE, YOUR SOUND.</span></div>
      </div>
    </main>
  </div>;
}

function ClientAccount({ onSignedIn, onSignedOut }: { onSignedIn: () => void; onSignedOut: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [orders, setOrders] = useState<ClientOrder[]>([]);
  const [bookings, setBookings] = useState<ClientBooking[]>([]);
  const [interactions, setInteractions] = useState<ClientBeatInteraction[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const loadHistory = async () => {
      const history = await api.accountHistory();
      if (!active) return;
      setEmail(history.email);
      setOrders(history.orders);
      setBookings(history.bookings);
      setInteractions(history.interactions);
    };
    const load = async () => {
      try {
        const session = await api.accountSession();
        if (!active) return;
        if (session.authenticated) await loadHistory();
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load your account.");
      } finally {
        if (active) setChecking(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const emailAddress = emailInput.trim();
      await (isSigningUp
        ? await api.accountSignup(emailAddress, passwordInput)
        : await api.accountLogin(emailAddress, passwordInput));
      setPasswordInput("");
      onSignedIn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not access your account.");
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await api.accountLogout();
      setEmail(null);
      setOrders([]);
      setBookings([]);
      setInteractions([]);
      setNotice("You are signed out.");
      setError("");
      onSignedOut();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  };

  return <main className="client-account-page">
    <header className="client-account-header"><Brand /><a href="#home">Back to RabsBeats</a></header>
    <section className="client-account-content">
      {checking
        ? <div className="client-account-card"><span className="section-kicker">RABSBEATS ACCOUNT</span><h1>One moment…</h1><p>Checking your account.</p></div>
        : email
          ? <div className="client-account-card">
            <div className="client-account-title"><div><span className="section-kicker">YOUR RABSBEATS ACCOUNT</span><h1>Your music, in one place.</h1><p>Signed in as <strong>{email}</strong></p></div><button className="button button-quiet" onClick={() => void signOut()} disabled={busy}>Sign out</button></div>
            {notice && <p className="account-notice" role="status">{notice}</p>}
            {error && <p className="admin-error" role="alert">{error}</p>}
            <section className="account-history-section"><div className="panel-heading"><div><h2>Beat orders</h2><p>Paid purchases associated with this email address.</p></div></div>
              {orders.length === 0 ? <p className="account-empty">No paid beat orders found for this email yet.</p> : <div className="account-history-list">{orders.map((order) => <article className="account-history-row" key={order.reference}><div><strong>{order.items.map((item) => item.title).join(", ")}</strong><span>{order.items.map((item) => item.licenseName).join(" · ")}</span><small>{new Date(`${order.paidAt ?? order.createdAt}Z`).toLocaleDateString("en-GH", { year: "numeric", month: "short", day: "numeric" })} · Ref {order.reference}</small></div><b>{formatCedis(order.amountPesewas / 100)}</b></article>)}</div>}
            </section>
            <section className="account-history-section"><div className="panel-heading"><div><h2>Studio bookings</h2><p>Deposit and session status.</p></div></div>
              {bookings.length === 0 ? <p className="account-empty">No studio bookings found for this email yet.</p> : <div className="account-history-list">{bookings.map((booking) => <article className="account-history-row" key={booking.reference}><div><strong>{booking.packageName} <span className={`booking-status booking-status-${booking.status}`}>{booking.status.replace(/_/g, " ")}</span></strong><span>{new Date(`${booking.date}T12:00:00`).toLocaleDateString("en-GH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · {sessionSlots.find((slot) => slot.id === booking.timeSlot)?.label}</span><small>Deposit {formatCedis(booking.depositPesewas / 100)} of {formatCedis(booking.totalPesewas / 100)} · Ref {booking.reference}</small></div></article>)}</div>}
            </section>
            <section className="account-history-section"><div className="panel-heading"><div><h2>Beats you explored</h2><p>Recent previews and license selections, used to personalize recommendations.</p></div></div>
              {interactions.length === 0 ? <p className="account-empty">Preview a beat or choose a license to start building your listening history.</p> : <div className="account-history-list">{interactions.map((interaction) => <article className="account-history-row" key={interaction.beatId}><div><strong>{interaction.title}</strong><span>{interaction.genre} · {interaction.mood}</span><small>{interaction.interactionCount} interaction{interaction.interactionCount === 1 ? "" : "s"} · Last explored {new Date(`${interaction.lastInteractedAt.replace(" ", "T")}Z`).toLocaleDateString("en-GH", { year: "numeric", month: "short", day: "numeric" })}</small></div></article>)}</div>}
            </section>
          </div>
          : <div className="client-account-card">
            <span className="section-kicker">CLIENT ACCOUNT</span>
            <h1>Good to have you here.</h1>
            <p>Create an account or sign in with your email and password to view purchases and studio bookings associated with your email.</p>
            {notice && <p className="account-notice" role="status">{notice}</p>}
            {error && <p className="admin-error" role="alert">{error}</p>}
            <form className="account-link-form" onSubmit={submitCredentials}>
              <label>Email address<input type="email" autoComplete="email" value={emailInput} onChange={(event) => setEmailInput(event.target.value)} placeholder="you@example.com" required /></label>
              <label>Password<input type="password" autoComplete={isSigningUp ? "new-password" : "current-password"} value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} minLength={isSigningUp ? 8 : undefined} maxLength={128} required /></label>
              <button className="button button-dark" type="submit" disabled={busy}>{busy ? "Please wait…" : isSigningUp ? "Create account" : "Sign in"} <Icon name="arrow" size={15} /></button>
            </form>
            <button className="account-mode-toggle" onClick={() => { setIsSigningUp((current) => !current); setError(""); setNotice(""); }}>{isSigningUp ? "Already have an account? Sign in" : "New to RabsBeats? Create an account"}</button>
            <small>Use a password of at least 8 characters. Your password is stored as a secure hash.</small>
          </div>}
    </section>
  </main>;
}

export default function App() {
  const [adminOpen, setAdminOpen] = useState(window.location.hash === "#studio");
  const [accountOpen, setAccountOpen] = useState(window.location.hash === "#account");
  const [accountSignedIn, setAccountSignedIn] = useState(false);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentPending, setPaymentPending] = useState(false);
  const [paymentNextSteps, setPaymentNextSteps] = useState<PaymentNextSteps | null>(null);
  const [soundPlayed, setSoundPlayed] = useState(false);
  const [soundStatus, setSoundStatus] = useState("");

  const onPlaySound = () => {
    setSoundStatus("Playing confirmation sound…");
    void playConfirmationChime()
      .then(() => {
        setSoundPlayed(true);
        setSoundStatus("");
      })
      .catch(() => {
        setSoundStatus("Sound could not play. Check your device volume and try again.");
      });
  };

  useEffect(() => {
    const updateRoute = () => {
      setAdminOpen(window.location.hash === "#studio");
      setAccountOpen(window.location.hash === "#account");
    };
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  const refreshCatalog = useCallback(() => {
    return api.catalog()
      .then(({ beats: catalogBeats, packs: catalogPacks }) => {
        setBeats(catalogBeats);
        setPacks(catalogPacks);
        setCatalogError("");
      })
      .catch((error: unknown) => {
        setCatalogError(error instanceof Error ? error.message : "Could not load the beat catalog.");
      });
  }, []);

  // Load on mount, whenever the admin view closes, when the tab regains focus, and every 30s.
  useEffect(() => {
    void refreshCatalog();
    const onVisible = () => { if (document.visibilityState === "visible") void refreshCatalog(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(onVisible, 30000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [refreshCatalog]);

  useEffect(() => {
    if (!adminOpen) void refreshCatalog();
  }, [adminOpen, refreshCatalog]);

  useEffect(() => {
    let active = true;
    api.accountSession()
      .then(({ authenticated }) => {
        if (active) setAccountSignedIn(authenticated);
      })
      .catch(() => {
        if (active) setAccountSignedIn(false);
      });
    return () => { active = false; };
  }, [adminOpen, accountOpen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference");
    if (params.get("payment") !== "return" || !reference) return;
    let active = true;
    api.verifyPayment(reference)
      .then(({ status, type }) => {
        if (!active) return;
        if (status === "confirmed") {
          const nextSteps = {
            title: "Your studio session is confirmed",
            steps: [
              "Check your inbox and spam folder for the confirmation email with your session date and time.",
              "Add the session to your calendar and arrive on time.",
              "Bring your lyrics, beat or stems, and 1–2 reference tracks.",
            ],
          };
          setPaymentNextSteps(nextSteps);
          setPaymentMessage("Your deposit has been verified.");
        } else if (status === "payment_received_review") {
          setPaymentNextSteps({
            title: "Your payment was received",
            steps: ["The selected session time needs a quick review. RabsBeats will email you to confirm the time or arrange next steps."],
          });
          setPaymentMessage("Your payment was received. The studio will contact you shortly to confirm the session details.");
        } else if (status === "paid") {
          setPaymentNextSteps({
            title: "Your beat purchase is confirmed",
            steps: [
              "Check the checkout email inbox (and spam folder) for your receipt and delivery details.",
              "Open each Telegram link in that email to get your purchased beat or pack ZIP.",
              "Use the matching WinRAR password shown for each file; pack passwords are separate from beat license passwords.",
              "If the email does not arrive, contact RabsBeats at brewurichard95@gmail.com or WhatsApp 0537327722.",
            ],
          });
          setPaymentMessage("Payment verified. Your download link and archive password are in the order email.");
        } else {
          setPaymentNextSteps(null);
          setPaymentMessage("Payment is still processing. Your booking or order will update as soon as Paystack confirms it.");
          setPaymentPending(true);
        }
        if (status === "confirmed" || status === "paid") {
          let playSound = true;
          try {
            const soundKey = `rabsbeats:payment-sound:${reference}`;
            if (window.sessionStorage.getItem(soundKey)) playSound = false;
            else window.sessionStorage.setItem(soundKey, "1");
          } catch {
            // Still attempt the sound if this browser blocks session storage.
          }
          if (playSound) {
            void playConfirmationChime()
              .then(() => {
                if (active) setSoundPlayed(true);
              })
              .catch(() => {
                if (active) setSoundStatus("Automatic sound was blocked. Tap “Play confirmation sound” below.");
              });
          }
          try {
            const notifiedKey = `rabsbeats:payment-notified:${reference}`;
            if (!window.sessionStorage.getItem(notifiedKey)) {
              window.sessionStorage.setItem(notifiedKey, "1");
              if ("Notification" in window && Notification.permission === "granted") {
                const title = status === "paid" ? "Beat purchase confirmed" : "Studio session confirmed";
                const body = status === "paid"
                  ? "Check your email for the Telegram link and archive password."
                  : "Check your email for the session details and what to bring.";
                void navigator.serviceWorker?.ready
                  .then((registration) => registration.showNotification(title, { body, icon: "/icon-192.png", data: { url: "/" } }))
                  .catch(() => new Notification(title, { body, icon: "/icon-192.png" }));
              }
            }
          } catch {
            // The on-page confirmation remains available if browser notifications or session storage are unavailable.
          }
        }
        if (status !== "pending" && (type === "booking" || type === "order")) {
          window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setPaymentNextSteps(null);
          setPaymentMessage(error instanceof Error ? error.message : "Could not verify the payment yet. Try again in a moment.");
          setPaymentPending(true);
        }
      });
    return () => { active = false; };
  }, []);

  const openAdmin = () => {
    window.location.hash = "studio";
    setAdminOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const closeAdmin = () => {
    window.location.hash = "home";
    setAdminOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const onClientSignedIn = () => {
    setAccountSignedIn(true);
    setAccountOpen(false);
    window.location.hash = "home";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const onClientSignedOut = () => setAccountSignedIn(false);

  if (adminOpen) return <Admin beats={beats} onBack={closeAdmin} onBeatAdded={(beat, pack) => {
    setBeats((current) => [...current, beat]);
    if (pack) setPacks((current) => [...current, pack]);
  }} onCatalogUpdated={setBeats} />;
  if (accountOpen) return <ClientAccount onSignedIn={onClientSignedIn} onSignedOut={onClientSignedOut} />;
  return <Storefront beats={beats} packs={packs} onAdmin={openAdmin} onAccount={() => { window.location.hash = "account"; setAccountOpen(true); window.scrollTo({ top: 0 }); }} accountSignedIn={accountSignedIn} paymentMessage={paymentMessage || catalogError} paymentPending={paymentPending} paymentNextSteps={paymentNextSteps} soundPlayed={soundPlayed} soundStatus={soundStatus} onPlaySound={onPlaySound} />;
}
