/* cashcow.exe — barn controls. Session-gated; every mutation carries a CSRF token. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let csrf = null;
let es = null;
let retry = 1000;
let tab = "now";
let countdownFrom = 0, countdownAt = Date.now();

const sol = (n, d = 4) => (n == null ? "—" : Number(n).toFixed(d));
const money = (u) => (u >= 1000 ? `$${Math.round(u / 1000)}k` : `$${Math.round(u || 0)}`);
const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function msg(el, text, kind = "ok") {
  el.innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
  if (kind === "ok") setTimeout(() => { el.innerHTML = ""; }, 6000);
}

// -------------------------------------------------------------------- boot

async function boot() {
  const res = await fetch("/api/session").then((r) => r.json()).catch(() => null);

  if (!res) {
    document.body.innerHTML = `<div class="login-shell"><div class="login">
      <div class="name">cashcow.exe</div><p class="sub">The barn is not answering.</p></div></div>`;
    return;
  }

  if (!res.configured) {
    // Default-deny: no password means the portal is OFF, not open.
    document.body.innerHTML = `<div class="login-shell"><div class="login">
      <div class="name">cashcow.exe</div>
      <p class="sub">Barn locked</p>
      <div class="msg err">${esc(res.reason || "")}</div>
    </div></div>`;
    return;
  }

  if (res.authenticated) { csrf = res.csrf; showPanel(); }
  else $("login-shell").hidden = false;
}

function showPanel() {
  $("login-shell").hidden = true;
  $("panel-shell").hidden = false;
  buildNav();
  fetch("/api/admin/snapshot").then((r) => r.json()).then(render).catch(() => {});
  connect();
}

// ------------------------------------------------------------------- login

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "SNIFFING…";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
    });
    const body = await r.json();
    if (!r.ok) {
      msg($("login-msg"), body.error || "No entry.", "err");
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
    btn.textContent = "LET ME IN";
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
  const reason = prompt("Why is the cow stopping? (optional)", "manual stop");
  if (reason === null) return;
  action(async () => {
    await post("/api/admin/halt", { reason });
    return { note: "Stopped. No new launches; open positions still exit on their rules." };
  });
});

$("btn-resume").addEventListener("click", () =>
  action(async () => {
    await post("/api/admin/resume", {});
    return { note: "Awake and munching again." };
  }));

$("btn-sell-all").addEventListener("click", () => {
  if (!confirm("Queue a sell of EVERY open position?\n\nThis spends SOL and cannot be undone.")) return;
  action(() => post("/api/admin/command", { kind: "sell_all_positions" }));
});

$("btn-claim").addEventListener("click", () =>
  action(() => post("/api/admin/command", { kind: "claim_fees" })));

$("btn-revoke").addEventListener("click", () => {
  if (!confirm("Sign out every admin session, including this one?")) return;
  post("/api/admin/revoke-sessions", {}).then(() => location.reload()).catch(() => {});
});

// A successful change revokes every session, so the only thing to do afterwards
// is reload into the login screen. The fields are cleared either way -- there is
// no reason for a plaintext password to sit in the DOM after the request.
$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("pw-btn");
  const fields = ["pw-current", "pw-next", "pw-confirm"].map($);
  btn.disabled = true;
  btn.textContent = "CHANGING...";
  try {
    await post("/api/admin/password", {
      current: fields[0].value,
      next: fields[1].value,
      confirm: fields[2].value,
    });
    fields.forEach((f) => { f.value = ""; });
    msg($("pw-msg"), "Password changed. Signing you out...", "ok");
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    fields.forEach((f) => { f.value = ""; });
    msg($("pw-msg"), err.message, "err");
    btn.disabled = false;
    btn.textContent = "CHANGE PASSWORD";
  }
});

function sellOne(id, symbol) {
  if (!confirm(`Queue a sell of position #${id} (${symbol})?\n\nThis spends SOL and cannot be undone.`)) return;
  action(() => post("/api/admin/command", { kind: "sell_position", payload: { positionId: id } }));
}

// --------------------------------------------------------------------- nav

const NAV = [
  ["now", "Right now"], ["queue", "The plate"], ["positions", "Chewing"],
  ["money", "Milk & money"], ["feeds", "Noses"], ["learning", "Cow school"],
  ["log", "Barn log"], ["config", "Fences"],
];
const TITLES = Object.fromEntries(NAV);

function buildNav() {
  $("sidenav").innerHTML = NAV.map(([id, label]) =>
    `<button data-tab="${id}" class="${id === tab ? "active" : ""}">
       <span>${esc(label)}</span><span class="badge" data-badge="${id}"></span>
     </button>`).join("");

  $("sidenav").querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab;
      $("sidenav").querySelectorAll("[data-tab]").forEach((b) =>
        b.classList.toggle("active", b.dataset.tab === tab));
      document.querySelectorAll(".panel[data-panel]").forEach((p) =>
        p.classList.toggle("active", p.dataset.panel === tab));
      $("a-title").textContent = TITLES[tab];
    });
  });
}

// ------------------------------------------------------------------ render

function render(d) {
  const b = d.budget;

  // Display only -- see networkLabel() in app.js; the real cluster id is
  // what config, RPC and explorer links use.
  const netLabel = d.network === "mainnet-beta" ? "Mainnet" : d.network;
  $("a-mode").textContent = `${d.dryRun ? "PLAY MONEY" : "REAL MONEY"} · ${netLabel}`;
  $("a-mode-sub").textContent = d.dryRun ? "nothing real is ever signed" : "this spends real SOL";
  $("a-title").textContent = TITLES[tab];

  $("a-warmup").textContent = `warmup: ${
    d.warmup.spanMinutes >= d.warmup.requiredMinutes
      ? "full"
      : `${Math.round(d.warmup.spanMinutes)}/${d.warmup.requiredMinutes}min`}`;
  $("a-clock").textContent = new Date(d.at).toLocaleTimeString();

  countdownFrom = d.nextPollSeconds ?? 0;
  countdownAt = Date.now();
  tickCountdown();

  $("btn-halt").hidden = d.halted;
  $("btn-resume").hidden = !d.halted;

  $("a-notice").innerHTML = d.halted
    ? `<div class="banner pink mb-m"><span class="cap">COW STOPPED.</span> ${esc(d.haltReason || "")} — open positions still follow their exit rules.</div>`
    : (d.dryRun ? `<div class="banner sun mb-m"><span class="cap">PLAY MONEY.</span> The whole pipeline runs, but no transaction is ever signed.</div>` : "");

  // --- wallet (admin always sees it)
  const w = d.wallet;
  $("a-purse").innerHTML = w && w.address
    ? `<div class="label">Purse · ${esc(w.network === "mainnet-beta" ? "Mainnet" : w.network)}</div>
       <div class="bal">${esc(sol(w.balanceSol))} SOL</div>
       <div class="addr">
         <a href="${esc(w.explorerUrl)}" target="_blank" rel="noopener noreferrer"
            title="${esc(w.address)}">${esc(w.address.slice(0, 8))}…${esc(w.address.slice(-8))}</a>
       </div>`
    : `<div class="label">Purse</div><div class="addr">no wallet configured</div>`;

  // --- badges
  const badges = {
    now: d.halted ? "off" : "live",
    queue: String(d.candidates.length),
    positions: String(b.openPositions),
    money: sol(d.outcomes.estimatedFeeSol, 2),
    feeds: `${d.feeds.filter((f) => f.enabled && f.signalsLastHour > 0).length}/${d.feeds.filter((f) => f.enabled).length}`,
    learning: d.learning.enabled ? "on" : "off",
    log: String(d.audit.length),
    config: "",
  };
  document.querySelectorAll("[data-badge]").forEach((el) => {
    el.textContent = badges[el.dataset.badge] ?? "";
    el.hidden = !el.textContent;
  });

  // --- meters
  const cap = d.capacity || {};
  $("a-meters").innerHTML = [
    ["Launches / 24h", `${b.launches} / ${b.maxLaunches}`, (b.launches / Math.max(b.maxLaunches, 1)) * 100, "grass",
      cap.adaptive ? esc(cap.binding).slice(0, 46) : "rolling 24h, not calendar day"],
    ["SOL spent / 24h", sol(b.solSpent), (b.solSpent / Math.max(b.maxSol, 0.0001)) * 100, "grass", `allowance ${sol(b.maxSol, 2)} SOL`],
    ["Losses vs the brake", sol(b.realizedLoss), (b.realizedLoss / Math.max(b.maxLoss, 0.0001)) * 100, "pink", `spending halts at ${b.maxLoss} SOL`],
    ["Open positions", `${b.openPositions} / ${b.maxPositions}`, (b.openPositions / Math.max(b.maxPositions, 1)) * 100, "grass", "concurrent exposure fence"],
  ].map(([label, value, w, col, sub]) => `
    <div class="card tight">
      <div class="label">${esc(label)}</div>
      <div style="font-family:var(--display);font-size:40px;line-height:.98;margin:8px 0" class="num">${esc(value)}</div>
      <span class="bar"><span data-w="${Math.min(100, w).toFixed(1)}" data-col="${col}"></span></span>
      <div class="note" style="margin-top:5px">${esc(sub)}</div>
    </div>`).join("");

  // --- queue
  const queueRow = (q, full) => `
    <div class="dashrow" style="grid-template-columns:${full ? "1.6fr 56px 52px 52px 52px 52px 1.1fr" : "1.6fr 56px 52px 52px 52px 1.1fr"}">
      <span>${esc(q.term.slice(0, 44))}</span>
      <span class="score-chip num" data-score="${q.score >= 70 ? "hot" : q.qualifies ? "ok" : "cold"}">${q.score.toFixed(0)}</span>
      <span class="r grey" style="font-size:13.5px">${q.components.velocity.toFixed(2)}</span>
      <span class="r grey" style="font-size:13.5px">${q.components.corroboration.toFixed(2)}</span>
      ${full ? `<span class="r grey" style="font-size:13.5px">${q.components.cryptoAffinity.toFixed(2)}</span>` : ""}
      <span class="r grey" style="font-size:13.5px">${q.observations}</span>
      <span style="font-size:13.5px" class="grey">${esc(full ? q.feeds.join(", ") : (q.qualifies ? "waiting on a gate" : "score under the line"))}</span>
    </div>`;

  $("a-queue").innerHTML = d.candidates.length
    ? d.candidates.slice(0, 8).map((q) => queueRow(q, false)).join("")
    : `<div class="empty">Nothing on the plate.</div>`;
  $("a-queue-full").innerHTML = d.candidates.length
    ? d.candidates.map((q) => queueRow(q, true)).join("")
    : `<div class="empty">Nothing on the plate.</div>`;

  // --- positions
  const posRow = (p, full) => `
    <div class="dashrow" style="grid-template-columns:${full ? "60px 130px 104px 80px 1fr 90px" : "1fr auto auto"}">
      ${full ? `<span class="num grey">${p.id}</span>` : ""}
      <span>
        <span style="font-family:var(--display);font-size:20px">${esc(p.symbol || p.mint.slice(0, 8))}</span>
        ${full ? "" : `<br><span class="grey" style="font-size:13px">in at ${sol(p.entrySol)} SOL</span>`}
      </span>
      ${full ? `<span class="r num">${sol(p.entrySol)}</span>` : ""}
      <span class="${full ? "r" : ""} num" style="font-family:var(--display);font-size:18px">${p.ageMinutes.toFixed(0)}m</span>
      ${full ? `<span>${p.status === "stuck" ? `<span class="red">stuck (${p.sellAttempts} tries)</span>` : "open"}</span>` : ""}
      <span class="${full ? "r" : ""}"><button class="sm pink" data-sell="${p.id}" data-sym="${esc(p.symbol || "")}">SELL</button></span>
    </div>`;

  $("a-positions").innerHTML = d.positions.length
    ? d.positions.map((p) => posRow(p, false)).join("")
    : `<div class="empty">Nothing being chewed.</div>`;
  $("a-positions-full").innerHTML = d.positions.length
    ? d.positions.map((p) => posRow(p, true)).join("")
    : `<div class="empty">Nothing being chewed.</div>`;

  document.querySelectorAll("[data-sell]").forEach((btn) =>
    btn.addEventListener("click", () => sellOne(Number(btn.dataset.sell), btn.dataset.sym)));

  // --- commands
  $("a-commands").innerHTML = d.commands.length
    ? d.commands.slice(0, 6).map((c) => `
        <div class="dashrow" style="grid-template-columns:96px 1fr auto">
          <span class="grey num" style="font-size:13px">${esc(fmtTime(c.requested_at))}</span>
          <span>${esc(String(c.kind).replace(/_/g, " "))}</span>
          <span class="tag ${c.status === "done" ? "leaf" : c.status === "failed" ? "pink" : ""}">${esc(String(c.status).toUpperCase())}</span>
        </div>`).join("")
    : `<div class="empty">Nothing asked of it yet.</div>`;

  // --- money
  const o = d.outcomes;
  // From stats, not outcomes: fee_claims is the exact total, while
  // outcomes.estimatedFeeSol is a per-token apportionment. And this
  // subtracts launch spend, which the old client-side sum did not.
  const net = d.stats.netProfitSol || 0;
  $("a-money-plates").innerHTML = `
    <div class="plate hero-plate">
      <div class="cap">CREATOR-FEE MILK</div>
      <div class="value">${esc(sol(o.estimatedFeeSol))}</div>
      <div class="sub">SOL across ${d.claims.length} bucket${d.claims.length === 1 ? "" : "s"}</div>
    </div>
    <div class="plate" style="background:var(--pink)">
      <div class="label" style="color:var(--ink)">Dev position P&amp;L</div>
      <div class="value">${o.realisedPnlSol >= 0 ? "+" : ""}${esc(sol(o.realisedPnlSol))}</div>
      <div class="sub">SOL over ${o.settled} settled launches</div>
    </div>
    <div class="plate" style="background:var(--sky)">
      <div class="label" style="color:var(--ink)">Net</div>
      <div class="value">${net >= 0 ? "+" : ""}${esc(sol(net))}</div>
      <div class="sub">SOL. Fees are the business.</div>
    </div>`;

  $("a-ledger").innerHTML = d.ledger.length
    ? d.ledger.map((l) => `
        <div class="dashrow" style="grid-template-columns:170px 150px 110px 1fr">
          <span class="grey num">${esc(fmtTime(l.ts))}</span>
          <span>${esc(l.kind.replace(/_/g, " "))}</span>
          <span class="r num ${l.solDelta >= 0 ? "deep" : "red"}" style="font-family:var(--display);font-size:16px">${l.solDelta >= 0 ? "+" : ""}${esc(sol(l.solDelta, 5))}</span>
          <span class="grey" style="font-size:13.5px">${esc(l.note || "")}</span>
        </div>`).join("")
    : `<div class="empty">No lamports moved.</div>`;

  // --- feeds
  $("a-feeds").innerHTML = d.feeds.map((f) => `
    <div class="dashrow" style="grid-template-columns:150px 90px 80px 80px 1fr">
      <span>${esc(f.id)}</span>
      <span>${f.enabled ? `<span class="tag leaf">ON</span>` : `<span class="tag grey">OFF</span>`}</span>
      <span class="r grey num">${f.weight}</span>
      <span class="r num ${f.enabled && f.signalsLastHour === 0 ? "red" : ""}">${f.signalsLastHour}</span>
      <span class="grey">${esc(ago(f.lastSeen))}</span>
    </div>`).join("");

  $("a-meter-x").innerHTML = d.xApiMeterUsd > 0
    ? `<p class="note">X API spend this month: <strong>$${d.xApiMeterUsd.toFixed(2)}</strong></p>` : "";

  $("a-declines").innerHTML = (d.declines || []).length
    ? d.declines.map((x) => `
        <div class="dashrow" style="grid-template-columns:1fr auto auto">
          <span>${esc(x.term)}</span>
          <span class="grey num" style="font-size:13px">${esc(ago(x.ts))}</span>
          <span class="tag ${esc(x.tone)}" title="${esc(x.detail)}">${esc(x.reason)}</span>
        </div>`).join("")
    : `<div class="empty">Nothing turned away yet.</div>`;

  // --- cow school
  const L = d.learning;
  $("a-learn-state").innerHTML = !L.enabled
    ? `<div class="banner sun"><span class="cap">COW SCHOOL IS OFF.</span> It needs ${L.minSampleSize} settled launches before it will run at all — there ${o.settled === 1 ? "is" : "are"} ${o.settled}. It may change how <em>picky</em> the cow is. It can never change how much money the cow may lose.</div>`
    : (L.autoApply
      ? `<div class="banner" style="background:var(--leaf)"><span class="cap">LEARNING AND APPLYING.</span> Changes land inside the guardrails automatically.</div>`
      : `<div class="banner sun"><span class="cap">LEARNING, PROPOSE-ONLY.</span> Suggestions are logged but never applied.</div>`);

  $("a-outcomes").innerHTML = (d.recentOutcomes || []).length
    ? d.recentOutcomes.map((r) => `
        <div class="dashrow" style="grid-template-columns:96px 130px 60px 104px 104px 100px 1fr">
          <span class="tag ${r.verdict === "hit" ? "leaf" : r.verdict === "dud" ? "" : "sun"}">${esc({ hit: "YUM", modest: "OK", dud: "MEH" }[r.verdict] || r.verdict)}</span>
          <span style="font-family:var(--display);font-size:19px">${esc(r.symbol)}</span>
          <span class="r num">${Number(r.score).toFixed(0)}</span>
          <span class="r num" style="font-family:var(--display);font-size:16px">${esc(money(r.peakMcapUsd))}</span>
          <span class="r num grey">${esc(sol(r.estimatedFeeSol, 5))}</span>
          <span class="r num strong ${(r.realizedPnlSol ?? 0) >= 0 ? "deep" : "red"}">${r.realizedPnlSol == null ? "—" : sol(r.realizedPnlSol)}</span>
          <span class="grey" style="font-size:13px">${esc((r.feeds || []).join(", "))}</span>
        </div>`).join("")
    : `<div class="empty">Nothing has settled yet.</div>`;

  const ov = L.overlay || { present: false, values: {} };
  $("a-overlay").innerHTML = ov.present
    ? `<p class="note" style="margin:0">Learned values in force since ${esc(new Date(ov.updatedAt || 0).toLocaleString())}:</p>
       ${Object.entries(ov.values).map(([k, v]) =>
         `<div class="dashrow" style="grid-template-columns:1fr auto"><span>${esc(k)}</span><span class="num" style="font-family:var(--display)">${esc(v)}</span></div>`).join("")}`
    : `<p class="note" style="margin:0">No learned values in force; the fences are exactly as you wrote them.</p>`;

  $("a-tuning").innerHTML = (L.history || []).length
    ? L.history.map((h) => {
        const acc = Array.isArray(h.accepted) ? h.accepted : [];
        const rej = Array.isArray(h.rejected) ? h.rejected : [];
        return `<div class="dashrow" style="grid-template-columns:160px 80px 1fr 1.2fr">
          <span class="grey num" style="font-size:13px">${esc(fmtTime(h.ts))}</span>
          <span class="r num">${h.sampleSize}</span>
          <span style="font-size:13px">${acc.length
            ? acc.map((a) => `${esc(a.path)}: ${a.from}→${a.to}`).join("<br>")
            : `<span class="grey">none</span>`}${rej.length ? `<br><span class="grey">${rej.length} rejected</span>` : ""}</span>
          <span class="grey" style="font-size:13px">${esc(String(h.rationale || "").slice(0, 150))}</span>
        </div>`;
      }).join("")
    : `<div class="empty">No school reports yet.</div>`;

  // --- log + config
  $("a-audit").innerHTML = d.audit.length
    ? d.audit.map((a) => `
        <div class="dashrow" style="grid-template-columns:170px 190px 1fr 130px">
          <span class="grey num" style="font-size:13px">${esc(fmtTime(a.ts))}</span>
          <span>${esc(a.action)}</span>
          <span class="grey" style="font-size:13px">${esc(String(a.detail || "").slice(0, 80))}</span>
          <span class="grey num" style="font-size:13px">${esc(a.ip || "")}</span>
        </div>`).join("")
    : `<div class="empty">Nothing logged.</div>`;

  $("a-config").textContent = JSON.stringify(d.config, null, 2);

  applyDynamicStyles();
  document.body.classList.remove("stale");
}

/** CSP forbids style attributes on generated markup; apply data-driven values here. */
function applyDynamicStyles() {
  const cols = { grass: "#7dbb2e", leaf: "#a9de5b", pink: "#ff9eb5", sun: "#ffd645" };
  document.querySelectorAll("[data-w]").forEach((el) => {
    el.style.width = `${el.dataset.w}%`;
    if (el.dataset.col) el.style.background = cols[el.dataset.col] || cols.grass;
  });
  document.querySelectorAll("[data-score]").forEach((el) => {
    const t = el.dataset.score;
    el.style.background = t === "hot" ? cols.leaf : t === "ok" ? cols.sun : "#fffdf5";
    el.style.border = "3px solid #1a1a1a";
    el.style.borderRadius = "999px";
    el.style.textAlign = "center";
    el.style.fontFamily = "var(--display)";
    el.style.fontSize = "16px";
  });
}

function tickCountdown() {
  const left = Math.max(0, countdownFrom - Math.floor((Date.now() - countdownAt) / 1000));
  const el = $("a-countdown");
  if (!el) return;
  el.textContent = left > 0
    ? `next sniff ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`
    : "sniffing now";
}
setInterval(tickCountdown, 1000);

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
