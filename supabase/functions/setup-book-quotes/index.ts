const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const tickerPattern = /^[A-Z0-9.^=_-]{1,16}$/;
const refreshBatchSize = 24;
const requestWindows = new Map<string, { count: number; expiresAt: number }>();
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

type CachedQuoteRow = {
  ticker: string;
  price: number | string | null;
  currency: string | null;
  exchange: string | null;
  source: Quote["source"] | null;
  requested_symbol: string | null;
  resolved_symbol: string | null;
  asset_class: AssetClass | null;
  quoted_at: string | null;
  refreshed_at: string | null;
  next_refresh_at: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=20" },
  });
}

function allowRequest(request: Request) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const current = requestWindows.get(key);
  if (!current || current.expiresAt <= now) {
    requestWindows.set(key, { count: 1, expiresAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 30;
}

async function callDatabaseRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!projectUrl || !serviceRoleKey) throw new Error("The shared quote cache is not configured.");

  const response = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${name} returned ${response.status}: ${message.slice(0, 500)}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function cleanTickers(values: unknown, limit = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value: unknown) => String(value || "").trim().toUpperCase())
    .filter((value: string) => tickerPattern.test(value)))].slice(0, limit) as string[];
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

  const ticker = resolution.resolvedSymbol;
  const exchanges = ["NASDAQ", "NYSE", "NYSEARCA", "OTCMKTS", "INDEXSP", "INDEXNASDAQ"];
  for (const exchange of exchanges) {
    try {
      const url = `https://www.google.com/finance/quote/${encodeURIComponent(ticker)}:${exchange}`;
      const response = await fetchWithTimeout(url, 5000);
      if (!response.ok) continue;
      const html = await response.text();
      const title = html.match(/<title>(.*?)<\/title>/is)?.[1] || "";
      if (!new RegExp(`\\(${escapeRegExp(ticker)}\\)`, "i").test(title)) continue;
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
  throw new Error("No public quote source returned a usable price.");
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

async function getQuote(ticker: string) {
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  if (!allowRequest(request)) return json({ error: "rate_limited", message: "Quote refresh limit reached. Try again shortly." }, 429);

  try {
    const payload: { tickers?: unknown } = await request.json().catch(() => ({}));
    const preferredTickers = cleanTickers(payload?.tickers);
    const claimedRows = await callDatabaseRpc<Array<{ ticker: string }>>("claim_setup_quote_refreshes", {
      p_preferred: preferredTickers,
      p_limit: refreshBatchSize,
      p_lease_seconds: 45,
    });
    const claimedTickers = cleanTickers((claimedRows || []).map((row) => row.ticker), refreshBatchSize);
    const settled = await Promise.allSettled(claimedTickers.map(async (ticker) => [ticker, await getQuote(ticker)] as const));
    const storedResults: Array<Record<string, unknown>> = [];
    const unavailable: string[] = [];
    settled.forEach((result, index) => {
      const ticker = claimedTickers[index];
      if (result.status === "fulfilled") {
        const quote = result.value[1];
        storedResults.push({
          ticker,
          price: quote.price,
          currency: quote.currency,
          exchange: quote.exchange,
          source: quote.source,
          requested_symbol: quote.requestedSymbol,
          resolved_symbol: quote.resolvedSymbol,
          asset_class: quote.assetClass,
          quoted_at: quote.quotedAt,
          error: null,
        });
      } else {
        unavailable.push(ticker);
        storedResults.push({
          ticker,
          error: String(result.reason || "Quote unavailable.").slice(0, 500),
        });
      }
    });
    if (storedResults.length) {
      await callDatabaseRpc<void>("store_setup_quote_results", { p_results: storedResults });
    }

    const snapshotRows = await callDatabaseRpc<CachedQuoteRow[]>("setup_quote_snapshot", {
      p_tickers: preferredTickers,
    });
    const quotes: Record<string, Quote & { refreshedAt: string | null; nextRefreshAt: string }> = {};
    (snapshotRows || []).forEach((row) => {
      const price = Number(row.price);
      if (!tickerPattern.test(String(row.ticker || "")) || !Number.isFinite(price) || price <= 0 || !row.source) return;
      quotes[row.ticker] = {
        price,
        currency: row.currency || "USD",
        exchange: row.exchange || "UNKNOWN",
        quotedAt: row.quoted_at || row.refreshed_at || new Date().toISOString(),
        source: row.source,
        requestedSymbol: row.requested_symbol || row.ticker,
        resolvedSymbol: row.resolved_symbol || row.ticker,
        assetClass: row.asset_class || "EQUITY",
        refreshedAt: row.refreshed_at,
        nextRefreshAt: row.next_refresh_at,
      };
    });

    return json({
      quotes,
      unavailable,
      refreshedAt: new Date().toISOString(),
      cache: {
        mode: "SHARED_DEMAND_DRIVEN",
        tracked: (snapshotRows || []).length,
        claimed: claimedTickers.length,
        refreshed: storedResults.length - unavailable.length,
      },
    });
  } catch (error) {
    console.error(error);
    return json({ error: "quote_refresh_failed", message: "The setup-book quotes could not be refreshed." }, 500);
  }
});
