import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputRoot = resolve(process.argv[2] || "_site");
const supabaseUrl = "https://pynosegrafnskdlthdcr.supabase.co";
const publishableKey = "sb_publishable_PiqCuSrReoRf9zCl-m0omQ_CT2qNBlO";
const siteUrl = "https://composite-operator.github.io/ledger/";
const socialCardEndpoint = `${supabaseUrl}/functions/v1/social-card`;
const headers = {
  apikey: publishableKey,
  Authorization: `Bearer ${publishableKey}`,
  "Content-Type": "application/json",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeSegment(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(normalized)) throw new Error(`Unsafe share-page segment: ${value}`);
  return normalized;
}

function operatorTarget(handle) {
  const url = new URL(siteUrl);
  url.searchParams.set("profile", handle);
  url.hash = "leaderboard";
  return url.toString();
}

function setupTarget(id, kind) {
  const url = new URL(siteUrl);
  url.searchParams.set(kind, id);
  url.hash = "setups";
  return url.toString();
}

function sharePageUrl(kind, id) {
  return new URL(`share/${kind}/${id}/`, siteUrl).toString();
}

function socialImageUrl(kind, value) {
  const url = new URL(socialCardEndpoint);
  url.searchParams.set("type", kind);
  url.searchParams.set(kind === "operator" ? "handle" : "id", value);
  url.searchParams.set("format", "image");
  url.searchParams.set("v", "discord-link-1");
  return url.toString();
}

function pageHtml({ title, description, shareUrl, targetUrl, imageUrl }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeShareUrl = escapeHtml(shareUrl);
  const safeTargetUrl = escapeHtml(targetUrl);
  const safeImageUrl = escapeHtml(imageUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <link rel="canonical" href="${safeShareUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Composite Operator Ledger">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${safeShareUrl}">
  <meta property="og:image" content="${safeImageUrl}">
  <meta property="og:image:secure_url" content="${safeImageUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${safeTitle}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <meta name="twitter:image" content="${safeImageUrl}">
  <meta http-equiv="refresh" content="0;url=${safeTargetUrl}">
  <style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090d;color:#fff;font:20px/1.6 Arial,sans-serif}.card{max-width:720px;margin:24px;padding:42px;border:1px solid #536b12;border-radius:20px;background:#0f1319;box-shadow:0 30px 90px #000}.card small{color:#baff18;font-weight:800;letter-spacing:.16em}.card h1{font-size:42px;line-height:1.05}.card p{color:#eef2f7}.card a{display:inline-block;margin-top:12px;padding:15px 20px;border-radius:9px;background:#baff18;color:#07090d;font-weight:900;text-decoration:none}</style>
</head>
<body><main class="card"><small>COMPOSITE OPERATOR / LEDGER</small><h1>${safeTitle}</h1><p>${safeDescription}</p><a href="${safeTargetUrl}">Open the public Ledger record →</a></main></body>
</html>`;
}

async function writeSharePage(kind, id, values) {
  const directory = resolve(outputRoot, "share", kind, safeSegment(id));
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), pageHtml(values), "utf8");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json();
}

const operators = await fetchJson(`${supabaseUrl}/rest/v1/rpc/leaderboard_page`, {
  method: "POST",
  body: JSON.stringify({ p_sort: "goat", p_search: "", p_limit: 1000, p_offset: 0 }),
});

for (const operator of operators) {
  const handle = safeSegment(operator.handle);
  const targetUrl = operatorTarget(handle);
  await writeSharePage("operator", handle, {
    title: `@${handle} · Ledger operator record`,
    description: `Inspect @${handle}'s public GOAT score, resolved setups, operator history, and original trade plans.`,
    shareUrl: sharePageUrl("operator", handle),
    targetUrl,
    imageUrl: socialImageUrl("operator", handle),
  });
}

const setups = await fetchJson(`${supabaseUrl}/rest/v1/setups_public?select=id,handle,ticker,status,final_status,r_result,score&limit=5000`);
for (const setup of setups) {
  const id = safeSegment(setup.id);
  const result = Number(setup.r_result ?? setup.score);
  const resolved = Boolean(setup.final_status) || ["RESOLVED", "STOPPED"].includes(String(setup.status || "").toUpperCase());
  if (!resolved || !Number.isFinite(result)) continue;
  const kind = result > 0 ? "victory" : "loss";
  const ticker = String(setup.ticker || "MARKET").toUpperCase();
  const handle = String(setup.handle || "operator").replace(/^@/, "");
  const targetUrl = setupTarget(id, kind);
  await writeSharePage(kind, id, {
    title: `${ticker} ${result > 0 ? "+" : ""}${result.toFixed(2)}R · @${handle}`,
    description: `Inspect the verified ${kind}, original entry, stop, targets, and complete public discussion.`,
    shareUrl: sharePageUrl(kind, id),
    targetUrl,
    imageUrl: socialImageUrl(kind, id),
  });
}

console.log(`Generated ${operators.length} operator share page(s) and resolved setup share pages in ${outputRoot}.`);
