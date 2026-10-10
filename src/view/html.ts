import type { ViewModel } from "./model.js";

/** JSON that is safe inside a <script> element: nothing in it can close the element. */
function embed(model: ViewModel): string {
  // U+2028 and U+2029 are escaped too: they end lines in older JavaScript parsers.
  return JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

const STYLES = /* css */ `
:root {
  --bg: #f7f7f5; --panel: #ffffff; --sunken: #f0efec; --border: #e3e1dc; --text: #1c1b19;
  --muted: #6b6862; --accent: #b4441f; --accent-soft: #f8e6de; --ok: #2f7a4b; --ok-soft: #e1f1e6;
  --bad: #b3261e; --bad-soft: #fbe3e1; --tool: #5b4bb7; --tool-soft: #ebe8fa; --result: #22667f; --result-soft: #e0f0f5;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161514; --panel: #1f1e1c; --sunken: #262522; --border: #34322e; --text: #ece9e3;
    --muted: #a19d95; --accent: #f08a5d; --accent-soft: #3a261d; --ok: #7cc79a; --ok-soft: #1d2e23;
    --bad: #f28b82; --bad-soft: #3a1f1d; --tool: #b3a8f5; --tool-soft: #29253f; --result: #7fc4dc; --result-soft: #1a2d34;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 2; }
.brand { font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
.brand span { color: var(--accent); }
.stats { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); }
.stats b { color: var(--text); font-weight: 600; }
.layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: calc(100vh - 56px); }
aside { border-right: 1px solid var(--border); background: var(--panel); padding: 12px; position: sticky; top: 56px; height: calc(100vh - 56px); overflow: auto; }
aside input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; margin-bottom: 10px; }
.group { color: var(--muted); font-size: 12px; margin: 12px 4px 4px; overflow-wrap: anywhere; }
.item { display: block; width: 100%; text-align: left; border: 0; background: none; color: inherit; font: inherit; padding: 7px 10px; border-radius: 8px; cursor: pointer; }
.item:hover { background: var(--sunken); }
.item[aria-current="true"] { background: var(--accent-soft); }
.item .name { font-weight: 500; word-break: break-word; }
.item .meta { color: var(--muted); font-size: 12px; }
main { padding: 20px 24px 60px; min-width: 0; }
h1 { font-size: 18px; margin: 0 0 4px; overflow-wrap: anywhere; }
.sub { color: var(--muted); margin-bottom: 18px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
.card-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--sunken); }
.num { font-weight: 700; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--panel); border: 1px solid var(--border); white-space: nowrap; }
.badge.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.badge.bad { background: var(--bad-soft); color: var(--bad); border-color: transparent; }
.spacer { flex: 1; }
.facts { color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.body { padding: 12px 14px; display: grid; gap: 10px; }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; user-select: none; }
details[open] > summary { margin-bottom: 6px; }
.tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tools .label { color: var(--muted); font-size: 13px; }
.chip { font-size: 12px; padding: 1px 8px; border-radius: 6px; background: var(--tool-soft); color: var(--tool); }
.note { color: var(--muted); font-size: 12.5px; font-style: italic; }
.msg { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; }
.role { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding-top: 8px; text-align: right; }
.bubble { display: grid; gap: 6px; min-width: 0; }
.text { white-space: pre-wrap; word-break: break-word; background: var(--sunken); border-radius: 10px; padding: 8px 12px; max-height: 28em; overflow: auto; }
.msg.response .text { background: var(--accent-soft); }
.msg.response .role { color: var(--accent); font-weight: 600; }
.call, .result { border-radius: 10px; padding: 8px 12px; overflow: auto; max-height: 24em; }
.call { background: var(--tool-soft); }
.call .title { color: var(--tool); font-weight: 600; }
.result { background: var(--result-soft); }
.result .title { color: var(--result); font-weight: 600; }
.result.error { background: var(--bad-soft); }
.result.error .title { color: var(--bad); }
pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
.raw pre { background: var(--sunken); border-radius: 8px; padding: 10px; max-height: 32em; overflow: auto; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  aside { position: static; height: auto; max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--border); }
  header { position: static; padding: 12px 16px; }
  main { padding: 16px; }
  .msg { grid-template-columns: 1fr; gap: 2px; }
  .role { text-align: left; padding-top: 0; }
}
`;

const SCRIPT = /* js */ `
const model = JSON.parse(document.getElementById("tomiko-data").textContent);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const tokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
const usd = (n) => n === null || n === undefined ? "no price" : n > 0 && n < 0.0001 ? "<$0.0001" : "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
const ms = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms";
const json = (v) => typeof v === "string" ? v : JSON.stringify(v, null, 2);
const totalTokens = (u) => u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
const baseName = (p) => p.split(/[\\\\/]/).pop().replace(/\\.json$/, "");
const dirName = (p) => { const parts = p.split(/[\\\\/]/); parts.pop(); return parts.join("/") || "."; };

function usageFacts(u, cost) {
  if (!u) return [];
  const facts = [tokens(u.inputTokens) + " in", tokens(u.outputTokens) + " out"];
  if (u.cacheReadTokens) facts.push(tokens(u.cacheReadTokens) + " cache read");
  if (u.cacheWriteTokens) facts.push(tokens(u.cacheWriteTokens) + " cache write");
  facts.push(usd(cost));
  return facts;
}

function renderPart(part) {
  switch (part.kind) {
    case "text": return h("div", { class: "text" }, part.text);
    case "tool_call": return h("div", { class: "call" }, h("span", { class: "title mono" }, "→ " + part.name), h("pre", {}, json(part.input)));
    case "tool_result": return h("div", { class: "result" + (part.isError ? " error" : "") }, h("span", { class: "title mono" }, part.isError ? "← error" : "← result"), h("pre", {}, part.content));
    case "image": return h("div", { class: "note" }, "[image]");
    default: return h("details", {}, h("summary", {}, part.label), h("pre", {}, json(part.value)));
  }
}

function renderMessage(message, extraClass) {
  return h("div", { class: "msg " + (extraClass || "") }, h("div", { class: "role" }, message.role), h("div", { class: "bubble" }, message.parts.map(renderPart)));
}

function earlierNote(i, previousIndex) {
  const parts = [];
  if (i.earlierMessages > 0) parts.push(i.earlierMessages + " earlier message" + (i.earlierMessages === 1 ? "" : "s"));
  if (i.repeatsPreviousResponse) parts.push("the response");
  return "History: " + parts.join(" and ") + " from #" + previousIndex;
}

function renderInteraction(i, previousIndex) {
  const ok = i.status >= 200 && i.status < 300;
  const response = {
    role: "response",
    parts: [
      ...(i.response.text ? [{ kind: "text", text: i.response.text }] : []),
      ...i.response.toolCalls.map((t) => ({ kind: "tool_call", name: t.name, input: t.input })),
    ],
  };
  if (response.parts.length === 0 && !ok) response.parts.push({ kind: "other", label: "error body", value: i.rawResponse });
  return h("section", { class: "card", id: "r" + i.index },
    h("div", { class: "card-head" },
      h("span", { class: "num" }, "#" + i.index),
      i.model && h("span", { class: "badge mono" }, i.model),
      h("span", { class: "badge " + (ok ? "ok" : "bad") }, String(i.status)),
      i.response.streamed && h("span", { class: "badge" }, "stream"),
      i.response.stopReason && h("span", { class: "badge" }, i.response.stopReason),
      h("span", { class: "spacer" }),
      h("span", { class: "facts" }, [...usageFacts(i.usage, i.cost), ms(i.durationMs)].map((f) => h("span", {}, f))),
    ),
    h("div", { class: "body" },
      i.system !== undefined && h("details", {},
        h("summary", {}, i.systemRepeated ? "System prompt (same as #" + previousIndex + ")" : "System prompt"),
        h("div", { class: "text" }, i.system)),
      i.tools.length > 0 && h("div", { class: "tools" }, h("span", { class: "label" }, "Tools:"), i.tools.map((t) => h("span", { class: "chip mono", title: t.description || "" }, t.name))),
      (i.earlierMessages > 0 || i.repeatsPreviousResponse) && h("div", { class: "note" }, earlierNote(i, previousIndex)),
      i.messages.map((m) => renderMessage(m)),
      renderMessage(response, "response"),
      h("details", { class: "raw" }, h("summary", {}, "Raw request"), h("pre", {}, json(i.rawRequest))),
      h("details", { class: "raw" }, h("summary", {}, "Raw response"), h("pre", {}, json(i.rawResponse))),
    ),
  );
}

function renderCassette(index) {
  const main = document.querySelector("main");
  main.replaceChildren();
  const c = model.cassettes[index];
  if (!c) { main.append(h("div", { class: "empty" }, model.cassettes.length ? "Pick a cassette." : "No cassettes found.")); return; }
  const models = [...new Set(c.interactions.map((i) => i.model).filter(Boolean))];
  main.append(
    h("h1", {}, c.path.replaceAll("/", "/\u200b")),
    h("div", { class: "sub" }, [
      c.interactions.length + " request" + (c.interactions.length === 1 ? "" : "s"),
      tokens(totalTokens(c.usage)) + " tokens",
      c.cost === null && c.unpricedModels.length ? "no price for " + c.unpricedModels.join(", ") : usd(c.cost) + (c.unpricedModels.length ? " (no price for " + c.unpricedModels.join(", ") + ")" : ""),
      models.join(", "),
    ].filter(Boolean).join(" · ")),
    ...c.interactions.map((i) => renderInteraction(i, i.index - 1)),
  );
  document.querySelectorAll(".item").forEach((el) => el.setAttribute("aria-current", String(el.dataset.index === String(index))));
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}

function renderList(filter) {
  const list = document.getElementById("list");
  list.replaceChildren();
  const needle = filter.trim().toLowerCase();
  let group = null;
  model.cassettes.forEach((c, index) => {
    if (needle && !c.path.toLowerCase().includes(needle) && !c.interactions.some((i) => (i.model || "").toLowerCase().includes(needle))) return;
    const dir = dirName(c.path);
    if (dir !== group) { group = dir; list.append(h("div", { class: "group mono" }, dir.replaceAll("/", "/\u200b"))); }
    list.append(h("button", { class: "item", "data-index": index, onclick: () => { location.hash = String(index); } },
      h("div", { class: "name" }, baseName(c.path)),
      h("div", { class: "meta" }, c.interactions.length + " req · " + tokens(totalTokens(c.usage)) + " tok · " + usd(c.cost)),
    ));
  });
  if (!list.children.length) list.append(h("div", { class: "empty" }, "No matches."));
}

document.getElementById("stats").append(
  h("span", {}, h("b", {}, String(model.cassettes.length)), " cassettes"),
  h("span", {}, h("b", {}, String(model.requests)), " requests"),
  h("span", {}, h("b", {}, tokens(totalTokens(model.usage))), " tokens"),
  h("span", {}, h("b", {}, usd(model.cost)), " est. to record"),
);
document.getElementById("search").addEventListener("input", (e) => {
  renderList(e.target.value);
  const current = Number(location.hash.slice(1) || 0);
  document.querySelectorAll(".item").forEach((el) => el.setAttribute("aria-current", String(el.dataset.index === String(current))));
});
const show = () => renderCassette(Number(location.hash.slice(1) || 0));
window.addEventListener("hashchange", show);
renderList("");
show();
`;

export function renderHtml(model: ViewModel): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tomiko cassettes</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="brand">tomiko<span>.</span></div>
  <div class="stats" id="stats"></div>
</header>
<div class="layout">
  <aside>
    <input id="search" type="search" placeholder="Filter by path or model" aria-label="Filter cassettes">
    <nav id="list"></nav>
  </aside>
  <main></main>
</div>
<script id="tomiko-data" type="application/json">${embed(model)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
