(function () {
  "use strict";

  const config = window.LEDGER_CONFIG || {};
  const liveConfigPresent = Boolean(config.supabaseUrl && config.supabasePublishableKey && config.demoMode !== true);

  const previewLeaders = [
    { id: "sheet-000000001", handle: "daft", display_name: "daft", total_setups: 2, triggered_setups: 2, stopped_setups: 2, t1_hits: 0, t2_hits: 0, t3_hits: 0, win_rate: 0, avg_r: -1, total_score: -2, goat_score: null, last_30d_score: 0, bio: "Verified Ledger operator from the current source sheet." }
  ];

  const previewSetups = [];
  const previewStats = { setups: 2, resolved: 2 };

  const state = {
    supabase: null,
    session: null,
    profile: null,
    live: false,
    leaders: previewLeaders.slice(),
    compactLeaders: previewLeaders.slice(0, 5),
    podiumLeaders: previewLeaders.slice(0, 3),
    rankTotal: previewLeaders.length,
    setups: previewSetups.slice(),
    rankMode: "goat",
    rankSearch: "",
    rankPage: 1,
    rankPageSize: 25,
    setupState: "all",
    setupDirection: "all",
    setupSearch: "",
    setupSort: "newest",
    chart: null,
    commandItems: [],
    commandToken: 0,
    rankSearchTimer: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindNavigation();
    bindDialogs();
    bindLeaderboard();
    bindSetupFilters();
    bindSubmissionForm();
    bindCommandPalette();
    bindUtilities();
    renderAll();

    if (liveConfigPresent && window.supabase?.createClient) {
      await connectLiveData();
    } else {
      setNetworkState("Backend setup required", true);
    }
  }

  function bindNavigation() {
    $$('[data-view-target]').forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.viewTarget));
    });
  }

  function switchView(viewName) {
    $$(".app-view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === viewName));
    $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === viewName));
    if (viewName === "setups") renderNetworkChart();
    history.replaceState(null, "", viewName === "overview" ? location.pathname : `#${viewName}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindDialogs() {
    const authDialog = $("#auth-dialog");
    const submitDialog = $("#submit-dialog");
    const methodDialog = $("#method-dialog");

    $("#account-button").addEventListener("click", async () => {
      if (state.session?.user) {
        const ownLeader = state.leaders.find((leader) => leader.id === state.session.user.id) || profileFromSession();
        openProfile(ownLeader);
      } else {
        authDialog.showModal();
      }
    });

    $$('[data-open-auth]').forEach((button) => button.addEventListener("click", () => authDialog.showModal()));
    $$('[data-open-submit]').forEach((button) => button.addEventListener("click", () => {
      updateFormAuthState();
      submitDialog.showModal();
    }));
    $$('[data-close-submit]').forEach((button) => button.addEventListener("click", () => submitDialog.close()));
    $("#open-methodology").addEventListener("click", () => methodDialog.showModal());
    $$('[data-close-method]').forEach((button) => button.addEventListener("click", () => methodDialog.close()));
    $("#google-auth").addEventListener("click", () => signIn("google"));
    $("#x-auth").addEventListener("click", () => signIn("x"));

    [authDialog, submitDialog, methodDialog, $("#command-dialog"), $("#profile-dialog")].forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  async function connectLiveData() {
    try {
      state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" }
      });

      const { data: sessionData } = await state.supabase.auth.getSession();
      state.session = sessionData.session;
      await hydrateSignedInProfile();
      updateAccountUI();

      state.supabase.auth.onAuthStateChange(async (_event, session) => {
        state.session = session;
        await hydrateSignedInProfile();
        updateAccountUI();
        updateFormAuthState();
      });

      state.live = true;
      await loadLiveData();
      setNetworkState("Ledger connected", false);
      renderAll();
    } catch (error) {
      console.error(error);
      setNetworkState("Preview fallback", true);
      showToast("Preview mode", "The live data connection is unavailable. The interface remains in preview mode.", true);
    }
  }

  async function loadLiveData() {
    const [leadersResult, compactResult, setupsResult] = await Promise.all([
      state.supabase.rpc("leaderboard_page", {
        p_sort: state.rankMode,
        p_search: state.rankSearch,
        p_limit: state.rankPageSize,
        p_offset: (state.rankPage - 1) * state.rankPageSize
      }),
      state.supabase.rpc("leaderboard_page", { p_sort: "goat", p_search: "", p_limit: 5, p_offset: 0 }),
      state.supabase.from("setups_public").select("*").order("submitted_at", { ascending: false }).limit(500)
    ]);

    if (leadersResult.error) throw leadersResult.error;
    if (compactResult.error) throw compactResult.error;
    if (setupsResult.error) throw setupsResult.error;
    state.leaders = (leadersResult.data || []).map(normalizeLeader);
    state.rankTotal = state.leaders[0]?.total_count || 0;
    state.compactLeaders = (compactResult.data || []).map(normalizeLeader);
    if (state.rankPage === 1) state.podiumLeaders = state.leaders.slice(0, 3);
    state.setups = (setupsResult.data || []).map(normalizeSetup);
  }

  async function loadLiveLeaderboardPage() {
    if (!state.live || !state.supabase) return;
    const { data, error } = await state.supabase.rpc("leaderboard_page", {
      p_sort: state.rankMode,
      p_search: state.rankSearch,
      p_limit: state.rankPageSize,
      p_offset: (state.rankPage - 1) * state.rankPageSize
    });
    if (error) {
      showToast("Leaderboard unavailable", error.message, true);
      return;
    }
    state.leaders = (data || []).map(normalizeLeader);
    state.rankTotal = state.leaders[0]?.total_count || 0;
    if (state.rankPage === 1) state.podiumLeaders = state.leaders.slice(0, 3);
    renderLeaderboard();
    renderMetrics();
    renderSetupCounts();
  }

  async function hydrateSignedInProfile() {
    if (!state.supabase || !state.session?.user) {
      state.profile = null;
      return;
    }
    const { data } = await state.supabase.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
    state.profile = data || null;
  }

  function normalizeLeader(row) {
    return {
      id: row.profile_id || row.id,
      rank_position: Number(row.rank_position || 0),
      total_count: Number(row.total_count || 0),
      handle: row.handle,
      display_name: row.display_name || row.handle,
      avatar_url: row.avatar_url || null,
      total_setups: Number(row.total_setups || 0),
      triggered_setups: Number(row.triggered_setups || 0),
      stopped_setups: Number(row.stopped_setups || 0),
      t1_hits: Number(row.t1_hits || 0),
      t2_hits: Number(row.t2_hits || 0),
      t3_hits: Number(row.t3_hits || 0),
      win_rate: nullableNumber(row.win_rate),
      avg_r: nullableNumber(row.avg_r),
      total_score: Number(row.total_score || 0),
      goat_score: nullableNumber(row.goat_score),
      last_30d_score: Number(row.last_30d_score || 0),
      bio: row.bio || ""
    };
  }

  function normalizeSetup(row) {
    return {
      ...row,
      handle: row.handle || row.profile_handle || "operator",
      ticker: String(row.ticker || "").toUpperCase(),
      direction: String(row.direction || "LONG").toUpperCase(),
      status: String(row.status || "QUEUED").toUpperCase(),
      entry: nullableNumber(row.entry),
      stop: nullableNumber(row.stop),
      t1: nullableNumber(row.t1),
      t2: nullableNumber(row.t2),
      t3: nullableNumber(row.t3),
      current_price: nullableNumber(row.current_price),
      score: nullableNumber(row.score),
      r_result: nullableNumber(row.r_result)
    };
  }

  async function signIn(provider) {
    if (!state.supabase) {
      showToast("Sign-in is not active yet", "The Supabase project and OAuth providers must be configured first.", true);
      return;
    }
    const redirectTo = config.siteUrl || `${location.origin}${location.pathname}`;
    const { error } = await state.supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (error) showToast("Sign-in failed", error.message, true);
  }

  function updateAccountUI() {
    const label = $("#account-label");
    const avatar = $("#account-avatar");
    if (!state.session?.user) {
      label.textContent = "Sign in";
      avatar.textContent = "CO";
      return;
    }
    const handle = state.profile?.handle || state.session.user.user_metadata?.user_name || state.session.user.user_metadata?.name || "Operator";
    label.textContent = handle;
    avatar.textContent = initials(handle);
  }

  function profileFromSession() {
    const handle = state.profile?.handle || state.session?.user?.user_metadata?.user_name || "operator";
    return {
      id: state.session?.user?.id,
      handle,
      display_name: state.profile?.display_name || handle,
      avatar_url: state.profile?.avatar_url || null,
      total_setups: 0,
      triggered_setups: 0,
      win_rate: null,
      avg_r: null,
      total_score: 0,
      goat_score: null,
      last_30d_score: 0,
      bio: state.profile?.bio || ""
    };
  }

  function bindLeaderboard() {
    $$('[data-rank-mode]').forEach((button) => {
      button.addEventListener("click", async () => {
        state.rankMode = button.dataset.rankMode;
        state.rankPage = 1;
        $$('[data-rank-mode]').forEach((item) => item.classList.toggle("is-active", item === button));
        if (state.live) await loadLiveLeaderboardPage();
        else renderLeaderboard();
      });
    });
    $("#leaderboard-search").addEventListener("input", (event) => {
      state.rankSearch = event.target.value.trim().toLowerCase();
      state.rankPage = 1;
      clearTimeout(state.rankSearchTimer);
      if (state.live) state.rankSearchTimer = setTimeout(loadLiveLeaderboardPage, 220);
      else renderLeaderboard();
    });
    $("#leaderboard-prev").addEventListener("click", async () => {
      state.rankPage = Math.max(1, state.rankPage - 1);
      if (state.live) await loadLiveLeaderboardPage();
      else renderLeaderboard();
    });
    $("#leaderboard-next").addEventListener("click", async () => {
      state.rankPage += 1;
      if (state.live) await loadLiveLeaderboardPage();
      else renderLeaderboard();
    });
  }

  function rankedLeaders() {
    if (state.live) return state.leaders.slice();
    const search = state.rankSearch;
    const filtered = state.leaders.filter((leader) => !search || `${leader.handle} ${leader.display_name}`.toLowerCase().includes(search));
    const getter = {
      goat: (leader) => leader.goat_score ?? -Infinity,
      last30: (leader) => leader.last_30d_score ?? -Infinity,
      score: (leader) => leader.total_score ?? -Infinity,
      win: (leader) => leader.win_rate ?? -Infinity
    }[state.rankMode];
    return filtered.sort((a, b) => getter(b) - getter(a) || b.triggered_setups - a.triggered_setups || a.handle.localeCompare(b.handle));
  }

  function renderLeaderboard() {
    const leaders = rankedLeaders();
    const totalCount = state.live ? state.rankTotal : leaders.length;
    const pageCount = Math.max(1, Math.ceil(totalCount / state.rankPageSize));
    state.rankPage = Math.min(state.rankPage, pageCount);
    const start = (state.rankPage - 1) * state.rankPageSize;
    const page = state.live ? leaders : leaders.slice(start, start + state.rankPageSize);
    const body = $("#leaderboard-body");
    body.innerHTML = page.map((leader, index) => leaderboardRow(leader, leader.rank_position || start + index + 1)).join("");
    bindProfileTriggers(body);
    $("#leaderboard-empty").hidden = page.length > 0;
    $("#leaderboard-count").textContent = `Showing ${page.length} of ${totalCount} operators`;
    $("#leaderboard-page").textContent = String(state.rankPage).padStart(2, "0");
    $("#leaderboard-prev").disabled = state.rankPage <= 1;
    $("#leaderboard-next").disabled = state.rankPage >= pageCount;
    renderPodium(state.live ? state.podiumLeaders : leaders.slice(0, 3));
  }

  function leaderboardRow(leader, rank) {
    return `<tr data-profile-id="${escapeAttr(leader.id)}">
      <td><div class="rank-operator-cell"><span>${String(rank).padStart(2, "0")}</span>${avatar(leader)}<div class="operator-copy"><b>${escapeHtml(leader.display_name)}</b><small>@${escapeHtml(leader.handle)}</small></div></div></td>
      <td class="${metricClass(leader.goat_score)}">${formatNumber(leader.goat_score, 2, "—")}</td>
      <td class="${metricClass(leader.last_30d_score)}">${formatSigned(leader.last_30d_score)}</td>
      <td>${formatPercent(leader.win_rate)}</td>
      <td class="${metricClass(leader.avg_r)}">${formatR(leader.avg_r)}</td>
      <td>${formatInteger(leader.triggered_setups)}</td>
      <td class="${metricClass(leader.total_score)}">${formatSigned(leader.total_score)}</td>
      <td><span class="row-open">↗</span></td>
    </tr>`;
  }

  function renderPodium(leaders) {
    const podium = $("#ranking-podium");
    podium.innerHTML = leaders.map((leader, index) => `<article class="podium-card" data-rank="0${index + 1}" data-profile-id="${escapeAttr(leader.id)}">
      <div class="podium-top"><span class="podium-rank">RANK / 0${index + 1}</span><span class="podium-score">GOAT ${formatNumber(leader.goat_score, 2, "NQ")}</span></div>
      <div class="podium-operator">${avatar(leader)}<div><b>${escapeHtml(leader.display_name)}</b><small>@${escapeHtml(leader.handle)}</small></div></div>
      <div class="podium-metrics"><div><span>WIN RATE</span><b>${formatPercent(leader.win_rate)}</b></div><div><span>AVG R</span><b>${formatR(leader.avg_r)}</b></div><div><span>RESOLVED</span><b>${formatInteger(leader.triggered_setups)}</b></div></div>
    </article>`).join("");
    bindProfileTriggers(podium);
  }

  function renderCompactLeaderboard() {
    const leaders = (state.live ? state.compactLeaders : state.leaders)
      .slice()
      .sort((a, b) => (b.goat_score ?? -Infinity) - (a.goat_score ?? -Infinity))
      .slice(0, 5);
    const target = $("#compact-leaderboard");
    target.innerHTML = leaders.map((leader, index) => `<div class="compact-row" data-profile-id="${escapeAttr(leader.id)}">
      <span class="rank-number">${String(index + 1).padStart(2, "0")}</span>
      <div class="operator-cell">${avatar(leader)}<div class="operator-copy"><b>${escapeHtml(leader.display_name)}</b><small>@${escapeHtml(leader.handle)}</small></div></div>
      ${compactStat("GOAT", formatNumber(leader.goat_score, 2, "NQ"), metricClass(leader.goat_score))}
      ${compactStat("WIN", formatPercent(leader.win_rate), "")}
      ${compactStat("AVG R", formatR(leader.avg_r), metricClass(leader.avg_r))}
      ${compactStat("30D", formatSigned(leader.last_30d_score), metricClass(leader.last_30d_score))}
      <i>↗</i>
    </div>`).join("");
    bindProfileTriggers(target);
  }

  function compactStat(label, value, cssClass) {
    return `<div class="compact-stat"><span>${label}</span><b class="${cssClass}">${value}</b></div>`;
  }

  function bindProfileTriggers(root) {
    $$('[data-profile-id]', root).forEach((element) => {
      element.addEventListener("click", () => {
        const leader = [...state.leaders, ...state.compactLeaders].find((item) => String(item.id) === String(element.dataset.profileId));
        if (leader) openProfile(leader);
      });
    });
  }

  async function openProfile(leader) {
    let profileSetups = state.setups.filter((setup) => String(setup.user_id) === String(leader.id) || setup.handle === leader.handle);
    if (state.live && state.supabase && leader.id) {
      const { data } = await state.supabase
        .from("setups_public")
        .select("*")
        .eq("user_id", leader.id)
        .order("submitted_at", { ascending: false })
        .limit(25);
      if (data) profileSetups = data.map(normalizeSetup);
    }
    const recent = profileSetups.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 7);
    const drawer = $("#profile-drawer");
    drawer.innerHTML = `<div class="profile-head">
      <button class="modal-close" type="button" data-close-profile aria-label="Close profile">×</button>
      <div class="profile-avatar-large">${initials(leader.handle)}</div>
      <h2>${escapeHtml(leader.display_name || leader.handle)}</h2>
      <p>@${escapeHtml(leader.handle)} · ${escapeHtml(leader.bio || "Public Ledger operator")}</p>
      <div class="profile-badges"><span>SSO VERIFIED</span><span>PUBLIC RECORD</span><span>${leader.triggered_setups || 0} RESOLVED</span></div>
    </div>
    <div class="profile-body">
      <div class="profile-metric-grid">
        <div><span>GOAT SCORE</span><b>${formatNumber(leader.goat_score, 2, "NQ")}</b></div>
        <div><span>WIN RATE</span><b>${formatPercent(leader.win_rate)}</b></div>
        <div><span>AVG R</span><b class="${metricClass(leader.avg_r)}">${formatR(leader.avg_r)}</b></div>
        <div><span>TOTAL SCORE</span><b class="${metricClass(leader.total_score)}">${formatSigned(leader.total_score)}</b></div>
        <div><span>30D SCORE</span><b class="${metricClass(leader.last_30d_score)}">${formatSigned(leader.last_30d_score)}</b></div>
        <div><span>TOTAL SETUPS</span><b>${formatInteger(leader.total_setups)}</b></div>
      </div>
      <div class="profile-section-title">RECENT PUBLIC RECORDS</div>
      <div class="profile-records">${recent.length ? recent.map(profileRecord).join("") : '<div class="table-empty">No public setups yet.</div>'}</div>
    </div>`;
    $("[data-close-profile]", drawer).addEventListener("click", () => $("#profile-dialog").close());
    $("#profile-dialog").showModal();
  }

  function profileRecord(setup) {
    const result = setup.status === "RESOLVED" ? `${formatR(setup.r_result)}` : setup.status;
    return `<div class="profile-record"><b>${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.trigger_type))} · ${formatDate(setup.submitted_at)}</span><i class="${metricClass(setup.r_result)}">${escapeHtml(result)}</i></div>`;
  }

  function bindSetupFilters() {
    $$('[data-setup-state]').forEach((button) => button.addEventListener("click", () => {
      state.setupState = button.dataset.setupState;
      $$('[data-setup-state]').forEach((item) => item.classList.toggle("is-active", item === button));
      renderSetups();
    }));
    $$('[data-direction]').forEach((button) => button.addEventListener("click", () => {
      state.setupDirection = button.dataset.direction;
      $$('[data-direction]').forEach((item) => item.classList.toggle("is-active", item === button));
      renderSetups();
    }));
    $("#setup-search").addEventListener("input", (event) => {
      state.setupSearch = event.target.value.trim().toLowerCase();
      renderSetups();
    });
    $("#setup-sort").addEventListener("change", (event) => {
      state.setupSort = event.target.value;
      renderSetups();
    });
  }

  function filteredSetups() {
    let rows = state.setups.filter((setup) => {
      const matchesState = state.setupState === "all" || normalizeState(setup.status) === state.setupState;
      const matchesDirection = state.setupDirection === "all" || setup.direction === state.setupDirection;
      const haystack = `${setup.ticker} ${setup.handle} ${setup.strategy || ""} ${setup.thesis || ""}`.toLowerCase();
      const matchesSearch = !state.setupSearch || haystack.includes(state.setupSearch);
      return matchesState && matchesDirection && matchesSearch;
    });

    if (state.setupSort === "trigger") {
      rows.sort((a, b) => triggerDistance(a) - triggerDistance(b));
    } else if (state.setupSort === "score") {
      rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    } else {
      rows.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    }
    return rows;
  }

  function renderSetups() {
    const rows = filteredSetups();
    const grid = $("#setup-card-grid");
    grid.innerHTML = rows.map(setupCard).join("");
    $("#setup-empty").hidden = rows.length > 0;
    $$("[data-open-setup-profile]", grid).forEach((button) => button.addEventListener("click", () => {
      const leader = [...state.leaders, ...state.compactLeaders].find((item) => String(item.id) === String(button.dataset.openSetupProfile) || item.handle === button.dataset.handle) || {
        id: button.dataset.openSetupProfile,
        handle: button.dataset.handle,
        display_name: button.dataset.handle,
        total_setups: 0,
        triggered_setups: 0,
        total_score: 0,
        last_30d_score: 0
      };
      openProfile(leader);
    }));
    renderSetupCounts();
    renderNetworkIntel();
  }

  function setupCard(setup) {
    const normalized = normalizeState(setup.status);
    const plannedR = computePlannedR(setup.direction, setup.entry, setup.stop, setup.t1);
    return `<article class="setup-card is-${setup.direction.toLowerCase()}">
      <div class="setup-card-top">
        <div class="ticker-lockup"><div class="ticker-icon">${escapeHtml(setup.ticker.slice(0, 4))}</div><div class="ticker-copy"><b>${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.horizon || "SWING"))}</span></div></div>
        <span class="status-chip ${normalized}">${escapeHtml(normalized.toUpperCase())}</span>
      </div>
      <div class="setup-price-grid">
        <div><span>CURRENT</span><b>${formatPrice(setup.current_price)}</b></div>
        <div><span>ENTRY</span><b>${formatPrice(setup.entry)}</b></div>
        <div><span>STOP</span><b class="metric-negative">${formatPrice(setup.stop)}</b></div>
        <div><span>PLANNED R</span><b class="metric-positive">${formatNumber(plannedR, 2, "—")}R</b></div>
      </div>
      <p class="setup-thesis">${escapeHtml(setup.thesis || "No public thesis was added to this setup.")}</p>
      <div class="setup-card-foot"><span>@${escapeHtml(setup.handle)} · ${formatRelative(setup.submitted_at)}</span><button type="button" data-open-setup-profile="${escapeAttr(setup.user_id)}" data-handle="${escapeAttr(setup.handle)}">VIEW OPERATOR ↗</button></div>
    </article>`;
  }

  function renderSetupCounts() {
    const counts = { all: state.setups.length, queued: 0, hot: 0, near: 0, active: 0, resolved: 0 };
    state.setups.forEach((setup) => { counts[normalizeState(setup.status)] = (counts[normalizeState(setup.status)] || 0) + 1; });
    Object.entries(counts).forEach(([key, value]) => {
      const node = $(`#count-${key}`);
      if (node) node.textContent = value;
    });
    $("#rail-queued").textContent = counts.queued;
    $("#rail-hot").textContent = counts.hot;
    $("#rail-near").textContent = counts.near;
    $("#rail-active").textContent = counts.active;
    $("#rail-resolved").textContent = counts.resolved;
    $("#rail-operators").textContent = state.live ? state.rankTotal : state.leaders.length;
    $("#hero-open-signals").textContent = counts.queued + counts.hot + counts.near + counts.active;
  }

  function renderActivity() {
    const items = state.setups.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 7);
    $("#activity-stream").innerHTML = items.length ? items.map((setup) => `<div class="activity-item">
      <div class="activity-node">${setup.direction === "LONG" ? "↗" : "↘"}</div>
      <div class="activity-copy"><b>@${escapeHtml(setup.handle)} published ${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} ${escapeHtml(labelize(setup.trigger_type))} at ${formatPrice(setup.entry)} · ${escapeHtml(setup.strategy || "Uncategorized")}</span></div>
      <time>${formatRelative(setup.submitted_at)}</time>
    </div>`).join("") : '<div class="activity-empty"><b>No current public signals</b><span>Live activity will appear here after the backend and submission flow are activated.</span></div>';
  }

  function renderNetworkIntel() {
    const rows = state.setups;
    if (!rows.length) {
      $("#long-bias-label").textContent = "NO LIVE DATA";
      $("#long-bias-bar").style.width = "0%";
      $("#top-horizon").textContent = "—";
      $("#top-trigger").textContent = "—";
      $("#median-r").textContent = "—";
      return;
    }
    const longCount = rows.filter((setup) => setup.direction === "LONG").length;
    const longPct = Math.round((longCount / rows.length) * 100);
    $("#long-bias-label").textContent = `${longPct}% LONG`;
    $("#long-bias-bar").style.width = `${longPct}%`;
    $("#top-horizon").textContent = modeOf(rows.map((setup) => setup.horizon || "SWING"));
    $("#top-trigger").textContent = modeOf(rows.map((setup) => setup.trigger_type || "BREACH"));
    const planned = rows.map((setup) => computePlannedR(setup.direction, setup.entry, setup.stop, setup.t1)).filter(Number.isFinite).sort((a, b) => a - b);
    $("#median-r").textContent = planned.length ? `${formatNumber(median(planned), 1)}R` : "—";
  }

  function renderNetworkChart() {
    if (!window.Chart || !$("#network-chart")) return;
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    state.setups.forEach((setup) => {
      const age = Math.floor((Date.now() - new Date(setup.submitted_at).getTime()) / 86400000);
      const bucket = 6 - Math.min(6, Math.max(0, age));
      buckets[bucket] += 1;
    });
    if (state.chart) state.chart.destroy();
    state.chart = new window.Chart($("#network-chart"), {
      type: "line",
      data: {
        labels: ["-6d", "-5d", "-4d", "-3d", "-2d", "-1d", "NOW"],
        datasets: [{ data: buckets, borderColor: "#c8ff2e", backgroundColor: "rgba(200,255,46,.07)", fill: true, tension: .42, pointRadius: 0, borderWidth: 1.4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { displayColors: false, backgroundColor: "#12151d", borderColor: "rgba(255,255,255,.1)", borderWidth: 1, titleFont: { family: "DM Mono", size: 8 }, bodyFont: { family: "DM Mono", size: 8 } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: "#5d6371", font: { family: "DM Mono", size: 7 } } },
          y: { display: false, beginAtZero: true }
        }
      }
    });
  }

  function bindSubmissionForm() {
    const form = $("#setup-form");
    ["entry", "stop", "t1"].forEach((id) => $(`#${id}`).addEventListener("input", updateRiskPreview));
    $$('input[name="direction"]').forEach((input) => input.addEventListener("change", updateRiskPreview));
    $("#thesis").addEventListener("input", (event) => { $("#thesis-count").textContent = event.target.value.length; });
    form.addEventListener("submit", submitSetup);
    updateRiskPreview();
    updateFormAuthState();
  }

  function updateFormAuthState() {
    $("#form-auth-alert").classList.toggle("is-visible", !state.session?.user);
  }

  function updateRiskPreview() {
    const direction = $('input[name="direction"]:checked')?.value || "LONG";
    const entry = Number($("#entry").value);
    const stop = Number($("#stop").value);
    const t1 = Number($("#t1").value);
    const valid = [entry, stop, t1].every((value) => Number.isFinite(value) && value > 0);
    const risk = valid ? Math.abs(entry - stop) : null;
    const reward = valid ? Math.abs(t1 - entry) : null;
    const plannedR = valid && risk > 0 ? reward / risk : null;
    $("#risk-value").textContent = risk == null ? "—" : formatPrice(risk);
    $("#reward-value").textContent = reward == null ? "—" : formatPrice(reward);
    $("#planned-r-value").textContent = plannedR == null ? "—" : `${formatNumber(plannedR, 2)}R`;
    const lossPct = plannedR == null ? 30 : Math.max(12, Math.min(45, 100 / (1 + plannedR)));
    $("#risk-visual-loss").style.width = `${lossPct}%`;
    $("#risk-visual-gain").style.width = `${100 - lossPct}%`;
    $("#risk-preview").dataset.direction = direction;
  }

  async function submitSetup(event) {
    event.preventDefault();
    const errorNode = $("#form-error");
    errorNode.hidden = true;
    if (!state.session?.user || !state.supabase) {
      errorNode.textContent = "Sign in with Google or X before you publish this setup.";
      errorNode.hidden = false;
      $("#auth-dialog").showModal();
      return;
    }

    const formData = new FormData(event.currentTarget);
    const payload = {
      user_id: state.session.user.id,
      client_request_id: crypto.randomUUID(),
      ticker: String(formData.get("ticker") || "").trim().toUpperCase(),
      direction: formData.get("direction"),
      horizon: formData.get("horizon") || "SWING",
      trigger_type: formData.get("trigger_type"),
      entry: toNumber(formData.get("entry")),
      stop: toNumber(formData.get("stop")),
      t1: toNumber(formData.get("t1")),
      t2: toNumber(formData.get("t2")),
      t3: toNumber(formData.get("t3")),
      strategy: String(formData.get("strategy") || "").trim() || null,
      thesis: String(formData.get("thesis") || "").trim() || null
    };

    const validationError = validateSetup(payload);
    if (validationError) {
      errorNode.textContent = validationError;
      errorNode.hidden = false;
      return;
    }

    const publishButton = $("#publish-setup");
    publishButton.disabled = true;
    publishButton.querySelector("span").textContent = "Publishing…";
    const { data, error } = await state.supabase.from("setups").insert(payload).select().single();
    publishButton.disabled = false;
    publishButton.querySelector("span").textContent = "Publish setup";

    if (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
      return;
    }

    $("#submit-dialog").close();
    event.currentTarget.reset();
    $("#thesis-count").textContent = "0";
    updateRiskPreview();
    showToast("Setup published", `${payload.ticker} is now part of your public record.`);
    if (data) state.setups.unshift(normalizeSetup({ ...data, handle: state.profile?.handle || "operator" }));
    await loadLiveData().catch(() => null);
    renderAll();
    switchView("setups");
  }

  function validateSetup(payload) {
    if (!/^[A-Z0-9.^=_-]{1,16}$/.test(payload.ticker)) return "Enter a valid ticker with 1–16 supported characters.";
    if (![payload.entry, payload.stop, payload.t1].every((value) => Number.isFinite(value) && value > 0)) return "Entry, stop loss, and T1 must be positive numbers.";
    if (payload.direction === "LONG" && !(payload.stop < payload.entry && payload.t1 > payload.entry)) return "For a LONG setup, the stop must be below entry and T1 must be above entry.";
    if (payload.direction === "SHORT" && !(payload.stop > payload.entry && payload.t1 < payload.entry)) return "For a SHORT setup, the stop must be above entry and T1 must be below entry.";
    const targets = [payload.t1, payload.t2, payload.t3].filter((value) => value != null);
    if (payload.direction === "LONG" && targets.some((value, index) => index > 0 && value <= targets[index - 1])) return "LONG targets must increase from T1 to T3.";
    if (payload.direction === "SHORT" && targets.some((value, index) => index > 0 && value >= targets[index - 1])) return "SHORT targets must decrease from T1 to T3.";
    return "";
  }

  function bindCommandPalette() {
    const dialog = $("#command-dialog");
    const input = $("#command-input");
    const trigger = $("#command-trigger");
    trigger.addEventListener("click", openCommand);
    input.addEventListener("input", () => { void renderCommandResults(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") $(".command-result", $("#command-results"))?.click();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && !isTyping(event.target)) {
        event.preventDefault();
        openCommand();
      }
      if (event.key === "Escape" && dialog.open) dialog.close();
    });
  }

  function openCommand() {
    const dialog = $("#command-dialog");
    dialog.showModal();
    $("#command-input").value = "";
    void renderCommandResults();
    setTimeout(() => $("#command-input").focus(), 0);
  }

  async function renderCommandResults() {
    const query = $("#command-input").value.trim().toLowerCase();
    const requestToken = ++state.commandToken;
    const viewItems = [
      { type: "VIEW", icon: "01", label: "Overview", note: "Network summary and signal stream", action: () => switchView("overview") },
      { type: "VIEW", icon: "02", label: "Leaderboard", note: "Global operator rankings", action: () => switchView("leaderboard") },
      { type: "VIEW", icon: "03", label: "Live setups", note: "Public setup tape", action: () => switchView("setups") }
    ];
    let commandLeaders = uniqueLeaders([...state.leaders, ...state.compactLeaders]);
    if (state.live && state.supabase && query.length >= 2) {
      const { data } = await state.supabase.rpc("leaderboard_page", { p_sort: "goat", p_search: query, p_limit: 8, p_offset: 0 });
      if (requestToken !== state.commandToken) return;
      if (data) commandLeaders = data.map(normalizeLeader);
    }
    const leaderItems = commandLeaders.map((leader) => ({ type: "OPERATOR", icon: initials(leader.handle), label: `@${leader.handle}`, note: `${leader.triggered_setups} resolved · ${formatR(leader.avg_r)} average`, action: () => openProfile(leader) }));
    const setupItems = state.setups.map((setup) => ({ type: "SETUP", icon: setup.direction === "LONG" ? "↗" : "↘", label: setup.ticker, note: `@${setup.handle} · ${setup.status} · ${setup.strategy || "Uncategorized"}`, action: () => { state.setupSearch = setup.ticker.toLowerCase(); $("#setup-search").value = setup.ticker; switchView("setups"); renderSetups(); } }));
    state.commandItems = [...viewItems, ...leaderItems, ...setupItems].filter((item) => !query || `${item.label} ${item.note} ${item.type}`.toLowerCase().includes(query)).slice(0, 12);
    $("#command-results").innerHTML = state.commandItems.map((item, index) => `<div class="command-result ${index === 0 ? "is-selected" : ""}" data-command-index="${index}"><span class="command-result-icon">${escapeHtml(item.icon)}</span><span class="command-result-copy"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.note)}</small></span><span class="command-result-type">${item.type}</span></div>`).join("") || '<div class="table-empty">No matching operators or setups.</div>';
    $$('[data-command-index]').forEach((element) => element.addEventListener("click", () => {
      $("#command-dialog").close();
      state.commandItems[Number(element.dataset.commandIndex)].action();
    }));
  }

  function bindUtilities() {
    $("#theme-toggle").addEventListener("click", () => document.body.classList.toggle("high-contrast"));
    if (location.hash === "#leaderboard" || location.hash === "#setups") switchView(location.hash.slice(1));
  }

  function renderAll() {
    renderMetrics();
    renderCompactLeaderboard();
    renderLeaderboard();
    renderSetups();
    renderActivity();
    renderNetworkChart();
    updateAccountUI();
    updateFormAuthState();
    updateAuthAvailability();
  }

  function renderMetrics() {
    const operatorCount = state.live ? state.rankTotal : state.leaders.length;
    const setupCount = state.live ? state.setups.length : previewStats.setups;
    const resolvedCount = state.live ? state.setups.filter((setup) => normalizeState(setup.status) === "resolved").length : previewStats.resolved;
    $$('[data-metric="operators"]').forEach((node) => node.textContent = formatInteger(operatorCount));
    $$('[data-metric="setups"]').forEach((node) => node.textContent = formatInteger(setupCount));
    $$('[data-metric="resolved"]').forEach((node) => node.textContent = formatInteger(resolvedCount));
  }

  function updateAuthAvailability() {
    const notice = $("#auth-setup-notice");
    if (notice) notice.hidden = liveConfigPresent;
    [["#google-auth", "Google"], ["#x-auth", "X"]].forEach(([selector, provider]) => {
      const button = $(selector);
      if (!button) return;
      button.classList.toggle("is-unavailable", !liveConfigPresent);
      if (liveConfigPresent) button.removeAttribute("aria-describedby");
      else button.setAttribute("aria-describedby", "auth-setup-notice");
      const detail = button.querySelector("small");
      if (detail) detail.textContent = liveConfigPresent ? `Use your ${provider} identity` : "Backend setup required";
    });
    const identityState = $("#network-identity-state");
    if (identityState) {
      identityState.textContent = liveConfigPresent ? "SSO READY" : "SETUP REQUIRED";
      identityState.classList.toggle("positive", liveConfigPresent);
    }
  }

  function setNetworkState(label, preview) {
    $("#network-state-label").textContent = label;
    $("#network-state").classList.toggle("is-preview", Boolean(preview));
  }

  function showToast(title, message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " is-error" : ""}`;
    toast.innerHTML = `<i></i><p><b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span></p><button type="button" aria-label="Dismiss notification">×</button>`;
    toast.querySelector("button").addEventListener("click", () => toast.remove());
    $("#toast-region").appendChild(toast);
    setTimeout(() => toast.remove(), 7000);
  }

  function renderSetupCountsFallback() { renderSetupCounts(); }

  function avatar(leader) {
    if (leader.avatar_url) return `<img class="operator-avatar" src="${escapeAttr(leader.avatar_url)}" alt="">`;
    return `<span class="operator-avatar">${initials(leader.handle)}</span>`;
  }

  function initials(value) {
    return String(value || "CO").split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "CO";
  }

  function normalizeState(value) {
    const stateValue = String(value || "QUEUED").toUpperCase();
    if (["STOPPED", "CLOSED", "ARCHIVED", "RESOLVED", "CANCELLED", "EXPIRED"].includes(stateValue)) return "resolved";
    if (["ACTIVE", "TRIGGERED", "T1 HIT", "T2 HIT", "T3 HIT", "T1_HIT", "T2_HIT", "T3_HIT"].includes(stateValue)) return "active";
    if (stateValue === "HOT") return "hot";
    if (stateValue === "NEAR") return "near";
    return "queued";
  }

  function computePlannedR(direction, entry, stop, target) {
    const e = Number(entry);
    const s = Number(stop);
    const t = Number(target);
    if (![e, s, t].every(Number.isFinite) || Math.abs(e - s) === 0) return null;
    const signedReward = String(direction).toUpperCase() === "SHORT" ? e - t : t - e;
    return signedReward / Math.abs(e - s);
  }

  function triggerDistance(setup) {
    if (!Number.isFinite(setup.entry) || !Number.isFinite(setup.current_price)) return Infinity;
    return Math.abs(setup.current_price - setup.entry) / setup.entry;
  }

  function metricClass(value) {
    if (value == null || Number(value) === 0) return "metric-neutral";
    return Number(value) > 0 ? "metric-positive" : "metric-negative";
  }

  function formatNumber(value, digits = 2, fallback = "—") {
    if (value == null || !Number.isFinite(Number(value))) return fallback;
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function formatInteger(value) {
    return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatSigned(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${formatNumber(number, 1)}`;
  }

  function formatPercent(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return `${formatNumber(Number(value) * 100, 1)}%`;
  }

  function formatR(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${formatNumber(number, 2)}R`;
  }

  function formatPrice(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    const digits = number >= 1000 ? 0 : number < 1 ? 4 : 2;
    return `$${number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function formatRelative(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function labelize(value) {
    return String(value || "").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function modeOf(values) {
    if (!values.length) return "—";
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return String([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]).replaceAll("_", " ");
  }

  function uniqueLeaders(leaders) {
    return [...new Map(leaders.map((leader) => [String(leader.id || leader.handle), leader])).values()];
  }

  function median(values) {
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }

  function nullableNumber(value) {
    return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  }

  function toNumber(value) {
    return value === "" || value == null ? null : Number(value);
  }

  function isTyping(target) {
    return target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function hoursAgo(hours) { return new Date(Date.now() - hours * 3600000).toISOString(); }
  function daysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString(); }

  void renderSetupCountsFallback;
})();
