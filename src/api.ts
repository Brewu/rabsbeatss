export type ApiAvailabilitySlot = {
  date: string;
  timeSlot: "morning" | "afternoon";
};

export type ApiBooking = {
  id: string;
  artistName: string;
  email: string;
  packageName: string;
  date: string;
  timeSlot: "morning" | "afternoon";
  totalPesewas: number;
  depositPesewas: number;
  status: "pending_payment" | "confirmed" | "expired" | "cancelled" | "payment_received_review";
  reference: string;
  createdAt: string;
};

export type ApiNotification = {
  id: number;
  channel: "email";
  recipient: string;
  status: "pending" | "sent";
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

export type ApiTelegramDelivery = {
  beats: Array<{ beatId: number; telegramUrl: string; hasLink: boolean; tiktokUrl: string; tiktokThumbnailUrl: string }>;
  passwords: Array<{ beatId: number; licenseId: "mp3" | "wav"; configured: boolean; conflicting: boolean }>;
  packs: Array<{ beatId: number; title: string; telegramUrl: string; configured: boolean }>;
  packPasswords: Array<{ beatId: number; configured: boolean }>;
};

export type ApiPack = {
  beatId: number;
  title: string;
  price: number;
  cover: string;
};

export type PushSubscriptionPayload = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type ApiBeat = {
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

export type ClientOrder = {
  reference: string;
  items: Array<{ title: string; licenseName: string }>;
  amountPesewas: number;
  status: "paid";
  createdAt: string;
  paidAt: string | null;
};

export type ClientBooking = {
  reference: string;
  packageName: string;
  date: string;
  timeSlot: "morning" | "afternoon";
  totalPesewas: number;
  depositPesewas: number;
  status: string;
  createdAt: string;
  paidAt: string | null;
};

export type ClientBeatInteraction = {
  beatId: number;
  title: string;
  genre: string;
  mood: string;
  interactionCount: number;
  lastInteractedAt: string;
};

type ApiError = { error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error("Cannot reach the RabsBeats server. Start the API server and try again.");
  }
  const data = await response.json().catch(() => ({} as T & ApiError));
  if (!response.ok) {
    throw new Error((data as ApiError).error ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; paymentsEnabled: boolean; emailEnabled: boolean; pushEnabled: boolean }>("/health"),
  pushConfig: () => request<{ enabled: boolean; publicKey: string | null }>("/push/config"),
  savePushSubscription: (subscription: PushSubscriptionPayload) =>
    request<{ subscribed: boolean }>("/push/subscriptions", { method: "POST", body: JSON.stringify(subscription) }),
  removePushSubscription: (subscription: PushSubscriptionPayload) =>
    request<{ subscribed: boolean }>("/push/subscriptions", { method: "DELETE", body: JSON.stringify(subscription) }),
  catalog: () => request<{ beats: ApiBeat[]; packs: ApiPack[] }>("/catalog"),
  availability: (from: string, to: string) => request<{ slots: ApiAvailabilitySlot[] }>(`/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createBooking: (payload: { artistName: string; email: string; packageName: string; date: string; timeSlot: string }) =>
    request<{ authorizationUrl: string; reference: string }>("/bookings", { method: "POST", body: JSON.stringify(payload) }),
  createOrder: (payload: { email: string; items: Array<{ type: "beat"; beatId: number; licenseId: "mp3" | "wav" } | { type: "pack"; beatId: number }> }) =>
    request<{ authorizationUrl: string; reference: string }>("/checkout/orders", { method: "POST", body: JSON.stringify(payload) }),
  verifyPayment: (reference: string) =>
    request<{ status: "paid" | "confirmed" | "pending" | "payment_received_review"; type: "order" | "booking" }>(`/payments/verify/${encodeURIComponent(reference)}`),
  login: (password: string) => request<{ authenticated: boolean }>("/admin/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>("/admin/logout", { method: "POST" }),
  adminSession: () => request<{ authenticated: boolean }>("/admin/session"),
  adminBookings: () => request<{ bookings: ApiBooking[] }>("/admin/bookings"),
  adminNotifications: () => request<{ notifications: ApiNotification[] }>("/admin/notifications"),
  adminDelivery: () => request<ApiTelegramDelivery>("/admin/delivery"),
  saveAdminDelivery: (payload: {
    beats: Array<{ beatId: number; telegramUrl: string; tiktokUrl: string }>;
    passwords: Array<{ beatId: number; licenseId: "mp3" | "wav"; password: string }>;
    packs: Array<{ beatId: number; telegramUrl: string; password: string }>;
  }) =>
    request<ApiTelegramDelivery>("/admin/delivery", { method: "PUT", body: JSON.stringify(payload) }),
  addCatalogBeat: ({ packIncluded, ...payload }: {
    title: string;
    genre: string;
    mood: string;
    bpm: number;
    key: string;
    telegramUrl: string;
    tiktokUrl: string;
    mp3Password: string;
    wavPassword: string;
    packIncluded?: boolean;
    packTelegramUrl?: string;
    packPassword?: string;
  }) => request<{ beat: ApiBeat; pack: ApiPack | null }>("/admin/catalog/beats", {
    method: "POST",
    body: JSON.stringify({ ...payload, packCategory: packIncluded ? "drumkit" : "" }),
  }),
  cancelBooking: (id: string) => request<{ cancelled: boolean }>(`/admin/bookings/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  retryNotifications: () => request<{ ok: boolean }>("/admin/notifications/retry", { method: "POST" }),
  accountSignup: (email: string, password: string) => request<{ authenticated: boolean; email: string }>("/account/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  accountLogin: (email: string, password: string) => request<{ authenticated: boolean; email: string }>("/account/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  accountSession: () => request<{ authenticated: boolean; email: string | null }>("/account/session"),
  accountHistory: () => request<{ email: string; orders: ClientOrder[]; bookings: ClientBooking[]; interactions: ClientBeatInteraction[] }>("/account/history"),
  accountInteractions: () => request<{ interactions: ClientBeatInteraction[] }>("/account/interactions"),
  recordBeatInteraction: (beatId: number, interactionCount: number) =>
    request<{ interaction: ClientBeatInteraction }>("/account/interactions", { method: "POST", body: JSON.stringify({ beatId, interactionCount }) }),
  accountLogout: () => request<{ authenticated: boolean }>("/account/logout", { method: "POST" }),
};
