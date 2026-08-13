import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const tolerance = 0.005;
const tickerPattern = /^[A-Z0-9.^=_-]{1,16}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Quote = {
  price: number;
  currency: string;
  exchange: string;
  quotedAt: string;
  source: "YAHOO_FINANCE" | "GOOGLE_FINANCE_FALLBACK";
};

type SetupPayload = {
  client_request_id?: string;
  ticker?: string;
  direction?: string;
  horizon?: string;
  trigger_type?: string;
  entry?: number;
  stop?: number;
  t1?: number;
  t2?: number | null;
  t3?: number | null;
  strategy?: string | null;
  thesis?: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundPrice(value: number) {
  const digits = value >= 1000 ? 4 : value >= 1 ? 6 : 8;
  return Number(value.toFixed(digits));
}

function findApiKey(rawValue: string | undefined, prefix: string) {
  if (!rawValue) return null;
  const pending: unknown[] = [rawValue];
  while (pending.length) {
    const value = pending.shift();
    if (typeof value === "string") {
      if (value.startsWith(prefix)) return value;
      try {
        pending.push(JSON.parse(value));
      } catch (_error) {
        // This string is not the requested key or a JSON container.
      }
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
  return null;
}

async function fetchWithTimeout(url: string, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CompositeOperatorLedger/1.0)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function quoteFromYahoo(ticker: string): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Yahoo returned ${response.status}.`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const price = Number(result?.meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Yahoo returned no usable quote.");
  const epoch = Number(result?.meta?.regularMarketTime);
  return {
    price,
    currency: String(result?.meta?.currency || "USD"),
    exchange: String(result?.meta?.exchangeName || "UNKNOWN"),
    quotedAt: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
    source: "YAHOO_FINANCE",
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function quoteFromGoogle(ticker: string): Promise<Quote> {
  const exchanges = ["NASDAQ", "NYSE", "NYSEARCA", "OTCMKTS", "INDEXSP", "INDEXNASDAQ"];
  const symbol = ticker.replace(/[^A-Z0-9.=_-]/g, "");
  for (const exchange of exchanges) {
    try {
      const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${exchange}`;
      const response = await fetchWithTimeout(url, 5000);
      if (!response.ok) continue;
      const html = await response.text();
      const title = html.match(/<title>(.*?)<\/title>/is)?.[1] || "";
      if (!new RegExp(`\\(${escapeRegExp(symbol)}\\)`, "i").test(title)) continue;
      const priceText = html.match(/\$([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,8})?)/)?.[1];
      const price = Number(String(priceText || "").replaceAll(",", ""));
      if (!Number.isFinite(price) || price <= 0) continue;
      return {
        price,
        currency: "USD",
        exchange,
        quotedAt: new Date().toISOString(),
        source: "GOOGLE_FINANCE_FALLBACK",
      };
    } catch (_error) {
      // Try the next common US exchange code.
    }
  }
  throw new Error("Google Finance returned no usable fallback quote.");
}

async function getVerifiedQuote(ticker: string): Promise<Quote> {
  try {
    return await quoteFromYahoo(ticker);
  } catch (yahooError) {
    try {
      return await quoteFromGoogle(ticker);
    } catch (googleError) {
      throw new Error(`Quote unavailable. ${String(yahooError)} ${String(googleError)}`);
    }
  }
}

function validateGeometry(payload: SetupPayload, effectiveEntry: number) {
  const { direction, stop, t1, t2, t3 } = payload;
  if (!finitePositive(stop) || !finitePositive(t1)) return "Stop loss and T1 must be positive numbers.";
  if (direction === "LONG" && !(stop < effectiveEntry && t1 > effectiveEntry)) {
    return "At the verified market price, a LONG stop must be below entry and T1 must be above entry.";
  }
  if (direction === "SHORT" && !(stop > effectiveEntry && t1 < effectiveEntry)) {
    return "At the verified market price, a SHORT stop must be above entry and T1 must be below entry.";
  }
  const targets = [t1, t2, t3].filter((value): value is number => value != null);
  if (targets.some((value) => !finitePositive(value))) return "Targets must be positive numbers.";
  if (direction === "LONG" && targets.some((value, index) => index > 0 && value <= targets[index - 1])) {
    return "LONG targets must increase from T1 to T3.";
  }
  if (direction === "SHORT" && targets.some((value, index) => index > 0 && value >= targets[index - 1])) {
    return "SHORT targets must decrease from T1 to T3.";
  }
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);

  try {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "authentication_required", message: "Sign in before submitting a market setup." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const publishableKey = findApiKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"), "sb_publishable_")
      || Deno.env.get("SUPABASE_ANON_KEY");
    const secretKey = findApiKey(Deno.env.get("SUPABASE_SECRET_KEYS"), "sb_secret_")
      || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!publishableKey || !secretKey) {
      return json({ error: "server_configuration_error", message: "The verified-market service is not configured." }, 500);
    }
    const authClient = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "invalid_session", message: "Your Ledger session is no longer valid. Sign in again." }, 401);
    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const payload = await request.json() as SetupPayload;
    const ticker = String(payload.ticker || "").trim().toUpperCase();
    const direction = String(payload.direction || "").toUpperCase();
    const horizon = String(payload.horizon || "SWING").toUpperCase();
    const triggerType = String(payload.trigger_type || "").toUpperCase();
    const clientRequestId = String(payload.client_request_id || "");
    const referenceEntry = Number(payload.entry);

    if (!tickerPattern.test(ticker)) return json({ error: "invalid_ticker", message: "Enter a supported ticker with 1-16 characters." }, 422);
    if (!uuidPattern.test(clientRequestId)) return json({ error: "invalid_request_id", message: "The submission ID is invalid. Refresh and try again." }, 422);
    if (!finitePositive(referenceEntry)) return json({ error: "invalid_reference_price", message: "Enter a positive reference price." }, 422);
    if (!['LONG', 'SHORT'].includes(direction)) return json({ error: "invalid_direction", message: "Direction must be LONG or SHORT." }, 422);
    if (!['DAY_TRADE', 'SWING', 'POSITION', 'LONG_TERM'].includes(horizon)) return json({ error: "invalid_horizon", message: "Select a supported time horizon." }, 422);
    if (triggerType !== "MARKET") return json({ error: "market_only", message: "This verified endpoint accepts MARKET setups only." }, 422);
    if (String(payload.strategy || "").length > 80 || String(payload.thesis || "").length > 1200) {
      return json({ error: "text_too_long", message: "Strategy or thesis exceeds the supported length." }, 422);
    }

    const quote = await getVerifiedQuote(ticker);
    const differencePct = Math.abs(referenceEntry - quote.price) / quote.price;
    const minAllowed = roundPrice(quote.price * (1 - tolerance));
    const maxAllowed = roundPrice(quote.price * (1 + tolerance));
    if (differencePct > tolerance) {
      return json({
        error: "price_outside_tolerance",
        message: `${ticker} is ${quote.price.toLocaleString("en-US", { style: "currency", currency: quote.currency })}. Your reference must be within +/-0.5% (${minAllowed}-${maxAllowed}).`,
        quote: { ...quote, tolerancePct: tolerance * 100, differencePct: differencePct * 100, minAllowed, maxAllowed },
      }, 422);
    }

    const geometryError = validateGeometry(payload, quote.price);
    if (geometryError) return json({ error: "invalid_market_geometry", message: geometryError, quote }, 422);

    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("id, account_status")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile || profile.account_status !== "ACTIVE") {
      return json({ error: "inactive_profile", message: "Your Ledger profile is not active." }, 403);
    }

    const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const activatedAt = new Date().toISOString();
    const insertPayload = {
      client_request_id: clientRequestId,
      user_id: userData.user.id,
      ticker,
      direction,
      horizon,
      trigger_type: "MARKET",
      entry: roundPrice(quote.price),
      stop: payload.stop,
      t1: payload.t1,
      t2: payload.t2 ?? null,
      t3: payload.t3 ?? null,
      strategy: String(payload.strategy || "").trim() || null,
      thesis: String(payload.thesis || "").trim() || null,
      status: "ACTIVE",
      current_price: roundPrice(quote.price),
      price_source: quote.source,
      triggered_at: activatedAt,
    };

    let { data: setup, error: insertError } = await admin.from("setups").insert(insertPayload).select().single();
    if (insertError?.code === "23505") {
      const existing = await admin
        .from("setups")
        .select("*")
        .eq("client_request_id", clientRequestId)
        .eq("user_id", userData.user.id)
        .maybeSingle();
      setup = existing.data;
      insertError = existing.error;
    }
    if (insertError || !setup) throw insertError || new Error("The verified setup was not created.");

    const { error: eventError } = await admin.from("setup_events").insert({
      setup_id: setup.id,
      event_type: "MARKET_VERIFIED_AND_ACTIVATED",
      event_at: activatedAt,
      price: roundPrice(quote.price),
      created_by: "EDGE_FUNCTION",
      payload: {
        source: quote.source,
        exchange: quote.exchange,
        currency: quote.currency,
        quoted_at: quote.quotedAt,
        submitted_reference_entry: referenceEntry,
        verified_entry: roundPrice(quote.price),
        difference_pct: differencePct * 100,
        tolerance_pct: tolerance * 100,
      },
    });
    if (eventError) console.error("Market activation event insert failed", eventError);

    return json({
      setup,
      marketValidation: {
        accepted: true,
        referenceEntry,
        verifiedEntry: roundPrice(quote.price),
        differencePct: differencePct * 100,
        tolerancePct: tolerance * 100,
        source: quote.source,
        exchange: quote.exchange,
        currency: quote.currency,
        quotedAt: quote.quotedAt,
      },
    }, 201);
  } catch (error) {
    console.error(error);
    return json({ error: "market_submission_failed", message: error instanceof Error ? error.message : "The market setup could not be verified." }, 500);
  }
});
