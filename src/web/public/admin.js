/* Admin portal. Session-gated; every mutation carries a CSRF token. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let csrf = null;
let es = null;
let retry = 1000;

const fmtSol = (n, d = 4) => (n == null ? "—" : Number(n).toFixed(d));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function msg(el, text, kind = "ok") {
  el.innerHTML = `<div class="${kind}">${esc(text)}</div>`;
  if (kind === "ok") setTimeout(() => { el.innerHTML = ""; }, 6000);
}

// -------------------------------------------------------------------- boot

async function boot() {
  const res = await fetch("/api/session").then((r) => r.json()).catch(() => null);

  if (!res) {
    document.body.innerHTML = `<div class="login-shell"><div class="login">
      <h2>Offline</h2><p class="sub">Could not reach the server.</p></div></div>`;
    return;
  }

  if (!res.configured) {
    // Default-deny: no password set means the portal is off, not open.
    document.body.innerHTML = `<div class="login-shell"><div class="login">
      <div class="mark">T</div>
      <h2>Admin disabled</h2>
      <p class="sub">No password is configured.</p>
      <div class="notice text-left">${esc(res.reason || "")}</div>
    </div></div>`;
    return;
  }

  if (res.authenticated) {
    csrf = res.csrf;
    showPanel();
  } else {
    $("login-shell").hidden = false;
  }
}

function showPanel() {
  $("login-shell").hidden = true;
  $("panel-shell").hidden = false;
  fetch("/api/admin/snapshot").then((r) => r.json()).then(render).catch(() => {});
  connect();
}

// ------------------------------------------------------------------- login

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
    });
    const body = await r.json();

    if (!r.ok) {
      msg($("login-msg"), body.error || "Sign-in failed", "err");
      $("password").value = "";
    } else {
      csrf = body.csrf;
      $("login-msg").innerHTML = "";
      showPanel();
    }
  } catch {
    msg($("login-msg"), "Network error", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("logout").addEventListener("click", async () => {
  await post("/api/logout", {});
  location.reload();
});

// ----------------------------------------------------------------- actions

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, csrf }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

async function action(fn) {
  try {
    const out = await fn();
    msg($("cmd-msg"), out.note || "Done.", "ok");
  } catch (e) {
    msg($("cmd-msg"), e.message, "err");
  }
}

$("btn-halt").addEventListener("click", () => {
  const reason = prompt("Reason for pausing (optional):", "manual pause");
  if (reason === null) return;
  action(async () => {
    await post("/api/admin/halt", { reason });
    return { note: "Paused. New launches stopped; open positions still exit." };
  });
});

$("btn-resume").addEventListener("click", () =>
  action(async () => {
    await post("/api/admin/resume", {});
    return { note: "Resumed." };
  }));

$("btn-sell-all").addEventListener("click", () => {
  if (!confirm("Queue a sell of EVERY open position?\n\nThis spends SOL and is not reversible.")) return;
  action(() => post("/api/admin/command", { kind: "sell_all_positions" }));
});

$("btn-claim").addEventListener("click", () =>
  action(() => post("/api/admin/command", { kind: "claim_fees" })));

$("btn-revoke").addEventListener("click", () => {
  if (!confirm("Sign out every admin session, including this one?")) return;
  post("/api/admin/revoke-sessions", {}).then(() => location.reload()).catch(() => {});
});

function sellOne(id, symbol) {
  if (!confirm(`Queue a sell of position #${id} (${symbol})?\n\nThis spends SOL and is not reversible.`)) return;
  action(() => post("/api/admin/command", { kind: "sell_position", payload: { positionId: id } }));
}

// tabs
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add("active");
  });
});

// ------------------------------------------------------------------ render

function meter(el, used, cap) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  el.style.width = `${pct}%`;
  el.className = pct >= 100 ? "over" : pct >= 75 ? "hot" : "";
}

function render(d) {
  const pill = $("a-pill");
  pill.className = `pill ${d.status.pill}`;
  $("a-status").textContent = d.status.label;
  $("a-mode").textContent = `${d.dryRun ? "DRY RUN" : "LIVE"} · ${d.network}`;

  $("a-notice").innerHTML = d.halted
    ? `<div class="notice"><strong>Paused.</strong> ${esc(d.haltReason || "")} — open positions still follow their exit rules.</div>`
    : (d.dryRun
      ? `<div class="notice">Practice mode: the pipeline runs but no transaction is ever signed.</div>`
      : "");

  $("btn-halt").hidden = d.halted;
  $("btn-resume").hidden = !d.halted;

  const b = d.budget;
  $("a-launches").textContent = b.launches;
  $("a-launches-cap").textContent = `cap ${b.maxLaunches} per rolling 24h`;
  meter($("a-launch-meter"), b.launches, b.maxLaunches);

  $("a-spent").textContent = fmtSol(b.solSpent);
  $("a-spent-cap").textContent = `cap ${b.maxSol} SOL`;
  meter($("a-spend-meter"), b.solSpent, b.maxSol);

  const pnl = d.stats.realisedPnlSol;
  const pnlEl = $("a-pnl");
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${fmtSol(pnl)}`;
  pnlEl.className = `value ${pnl >= 0 ? "pos" : "neg"}`;
  $("a-pnl-sub").textContent = `${d.stats.closedPositions} closed · loss breaker ${fmtSol(b.realizedLoss)}/${b.maxLoss}`;

  $("a-open").textContent = b.openPositions;
  $("a-open-cap").textContent = `cap ${b.maxPositions} concurrent`;

  // capacity
  const cap = d.capacity || {};
  $("a-capacity").textContent = cap.launchesPerDay ?? "—";
  $("a-capacity-why").textContent =
    `${cap.adaptive ? "adaptive" : "static"} · ${esc(cap.binding || "")}`.slice(0, 90);

  // outcomes
  const o = d.outcomes || {};
  const hr = $("a-hitrate");
  if (o.settled > 0 && o.hitRate != null) {
    hr.textContent = `${(o.hitRate * 100).toFixed(0)}%`;
    hr.className = `value ${o.hitRate >= 0.1 ? "pos" : o.hitRate > 0 ? "" : "neg"}`;
    $("a-hitrate-sub").textContent =
      `${o.hits} hit / ${o.modest} modest / ${o.duds} dud of ${o.settled} settled`;
  } else {
    hr.textContent = "—";
    hr.className = "value";
    $("a-hitrate-sub").textContent = `${o.pending ?? 0} still settling`;
  }

  // recent outcomes
  $("t-outcomes").innerHTML = (d.recentOutcomes || []).length
    ? d.recentOutcomes.map((r) => `<tr>
        <td>${verdictCell(r.verdict)}</td>
        <td>${esc(r.symbol || "")}</td>
        <td class="num dim">${Number(r.score).toFixed(1)}</td>
        <td class="num">$${Math.round(r.peakMcapUsd || 0).toLocaleString()}</td>
        <td class="num faint">${Number(r.estimatedFeeSol || 0).toFixed(5)}</td>
        <td class="num ${(r.realizedPnlSol ?? 0) >= 0 ? "pos" : "neg"}">${
          r.realizedPnlSol == null ? "—" : Number(r.realizedPnlSol).toFixed(4)}</td>
        <td class="faint tiny">${esc((r.feeds || []).join(", "))}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="empty">No settled launches yet.</td></tr>`;

  // learning state
  const L = d.learning || {};
  $("a-learn-state").innerHTML = !L.enabled
    ? `<div class="notice">Self-tuning is <strong>off</strong>. Enable <code>learning.enabled</code> once there are real outcomes to learn from — it needs ${L.minSampleSize ?? 20} settled launches before it will run at all.</div>`
    : (L.autoApply
      ? `<div class="ok">Self-tuning is on and <strong>applying</strong> changes automatically, within the guardrails.</div>`
      : `<div class="notice">Self-tuning is on in <strong>propose-only</strong> mode. Changes are logged but not applied.</div>`);

  const ov = L.overlay || { present: false, values: {} };
  $("a-overlay").innerHTML = ov.present
    ? `<p class="hint m0">Learned values currently in force (since ${
        new Date(ov.updatedAt || 0).toLocaleString()}):</p>
       <dl class="kv mt-sm">${Object.entries(ov.values)
         .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
    : `<p class="hint m0">No learned values in force; the config is exactly as authored.</p>`;

  $("t-tuning").innerHTML = (L.history || []).length
    ? L.history.map((h) => {
        const acc = Array.isArray(h.accepted) ? h.accepted : [];
        const rej = Array.isArray(h.rejected) ? h.rejected : [];
        return `<tr>
          <td class="faint">${esc(fmtTime(h.ts))}</td>
          <td class="num dim">${h.sampleSize}</td>
          <td class="tiny">${acc.length
            ? acc.map((a) => `${esc(a.path)}: ${a.from}→${a.to}`).join("<br>")
            : `<span class="faint">none</span>`}${
            rej.length ? `<br><span class="faint">${rej.length} rejected</span>` : ""}</td>
          <td class="faint small">${esc(String(h.rationale || "").slice(0, 140))}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="empty">No tuning runs yet.</td></tr>`;

  // positions
  $("t-positions").innerHTML = d.positions.length
    ? d.positions.map((p) => `<tr>
        <td class="mono">${p.id}</td>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.symbol || p.mint.slice(0, 8))}</a></td>
        <td class="num">${fmtSol(p.entrySol)}</td>
        <td class="num">${p.ageMinutes.toFixed(0)}m</td>
        <td>${p.status === "stuck"
          ? `<span class="neg">stuck (${p.sellAttempts} tries)</span>`
          : `<span class="dim">open</span>`}</td>
        <td><button class="sm danger" data-sell="${p.id}" data-sym="${esc(p.symbol || "")}">Sell</button></td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No open positions.</td></tr>`;

  $("t-positions").querySelectorAll("[data-sell]").forEach((btn) => {
    btn.addEventListener("click", () => sellOne(Number(btn.dataset.sell), btn.dataset.sym));
  });

  // candidate queue
  $("t-queue").innerHTML = d.candidates.length
    ? d.candidates.map((c) => `<tr>
        <td>${esc(c.term.slice(0, 46))}</td>
        <td class="num ${c.qualifies ? "pos" : ""}">${c.score.toFixed(1)}</td>
        <td class="num dim">${c.components.velocity.toFixed(2)}</td>
        <td class="num dim">${c.components.corroboration.toFixed(2)}</td>
        <td class="num dim">${c.components.cryptoAffinity.toFixed(2)}</td>
        <td class="num dim">${c.observations}</td>
        <td class="faint tiny">${esc(c.feeds.join(", "))}</td>
        <td>${c.sampleUrl ? `<a href="${esc(c.sampleUrl)}" target="_blank" rel="noopener noreferrer">src</a>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="8" class="empty">Nothing in the queue.</td></tr>`;

  // ledger
  $("t-ledger").innerHTML = d.ledger.length
    ? d.ledger.map((l) => `<tr>
        <td class="faint">${esc(fmtTime(l.ts))}</td>
        <td class="dim">${esc(l.kind)}</td>
        <td class="num ${l.solDelta >= 0 ? "pos" : "neg"}">${l.solDelta >= 0 ? "+" : ""}${fmtSol(l.solDelta, 5)}</td>
        <td class="faint small">${esc(l.note || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty">Nothing recorded.</td></tr>`;

  // feeds
  $("t-feeds").innerHTML = d.feeds.map((f) => `<tr>
      <td>${esc(f.id)}</td>
      <td>${f.enabled ? `<span class="pos">on</span>` : `<span class="faint">off</span>`}</td>
      <td class="num dim">${f.weight}</td>
      <td class="num ${f.enabled && f.signalsLastHour === 0 ? "neg" : ""}">${f.signalsLastHour}</td>
      <td class="faint">${esc(ago(f.lastSeen))}</td>
    </tr>`).join("");

  $("a-meter-x").innerHTML = d.xApiMeterUsd > 0
    ? `<p class="hint m0">X API spend this month: <strong>$${d.xApiMeterUsd.toFixed(2)}</strong></p>`
    : "";

  // commands
  $("t-commands").innerHTML = d.commands.length
    ? d.commands.map((c) => `<tr>
        <td class="faint">${esc(fmtTime(c.requested_at))}</td>
        <td class="dim">${esc(c.kind)}</td>
        <td>${statusCell(c.status)}</td>
        <td class="faint small">${esc(c.error || c.result || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty">No commands issued.</td></tr>`;

  // audit
  $("t-audit").innerHTML = d.audit.length
    ? d.audit.map((a) => `<tr>
        <td class="faint">${esc(fmtTime(a.ts))}</td>
        <td class="dim">${esc(a.action)}</td>
        <td class="faint small">${esc((a.detail || "").slice(0, 70))}</td>
        <td class="mono faint">${esc(a.ip || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty">Nothing logged.</td></tr>`;

  $("a-config").textContent = JSON.stringify(d.config, null, 2);
  $("a-foot").textContent =
    `Warmup ${d.warmup.spanMinutes.toFixed(0)}/${d.warmup.requiredMinutes}min · updated ${new Date(d.at).toLocaleTimeString()}`;

  document.body.classList.remove("stale");
}

function verdictCell(v) {
  if (v === "hit") return `<span class="pos">hit</span>`;
  if (v === "modest") return `<span class="dim">modest</span>`;
  if (v === "dud") return `<span class="neg">dud</span>`;
  return `<span class="faint">${esc(v)}</span>`;
}

function statusCell(s) {
  if (s === "done") return `<span class="pos">done</span>`;
  if (s === "failed") return `<span class="neg">failed</span>`;
  if (s === "running") return `<span class="dim">running</span>`;
  return `<span class="faint">pending</span>`;
}

// ------------------------------------------------------------------ stream

function connect() {
  es = new EventSource("/api/admin/stream");

  es.addEventListener("snapshot", (ev) => {
    retry = 1000;
    try { render(JSON.parse(ev.data)); } catch (e) { console.error(e); }
  });

  es.onerror = () => {
    document.body.classList.add("stale");
    es.close();
    // A dropped stream may just be an expired session; re-check before retrying.
    fetch("/api/session").then((r) => r.json()).then((s) => {
      if (!s.authenticated) location.reload();
      else setTimeout(connect, retry);
    }).catch(() => setTimeout(connect, retry));
    retry = Math.min(retry * 2, 30000);
  };
}

boot();
