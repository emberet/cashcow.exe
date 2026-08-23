/* Public dashboard. Read-only, no controls, no pre-launch candidates. */

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ format

const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString());

function fmtSol(n, digits = 4) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.0001) return n > 0 ? "<0.0001" : ">-0.0001";
  return n.toFixed(digits);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Same FNV-1a hue derivation the token artwork uses, so avatars match. */
function hueOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) % 360;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ charts

/** Filled area chart, drawn as inline SVG so there is no charting dependency. */
function areaChart(values, { height = 130, stroke = "#7c8cff", spanHours = 48 } = {}) {
  if (!values || values.length < 2 || values.every((v) => v === 0)) {
    return `<div class="chart-empty">Not enough data yet</div>`;
  }

  const w = 600;
  const pad = 6;
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);

  const pts = values.map((v, i) => {
    const x = i * step;
    const y = pad + (1 - v / max) * (height - pad * 2);
    return [x, y];
  });

  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${height} L0,${height} Z`;
  const grid = [0.25, 0.5, 0.75].map((f) =>
    `<line x1="0" y1="${(pad + f * (height - pad * 2)).toFixed(1)}" x2="${w}" y2="${(pad + f * (height - pad * 2)).toFixed(1)}"
       stroke="#1e2230" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");

  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img" aria-label="activity chart">
    <defs>
      <linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${area}" fill="url(#gArea)"/>
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="chart-meta"><span>${spanHours}h ago</span><span>peak ${max.toLocaleString()}/h</span><span>now</span></div>`;
}

/** Cumulative line that crosses zero, coloured by final sign. */
function pnlChart(series, height = 130) {
  if (!series || series.length < 2) {
    return `<div class="chart-empty">Not enough closed positions yet</div>`;
  }

  const w = 600;
  const pad = 8;
  const vals = series.map((p) => p.cumulative);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const range = max - min || 1;
  const step = w / (series.length - 1);
  const yOf = (v) => pad + (1 - (v - min) / range) * (height - pad * 2);

  const line = vals.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  const colour = last >= 0 ? "#34d399" : "#f87171";
  const zeroY = yOf(0);

  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img" aria-label="profit and loss chart">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${w}" y2="${zeroY.toFixed(1)}"
          stroke="#262b38" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="${colour}" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="chart-meta"><span>${series.length} closed positions</span><span class="${last >= 0 ? "pos" : "neg"}">${last >= 0 ? "+" : ""}${last.toFixed(4)} SOL</span></div>`;
}

function barList(rows) {
  if (!rows || !rows.length) return `<div class="empty">No launches yet.</div>`;
  const max = Math.max(...rows.map((r) => r.count), 1);
  // Width is carried as a data attribute and applied in applyDynamicStyles():
  // the page runs under `style-src 'self'`, which blocks style attributes.
  return `<div class="barlist">${rows.map((r) => `
    <div class="barrow">
      <span class="dim">${esc(r.feed)}</span>
      <span class="bartrack"><span class="barfill" data-w="${((r.count / max) * 100).toFixed(2)}"></span></span>
      <span class="n">${r.count}</span>
    </div>`).join("")}</div>`;
}

// ------------------------------------------------------------------ render

function render(d) {
  // status
  const pill = $("status-pill");
  pill.className = `pill ${d.status.pill}`;
  $("status-label").textContent = d.status.label;
  $("status-detail").textContent = d.status.detail;

  // headline stats
  const s = d.stats;
  $("s-total").textContent = fmtInt(s.launchesTotal);
  $("s-today").textContent = `${fmtInt(s.launches24h)} in the last 24 hours`;
  $("s-fees").textContent = fmtSol(s.feesTotalSol);
  $("s-open").textContent = fmtInt(s.openPositions);

  const pnlEl = $("s-open-sub");
  if (s.closedPositions > 0) {
    const w = s.winRate == null ? "" : ` · ${Math.round(s.winRate * 100)}% profitable`;
    pnlEl.innerHTML = `${s.closedPositions} closed, <span class="${s.realisedPnlSol >= 0 ? "pos" : "neg"}">${
      s.realisedPnlSol >= 0 ? "+" : ""}${fmtSol(s.realisedPnlSol)} SOL</span>${esc(w)}`;
  } else {
    pnlEl.textContent = "positions it hasn't sold yet";
  }

  $("s-terms").textContent = fmtInt(s.termsTracked);
  $("s-signals").textContent = `${fmtInt(s.signals24h)} mentions in 24 hours`;

  // charts
  $("chart-signals").innerHTML = areaChart(d.signalSeries?.values ?? []);
  $("chart-pnl").innerHTML = pnlChart(d.pnlSeries ?? []);
  $("attribution").innerHTML = barList(d.attribution ?? []);

  // launches
  $("launches").innerHTML = (d.launches ?? []).length
    ? d.launches.map(launchCard).join("")
    : `<div class="empty">Nothing launched yet. It only fires when a trend clears every check.</div>`;

  // feeds
  const enabledCount = (d.feeds ?? []).filter((f) => f.enabled).length;
  const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
  const n = $("hero-nsources");
  if (n) n.textContent = words[enabledCount] ?? String(enabledCount);

  $("feeds").innerHTML = (d.feeds ?? []).map((f) => {
    const cls = !f.enabled ? "idle" : f.healthy ? "on" : "off";
    const sub = !f.enabled ? "off" : f.signalsLastHour > 0
      ? `${f.signalsLastHour} in the last hour`
      : `quiet · last ${ago(f.lastSeen)}`;
    return `<div class="feed">
      <span class="dot ${cls}"></span>
      <span><span class="fname">${esc(f.id)}</span><br><span class="fsub">${esc(sub)}</span></span>
    </div>`;
  }).join("");

  // rules
  const r = d.rules;
  $("rules").innerHTML = [
    ["Most launches per day", r.maxLaunchesPerDay],
    ["It buys of each coin", r.devBuySol > 0 ? `${r.devBuySol} SOL` : "nothing"],
    ["Takes profit at", `${r.takeProfitMultiple}×`],
    ["Sells no later than", `${r.maxHoldMinutes} min`],
    ["Cuts losses at", `−${r.stopLossPct}%`],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

  $("foot-meta").textContent =
    `${d.dryRun ? "Practice mode — no real money." : `Network: ${d.network}.`} Updated ${new Date(d.at).toLocaleTimeString()}.`;

  applyDynamicStyles();
  document.body.classList.remove("stale");
}

/**
 * CSP forbids inline style attributes, but not CSSOM writes. Anything genuinely
 * data-driven is therefore emitted as a data attribute and applied here.
 */
function applyDynamicStyles() {
  document.querySelectorAll(".barfill[data-w]").forEach((el) => {
    el.style.width = `${el.dataset.w}%`;
  });
  document.querySelectorAll(".avatar[data-hue]").forEach((el) => {
    const h = Number(el.dataset.hue);
    el.style.background =
      `linear-gradient(140deg, hsl(${h},82%,56%), hsl(${(h + 45) % 360},78%,44%))`;
  });
}

function launchCard(l) {
  const hue = hueOf(l.symbol);

  let posTag = "";
  if (l.position) {
    if (l.position.status === "open") posTag = `<span class="tag open">holding</span>`;
    else if (l.position.pnlSol != null) {
      const good = l.position.pnlSol >= 0;
      posTag = `<span class="tag ${good ? "pos" : "neg"}">${good ? "+" : ""}${fmtSol(l.position.pnlSol, 3)} SOL</span>`;
    }
  }

  // Verdicts are shown honestly, duds included -- that is the point.
  let verdictTag = "";
  if (l.outcome && l.outcome.verdict !== "pending") {
    const v = l.outcome.verdict;
    const cls = v === "hit" ? "pos" : v === "dud" ? "neg" : "";
    const peak = l.outcome.peakMcapUsd >= 1000
      ? ` $${Math.round(l.outcome.peakMcapUsd / 1000)}k peak` : "";
    verdictTag = `<span class="tag ${cls}">${esc(v)}${esc(peak)}</span>`;
  }

  return `<div class="launch">
    <div class="avatar" data-hue="${hue}">${esc(l.symbol.slice(0, 4))}</div>
    <div class="meta">
      <div class="sym">${esc(l.symbol)}</div>
      <div class="nm">${esc(l.name)}</div>
      <div class="row">
        <span class="tag score">${l.score.toFixed(0)}</span>
        <span class="tag">${esc((l.feeds || []).join(", ") || "—")}</span>
        ${verdictTag}${posTag}
      </div>
      <div class="row">
        <span class="fsub faint">${esc(ago(l.createdAt))}</span>
        <a class="fsub" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">view →</a>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ stream

let es;
let retry = 1000;

function connect() {
  es = new EventSource("/api/stream");

  es.addEventListener("snapshot", (ev) => {
    retry = 1000;
    try {
      render(JSON.parse(ev.data));
    } catch (e) {
      console.error("render failed", e);
    }
  });

  es.onopen = () => { retry = 1000; };

  es.onerror = () => {
    // Dim the page so a stale view is never mistaken for a live one.
    document.body.classList.add("stale");
    es.close();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  };
}

// Seed immediately so the page is not blank while SSE connects.
fetch("/api/public")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then(render)
  .catch(() => {
    $("status-label").textContent = "Offline";
    $("status-detail").textContent = "Could not reach the bot. Is it running?";
  })
  .finally(connect);

// Relative timestamps drift if the tab is left open.
setInterval(() => {
  if (!document.hidden) {
    fetch("/api/public").then((r) => r.json()).then(render).catch(() => {});
  }
}, 60000);
