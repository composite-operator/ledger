(function () {
  "use strict";

  const config = window.LEDGER_CONFIG || {};
  const liveConfigPresent = Boolean(config.supabaseUrl && config.supabasePublishableKey && config.demoMode !== true);
  const mediaBucket = "avatars";
  const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const maxImageBytes = 2 * 1024 * 1024;
  const quoteRefreshMinimumMs = 45 * 1000;
  const quoteRefreshJitterMs = 30 * 1000;
  const quoteResumeMinimumMs = 20 * 1000;
  const pastedAttachmentFiles = new WeakMap();
  const mentionLookupState = new WeakMap();
  const mentionSearchCache = new Map();
  const mentionQueryLimit = 8;
  const setupLayoutOptions = new Set(["panels", "linear", "compact"]);
  const attachmentMarkerPattern = /(?:\r?\n)?\[ledger-image:([0-9a-f-]{36}\/ledger-media\/(?:setups|comments)\/[0-9a-f-]{36}\.(?:jpg|png|webp))\]$/i;
  const defaultNotificationPreferences = {
    notifications_muted: false,
    notify_new_setups: true,
    notify_comments: true,
    notify_entry_hits: true,
    notify_followed_setup_hot: true,
    notify_followed_setup_entry: true,
    notify_followed_setup_targets: true,
    notify_followed_setup_stops: true,
    notify_wins: true,
    notify_losses: true
  };

  const previewLeaders = [
    { id: "sheet-000000001", handle: "daft", display_name: "daft", total_setups: 2, triggered_setups: 2, stopped_setups: 2, t1_hits: 0, t2_hits: 0, t3_hits: 0, win_rate: 0, avg_r: -1, total_score: -2, goat_score: null, last_30d_score: 0, bio: "Verified Ledger operator from the current source sheet." }
  ];

  const previewSetups = [];
  const previewStats = { setups: 2, resolved: 2 };
  const setupBooks = {
    all: { title: "All setups", kicker: "PUBLIC SETUP BOOK", description: "Every published thesis, from queue to resolved outcome." },
    queued: { title: "Queued setups", kicker: "PRE-EXECUTION BOOK", description: "Ideas waiting for their entry. Review the plan and discuss it before execution." },
    hot: { title: "Hot setups", kicker: "IMMEDIATE WATCH BOOK", description: "Setups receiving the strongest near-term attention from the network." },
    near: { title: "Near-entry setups", kicker: "PROXIMITY BOOK", description: "Setups closest to their published entry, ordered with live market distance." },
    active: { title: "Active setups", kicker: "LIVE EXECUTION BOOK", description: "Triggered setups now moving through their published stop and target map." },
    resolved: { title: "Resolved setups", kicker: "OUTCOME BOOK", description: "Closed public records with the original plan, result, and full discussion intact." },
    followed: { title: "Followed setups", kicker: "PERSONAL WATCHLIST", description: "The individual setups you follow, with lifecycle alerts from Hot through final outcome." }
  };
  const victoryVariants = [
    {
      slug: "frog-king",
      art: "assets/victory/frog-king.webp",
      eyebrow: "LILYPAD ALPHA CONFIRMED",
      headline: "BAGS SECURED.",
      line: "The frog reviewed the risk map and found it acceptable."
    },
    {
      slug: "winning-son",
      art: "assets/victory/winning-son.webp",
      eyebrow: "PATERNAL DUE DILIGENCE",
      headline: "ARE YA WINNING, SON?",
      line: "For one verified public record, the answer is yes."
    },
    {
      slug: "wojak-chad",
      art: "assets/victory/wojak-chad.webp",
      eyebrow: "RISK-ADJUSTED CHARACTER ARC",
      headline: "THE CHART CHANGED HIM.",
      line: "From entry anxiety to immutable jawline in one closed trade."
    },
    {
      slug: "chud-terminal",
      art: "assets/victory/chud-terminal.webp",
      eyebrow: "BASEMENT DESK / PRIME EXECUTION",
      headline: "HE CANNOT KEEP GETTING AWAY WITH THIS.",
      line: "The room failed inspection. The setup did not."
    }
  ];
  const lossVariants = [
    {
      slug: "wojak-meltdown",
      art: "assets/loss/wojak-meltdown.webp",
      eyebrow: "MARKET FEEDBACK RECEIVED",
      headline: "THE MARKET HAS REVIEWED YOUR THESIS.",
      line: "It returned the document with one red note: absolutely not."
    },
    {
      slug: "burning-bag",
      art: "assets/loss/burning-bag.webp",
      eyebrow: "BAGHOLDER RELIEF PROGRAM",
      headline: "CONGRATS ON THE PREMIUM BAG.",
      line: "Hand-stitched, lightly smoked, and worth considerably less than advertised."
    },
    {
      slug: "risk-audit",
      art: "assets/loss/risk-audit.webp",
      eyebrow: "PARENTAL RISK COMMITTEE",
      headline: "ARE YA RISK-MANAGING, SON?",
      line: "The fire extinguisher suggests the answer arrived before he did."
    },
    {
      slug: "account-crater",
      art: "assets/loss/account-crater.webp",
      eyebrow: "CAPITAL PRESERVATION ADJACENT",
      headline: "CONFIDENCE: UNCHANGED.",
      line: "Capital: changed. Dramatically."
    }
  ];

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
    setupLayout: readStoredSetupLayout(),
    commentsBySetup: new Map(),
    commentErrors: new Map(),
    commentsLoading: new Set(),
    expandedComments: new Set(),
    replyTargets: new Map(),
    followingIds: new Set(),
    followedSetupIds: new Set(),
    setupFollowsAvailable: true,
    notifications: [],
    notificationPreferences: { ...defaultNotificationPreferences },
    notificationsAvailable: true,
    notificationChannel: null,
    outcomeSetupId: null,
    outcomeCardKind: null,
    quoteRefreshActive: false,
    quoteRefreshTimer: null,
    quoteLastRequestedAt: 0,
    quoteResumeListenersBound: false,
    chart: null,
    commandItems: [],
    commandToken: 0,
    rankSearchTimer: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    initTheme();
    bindNavigation();
    bindDialogs();
    bindLeaderboard();
    bindSetupFilters();
    bindSubmissionForm();
    bindCommandPalette();
    bindNotifications();
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
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (button.dataset.viewTarget === "setups") openSetupBook("all");
        else switchView(button.dataset.viewTarget, true);
      });
    });
    $$('[data-open-book]').forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      openSetupBook(link.dataset.openBook);
    }));
  }

  function switchView(viewName, pushHistory = false) {
    $$(".app-view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === viewName));
    $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === viewName));
    if (viewName === "setups") renderNetworkChart();
    if (viewName === "leaderboard") document.title = "Leaderboard — Composite Operator Ledger";
    if (viewName === "overview") document.title = "Ledger — Composite Operator";
    const nextUrl = new URL(location.href);
    if (viewName !== "setups") nextUrl.searchParams.delete("book");
    nextUrl.hash = viewName === "overview" ? "" : viewName;
    history[pushHistory ? "pushState" : "replaceState"](null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSetupBook(bookName, pushHistory = true) {
    const book = setupBooks[bookName] ? bookName : "all";
    state.setupState = book;
    syncSetupBookUI();
    renderSetups();
    $$(".app-view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === "setups"));
    $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === "setups"));
    document.title = book === "all" ? "Ledger — Composite Operator" : `${setupBooks[book].title} — Composite Operator Ledger`;
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("book", book);
    nextUrl.hash = "setups";
    history[pushHistory ? "pushState" : "replaceState"](null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    renderNetworkChart();
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestQuoteRefreshIfStale(quoteResumeMinimumMs);
  }

  function syncSetupBookUI() {
    const book = setupBooks[state.setupState] || setupBooks.all;
    $("#setup-book-kicker").textContent = book.kicker;
    $("#setup-book-title").textContent = book.title;
    $("#setup-book-description").textContent = book.description;
    $$('[data-setup-state]').forEach((item) => item.classList.toggle("is-active", item.dataset.setupState === state.setupState));
  }

  function navigateToSetup(setupId, bookName) {
    const profileDialog = $("#profile-dialog");
    if (profileDialog?.open) profileDialog.close();
    openSetupBook(bookName || "all");
    requestAnimationFrame(() => {
      const card = document.getElementById(`setup-${setupId}`);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("is-context-jump");
      setTimeout(() => card.classList.remove("is-context-jump"), 1800);
    });
  }

  function bindDialogs() {
    const authDialog = $("#auth-dialog");
    const submitDialog = $("#submit-dialog");
    const methodDialog = $("#method-dialog");
    const symbolGuideDialog = $("#symbol-guide-dialog");
    const outcomeDialog = $("#outcome-dialog");

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
    $("[data-close-auth]").addEventListener("click", () => authDialog.close());
    $("#open-methodology").addEventListener("click", () => methodDialog.showModal());
    $$('[data-close-method]').forEach((button) => button.addEventListener("click", () => methodDialog.close()));
    $$('[data-open-symbol-guide]').forEach((button) => button.addEventListener("click", () => symbolGuideDialog.showModal()));
    $$('[data-close-symbol-guide]').forEach((button) => button.addEventListener("click", () => symbolGuideDialog.close()));
    $("[data-close-outcome]").addEventListener("click", () => outcomeDialog.close());
    $("[data-share-outcome]").addEventListener("click", () => {
      const setup = state.setups.find((item) => String(item.id) === String(state.outcomeSetupId));
      if (!setup) return;
      if (state.outcomeCardKind === "loss") void shareLossSetup(setup);
      else void shareVictorySetup(setup);
    });
    outcomeDialog.addEventListener("close", () => {
      state.outcomeSetupId = null;
      state.outcomeCardKind = null;
      const nextUrl = new URL(location.href);
      if (!nextUrl.searchParams.has("victory") && !nextUrl.searchParams.has("loss")) return;
      nextUrl.searchParams.delete("victory");
      nextUrl.searchParams.delete("loss");
      history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    });
    $$('[data-copy-symbol]').forEach((button) => button.addEventListener("click", async () => {
      const symbol = button.dataset.copySymbol;
      const tickerInput = $("#ticker");
      tickerInput.value = symbol;
      try {
        await navigator.clipboard.writeText(symbol);
        showToast("Symbol selected", `${symbol} was copied and loaded into the setup form.`);
      } catch (_error) {
        showToast("Symbol selected", `${symbol} was loaded into the setup form.`);
      }
    }));
    $("#auth-form").addEventListener("submit", (event) => {
      event.preventDefault();
      authenticateWithPassword("signin");
    });
    $("#credential-sign-up").addEventListener("click", () => authenticateWithPassword("signup"));

    const dialogs = [authDialog, submitDialog, methodDialog, symbolGuideDialog, outcomeDialog, $("#command-dialog"), $("#profile-dialog")];
    let overlayScrollY = 0;
    let overlayScrollLocked = false;
    const syncOverlayScrollLock = () => {
      const hasOpenDialog = dialogs.some((dialog) => dialog.open);
      if (hasOpenDialog && !overlayScrollLocked) {
        overlayScrollY = window.scrollY;
        document.documentElement.classList.add("overlay-open");
        document.body.classList.add("overlay-open");
        overlayScrollLocked = true;
      } else if (!hasOpenDialog && overlayScrollLocked) {
        document.documentElement.classList.remove("overlay-open");
        document.body.classList.remove("overlay-open");
        window.scrollTo(0, overlayScrollY);
        overlayScrollLocked = false;
      }
    };

    dialogs.forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener("close", syncOverlayScrollLock);
      dialog.addEventListener("cancel", () => requestAnimationFrame(syncOverlayScrollLock));
      new MutationObserver(syncOverlayScrollLock).observe(dialog, { attributes: true, attributeFilter: ["open"] });
    });
    document.addEventListener("keydown", (event) => {
      if (!overlayScrollLocked || isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const scrollKeys = new Set(["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "]);
      if (!scrollKeys.has(event.key)) return;
      const openDialog = dialogs.find((dialog) => dialog.open);
      const scrollTarget = openDialog?.querySelector(".profile-drawer, .submit-card, .command-results, .modal-card");
      event.preventDefault();
      if (!scrollTarget || scrollTarget.scrollHeight <= scrollTarget.clientHeight) return;
      if (event.key === "Home") scrollTarget.scrollTo({ top: 0, behavior: "smooth" });
      else if (event.key === "End") scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: "smooth" });
      else {
        const direction = ["PageUp", "ArrowUp"].includes(event.key) ? -1 : 1;
        const distance = event.key.startsWith("Arrow") ? 48 : Math.max(180, scrollTarget.clientHeight * 0.8);
        scrollTarget.scrollBy({ top: direction * distance, behavior: "smooth" });
      }
    }, true);
    syncOverlayScrollLock();
  }

  async function connectLiveData() {
    try {
      state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" }
      });

      const { data: sessionData } = await state.supabase.auth.getSession();
      state.session = sessionData.session;
      await hydrateSignedInProfile();
      await loadAccountFeatures();
      syncNotificationSubscription();
      updateAccountUI();

      state.supabase.auth.onAuthStateChange(async (_event, session) => {
        state.session = session;
        await hydrateSignedInProfile();
        await loadAccountFeatures();
        syncNotificationSubscription();
        updateAccountUI();
        updateFormAuthState();
        renderSetups();
      });

      state.live = true;
      await loadLiveData();
      setNetworkState("Ledger connected", false);
      renderAll();
      await activateSharedSetup();
      startQuoteRefreshLoop();
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
    await hydrateFollowedSetups();
    void refreshSetupQuotes();
  }

  async function loadAccountFeatures() {
    if (!state.supabase || !state.session?.user) {
      state.followingIds = new Set();
      state.followedSetupIds = new Set();
      state.setupFollowsAvailable = true;
      state.notifications = [];
      state.notificationPreferences = { ...defaultNotificationPreferences };
      state.notificationsAvailable = true;
      renderNotificationUI();
      return;
    }

    const userId = state.session.user.id;
    const [followingResult, setupFollowsResult, preferencesResult, notificationsResult] = await Promise.all([
      state.supabase.from("operator_follows").select("following_id").eq("follower_id", userId),
      state.supabase.from("setup_follows").select("setup_id").eq("follower_id", userId).order("created_at", { ascending: false }).limit(500),
      state.supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(),
      state.supabase.from("notification_feed").select("*").order("created_at", { ascending: false }).limit(100)
    ]);

    const featureError = followingResult.error || preferencesResult.error || notificationsResult.error;
    if (featureError) {
      state.followingIds = new Set();
      state.followedSetupIds = new Set();
      state.setupFollowsAvailable = !setupFollowsResult.error;
      state.notifications = [];
      state.notificationPreferences = { ...defaultNotificationPreferences };
      state.notificationsAvailable = false;
      renderNotificationUI();
      console.warn("Account notification features are unavailable.", featureError);
      return;
    }

    state.notificationsAvailable = true;
    state.followingIds = new Set((followingResult.data || []).map((row) => String(row.following_id)));
    state.setupFollowsAvailable = !setupFollowsResult.error;
    state.followedSetupIds = new Set((setupFollowsResult.data || []).map((row) => String(row.setup_id)));
    state.notificationPreferences = { ...defaultNotificationPreferences, ...(preferencesResult.data || {}) };
    state.notifications = notificationsResult.data || [];

    if (setupFollowsResult.error) console.warn("Setup follows are unavailable.", setupFollowsResult.error);

    if (!preferencesResult.data) {
      const { data } = await state.supabase
        .from("notification_preferences")
        .insert({ user_id: userId })
        .select("*")
        .single();
      if (data) state.notificationPreferences = { ...defaultNotificationPreferences, ...data };
    }
    await hydrateFollowedSetups();
    renderNotificationUI();
  }

  async function hydrateFollowedSetups() {
    if (!state.supabase || !state.session?.user || !state.followedSetupIds.size || !state.setupFollowsAvailable) return;
    const loadedIds = new Set(state.setups.map((setup) => String(setup.id)));
    const missingIds = [...state.followedSetupIds].filter((setupId) => !loadedIds.has(setupId));
    for (let offset = 0; offset < missingIds.length; offset += 100) {
      const batch = missingIds.slice(offset, offset + 100);
      const { data, error } = await state.supabase.from("setups_public").select("*").in("id", batch);
      if (error) {
        console.warn("Followed setup hydration failed.", error);
        return;
      }
      state.setups.push(...(data || []).map(normalizeSetup));
    }
  }

  async function loadNotifications() {
    if (!state.supabase || !state.session?.user || !state.notificationsAvailable) return;
    const { data, error } = await state.supabase
      .from("notification_feed")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      console.warn("Notification inbox refresh failed.", error);
      return;
    }
    state.notifications = data || [];
    renderNotificationUI();
  }

  function syncNotificationSubscription() {
    if (!state.supabase) return;
    if (state.notificationChannel) {
      state.supabase.removeChannel(state.notificationChannel);
      state.notificationChannel = null;
    }
    if (!state.session?.user || !state.notificationsAvailable) return;

    const userId = state.session.user.id;
    state.notificationChannel = state.supabase
      .channel(`ledger-notifications-${userId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_id=eq.${userId}`
      }, async () => {
        await loadNotifications();
        const newest = state.notifications[0];
        if (newest && !state.notificationPreferences.notifications_muted) {
          showToast("New Ledger alert", notificationMessage(newest));
        }
      })
      .subscribe();
  }

  async function refreshSetupQuotes() {
    if (!state.live || state.quoteRefreshActive) return;
    const tickers = preferredQuoteTickers();
    state.quoteRefreshActive = true;
    state.quoteLastRequestedAt = Date.now();
    setQuoteState("REFRESHING PRICES", "is-loading");
    try {
      const response = await fetch(`${config.supabaseUrl}/functions/v1/setup-book-quotes`, {
        method: "POST",
        headers: {
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${config.supabasePublishableKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tickers })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.quotes) {
        setQuoteState("STORED PRICES", "");
        return;
      }
      const hydratedTickers = new Set();
      state.setups.forEach((setup) => {
        if (!isTrackableSetup(setup)) return;
        const quote = payload.quotes[setup.ticker];
        if (!quote || !Number.isFinite(Number(quote.price))) return;
        const entryRatio = Number.isFinite(setup.entry) && setup.entry > 0 ? Math.abs(Number(quote.price) - setup.entry) / setup.entry : 0;
        const unambiguousAsset = ["CRYPTO", "FUTURE", "INDEX", "FOREX"].includes(String(quote.assetClass || ""));
        if (entryRatio > 0.5 && !unambiguousAsset) return;
        setup.current_price = Number(quote.price);
        setup.live_quote_source = quote.source;
        setup.live_quote_at = quote.quotedAt;
        setup.quote_symbol = quote.resolvedSymbol || setup.ticker;
        setup.quote_asset_class = quote.assetClass || null;
        hydratedTickers.add(setup.ticker);
      });
      const quoteCount = hydratedTickers.size;
      setQuoteState(`${quoteCount} LIVE QUOTE${quoteCount === 1 ? "" : "S"}`, "is-live");
      renderSetups();
    } catch (error) {
      console.warn("Setup-book quote refresh failed", error);
      setQuoteState("STORED PRICES", "");
    } finally {
      state.quoteRefreshActive = false;
    }
  }

  function preferredQuoteTickers() {
    const visibleSetups = filteredSetups().filter(isTrackableSetup);
    const remainingSetups = state.setups.filter(isTrackableSetup);
    return [...new Set([...visibleSetups, ...remainingSetups]
      .map((setup) => String(setup.ticker || "").trim().toUpperCase())
      .filter(Boolean))].slice(0, 80);
  }

  function isTrackableSetup(setup) {
    return !setup.final_status && normalizeState(setup.status) !== "resolved";
  }

  function requestQuoteRefreshIfStale(minimumAgeMs = quoteRefreshMinimumMs) {
    if (!state.live || document.visibilityState === "hidden") return;
    if (Date.now() - state.quoteLastRequestedAt < minimumAgeMs) return;
    void refreshSetupQuotes();
  }

  function startQuoteRefreshLoop() {
    if (state.quoteRefreshTimer) clearTimeout(state.quoteRefreshTimer);
    if (!state.quoteResumeListenersBound) {
      const refreshAfterResume = () => requestQuoteRefreshIfStale(quoteResumeMinimumMs);
      document.addEventListener("visibilitychange", refreshAfterResume);
      window.addEventListener("focus", refreshAfterResume);
      state.quoteResumeListenersBound = true;
    }

    const schedule = () => {
      const delay = quoteRefreshMinimumMs + Math.round(Math.random() * quoteRefreshJitterMs);
      state.quoteRefreshTimer = setTimeout(async () => {
        if (document.visibilityState !== "hidden") await refreshSetupQuotes();
        schedule();
      }, delay);
    };
    schedule();
  }

  function setQuoteState(label, className) {
    const node = $("#quote-refresh-state");
    if (!node) return;
    node.className = `quote-state${className ? ` ${className}` : ""}`;
    node.innerHTML = `<i></i> ${escapeHtml(label)}`;
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
      bio: row.bio || "",
      created_at: row.created_at || null
    };
  }

  function normalizeSetup(row) {
    const thesisAttachment = parseAttachmentText(row.thesis);
    return {
      ...row,
      handle: row.handle || row.profile_handle || "operator",
      ticker: String(row.ticker || "").toUpperCase(),
      direction: String(row.direction || "LONG").toUpperCase(),
      status: String(row.status || "QUEUED").toUpperCase(),
      thesis: thesisAttachment.text,
      thesis_image_path: thesisAttachment.path,
      entry: nullableNumber(row.entry),
      stop: nullableNumber(row.stop),
      t1: nullableNumber(row.t1),
      t2: nullableNumber(row.t2),
      t3: nullableNumber(row.t3),
      current_price: nullableNumber(row.current_price),
      score: nullableNumber(row.score),
      r_result: nullableNumber(row.r_result),
      comment_count: Number(row.comment_count || 0),
      operator_total_setups: Number(row.operator_total_setups || 0),
      operator_triggered_setups: Number(row.operator_triggered_setups || 0),
      operator_win_rate: nullableNumber(row.operator_win_rate),
      operator_avg_r: nullableNumber(row.operator_avg_r),
      operator_goat_score: nullableNumber(row.operator_goat_score)
    };
  }

  function normalizeComment(row) {
    const attachment = parseAttachmentText(row.body);
    const replyAttachment = parseAttachmentText(row.reply_to_body);
    return {
      ...row,
      body: attachment.text,
      image_path: attachment.path,
      reply_to_body: replyAttachment.text,
      reply_to_image_path: replyAttachment.path
    };
  }

  async function authenticateWithPassword(mode) {
    if (!state.supabase) {
      showToast("Account system is not active yet", "Connect the free Supabase project first.", true);
      return;
    }
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const handle = $("#auth-handle").value.trim().toLowerCase();

    $("#auth-inline-status").classList.remove("is-error", "is-success");
    if (!email || !email.includes("@")) return setAuthStatus("Enter a valid email address.", true);
    if (password.length < 8) return setAuthStatus("Use a password with at least 8 characters.", true);
    if (mode === "signup" && !/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)) {
      return setAuthStatus("Handle: 3–30 letters, numbers, underscores, or hyphens.", true);
    }

    setAuthBusy(true);
    setAuthStatus(mode === "signup" ? "Creating your Ledger account…" : "Signing in…");
    try {
      if (mode === "signup") {
        const { data, error } = await state.supabase.auth.signUp({
          email,
          password,
          options: { data: { user_name: handle, name: handle } }
        });
        if (error) throw error;
        if (data.session) {
          $("#auth-dialog").close();
          showToast("Account created", `Welcome to the Ledger, @${handle}.`);
        } else {
          setAuthStatus("Account created. Check your email if confirmation is enabled.", false, true);
        }
      } else {
        const { error } = await state.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        $("#auth-dialog").close();
        showToast("Signed in", "Your Ledger account is active.");
      }
      $("#auth-password").value = "";
    } catch (error) {
      setAuthStatus(error.message || "Authentication failed.", true);
    } finally {
      setAuthBusy(false);
    }
  }

  function setAuthStatus(message, isError = false, isSuccess = false) {
    const status = $("#auth-inline-status");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
    status.classList.toggle("is-success", isSuccess);
  }

  function setAuthBusy(busy) {
    [$("#credential-sign-in"), $("#credential-sign-up")].forEach((button) => { button.disabled = busy; });
  }

  function updateAccountUI() {
    const label = $("#account-label");
    const avatar = $("#account-avatar");
    if (!state.session?.user) {
      label.textContent = "Sign in";
      avatar.textContent = "CO";
      renderNotificationUI();
      return;
    }
    const handle = state.profile?.handle || state.session.user.user_metadata?.user_name || state.session.user.user_metadata?.name || "Operator";
    label.textContent = handle;
    avatar.innerHTML = state.profile?.avatar_url
      ? `<img src="${escapeAttr(state.profile.avatar_url)}" alt="">`
      : escapeHtml(initials(handle));
    renderNotificationUI();
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
      bio: state.profile?.bio || "",
      created_at: state.profile?.created_at || state.session?.user?.created_at || null
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
      <div class="podium-metrics"><div><span>WIN RATE</span><b>${formatPercent(leader.win_rate)}</b></div><div><span>AVG R</span><b>${formatR(leader.avg_r)}</b></div><div><span>TRIGGERED</span><b>${formatInteger(leader.triggered_setups)}</b></div></div>
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
    let detailedLeader = { ...leader };
    let profileSetups = state.setups.filter((setup) => String(setup.user_id) === String(leader.id) || setup.handle === leader.handle);
    if (state.live && state.supabase && leader.id) {
      const [profileResult, setupsResult, metricsResult, socialResult] = await Promise.all([
        state.supabase.from("profiles").select("id, handle, display_name, avatar_url, bio, created_at").eq("id", leader.id).maybeSingle(),
        state.supabase.from("setups_public").select("*").eq("user_id", leader.id).order("submitted_at", { ascending: false }).limit(100),
        state.supabase.rpc("leaderboard_page", { p_sort: "goat", p_search: leader.handle || "", p_limit: 5, p_offset: 0 }),
        state.supabase.rpc("operator_social_summary", { p_profile_id: leader.id })
      ]);
      const metricRow = (metricsResult.data || []).map(normalizeLeader).find((item) => String(item.id) === String(leader.id));
      if (metricRow) detailedLeader = { ...detailedLeader, ...metricRow };
      if (profileResult.data) detailedLeader = { ...detailedLeader, ...profileResult.data, id: profileResult.data.id };
      if (setupsResult.data) {
        profileSetups = setupsResult.data.map(normalizeSetup);
        const loadedSetupIndexes = new Map(state.setups.map((setup, index) => [String(setup.id), index]));
        profileSetups.forEach((setup) => {
          const loadedIndex = loadedSetupIndexes.get(String(setup.id));
          if (loadedIndex === undefined) {
            loadedSetupIndexes.set(String(setup.id), state.setups.length);
            state.setups.push(setup);
          } else {
            state.setups[loadedIndex] = { ...state.setups[loadedIndex], ...setup };
          }
        });
      }
      if (socialResult.data?.[0]) detailedLeader = { ...detailedLeader, ...socialResult.data[0] };
    }
    const recent = profileSetups.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 100);
    const drawer = $("#profile-drawer");
    const isOwnProfile = Boolean(state.session?.user && String(state.session.user.id) === String(detailedLeader.id));
    const isFollowing = state.followingIds.has(String(detailedLeader.id));
    const followedSetups = isOwnProfile
      ? state.setups.filter((setup) => state.followedSetupIds.has(String(setup.id))).sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
      : [];
    drawer.innerHTML = `<button class="modal-close profile-close" type="button" data-close-profile aria-label="Close profile">×</button>
    <div class="profile-head">
      <div class="profile-avatar-large">${profileAvatar(detailedLeader)}</div>
      <h2>${escapeHtml(detailedLeader.display_name || detailedLeader.handle)}</h2>
      <p class="profile-handle">@${escapeHtml(detailedLeader.handle)}</p>
      <p class="profile-bio">${escapeHtml(detailedLeader.bio || "No bio yet.")}</p>
      <div class="profile-badges"><span>LEDGER ACCOUNT</span><span>PUBLIC RECORD</span><span>JOINED ${escapeHtml(formatMonthYear(detailedLeader.created_at))}</span><span>${detailedLeader.triggered_setups || 0} TRIGGERED</span><span>${formatInteger(detailedLeader.follower_count)} FOLLOWERS</span><span>${formatInteger(detailedLeader.following_count)} FOLLOWING</span></div>
      ${isOwnProfile
        ? '<button class="profile-signout" type="button" data-sign-out>Sign out</button>'
        : `<button class="profile-follow-button${isFollowing ? " is-following" : ""}" type="button" data-follow-profile="${escapeAttr(detailedLeader.id)}">${state.session?.user ? (isFollowing ? "FOLLOWING" : "FOLLOW OPERATOR") : "SIGN IN TO FOLLOW"}</button>`}
    </div>
    <div class="profile-body">
      <div class="profile-metric-grid">
        <div><span>GOAT SCORE</span><b>${formatNumber(detailedLeader.goat_score, 2, "NQ")}</b></div>
        <div><span>WIN RATE</span><b>${formatPercent(detailedLeader.win_rate)}</b></div>
        <div><span>AVG R</span><b class="${metricClass(detailedLeader.avg_r)}">${formatR(detailedLeader.avg_r)}</b></div>
        <div><span>TOTAL SCORE</span><b class="${metricClass(detailedLeader.total_score)}">${formatSigned(detailedLeader.total_score)}</b></div>
        <div><span>30D SCORE</span><b class="${metricClass(detailedLeader.last_30d_score)}">${formatSigned(detailedLeader.last_30d_score)}</b></div>
        <div><span>TOTAL SETUPS</span><b>${formatInteger(detailedLeader.total_setups)}</b></div>
        <div><span>TRIGGERED</span><b>${formatInteger(detailedLeader.triggered_setups)}</b></div>
        <div><span>STOPPED</span><b>${formatInteger(detailedLeader.stopped_setups)}</b></div>
        <div><span>TARGET HITS</span><b><small>T1</small> ${formatInteger(detailedLeader.t1_hits)} <small>T2</small> ${formatInteger(detailedLeader.t2_hits)} <small>T3</small> ${formatInteger(detailedLeader.t3_hits)}</b></div>
      </div>
      ${isOwnProfile ? `${profileEditor(detailedLeader)}${notificationSettingsPanel()}` : ""}
      ${isOwnProfile ? followedSetupDashboard(followedSetups) : ""}
      <div class="profile-section-title">PUBLIC RECORDS <span>${recent.length}</span></div>
      <div class="profile-records">${recent.length ? recent.map(profileRecord).join("") : '<div class="table-empty">No public setups yet.</div>'}</div>
    </div>`;
    $("[data-close-profile]", drawer).addEventListener("click", () => $("#profile-dialog").close());
    const signOutButton = $("[data-sign-out]", drawer);
    if (signOutButton) signOutButton.addEventListener("click", signOut);
    const followButton = $("[data-follow-profile]", drawer);
    if (followButton) followButton.addEventListener("click", () => toggleFollow(detailedLeader));
    const profileForm = $("[data-profile-form]", drawer);
    if (profileForm) profileForm.addEventListener("submit", (event) => saveProfile(event, detailedLeader));
    const notificationForm = $("[data-notification-settings-form]", drawer);
    if (notificationForm) notificationForm.addEventListener("submit", saveNotificationSettings);
    const openFollowedBookButton = $("[data-open-followed-book]", drawer);
    if (openFollowedBookButton) openFollowedBookButton.addEventListener("click", () => {
      $("#profile-dialog").close();
      openSetupBook("followed");
    });
    $$('[data-profile-open-setup]', drawer).forEach((record) => {
      const openProfileSetup = () => {
        const setupId = String(record.dataset.profileOpenSetup);
        const targetBook = record.dataset.profileSetupBook || "all";
        navigateToSetup(setupId, targetBook);
      };
      record.addEventListener("click", (event) => {
        if (!event.target.closest("[data-profile-unfollow-setup]")) openProfileSetup();
      });
      record.addEventListener("keydown", (event) => {
        if (event.target.closest("[data-profile-unfollow-setup]")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openProfileSetup();
      });
    });
    $$('[data-profile-unfollow-setup]', drawer).forEach((button) => button.addEventListener("click", async () => {
      const setup = state.setups.find((item) => String(item.id) === String(button.dataset.profileUnfollowSetup));
      if (setup) await toggleSetupFollow(setup, true);
    }));
    const avatarInput = $("input[name='avatar']", drawer);
    if (avatarInput) avatarInput.addEventListener("change", () => updateAvatarFileLabel(avatarInput));
    if (!$("#profile-dialog").open) $("#profile-dialog").showModal();
  }

  function profileAvatar(profile) {
    if (profile.avatar_url) return `<img src="${escapeAttr(profile.avatar_url)}" alt="${escapeAttr(profile.display_name || profile.handle)} profile picture">`;
    return escapeHtml(initials(profile.handle));
  }

  function profileEditor(profile) {
    return `<details class="profile-editor">
      <summary><span>EDIT PUBLIC PROFILE</span><i>OPEN +</i></summary>
      <form data-profile-form>
        <label><span>PROFILE PICTURE</span><input name="avatar" type="file" accept="image/jpeg,image/png,image/webp"><small data-avatar-file>JPG, PNG, or WEBP · 2 MB maximum</small></label>
        <label><span>DISPLAY NAME</span><input name="display_name" type="text" maxlength="80" required value="${escapeAttr(profile.display_name || profile.handle)}"></label>
        <label><span>BIO</span><textarea name="bio" maxlength="600" rows="5" placeholder="What do you trade? What is your process?">${escapeHtml(profile.bio || "")}</textarea></label>
        <p class="profile-form-status" data-profile-status></p>
        <button type="submit">SAVE PROFILE <span>→</span></button>
      </form>
    </details>`;
  }

  function notificationSettingsPanel() {
    const preferences = state.notificationPreferences;
    return `<details class="profile-editor notification-settings" data-notification-settings>
      <summary><span>NOTIFICATION SETTINGS</span><i>OPEN +</i></summary>
      <form data-notification-settings-form>
        <p class="notification-settings-copy">Choose which operator activity and followed-setup milestones enter your private alert feed.</p>
        ${notificationSetting("notifications_muted", "MUTE ALL ALERTS", "Pause delivery without changing your channel choices.", preferences.notifications_muted)}
        ${notificationSetting("notify_new_setups", "NEW SETUPS", "Alert when a followed operator publishes a setup.", preferences.notify_new_setups)}
        ${notificationSetting("notify_comments", "NEW COMMENTS", "Alert when a followed operator comments on any setup.", preferences.notify_comments)}
        ${notificationSetting("notify_entry_hits", "OPERATOR ENTRY ACHIEVED", "Alert when a followed operator's setup reaches entry.", preferences.notify_entry_hits)}
        ${notificationSetting("notify_followed_setup_hot", "FOLLOWED SETUP GOES HOT", "Alert when an individually followed setup enters the Hot book.", preferences.notify_followed_setup_hot)}
        ${notificationSetting("notify_followed_setup_entry", "FOLLOWED SETUP ENTRY", "Alert when an individually followed setup reaches entry.", preferences.notify_followed_setup_entry)}
        ${notificationSetting("notify_followed_setup_targets", "FOLLOWED SETUP TARGETS", "Alert separately when T1, T2, or T3 is recorded.", preferences.notify_followed_setup_targets)}
        ${notificationSetting("notify_followed_setup_stops", "FOLLOWED SETUP STOP-OUT", "Alert when the published stop is recorded.", preferences.notify_followed_setup_stops)}
        ${notificationSetting("notify_wins", "VICTORY CARDS", "Alert when your setup, a followed setup, or a followed operator closes green.", preferences.notify_wins)}
        ${notificationSetting("notify_losses", "LOSS CARDS", "Alert when your setup, a followed setup, or a followed operator closes red.", preferences.notify_losses)}
        <p class="profile-form-status" data-notification-settings-status></p>
        <button type="submit">SAVE NOTIFICATIONS <span>→</span></button>
      </form>
    </details>`;
  }

  function notificationSetting(name, label, description, checked) {
    return `<label class="notification-setting-row">
      <span><b>${escapeHtml(label)}</b><small>${escapeHtml(description)}</small></span>
      <input type="checkbox" name="${escapeAttr(name)}" ${checked ? "checked" : ""}>
      <i aria-hidden="true"></i>
    </label>`;
  }

  async function saveNotificationSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("button[type='submit']", form);
    const status = $("[data-notification-settings-status]", form);
    const data = new FormData(form);
    const nextPreferences = {
      notifications_muted: data.has("notifications_muted"),
      notify_new_setups: data.has("notify_new_setups"),
      notify_comments: data.has("notify_comments"),
      notify_entry_hits: data.has("notify_entry_hits"),
      notify_followed_setup_hot: data.has("notify_followed_setup_hot"),
      notify_followed_setup_entry: data.has("notify_followed_setup_entry"),
      notify_followed_setup_targets: data.has("notify_followed_setup_targets"),
      notify_followed_setup_stops: data.has("notify_followed_setup_stops"),
      notify_wins: data.has("notify_wins"),
      notify_losses: data.has("notify_losses")
    };
    button.disabled = true;
    button.textContent = "SAVING...";
    setProfileFormStatus(status, "Saving your alert channels...");
    try {
      await persistNotificationPreferences(nextPreferences);
      setProfileFormStatus(status, "Notification settings saved.");
      button.innerHTML = 'SAVE NOTIFICATIONS <span>→</span>';
      button.disabled = false;
      showToast("Notification settings saved", nextPreferences.notifications_muted ? "New alerts are muted." : "Your selected alert channels are active.");
    } catch (error) {
      button.innerHTML = 'SAVE NOTIFICATIONS <span>→</span>';
      button.disabled = false;
      setProfileFormStatus(status, error.message || "Notification settings could not be saved.", true);
    }
  }

  async function persistNotificationPreferences(patch) {
    if (!state.supabase || !state.session?.user) throw new Error("Sign in to change notification settings.");
    const merged = { ...state.notificationPreferences, ...patch };
    const preferenceValues = {
      notifications_muted: Boolean(merged.notifications_muted),
      notify_new_setups: Boolean(merged.notify_new_setups),
      notify_comments: Boolean(merged.notify_comments),
      notify_entry_hits: Boolean(merged.notify_entry_hits),
      notify_followed_setup_hot: Boolean(merged.notify_followed_setup_hot),
      notify_followed_setup_entry: Boolean(merged.notify_followed_setup_entry),
      notify_followed_setup_targets: Boolean(merged.notify_followed_setup_targets),
      notify_followed_setup_stops: Boolean(merged.notify_followed_setup_stops),
      notify_wins: Boolean(merged.notify_wins),
      notify_losses: Boolean(merged.notify_losses)
    };
    let { data, error } = await state.supabase
      .from("notification_preferences")
      .update(preferenceValues)
      .eq("user_id", state.session.user.id)
      .select("*")
      .maybeSingle();
    if (!error && !data) {
      const insertResult = await state.supabase
        .from("notification_preferences")
        .insert({ user_id: state.session.user.id, ...preferenceValues })
        .select("*")
        .single();
      data = insertResult.data;
      error = insertResult.error;
    }
    if (error) throw error;
    state.notificationPreferences = { ...defaultNotificationPreferences, ...data };
    renderNotificationUI();
  }

  async function toggleFollow(profile) {
    if (!state.session?.user || !state.supabase) {
      $("#profile-dialog").close();
      $("#auth-dialog").showModal();
      return;
    }
    const profileId = String(profile.id);
    const isFollowing = state.followingIds.has(profileId);
    const button = $("[data-follow-profile]", $("#profile-drawer"));
    if (button) {
      button.disabled = true;
      button.textContent = isFollowing ? "UNFOLLOWING..." : "FOLLOWING...";
    }
    const query = isFollowing
      ? state.supabase.from("operator_follows").delete().eq("follower_id", state.session.user.id).eq("following_id", profileId)
      : state.supabase.from("operator_follows").insert({ follower_id: state.session.user.id, following_id: profileId });
    const { error } = await query;
    if (error) {
      if (button) {
        button.disabled = false;
        button.textContent = isFollowing ? "FOLLOWING" : "FOLLOW OPERATOR";
      }
      showToast("Follow action failed", error.message, true);
      return;
    }
    if (isFollowing) state.followingIds.delete(profileId);
    else state.followingIds.add(profileId);
    showToast(isFollowing ? "Operator unfollowed" : "Operator followed", isFollowing ? `Alerts from @${profile.handle} are off.` : `Future activity from @${profile.handle} can now reach your alert feed.`);
    await openProfile(profile);
  }

  async function toggleSetupFollow(setup, refreshProfile = false) {
    if (!state.session?.user || !state.supabase) {
      if ($("#profile-dialog")?.open) $("#profile-dialog").close();
      $("#auth-dialog").showModal();
      return;
    }
    if (!state.setupFollowsAvailable) {
      showToast("Setup follows unavailable", "The setup-follow database update is not active yet.", true);
      return;
    }

    const setupId = String(setup.id);
    const isFollowing = state.followedSetupIds.has(setupId);
    const buttons = $$('[data-follow-setup], [data-profile-unfollow-setup]').filter((button) =>
      String(button.dataset.followSetup || button.dataset.profileUnfollowSetup) === setupId
    );
    buttons.forEach((button) => {
      button.disabled = true;
      button.textContent = isFollowing ? "UNFOLLOWING…" : "FOLLOWING…";
    });

    const query = isFollowing
      ? state.supabase.from("setup_follows").delete().eq("follower_id", state.session.user.id).eq("setup_id", setupId)
      : state.supabase.from("setup_follows").insert({ follower_id: state.session.user.id, setup_id: setupId });
    const { error } = await query;
    if (error) {
      buttons.forEach((button) => {
        button.disabled = false;
        button.textContent = button.matches("[data-profile-unfollow-setup]") ? "UNFOLLOW" : (isFollowing ? "FOLLOWING ✓" : "FOLLOW SETUP +");
      });
      renderSetups();
      showToast("Setup follow failed", error.message, true);
      return;
    }

    if (isFollowing) state.followedSetupIds.delete(setupId);
    else state.followedSetupIds.add(setupId);
    renderSetups();
    showToast(
      isFollowing ? "Setup unfollowed" : "Setup followed",
      isFollowing
        ? `${setup.ticker} was removed from your personal watchlist.`
        : `${setup.ticker} is on your dashboard. Hot, entry, target, and stop alerts are active.`
    );

    if (refreshProfile) {
      const ownLeader = [...state.leaders, ...state.compactLeaders].find((leader) => String(leader.id) === String(state.session.user.id)) || profileFromSession();
      await openProfile(ownLeader);
    }
  }

  function updateAvatarFileLabel(input) {
    const file = input.files?.[0];
    const label = $("[data-avatar-file]", input.closest("form"));
    if (label) label.textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : "JPG, PNG, or WEBP · 2 MB maximum";
  }

  async function saveProfile(event, leader) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $("[data-profile-status]", form);
    const button = $("button[type='submit']", form);
    const displayName = String(new FormData(form).get("display_name") || "").trim();
    const bio = String(new FormData(form).get("bio") || "").trim();
    const avatarFile = $("input[name='avatar']", form).files?.[0] || null;
    if (!displayName) return setProfileFormStatus(status, "Display name is required.", true);
    if (bio.length > 600) return setProfileFormStatus(status, "Bio must be 600 characters or fewer.", true);
    if (avatarFile && (!['image/jpeg', 'image/png', 'image/webp'].includes(avatarFile.type) || avatarFile.size > 2097152)) {
      return setProfileFormStatus(status, "Use a JPG, PNG, or WEBP image no larger than 2 MB.", true);
    }

    button.disabled = true;
    button.textContent = avatarFile ? "UPLOADING…" : "SAVING…";
    setProfileFormStatus(status, "Saving your public profile…");
    try {
      let avatarUrl = leader.avatar_url || null;
      if (avatarFile) {
        const objectPath = `${state.session.user.id}/avatar`;
        const { error: uploadError } = await state.supabase.storage.from("avatars").upload(objectPath, avatarFile, {
          cacheControl: "3600",
          contentType: avatarFile.type,
          upsert: true
        });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = state.supabase.storage.from("avatars").getPublicUrl(objectPath);
        avatarUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;
      }

      const { data, error } = await state.supabase
        .from("profiles")
        .update({ display_name: displayName, bio, avatar_url: avatarUrl })
        .eq("id", state.session.user.id)
        .select("*")
        .single();
      if (error) throw error;
      applyProfileUpdate(data);
      renderAll();
      showToast("Profile updated", "Your avatar, bio, and public profile are live.");
      await openProfile({ ...leader, ...data });
    } catch (error) {
      button.disabled = false;
      button.innerHTML = 'SAVE PROFILE <span>→</span>';
      setProfileFormStatus(status, error.message || "The profile could not be saved.", true);
    }
  }

  function setProfileFormStatus(node, message, isError = false) {
    node.textContent = message;
    node.classList.toggle("is-error", isError);
  }

  function applyProfileUpdate(profile) {
    state.profile = { ...state.profile, ...profile };
    const patchLeader = (item) => String(item.id) === String(profile.id) ? { ...item, ...profile } : item;
    state.leaders = state.leaders.map(patchLeader);
    state.compactLeaders = state.compactLeaders.map(patchLeader);
    state.podiumLeaders = state.podiumLeaders.map(patchLeader);
    state.setups.forEach((setup) => {
      if (String(setup.user_id) !== String(profile.id)) return;
      setup.display_name = profile.display_name;
      setup.avatar_url = profile.avatar_url;
    });
  }

  async function signOut() {
    if (!state.supabase) return;
    const { error } = await state.supabase.auth.signOut();
    if (error) return showToast("Sign-out failed", error.message, true);
    $("#profile-dialog").close();
    showToast("Signed out", "Your public Ledger remains available.");
  }

  function profileRecord(setup) {
    const result = setup.status === "RESOLVED" ? `${formatR(setup.r_result)}` : setup.status;
    return `<div class="profile-record is-clickable" role="link" tabindex="0" data-profile-open-setup="${escapeAttr(setup.id)}" data-profile-setup-book="${escapeAttr(normalizeState(setup.status))}" aria-label="Open ${escapeAttr(setup.ticker)} setup from ${escapeAttr(formatDate(setup.submitted_at))}"><b>${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.trigger_type))} · ${formatDate(setup.submitted_at)}</span><i class="${metricClass(setup.r_result)}">${escapeHtml(result)} ↗</i></div>`;
  }

  function followedSetupDashboard(setups) {
    const count = state.followedSetupIds.size;
    const rows = setups.slice(0, 8);
    const contents = !state.setupFollowsAvailable
      ? '<div class="table-empty">The setup-follow database update is not active yet.</div>'
      : rows.length
        ? rows.map(followedSetupRecord).join("")
        : '<div class="table-empty">Follow any setup to place it on this dashboard.</div>';
    return `<section class="profile-watchlist">
      <div class="profile-section-title">FOLLOWED SETUPS <span>${formatInteger(count)}</span></div>
      <div class="profile-followed-records">${contents}</div>
      <button class="profile-open-watchlist" type="button" data-open-followed-book ${state.setupFollowsAvailable ? "" : "disabled"}>OPEN FULL WATCHLIST <span>→</span></button>
    </section>`;
  }

  function followedSetupRecord(setup) {
    const distance = percentFromEntry(setup);
    return `<div class="profile-followed-record" role="link" tabindex="0" data-profile-open-setup="${escapeAttr(setup.id)}" data-profile-setup-book="followed">
      <b>${escapeHtml(setup.ticker)}</b>
      <span>@${escapeHtml(setup.handle)} · ${escapeHtml(labelize(setup.status))} · ${formatSignedPercent(distance)} from entry</span>
      <i class="status-chip ${normalizeState(setup.status)}">${escapeHtml(normalizeState(setup.status).toUpperCase())}</i>
      <button type="button" data-profile-unfollow-setup="${escapeAttr(setup.id)}">UNFOLLOW</button>
    </div>`;
  }

  function bindSetupFilters() {
    $$('[data-setup-state]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.setupState === "followed" && !state.session?.user) {
        $("#auth-dialog").showModal();
        return;
      }
      openSetupBook(button.dataset.setupState);
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
      syncSetupSortUI();
      renderSetups();
    });
    $$('[data-setup-sort-field]').forEach((button) => button.addEventListener("click", () => {
      state.setupSort = button.dataset.setupSortField;
      syncSetupSortUI();
      renderSetups();
    }));
    $$('[data-setup-layout]').forEach((button) => button.addEventListener("click", () => setSetupLayout(button.dataset.setupLayout)));
    syncSetupLayoutUI();
  }

  function syncSetupSortUI() {
    $("#setup-sort").value = state.setupSort;
    $$('[data-setup-sort-field]').forEach((button) => button.classList.toggle("is-active", button.dataset.setupSortField === state.setupSort));
  }

  function setSetupLayout(layout) {
    if (!setupLayoutOptions.has(layout)) return;
    state.setupLayout = layout;
    try { localStorage.setItem("ledger-setup-layout", layout); } catch (_error) { /* Storage can be disabled. */ }
    syncSetupLayoutUI();
  }

  function syncSetupLayoutUI() {
    const grid = $("#setup-card-grid");
    if (grid) {
      setupLayoutOptions.forEach((layout) => grid.classList.toggle(`layout-${layout}`, layout === state.setupLayout));
    }
    $$('[data-setup-layout]').forEach((button) => {
      const active = button.dataset.setupLayout === state.setupLayout;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function filteredSetups() {
    let rows = state.setups.filter((setup) => {
      const matchesState = state.setupState === "all"
        || (state.setupState === "followed" ? state.followedSetupIds.has(String(setup.id)) : normalizeState(setup.status) === state.setupState);
      const matchesDirection = state.setupDirection === "all" || setup.direction === state.setupDirection;
      const haystack = `${setup.ticker} ${setup.handle} ${setup.strategy || ""} ${setup.thesis || ""}`.toLowerCase();
      const matchesSearch = !state.setupSearch || haystack.includes(state.setupSearch);
      return matchesState && matchesDirection && matchesSearch;
    });

    if (state.setupSort === "oldest") {
      rows.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    } else if (state.setupSort === "entry-near") {
      rows.sort((a, b) => triggerDistance(a) - triggerDistance(b));
    } else if (state.setupSort === "entry-far") {
      rows.sort((a, b) => triggerDistance(b) - triggerDistance(a));
    } else if (state.setupSort === "operator-r") {
      rows.sort((a, b) => operatorMetric(b, "avg_r") - operatorMetric(a, "avg_r") || new Date(b.submitted_at) - new Date(a.submitted_at));
    } else if (state.setupSort === "operator-win") {
      rows.sort((a, b) => operatorMetric(b, "win_rate") - operatorMetric(a, "win_rate") || operatorMetric(b, "triggered_setups") - operatorMetric(a, "triggered_setups"));
    } else if (state.setupSort === "planned-r") {
      rows.sort((a, b) => (computePlannedR(b.direction, b.entry, b.stop, b.t1) ?? -Infinity) - (computePlannedR(a.direction, a.entry, a.stop, a.t1) ?? -Infinity));
    } else if (state.setupSort === "score") {
      rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    } else if (state.setupSort === "discussed") {
      rows.sort((a, b) => b.comment_count - a.comment_count || new Date(b.submitted_at) - new Date(a.submitted_at));
    } else {
      rows.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    }
    return rows;
  }

  function renderSetups() {
    syncSetupBookUI();
    syncSetupSortUI();
    syncSetupLayoutUI();
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
    $$("[data-toggle-comments]", grid).forEach((button) => button.addEventListener("click", () => toggleSetupComments(button.dataset.toggleComments)));
    $$("[data-comment-auth]", grid).forEach((button) => button.addEventListener("click", () => $("#auth-dialog").showModal()));
    $$("[data-comment-form]", grid).forEach((form) => {
      form.addEventListener("submit", submitComment);
      form.addEventListener("paste", (event) => handleAttachmentPaste(
        event,
        $("[data-comment-image]", form),
        $(".attachment-preview", form),
        "comment"
      ));
      const textarea = $("textarea[name='comment']", form);
      if (textarea) bindMentionAutocomplete(textarea, form);
    });
    $$("[data-comment-image]", grid).forEach((input) => input.addEventListener("change", () => {
      pastedAttachmentFiles.delete(input);
      updateAttachmentPreview(input, $(".attachment-preview", input.closest("form")));
    }));
    $$("[data-remove-comment-image]", grid).forEach((button) => button.addEventListener("click", () => {
      const form = button.closest("form");
      clearAttachmentPreview($("[data-comment-image]", form), $(".attachment-preview", form));
    }));
    $$("[data-reply-comment]", grid).forEach((button) => button.addEventListener("click", () => beginCommentReply(button.dataset.setupId, button.dataset.replyComment)));
    $$("[data-cancel-comment-reply]", grid).forEach((button) => button.addEventListener("click", () => cancelCommentReply(button.dataset.cancelCommentReply)));
    $$("[data-jump-comment]", grid).forEach((button) => button.addEventListener("click", () => jumpToComment(button.dataset.setupId, button.dataset.jumpComment)));
    $$("[data-comment-handle]", grid).forEach((button) => button.addEventListener("click", () => openProfileByHandle(button.dataset.commentHandle)));
    $$("[data-delete-comment]", grid).forEach((button) => button.addEventListener("click", () => softDeleteComment(button.dataset.setupId, button.dataset.deleteComment)));
    $$("[data-share-setup]", grid).forEach((button) => button.addEventListener("click", () => shareSetup(button.dataset.shareSetup)));
    $$("[data-open-victory]", grid).forEach((button) => button.addEventListener("click", () => {
      const setup = state.setups.find((item) => String(item.id) === String(button.dataset.openVictory));
      if (setup) openVictoryCard(setup);
    }));
    $$("[data-open-loss]", grid).forEach((button) => button.addEventListener("click", () => {
      const setup = state.setups.find((item) => String(item.id) === String(button.dataset.openLoss));
      if (setup) openLossCard(setup);
    }));
    $$("[data-follow-setup]", grid).forEach((button) => button.addEventListener("click", () => {
      const setup = state.setups.find((item) => String(item.id) === String(button.dataset.followSetup));
      if (setup) void toggleSetupFollow(setup);
    }));
    renderSetupCounts();
    renderNetworkIntel();
  }

  function setupCard(setup) {
    const normalized = normalizeState(setup.status);
    const plannedR = computePlannedR(setup.direction, setup.entry, setup.stop, setup.t1);
    const operator = operatorHistory(setup);
    const setupId = String(setup.id);
    const commentsOpen = state.expandedComments.has(setupId);
    const isFollowed = state.followedSetupIds.has(setupId);
    const victory = isWinningSetup(setup);
    const loss = isLosingSetup(setup);
    const victoryVariant = victory ? victoryVariantFor(setup) : null;
    const lossVariant = loss ? lossVariantFor(setup) : null;
    return `<article class="setup-card is-${setup.direction.toLowerCase()}${commentsOpen ? " has-open-comments" : ""}${isFollowed ? " is-followed" : ""}" id="setup-${escapeAttr(setupId)}">
      <div class="setup-card-top">
        <div class="ticker-lockup"><div class="ticker-icon">${escapeHtml(setup.ticker.slice(0, 4))}</div><div class="ticker-copy"><b>${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.horizon || "SWING"))}</span></div></div>
        <span class="status-chip ${normalized}">${escapeHtml(normalized.toUpperCase())}</span>
      </div>
      ${setupPositionMap(setup)}
      <div class="setup-price-grid">
        <div><span>PLANNED R</span><b class="metric-positive">${formatNumber(plannedR, 2, "—")}R</b></div>
        <div><span>OP AVG R</span><b class="${metricClass(operator.avg_r)}">${formatR(operator.avg_r)}</b></div>
        <div><span>OP WIN / HISTORY</span><b>${formatPercent(operator.win_rate)} <small>${formatInteger(operator.triggered_setups)}T</small></b></div>
      </div>
      ${victory ? `<button class="setup-victory-teaser" type="button" data-open-victory="${escapeAttr(setupId)}">
        <span><i>✦</i><small>VERIFIED WIN / ${escapeHtml(victoryVariant.eyebrow)}</small><b>${escapeHtml(victoryVariant.headline)}</b></span>
        <strong>${formatR(setup.r_result ?? setup.score)}</strong><em>OPEN VICTORY CARD ↗</em>
      </button>` : loss ? `<button class="setup-victory-teaser is-loss" type="button" data-open-loss="${escapeAttr(setupId)}">
        <span><i>×</i><small>VERIFIED LOSS / ${escapeHtml(lossVariant.eyebrow)}</small><b>${escapeHtml(lossVariant.headline)}</b></span>
        <strong>${formatR(setup.r_result ?? setup.score)}</strong><em>OPEN LOSS CARD ↗</em>
      </button>` : ""}
      <p class="setup-thesis">${escapeHtml(setup.thesis || "No public thesis was added to this setup.")}</p>
      ${setup.thesis_image_path ? `<a class="setup-thesis-image" href="${escapeAttr(publicMediaUrl(setup.thesis_image_path))}" target="_blank" rel="noopener noreferrer"><img src="${escapeAttr(publicMediaUrl(setup.thesis_image_path))}" loading="lazy" alt="Original ${escapeAttr(setup.ticker)} thesis chart"><span>ORIGINAL THESIS IMAGE ↗</span></a>` : ""}
      <div class="setup-card-foot">
        <div class="setup-card-byline">
          <button class="setup-operator-handle" type="button" data-open-setup-profile="${escapeAttr(setup.user_id)}" data-handle="${escapeAttr(setup.handle)}" aria-label="Open @${escapeAttr(setup.handle)} profile"><span class="setup-operator-avatar" aria-hidden="true">${avatarContent(setup.avatar_url, setup.handle)}</span><span>@${escapeHtml(setup.handle)}</span></button>
          <span>POSTED ${formatDate(setup.submitted_at)} · ${formatRelative(setup.submitted_at)}</span>
        </div>
        <div><button class="setup-follow-button${isFollowed ? " is-following" : ""}" type="button" data-follow-setup="${escapeAttr(setupId)}" aria-pressed="${isFollowed}">${state.session?.user ? (isFollowed ? "FOLLOWING ✓" : "FOLLOW SETUP +") : "SIGN IN TO FOLLOW"}</button><button type="button" data-share-setup="${escapeAttr(setupId)}">SHARE ↗</button><button type="button" data-open-setup-profile="${escapeAttr(setup.user_id)}" data-handle="${escapeAttr(setup.handle)}">VIEW OPERATOR ↗</button></div>
      </div>
      ${setupComments(setup)}
    </article>`;
  }

  function setupPositionMap(setup) {
    const entry = Number(setup.entry);
    const stop = Number(setup.stop);
    const current = setup.current_price == null ? Number.NaN : Number(setup.current_price);
    const hasCurrent = Number.isFinite(current);
    const hasScale = Number.isFinite(entry) && Number.isFinite(stop) && entry !== stop;
    const targets = [setup.t1, setup.t2, setup.t3].map((value, index) => ({
      key: `tp${index + 1}`,
      label: `TP${index + 1}`,
      value: value == null ? Number.NaN : Number(value),
      index: index + 1
    }));
    const publishedTargets = targets.filter((target) => Number.isFinite(target.value));
    const normalized = normalizeState(setup.status);
    const rawDistance = percentFromEntry(setup);
    const directionalDistance = rawDistance == null ? null : rawDistance * (setup.direction === "SHORT" ? -1 : 1);
    const result = setup.r_result ?? setup.score;
    const tone = normalized === "active"
      ? (directionalDistance == null || directionalDistance === 0 ? "neutral" : directionalDistance > 0 ? "positive" : "negative")
      : normalized === "resolved" && result != null
        ? (Number(result) > 0 ? "positive" : Number(result) < 0 ? "negative" : "neutral")
        : "neutral";
    const heading = normalized === "active" ? "LIVE EXECUTION MAP" : normalized === "resolved" ? "FINAL EXECUTION MAP" : "PRE-ENTRY EXECUTION MAP";
    const distanceLabel = directionalDistance == null
      ? "QUOTE PENDING"
      : ["queued", "hot", "near"].includes(normalized)
        ? `${formatNumber(Math.abs(rawDistance), 2)}% FROM ENTRY`
        : `${formatNumber(Math.abs(directionalDistance), 2)}% ${directionalDistance >= 0 ? "FAVORABLE" : "ADVERSE"}`;

    let stopPosition = 12;
    let entryPosition = 50;
    let currentPosition = 50;
    let position = () => 50;
    if (hasScale) {
      const scaleValues = [stop, entry, ...publishedTargets.map((target) => target.value), ...(hasCurrent ? [current] : [])];
      const floor = Math.min(...scaleValues);
      const ceiling = Math.max(...scaleValues);
      const span = Math.max(ceiling - floor, Math.abs(entry - stop));
      const scaleFloor = floor - span * 0.08;
      const scaleCeiling = ceiling + span * 0.08;
      position = (value) => Math.max(5, Math.min(95, ((value - scaleFloor) / (scaleCeiling - scaleFloor)) * 100));
      stopPosition = position(stop);
      entryPosition = position(entry);
      currentPosition = hasCurrent ? position(current) : entryPosition;
    }
    const fillLeft = Math.min(entryPosition, currentPosition);
    const fillWidth = Math.max(0.8, Math.abs(currentPosition - entryPosition));
    const riskLeft = Math.min(stopPosition, entryPosition);
    const riskWidth = Math.max(0.8, Math.abs(entryPosition - stopPosition));
    const rewardBoundary = publishedTargets.length
      ? (setup.direction === "SHORT"
        ? Math.min(...publishedTargets.map((target) => target.value))
        : Math.max(...publishedTargets.map((target) => target.value)))
      : entry;
    const rewardPosition = position(rewardBoundary);
    const rewardLeft = Math.min(entryPosition, rewardPosition);
    const rewardWidth = Math.max(0.8, Math.abs(rewardPosition - entryPosition));
    const quoteSymbol = setup.quote_symbol || setup.ticker;
    const quoteSource = setup.live_quote_source ? labelize(setup.live_quote_source) : "stored quote";
    const quoteAge = setup.live_quote_at ? formatRelative(setup.live_quote_at) : "time unavailable";
    const queued = ["queued", "hot", "near"].includes(normalized);
    const entryExplanation = queued
      ? "Published trigger. The setup becomes active when the market reaches this price."
      : "Original published trigger or fill. It remains locked for outcome scoring.";
    const stopExplanation = `Published invalidation. This ${setup.direction.toLowerCase()} setup stops when price reaches this level.`;
    const nowExplanation = hasCurrent
      ? `Latest tracked ${quoteSymbol} price from ${quoteSource}, quoted ${quoteAge}.`
      : "A live quote is pending. The published entry, stop, and targets remain plotted.";
    const tooltipAlignment = (value) => value < 22 ? "left" : value > 78 ? "right" : "center";
    const marker = (className, label, value, markerPosition, explanation, markerText = "") => `<button class="position-marker ${className}" type="button" style="--marker-position:${markerPosition.toFixed(2)}%" data-tooltip-align="${tooltipAlignment(markerPosition)}" data-map-tooltip="${escapeAttr(`${label} ${formatPrice(value)} — ${explanation}`)}" aria-label="${escapeAttr(`${label} ${formatPrice(value)}. ${explanation}`)}">${markerText}</button>`;
    const valueCell = (className, label, value, explanation, note = "") => `<button class="position-value ${className}" type="button" data-map-tooltip="${escapeAttr(`${label} ${formatPrice(value)} — ${explanation}`)}" aria-label="${escapeAttr(`${label} ${formatPrice(value)}. ${explanation}`)}"><span>${label}${note ? `<small>${escapeHtml(note)}</small>` : ""}</span><b>${formatPrice(value)}</b></button>`;
    const targetMarkers = publishedTargets.map((target) => {
      const targetR = computePlannedR(setup.direction, entry, stop, target.value);
      const explanation = `${target.index === 1 ? "First" : target.index === 2 ? "Second" : "Final"} published take-profit${targetR == null ? "" : `, equal to ${formatNumber(targetR, 2)}R from entry`}.`;
      return marker(`is-target is-${target.key}`, target.label, target.value, position(target.value), explanation, String(target.index));
    }).join("");
    const targetValueItems = targets.map((target) => {
      const published = Number.isFinite(target.value);
      const targetR = published ? computePlannedR(setup.direction, entry, stop, target.value) : null;
      const explanation = published
        ? `${target.index === 1 ? "First" : target.index === 2 ? "Second" : "Final"} published take-profit${targetR == null ? "" : `, equal to ${formatNumber(targetR, 2)}R from entry`}.`
        : `No ${target.label} was published for this setup.`;
      return {
        value: published ? target.value : (setup.direction === "SHORT" ? -Number.MAX_VALUE + (4 - target.index) : Number.MAX_VALUE - (4 - target.index)),
        tieOrder: setup.direction === "SHORT" ? 3 - target.index : target.index + 2,
        html: valueCell(`is-target is-${target.key}${published ? "" : " is-unset"}`, target.label, published ? target.value : null, explanation, targetR == null ? "" : `${formatNumber(targetR, 2)}R`)
      };
    });
    const valueItems = [
      {
        value: stop,
        tieOrder: setup.direction === "SHORT" ? 5 : 0,
        html: valueCell("is-stop", "SL", stop, stopExplanation)
      },
      {
        value: entry,
        tieOrder: setup.direction === "SHORT" ? 4 : 1,
        html: valueCell("is-entry", "ENTRY", entry, entryExplanation)
      },
      ...targetValueItems,
      {
        value: hasCurrent ? current : (setup.direction === "SHORT" ? entry - Number.EPSILON : entry + Number.EPSILON),
        tieOrder: setup.direction === "SHORT" ? 3 : 2,
        html: valueCell(`is-current${hasCurrent ? "" : " is-unset"}`, "NOW", hasCurrent ? current : null, nowExplanation, quoteSymbol !== setup.ticker ? quoteSymbol : "")
      }
    ].sort((a, b) => a.value - b.value || a.tieOrder - b.tieOrder);
    const orderedValues = valueItems.map((item) => item.html).join("");
    const ariaTargets = targets.map((target) => `${target.label} ${formatPrice(Number.isFinite(target.value) ? target.value : null)}`).join(", ");

    return `<section class="setup-position-map is-${tone}${hasCurrent ? "" : " is-pending"}" aria-label="${escapeAttr(`${setup.ticker} ${setup.direction} execution map. Stop ${formatPrice(setup.stop)}, entry ${formatPrice(setup.entry)}, ${ariaTargets}, current ${formatPrice(setup.current_price)}.`)}">
      <header><span>${heading}<small>${escapeHtml(setup.direction)} / ${escapeHtml(quoteSymbol)}</small></span><b>${distanceLabel}</b></header>
      <div class="setup-position-track" style="--risk-left:${riskLeft.toFixed(2)}%;--risk-width:${riskWidth.toFixed(2)}%;--reward-left:${rewardLeft.toFixed(2)}%;--reward-width:${rewardWidth.toFixed(2)}%;--fill-left:${fillLeft.toFixed(2)}%;--fill-width:${fillWidth.toFixed(2)}%">
        <i class="position-zone is-risk" aria-hidden="true"></i><i class="position-zone is-reward" aria-hidden="true"></i>${hasCurrent ? '<i class="position-fill" aria-hidden="true"></i>' : ""}
        ${marker("is-stop", "SL", stop, stopPosition, stopExplanation)}
        ${marker("is-entry", "ENTRY", entry, entryPosition, entryExplanation)}
        ${targetMarkers}
        ${hasCurrent ? marker("is-current", "NOW", current, currentPosition, nowExplanation) : ""}
      </div>
      <div class="position-map-key" aria-hidden="true"><span class="is-risk">RISK</span><span class="is-reward">TARGET PATH</span><span class="is-move">ENTRY → NOW</span></div>
      <div class="setup-position-values">
        ${orderedValues}
      </div>
    </section>`;
  }

  function setupComments(setup) {
    const setupId = String(setup.id);
    const expanded = state.expandedComments.has(setupId);
    const comments = state.commentsBySetup.get(setupId);
    const loading = state.commentsLoading.has(setupId);
    const error = state.commentErrors.get(setupId);
    const count = comments ? comments.filter((comment) => !comment.is_deleted).length : setup.comment_count;
    const preExecution = ["queued", "hot", "near"].includes(normalizeState(setup.status));
    const replyTargetId = state.replyTargets.get(setupId);
    const replyTarget = comments?.find((comment) => String(comment.id) === String(replyTargetId) && !comment.is_deleted);
    let conversation = "";

    if (loading) {
      conversation = '<div class="comment-system-state"><i></i><span>Loading conversation…</span></div>';
    } else if (error) {
      conversation = `<div class="comment-system-state is-error"><span>${escapeHtml(error)}</span></div>`;
    } else if (!comments?.length) {
      conversation = '<div class="comment-system-state"><span>No comments yet. Start the signal check.</span></div>';
    } else {
      conversation = `<div class="comment-list">${comments.map(commentItem).join("")}</div>`;
    }

    if (replyTargetId && !replyTarget) state.replyTargets.delete(setupId);
    const replyContext = replyTarget ? `<div class="comment-reply-context">
      <span>REPLYING TO <b>@${escapeHtml(replyTarget.handle)}</b></span>
      <p>${escapeHtml(commentPreview(replyTarget.body, replyTarget.image_path))}</p>
      <button type="button" data-cancel-comment-reply="${escapeAttr(setupId)}" aria-label="Cancel reply">CANCEL</button>
    </div>` : "";
    const replyDraft = replyTarget ? `@${replyTarget.handle} ` : "";
    const composer = state.session?.user ? `<form class="comment-composer" data-comment-form="${escapeAttr(setupId)}"${replyTarget ? ` data-reply-to-comment="${escapeAttr(replyTarget.id)}"` : ""}>
      <span class="comment-avatar">${avatarContent(state.profile?.avatar_url, state.profile?.handle || state.session.user.email)}</span>
      <div class="comment-compose-body">
        ${replyContext}
        <div class="comment-mention-shell">
        <label><span class="sr-only">Comment on ${escapeHtml(setup.ticker)}</span><textarea name="comment" maxlength="600" placeholder="Add signal, context, or a question… Use @handle or paste a chart with Ctrl+V.">${escapeHtml(replyDraft)}</textarea></label>
          <div class="mention-suggestions" id="mention-suggestions-${escapeAttr(setupId)}" role="listbox" aria-label="Matching Ledger operators" hidden></div>
        </div>
        <div class="comment-attachment-actions">
          <label class="comment-image-picker" tabindex="0"><input class="attachment-input" name="comment_image" type="file" accept="image/jpeg,image/png,image/webp" data-comment-image><span>▧ ATTACH / PASTE</span></label>
          <small>CTRL+V · JPG, PNG, or WEBP · 2 MB maximum</small>
        </div>
        <div class="attachment-preview comment-attachment-preview" hidden>
          <img alt="Selected comment image preview">
          <div><b data-attachment-name></b><small data-attachment-size></small></div>
          <button type="button" data-remove-comment-image aria-label="Remove selected comment image">REMOVE</button>
        </div>
      </div>
      <button type="submit">POST COMMENT <span>→</span></button>
    </form>` : `<button class="comment-sign-in" type="button" data-comment-auth>Sign in to join the discussion <span>→</span></button>`;

    return `<section class="setup-discussion${expanded ? " is-open" : ""}">
      <button class="discussion-toggle" type="button" data-toggle-comments="${escapeAttr(setupId)}" aria-expanded="${expanded}" aria-controls="comments-${escapeAttr(setupId)}">
        <span><i class="comment-pulse"></i> ${preExecution ? "PRE-EXECUTION THREAD" : "DISCUSSION"}</span><b>${formatInteger(count)} COMMENT${count === 1 ? "" : "S"}</b><em>${expanded ? "COLLAPSE −" : "EXPAND +"}</em>
      </button>
      <div class="discussion-body" id="comments-${escapeAttr(setupId)}"${expanded ? "" : " hidden"}>
        <div class="discussion-heading"><div><span>PUBLIC THREAD</span><b>${escapeHtml(setup.ticker)} / @${escapeHtml(setup.handle)}</b></div><small>OP replies carry the gold star.</small></div>
        ${conversation}
        ${composer}
      </div>
    </section>`;
  }

  function commentItem(comment) {
    const ownComment = state.session?.user?.id === comment.user_id;
    const replyReference = comment.reply_to_comment_id ? `<button class="comment-reply-reference" type="button" data-jump-comment="${escapeAttr(comment.reply_to_comment_id)}" data-setup-id="${escapeAttr(comment.setup_id)}">
      <span>↳ @${escapeHtml(comment.reply_to_handle || "comment")}</span>
      <small>${escapeHtml(commentPreview(comment.reply_to_body, comment.reply_to_image_path, comment.reply_to_is_deleted))}</small>
    </button>` : "";
    return `<article class="comment-item${comment.is_op ? " is-op" : ""}${comment.is_deleted ? " is-deleted" : ""}" id="comment-${escapeAttr(comment.id)}">
      <span class="comment-avatar">${avatarContent(comment.avatar_url, comment.handle)}</span>
      <div class="comment-content">
        ${replyReference}
        <header><button class="comment-handle" type="button" data-comment-handle="${escapeAttr(comment.handle)}">@${escapeHtml(comment.handle)}</button>${comment.is_op ? '<strong>★ OP</strong>' : ""}<time>${formatRelative(comment.created_at)}</time></header>
        ${comment.body ? `<p>${commentBodyHtml(comment.body)}</p>` : ""}
        ${comment.image_path && !comment.is_deleted ? `<a class="comment-image" href="${escapeAttr(publicMediaUrl(comment.image_path))}" target="_blank" rel="noopener noreferrer"><img src="${escapeAttr(publicMediaUrl(comment.image_path))}" loading="lazy" alt="Image attached by @${escapeAttr(comment.handle)}"></a>` : ""}
      </div>
      ${!comment.is_deleted ? `<div class="comment-actions"><button class="comment-reply" type="button" data-reply-comment="${escapeAttr(comment.id)}" data-setup-id="${escapeAttr(comment.setup_id)}">REPLY</button>${ownComment ? `<button class="comment-delete" type="button" data-delete-comment="${escapeAttr(comment.id)}" data-setup-id="${escapeAttr(comment.setup_id)}" aria-label="Remove your comment">REMOVE</button>` : ""}</div>` : ""}
    </article>`;
  }

  function commentPreview(body, imagePath, isDeleted = false) {
    if (isDeleted) return "Comment removed";
    const clean = String(body || "").replace(/\s+/g, " ").trim();
    if (clean) return clean.length > 116 ? `${clean.slice(0, 113)}…` : clean;
    return imagePath ? "Image attachment" : "Referenced comment";
  }

  function commentBodyHtml(body) {
    return escapeHtml(body || "").replace(
      /(^|[\s([{])@([a-z0-9][a-z0-9_-]{2,29})/gi,
      (_match, prefix, handle) => `${prefix}<button class="comment-mention" type="button" data-comment-handle="${escapeAttr(handle.toLowerCase())}">@${escapeHtml(handle)}</button>`
    );
  }

  function bindMentionAutocomplete(textarea, form) {
    const panel = $(".mention-suggestions", form);
    if (!panel) return;

    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("aria-autocomplete", "list");
    textarea.setAttribute("aria-haspopup", "listbox");
    textarea.setAttribute("aria-controls", panel.id);
    textarea.setAttribute("aria-expanded", "false");
    mentionLookupState.set(textarea, {
      activeIndex: -1,
      items: [],
      query: "",
      requestToken: 0,
      timer: null
    });

    const schedule = () => scheduleMentionLookup(textarea, panel);
    textarea.addEventListener("input", schedule);
    textarea.addEventListener("click", schedule);
    textarea.addEventListener("keyup", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) schedule();
    });
    textarea.addEventListener("keydown", (event) => handleMentionKeydown(event, textarea, panel));
    textarea.addEventListener("blur", () => window.setTimeout(() => closeMentionSuggestions(textarea, panel), 140));
  }

  function currentMentionContext(textarea) {
    const cursor = textarea.selectionStart;
    if (!Number.isInteger(cursor)) return null;
    const match = textarea.value.slice(0, cursor).match(/(^|[\s([{])@([a-z0-9_-]{0,29})$/i);
    if (!match) return null;
    return {
      end: cursor,
      query: match[2].toLowerCase(),
      start: cursor - match[2].length - 1
    };
  }

  function scheduleMentionLookup(textarea, panel) {
    const lookup = mentionLookupState.get(textarea);
    const context = currentMentionContext(textarea);
    if (!lookup || !context || !state.supabase) {
      closeMentionSuggestions(textarea, panel);
      return;
    }

    if (lookup.timer) window.clearTimeout(lookup.timer);
    lookup.query = context.query;
    const requestToken = ++lookup.requestToken;
    panel.hidden = false;
    panel.innerHTML = '<div class="mention-suggestion-state"><i></i> SEARCHING LEDGER...</div>';
    textarea.setAttribute("aria-expanded", "true");
    textarea.removeAttribute("aria-activedescendant");
    lookup.timer = window.setTimeout(() => {
      void loadMentionSuggestions(textarea, panel, context.query, requestToken);
    }, 110);
  }

  async function loadMentionSuggestions(textarea, panel, query, requestToken) {
    const lookup = mentionLookupState.get(textarea);
    if (!lookup) return;

    let items = mentionSearchCache.get(query);
    if (!items) {
      let request = state.supabase
        .from("profiles")
        .select("id, handle, display_name, avatar_url")
        .eq("is_public", true)
        .eq("account_status", "ACTIVE")
        .order("handle", { ascending: true })
        .limit(mentionQueryLimit);
      if (query) request = request.or(`handle.ilike.${query}%,display_name.ilike.%${query}%`);

      const { data, error } = await request;
      if (error) {
        if (lookup.requestToken === requestToken) renderMentionSuggestions(textarea, panel, [], "Operator search is unavailable.");
        return;
      }
      items = (data || []).filter((item) => item.handle).map((item) => ({
        avatar_url: item.avatar_url || "",
        display_name: item.display_name || item.handle,
        handle: String(item.handle).toLowerCase(),
        id: item.id
      }));
      mentionSearchCache.set(query, items);
    }

    const context = currentMentionContext(textarea);
    if (!textarea.isConnected || lookup.requestToken !== requestToken || !context || context.query !== query) return;
    renderMentionSuggestions(textarea, panel, items);
  }

  function renderMentionSuggestions(textarea, panel, items, errorMessage = "") {
    const lookup = mentionLookupState.get(textarea);
    if (!lookup) return;
    lookup.items = items;
    lookup.activeIndex = items.length ? 0 : -1;
    panel.hidden = false;
    textarea.setAttribute("aria-expanded", "true");

    if (!items.length) {
      panel.innerHTML = `<div class="mention-suggestion-state${errorMessage ? " is-error" : ""}">${escapeHtml(errorMessage || "NO MATCHING OPERATORS")}</div>`;
      textarea.removeAttribute("aria-activedescendant");
      return;
    }

    panel.innerHTML = items.map((item, index) => `<button class="mention-option${index === lookup.activeIndex ? " is-active" : ""}" id="${escapeAttr(panel.id)}-option-${index}" type="button" role="option" aria-selected="${index === lookup.activeIndex}" data-mention-index="${index}">
      <span class="mention-option-avatar">${avatarContent(item.avatar_url, item.handle)}</span>
      <span class="mention-option-copy"><b>@${escapeHtml(item.handle)}</b><small>${escapeHtml(item.display_name)}</small></span>
    </button>`).join("");
    syncMentionActiveOption(textarea, panel);

    $$("[data-mention-index]", panel).forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectMention(textarea, panel, Number(button.dataset.mentionIndex)));
      button.addEventListener("mousemove", () => {
        const nextIndex = Number(button.dataset.mentionIndex);
        if (lookup.activeIndex === nextIndex) return;
        lookup.activeIndex = nextIndex;
        syncMentionActiveOption(textarea, panel);
      });
    });
  }

  function handleMentionKeydown(event, textarea, panel) {
    const lookup = mentionLookupState.get(textarea);
    if (!lookup || panel.hidden) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionSuggestions(textarea, panel);
      return;
    }
    if (!lookup.items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      lookup.activeIndex = (lookup.activeIndex + step + lookup.items.length) % lookup.items.length;
      syncMentionActiveOption(textarea, panel, true);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMention(textarea, panel, lookup.activeIndex);
    }
  }

  function syncMentionActiveOption(textarea, panel, ensureVisible = false) {
    const lookup = mentionLookupState.get(textarea);
    if (!lookup) return;
    $$("[data-mention-index]", panel).forEach((button, index) => {
      const active = index === lookup.activeIndex;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      if (active) {
        textarea.setAttribute("aria-activedescendant", button.id);
        if (ensureVisible) button.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function selectMention(textarea, panel, index) {
    const lookup = mentionLookupState.get(textarea);
    const context = currentMentionContext(textarea);
    const item = lookup?.items[index];
    if (!item || !context) return;
    textarea.setRangeText(`@${item.handle} `, context.start, context.end, "end");
    closeMentionSuggestions(textarea, panel);
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function closeMentionSuggestions(textarea, panel) {
    const lookup = mentionLookupState.get(textarea);
    if (lookup?.timer) window.clearTimeout(lookup.timer);
    if (lookup) {
      lookup.activeIndex = -1;
      lookup.items = [];
      lookup.requestToken += 1;
      lookup.timer = null;
    }
    panel.hidden = true;
    panel.innerHTML = "";
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute("aria-activedescendant");
  }

  async function openProfileByHandle(handle) {
    const normalizedHandle = String(handle || "").replace(/^@/, "").toLowerCase();
    let profile = [...state.leaders, ...state.compactLeaders].find((item) => String(item.handle).toLowerCase() === normalizedHandle);
    if (!profile) {
      const setup = state.setups.find((item) => String(item.handle).toLowerCase() === normalizedHandle);
      if (setup) profile = { id: setup.user_id, handle: setup.handle, display_name: setup.handle };
    }
    if (!profile && state.supabase) {
      const { data } = await state.supabase
        .from("profiles")
        .select("id, handle, display_name, avatar_url, bio, created_at")
        .eq("handle", normalizedHandle)
        .maybeSingle();
      if (data) profile = data;
    }
    if (profile) await openProfile(profile);
    else showToast("Operator not found", `@${normalizedHandle} is not a visible Ledger profile.`, true);
  }

  function beginCommentReply(setupId, commentId) {
    if (!state.session?.user) {
      $("#auth-dialog").showModal();
      return;
    }
    const key = String(setupId);
    const comment = (state.commentsBySetup.get(key) || []).find((item) => String(item.id) === String(commentId) && !item.is_deleted);
    if (!comment) return;
    state.replyTargets.set(key, String(comment.id));
    state.expandedComments.add(key);
    renderSetups();
    requestAnimationFrame(() => {
      const form = $$("[data-comment-form]").find((item) => item.dataset.commentForm === key);
      const textarea = form ? $("textarea", form) : null;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function cancelCommentReply(setupId) {
    state.replyTargets.delete(String(setupId));
    renderSetups();
  }

  function jumpToComment(_setupId, commentId) {
    const target = document.getElementById(`comment-${commentId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-referenced");
    requestAnimationFrame(() => target.classList.add("is-referenced"));
    window.setTimeout(() => target.classList.remove("is-referenced"), 1800);
  }

  async function toggleSetupComments(setupId) {
    const key = String(setupId);
    if (state.expandedComments.has(key)) {
      state.expandedComments.delete(key);
      renderSetups();
      return;
    }
    state.expandedComments.add(key);
    renderSetups();
    if (!state.commentsBySetup.has(key)) await loadSetupComments(key);
  }

  async function loadSetupComments(setupId) {
    const key = String(setupId);
    if (!state.supabase || state.commentsLoading.has(key)) return;
    state.commentsLoading.add(key);
    state.commentErrors.delete(key);
    renderSetups();
    const { data, error } = await state.supabase
      .from("setup_comments_public")
      .select("*")
      .eq("setup_id", key)
      .order("created_at", { ascending: true })
      .limit(100);
    state.commentsLoading.delete(key);
    if (error) {
      const migrationPending = error.code === "42P01" || error.code === "42501" || /setup_comments/i.test(error.message || "");
      state.commentErrors.set(key, migrationPending ? "The comments database migration is not active yet." : error.message);
    } else {
      state.commentsBySetup.set(key, (data || []).map(normalizeComment));
    }
    renderSetups();
  }

  async function submitComment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const setupId = String(form.dataset.commentForm);
    const replyToCommentId = form.dataset.replyToComment || null;
    const textarea = $("textarea", form);
    const body = textarea.value.trim();
    const imageInput = $("[data-comment-image]", form);
    const imageFile = selectedAttachmentFile(imageInput);
    if (!state.session?.user || !state.supabase) {
      $("#auth-dialog").showModal();
      return;
    }
    if ((!body && !imageFile) || body.length > 600) {
      showToast("Comment needs content", "Add text, an image, or both before posting.", true);
      return;
    }
    const imageError = validateImageFile(imageFile);
    if (imageError) {
      showToast("Image not accepted", imageError, true);
      return;
    }

    const button = $("button[type='submit']", form);
    button.disabled = true;
    button.textContent = imageFile ? "UPLOADING…" : "POSTING…";
    let uploadedPath = null;
    try {
      if (imageFile) {
        uploadedPath = await uploadLedgerImage(imageFile, "comments");
        button.textContent = "POSTING…";
      }
      const storedBody = serializeAttachmentText(body, uploadedPath, 600);
      const commentRecord = {
        setup_id: setupId,
        user_id: state.session.user.id,
        body: storedBody
      };
      if (replyToCommentId) commentRecord.reply_to_comment_id = replyToCommentId;
      const { error } = await state.supabase.from("setup_comments").insert(commentRecord);
      if (error) throw error;
    } catch (error) {
      if (uploadedPath) await removeLedgerImage(uploadedPath);
      button.disabled = false;
      button.innerHTML = "POST COMMENT <span>→</span>";
      showToast("Comment not posted", error.message || "The comment attachment could not be published.", true);
      return;
    }

    const setup = state.setups.find((item) => String(item.id) === setupId);
    if (setup) setup.comment_count += 1;
    state.replyTargets.delete(setupId);
    state.commentsBySetup.delete(setupId);
    textarea.value = "";
    clearAttachmentPreview(imageInput, $(".attachment-preview", form));
    await loadSetupComments(setupId);
    showToast(replyToCommentId ? "Reply posted" : "Comment posted", replyToCommentId ? "The referenced operator received a reply alert." : "Your comment is now part of the public thread.");
  }

  async function softDeleteComment(setupId, commentId) {
    if (!state.session?.user || !state.supabase) return;
    const comment = (state.commentsBySetup.get(String(setupId)) || []).find((item) => String(item.id) === String(commentId));
    const { error } = await state.supabase
      .from("setup_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", commentId)
      .eq("user_id", state.session.user.id);
    if (error) {
      showToast("Comment not removed", error.message, true);
      return;
    }
    if (comment?.image_path) await removeLedgerImage(comment.image_path);
    const key = String(setupId);
    const setup = state.setups.find((item) => String(item.id) === key);
    if (setup) setup.comment_count = Math.max(0, setup.comment_count - 1);
    state.commentsBySetup.delete(key);
    await loadSetupComments(key);
    showToast("Comment removed", "The public thread now shows a removal marker.");
  }

  function isWinningSetup(setup) {
    const result = Number(setup?.r_result ?? setup?.score);
    const finalStatus = String(setup?.final_status || "").toUpperCase();
    const losingOutcome = ["STOPPED", "CANCELLED", "EXPIRED"].includes(finalStatus);
    return normalizeState(setup?.status) === "resolved" && Number.isFinite(result) && result > 0 && !losingOutcome;
  }

  function isLosingSetup(setup) {
    const result = Number(setup?.r_result ?? setup?.score);
    const finalStatus = String(setup?.final_status || "").toUpperCase();
    const voidOutcome = ["CANCELLED", "EXPIRED"].includes(finalStatus);
    return normalizeState(setup?.status) === "resolved" && Number.isFinite(result) && result < 0 && !voidOutcome;
  }

  function victoryVariantFor(setup) {
    const finalStatus = String(setup.final_status || "").toUpperCase();
    if (finalStatus === "T3") return victoryVariants[0];
    if (finalStatus === "T2") return victoryVariants[2];
    const hash = String(setup.id || setup.ticker || "victory").split("").reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 0);
    return victoryVariants[hash % victoryVariants.length];
  }

  function lossVariantFor(setup) {
    const hash = String(setup.id || setup.ticker || "loss").split("").reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 0);
    return lossVariants[hash % lossVariants.length];
  }

  function victoryTargetPrice(setup) {
    const finalStatus = String(setup.final_status || "").toUpperCase();
    if (finalStatus === "T3") return setup.t3 ?? setup.t2 ?? setup.t1;
    if (finalStatus === "T2") return setup.t2 ?? setup.t1;
    return setup.t1;
  }

  function victoryRecordUrl(setup) {
    const url = new URL(config.siteUrl || location.href);
    url.search = "";
    url.searchParams.set("setup", setup.id);
    url.hash = "setups";
    return url.toString();
  }

  function victoryShareUrl(setup) {
    const url = new URL(config.siteUrl || location.href);
    url.search = "";
    url.searchParams.set("victory", setup.id);
    url.hash = "setups";
    return url.toString();
  }

  function lossShareUrl(setup) {
    const url = new URL(config.siteUrl || location.href);
    url.search = "";
    url.searchParams.set("loss", setup.id);
    url.hash = "setups";
    return url.toString();
  }

  function victoryElapsed(setup) {
    const start = new Date(setup.triggered_at || setup.submitted_at).getTime();
    const end = new Date(setup.archived_at || setup.updated_at || Date.now()).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "VERIFIED";
    const minutes = Math.max(1, Math.round((end - start) / 60000));
    if (minutes < 60) return `${minutes}M`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}H ${minutes % 60}M`;
    return `${Math.floor(hours / 24)}D ${hours % 24}H`;
  }

  function victoryCardHtml(setup) {
    const variant = victoryVariantFor(setup);
    const operator = operatorHistory(setup);
    const finalStatus = labelize(setup.final_status || setup.status || "WIN");
    const result = setup.r_result ?? setup.score;
    const outcomePercent = setup.pct_from_fill == null ? "TARGET VERIFIED" : `${formatSignedPercent(Number(setup.pct_from_fill))} FROM FILL`;
    const recordUrl = victoryRecordUrl(setup);
    return `<article class="victory-card victory-${escapeAttr(variant.slug)}">
      <img class="victory-art" src="${escapeAttr(variant.art)}" alt="" loading="eager">
      <div class="victory-noise" aria-hidden="true"></div>
      <header class="victory-card-header">
        <a class="victory-brand" href="${escapeAttr(config.siteUrl || location.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open Composite Operator Ledger">
          <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
          <span><b>COMPOSITE</b><small>OPERATOR / LEDGER</small></span>
        </a>
        <span class="victory-verified"><i></i> VERIFIED PUBLIC OUTCOME</span>
      </header>
      <section class="victory-copy">
        <span>${escapeHtml(variant.eyebrow)}</span>
        <h2>${escapeHtml(variant.headline)}</h2>
        <p>${escapeHtml(variant.line)}</p>
      </section>
      <section class="victory-result">
        <div class="victory-instrument"><span>MARKET / DIRECTION</span><strong>${escapeHtml(setup.ticker)}</strong><small>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.horizon || "SWING"))}</small></div>
        <div class="victory-r"><span>REALIZED RESULT</span><strong>${formatR(result)}</strong><small>${escapeHtml(outcomePercent)}</small></div>
      </section>
      <section class="victory-trade-stats" aria-label="Winning trade statistics">
        <div><span>OUTCOME</span><b>${escapeHtml(finalStatus)}</b></div>
        <div><span>ENTRY</span><b>${formatPrice(setup.entry)}</b></div>
        <div><span>WINNING TARGET</span><b>${formatPrice(victoryTargetPrice(setup))}</b></div>
        <div><span>TIME IN PLAY</span><b>${escapeHtml(victoryElapsed(setup))}</b></div>
      </section>
      <section class="victory-operator-stats" aria-label="Operator history at close">
        <div><span>OPERATOR</span><b>@${escapeHtml(setup.handle)}</b></div>
        <div><span>WIN RATE</span><b>${formatPercent(operator.win_rate)}</b></div>
        <div><span>AVG R</span><b>${formatR(operator.avg_r)}</b></div>
        <div><span>TRIGGERED</span><b>${formatInteger(operator.triggered_setups)}</b></div>
      </section>
      <footer class="victory-card-footer">
        <a href="${escapeAttr(recordUrl)}" target="_blank" rel="noopener noreferrer">OPEN THE RECEIPT ↗</a>
        <span>CLOSED ${formatDate(setup.archived_at || setup.updated_at)} · ID ${escapeHtml(String(setup.id).slice(0, 8).toUpperCase())}</span>
      </footer>
    </article>`;
  }

  function lossCardHtml(setup) {
    const variant = lossVariantFor(setup);
    const operator = operatorHistory(setup);
    const finalStatus = labelize(setup.final_status || setup.status || "LOSS");
    const result = setup.r_result ?? setup.score;
    const outcomePercent = setup.pct_from_fill == null ? "STOP VERIFIED" : `${formatSignedPercent(Number(setup.pct_from_fill))} FROM FILL`;
    const recordUrl = victoryRecordUrl(setup);
    return `<article class="victory-card loss-card loss-${escapeAttr(variant.slug)}">
      <img class="victory-art" src="${escapeAttr(variant.art)}" alt="" loading="eager">
      <div class="victory-noise" aria-hidden="true"></div>
      <header class="victory-card-header">
        <a class="victory-brand" href="${escapeAttr(config.siteUrl || location.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open Composite Operator Ledger">
          <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
          <span><b>COMPOSITE</b><small>OPERATOR / LEDGER</small></span>
        </a>
        <span class="victory-verified"><i></i> VERIFIED PUBLIC LOSS</span>
      </header>
      <section class="victory-copy">
        <span>${escapeHtml(variant.eyebrow)}</span>
        <h2>${escapeHtml(variant.headline)}</h2>
        <p>${escapeHtml(variant.line)}</p>
      </section>
      <section class="victory-result">
        <div class="victory-instrument"><span>MARKET / DIRECTION</span><strong>${escapeHtml(setup.ticker)}</strong><small>${escapeHtml(setup.direction)} · ${escapeHtml(labelize(setup.horizon || "SWING"))}</small></div>
        <div class="victory-r"><span>REALIZED DAMAGE</span><strong>${formatR(result)}</strong><small>${escapeHtml(outcomePercent)}</small></div>
      </section>
      <section class="victory-trade-stats" aria-label="Losing trade statistics">
        <div><span>OUTCOME</span><b>${escapeHtml(finalStatus)}</b></div>
        <div><span>ENTRY</span><b>${formatPrice(setup.entry)}</b></div>
        <div><span>PUBLISHED STOP</span><b>${formatPrice(setup.stop)}</b></div>
        <div><span>TIME IN PLAY</span><b>${escapeHtml(victoryElapsed(setup))}</b></div>
      </section>
      <section class="victory-operator-stats" aria-label="Operator history at close">
        <div><span>OPERATOR</span><b>@${escapeHtml(setup.handle)}</b></div>
        <div><span>WIN RATE</span><b>${formatPercent(operator.win_rate)}</b></div>
        <div><span>AVG R</span><b>${formatR(operator.avg_r)}</b></div>
        <div><span>TRIGGERED</span><b>${formatInteger(operator.triggered_setups)}</b></div>
      </section>
      <footer class="victory-card-footer">
        <a href="${escapeAttr(recordUrl)}" target="_blank" rel="noopener noreferrer">INSPECT THE DAMAGE ↗</a>
        <span>CLOSED ${formatDate(setup.archived_at || setup.updated_at)} · ID ${escapeHtml(String(setup.id).slice(0, 8).toUpperCase())}</span>
      </footer>
    </article>`;
  }

  function openVictoryCard(setup, pushHistory = true) {
    if (!isWinningSetup(setup)) {
      showToast("Victory card unavailable", "This setup does not have a positive closed result.", true);
      return;
    }
    const dialog = $("#outcome-dialog");
    state.outcomeSetupId = String(setup.id);
    state.outcomeCardKind = "victory";
    $("#outcome-card-host").innerHTML = victoryCardHtml(setup);
    $("[data-open-outcome-record]").href = victoryRecordUrl(setup);
    $("[data-share-outcome]").innerHTML = "SHARE VICTORY <span>↗</span>";
    $(".victory-modal-card", dialog).classList.remove("is-loss");
    if (pushHistory) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.delete("setup");
      nextUrl.searchParams.delete("loss");
      nextUrl.searchParams.set("victory", setup.id);
      nextUrl.hash = "setups";
      history.pushState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    }
    if (!dialog.open) dialog.showModal();
  }

  function openLossCard(setup, pushHistory = true) {
    if (!isLosingSetup(setup)) {
      showToast("Loss card unavailable", "This setup does not have a negative closed result.", true);
      return;
    }
    const dialog = $("#outcome-dialog");
    state.outcomeSetupId = String(setup.id);
    state.outcomeCardKind = "loss";
    $("#outcome-card-host").innerHTML = lossCardHtml(setup);
    $("[data-open-outcome-record]").href = victoryRecordUrl(setup);
    $("[data-share-outcome]").innerHTML = "SHARE THE DAMAGE <span>↗</span>";
    $(".victory-modal-card", dialog).classList.add("is-loss");
    if (pushHistory) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.delete("setup");
      nextUrl.searchParams.delete("victory");
      nextUrl.searchParams.set("loss", setup.id);
      nextUrl.hash = "setups";
      history.pushState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    }
    if (!dialog.open) dialog.showModal();
  }

  async function shareVictorySetup(setup) {
    const url = victoryShareUrl(setup);
    const text = `${setup.ticker} closed ${formatR(setup.r_result ?? setup.score)} by @${setup.handle}. Verified on Composite Operator Ledger.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${setup.ticker} victory card`, text, url });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showToast("Victory link copied", "The branded result card is ready to share.");
    } catch (_error) {
      showToast("Copy blocked", url, true);
    }
  }

  async function shareLossSetup(setup) {
    const url = lossShareUrl(setup);
    const text = `${setup.ticker} closed ${formatR(setup.r_result ?? setup.score)} by @${setup.handle}. The public loss receipt is verified on Composite Operator Ledger.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${setup.ticker} loss card`, text, url });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showToast("Loss link copied", "The branded damage report is ready to share.");
    } catch (_error) {
      showToast("Copy blocked", url, true);
    }
  }

  async function shareSetup(setupId) {
    const url = new URL(config.siteUrl || location.href);
    url.searchParams.set("setup", setupId);
    url.hash = "setups";
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Post link copied", "The link opens this setup with its discussion expanded.");
    } catch (_error) {
      showToast("Copy blocked", url.toString(), true);
    }
  }

  async function activateSharedSetup() {
    const params = new URLSearchParams(location.search);
    const victoryId = params.get("victory");
    if (victoryId) {
      let victorySetup = state.setups.find((setup) => String(setup.id) === victoryId);
      if (!victorySetup && state.supabase) {
        const { data } = await state.supabase.from("setups_public").select("*").eq("id", victoryId).maybeSingle();
        if (data) {
          victorySetup = normalizeSetup(data);
          state.setups.unshift(victorySetup);
        }
      }
      if (victorySetup && isWinningSetup(victorySetup)) {
        openSetupBook("resolved", false);
        openVictoryCard(victorySetup, false);
        requestAnimationFrame(() => document.getElementById(`setup-${victoryId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
      return;
    }
    const lossId = params.get("loss");
    if (lossId) {
      let lossSetup = state.setups.find((setup) => String(setup.id) === lossId);
      if (!lossSetup && state.supabase) {
        const { data } = await state.supabase.from("setups_public").select("*").eq("id", lossId).maybeSingle();
        if (data) {
          lossSetup = normalizeSetup(data);
          state.setups.unshift(lossSetup);
        }
      }
      if (lossSetup && isLosingSetup(lossSetup)) {
        openSetupBook("resolved", false);
        openLossCard(lossSetup, false);
        requestAnimationFrame(() => document.getElementById(`setup-${lossId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
      return;
    }
    const setupId = params.get("setup");
    if (!setupId) return;
    let sharedSetup = state.setups.find((setup) => String(setup.id) === setupId);
    if (!sharedSetup && state.supabase) {
      const { data } = await state.supabase.from("setups_public").select("*").eq("id", setupId).maybeSingle();
      if (data) {
        sharedSetup = normalizeSetup(data);
        state.setups.unshift(sharedSetup);
      }
    }
    if (!sharedSetup) return;
    state.expandedComments.add(setupId);
    openSetupBook("all", false);
    await loadSetupComments(setupId);
    requestAnimationFrame(() => document.getElementById(`setup-${setupId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function renderSetupCounts() {
    const counts = { all: state.setups.length, queued: 0, hot: 0, near: 0, active: 0, resolved: 0, followed: state.followedSetupIds.size };
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
    const stream = $("#activity-stream");
    stream.innerHTML = items.length ? items.map((setup) => `<div class="activity-item is-clickable" role="link" tabindex="0" data-activity-setup="${escapeAttr(setup.id)}" data-activity-book="${escapeAttr(normalizeState(setup.status))}" aria-label="Open ${escapeAttr(setup.ticker)} setup by ${escapeAttr(setup.handle)}">
      <div class="activity-node ${setup.direction === "LONG" ? "is-long" : "is-short"}" aria-hidden="true">${setup.direction === "LONG" ? "↗" : "↘"}</div>
      <div class="activity-copy"><b>@${escapeHtml(setup.handle)} published ${escapeHtml(setup.ticker)}</b><span>${escapeHtml(setup.direction)} ${escapeHtml(labelize(setup.trigger_type))} at ${formatPrice(setup.entry)} · ${escapeHtml(setup.strategy || "Uncategorized")}</span></div>
      <time><span>${formatRelative(setup.submitted_at)}</span><b>OPEN ↗</b></time>
    </div>`).join("") : '<div class="activity-empty"><b>No current public signals</b><span>The stream is ready for the first operator submission.</span></div>';
    $$('[data-activity-setup]', stream).forEach((item) => {
      const openStreamSetup = () => navigateToSetup(String(item.dataset.activitySetup), item.dataset.activityBook || "all");
      item.addEventListener("click", openStreamSetup);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openStreamSetup();
      });
    });
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
    const lightTheme = document.documentElement.dataset.theme === "light";
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
        datasets: [{ data: buckets, borderColor: lightTheme ? "#607d00" : "#c8ff2e", backgroundColor: lightTheme ? "rgba(96,125,0,.1)" : "rgba(200,255,46,.07)", fill: true, tension: .42, pointRadius: 0, borderWidth: 1.4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { displayColors: false, backgroundColor: lightTheme ? "#ffffff" : "#12151d", titleColor: lightTheme ? "#111827" : "#f4f6f8", bodyColor: lightTheme ? "#4b5563" : "#f4f6f8", borderColor: lightTheme ? "rgba(15,23,42,.16)" : "rgba(255,255,255,.1)", borderWidth: 1, titleFont: { family: "DM Mono", size: 8 }, bodyFont: { family: "DM Mono", size: 8 } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: lightTheme ? "#6b7280" : "#5d6371", font: { family: "DM Mono", size: 7 } } },
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
    $("#thesis-image").addEventListener("change", (event) => {
      pastedAttachmentFiles.delete(event.currentTarget);
      updateAttachmentPreview(event.currentTarget, $("#thesis-image-preview"));
    });
    $("[data-remove-thesis-image]").addEventListener("click", () => clearAttachmentPreview($("#thesis-image"), $("#thesis-image-preview")));
    form.addEventListener("paste", (event) => handleAttachmentPaste(event, $("#thesis-image"), $("#thesis-image-preview"), "thesis"));
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
      errorNode.textContent = "Sign in to your Ledger account before you publish this setup.";
      errorNode.hidden = false;
      $("#auth-dialog").showModal();
      return;
    }

    const formData = new FormData(event.currentTarget);
    const thesisImageInput = $("#thesis-image");
    const thesisImageFile = selectedAttachmentFile(thesisImageInput);
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
    const imageError = validateImageFile(thesisImageFile);
    if (imageError) {
      errorNode.textContent = imageError;
      errorNode.hidden = false;
      return;
    }

    const publishButton = $("#publish-setup");
    publishButton.disabled = true;
    let uploadedPath = null;
    if (thesisImageFile) {
      publishButton.querySelector("span").textContent = "Uploading chart…";
      try {
        uploadedPath = await uploadLedgerImage(thesisImageFile, "setups");
        payload.thesis = serializeAttachmentText(payload.thesis || "", uploadedPath, 1200);
      } catch (error) {
        if (uploadedPath) await removeLedgerImage(uploadedPath);
        publishButton.disabled = false;
        publishButton.querySelector("span").textContent = "Publish setup";
        errorNode.textContent = error.message || "The thesis image could not be uploaded.";
        errorNode.hidden = false;
        return;
      }
    }
    publishButton.querySelector("span").textContent = payload.trigger_type === "MARKET" ? "Checking live quote…" : "Publishing…";
    const result = payload.trigger_type === "MARKET"
      ? await submitVerifiedMarketSetup(payload)
      : await state.supabase.from("setups").insert(payload).select().single();
    const { data, error, marketValidation } = result;
    publishButton.disabled = false;
    publishButton.querySelector("span").textContent = "Publish setup";

    if (error) {
      if (uploadedPath) await removeLedgerImage(uploadedPath);
      errorNode.textContent = error.message;
      errorNode.hidden = false;
      return;
    }

    $("#submit-dialog").close();
    event.currentTarget.reset();
    $("#thesis-count").textContent = "0";
    clearAttachmentPreview(thesisImageInput, $("#thesis-image-preview"));
    updateRiskPreview();
    if (marketValidation) {
      const resolution = marketValidation.resolvedSymbol && marketValidation.resolvedSymbol !== payload.ticker
        ? `${payload.ticker} resolved as ${marketValidation.resolvedSymbol} and was`
        : `${payload.ticker} was`;
      showToast("Market setup active", `${resolution} verified at ${formatPrice(marketValidation.verifiedEntry)} via ${labelize(marketValidation.source)}.`);
    } else {
      showToast("Setup published", `${payload.ticker} is now part of your public record.`);
    }
    if (data) state.setups.unshift(normalizeSetup({ ...data, handle: state.profile?.handle || "operator" }));
    await loadLiveData().catch(() => null);
    renderAll();
    openSetupBook("all");
  }

  async function submitVerifiedMarketSetup(payload) {
    const { data: sessionData } = await state.supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return { data: null, error: { message: "Your Ledger session expired. Sign in again." } };

    try {
      const response = await fetch(`${config.supabaseUrl}/functions/v1/submit-market-setup`, {
        method: "POST",
        headers: {
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return { data: null, error: { message: result.message || "The live quote could not be verified." } };
      return { data: result.setup, error: null, marketValidation: result.marketValidation };
    } catch (_error) {
      return { data: null, error: { message: "The live quote service is unavailable. No setup was published." } };
    }
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
      { type: "VIEW", icon: "03", label: "Setup books", note: "Sortable public setup records", action: () => openSetupBook("all") }
    ];
    let commandLeaders = uniqueLeaders([...state.leaders, ...state.compactLeaders]);
    if (state.live && state.supabase && query.length >= 2) {
      const { data } = await state.supabase.rpc("leaderboard_page", { p_sort: "goat", p_search: query, p_limit: 8, p_offset: 0 });
      if (requestToken !== state.commandToken) return;
      if (data) commandLeaders = data.map(normalizeLeader);
    }
    const leaderItems = commandLeaders.map((leader) => ({ type: "OPERATOR", icon: initials(leader.handle), label: `@${leader.handle}`, note: `${leader.triggered_setups} triggered · ${formatR(leader.avg_r)} average`, action: () => openProfile(leader) }));
    const setupItems = state.setups.map((setup) => ({ type: "SETUP", icon: setup.direction === "LONG" ? "↗" : "↘", label: setup.ticker, note: `@${setup.handle} · ${setup.status} · ${setup.strategy || "Uncategorized"}`, action: () => { state.setupSearch = setup.ticker.toLowerCase(); $("#setup-search").value = setup.ticker; openSetupBook(normalizeState(setup.status)); } }));
    state.commandItems = [...viewItems, ...leaderItems, ...setupItems].filter((item) => !query || `${item.label} ${item.note} ${item.type}`.toLowerCase().includes(query)).slice(0, 12);
    $("#command-results").innerHTML = state.commandItems.map((item, index) => `<div class="command-result ${index === 0 ? "is-selected" : ""}" data-command-index="${index}"><span class="command-result-icon">${escapeHtml(item.icon)}</span><span class="command-result-copy"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.note)}</small></span><span class="command-result-type">${item.type}</span></div>`).join("") || '<div class="table-empty">No matching operators or setups.</div>';
    $$('[data-command-index]').forEach((element) => element.addEventListener("click", () => {
      $("#command-dialog").close();
      state.commandItems[Number(element.dataset.commandIndex)].action();
    }));
  }

  function bindNotifications() {
    const center = $("#notification-center");
    const button = $("#notification-button");
    const popover = $("#notification-popover");

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = popover.hidden;
      popover.hidden = !willOpen;
      button.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) void loadNotifications();
    });

    popover.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", (event) => {
      if (!center.contains(event.target)) closeNotificationPopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !popover.hidden) closeNotificationPopover();
    });

    $("#notification-mute").addEventListener("click", async () => {
      const nextMuted = !state.notificationPreferences.notifications_muted;
      try {
        await persistNotificationPreferences({ notifications_muted: nextMuted });
        showToast(nextMuted ? "Notifications muted" : "Notifications resumed", nextMuted ? "No new Ledger alerts will be created." : "Your selected alert channels are active again.");
      } catch (error) {
        showToast("Notification setting failed", error.message, true);
      }
    });

    $("#notification-read-all").addEventListener("click", markAllNotificationsRead);
    $("#notification-sweep").addEventListener("click", sweepNotifications);
    $("#notification-settings").addEventListener("click", async () => {
      closeNotificationPopover();
      if (!state.session?.user) return;
      const ownLeader = [...state.leaders, ...state.compactLeaders].find((leader) => String(leader.id) === String(state.session.user.id)) || profileFromSession();
      await openProfile(ownLeader);
      const settings = $("[data-notification-settings]", $("#profile-drawer"));
      if (settings) {
        settings.open = true;
        settings.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    $("#notification-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-notification-id]");
      if (!item) return;
      const notification = state.notifications.find((entry) => String(entry.id) === String(item.dataset.notificationId));
      if (notification) void openNotification(notification);
    });
  }

  function closeNotificationPopover() {
    const popover = $("#notification-popover");
    const button = $("#notification-button");
    if (!popover || !button) return;
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function renderNotificationUI() {
    const center = $("#notification-center");
    if (!center) return;
    const signedIn = Boolean(state.session?.user);
    center.hidden = !signedIn;
    if (!signedIn) {
      closeNotificationPopover();
      return;
    }

    const unreadCount = state.notifications.filter((notification) => !notification.read_at).length;
    const badge = $("#notification-badge");
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    $("#notification-button").classList.toggle("has-unread", unreadCount > 0);
    $("#notification-button").setAttribute("aria-label", unreadCount ? `Open notifications, ${unreadCount} unread` : "Open notifications");

    const isMuted = Boolean(state.notificationPreferences.notifications_muted);
    $("#notification-mute").textContent = isMuted ? "RESUME" : "MUTE";
    $("#notification-muted-state").hidden = !isMuted;
    $("#notification-mute").disabled = !state.notificationsAvailable;
    $("#notification-read-all").disabled = !state.notificationsAvailable || unreadCount === 0;
    $("#notification-sweep").disabled = !state.notificationsAvailable || state.notifications.length === 0;

    const list = $("#notification-list");
    if (!state.notificationsAvailable) {
      list.innerHTML = '<div class="notification-empty"><b>ALERT NETWORK OFFLINE</b><span>The notification database update is not active yet.</span></div>';
      return;
    }
    if (!state.notifications.length) {
      list.innerHTML = '<div class="notification-empty"><b>ALL CLEAR</b><span>Follow an operator or an individual setup to receive activity and lifecycle alerts here.</span></div>';
      return;
    }
    list.innerHTML = state.notifications.map(notificationItem).join("");
  }

  function notificationItem(notification) {
    const unread = !notification.read_at;
    return `<button class="notification-item${unread ? " is-unread" : ""}" type="button" data-notification-id="${escapeAttr(notification.id)}">
      <span class="notification-type-icon" data-notification-type="${escapeAttr(notification.notification_type)}">${notificationIcon(notification.notification_type)}</span>
      <span class="notification-copy"><b>${escapeHtml(notificationMessage(notification))}</b><small>${escapeHtml(notificationDetail(notification))}</small></span>
      ${unread ? '<i class="notification-unread-dot" aria-label="Unread"></i>' : ""}
    </button>`;
  }

  function notificationMessage(notification) {
    const actor = `@${notification.actor_handle || "operator"}`;
    const ticker = notification.ticker || "a setup";
    if (notification.notification_type === "COMMENT") return `${actor} commented on ${ticker}`;
    if (notification.notification_type === "REPLY") return `${actor} replied to your comment on ${ticker}`;
    if (notification.notification_type === "MENTION") return `${actor} mentioned you on ${ticker}`;
    if (notification.notification_type === "ENTRY_HIT") return `${ticker} by ${actor} achieved entry`;
    if (notification.notification_type === "SETUP_HOT") return `${ticker} moved to the Hot book`;
    if (notification.notification_type === "SETUP_ENTRY") return `${ticker} achieved entry`;
    if (notification.notification_type === "SETUP_T1") return `${ticker} hit T1`;
    if (notification.notification_type === "SETUP_T2") return `${ticker} hit T2`;
    if (notification.notification_type === "SETUP_T3") return `${ticker} hit T3`;
    if (notification.notification_type === "SETUP_STOPPED") return `${ticker} hit its published stop`;
    if (notification.notification_type === "VICTORY") return `${ticker} closed ${formatR(notification.r_result ?? notification.score)}`;
    if (notification.notification_type === "LOSS_CARD") return `${ticker} closed ${formatR(notification.r_result ?? notification.score)}`;
    return `${actor} published ${ticker}`;
  }

  function notificationDetail(notification) {
    const labels = {
      VICTORY: "VERIFIED WIN / OPEN VICTORY CARD",
      LOSS_CARD: "VERIFIED LOSS / OPEN LOSS CARD",
      COMMENT: "COMMENT",
      REPLY: "REPLY TO YOUR COMMENT",
      MENTION: "HANDLE MENTION",
      ENTRY_HIT: "OPERATOR ENTRY ACHIEVED",
      NEW_SETUP: "NEW SETUP",
      SETUP_HOT: "FOLLOWED SETUP · HOT",
      SETUP_ENTRY: "FOLLOWED SETUP · ENTRY",
      SETUP_T1: "FOLLOWED SETUP · T1",
      SETUP_T2: "FOLLOWED SETUP · T2",
      SETUP_T3: "FOLLOWED SETUP · T3",
      SETUP_STOPPED: "FOLLOWED SETUP · STOPPED"
    };
    const type = labels[notification.notification_type] || "LEDGER ALERT";
    const status = notification.setup_status ? ` · ${labelize(notification.setup_status)}` : "";
    return `${type}${status} · ${formatRelative(notification.created_at)}`;
  }

  function notificationIcon(type) {
    if (type === "COMMENT") return "C";
    if (type === "REPLY") return "R";
    if (type === "MENTION") return "@";
    if (type === "ENTRY_HIT" || type === "SETUP_ENTRY") return "E";
    if (type === "SETUP_HOT") return "H";
    if (type === "SETUP_T1") return "1";
    if (type === "SETUP_T2") return "2";
    if (type === "SETUP_T3") return "3";
    if (type === "SETUP_STOPPED") return "S";
    if (type === "VICTORY") return "V";
    if (type === "LOSS_CARD") return "L";
    return "N";
  }

  async function markAllNotificationsRead() {
    if (!state.supabase || !state.session?.user) return;
    const readAt = new Date().toISOString();
    const { error } = await state.supabase
      .from("notifications")
      .update({ read_at: readAt })
      .eq("recipient_id", state.session.user.id)
      .is("read_at", null);
    if (error) {
      showToast("Notifications not updated", error.message, true);
      return;
    }
    state.notifications = state.notifications.map((notification) => ({ ...notification, read_at: notification.read_at || readAt }));
    renderNotificationUI();
  }

  async function sweepNotifications() {
    if (!state.supabase || !state.session?.user || !state.notifications.length) return;
    if (!window.confirm("Clear every notification from your Ledger inbox?")) return;
    const { error } = await state.supabase
      .from("notifications")
      .delete()
      .eq("recipient_id", state.session.user.id);
    if (error) {
      showToast("Inbox not cleared", error.message, true);
      return;
    }
    state.notifications = [];
    renderNotificationUI();
    showToast("Inbox swept", "Your notification feed is clear.");
  }

  async function openNotification(notification) {
    closeNotificationPopover();
    if (!notification.read_at && state.supabase) {
      const readAt = new Date().toISOString();
      notification.read_at = readAt;
      renderNotificationUI();
      const { error } = await state.supabase.from("notifications").update({ read_at: readAt }).eq("id", notification.id);
      if (error) console.warn("Notification read state was not saved.", error);
    }

    let setup = state.setups.find((item) => String(item.id) === String(notification.setup_id));
    if (!setup && state.supabase && notification.setup_id) {
      const { data } = await state.supabase.from("setups_public").select("*").eq("id", notification.setup_id).maybeSingle();
      if (data) {
        setup = normalizeSetup(data);
        state.setups.unshift(setup);
      }
    }
    if (!setup) return;

    if (notification.notification_type === "VICTORY" && isWinningSetup(setup)) {
      openSetupBook("resolved", false);
      requestAnimationFrame(() => openVictoryCard(setup));
      return;
    }
    if (notification.notification_type === "LOSS_CARD" && isLosingSetup(setup)) {
      openSetupBook("resolved", false);
      requestAnimationFrame(() => openLossCard(setup));
      return;
    }

    const setupId = String(setup.id);
    const commentNotification = ["COMMENT", "REPLY", "MENTION"].includes(notification.notification_type);
    if (commentNotification) state.expandedComments.add(setupId);
    openSetupBook(normalizeState(setup.status));
    if (commentNotification) await loadSetupComments(setupId);
    requestAnimationFrame(() => {
      if (commentNotification && notification.comment_id) jumpToComment(setupId, notification.comment_id);
      else document.getElementById(`setup-${setupId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function bindUtilities() {
    $("#theme-toggle").addEventListener("click", toggleTheme);
    applyLocationRoute();
    window.addEventListener("popstate", applyLocationRoute);
  }

  function readStoredSetupLayout() {
    try {
      const saved = localStorage.getItem("ledger-setup-layout");
      return setupLayoutOptions.has(saved) ? saved : "panels";
    } catch (_error) {
      return "panels";
    }
  }

  function initTheme() {
    const savedTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    applyTheme(savedTheme, false);
  }

  function toggleTheme() {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(nextTheme, true);
    renderNetworkChart();
  }

  function applyTheme(theme, persist) {
    const nextTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    document.body.classList.toggle("light-mode", nextTheme === "light");
    const button = $("#theme-toggle");
    const targetLabel = nextTheme === "light" ? "Switch to dark mode" : "Switch to light mode";
    button.setAttribute("aria-label", targetLabel);
    button.setAttribute("title", targetLabel);
    button.setAttribute("aria-pressed", String(nextTheme === "light"));
    $("#theme-color-meta").setAttribute("content", nextTheme === "light" ? "#eef1f5" : "#06070b");
    if (persist) {
      try { localStorage.setItem("ledger-theme", nextTheme); } catch (_error) { /* Storage can be disabled. */ }
    }
  }

  function applyLocationRoute() {
    const params = new URLSearchParams(location.search);
    const book = params.get("book");
    const victoryId = params.get("victory");
    if (victoryId) {
      openSetupBook("resolved", false);
      const victorySetup = state.setups.find((setup) => String(setup.id) === victoryId);
      if (victorySetup && isWinningSetup(victorySetup)) openVictoryCard(victorySetup, false);
      return;
    }
    const lossId = params.get("loss");
    if (lossId) {
      openSetupBook("resolved", false);
      const lossSetup = state.setups.find((setup) => String(setup.id) === lossId);
      if (lossSetup && isLosingSetup(lossSetup)) openLossCard(lossSetup, false);
      return;
    }
    const outcomeDialog = $("#outcome-dialog");
    if (outcomeDialog?.open) outcomeDialog.close();
    if (location.hash === "#setups" || setupBooks[book]) {
      openSetupBook(book || "all", false);
      return;
    }
    if (location.hash === "#leaderboard") {
      switchView("leaderboard", false);
      return;
    }
    switchView("overview", false);
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
    const resolutionRate = setupCount > 0 ? Math.round((resolvedCount / setupCount) * 100) : 0;
    $$('[data-metric="operators"]').forEach((node) => node.textContent = formatInteger(operatorCount));
    $$('[data-metric="setups"]').forEach((node) => node.textContent = formatInteger(setupCount));
    $$('[data-metric="resolved"]').forEach((node) => node.textContent = formatInteger(resolvedCount));
    const resolutionRing = $(".metric-ring");
    if (resolutionRing) {
      resolutionRing.style.setProperty("--value", resolutionRate);
      const label = $("span", resolutionRing);
      if (label) label.textContent = `${resolutionRate}%`;
    }
  }

  function updateAuthAvailability() {
    const notice = $("#auth-setup-notice");
    if (notice) notice.hidden = liveConfigPresent;
    [$("#credential-sign-in"), $("#credential-sign-up")].forEach((button) => {
      if (!button) return;
      if (liveConfigPresent) button.removeAttribute("aria-describedby");
      else button.setAttribute("aria-describedby", "auth-setup-notice");
    });
    const identityState = $("#network-identity-state");
    if (identityState) {
      identityState.textContent = liveConfigPresent ? "ACCOUNTS READY" : "SETUP REQUIRED";
      identityState.classList.toggle("positive", liveConfigPresent);
    }
    const integrityStatus = $("#integrity-status");
    const integrityDetail = $("#integrity-detail");
    const integrityNetworkState = $("#integrity-network-state");
    if (integrityStatus) integrityStatus.textContent = state.live ? "RLS" : "—";
    if (integrityDetail) integrityDetail.textContent = state.live ? "enforced" : "standby";
    if (integrityNetworkState) integrityNetworkState.textContent = state.live ? "VERIFIED" : "PENDING";
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

  function avatarContent(avatarUrl, fallback) {
    if (avatarUrl) return `<img src="${escapeAttr(avatarUrl)}" alt="">`;
    return escapeHtml(initials(fallback));
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

  function percentFromEntry(setup) {
    if (!Number.isFinite(setup.entry) || !Number.isFinite(setup.current_price) || setup.entry === 0) return null;
    return ((setup.current_price - setup.entry) / setup.entry) * 100;
  }

  function operatorHistory(setup) {
    const leader = [...state.leaders, ...state.compactLeaders].find((item) => String(item.id) === String(setup.user_id) || item.handle === setup.handle);
    return {
      avg_r: setup.operator_avg_r ?? leader?.avg_r ?? null,
      win_rate: setup.operator_win_rate ?? leader?.win_rate ?? null,
      triggered_setups: setup.operator_triggered_setups || leader?.triggered_setups || 0,
      total_setups: setup.operator_total_setups || leader?.total_setups || 0,
      goat_score: setup.operator_goat_score ?? leader?.goat_score ?? null
    };
  }

  function operatorMetric(setup, key) {
    const rawValue = operatorHistory(setup)[key];
    if (rawValue == null) return -Infinity;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : -Infinity;
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

  function formatSignedPercent(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${formatNumber(number, 2)}%`;
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

  function formatMonthYear(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, { month: "short", year: "numeric" }).toUpperCase();
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(Number(bytes))) return "—";
    return `${formatNumber(Number(bytes) / 1048576, 2)} MB`;
  }

  function validateImageFile(file) {
    if (!file) return null;
    if (!imageMimeTypes.has(file.type)) return "Use a JPG, PNG, or WEBP image.";
    if (file.size > maxImageBytes) return "The image must be 2 MB or smaller.";
    return null;
  }

  function selectedAttachmentFile(input) {
    return pastedAttachmentFiles.get(input) || input?.files?.[0] || null;
  }

  function clipboardImageFile(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) return null;
    const imageItem = Array.from(clipboard.items || []).find((item) => item.kind === "file" && item.type.startsWith("image/"));
    return imageItem?.getAsFile() || Array.from(clipboard.files || []).find((file) => file.type.startsWith("image/")) || null;
  }

  function namedClipboardImage(file) {
    const extension = imageExtension(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([file], `clipboard-${stamp}.${extension}`, {
      type: file.type,
      lastModified: Date.now()
    });
  }

  function handleAttachmentPaste(event, input, preview, scope) {
    const clipboardFile = clipboardImageFile(event);
    if (!clipboardFile || !input || !preview) return false;
    event.preventDefault();
    const file = namedClipboardImage(clipboardFile);
    const error = validateImageFile(file);
    if (error) {
      showToast("Pasted image not accepted", error, true);
      return true;
    }

    pastedAttachmentFiles.set(input, file);
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
    } catch (_error) {
      // The WeakMap retains the pasted File when a browser blocks FileList assignment.
    }
    updateAttachmentPreview(input, preview);
    window.requestAnimationFrame(() => preview.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    const target = input.closest(".attachment-upload, .comment-compose-body");
    target?.classList.add("has-pasted-image");
    window.setTimeout(() => target?.classList.remove("has-pasted-image"), 900);
    showToast("Image pasted", `The clipboard image is attached to this ${scope}.`);
    return true;
  }

  function parseAttachmentText(value) {
    const storedText = String(value || "");
    const match = storedText.match(attachmentMarkerPattern);
    if (!match) return { text: storedText, path: null };
    return { text: storedText.slice(0, match.index).trimEnd(), path: match[1] };
  }

  function serializeAttachmentText(value, objectPath, maxLength) {
    const text = String(value || "").trim();
    if (!objectPath) return text;
    const storedText = `${text ? `${text}\n` : ""}[ledger-image:${objectPath}]`;
    if (storedText.length > maxLength) {
      throw new Error(`Shorten the text so the image can fit in the ${maxLength}-character public record.`);
    }
    return storedText;
  }

  function updateAttachmentPreview(input, preview) {
    const file = selectedAttachmentFile(input);
    const error = validateImageFile(file);
    if (!file || error) {
      clearAttachmentPreview(input, preview);
      if (error) showToast("Image not accepted", error, true);
      return;
    }
    const previousUrl = preview.dataset.objectUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const objectUrl = URL.createObjectURL(file);
    preview.dataset.objectUrl = objectUrl;
    $("img", preview).src = objectUrl;
    $("[data-attachment-name]", preview).textContent = file.name;
    $("[data-attachment-size]", preview).textContent = formatFileSize(file.size);
    preview.hidden = false;
  }

  function clearAttachmentPreview(input, preview) {
    const objectUrl = preview?.dataset.objectUrl;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (input) {
      pastedAttachmentFiles.delete(input);
      input.value = "";
    }
    if (preview) {
      delete preview.dataset.objectUrl;
      const image = $("img", preview);
      if (image) image.removeAttribute("src");
      const name = $("[data-attachment-name]", preview);
      const size = $("[data-attachment-size]", preview);
      if (name) name.textContent = "";
      if (size) size.textContent = "";
      preview.hidden = true;
    }
  }

  function imageExtension(file) {
    return file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  }

  async function uploadLedgerImage(file, scope) {
    const error = validateImageFile(file);
    if (error) throw new Error(error);
    if (!state.session?.user || !state.supabase) throw new Error("Sign in before uploading an image.");
    const objectPath = `${state.session.user.id}/ledger-media/${scope}/${crypto.randomUUID()}.${imageExtension(file)}`;
    const { error: uploadError } = await state.supabase.storage.from(mediaBucket).upload(objectPath, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false
    });
    if (uploadError) throw uploadError;
    return objectPath;
  }

  async function removeLedgerImage(objectPath) {
    if (!objectPath || !state.supabase) return;
    await state.supabase.storage.from(mediaBucket).remove([objectPath]);
  }

  function publicMediaUrl(objectPath) {
    if (!objectPath || !state.supabase) return "";
    return state.supabase.storage.from(mediaBucket).getPublicUrl(objectPath).data.publicUrl;
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
