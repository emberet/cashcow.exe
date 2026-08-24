/* cashcow.exe — public page. Read-only, no controls, no live candidate queue. */

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString());

function sol(n, d = 4) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a > 0 && a < 0.0001) return n > 0 ? "<0.0001" : ">-0.0001";
  return n.toFixed(d);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const money = (usd) =>
  usd >= 1000 ? `$${Math.round(usd / 1000)}k` : `$${Math.round(usd || 0)}`;

/** Zigzag grass tips, as a clip-path polygon of N blades. */
function grassEdge(blades = 90) {
  const pts = [];
  for (let i = 0; i < blades; i++) {
    pts.push(`${((i / blades) * 100).toFixed(2)}% 100%`);
    pts.push(`${(((i + 0.5) / blades) * 100).toFixed(2)}% 0%`);
  }
  pts.push("100% 100%");
  return `polygon(${pts.join(", ")})`;
}

// ------------------------------------------------------------------ charts

/** Area chart with a pink rule at each launch. */
function signalChart(values, launchTimes, startMs, stepMs) {
  if (!values || values.length < 2 || values.every((v) => v === 0)) {
    return `<div class="chart-empty">Nothing chewed yet</div>`;
  }

  const w = 600, h = 170, pad = 10;
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, pad + (1 - v / max) * (h - pad * 2)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;

  const spanMs = values.length * stepMs;
  const marks = (launchTimes || [])
    .filter((t) => t >= startMs && t <= startMs + spanMs)
    .map((t) => (((t - startMs) / spanMs) * w).toFixed(1))
    .map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#ff9eb5" stroke-width="4" vector-effect="non-scaling-stroke"/>`)
    .join("");

  const grid = [0.25, 0.5, 0.75]
    .map((f) => `<line x1="0" y1="${(f * h).toFixed(1)}" x2="${w}" y2="${(f * h).toFixed(1)}" stroke="#e2d8b4" stroke-width="2" vector-effect="non-scaling-stroke"/>`)
    .join("");

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="mentions per hour">
    ${grid}
    <path d="${area}" fill="#a9de5b"/>
    <path d="${line}" fill="none" stroke="#1a1a1a" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${marks}
  </svg>
  <div class="chart-axis"><span>48h ago</span><span style="color:#d6547b">pink line = a launch</span><span>now</span></div>`;
}

// ------------------------------------------------------------------ render

function render(d) {
  const s = d.stats;

  // --- status chips
  $("p-mode").textContent = d.dryRun ? "PLAY MONEY" : "REAL MONEY";
  $("p-mode").className = `pill ${d.dryRun ? "sun" : "pink"}`;
  $("p-network").textContent = d.network;

  const statusWord = {
    live: "MUNCHING", "dry-run": "PRETEND MUNCHING",
    "warming-up": "SNIFFING", halted: "NAPPING",
  }[d.status.pill] || "MUNCHING";
  $("p-status").innerHTML = `${esc(statusWord)} <span class="blinker"></span>`;
  $("p-status").className = `pill ${d.status.pill === "halted" ? "pink" : "leaf"}`;
  $("p-status").title = d.status.detail;

  // --- hero
  const f = d.funnel;
  const sniffed = f.gates[0]?.pass ?? 0;
  const burped = f.gates[7]?.pass ?? 0;
  const net = (s.feesTotalSol || 0) + (s.realisedPnlSol || 0);

  $("hero-bubble").innerHTML = sniffed > 0
    ? `Moo. I ate ${int(sniffed)} rumours today<br>and burped out ${int(burped)} coin${burped === 1 ? "" : "s"}.`
    : `Moo. Nothing to chew just yet.<br>Give me a few minutes.`;

  $("hero-readout").innerHTML =
    `<span>IN ${esc(int(sniffed))} RUMOURS</span><span>·</span>` +
    `<span>OUT ${esc(int(burped))} COINS</span><span>·</span>` +
    `<span>NET ${net >= 0 ? "+" : ""}${esc(sol(net))} SOL</span>`;

  // --- gate funnel
  $("gates").innerHTML = f.gates.map((g) => `
    <div class="gate${g.jam ? " jam" : ""}${g.win ? " win" : ""}">
      <div class="gate-top">
        <span class="gate-idx">${g.idx}</span>
        <span class="gate-tag">${g.jam ? "THE JAM" : g.win ? "YUM" : ""}</span>
      </div>
      <div class="gate-label">${esc(g.label)}</div>
      <div class="gate-pass">${esc(int(g.pass))}</div>
      <div class="gate-unit">${esc(g.unit)}</div>
      <div class="gate-drop">${esc(g.drop)}</div>
    </div>`).join("");

  // --- pipeline notes
  // Read the funnel, not the decline list: declines are delayed for the public
  // page, so using them here made the banner claim "all clear" while the crowd
  // gate card showed a jam. The aggregate count leaks no terms.
  const stuck = f.crowdedOut ?? 0;
  const lastLaunch = d.launches?.[0]?.createdAt;
  const quiet = lastLaunch ? ago(lastLaunch) : "a while";
  $("pipeline-notes").innerHTML = `
    <div class="banner pink" style="display:flex;align-items:center;gap:14px">
      <span style="font-size:30px;font-family:var(--display)">!</span>
      <div>
        <div class="cap">RIGHT NOW</div>
        <div>${stuck > 0
          ? `${stuck} tasty trend${stuck === 1 ? " was" : "s were"} turned away at the <strong>crowd gate</strong> today — somebody else already minted them. No thanks.`
          : `Nothing jammed at the crowd gate. The plate is clear.`}</div>
      </div>
    </div>
    <div class="banner">
      <div class="cap deep">${burped === 0 ? "QUIET STRETCH" : `LAST BURP ${esc(quiet).toUpperCase()} AGO`}</div>
      <div>Not a bug. Saying no is the cheap outcome.</div>
    </div>`;

  // --- money plates
  const runway = d.capacityRunwayDays;
  $("money-plates").innerHTML = `
    <div class="plate hero-plate">
      <div class="cap">NET, ALL TIME</div>
      <div class="value">${net >= 0 ? "+" : ""}${esc(sol(net))}</div>
      <div class="sub">SOL. Creator-fee milk, minus what the dev positions trampled.</div>
    </div>
    <div class="plate">
      <div class="label">Creator-fee milk</div>
      <div class="value deep">${esc(sol(s.feesTotalSol))}</div>
      <div class="sub">SOL, collected in ${d.claims.length} bucket${d.claims.length === 1 ? "" : "s"}</div>
    </div>
    <div class="plate">
      <div class="label">Dev position</div>
      <div class="value ${s.realisedPnlSol >= 0 ? "deep" : "red"}">${s.realisedPnlSol >= 0 ? "+" : ""}${esc(sol(s.realisedPnlSol))}</div>
      <div class="sub">SOL over ${s.closedPositions} closed${
        s.winRate == null ? "" : ` · ${Math.round(s.winRate * 100)}% winners`}</div>
    </div>
    <div class="plate">
      <div class="label">Still chewing</div>
      <div class="value">${int(s.openPositions)}</div>
      <div class="sub">${runway ? `${runway} of runway before the wallet floor` : "positions it has not sold yet"}</div>
    </div>`;

  // --- charts
  const ss = d.signalSeries || { values: [], startMs: 0, stepMs: 3600000 };
  $("chart-signals").innerHTML = signalChart(
    ss.values, (d.launches || []).map((l) => l.createdAt), ss.startMs, ss.stepMs,
  );
  const peak = Math.max(...(ss.values || [0]), 0);
  $("chart-cap").textContent = `mentions / hour · 48h · peak ${int(peak)}`;

  // --- feeds
  const maxFeed = Math.max(...(d.feeds || []).map((x) => x.signalsLastHour), 1);
  const fed = new Set((d.attribution || []).map((a) => a.feed));
  $("feeds").innerHTML = (d.feeds || []).map((x) => {
    const off = !x.enabled;
    const w = off ? 0 : (x.signalsLastHour / maxFeed) * 100;
    return `<div class="feedrow">
      <span class="${off ? "grey" : ""}">${esc(x.id)}</span>
      <span class="bar"><span data-w="${w.toFixed(1)}" data-col="${fed.has(x.id) ? "grass" : "leaf"}"></span></span>
      <span class="n ${off ? "grey" : ""}">${off ? "zzz" : int(x.signalsLastHour)}</span>
    </div>`;
  }).join("");

  // --- launches
  $("launch-count").textContent = `${s.launchesTotal} TOTAL · DUDS INCLUDED`;
  $("launches").innerHTML = (d.launches || []).length
    ? d.launches.map(launchRow).join("")
    : `<div class="card empty">No coins yet. It only burps when a trend clears every gate.</div>`;

  // --- declines
  $("decline-delay").textContent = d.declineDelayHours
    ? `${d.declineDelayHours}-hour delay` : "live";
  $("declines").innerHTML = (d.declines || []).length
    ? d.declines.map((x) => `
        <div class="dashrow" style="grid-template-columns:1fr auto">
          <span style="font-size:16px">${esc(x.term)}</span>
          <span class="tag ${esc(x.tone)}" title="${esc(x.detail)}">${esc(x.reason)}</span>
        </div>`).join("")
    : `<div class="empty">Nothing turned away yet.</div>`;

  // --- fences
  const r = d.rules;
  $("fences").innerHTML = [
    ["Launches today", `${d.launchesToday} / ${r.maxLaunchesPerDay}`,
      (d.launchesToday / Math.max(r.maxLaunchesPerDay, 1)) * 100, "grass", "rolling 24h, not calendar day"],
    ["Buys of each coin", r.devBuySol > 0 ? `${r.devBuySol} SOL` : "nothing", 0, "grass",
      r.devBuySol > 0 ? "fixed size, every single time" : "pure fee harvesting, no dev bag"],
    ["Takes profit at", `${r.takeProfitMultiple}×`, 0, "grass", `or after ${r.maxHoldMinutes} minutes, whichever comes first`],
    ["Cuts losses at", `−${r.stopLossPct}%`, 0, "pink", "no hunches, no averaging down"],
  ].map(([label, value, w, col, note]) => `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-weight:600;font-size:15.5px">${esc(label)}</span>
        <span style="font-family:var(--display);font-size:19px" class="num">${esc(value)}</span>
      </div>
      ${w > 0 ? `<span class="bar" style="margin-top:5px"><span data-w="${Math.min(100, w).toFixed(1)}" data-col="${col}"></span></span>` : ""}
      <div class="note" style="margin-top:4px">${esc(note)}</div>
    </div>`).join("");

  // --- claims
  $("claims").innerHTML = (d.claims || []).length
    ? d.claims.map((c) => `
        <div class="dashrow" style="grid-template-columns:220px 130px 1fr">
          <span class="grey num">${esc(new Date(c.ts).toLocaleString())}</span>
          <span class="r deep num" style="text-align:right;font-family:var(--display);font-size:19px">${esc(sol(c.sol, 5))}</span>
          <span class="grey" style="font-size:14.5px">${c.tokens} token${c.tokens === 1 ? "" : "s"} in the bucket</span>
        </div>`).join("")
    : `<div class="empty">No milk collected yet.</div>`;

  // --- countdown + footer
  countdownFrom = d.nextPollSeconds ?? 0;
  paintCountdown();

  $("foot-meta").innerHTML =
    `${d.dryRun ? "Play money — nothing real is spent" : `Live on ${esc(d.network)}`}<br>` +
    `Updated ${new Date(d.at).toLocaleTimeString()}<br>` +
    `The pre-launch queue stays behind the barn door`;

  applyDynamicStyles();
  document.body.classList.remove("stale");
}

function launchRow(l) {
  const v = l.outcome && l.outcome.verdict !== "pending" ? l.outcome.verdict : null;
  const win = v === "hit";
  const peak = l.outcome ? money(l.outcome.peakMcapUsd) : "—";

  let pnl = "holding", cls = "deep";
  if (l.position && l.position.status !== "open" && l.position.pnlSol != null) {
    pnl = `${l.position.pnlSol >= 0 ? "+" : ""}${sol(l.position.pnlSol, 4)}`;
    cls = l.position.pnlSol >= 0 ? "deep" : "red";
  } else if (!l.position) {
    pnl = "—"; cls = "grey";
  }

  return `<div class="launch-row${win ? " win" : ""}">
    <span class="sym">${esc(l.symbol)}</span>
    <span class="nm">${esc(l.name)}</span>
    <span class="score${l.score >= 70 ? " hot" : ""}">${Math.round(l.score)}</span>
    <span class="grey hide-md" style="font-size:13.5px">${esc((l.feeds || []).join(", "))}</span>
    <span class="r ${win ? "deep" : ""}" style="font-family:var(--display);font-size:19px">${esc(peak)}</span>
    <span class="r grey hide-md">${esc(v ? v : "settling")}</span>
    <span class="r strong ${cls}">${esc(pnl)}</span>
    <span class="r grey hide-md">${esc(ago(l.createdAt))}</span>
    <span class="r hide-md"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" style="font-family:var(--display);font-size:14px">peek</a></span>
  </div>`;
}

/** CSP forbids style attributes on generated markup; apply data-driven values here. */
function applyDynamicStyles() {
  const cols = { grass: "#7dbb2e", leaf: "#a9de5b", pink: "#ff9eb5", sun: "#ffd645" };
  document.querySelectorAll("[data-w]").forEach((el) => {
    el.style.width = `${el.dataset.w}%`;
    if (el.dataset.col) el.style.background = cols[el.dataset.col] || cols.grass;
  });
  const edge = grassEdge();
  ["grass-tips-1", "grass-tips-2"].forEach((id) => {
    const el = $(id);
    if (el) el.style.clipPath = edge;
  });
}

// --------------------------------------------------------------- countdown

let countdownFrom = 0;
let countdownAt = Date.now();

function paintCountdown() {
  countdownAt = Date.now();
  tickCountdown();
}

function tickCountdown() {
  const elapsed = Math.floor((Date.now() - countdownAt) / 1000);
  const left = Math.max(0, countdownFrom - elapsed);
  const el = $("p-countdown");
  if (!el) return;
  el.textContent = left > 0
    ? `next sniff ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`
    : "sniffing now";
}
setInterval(tickCountdown, 1000);

// ------------------------------------------------------------------ stream

let es, retry = 1000;

function connect() {
  es = new EventSource("/api/stream");

  es.addEventListener("snapshot", (ev) => {
    retry = 1000;
    try { render(JSON.parse(ev.data)); } catch (e) { console.error("render failed", e); }
  });

  es.onopen = () => { retry = 1000; };

  es.onerror = () => {
    // Dim, so a stale page is never mistaken for a live one.
    document.body.classList.add("stale");
    es.close();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  };
}

fetch("/api/public")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then(render)
  .catch(() => {
    $("hero-bubble").textContent = "Moo? I cannot reach the barn.";
    $("p-status").innerHTML = "OFFLINE";
    $("p-status").className = "pill pink";
  })
  .finally(connect);
