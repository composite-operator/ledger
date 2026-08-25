import React from "npm:react@19.0.0";
import { ImageResponse } from "npm:@vercel/og@0.8.5";
import { withSupabase } from "npm:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_URL = "https://composite-operator.github.io/ledger/";
const CACHE_CONTROL = "public, max-age=300, s-maxage=900, stale-while-revalidate=86400";
const SOCIAL_CARD_VERSION = "setup-1";
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,29}$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]{6,80}$/;

type CardKind = "operator" | "setup" | "victory" | "loss";
type CardRecord = {
  kind: CardKind;
  title: string;
  description: string;
  targetUrl: string;
  handle: string;
  rank?: number | null;
  totalOperators?: number | null;
  goatScore?: number | null;
  winRate?: number | null;
  avgR?: number | null;
  totalR?: number | null;
  followers?: number | null;
  ticker?: string | null;
  direction?: string | null;
  horizon?: string | null;
  resultR?: number | null;
  finalStatus?: string | null;
  entry?: number | null;
  stop?: number | null;
  t1?: number | null;
  t2?: number | null;
  t3?: number | null;
  currentPrice?: number | null;
  plannedR?: number | null;
  status?: string | null;
  triggerType?: string | null;
  strategy?: string | null;
  thesisImageUrl?: string | null;
  terminalPrice?: number | null;
  closedAt?: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const PUBLIC_FUNCTION_URL = `${supabaseUrl}/functions/v1/social-card`;
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function formatNumber(value: number | null | undefined, digits = 2, fallback = "NQ") {
  if (value == null || !Number.isFinite(value)) return fallback;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatInteger(value: number | null | undefined, fallback = "0") {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value * 100, 1, "—")}%`;
}

function formatR(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, 2, "—")}R`;
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const digits = absolute > 0 && absolute < 1 ? 6 : absolute < 100 ? 4 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
}

function labelize(value: unknown) {
  return String(value || "").replace(/[_-]+/g, " ").trim().toUpperCase();
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] || character));
}

function initials(handle: string) {
  return handle.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "CO";
}

function operatorTargetUrl(handle: string) {
  const url = new URL(SITE_URL);
  url.searchParams.set("profile", handle);
  url.hash = "leaderboard";
  return url.toString();
}

function setupTargetUrl(id: string, kind: "setup" | "victory" | "loss") {
  const url = new URL(SITE_URL);
  url.searchParams.set(kind === "setup" ? "setup" : kind, id);
  url.hash = "setups";
  return url.toString();
}

const attachmentMarkerPattern = /(?:\r?\n)?\[ledger-image:([0-9a-f-]{36}\/ledger-media\/setups\/[0-9a-f-]{36}\.(?:jpg|png|webp))\]$/i;

function publicStorageUrl(objectPath: string | null) {
  if (!objectPath || !supabaseUrl) return null;
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/public/avatars/${encodedPath}`;
}

function thesisImageUrl(value: unknown) {
  const match = String(value || "").match(attachmentMarkerPattern);
  return publicStorageUrl(match?.[1] || null);
}

function targetR(direction: string, entry: number | null, stop: number | null, target: number | null) {
  if (entry == null || stop == null || target == null || entry === stop) return null;
  const reward = direction === "SHORT" ? entry - target : target - entry;
  return reward / Math.abs(entry - stop);
}

function setupPlannedR(setup: Record<string, unknown>, direction: string, entry: number | null, stop: number | null) {
  const targets = [priceOrNull(setup.t1), priceOrNull(setup.t2), priceOrNull(setup.t3)];
  const allocations = [numberOrNull(setup.t1_allocation), numberOrNull(setup.t2_allocation), numberOrNull(setup.t3_allocation)];
  const allocationTotal = allocations.reduce((sum: number, value) => sum + (value || 0), 0);
  if (allocationTotal >= .99 && allocationTotal <= 1.01) {
    return targets.reduce((sum: number, target, index) => {
      const result = targetR(direction, entry, stop, target);
      return sum + (result == null ? 0 : result * (allocations[index] || 0));
    }, 0);
  }
  return targetR(direction, entry, stop, targets[0]);
}

async function loadOperator(handle: string): Promise<CardRecord> {
  const normalized = handle.replace(/^@/, "").trim().toLowerCase();
  if (!HANDLE_PATTERN.test(normalized)) throw new Response("Invalid public handle.", { status: 400 });

  const profileResult = await supabase
    .from("profiles")
    .select("id, handle, avatar_url, bio, is_public, created_at")
    .eq("handle", normalized)
    .eq("is_public", true)
    .maybeSingle();

  if (profileResult.error) throw new Response("The public profile could not be read.", { status: 502 });
  if (!profileResult.data) throw new Response("Public operator not found.", { status: 404 });

  const profile = profileResult.data;
  const [leaderboardResult, socialResult] = await Promise.all([
    supabase.rpc("leaderboard_page", { p_sort: "goat", p_search: normalized, p_limit: 10, p_offset: 0 }),
    supabase.rpc("operator_social_summary", { p_profile_id: profile.id }),
  ]);
  const metric = (leaderboardResult.data || []).find((row: Record<string, unknown>) => String(row.profile_id || row.id) === String(profile.id)) || {};
  const social = socialResult.data?.[0] || {};
  const combined = { ...metric, ...social } as Record<string, unknown>;
  const rank = numberOrNull(combined.rank_position);
  const totalOperators = numberOrNull(combined.total_count);
  const goatScore = numberOrNull(combined.goat_score);
  const winRate = numberOrNull(combined.win_rate);
  const avgR = numberOrNull(combined.avg_r);
  const totalR = numberOrNull(combined.total_score);
  const followers = numberOrNull(combined.follower_count);
  const standing = rank ? `Global rank #${formatInteger(rank)}. ` : "";
  return {
    kind: "operator",
    title: `@${normalized} · Composite Operator Ledger`,
    description: `${standing}GOAT ${formatNumber(goatScore, 2)} · ${formatPercent(winRate)} win rate · ${formatR(avgR)} average. Public market record.`,
    targetUrl: operatorTargetUrl(normalized),
    handle: normalized,
    rank,
    totalOperators,
    goatScore,
    winRate,
    avgR,
    totalR,
    followers,
  };
}

function resolvedStatus(value: unknown) {
  return ["STOPPED", "CLOSED", "ARCHIVED", "RESOLVED", "T1", "T2", "T3", "T1 HIT", "T2 HIT", "T3 HIT", "T1_HIT", "T2_HIT", "T3_HIT"].includes(labelize(value));
}

async function loadOutcome(id: string, kind: "victory" | "loss"): Promise<CardRecord> {
  if (!ID_PATTERN.test(id)) throw new Response("Invalid setup identifier.", { status: 400 });
  const result = await supabase.from("setups_public").select("*").eq("id", id).maybeSingle();
  if (result.error) throw new Response("The public outcome could not be read.", { status: 502 });
  if (!result.data) throw new Response("Public outcome not found.", { status: 404 });

  const setup = result.data as Record<string, unknown>;
  const resultR = numberOrNull(setup.r_result ?? setup.score);
  const finalStatus = labelize(setup.final_status || setup.status || (kind === "victory" ? "WIN" : "LOSS"));
  const isResolved = resolvedStatus(setup.status) || Boolean(setup.final_status);
  const validVictory = isResolved && resultR != null && resultR > 0 && !["STOPPED", "CANCELLED", "EXPIRED"].includes(finalStatus);
  const validLoss = isResolved && resultR != null && resultR < 0 && !["CANCELLED", "EXPIRED", "VOID", "TECHNICAL VOID"].includes(finalStatus);
  if ((kind === "victory" && !validVictory) || (kind === "loss" && !validLoss)) {
    throw new Response(`This setup does not have a public ${kind} result.`, { status: 404 });
  }

  const handle = String(setup.handle || setup.profile_handle || "operator").replace(/^@/, "").toLowerCase();
  const ticker = String(setup.ticker || "MARKET").toUpperCase();
  const direction = labelize(setup.direction || "LONG");
  const horizon = labelize(setup.horizon || "SWING");
  const terminalPrice = finalStatus === "CLOSED"
    ? numberOrNull(setup.current_price)
    : kind === "victory"
      ? numberOrNull(finalStatus === "T3" ? setup.t3 : finalStatus === "T2" ? setup.t2 : setup.t1)
      : numberOrNull(setup.stop);
  return {
    kind,
    title: `${ticker} ${formatR(resultR)} · @${handle} · Ledger`,
    description: `${kind === "victory" ? "Verified public victory" : "Verified public loss"}: ${ticker} ${direction}, ${formatR(resultR)} by @${handle}. Inspect the original entry, stop, targets, and discussion.`,
    targetUrl: setupTargetUrl(id, kind),
    handle,
    ticker,
    direction,
    horizon,
    resultR,
    finalStatus,
    entry: numberOrNull(setup.entry),
    terminalPrice,
    winRate: numberOrNull(setup.operator_win_rate),
    avgR: numberOrNull(setup.operator_avg_r),
    goatScore: numberOrNull(setup.operator_goat_score),
    closedAt: String(setup.archived_at || setup.updated_at || ""),
  };
}

async function loadSetup(id: string): Promise<CardRecord> {
  if (!ID_PATTERN.test(id)) throw new Response("Invalid setup identifier.", { status: 400 });
  const result = await supabase.from("setups_public").select("*").eq("id", id).maybeSingle();
  if (result.error) throw new Response("The public setup could not be read.", { status: 502 });
  if (!result.data) throw new Response("Public setup not found.", { status: 404 });

  const setup = result.data as Record<string, unknown>;
  const handle = String(setup.handle || setup.profile_handle || "operator").replace(/^@/, "").toLowerCase();
  const ticker = String(setup.ticker || "MARKET").toUpperCase();
  const direction = labelize(setup.direction || "LONG");
  const horizon = labelize(setup.horizon || "SWING");
  const triggerType = labelize(setup.trigger_type || "PUBLISHED");
  const strategy = labelize(setup.strategy || "PUBLIC SETUP");
  const status = labelize(setup.status || "QUEUED");
  const entry = priceOrNull(setup.entry);
  const stop = priceOrNull(setup.stop);
  const t1 = priceOrNull(setup.t1);
  const t2 = priceOrNull(setup.t2);
  const t3 = priceOrNull(setup.t3);
  const plannedR = setupPlannedR(setup, direction, entry, stop);
  const targets = [t1, t2, t3].filter((value) => value != null).map(formatPrice).join(" / ");
  return {
    kind: "setup",
    title: `${ticker} ${direction} · @${handle} · Ledger setup`,
    description: `${triggerType} ${horizon}. Entry ${formatPrice(entry)} · Stop ${formatPrice(stop)} · Targets ${targets || "—"} · Planned ${formatR(plannedR)}.`,
    targetUrl: setupTargetUrl(id, "setup"),
    handle,
    ticker,
    direction,
    horizon,
    triggerType,
    strategy,
    status,
    entry,
    stop,
    t1,
    t2,
    t3,
    currentPrice: priceOrNull(setup.current_price),
    plannedR,
    thesisImageUrl: thesisImageUrl(setup.thesis),
  };
}

function stat(label: string, value: string, accent?: string) {
  return <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: "18px 20px", borderRight: "1px solid rgba(255,255,255,.12)" }}>
    <span style={{ color: "#aeb5c2", fontSize: 17, fontWeight: 700, letterSpacing: ".08em" }}>{label}</span>
    <b style={{ marginTop: 8, color: accent || "#ffffff", fontSize: 30, lineHeight: 1 }}>{value}</b>
  </div>;
}

function brand() {
  return <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
    <div style={{ display: "flex", width: 62, height: 62, alignItems: "center", justifyContent: "center", border: "2px solid #c8ff2e", borderRadius: 18, background: "#11170b", color: "#c8ff2e", fontSize: 24, fontWeight: 900, letterSpacing: "-.08em" }}>CO</div>
    <div style={{ display: "flex", flexDirection: "column" }}>
      <b style={{ color: "#ffffff", fontSize: 25, letterSpacing: ".08em" }}>COMPOSITE OPERATOR</b>
      <span style={{ color: "#c8ff2e", fontSize: 19, fontWeight: 800, letterSpacing: ".24em" }}>LEDGER</span>
    </div>
  </div>;
}

function operatorImage(record: CardRecord) {
  const rankText = record.rank ? `#${formatInteger(record.rank)}` : "NQ";
  const totalText = record.totalOperators ? `OF ${formatInteger(record.totalOperators)} OPERATORS` : "RANKS AFTER QUALIFICATION";
  return <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: "48px 54px", backgroundColor: "#090b11", color: "#ffffff" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      {brand()}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 14px", border: "1px solid rgba(59,231,170,.45)", borderRadius: 999, color: "#3be7aa", fontSize: 17, fontWeight: 800 }}><span style={{ width: 9, height: 9, borderRadius: 999, background: "#3be7aa" }} /> PUBLIC RECORD</div>
    </div>
    <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 40 }}>
      <div style={{ display: "flex", width: 150, height: 150, alignItems: "center", justifyContent: "center", overflow: "hidden", border: "2px solid rgba(200,255,46,.42)", borderRadius: 38, background: "#141923", color: "#c8ff2e", fontSize: 54, fontWeight: 900 }}>
        {initials(record.handle)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <span style={{ color: "#c8ff2e", fontSize: 22, fontWeight: 800, letterSpacing: ".14em" }}>PUBLIC OPERATOR STATS</span>
        <b style={{ marginTop: 9, fontSize: 62, lineHeight: 1, letterSpacing: "-.05em" }}>@{record.handle}</b>
        <span style={{ marginTop: 17, color: "#cfd5df", fontSize: 23 }}>Follow proven traders. Inspect every public call.</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", width: 245, alignItems: "flex-end" }}>
        <span style={{ color: "#aeb5c2", fontSize: 18, fontWeight: 700, letterSpacing: ".09em" }}>GLOBAL STANDING</span>
        <b style={{ marginTop: 3, color: "#c8ff2e", fontSize: 72, lineHeight: 1 }}>{rankText}</b>
        <span style={{ marginTop: 8, color: "#cfd5df", fontSize: 17 }}>{totalText}</span>
      </div>
    </div>
    <div style={{ display: "flex", overflow: "hidden", border: "1px solid rgba(255,255,255,.14)", borderRadius: 15, background: "rgba(255,255,255,.035)" }}>
      {stat("GOAT SCORE", formatNumber(record.goatScore, 2), "#c8ff2e")}
      {stat("WIN RATE", formatPercent(record.winRate))}
      {stat("AVG R", formatR(record.avgR), (record.avgR || 0) >= 0 ? "#3be7aa" : "#ff665f")}
      {stat("NET R", formatR(record.totalR), (record.totalR || 0) >= 0 ? "#3be7aa" : "#ff665f")}
      {stat("FOLLOWERS", formatInteger(record.followers))}
    </div>
  </div>;
}

function setupExecutionMap(record: CardRecord) {
  const levels = [record.stop, record.entry, record.t1, record.t2, record.t3, record.currentPrice].filter((value): value is number => value != null && Number.isFinite(value));
  const floor = levels.length ? Math.min(...levels) : 0;
  const ceiling = levels.length ? Math.max(...levels) : 1;
  const rawSpan = Math.max(ceiling - floor, Math.abs((record.entry || 0) - (record.stop || 0)), 1e-9);
  const scaleFloor = floor - rawSpan * .08;
  const scaleCeiling = ceiling + rawSpan * .08;
  const position = (value: number | null | undefined) => value == null ? 50 : Math.max(4, Math.min(96, ((value - scaleFloor) / (scaleCeiling - scaleFloor)) * 100));
  const entryPosition = position(record.entry);
  const stopPosition = position(record.stop);
  const currentPosition = position(record.currentPrice ?? record.entry);
  const targetValues = [record.t1, record.t2, record.t3].filter((value): value is number => value != null && Number.isFinite(value));
  const targetBoundary = targetValues.length ? (record.direction === "SHORT" ? Math.min(...targetValues) : Math.max(...targetValues)) : record.entry;
  const targetPosition = position(targetBoundary);
  const riskLeft = Math.min(entryPosition, stopPosition);
  const riskWidth = Math.max(1, Math.abs(entryPosition - stopPosition));
  const targetLeft = Math.min(entryPosition, targetPosition);
  const targetWidth = Math.max(1, Math.abs(entryPosition - targetPosition));
  const nowLeft = Math.min(entryPosition, currentPosition);
  const nowWidth = Math.max(1, Math.abs(entryPosition - currentPosition));
  const marker = (label: string, value: number | null | undefined, color: string, index?: number) => value == null ? null : <div style={{ display: "flex", position: "absolute", left: `${position(value)}%`, top: 117, transform: "translateX(-50%)", flexDirection: "column", alignItems: "center", gap: 7 }}>
    <div style={{ display: "flex", width: index ? 28 : 19, height: index ? 28 : 19, alignItems: "center", justifyContent: "center", border: `3px solid ${color}`, borderRadius: 99, background: "#090b11", color, fontSize: 13, fontWeight: 900 }}>{index || ""}</div>
    <span style={{ color, fontSize: 14, fontWeight: 900 }}>{label}</span>
    <span style={{ color: "#ffffff", fontSize: 15, fontWeight: 800 }}>{formatPrice(value)}</span>
  </div>;
  const distance = record.entry && record.currentPrice
    ? ((record.currentPrice - record.entry) / record.entry) * 100 * (record.direction === "SHORT" ? -1 : 1)
    : null;

  return <div style={{ display: "flex", position: "relative", flexDirection: "column", flex: 1, minWidth: 0, height: 392, overflow: "hidden", border: "1px solid rgba(255,255,255,.16)", borderRadius: 18, background: "#0d1118" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 20px", borderBottom: "1px solid rgba(255,255,255,.1)" }}>
      <span style={{ color: "#c8ff2e", fontSize: 16, fontWeight: 900, letterSpacing: ".12em" }}>PUBLIC EXECUTION MAP</span>
      <span style={{ color: distance == null ? "#b8c0cd" : distance >= 0 ? "#3be7aa" : "#ff665f", fontSize: 16, fontWeight: 900 }}>{distance == null ? "QUOTE PENDING" : `${Math.abs(distance).toFixed(2)}% ${distance >= 0 ? "FAVORABLE" : "ADVERSE"}`}</span>
    </div>
    <div style={{ display: "flex", position: "relative", flex: 1 }}>
      <div style={{ display: "flex", position: "absolute", left: "4%", right: "4%", top: 126, height: 3, background: "rgba(255,255,255,.2)" }} />
      <div style={{ display: "flex", position: "absolute", left: `${riskLeft}%`, width: `${riskWidth}%`, top: 119, height: 17, borderRadius: 20, background: "rgba(255,102,95,.32)" }} />
      <div style={{ display: "flex", position: "absolute", left: `${targetLeft}%`, width: `${targetWidth}%`, top: 119, height: 17, borderRadius: 20, background: "rgba(59,231,170,.28)" }} />
      {record.currentPrice != null ? <div style={{ display: "flex", position: "absolute", left: `${nowLeft}%`, width: `${nowWidth}%`, top: 123, height: 9, borderRadius: 20, background: "#55dcf0" }} /> : null}
      {marker("SL", record.stop, "#ff665f")}
      {marker("ENTRY", record.entry, "#ffffff")}
      {marker("T1", record.t1, "#3be7aa", 1)}
      {marker("T2", record.t2, "#3be7aa", 2)}
      {marker("T3", record.t3, "#3be7aa", 3)}
      {record.currentPrice != null ? marker("NOW", record.currentPrice, "#55dcf0") : null}
      <div style={{ display: "flex", position: "absolute", left: 20, right: 20, bottom: 16, justifyContent: "space-between", color: "#aeb5c2", fontSize: 14 }}>
        <span>RED: PUBLISHED RISK</span><span>GREEN: TARGET PATH</span><span>CYAN: ENTRY → NOW</span>
      </div>
    </div>
  </div>;
}

function setupImage(record: CardRecord) {
  const accent = record.direction === "SHORT" ? "#ff665f" : "#3be7aa";
  const targetList = [record.t1, record.t2, record.t3].filter((value) => value != null).map(formatPrice).join(" · ") || "—";
  return <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: "38px 44px", background: "#090b11", color: "#ffffff" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      {brand()}
      <div style={{ display: "flex", padding: "9px 14px", border: `1px solid ${accent}`, borderRadius: 999, color: accent, fontSize: 16, fontWeight: 900, letterSpacing: ".08em" }}>{record.status || "PUBLIC SETUP"}</div>
    </div>
    <div style={{ display: "flex", flex: 1, alignItems: "stretch", gap: 30, marginTop: 26, minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", width: 480, minWidth: 480 }}>
        <span style={{ color: accent, fontSize: 19, fontWeight: 900, letterSpacing: ".13em" }}>{record.direction} · {record.horizon} · {record.triggerType}</span>
        <b style={{ marginTop: 8, fontSize: 76, lineHeight: .95, letterSpacing: "-.055em" }}>{record.ticker}</b>
        <span style={{ marginTop: 10, color: "#ffffff", fontSize: 26, fontWeight: 800 }}>@{record.handle}</span>
        <span style={{ marginTop: 8, color: "#c8ced9", fontSize: 19 }}>{record.strategy}</span>
        <div style={{ display: "flex", marginTop: 24, overflow: "hidden", border: "1px solid rgba(255,255,255,.16)", borderRadius: 13, background: "rgba(255,255,255,.035)" }}>
          {stat("ENTRY", formatPrice(record.entry))}
          {stat("STOP", formatPrice(record.stop), "#ff665f")}
          {stat("PLANNED R", formatR(record.plannedR), "#c8ff2e")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 18, padding: "16px 18px", border: "1px solid rgba(59,231,170,.28)", borderRadius: 13, background: "rgba(59,231,170,.05)" }}>
          <span style={{ color: "#aeb5c2", fontSize: 15, fontWeight: 800, letterSpacing: ".1em" }}>PUBLISHED TARGETS</span>
          <b style={{ marginTop: 7, color: "#3be7aa", fontSize: 22 }}>{targetList}</b>
        </div>
      </div>
      {record.thesisImageUrl
        ? <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden", border: "1px solid rgba(200,255,46,.3)", borderRadius: 18, background: "#05070a" }}>
          <div style={{ display: "flex", padding: "14px 18px", color: "#c8ff2e", fontSize: 15, fontWeight: 900, letterSpacing: ".12em", borderBottom: "1px solid rgba(255,255,255,.1)" }}>ORIGINAL THESIS CHART</div>
          <img src={record.thesisImageUrl} alt="Original thesis chart" width="570" height="350" style={{ width: "100%", height: "350px", objectFit: "contain" }} />
        </div>
        : setupExecutionMap(record)}
    </div>
  </div>;
}

function outcomeImage(record: CardRecord) {
  const victory = record.kind === "victory";
  const accent = victory ? "#c8ff2e" : "#ff665f";
  const secondary = victory ? "#3be7aa" : "#ffb64a";
  return <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: "44px 50px", background: victory ? "#07110c" : "#12090b", color: "#ffffff", position: "relative", overflow: "hidden" }}>
    <div style={{ display: "flex", position: "absolute", right: -25, top: 74, width: 420, height: 420, alignItems: "center", justifyContent: "center", border: `3px solid ${accent}`, borderRadius: 999, color: accent, fontSize: 180, fontWeight: 900, opacity: .24 }}>{victory ? "+R" : "-R"}</div>
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {brand()}
        <div style={{ display: "flex", padding: "9px 14px", border: `1px solid ${accent}`, borderRadius: 999, color: accent, fontSize: 17, fontWeight: 900, letterSpacing: ".08em" }}>VERIFIED PUBLIC {victory ? "VICTORY" : "LOSS"}</div>
      </div>
      <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 690 }}>
          <span style={{ color: secondary, fontSize: 22, fontWeight: 900, letterSpacing: ".16em" }}>{victory ? "THE RECEIPT CLEARED" : "THE MARKET HAS NOTES"}</span>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginTop: 13 }}>
            <b style={{ fontSize: 92, lineHeight: .9, letterSpacing: "-.06em" }}>{record.ticker}</b>
            <b style={{ color: accent, fontSize: 68, lineHeight: .9, letterSpacing: "-.05em" }}>{formatR(record.resultR)}</b>
          </div>
          <span style={{ marginTop: 22, color: "#e1e5eb", fontSize: 25 }}>@{record.handle} · {record.direction} · {record.horizon}</span>
        </div>
      </div>
      <div style={{ display: "flex", overflow: "hidden", border: "1px solid rgba(255,255,255,.16)", borderRadius: 15, background: "rgba(0,0,0,.35)" }}>
        {stat("OUTCOME", record.finalStatus || (victory ? "WIN" : "LOSS"), accent)}
        {stat("ENTRY", record.entry == null ? "—" : `$${formatNumber(record.entry, 2, "—")}`)}
        {stat(record.finalStatus === "CLOSED" ? "MARKET EXIT" : victory ? "WINNING TARGET" : "PUBLISHED STOP", record.terminalPrice == null ? "—" : `$${formatNumber(record.terminalPrice, 2, "—")}`)}
        {stat("OP WIN RATE", formatPercent(record.winRate))}
        {stat("OP AVG R", formatR(record.avgR), secondary)}
      </div>
    </div>
  </div>;
}

function imageResponse(record: CardRecord) {
  const image = record.kind === "operator" ? operatorImage(record) : record.kind === "setup" ? setupImage(record) : outcomeImage(record);
  return new ImageResponse(image, {
    width: 1200,
    height: 630,
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

function socialHtml(record: CardRecord, imageUrl: string) {
  const title = escapeHtml(record.title);
  const description = escapeHtml(record.description);
  const targetUrl = escapeHtml(record.targetUrl);
  const escapedImage = escapeHtml(imageUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="${targetUrl}"><meta property="og:type" content="website"><meta property="og:site_name" content="Composite Operator Ledger"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${targetUrl}"><meta property="og:image" content="${escapedImage}"><meta property="og:image:secure_url" content="${escapedImage}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${title}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${escapedImage}"><meta name="twitter:image:alt" content="${title}"><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#090b11;color:#fff;font:18px Arial,sans-serif}.card{max-width:680px;padding:36px;border:1px solid #384214;border-radius:18px;background:#0e1118}.card b{display:block;color:#c8ff2e;font-size:30px}.card p{line-height:1.6;color:#d9dde5}.card a{display:inline-block;margin-top:12px;padding:14px 18px;border-radius:9px;background:#c8ff2e;color:#090b11;font-weight:800;text-decoration:none}</style></head><body><main class="card"><b>${title}</b><p>${description}</p><a href="${targetUrl}">Open the public Ledger record →</a></main></body></html>`;
}

function isCrawler(userAgent: string) {
  return /bot|crawler|spider|preview|discord|twitter|facebookexternalhit|slack|linkedin|whatsapp|telegram/i.test(userAgent);
}

function needsDirectImage(userAgent: string) {
  // Supabase rewrites HTML GET responses to text/plain on its standard domain.
  // Discord honors nosniff and rejects that response. A direct PNG response
  // preserves Discord embeds while X can continue to parse the social HTML.
  return /discord|slackbot|whatsapp|telegram/i.test(userAgent);
}

async function handler(request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
  try {
    const url = new URL(request.url);
    const type = String(url.searchParams.get("type") || "operator").toLowerCase() as CardKind;
    if (!(["operator", "setup", "victory", "loss"] as string[]).includes(type)) return new Response("Unknown social card type.", { status: 400 });
    const record = type === "operator"
      ? await loadOperator(url.searchParams.get("handle") || "")
      : type === "setup"
        ? await loadSetup(url.searchParams.get("id") || "")
        : await loadOutcome(url.searchParams.get("id") || "", type);

    const userAgent = request.headers.get("user-agent") || "";
    if (url.searchParams.get("format") === "image" || needsDirectImage(userAgent)) return imageResponse(record);

    const imageUrl = new URL(PUBLIC_FUNCTION_URL);
    imageUrl.searchParams.set("type", record.kind);
    if (record.kind === "operator") imageUrl.searchParams.set("handle", record.handle);
    else imageUrl.searchParams.set("id", url.searchParams.get("id") || "");
    imageUrl.searchParams.set("format", "image");
    imageUrl.searchParams.set("v", SOCIAL_CARD_VERSION);
    if (!isCrawler(userAgent) && url.searchParams.get("inspect") !== "1") {
      return Response.redirect(record.targetUrl, 302);
    }
    return new Response(socialHtml(record, imageUrl.toString()), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return new Response("Social card unavailable.", { status: 500 });
  }
}

export default { fetch: withSupabase({ auth: "none" }, handler) };
