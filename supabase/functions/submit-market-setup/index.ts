import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const tolerance = 0.005;
const tickerPattern = /^[A-Z0-9.^=_-]{1,16}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fallbackCryptoSymbols = new Set([
  "BTC", "ETH", "USDT", "BNB", "XRP", "USDC", "SOL", "TRX", "DOGE", "ADA",
  "LINK", "XLM", "BCH", "DAI", "LTC", "AVAX", "SHIB", "DOT", "UNI", "XMR",
  "AAVE", "ETC", "NEAR", "ICP", "FIL", "APT", "SUI", "HBAR", "ATOM", "CRO",
  "ARB", "OP", "PEPE", "TAO", "TON", "LEO", "OKB", "ZEC", "MKR", "INJ",
]);

type AssetClass = "CRYPTO" | "FUTURE" | "INDEX" | "FOREX" | "EQUITY";

type CryptoMarket = {
  price: number;
  name: string;
  quotedAt: string;
};

type QuoteResolution = {
  requestedSymbol: string;
  resolvedSymbol: string;
  assetClass: AssetClass;
  cryptoBaseSymbol: string | null;
};

let cryptoMarketCache = new Map<string, CryptoMarket>();
let cryptoMarketCacheExpiresAt = 0;
let cryptoMarketRequest: Promise<Map<string, CryptoMarket>> | null = null;

type Quote = {
  price: number;
  currency: string;
  exchange: string;
  quotedAt: string;
  source: "YAHOO_FINANCE" | "GOOGLE_FINANCE_FALLBACK" | "COINGECKO_CRYPTO_FALLBACK";
  requestedSymbol: string;
  resolvedSymbol: string;
  assetClass: AssetClass;
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
  entry_expires_at?: string | null;
  management_style?: string | null;
  t1_allocation?: number;
  t2_allocation?: number;
  t3_allocation?: number;
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

async function getTopCryptoMarket() {
  const now = Date.now();
  if (cryptoMarketCacheExpiresAt > now) return cryptoMarketCache;
  if (cryptoMarketRequest) return await cryptoMarketRequest;

  cryptoMarketRequest = (async () => {
    try {
      const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false";
      const response = await fetchWithTimeout(url, 5000);
      if (!response.ok) throw new Error(`CoinGecko returned ${response.status}.`);
      const payload = await response.json();
      const market = new Map<string, CryptoMarket>();
      if (Array.isArray(payload)) {
        payload.forEach((coin) => {
          const symbol = String(coin?.symbol || "").trim().toUpperCase();
          const price = Number(coin?.current_price);
          if (!/^[A-Z0-9_]{2,12}$/.test(symbol) || market.has(symbol)) return;
          market.set(symbol, {
            price: Number.isFinite(price) && price > 0 ? price : Number.NaN,
            name: String(coin?.name || symbol),
            quotedAt: String(coin?.last_updated || new Date().toISOString()),
          });
        });
      }
      cryptoMarketCache = market;
      cryptoMarketCacheExpiresAt = Date.now() + 15 * 60_000;
      return market;
    } catch (error) {
      console.error("Top-100 crypto classification failed", error);
      cryptoMarketCacheExpiresAt = Date.now() + 60_000;
      return cryptoMarketCache;
    } finally {
      cryptoMarketRequest = null;
    }
  })();

  return await cryptoMarketRequest;
}

function classifyExplicitSymbol(symbol: string): AssetClass {
  if (symbol.endsWith("=F")) return "FUTURE";
  if (symbol.endsWith("=X")) return "FOREX";
  if (symbol.startsWith("^")) return "INDEX";
  return "EQUITY";
}

async function resolveQuoteSymbol(ticker: string): Promise<QuoteResolution> {
  const requestedSymbol = ticker.trim().toUpperCase();
  const explicitCrypto = requestedSymbol.match(/^([A-Z0-9_]{2,12})-USD$/);
  if (explicitCrypto) {
    return { requestedSymbol, resolvedSymbol: `${explicitCrypto[1]}-USD`, assetClass: "CRYPTO", cryptoBaseSymbol: explicitCrypto[1] };
  }

  const compactCrypto = requestedSymbol.match(/^([A-Z0-9_]{2,12})USD$/);
  const candidate = compactCrypto?.[1] || (/^[A-Z0-9_]{2,12}$/.test(requestedSymbol) ? requestedSymbol : null);
  if (candidate && fallbackCryptoSymbols.has(candidate)) {
    return { requestedSymbol, resolvedSymbol: `${candidate}-USD`, assetClass: "CRYPTO", cryptoBaseSymbol: candidate };
  }

  const cryptoMarket = candidate ? await getTopCryptoMarket() : cryptoMarketCache;
  if (candidate && cryptoMarket.has(candidate)) {
    return { requestedSymbol, resolvedSymbol: `${candidate}-USD`, assetClass: "CRYPTO", cryptoBaseSymbol: candidate };
  }

  return {
    requestedSymbol,
    resolvedSymbol: requestedSymbol,
    assetClass: classifyExplicitSymbol(requestedSymbol),
    cryptoBaseSymbol: null,
  };
}

async function quoteFromYahoo(resolution: QuoteResolution): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(resolution.resolvedSymbol)}?interval=1m&range=1d`;
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
    requestedSymbol: resolution.requestedSymbol,
    resolvedSymbol: String(result?.meta?.symbol || resolution.resolvedSymbol).toUpperCase(),
    assetClass: resolution.assetClass,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function quoteFromGoogle(resolution: QuoteResolution): Promise<Quote> {
  if (resolution.assetClass === "CRYPTO" && resolution.cryptoBaseSymbol) {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(`${resolution.cryptoBaseSymbol}-USD`)}`;
    const response = await fetchWithTimeout(url, 5000);
    if (response.ok) {
      const html = await response.text();
      const priceText = html.match(/\$([0-9]{1,12}(?:,[0-9]{3})*(?:\.[0-9]{1,10})?)/)?.[1];
      const price = Number(String(priceText || "").replaceAll(",", ""));
      if (Number.isFinite(price) && price > 0) {
        return {
          price,
          currency: "USD",
          exchange: "CRYPTO",
          quotedAt: new Date().toISOString(),
          source: "GOOGLE_FINANCE_FALLBACK",
          requestedSymbol: resolution.requestedSymbol,
          resolvedSymbol: resolution.resolvedSymbol,
          assetClass: resolution.assetClass,
        };
      }
    }
    throw new Error("Google Finance returned no usable crypto fallback quote.");
  }

  const exchanges = ["NASDAQ", "NYSE", "NYSEARCA", "OTCMKTS", "INDEXSP", "INDEXNASDAQ"];
  const symbol = resolution.resolvedSymbol.replace(/[^A-Z0-9.=_-]/g, "");
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
        requestedSymbol: resolution.requestedSymbol,
        resolvedSymbol: resolution.resolvedSymbol,
        assetClass: resolution.assetClass,
      };
    } catch (_error) {
      // Try the next common US exchange code.
    }
  }
  throw new Error("Google Finance returned no usable fallback quote.");
}

async function quoteFromCoinGecko(resolution: QuoteResolution): Promise<Quote> {
  if (!resolution.cryptoBaseSymbol) throw new Error("CoinGecko fallback applies only to crypto symbols.");
  const market = await getTopCryptoMarket();
  const coin = market.get(resolution.cryptoBaseSymbol);
  if (!coin || !Number.isFinite(coin.price) || coin.price <= 0) throw new Error("CoinGecko returned no usable crypto fallback quote.");
  return {
    price: coin.price,
    currency: "USD",
    exchange: "CRYPTO",
    quotedAt: coin.quotedAt,
    source: "COINGECKO_CRYPTO_FALLBACK",
    requestedSymbol: resolution.requestedSymbol,
    resolvedSymbol: resolution.resolvedSymbol,
    assetClass: resolution.assetClass,
  };
}

async function getVerifiedQuote(ticker: string): Promise<Quote> {
  const resolution = await resolveQuoteSymbol(ticker);
  try {
    return await quoteFromYahoo(resolution);
  } catch (yahooError) {
    if (resolution.assetClass === "CRYPTO") {
      try {
        return await quoteFromCoinGecko(resolution);
      } catch (coinGeckoError) {
        try {
          return await quoteFromGoogle(resolution);
        } catch (googleError) {
          throw new Error(`Crypto quote unavailable. ${String(yahooError)} ${String(coinGeckoError)} ${String(googleError)}`);
        }
      }
    }
    try {
      return await quoteFromGoogle(resolution);
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
      ticker: quote.assetClass === "CRYPTO" ? quote.resolvedSymbol : ticker,
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
      entry_expires_at: payload.entry_expires_at ?? null,
      management_style: payload.management_style ?? "SCALE_PROTECT",
      t1_allocation: payload.t1_allocation ?? 1,
      t2_allocation: payload.t2_allocation ?? 0,
      t3_allocation: payload.t3_allocation ?? 0,
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
        requested_symbol: quote.requestedSymbol,
        resolved_symbol: quote.resolvedSymbol,
        asset_class: quote.assetClass,
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
        requestedSymbol: quote.requestedSymbol,
        resolvedSymbol: quote.resolvedSymbol,
        assetClass: quote.assetClass,
        quotedAt: quote.quotedAt,
      },
    }, 201);
  } catch (error) {
    console.error(error);
    return json({ error: "market_submission_failed", message: error instanceof Error ? error.message : "The market setup could not be verified." }, 500);
  }
});
