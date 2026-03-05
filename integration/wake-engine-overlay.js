(function () {
  const POLL_INTERVAL_MS = 5000;
  const COMPACT_LAYOUT_QUERY = "(max-width: 720px)";
  const STYLE_ID = "wake-engine-overlay-style";
  const API = {
    wake: "/api/wake-engine",
    status: "/api/engine-status",
    health: "/api/engine-health",
    diag: "/api/custom/diag",
  };

  const state = {
    mounted: false,
    uiState: "idle",
    engineState: "offline",
    requestId: null,
    lastHealth: null,
    pollTimer: null,
    featureEnabled: true,
    targetName: "gaming-pc",
    mountPriority: 0,
  };

  const dom = {
    root: null,
    wakeButton: null,
    badge: null,
    diagnosticsBackdrop: null,
    diagnosticsNote: null,
    diagnosticsRows: {},
    diagnosticsRefreshButton: null,
  };
  let mountScheduled = false;

  function log(eventName, details) {
    const payload = {
      timestamp: new Date().toISOString(),
      component: "frontend",
      event: eventName,
      state: state.uiState,
      request_id: state.requestId,
      details: details || {},
    };
    console.info("[wake-overlay]", payload);
  }

  async function fetchJson(url, options) {
    try {
      const response = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
      if (!response.ok) {
        const text = await response.text();
        throw new Error("HTTP " + response.status + ": " + text);
      }
      return await response.json();
    } catch (error) {
      log("wake_api_fetch_failed", { url: url, error: String(error) });
      throw error;
    }
  }

  function isCompactLayout() {
    return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
  }

  function colorForState(uiState) {
    switch (uiState) {
      case "online":
        return "#0f766e";
      case "host_online":
        return "#2563eb";
      case "waking":
        return "#b45309";
      case "timeout":
      case "error":
        return "#b91c1c";
      default:
        return "#475569";
    }
  }

  function fullLabelForState(uiState) {
    switch (uiState) {
      case "online":
        return "Ready";
      case "host_online":
        return "Host Online";
      case "waking":
        return "Waking";
      case "timeout":
        return "Timeout";
      case "error":
        return "Error";
      default:
        return "Offline";
    }
  }

  function compactLabelForState(uiState) {
    switch (uiState) {
      case "online":
        return "Ready";
      case "host_online":
        return "Host";
      case "waking":
        return "Wake";
      case "timeout":
        return "Time";
      case "error":
        return "Err";
      default:
        return "Off";
    }
  }

  function badgeLabelForState(uiState) {
    return isCompactLayout() ? compactLabelForState(uiState) : fullLabelForState(uiState);
  }

  function buttonLabelForState(uiState) {
    if (uiState === "waking") {
      return isCompactLayout() ? "Waking" : "Waking...";
    }
    if (uiState === "host_online") {
      return isCompactLayout() ? "Starting" : "Starting Ollama...";
    }
    return isCompactLayout() ? "Wake" : "Wake Engine";
  }

  function isWakeInProgress(uiState) {
    return uiState === "waking" || uiState === "host_online";
  }

  function shouldShowWakeButton(uiState) {
    return uiState !== "online";
  }

  function syncDom() {
    if (!dom.root) {
      return;
    }

    const wakeInProgress = isWakeInProgress(state.uiState);
    const showWakeButton = shouldShowWakeButton(state.uiState);

    dom.root.dataset.state = state.uiState;
    dom.wakeButton.textContent = buttonLabelForState(state.uiState);
    dom.wakeButton.disabled = wakeInProgress;
    dom.wakeButton.hidden = !showWakeButton;
    dom.wakeButton.setAttribute("aria-hidden", showWakeButton ? "false" : "true");
    dom.wakeButton.title = showWakeButton ? "Send a Wake-on-LAN packet to start the engine" : "";

    dom.badge.textContent = badgeLabelForState(state.uiState);
    dom.badge.style.background = colorForState(state.uiState);
    dom.badge.title = "Open engine diagnostics";
  }

  function setState(next) {
    if (next.uiState) {
      state.uiState = next.uiState;
    }
    if (next.engineState) {
      state.engineState = next.engineState;
    }
    if (Object.prototype.hasOwnProperty.call(next, "requestId")) {
      state.requestId = next.requestId;
    }
    syncDom();
  }

  function ensurePolling() {
    if (state.pollTimer) {
      return;
    }

    state.pollTimer = window.setInterval(refreshStatus, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!state.pollTimer) {
      return;
    }

    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function refreshStatus() {
    try {
      const payload = await fetchJson(API.status);
      setState({
        uiState: payload.ui_state || "idle",
        engineState: payload.state || "offline",
        requestId: payload.request_id || null,
      });
      log("status_polled", payload);
      if (["waking", "host_online"].includes(payload.ui_state || "idle")) {
        ensurePolling();
      } else {
        stopPolling();
      }
    } catch (error) {
      setState({ uiState: "error" });
      stopPolling();
    }
  }

  function formatTimestamp(value) {
    if (!value) {
      return "Not yet";
    }

    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return String(value);
    }
  }

  function formatFlag(value) {
    if (value === true) {
      return "Yes";
    }
    if (value === false) {
      return "No";
    }
    return "Unknown";
  }

  function inferReachabilityFromState(uiState) {
    switch (uiState) {
      case "online":
        return { host: true, ollama: true };
      case "host_online":
        return { host: true, ollama: false };
      case "waking":
      case "timeout":
      case "error":
      case "idle":
      default:
        return { host: false, ollama: false };
    }
  }

  function buildCachedDiagnosticsSnapshot() {
    const snapshot = state.lastHealth ? Object.assign({}, state.lastHealth) : {};
    const uiState = state.uiState || snapshot.ui_state || "idle";
    const reachability = inferReachabilityFromState(uiState);

    snapshot.ui_state = uiState;
    snapshot.engine_state = state.engineState || snapshot.engine_state || "offline";
    snapshot.current_request_id = state.requestId || snapshot.current_request_id || null;
    snapshot.host_reachable = reachability.host;
    snapshot.ollama_reachable = reachability.ollama;

    return snapshot;
  }

  function setDiagnosticsRow(key, value) {
    if (!dom.diagnosticsRows[key]) {
      return;
    }

    dom.diagnosticsRows[key].textContent = value;
  }

  function closeDiagnosticsModal() {
    if (!dom.diagnosticsBackdrop) {
      return;
    }

    dom.diagnosticsBackdrop.hidden = true;
  }

  function buildDiagnosticsModal() {
    if (dom.diagnosticsBackdrop) {
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.id = "wake-engine-diagnostics-backdrop";
    backdrop.hidden = true;

    const dialog = document.createElement("div");
    dialog.id = "wake-engine-diagnostics";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "wake-engine-diagnostics-title");

    const title = document.createElement("h3");
    title.id = "wake-engine-diagnostics-title";
    title.textContent = "Engine Diagnostics";

    const note = document.createElement("p");
    note.className = "wake-engine-diagnostics-note";

    const rows = document.createElement("div");
    rows.className = "wake-engine-diagnostics-rows";

    [
      ["status", "Status"],
      ["host", "Host Online"],
      ["ollama", "Ollama Ready"],
      ["lastWake", "Last Wake Attempt"],
      ["hostOnlineAt", "Host Came Online"],
      ["readyAt", "Ready At"],
      ["lastReachable", "Last Reachable"],
      ["lastError", "Last Error"],
      ["requestId", "Request ID"],
    ].forEach(function (entry) {
      const row = document.createElement("div");
      row.className = "wake-engine-diagnostics-row";

      const label = document.createElement("span");
      label.className = "wake-engine-diagnostics-label";
      label.textContent = entry[1];

      const value = document.createElement("span");
      value.className = "wake-engine-diagnostics-value";

      row.appendChild(label);
      row.appendChild(value);
      rows.appendChild(row);
      dom.diagnosticsRows[entry[0]] = value;
    });

    const footer = document.createElement("div");
    footer.className = "wake-engine-diagnostics-footer";

    const refreshButton = makeButton("Refresh Status", "wake-engine-modal-button wake-engine-modal-primary");
    refreshButton.addEventListener("click", refreshDiagnostics);

    const closeButton = makeButton("Close", "wake-engine-modal-button");
    closeButton.addEventListener("click", closeDiagnosticsModal);

    footer.appendChild(refreshButton);
    footer.appendChild(closeButton);

    dialog.appendChild(title);
    dialog.appendChild(note);
    dialog.appendChild(rows);
    dialog.appendChild(footer);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", function (event) {
      if (event.target === backdrop) {
        closeDiagnosticsModal();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && dom.diagnosticsBackdrop && !dom.diagnosticsBackdrop.hidden) {
        closeDiagnosticsModal();
      }
    });

    dom.diagnosticsBackdrop = backdrop;
    dom.diagnosticsNote = note;
    dom.diagnosticsRefreshButton = refreshButton;
  }

  function renderDiagnosticsModal(payload) {
    const snapshot = payload || buildCachedDiagnosticsSnapshot();
    const usingLiveData = !!payload;

    setDiagnosticsRow("status", fullLabelForState(snapshot.ui_state || state.uiState || "idle"));
    setDiagnosticsRow("host", formatFlag(snapshot.host_reachable));
    setDiagnosticsRow("ollama", formatFlag(snapshot.ollama_reachable));
    setDiagnosticsRow("lastWake", formatTimestamp(snapshot.last_wake_attempt_at));
    setDiagnosticsRow("hostOnlineAt", formatTimestamp(snapshot.last_host_online_at));
    setDiagnosticsRow("readyAt", formatTimestamp(snapshot.last_successful_wake_at));
    setDiagnosticsRow("lastReachable", formatTimestamp(snapshot.last_reachable_at));
    setDiagnosticsRow("lastError", snapshot.last_failure_reason || "None");
    setDiagnosticsRow("requestId", snapshot.current_request_id || state.requestId || "None");

    if (dom.diagnosticsNote) {
      dom.diagnosticsNote.textContent = usingLiveData
        ? "Live status was refreshed just now."
        : "Showing cached status from the passive engine state. Use Refresh Status to run a live health check and update the detailed timestamps.";
    }
  }

  function openDiagnosticsModal() {
    buildDiagnosticsModal();
    renderDiagnosticsModal(state.lastHealth);
    dom.diagnosticsBackdrop.hidden = false;
  }

  async function refreshDiagnostics() {
    buildDiagnosticsModal();
    dom.diagnosticsRefreshButton.disabled = true;
    dom.diagnosticsRefreshButton.textContent = "Refreshing...";

    try {
      const payload = await fetchJson(API.health);
      state.lastHealth = payload;
      setState({
        uiState: payload.ui_state || state.uiState,
        engineState: payload.engine_state || state.engineState,
        requestId: payload.current_request_id || null,
      });
      if (["waking", "host_online"].includes(payload.ui_state || "idle")) {
        ensurePolling();
      } else {
        stopPolling();
      }
      log("diagnostics_refreshed", payload);
      renderDiagnosticsModal(payload);
    } catch (error) {
      log("diagnostics_refresh_failed", { error: String(error) });
      if (dom.diagnosticsNote) {
        dom.diagnosticsNote.textContent = "Refresh failed: " + String(error);
      }
    } finally {
      dom.diagnosticsRefreshButton.disabled = false;
      dom.diagnosticsRefreshButton.textContent = "Refresh Status";
    }
  }

  async function wakeEngine() {
    if (isWakeInProgress(state.uiState)) {
      return;
    }

    log("header_button_clicked");
    setState({ uiState: "waking" });

    try {
      const payload = await fetchJson(API.wake, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: state.targetName }),
      });

      setState({
        uiState: payload.state || "waking",
        requestId: payload.request_id || null,
      });
      log("wake_request_sent", payload);
      ensurePolling();
      await refreshStatus();
    } catch (error) {
      setState({ uiState: "error" });
    }
  }

  async function showDiagnostics() {
    log("diagnostics_opened", { cached: !!state.lastHealth });
    openDiagnosticsModal();
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#wake-engine-controls {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 6px;",
      "  margin-left: 10px;",
      "  flex: 0 0 auto;",
      "  --wake-surface: rgba(15, 23, 42, 0.045);",
      "  --wake-surface-hover: rgba(15, 23, 42, 0.075);",
      "  --wake-border: rgba(100, 116, 139, 0.24);",
      "  --wake-text: #0f172a;",
      "  --wake-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);",
      "}",
      "#wake-engine-controls .wake-engine-button,",
      "#wake-engine-controls .wake-engine-badge {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  appearance: none;",
      "  min-height: 32px;",
      "  border: 1px solid var(--wake-border);",
      "  border-radius: 999px;",
      "  padding: 0 12px;",
      "  background: var(--wake-surface);",
      "  color: var(--wake-text);",
      "  box-shadow: var(--wake-shadow);",
      "  font: inherit;",
      "  font-size: 0.8rem;",
      "  line-height: 1;",
      "  font-weight: 600;",
      "  letter-spacing: 0.01em;",
      "  white-space: nowrap;",
      "  transition: background-color 0.16s ease, border-color 0.16s ease, transform 0.16s ease, opacity 0.16s ease, box-shadow 0.16s ease;",
      "}",
      "#wake-engine-controls .wake-engine-button {",
      "  cursor: pointer;",
      "}",
      "#wake-engine-controls .wake-engine-button:hover:not(:disabled),",
      "#wake-engine-controls .wake-engine-badge:hover {",
      "  background: var(--wake-surface-hover);",
      "  border-color: rgba(100, 116, 139, 0.36);",
      "  transform: translateY(-1px);",
      "}",
      "#wake-engine-controls .wake-engine-button:disabled {",
      "  opacity: 0.84;",
      "  cursor: default;",
      "  transform: none;",
      "}",
      "#wake-engine-controls .wake-engine-button[hidden] {",
      "  display: none !important;",
      "}",
      "#wake-engine-controls .wake-engine-badge {",
      "  color: #ffffff;",
      "  border-color: transparent;",
      "  padding: 0 11px;",
      "  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.14);",
      "  cursor: pointer;",
      "}",
      "#wake-engine-controls[data-state='online'] .wake-engine-badge {",
      "  min-width: 64px;",
      "}",
      "#wake-engine-diagnostics-backdrop {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 2147483646;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  padding: 16px;",
      "  background: rgba(2, 6, 23, 0.52);",
      "  backdrop-filter: blur(6px);",
      "}",
      "#wake-engine-diagnostics-backdrop[hidden] {",
      "  display: none !important;",
      "}",
      "#wake-engine-diagnostics {",
      "  width: min(100%, 440px);",
      "  border: 1px solid rgba(100, 116, 139, 0.24);",
      "  border-radius: 18px;",
      "  padding: 18px;",
      "  background: rgba(255, 255, 255, 0.96);",
      "  color: #0f172a;",
      "  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.24);",
      "}",
      "#wake-engine-diagnostics h3 {",
      "  margin: 0 0 8px;",
      "  font-size: 1rem;",
      "  font-weight: 700;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-note {",
      "  margin: 0 0 14px;",
      "  font-size: 0.82rem;",
      "  line-height: 1.35;",
      "  color: #475569;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-rows {",
      "  display: grid;",
      "  gap: 9px;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-row {",
      "  display: grid;",
      "  grid-template-columns: minmax(0, 1fr) auto;",
      "  gap: 12px;",
      "  align-items: center;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-label {",
      "  font-size: 0.78rem;",
      "  font-weight: 600;",
      "  color: #475569;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-value {",
      "  font-size: 0.8rem;",
      "  font-weight: 600;",
      "  color: #0f172a;",
      "  text-align: right;",
      "}",
      "#wake-engine-diagnostics .wake-engine-diagnostics-footer {",
      "  display: flex;",
      "  justify-content: flex-end;",
      "  gap: 8px;",
      "  margin-top: 16px;",
      "}",
      "#wake-engine-diagnostics .wake-engine-modal-button {",
      "  appearance: none;",
      "  min-height: 34px;",
      "  padding: 0 12px;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(100, 116, 139, 0.22);",
      "  background: rgba(15, 23, 42, 0.04);",
      "  color: #0f172a;",
      "  font: inherit;",
      "  font-size: 0.8rem;",
      "  font-weight: 600;",
      "  cursor: pointer;",
      "}",
      "#wake-engine-diagnostics .wake-engine-modal-button:hover:not(:disabled) {",
      "  background: rgba(15, 23, 42, 0.08);",
      "}",
      "#wake-engine-diagnostics .wake-engine-modal-button:disabled {",
      "  opacity: 0.7;",
      "  cursor: default;",
      "}",
      "#wake-engine-diagnostics .wake-engine-modal-primary {",
      "  background: #0f172a;",
      "  border-color: #0f172a;",
      "  color: #f8fafc;",
      "}",
      "#wake-engine-diagnostics .wake-engine-modal-primary:hover:not(:disabled) {",
      "  background: #1e293b;",
      "}",
      "html.dark #wake-engine-controls,",
      "html.her #wake-engine-controls {",
      "  --wake-surface: rgba(255, 255, 255, 0.07);",
      "  --wake-surface-hover: rgba(255, 255, 255, 0.11);",
      "  --wake-border: rgba(255, 255, 255, 0.12);",
      "  --wake-text: #f8fafc;",
      "  --wake-shadow: 0 1px 2px rgba(2, 6, 23, 0.3);",
      "}",
      "html.dark #wake-engine-diagnostics,",
      "html.her #wake-engine-diagnostics {",
      "  background: rgba(15, 23, 42, 0.96);",
      "  border-color: rgba(148, 163, 184, 0.2);",
      "  color: #f8fafc;",
      "}",
      "html.dark #wake-engine-diagnostics .wake-engine-diagnostics-note,",
      "html.dark #wake-engine-diagnostics .wake-engine-diagnostics-label,",
      "html.her #wake-engine-diagnostics .wake-engine-diagnostics-note,",
      "html.her #wake-engine-diagnostics .wake-engine-diagnostics-label {",
      "  color: #cbd5e1;",
      "}",
      "html.dark #wake-engine-diagnostics .wake-engine-diagnostics-value,",
      "html.her #wake-engine-diagnostics .wake-engine-diagnostics-value {",
      "  color: #f8fafc;",
      "}",
      "html.dark #wake-engine-diagnostics .wake-engine-modal-button,",
      "html.her #wake-engine-diagnostics .wake-engine-modal-button {",
      "  background: rgba(255, 255, 255, 0.08);",
      "  border-color: rgba(255, 255, 255, 0.12);",
      "  color: #f8fafc;",
      "}",
      "html.dark #wake-engine-diagnostics .wake-engine-modal-button:hover:not(:disabled),",
      "html.her #wake-engine-diagnostics .wake-engine-modal-button:hover:not(:disabled) {",
      "  background: rgba(255, 255, 255, 0.12);",
      "}",
      "html.dark #wake-engine-diagnostics .wake-engine-modal-primary,",
      "html.her #wake-engine-diagnostics .wake-engine-modal-primary {",
      "  background: #e2e8f0;",
      "  border-color: #e2e8f0;",
      "  color: #0f172a;",
      "}",
      "@media (max-width: 720px) {",
      "  #wake-engine-controls {",
      "    gap: 5px;",
      "    margin-left: 8px;",
      "  }",
      "  #wake-engine-controls .wake-engine-button,",
      "  #wake-engine-controls .wake-engine-badge {",
      "    min-height: 28px;",
      "    padding: 0 9px;",
      "    font-size: 0.73rem;",
      "  }",
      "  #wake-engine-controls .wake-engine-badge {",
      "    min-width: 0;",
      "  }",
      "  #wake-engine-diagnostics {",
      "    width: min(100%, 360px);",
      "    padding: 15px;",
      "    border-radius: 16px;",
      "  }",
      "  #wake-engine-diagnostics .wake-engine-diagnostics-row {",
      "    grid-template-columns: 1fr;",
      "    gap: 3px;",
      "  }",
      "  #wake-engine-diagnostics .wake-engine-diagnostics-value {",
      "    text-align: left;",
      "  }",
      "  #wake-engine-diagnostics .wake-engine-diagnostics-footer {",
      "    justify-content: stretch;",
      "  }",
      "  #wake-engine-diagnostics .wake-engine-modal-button {",
      "    flex: 1 1 auto;",
      "    min-height: 32px;",
      "    font-size: 0.76rem;",
      "  }",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function makeButton(label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }

  function isVisible(node) {
    if (!node || !node.isConnected) {
      return false;
    }

    const styles = window.getComputedStyle(node);
    return styles.display !== "none" && styles.visibility !== "hidden";
  }

  function directInteractiveChildCount(node) {
    return Array.from(node.children).reduce(function (count, child) {
      const isInteractive =
        child.matches("button, select, input, [role='button'], [role='combobox']") ||
        !!child.querySelector("button, select, input, [role='button'], [role='combobox']");
      return count + (isInteractive ? 1 : 0);
    }, 0);
  }

  function depthFrom(node, ancestor) {
    let depth = 0;
    let current = node;

    while (current && current !== ancestor) {
      depth += 1;
      current = current.parentElement;
    }

    return depth;
  }

  function isDirectInteractiveElement(node) {
    return !!node && node.matches("button, a, [role='button'], [role='link']");
  }

  function isOverlayNode(node) {
    return !!node && node.id === "wake-engine-controls";
  }

  function visibleNonOverlayChildren(container) {
    return Array.from(container.children).filter(function (child) {
      return isVisible(child) && !isOverlayNode(child);
    });
  }

  function interactiveChildCount(container) {
    return visibleNonOverlayChildren(container).filter(function (child) {
      return (
        isDirectInteractiveElement(child) ||
        child.querySelector("button, a, [role='button'], [role='link']")
      );
    }).length;
  }

  function rightEdge(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return 0;
    }

    return node.getBoundingClientRect().right;
  }

  function centerX(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return 0;
    }

    const rect = node.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  function looksLikeModelSelectorCluster(node) {
    if (!node || !isVisible(node)) {
      return false;
    }

    if (node.querySelector("select, [role='combobox']")) {
      return true;
    }

    const text = (node.textContent || "").trim().toLowerCase();
    return (
      text.indexOf("select a model") !== -1 ||
      text.indexOf("set as default") !== -1 ||
      text.indexOf("model") !== -1
    );
  }

  function isSettingsNode(node) {
    if (!node || !isVisible(node) || !isDirectInteractiveElement(node)) {
      return false;
    }

    const href = (node.getAttribute("href") || "").toLowerCase();
    const ariaLabel = (node.getAttribute("aria-label") || "").toLowerCase();
    const title = (node.getAttribute("title") || "").toLowerCase();
    const testId = (node.getAttribute("data-testid") || "").toLowerCase();

    return (
      href.indexOf("/settings") !== -1 ||
      ariaLabel.indexOf("setting") !== -1 ||
      title.indexOf("setting") !== -1 ||
      testId.indexOf("setting") !== -1
    );
  }

  function isTemporaryChatNode(node) {
    if (!node || !isVisible(node) || !isDirectInteractiveElement(node)) {
      return false;
    }

    const ariaLabel = (node.getAttribute("aria-label") || "").toLowerCase();
    const title = (node.getAttribute("title") || "").toLowerCase();
    const testId = (node.getAttribute("data-testid") || "").toLowerCase();
    const text = (node.textContent || "").trim().toLowerCase();

    return (
      ariaLabel.indexOf("temporary") !== -1 ||
      title.indexOf("temporary") !== -1 ||
      testId.indexOf("temporary") !== -1 ||
      text.indexOf("temporary") !== -1
    );
  }

  function findSettingsAnchor(header) {
    return (
      Array.from(header.querySelectorAll("button, a, [role='button'], [role='link']")).find(
        isSettingsNode
      ) || null
    );
  }

  function findTemporaryChatAnchor(header) {
    return (
      Array.from(header.querySelectorAll("button, a, [role='button'], [role='link']")).find(
        isTemporaryChatNode
      ) || null
    );
  }

  function findRightmostInteractiveChild(container) {
    const children = visibleNonOverlayChildren(container);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (
        isDirectInteractiveElement(child) ||
        child.querySelector("button, a, [role='button'], [role='link']")
      ) {
        return child;
      }
    }

    return null;
  }

  function findLeftmostInteractiveChild(container) {
    const children = visibleNonOverlayChildren(container);

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (
        isDirectInteractiveElement(child) ||
        child.querySelector("button, a, [role='button'], [role='link']")
      ) {
        return child;
      }
    }

    return null;
  }

  function findActionCluster(startNode, header) {
    let current = startNode ? startNode.parentElement : null;

    while (current && current !== header) {
      if (
        isVisible(current) &&
        visibleNonOverlayChildren(current).length >= 2 &&
        visibleNonOverlayChildren(current).length <= 12 &&
        interactiveChildCount(current) >= 2
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return startNode && startNode.parentElement ? startNode.parentElement : null;
  }

  function findDirectChildForNode(container, node) {
    if (!container || !node) {
      return null;
    }

    let current = node;
    while (current && current.parentElement && current.parentElement !== container) {
      current = current.parentElement;
    }

    return current && current.parentElement === container ? current : null;
  }

  function resetMount() {
    state.mounted = false;
    dom.root = null;
    dom.wakeButton = null;
    dom.badge = null;
  }

  function buildControls() {
    ensureStyles();

    const wrapper = document.createElement("div");
    wrapper.id = "wake-engine-controls";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", "Engine controls");

    const wakeButton = makeButton("Wake Engine", "wake-engine-button");
    wakeButton.addEventListener("click", wakeEngine);

    const badge = makeButton("Offline", "wake-engine-badge");
    badge.addEventListener("click", showDiagnostics);

    wrapper.appendChild(wakeButton);
    wrapper.appendChild(badge);

    dom.root = wrapper;
    dom.wakeButton = wakeButton;
    dom.badge = badge;
    state.mounted = true;
  }

  function findHeaderTarget(header) {
    const candidates = Array.from(header.querySelectorAll("div, nav, section")).filter(function (
      candidate
    ) {
      return (
        isVisible(candidate) &&
        candidate.id !== "wake-engine-controls" &&
        visibleNonOverlayChildren(candidate).length > 0 &&
        visibleNonOverlayChildren(candidate).length <= 16 &&
        interactiveChildCount(candidate) >= 1
      );
    });

    candidates.sort(function (left, right) {
      const edgeDiff = rightEdge(right) - rightEdge(left);
      if (edgeDiff !== 0) {
        return edgeDiff;
      }

      const interactiveDiff = interactiveChildCount(right) - interactiveChildCount(left);
      if (interactiveDiff !== 0) {
        return interactiveDiff;
      }

      const depthDiff = depthFrom(right, header) - depthFrom(left, header);
      if (depthDiff !== 0) {
        return depthDiff;
      }

      return left.children.length - right.children.length;
    });

    return candidates[0] || header;
  }

  function findRightActionCluster(header) {
    if (!header || !isVisible(header)) {
      return null;
    }

    const headerRect = header.getBoundingClientRect();
    const rightHalfStart = headerRect.left + headerRect.width * 0.55;

    const candidates = Array.from(header.querySelectorAll("div, nav, section")).filter(function (
      candidate
    ) {
      if (!isVisible(candidate) || candidate.id === "wake-engine-controls") {
        return false;
      }

      const children = visibleNonOverlayChildren(candidate);
      if (children.length === 0 || children.length > 16) {
        return false;
      }

      if (interactiveChildCount(candidate) < 1) {
        return false;
      }

      if (centerX(candidate) < rightHalfStart) {
        return false;
      }

      if (looksLikeModelSelectorCluster(candidate)) {
        return false;
      }

      return true;
    });

    candidates.sort(function (left, right) {
      const leftInteractions = interactiveChildCount(left);
      const rightInteractions = interactiveChildCount(right);

      const leftInRange = leftInteractions >= 2 && leftInteractions <= 8 ? 1 : 0;
      const rightInRange = rightInteractions >= 2 && rightInteractions <= 8 ? 1 : 0;
      const rangeDiff = rightInRange - leftInRange;
      if (rangeDiff !== 0) {
        return rangeDiff;
      }

      const interactionDiff = rightInteractions - leftInteractions;
      if (interactionDiff !== 0) {
        return interactionDiff;
      }

      const edgeDiff = rightEdge(right) - rightEdge(left);
      if (edgeDiff !== 0) {
        return edgeDiff;
      }

      const widthDiff = left.getBoundingClientRect().width - right.getBoundingClientRect().width;
      if (widthDiff !== 0) {
        return widthDiff;
      }

      const depthDiff = depthFrom(right, header) - depthFrom(left, header);
      if (depthDiff !== 0) {
        return depthDiff;
      }

      return left.children.length - right.children.length;
    });

    return candidates[0] || null;
  }

  function findMountPlacement() {
    const header =
      document.querySelector("header") ||
      document.querySelector("nav") ||
      document.querySelector('[role="banner"]');

    if (!header) {
      return null;
    }

    const temporaryChatAnchor = findTemporaryChatAnchor(header);
    if (temporaryChatAnchor && temporaryChatAnchor.parentElement) {
      const actionCluster = findActionCluster(temporaryChatAnchor, header) || temporaryChatAnchor.parentElement;
      return {
        container: actionCluster,
        beforeNode:
          findDirectChildForNode(actionCluster, temporaryChatAnchor) ||
          findLeftmostInteractiveChild(actionCluster) ||
          temporaryChatAnchor,
        priority: 3,
      };
    }

    const settingsAnchor = findSettingsAnchor(header);
    if (settingsAnchor && settingsAnchor.parentElement) {
      const actionCluster = findActionCluster(settingsAnchor, header) || settingsAnchor.parentElement;
      return {
        container: actionCluster,
        beforeNode:
          findDirectChildForNode(actionCluster, settingsAnchor) ||
          findLeftmostInteractiveChild(actionCluster) ||
          settingsAnchor,
        priority: 2.5,
      };
    }

    const rightActionCluster = findRightActionCluster(header);
    if (rightActionCluster) {
      return {
        container: rightActionCluster,
        beforeNode: findLeftmostInteractiveChild(rightActionCluster) || null,
        priority: 2.2,
      };
    }

    const target = findHeaderTarget(header);
    if (!target) {
      return null;
    }

    return {
      container: target,
      beforeNode: findLeftmostInteractiveChild(target) || findRightmostInteractiveChild(target),
      priority: target === header ? 1 : 2,
    };
  }

  function mountInto(placement) {
    if (dom.root && !dom.root.isConnected) {
      resetMount();
    }

    if (!dom.root) {
      buildControls();
      log("header_controls_created");
    }

    const target = placement.container;
    const beforeNode =
      placement.beforeNode && placement.beforeNode.parentElement === target && placement.beforeNode !== dom.root
        ? placement.beforeNode
        : null;

    if (dom.root.parentElement !== target || dom.root.nextSibling !== beforeNode) {
      target.insertBefore(dom.root, beforeNode);
      log("header_controls_mounted", {
        target: target.tagName.toLowerCase(),
        anchored_before: beforeNode ? beforeNode.tagName.toLowerCase() : "none",
        priority: placement.priority || 0,
      });
    }

    state.mountPriority = placement.priority || 0;
    syncDom();
  }

  function mountWhenReady() {
    if (!state.featureEnabled) {
      return;
    }

    if (dom.root && !dom.root.isConnected) {
      resetMount();
    }

    const placement = findMountPlacement();
    if (!placement) {
      return;
    }

    if (
      dom.root &&
      dom.root.isConnected &&
      placement.priority <= state.mountPriority &&
      dom.root.parentElement
    ) {
      return;
    }

    mountInto(placement);
  }

  async function bootstrap() {
    try {
      const diag = await fetchJson(API.diag);
      if (diag.engine && diag.engine.name) {
        state.targetName = diag.engine.name;
      }
      if (diag.feature_flags && diag.feature_flags.enable_wake_header === false) {
        state.featureEnabled = false;
        log("feature_disabled", diag);
        return;
      }
      log("diagnostics_loaded", diag);
    } catch (error) {
      log("diagnostics_unavailable", { error: String(error) });
    }

    mountWhenReady();
    refreshStatus();
    window.addEventListener("resize", syncDom, { passive: true });
    window.addEventListener("focus", refreshStatus, { passive: true });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        refreshStatus();
      }
    });

    const observer = new MutationObserver(function () {
      if (mountScheduled) {
        return;
      }

      mountScheduled = true;
      window.requestAnimationFrame(function () {
        mountScheduled = false;
        mountWhenReady();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
