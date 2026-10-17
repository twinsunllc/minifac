// minifac viewer — vanilla ES module, no build step.

import { edgeStyle, edgeTooltip, routeEdgesOf } from "./edge-style.js";
import { edgeLanes, edgePath, layered } from "./layout.js";

const state = {
  factories: [],
  selectedFactoryId: null,
  factoryDetail: null,
  runs: [],
  activeRunId: null,
  source: null,
  nodeStatuses: new Map(), // nodeId → "running" | "succeeded" | "failed"
};

const els = {
  factoryList: document.getElementById("factory-list"),
  runList: document.getElementById("run-list"),
  factoryName: document.getElementById("factory-name"),
  startBtn: document.getElementById("start-run"),
  graph: document.getElementById("graph"),
  eventTail: document.getElementById("event-tail"),
  serverInfo: document.getElementById("server-info"),
};

els.serverInfo.textContent = `${location.host}`;

els.startBtn.addEventListener("click", () => {
  if (state.selectedFactoryId) startRun(state.selectedFactoryId);
});

async function refreshFactories() {
  const r = await fetch("/api/factories");
  const data = await r.json();
  state.factories = data.factories || [];
  renderFactories();
}

function renderFactories() {
  els.factoryList.replaceChildren();
  for (const f of state.factories) {
    const li = document.createElement("li");
    li.textContent = f.id + (f.error ? " ⚠" : "");
    if (f.error) {
      li.classList.add("error");
      li.title = f.error;
    }
    if (f.id === state.selectedFactoryId) li.classList.add("selected");
    li.addEventListener("click", () => selectFactory(f.id));
    els.factoryList.appendChild(li);
  }
}

async function selectFactory(id) {
  state.selectedFactoryId = id;
  state.factoryDetail = null;
  state.nodeStatuses.clear();
  renderFactories();
  els.factoryName.textContent = id;
  els.startBtn.disabled = true;

  const r = await fetch(`/api/factories/${encodeURIComponent(id)}`);
  if (r.status === 422) {
    const data = await r.json();
    els.factoryName.textContent = `${id} — invalid: ${data.error || ""}`;
    return;
  }
  if (!r.ok) {
    els.factoryName.textContent = `${id} — error ${r.status}`;
    return;
  }
  const data = await r.json();
  state.factoryDetail = data;
  els.factoryName.textContent = `${data.name} (${data.id})`;
  els.startBtn.disabled = false;
  drawGraph(data);
}

async function startRun(factoryId) {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  els.eventTail.replaceChildren();
  state.nodeStatuses.clear();
  if (state.factoryDetail) drawGraph(state.factoryDetail);

  const r = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ factoryId }),
  });
  if (r.status === 409) {
    const data = await r.json();
    appendEvent({ ev: "status", text: `Run already in flight: ${data.activeRunId}` });
    subscribe(data.activeRunId);
    return;
  }
  if (!r.ok) {
    const text = await r.text();
    appendEvent({ ev: "stderr", text: `start failed: ${r.status} ${text}` });
    return;
  }
  const data = await r.json();
  state.activeRunId = data.id;
  await refreshRuns();
  subscribe(data.id);
}

function subscribe(runId) {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  state.activeRunId = runId;
  const src = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.source = src;

  const handle = (kind) => (e) => {
    let data = null;
    try {
      data = JSON.parse(e.data);
    } catch {
      data = null;
    }
    onEvent(kind, data);
  };
  src.addEventListener("stdout", handle("stdout"));
  src.addEventListener("stderr", handle("stderr"));
  src.addEventListener("status", handle("status"));
  src.addEventListener("run_end", (e) => {
    let data = null;
    try {
      data = JSON.parse(e.data);
    } catch {
      data = null;
    }
    onEvent("run_end", data);
    src.close();
    state.source = null;
    refreshRuns();
  });
  src.onerror = () => {
    // EventSource auto-reconnects unless we close it.
  };
}

function onEvent(kind, data) {
  if (!data) return;
  if (kind === "status" && data.event && data.event.status) {
    const s = data.event.status;
    if (s === "succeeded" || s === "failed") {
      state.nodeStatuses.set(data.nodeId, s);
    } else {
      state.nodeStatuses.set(data.nodeId, "running");
    }
    if (state.factoryDetail) drawGraph(state.factoryDetail);
    appendEvent({ ev: "status", text: `[${data.nodeId} iter=${data.iteration}] ${s}` });
    return;
  }
  if (kind === "stdout" || kind === "stderr") {
    const line = data.event?.line ? data.event.line : "";
    appendEvent({
      ev: kind,
      text: `[${data.nodeId} iter=${data.iteration}] ${line}`,
    });
    return;
  }
  if (kind === "run_end") {
    const status = data.status || "?";
    appendEvent({ ev: "end", text: `--- run ended: ${status} ---` });
  }
}

function appendEvent({ ev, text }) {
  const span = document.createElement("span");
  span.className = `ev-${ev}`;
  span.textContent = `${text}\n`;
  els.eventTail.appendChild(span);
  els.eventTail.scrollTop = els.eventTail.scrollHeight;
}

async function refreshRuns() {
  const r = await fetch("/api/runs?limit=20");
  const data = await r.json();
  state.runs = data.runs || [];
  renderRuns();
}

function renderRuns() {
  els.runList.replaceChildren();
  for (const r of state.runs) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : "";
    main.textContent = `${r.factoryId} — ${r.status}`;
    const sub = document.createElement("small");
    sub.textContent = `${r.id.slice(0, 8)} · ${when}`;
    li.appendChild(main);
    li.appendChild(sub);
    li.addEventListener("click", () => openRun(r));
    els.runList.appendChild(li);
  }
}

async function openRun(r) {
  if (r.status === "running") {
    subscribe(r.id);
    return;
  }
  // Terminal — fetch the persisted event log and render it in the tail.
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  els.eventTail.replaceChildren();
  state.activeRunId = r.id;
  state.nodeStatuses.clear();
  if (state.factoryDetail) drawGraph(state.factoryDetail);
  const resp = await fetch(`/api/runs/${encodeURIComponent(r.id)}`);
  if (!resp.ok) {
    appendEvent({ ev: "stderr", text: `failed to load run ${r.id}: ${resp.status}` });
    return;
  }
  const data = await resp.json();
  for (const ev of data.events || []) {
    if (ev.kind === "run_end") {
      appendEvent({
        ev: "end",
        text: `--- run ended: ${ev.result ? ev.result.status : data.status} ---`,
      });
      continue;
    }
    if (ev.kind === "status" && ev.event && ev.event.status) {
      appendEvent({
        ev: "status",
        text: `[${ev.nodeId} iter=${ev.iteration}] ${ev.event.status}`,
      });
      continue;
    }
    if (ev.kind === "stdout" || ev.kind === "stderr") {
      const line = ev.event?.line ? ev.event.line : "";
      appendEvent({
        ev: ev.kind,
        text: `[${ev.nodeId} iter=${ev.iteration}] ${line}`,
      });
    }
  }
}

function drawGraph(factory) {
  const nodes = Object.keys(factory.nodes || {});
  // Routes (ADR 0055) are edges for the viewer, drawn in their own style.
  const edges = [...(factory.edges || []), ...routeEdgesOf(factory.nodes)];
  const layout = layered(nodes, edges);
  const svg = els.graph;
  // Reset SVG.
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.height = `${layout.height}px`;

  // Arrowhead marker.
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrow" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,-5L10,0L0,5" fill="#4a516a" />
    </marker>
    <marker id="arrow-fail" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,-5L10,0L0,5" fill="#b06868" />
    </marker>
    <marker id="arrow-error" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,-5L10,0L0,5" fill="#ffae8a" />
    </marker>
    <marker id="arrow-value" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,-5L10,0L0,5" fill="#7aa2f7" />
    </marker>
    <marker id="arrow-route" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,-5L10,0L0,5" fill="#bb9af7" />
    </marker>`;
  svg.appendChild(defs);

  // A route and an outcome edge between one pair each get their own lane.
  const lanes = edgeLanes(edges);
  edges.forEach((e, i) => {
    const a = layout.pos[e.from];
    const b = layout.pos[e.to];
    if (!a || !b) return;
    const { cls, marker } = edgeStyle(e.when);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", edgePath(a, b, lanes[i]));
    path.setAttribute("marker-end", marker);
    const tooltip = edgeTooltip(e);
    if (tooltip !== null) {
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = tooltip;
      path.appendChild(title);
    }
    svg.appendChild(path);
  });

  for (const id of nodes) {
    const p = layout.pos[id];
    if (!p) continue;
    const node = factory.nodes[id];
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const status = state.nodeStatuses.get(id);
    const cls = ["node-shape"];
    if (status) cls.push(`status-${status}`);
    if (node?.terminal) cls.push("status-terminal");
    rect.setAttribute("class", cls.join(" "));
    rect.setAttribute("x", String(p.x - 50));
    rect.setAttribute("y", String(p.y - 18));
    rect.setAttribute("width", "100");
    rect.setAttribute("height", "36");
    rect.setAttribute("rx", "5");
    g.appendChild(rect);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "node-label");
    label.setAttribute("x", String(p.x));
    label.setAttribute("y", String(p.y + 4));
    label.setAttribute("text-anchor", "middle");
    label.textContent = id;
    g.appendChild(label);

    svg.appendChild(g);
  }
}

refreshFactories();
refreshRuns();
