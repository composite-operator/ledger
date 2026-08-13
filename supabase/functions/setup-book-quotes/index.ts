const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const tickerPattern = /^[A-Z0-9.^=_-]{1,16}$/;
const requestWindows = new Map<string, { count: number; expiresAt: number }>();

type Quote = {
  price: number;
  currency: string;
  exchange: string;
  quotedAt: string;
  source: "YAHOO_FINANCE" | "GOOGLE_FINANCE_FALLBACK";
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
      return { price, currency: "USD", exchange, quotedAt: new Date().toISOString(), source: "GOOGLE_FINANCE_FALLBACK" };
    } catch (_error) {
      // Try the next common US exchange code.
    }
  }
  throw new Error("No public quote source returned a usable price.");
}

async function getQuote(ticker: string) {
  try {
    return await quoteFromYahoo(ticker);
  } catch (_error) {
    return await quoteFromGoogle(ticker);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  if (!allowRequest(request)) return json({ error: "rate_limited", message: "Quote refresh limit reached. Try again shortly." }, 429);

  try {
    const payload = await request.json();
    const tickers = [...new Set((Array.isArray(payload?.tickers) ? payload.tickers : [])
      .map((value: unknown) => String(value || "").trim().toUpperCase())
      .filter((value: string) => tickerPattern.test(value)))].slice(0, 40) as string[];
    if (!tickers.length) return json({ error: "invalid_tickers", message: "Send at least one supported ticker." }, 422);

    const settled = await Promise.allSettled(tickers.map(async (ticker) => [ticker, await getQuote(ticker)] as const));
    const quotes: Record<string, Quote> = {};
    const unavailable: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") quotes[result.value[0]] = result.value[1];
      else unavailable.push(tickers[index]);
    });
    return json({ quotes, unavailable, refreshedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return json({ error: "quote_refresh_failed", message: "The setup-book quotes could not be refreshed." }, 500);
  }
});
