function pageName() {
  const path = location.pathname;
  if (path === "/signin") return "signin";
  if (path === "/signup") return "signup";
  if (path === "/connect") return "connect";
  if (path === "/keys") return "keys";
  if (path === "/ask") return "ask";
  if (path === "/docs") return "docs";
  if (path === "/") return "home";
  return document.body.dataset.page || "home";
}

const page = pageName();

const errorEl = document.querySelector("#error");

const PLAN_LABEL = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
};

function getToastContainer() {
  let container = document.querySelector("#toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, type = "info", duration = 4000) {
  if (!message) return;
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const iconSvg = {
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
  }[type] || "";

  toast.innerHTML = `
    <div class="toast-icon">${iconSvg}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
    <button type="button" class="toast-close" aria-label="Close notification">&times;</button>
  `;

  const closeBtn = toast.querySelector(".toast-close");
  let timerId = null;

  const dismiss = () => {
    if (timerId) clearTimeout(timerId);
    toast.classList.add("toast-leaving");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  };

  closeBtn.addEventListener("click", dismiss);

  if (duration > 0) {
    timerId = setTimeout(dismiss, duration);
  }

  container.appendChild(toast);
}

function showError(message) {
  if (errorEl) {
    errorEl.textContent = message || "";
    errorEl.hidden = !message;
  }
  if (message) {
    showToast(message, "error");
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function field(id) {
  const el = document.querySelector(id);
  return el ? el.value.trim() : "";
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

const PAID_PLANS = new Set(["starter", "growth", "scale"]);

function planLabel(code) {
  return PLAN_LABEL[code] || code;
}

function renderFit(target, event, planCode) {
  target.hidden = false;
  target.replaceChildren();
  const rows = [
    ["Schema text", `${event.schemaTextChars} characters`],
    ["Path", event.path],
    [
      "Fits",
      `${planLabel(event.plan.code)}, $${event.plan.monthlyUsd}/month, ${event.plan.questionLimit} questions`,
    ],
  ];
  const list = document.createElement("dl");
  list.className = "fit-card";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "fit-metric";
    const term = document.createElement("dt");
    term.className = "fit-metric-label label";
    const detail = document.createElement("dd");
    detail.className = "fit-metric-val val";
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    list.append(row);
  }
  const note = document.createElement("p");
  note.className = "note";
  note.style.cssText = "font-size: 0.82rem; color: var(--text-muted); margin-top: 0.85rem;";
  note.textContent = PAID_PLANS.has(planCode)
    ? `This workspace is on the ${planLabel(planCode)} plan.`
    : "The workspace is on a 14-day trial with 30 questions.";
  target.append(list, note);
}

function showBilling(planCode, fitting) {
  const slot = document.querySelector("#billing");
  const button = document.querySelector("#billing-action");
  if (!button) return;
  if (slot) slot.hidden = false;
  if (PAID_PLANS.has(planCode)) {
    button.textContent = "Manage Subscription";
    button.dataset.action = "portal";
    return;
  }
  const label = fitting?.code ? planLabel(fitting.code) : "Starter";
  const usd = fitting?.monthlyUsd || 39;
  button.textContent = `Subscribe to ${label}, $${usd}/month`;
  button.dataset.action = "checkout";
}

async function startBilling(button) {
  showError("");
  button.disabled = true;
  try {
    const path = button.dataset.action === "portal" ? "/api/billing/portal" : "/api/billing/checkout";
    const data = await postJson(path, {});
    if (!data.url) throw new Error("Billing did not return a URL.");
    location.assign(data.url);
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
}

async function eachEvent(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = chunk.done ? "" : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line));
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = chunk.done ? "" : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

// Global Sign Out handler if present
const signOutBtn = document.querySelector("#sign-out");
if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    try {
      await postJson("/api/signout", {});
    } catch {}
    location.assign("/signin");
  });
}

// Global Billing Action handler if present
const billingBtn = document.querySelector("#billing-action");
if (billingBtn) {
  billingBtn.addEventListener("click", (event) => {
    startBilling(event.currentTarget);
  });
}

if (page === "signup") {
  const form = document.querySelector("#signup-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await postJson("/api/signup", {
          workspaceName: field("#workspace-name"),
          email: field("#email"),
          password: field("#password"),
        });
        location.assign("/connect");
      } catch (err) {
        showError(err.message);
        button.disabled = false;
      }
    });
  }
}

if (page === "signin") {
  const form = document.querySelector("#signin-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await postJson("/api/signin", {
          email: field("#email"),
          password: field("#password"),
        });
        location.assign("/connect");
      } catch (err) {
        showError(err.message);
        button.disabled = false;
      }
    });
  }
}

function pathLabel(path) {
  if (path === "small") return "Direct Full-Schema (Small)";
  if (path === "medium") return "Vector Retrieval (Medium)";
  if (path === "large") return "Multi-Module Index (Large)";
  return path || "Standard";
}

function pathBadgeLabel(path) {
  if (path === "small") return "Direct Full-Schema";
  if (path === "medium") return "Vector Retrieval";
  if (path === "large") return "Multi-Module Index";
  return path || "Active Index";
}

function planFitText(plan) {
  if (!plan?.code) return "Starter ($39/mo) or above";
  const label = planLabel(plan.code);
  const usd = plan.monthlyUsd || 39;
  return `${label} ($${usd}/mo) or above`;
}

function workspaceCoverageBadge(planCode) {
  if (PAID_PLANS.has(planCode)) {
    return `<span class="badge badge-emerald">Covered by ${escapeHtml(planLabel(planCode))} Plan</span>`;
  }
  return `<span class="badge badge-subtle">Free Trial</span>`;
}

if (page === "connect") {
  const form = document.querySelector("#connect-form");
  const current = document.querySelector("#current");
  let workspacePlan = "trial";

  function showSaved(connection) {
    if (!connection) {
      if (current) current.hidden = true;
      return;
    }
    const chars = Number(connection.schemaTextChars);
    const formattedChars = Number.isFinite(chars) ? chars.toLocaleString("en-US") + " characters" : "Pending indexing";
    const pathBadge = connection.path ? `<span class="badge badge-indigo">${escapeHtml(pathBadgeLabel(connection.path))}</span>` : "";
    const schemaGridHtml = connection.plan ? `
      <div class="conn-schema-grid">
        <div class="conn-metric">
          <span class="metric-label">Schema Volume</span>
          <span class="metric-val"><strong>${formattedChars}</strong></span>
        </div>
        <div class="conn-metric">
          <span class="metric-label">AI Engine Routing</span>
          <span class="metric-val">${escapeHtml(pathLabel(connection.path))}</span>
        </div>
        <div class="conn-metric">
          <span class="metric-label">Required Tier</span>
          <span class="metric-val">${escapeHtml(planFitText(connection.plan))}</span>
        </div>
        <div class="conn-metric">
          <span class="metric-label">Workspace Coverage</span>
          <span class="metric-val">${workspaceCoverageBadge(workspacePlan)}</span>
        </div>
      </div>
    ` : "";

    if (current) {
      current.hidden = false;
      current.classList.remove("hidden");
      current.innerHTML = `
        <div class="conn-status-header">
          <div class="conn-status-title">
            <span class="status-indicator-dot online"></span>
            <span>Active database</span>
          </div>
          <div class="conn-header-badges">
            <span class="badge badge-emerald">Read-Only Verified</span>
            ${pathBadge}
          </div>
        </div>
        <div class="conn-details-grid">
          <div class="conn-metric">
            <span class="metric-label">Database</span>
            <span class="metric-val"><code>${escapeHtml(connection.database || connection.databaseName || "")}</code></span>
          </div>
          <div class="conn-metric">
            <span class="metric-label">Host &amp; Port</span>
            <span class="metric-val"><code>${escapeHtml(connection.host)}:${escapeHtml(connection.port || "3306")}</code></span>
          </div>
          <div class="conn-metric">
            <span class="metric-label">Username</span>
            <span class="metric-val"><code>${escapeHtml(connection.username)}</code></span>
          </div>
          <div class="conn-metric">
            <span class="metric-label">Security</span>
            <span class="metric-val">AES-256-GCM Vault</span>
          </div>
        </div>
        ${schemaGridHtml}
        <div class="conn-switch-note">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span><strong>Changing databases:</strong> You can update credentials below anytime to connect a new database. Re-indexing updates the schema catalog without affecting your plan or monthly query credits.</span>
        </div>
      `;
    }

    const submitBtn = document.querySelector("#connect-form button[type='submit']");
    const submitBtnText = document.querySelector("#submit-btn-text") || submitBtn?.querySelector("span:not(.submit-note)");
    if (submitBtnText) submitBtnText.textContent = "Update & Re-Index Schema";
    const panelTitle = document.querySelector(".form-panel .panel-title");
    if (panelTitle) panelTitle.textContent = "Change / Update Connection";
    const panelBadge = document.querySelector(".form-panel .panel-header .badge");
    if (panelBadge) panelBadge.textContent = "Active Source Configured";

    const askLink = document.querySelector("#ask-link");
    if (askLink) {
      askLink.hidden = false;
      askLink.classList.remove("hidden");
    }
    if (connection.plan) {
      showBilling(workspacePlan, connection.plan);
    }
  }

  fetch("/api/me")
    .then(async (response) => {
      if (response.status === 401) {
        location.assign("/signin");
        return null;
      }
      return response.json();
    })
    .then(async (me) => {
      if (!me) return;
      const who = document.querySelector("#who");
      if (who) who.textContent = `${me.email} · ${me.workspaceName}`;
      workspacePlan = me.planCode || "trial";
      const response = await fetch("/api/connection");
      if (!response.ok) return;
      const body = await response.json();
      showSaved(body.connection);
    })
    .catch((err) => showError(err.message));

  const indexModal = document.querySelector("#index-modal");
  const modalTargetDb = document.querySelector("#modal-target-db");
  const modalErrorContainer = document.querySelector("#modal-error-container");
  const modalErrorBox = document.querySelector("#modal-error-box");
  const modalSuccessContainer = document.querySelector("#modal-success-container");
  const modalFooterNote = document.querySelector("#modal-footer-note");
  const modalDismissBtn = document.querySelector("#modal-dismiss-btn");
  const modalStudioBtn = document.querySelector("#modal-studio-btn");
  const progressFill = document.querySelector("#progress-fill");
  const progressPhase = document.querySelector("#progress-phase");
  const progressPercent = document.querySelector("#progress-percent");
  const processState = document.querySelector("#process-state");
  let connectAbort = null;
  let indexFailed = false;

  const copySyntaxBtn = document.querySelector("#copy-syntax-btn");
  if (copySyntaxBtn) {
    copySyntaxBtn.addEventListener("click", async () => {
      const syntaxCode = document.querySelector("#syntax-code")?.textContent || "";
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(syntaxCode);
        } else {
          throw new Error("Clipboard unavailable");
        }
      } catch {
        const ta = document.createElement("textarea");
        ta.value = syntaxCode;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      copySyntaxBtn.textContent = "Copied!";
      showToast("Database setup syntax copied to clipboard.", "success");
      setTimeout(() => { copySyntaxBtn.textContent = "Copy Syntax"; }, 2000);
    });
  }

  function leaveIndexModal() {
    connectAbort?.abort();
    if (indexModal) indexModal.hidden = true;
    const button = form?.querySelector("button");
    if (button) button.disabled = false;
    form?.removeAttribute("aria-busy");
    document.querySelector("#db-password")?.focus();
  }

  if (modalDismissBtn) {
    modalDismissBtn.addEventListener("click", leaveIndexModal);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !indexModal || indexModal.hidden) return;
    leaveIndexModal();
  });

  const processDefaults = new Map();
  document.querySelectorAll(".process-step").forEach((step) => {
    processDefaults.set(step.dataset.step, step.querySelector(".process-detail")?.textContent || "");
  });

  function setProcessState(label, stateType = "indigo") {
    if (!processState) return;
    processState.textContent = label;
    processState.className = stateType === "emerald" ? "badge badge-emerald" : stateType === "error" ? "badge badge-subtle" : "badge badge-indigo";
    if (stateType === "error") {
      processState.style.color = "#dc2626";
      processState.style.borderColor = "#fecaca";
    } else {
      processState.style.color = "";
      processState.style.borderColor = "";
    }
  }

  function setProgress(percent, phase) {
    if (progressFill) progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (progressPercent) progressPercent.textContent = `${Math.round(percent)}%`;
    if (progressPhase && phase) progressPhase.textContent = phase;
  }

  function setProcessStep(step, state, detail) {
    const item = document.querySelector(`.process-step[data-step="${step}"]`);
    if (!item) return;
    const steps = [...document.querySelectorAll(".process-step")];
    const index = steps.indexOf(item);
    if (state === "active" || state === "done" || state === "error") {
      steps.slice(0, index).forEach((earlier) => {
        if (earlier.dataset.state !== "done" && earlier.dataset.state !== "error") {
          earlier.dataset.state = "done";
          const status = earlier.querySelector(".process-status");
          if (status) status.textContent = "Done";
          const mark = earlier.querySelector(".process-mark");
          if (mark) mark.textContent = "✓";
        }
      });
    }
    item.dataset.state = state;
    const detailNode = item.querySelector(".process-detail");
    if (detailNode && detail) detailNode.textContent = detail;
    const status = item.querySelector(".process-status");
    if (status) {
      status.textContent = state === "active" ? "Running" : state === "done" ? "Done" : state === "error" ? "Failed" : "Waiting";
    }
    const mark = item.querySelector(".process-mark");
    if (mark) {
      mark.textContent = state === "done" ? "✓" : state === "error" ? "!" : String(index + 1);
    }
  }

  function resetProcess() {
    if (indexModal) {
      indexModal.hidden = false;
      indexModal.classList.remove("hidden");
    }
    if (modalTargetDb) {
      modalTargetDb.textContent = `${field("#username")}@${field("#host")}:${field("#port") || 3306}/${field("#database")}`;
    }
    if (modalErrorContainer) modalErrorContainer.hidden = true;
    if (modalSuccessContainer) modalSuccessContainer.hidden = true;
    if (modalFooterNote) modalFooterNote.hidden = false;
    if (modalDismissBtn) {
      modalDismissBtn.hidden = false;
      modalDismissBtn.textContent = "Cancel";
    }
    if (modalStudioBtn) modalStudioBtn.hidden = true;
    indexFailed = false;

    setProcessState("Running", "indigo");
    setProgress(5, "Verifying credentials and read-only grants...");

    document.querySelectorAll(".process-step").forEach((step, index) => {
      step.dataset.state = "waiting";
      const detail = step.querySelector(".process-detail");
      if (detail) detail.textContent = processDefaults.get(step.dataset.step) || "";
      const status = step.querySelector(".process-status");
      if (status) status.textContent = "Waiting";
      const mark = step.querySelector(".process-mark");
      if (mark) mark.textContent = String(index + 1);
    });
  }

  function failIndex(message) {
    if (indexFailed) return;
    indexFailed = true;
    const text = message || "Could not connect.";
    const active = document.querySelector('.process-step[data-state="active"]');
    setProcessStep(active?.dataset.step || "access", "error", text);
    setProcessState("Failed", "error");
    if (modalFooterNote) modalFooterNote.hidden = true;
    if (modalErrorBox) modalErrorBox.textContent = text;
    if (modalErrorContainer) modalErrorContainer.hidden = false;
    if (modalDismissBtn) {
      modalDismissBtn.hidden = false;
      modalDismissBtn.textContent = "Back";
    }
    showError(text);
  }

  function showProcessEvent(item) {
    if (item.step === "error") {
      failIndex(item.message || "Could not index that database.");
      return;
    }

    if (item.step === "done") {
      const chars = Number(item.schemaTextChars);
      const detail = Number.isFinite(chars) ? `${chars.toLocaleString("en-US")} characters` : item.detail;
      setProcessStep("measure", "done", detail);
      setProgress(100, "All 7 stages complete! Schema verified.");
      setProcessState("Complete", "emerald");
      if (modalFooterNote) modalFooterNote.hidden = true;
      if (modalSuccessContainer) modalSuccessContainer.hidden = false;
      const successNote = document.querySelector("#modal-success-note")
        || modalSuccessContainer?.querySelector("div div");
      if (successNote) successNote.textContent = "Stay on this page, or open SQL Studio when you are ready.";
      if (modalDismissBtn) {
        modalDismissBtn.hidden = false;
        modalDismissBtn.textContent = "Close";
      }
      if (modalStudioBtn) modalStudioBtn.hidden = false;
      showToast("Database connected and schema indexed successfully!", "success");
      return;
    }

    if (!item.step) return;
    setProcessStep(item.step, item.state || "active", item.detail || item.message || "");

    const STEP_PROGRESS = {
      access: { active: 10, done: 18, label: "Checking read-only access" },
      schema: { active: 25, done: 35, label: "Reading tables & columns" },
      catalog: { active: 45, done: 52, label: "Storing workspace catalog" },
      embed: { active: 60, done: 72, label: "Embedding table vectors" },
      vectors: { active: 78, done: 85, label: "Indexing vectors into Qdrant" },
      lookups: { active: 88, done: 93, label: "Indexing lookup values" },
      measure: { active: 96, done: 99, label: "Measuring schema characters & route" }
    };

    const config = STEP_PROGRESS[item.step];
    if (config) {
      let pct = item.state === "done" ? config.done : config.active;
      let phase = config.label;
      if (item.step === "embed" && item.detail) {
        const match = String(item.detail).match(/(\d+)\s+of\s+(\d+)/);
        if (match) {
          const ratio = Number(match[1]) / (Number(match[2]) || 1);
          pct = Math.round(55 + (16 * ratio));
          phase = `Embedding tables (${match[1]} of ${match[2]})`;
        }
      }
      setProgress(pct, phase);
    }
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      resetProcess();
      const button = form.querySelector("button");
      button.disabled = true;
      form.setAttribute("aria-busy", "true");
      connectAbort = new AbortController();
      try {
        const response = await fetch("/api/connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: connectAbort.signal,
          body: JSON.stringify({
            host: field("#host"),
            port: Number(field("#port")),
            database: field("#database"),
            username: field("#username"),
            password: field("#db-password"),
          }),
        });
        const type = response.headers.get("content-type") || "";
        if (!response.ok || !type.includes("ndjson")) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Could not connect.");
        }
        let finished = false;
        let failure = null;
        await eachEvent(response, (item) => {
          showProcessEvent(item);
          if (item.step === "error") failure = new Error(item.message || "Could not index that database.");
          if (item.step === "done" && item.plan) {
            finished = true;
            showSaved({
              host: field("#host"),
              database: field("#database"),
              username: field("#username"),
              schemaTextChars: item.schemaTextChars,
              path: item.path,
              plan: item.plan,
            });
          }
        });
        if (!failure && !finished) failIndex("Indexing stopped before it finished.");
      } catch (err) {
        if (err?.name === "AbortError") return;
        failIndex(err.message);
      } finally {
        button.disabled = false;
        form.removeAttribute("aria-busy");
      }
    });
  }
}

function renderResultTable(rows) {
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  if (!rows || !rows.length) {
    const empty = document.createElement("p");
    empty.style.padding = "1rem";
    empty.style.color = "var(--text-muted)";
    empty.textContent = "The query returned 0 rows.";
    scroll.append(empty);
    return scroll;
  }
  const table = document.createElement("table");
  table.className = "data-table";
  const keys = Object.keys(rows[0]);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const key of keys) {
    const th = document.createElement("th");
    th.textContent = key;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const key of keys) {
      const td = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell";
      button.textContent = row[key] == null ? "NULL" : String(row[key]);
      button.setAttribute("aria-expanded", "false");
      button.title = "Click to expand/collapse cell";
      button.addEventListener("click", () => {
        const open = button.classList.toggle("expanded");
        button.setAttribute("aria-expanded", open ? "true" : "false");
      });
      td.append(button);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  return scroll;
}

function downloadCsv(rows, filename = "querywell-results.csv") {
  if (!rows || !rows.length) return;
  const headers = Object.keys(rows[0]);
  const escapeCsv = (val) => {
    if (val == null) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent = [
    headers.map(escapeCsv).join(","),
    ...rows.map(row => headers.map(h => escapeCsv(row[h])).join(","))
  ].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function renderAnswer(target, event, asked) {
  target.hidden = false;
  target.replaceChildren();

  const rows = Array.isArray(event.rows) ? event.rows : [];
  const wrap = document.createElement("div");
  wrap.className = "result-card";

  if (asked) {
    const q = document.createElement("div");
    q.className = "result-question-block";
    const qLabel = document.createElement("p");
    qLabel.className = "result-kicker";
    qLabel.textContent = "Question";
    const qText = document.createElement("p");
    qText.className = "result-question";
    qText.textContent = asked;
    q.append(qLabel, qText);
    wrap.append(q);
  }

  const head = document.createElement("div");
  head.className = "result-head";
  const titles = document.createElement("div");
  const aLabel = document.createElement("p");
  aLabel.className = "result-kicker";
  aLabel.textContent = "Answer";
  const count = document.createElement("p");
  count.className = "result-count";
  count.textContent = rows.length === 1 ? "1 row" : `${rows.length} rows`;
  titles.append(aLabel, count);

  const actions = document.createElement("div");
  actions.className = "result-actions";

  let sqlPanel = null;
  if (event.sql || event.explanation) {
    const sqlBtn = document.createElement("button");
    sqlBtn.type = "button";
    sqlBtn.className = "button button-sm ghost";
    sqlBtn.textContent = "SQL";
    sqlBtn.addEventListener("click", () => {
      if (!sqlPanel) return;
      const open = sqlPanel.hidden;
      sqlPanel.hidden = !open;
      sqlBtn.textContent = open ? "Hide SQL" : "SQL";
    });
    actions.append(sqlBtn);
  }

  if (rows.length > 0) {
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "button button-sm ghost export-csv-btn";
    exportBtn.textContent = "CSV";
    exportBtn.addEventListener("click", () => {
      downloadCsv(rows, `querywell-results-${Date.now()}.csv`);
    });
    actions.append(exportBtn);
  }

  head.append(titles, actions);
  wrap.append(head);

  if (event.executeError) {
    const failed = document.createElement("p");
    failed.className = "result-error";
    failed.textContent = event.executeError;
    wrap.append(failed);
  }

  if (event.sql || event.explanation) {
    sqlPanel = document.createElement("div");
    sqlPanel.className = "result-sql-panel";
    sqlPanel.hidden = true;
    if (event.sql) {
      const code = document.createElement("pre");
      code.className = "sql-code sql";
      code.textContent = event.sql;
      sqlPanel.append(code);
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-sql-btn";
      copyBtn.style.margin = "0.75rem 0 0";
      copyBtn.textContent = "Copy SQL";
      copyBtn.addEventListener("click", async () => {
        await copyText(event.sql);
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy SQL"; }, 1600);
      });
      sqlPanel.append(copyBtn);
    }
    if (event.explanation) {
      const note = document.createElement("p");
      note.className = "result-note explanation";
      note.textContent = event.explanation;
      sqlPanel.append(note);
    }
    wrap.append(sqlPanel);
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "result-table-wrap";
  tableWrap.append(renderResultTable(rows));
  wrap.append(tableWrap);

  target.append(wrap);
}

function showUsage(usage) {
  const line = document.querySelector("#usage");
  if (!line) return;
  if (!usage || usage.limit == null) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  line.textContent = usage.expired
    ? "Trial ended"
    : `${usage.used} of ${usage.limit}`;
  line.title = usage.expired
    ? "The 14-day trial has ended"
    : `${usage.used} of ${usage.limit} queries used this month`;

  const fill = document.querySelector(".usage-bar-fill");
  if (fill && usage.limit > 0) {
    const pct = Math.min(100, Math.round((usage.used / usage.limit) * 100));
    fill.style.width = `${pct}%`;
  }
}

if (page === "ask") {
  const form = document.querySelector("#ask-form");
  const answer = document.querySelector("#answer");
  const needConnect = document.querySelector("#need-connect");
  const workspace = document.querySelector("#studio-workspace");
  const empty = document.querySelector("#studio-empty");
  const status = document.querySelector("#ask-status");
  const questionEl = document.querySelector("#question");
  const submitBtn = document.querySelector("#ask-submit");

  function resizeQuestion() {
    if (!questionEl) return;
    questionEl.style.height = "auto";
    questionEl.style.height = `${Math.min(questionEl.scrollHeight, 140)}px`;
  }

  function showWorkspace(indexed) {
    if (needConnect) needConnect.hidden = indexed;
    if (workspace) workspace.hidden = !indexed;
    if (indexed) questionEl?.focus();
  }

  document.querySelectorAll(".studio-suggestion").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!questionEl || !form) return;
      questionEl.value = chip.dataset.prompt || chip.textContent.trim();
      resizeQuestion();
      form.requestSubmit();
    });
  });

  if (questionEl && form) {
    questionEl.addEventListener("input", resizeQuestion);
    questionEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  fetch("/api/me")
    .then(async (response) => {
      if (response.status === 401) {
        location.assign("/signin");
        return null;
      }
      return response.json();
    })
    .then(async (me) => {
      if (!me) return;
      const who = document.querySelector("#who");
      if (who) who.textContent = `${me.email} · ${me.workspaceName}`;
      const response = await fetch("/api/connection");
      const body = response.ok ? await response.json() : { connection: null };
      const indexed = Boolean(body.connection?.plan);
      showWorkspace(indexed);
      const usageResponse = await fetch("/api/usage");
      const usage = usageResponse.ok ? await usageResponse.json() : null;
      if (usage) showUsage(usage);
      if (indexed) showBilling(usage?.planCode || me.planCode, body.connection.plan);
    })
    .catch((err) => showError(err.message));

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      if (empty) empty.hidden = true;
      if (answer) {
        answer.hidden = true;
        answer.replaceChildren();
      }
      if (status) status.hidden = false;
      if (submitBtn) submitBtn.disabled = true;
      form.setAttribute("aria-busy", "true");
      try {
        const asked = field("#question");
        const payload = { question: asked };
        const providerField = document.querySelector("#sql-provider");
        if (providerField?.value) payload.provider = providerField.value;
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const type = response.headers.get("content-type") || "";
        if (!response.ok || !type.includes("ndjson")) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Could not answer that question.");
        }
        const events = await readEvents(response);
        let finished = false;
        for (const item of events) {
          if (item.step === "error") throw new Error(item.message || "Could not answer that question.");
          if (item.step === "done") {
            finished = true;
            if (questionEl) {
              questionEl.value = "";
              questionEl.style.height = "";
            }
            if (answer) renderAnswer(answer, item, asked);
            showUsage(item);
          }
        }
        if (!finished) throw new Error("The question stopped before it finished.");
      } catch (err) {
        showError(err.message);
        if (empty && answer && !answer.children.length) empty.hidden = false;
        const usageResponse = await fetch("/api/usage").catch(() => null);
        if (usageResponse?.ok) showUsage(await usageResponse.json());
      } finally {
        if (status) status.hidden = true;
        if (submitBtn) submitBtn.disabled = false;
        form.removeAttribute("aria-busy");
        questionEl?.focus();
      }
    });
  }
}

if (page === "keys") {
  const rows = document.querySelector("#key-rows");
  const empty = document.querySelector("#key-empty");
  const secretPanel = document.querySelector("#key-secret");
  const secretValue = document.querySelector("#key-secret-value");
  const curl = document.querySelector("#snippet-curl");
  const python = document.querySelector("#snippet-python");
  let secret = "YOUR_API_KEY";

  function snippetText() {
    const origin = location.origin;
    const curlText = [
      `curl -sS ${origin}/api/ask \\`,
      `  -H "Authorization: Bearer ${secret}" \\`,
      `  -H "Accept: application/json" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d "{\\"question\\":\\"Count orders grouped by status\\"}"`,
    ].join("\n");
    const pythonText = [
      "import requests",
      "",
      "response = requests.post(",
      `    "${origin}/api/ask",`,
      "    headers={",
      `        "Authorization": "Bearer ${secret}",`,
      `        "Accept": "application/json",`,
      "    },",
      `    json={"question": "Count orders grouped by status"},`,
      ")",
      "print(response.json())",
    ].join("\n");
    if (curl) curl.textContent = curlText;
    if (python) python.textContent = pythonText;
  }

  async function copyText(text, button, label = "Snippet") {
    if (!text || !button) return;
    const previous = button.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard is unavailable.");
      }
      button.textContent = "Copied";
      showToast(`${label} copied to clipboard!`, "success");
      setTimeout(() => {
        button.textContent = previous;
      }, 1200);
    } catch {
      showError("Could not copy. Select the snippet and copy it manually.");
    }
  }

  function addKeyRow(key) {
    if (!rows) return;
    const row = document.createElement("tr");
    row.dataset.keyId = String(key.id);
    const name = document.createElement("td");
    name.textContent = key.name;
    const prefix = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = key.prefix;
    prefix.append(code);
    const created = document.createElement("td");
    created.textContent = key.createdAt || "";
    const used = document.createElement("td");
    used.textContent = key.lastUsedAt || "Never";
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-sm ghost revoke-key";
    button.dataset.id = String(key.id);
    button.textContent = "Revoke";
    action.append(button);
    row.append(name, prefix, created, used, action);
    rows.prepend(row);
    if (empty) empty.hidden = true;
  }

  snippetText();

  document.querySelector("#copy-curl")?.addEventListener("click", (event) => {
    copyText(curl?.textContent || "", event.currentTarget, "cURL command");
  });
  document.querySelector("#copy-python")?.addEventListener("click", (event) => {
    copyText(python?.textContent || "", event.currentTarget, "Python snippet");
  });
  document.querySelector("#copy-secret")?.addEventListener("click", (event) => {
    copyText(secretValue?.textContent || "", event.currentTarget, "API key secret");
  });

  document.querySelector("#key-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showError("");
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const data = await postJson("/api/keys", { name: field("#key-name") });
      secret = data.key.secret;
      if (secretValue) secretValue.textContent = secret;
      if (secretPanel) secretPanel.hidden = false;
      snippetText();
      addKeyRow(data.key);
      form.reset();
      showToast("API key created successfully!", "success");
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });

  rows?.addEventListener("click", async (event) => {
    const button = event.target.closest(".revoke-key");
    if (!button) return;
    showError("");
    button.disabled = true;
    try {
      await postJson(`/api/keys/${button.dataset.id}/revoke`, {});
      button.closest("tr")?.remove();
      if (empty && !rows.children.length) empty.hidden = false;
      showToast("API key revoked.", "info");
    } catch (err) {
      showError(err.message);
      button.disabled = false;
    }
  });
}

if (page === "docs") {
  const origin = location.origin;
  document.querySelectorAll("pre code").forEach((code) => {
    if (code.textContent.includes("__ORIGIN__")) {
      code.textContent = code.textContent.replaceAll("__ORIGIN__", origin);
    }
  });

  document.querySelectorAll(".docs-copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.querySelector(button.dataset.copy || "");
      const text = target?.textContent || "";
      const previous = button.textContent;
      if (!text) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        showToast("Snippet copied to clipboard!", "success");
        setTimeout(() => {
          button.textContent = previous;
        }, 1200);
      } catch {
        showError("Could not copy. Select the snippet and copy it manually.");
      }
    });
  });
}

// Landing page scenario switcher
if (page === "home") {
  const scenarioData = {
    revenue: {
      prompt: '"Which 5 customers generated the highest total revenue this quarter, and what is their current plan status?"',
      meta: "Generated in 1.4s",
      telemetry: `
        <span class="telemetry-pill"><strong>Path:</strong> Small Schema Full Context (4.8k chars)</span>
        <span class="telemetry-pill"><strong>Model:</strong> Claude 3.5 Sonnet</span>
        <span class="telemetry-pill"><strong>Query Latency:</strong> 11ms</span>
        <span class="telemetry-pill"><strong>Rows:</strong> 5</span>
      `,
      sql: `<span class="kw">SELECT</span>
  u.id <span class="kw">AS</span> customer_id,
  u.company_name,
  s.plan_code <span class="kw">AS</span> current_plan,
  <span class="fn">COUNT</span>(o.id) <span class="kw">AS</span> orders_count,
  <span class="fn">SUM</span>(o.amount_usd) <span class="kw">AS</span> total_revenue_usd
<span class="kw">FROM</span> users u
<span class="kw">JOIN</span> subscriptions s <span class="kw">ON</span> s.user_id = u.id
<span class="kw">JOIN</span> orders o <span class="kw">ON</span> o.user_id = u.id
<span class="kw">WHERE</span> o.status = <span class="str">'paid'</span>
  <span class="kw">AND</span> o.created_at &gt;= <span class="str">'2026-07-01'</span>
<span class="kw">GROUP BY</span> u.id, u.company_name, s.plan_code
<span class="kw">ORDER BY</span> total_revenue_usd <span class="kw">DESC</span>
<span class="kw">LIMIT</span> <span class="num">5</span>;`,
      tableTitle: "Execution Output",
      tableCount: "5 rows returned",
      headers: ["customer_id", "company_name", "current_plan", "orders_count", "total_revenue_usd"],
      rows: [
        ["<code>usr_9824</code>", "Acme Logistics Global", '<span class="status-badge enterprise">scale</span>', "142", "$42,850.00"],
        ["<code>usr_7719</code>", "CloudScale Networks", '<span class="status-badge enterprise">scale</span>', "98", "$31,200.00"],
        ["<code>usr_4102</code>", "Apex Retail Systems", '<span class="status-badge growth">growth</span>', "64", "$18,440.00"],
        ["<code>usr_5591</code>", "Beacon Health Analytics", '<span class="status-badge growth">growth</span>', "41", "$12,980.00"],
        ["<code>usr_1028</code>", "Nordic FinTech AS", '<span class="status-badge starter">starter</span>', "27", "$8,650.00"]
      ]
    },
    orders: {
      prompt: '"Show recent unfulfilled orders over $500 along with the customer company name and contact email"',
      meta: "Generated in 0.9s",
      telemetry: `
        <span class="telemetry-pill"><strong>Path:</strong> Small Schema Full Context (4.8k chars)</span>
        <span class="telemetry-pill"><strong>Model:</strong> Claude 3.5 Sonnet</span>
        <span class="telemetry-pill"><strong>Query Latency:</strong> 8ms</span>
        <span class="telemetry-pill"><strong>Rows:</strong> 4</span>
      `,
      sql: `<span class="kw">SELECT</span>
  o.id <span class="kw">AS</span> order_id,
  u.company_name,
  u.email <span class="kw">AS</span> contact_email,
  o.amount_usd,
  o.status <span class="kw">AS</span> order_status,
  o.created_at
<span class="kw">FROM</span> orders o
<span class="kw">JOIN</span> users u <span class="kw">ON</span> u.id = o.user_id
<span class="kw">WHERE</span> o.status = <span class="str">'pending_fulfillment'</span>
  <span class="kw">AND</span> o.amount_usd &gt;= <span class="num">500.00</span>
<span class="kw">ORDER BY</span> o.created_at <span class="kw">DESC</span>
<span class="kw">LIMIT</span> <span class="num">10</span>;`,
      tableTitle: "Execution Output",
      tableCount: "4 rows returned",
      headers: ["order_id", "company_name", "contact_email", "amount_usd", "order_status", "created_at"],
      rows: [
        ["<code>ord_8912</code>", "Vanguard Logistics", "ops@vanguardlog.com", "$1,450.00", '<span class="status-badge growth">pending_fulfillment</span>', "2026-10-12 14:22"],
        ["<code>ord_8840</code>", "Cascade Digital", "billing@cascadedigital.io", "$890.00", '<span class="status-badge growth">pending_fulfillment</span>', "2026-10-11 09:15"],
        ["<code>ord_8795</code>", "Solaris Health", "purchasing@solarishealth.org", "$2,100.00", '<span class="status-badge growth">pending_fulfillment</span>', "2026-10-10 18:40"],
        ["<code>ord_8721</code>", "Nexus Robotics", "admin@nexusrobotics.ai", "$620.00", '<span class="status-badge growth">pending_fulfillment</span>', "2026-10-09 11:05"]
      ]
    },
    churn: {
      prompt: '"How many active vs canceled subscriptions do we have by plan tier, with total monthly recurring revenue?"',
      meta: "Generated in 1.1s",
      telemetry: `
        <span class="telemetry-pill"><strong>Path:</strong> Small Schema Full Context (4.8k chars)</span>
        <span class="telemetry-pill"><strong>Model:</strong> Claude 3.5 Sonnet</span>
        <span class="telemetry-pill"><strong>Query Latency:</strong> 14ms</span>
        <span class="telemetry-pill"><strong>Rows:</strong> 6</span>
      `,
      sql: `<span class="kw">SELECT</span>
  s.plan_code,
  s.status <span class="kw">AS</span> subscription_status,
  <span class="fn">COUNT</span>(s.id) <span class="kw">AS</span> total_subscriptions,
  <span class="fn">SUM</span>(s.monthly_price_usd) <span class="kw">AS</span> total_mrr_usd
<span class="kw">FROM</span> subscriptions s
<span class="kw">GROUP BY</span> s.plan_code, s.status
<span class="kw">ORDER BY</span> s.plan_code <span class="kw">ASC</span>, total_mrr_usd <span class="kw">DESC</span>;`,
      tableTitle: "Execution Output",
      tableCount: "6 rows returned",
      headers: ["plan_code", "subscription_status", "total_subscriptions", "total_mrr_usd"],
      rows: [
        ['<span class="status-badge starter">starter</span>', '<span class="status-badge enterprise">active</span>', "420", "$16,380.00"],
        ['<span class="status-badge starter">starter</span>', '<span class="status-badge" style="background:#fee2e2;color:#991b1b;">canceled</span>', "38", "$1,482.00"],
        ['<span class="status-badge growth">growth</span>', '<span class="status-badge enterprise">active</span>', "184", "$23,736.00"],
        ['<span class="status-badge growth">growth</span>', '<span class="status-badge" style="background:#fee2e2;color:#991b1b;">canceled</span>', "12", "$1,548.00"],
        ['<span class="status-badge enterprise">scale</span>', '<span class="status-badge enterprise">active</span>', "48", "$16,752.00"],
        ['<span class="status-badge enterprise">scale</span>', '<span class="status-badge" style="background:#fee2e2;color:#991b1b;">canceled</span>', "2", "$698.00"]
      ]
    }
  };

  const scenarioButtons = document.querySelectorAll(".scenario-btn");
  scenarioButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const scenarioKey = btn.dataset.scenario;
      const data = scenarioData[scenarioKey];
      if (!data) return;

      scenarioButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const promptText = document.querySelector("#demo-prompt-text");
      const promptMeta = document.querySelector("#demo-prompt-meta");
      const telemetry = document.querySelector("#demo-telemetry");
      const sqlCode = document.querySelector("#demo-sql-code");
      const tableTitle = document.querySelector("#demo-table-title");
      const tableCount = document.querySelector("#demo-table-count");
      const dataTable = document.querySelector("#demo-data-table");

      if (promptText) promptText.textContent = data.prompt;
      if (promptMeta) promptMeta.textContent = data.meta;
      if (telemetry) telemetry.innerHTML = data.telemetry;
      if (sqlCode) sqlCode.innerHTML = data.sql;
      if (tableTitle) tableTitle.textContent = data.tableTitle;
      if (tableCount) tableCount.textContent = data.tableCount;

      if (dataTable) {
        const thead = dataTable.querySelector("thead");
        const tbody = dataTable.querySelector("tbody");
        if (thead) {
          thead.innerHTML = `<tr>${data.headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
        }
        if (tbody) {
          tbody.innerHTML = data.rows
            .map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
            .join("");
        }
      }
    });
  });
}

