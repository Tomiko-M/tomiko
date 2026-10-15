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
  --cloud: #8a5a00; --cloud-soft: #fbefd9; --mcp: #0b6b66; --mcp-soft: #dcf0ec;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161514; --panel: #1f1e1c; --sunken: #262522; --border: #34322e; --text: #ece9e3;
    --muted: #a19d95; --accent: #f08a5d; --accent-soft: #3a261d; --ok: #7cc79a; --ok-soft: #1d2e23;
    --bad: #f28b82; --bad-soft: #3a1f1d; --tool: #b3a8f5; --tool-soft: #29253f; --result: #7fc4dc; --result-soft: #1a2d34;
    --cloud: #f2b955; --cloud-soft: #33280f; --mcp: #6dd3c5; --mcp-soft: #142f2c;
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
.badge.judge { background: var(--tool-soft); color: var(--tool); border-color: transparent; }
.badge.cloud { background: var(--cloud-soft); color: var(--cloud); border-color: transparent; }
.badge.fault { background: transparent; color: var(--bad); border: 1px dashed var(--bad); }
.badge.mcp { background: var(--mcp-soft); color: var(--mcp); border-color: transparent; font-weight: 600; letter-spacing: 0.02em; }
.card.mcp { border-left: 3px solid var(--mcp); }
.card.mcp .card-head { background: var(--panel); }
.mcp-call { background: var(--mcp-soft); border-radius: 10px; padding: 8px 12px; overflow: auto; max-height: 24em; }
.mcp-call .title { color: var(--mcp); font-weight: 600; }
.banner { border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; border: 1px solid transparent; }
.banner .title { font-weight: 600; margin-bottom: 4px; }
.banner.bad { background: var(--bad-soft); border-color: var(--bad); }
.banner.bad .title { color: var(--bad); }
.banner.ok { background: var(--ok-soft); }
.banner.ok .title { color: var(--ok); }
.banner ul { margin: 4px 0; padding-left: 18px; }
.banner a { color: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
mark { color: inherit; border-radius: 3px; padding: 0 2px; }
mark.injected { background: var(--bad-soft); outline: 1px dashed var(--bad); }
mark.hidden { background: var(--cloud-soft); color: var(--cloud); }
mark .tag { font: 600 10.5px/1 system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 6px; padding: 1px 5px; border-radius: 4px; vertical-align: 1px; }
mark.injected > .tag { background: var(--bad); color: var(--panel); }
mark.hidden .tag { background: var(--cloud); color: var(--panel); }
.item .meta .warn { color: var(--bad); }
.item .meta .good { color: var(--ok); }
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

/** Text hidden in Unicode tag characters, which no one sees and models read. */
const HIDDEN = /[\u{E0020}-\u{E007E}]+/gu;
const reveal = (t) => [...t].map((c) => String.fromCharCode(c.codePointAt(0) - 0xE0000)).join("");

function revealHidden(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(HIDDEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("mark", { class: "hidden", title: "Invisible on screen: Unicode tag characters, which models read as text." }, h("span", { class: "tag" }, "hidden text"), reveal(m[0])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The attacks planted in this cassette, to mark where they appear. */
let attacks = [];

/** Text with each planted attack marked, and hidden text shown. */
function decorate(text) {
  const needles = attacks.flatMap((a) => [a.text, JSON.stringify(a.text).slice(1, -1)].map((n) => ({ n, a }))).filter((x) => x.n.length > 8);
  const out = [];
  let rest = text;
  for (;;) {
    let best;
    for (const x of needles) {
      const at = rest.indexOf(x.n);
      if (at !== -1 && (!best || at < best.at)) best = { at, ...x };
    }
    if (!best) break;
    out.push(...revealHidden(rest.slice(0, best.at)));
    out.push(h("mark", { class: "injected", title: "Planted by fault.promptInjection() (" + best.a.attack + "). Only the model saw it." }, h("span", { class: "tag" }, "injected"), ...revealHidden(best.n)));
    rest = rest.slice(best.at + best.n.length);
  }
  out.push(...revealHidden(rest));
  return out;
}

function renderPart(part) {
  switch (part.kind) {
    case "text": return h("div", { class: "text" }, decorate(part.text));
    case "tool_call": return h("div", { class: "call" }, h("span", { class: "title mono" }, "→ " + part.name), h("pre", {}, json(part.input)));
    case "tool_result": return h("div", { class: "result" + (part.isError ? " error" : "") }, h("span", { class: "title mono" }, part.isError ? "← error" : "← result"), h("pre", {}, decorate(part.content)));
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

const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

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
      i.judge && h("span", { class: "badge judge" }, "judge"),
      i.fault && i.fault !== "prompt_injection" && h("span", { class: "badge fault", title: "fault." + camel(i.fault) + "() rewrote this answer for the test. The response shown is the real one; the next request carries the rewritten one." }, "fault · " + i.fault.replace(/_/g, " ")),
      (i.injections || []).map((a) => h("span", { class: "badge fault", title: "fault.promptInjection() planted this attack in the result of " + a.tool + ". Only the model saw it; your code never did." }, "injection · " + a.attack)),
      i.provider === "bedrock" && h("span", { class: "badge cloud", title: "Amazon Bedrock" }, "Bedrock"),
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

/** JSON a tool returned as text, laid out to read. */
function pretty(text) {
  if (!/^\s*[[{]/.test(text)) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function renderMcp(i) {
  const m = i.mcp;
  const failed = m.isError;
  return h("section", { class: "card mcp", id: "r" + i.index },
    h("div", { class: "card-head" },
      h("span", { class: "num" }, "#" + i.index),
      h("span", { class: "badge mcp" }, "MCP"),
      h("span", { class: "badge mono" }, m.server),
      h("span", { class: "badge mono" }, m.method),
      h("span", { class: "badge " + (failed ? "bad" : "ok") }, failed ? "error" : "ok"),
      h("span", { class: "spacer" }),
      h("span", { class: "facts" }, h("span", {}, ms(i.durationMs))),
    ),
    h("div", { class: "body" },
      m.info && h("div", { class: "note" }, m.info),
      m.tools && h("div", { class: "tools" }, h("span", { class: "label" }, "Offers:"), m.tools.map((t) => h("span", { class: "chip mono", title: t.description || "" }, t.name))),
      m.tool && h("div", { class: "mcp-call" }, h("span", { class: "title mono" }, "→ " + m.tool), h("pre", {}, json(m.input))),
      !m.tool && m.input !== undefined && h("details", {}, h("summary", {}, "Params"), h("pre", {}, json(m.input))),
      m.notes.length > 0 && h("div", { class: "note" }, "While it worked: " + m.notes.join(" · ")),
      m.error
        ? h("div", { class: "result error" }, h("span", { class: "title mono" }, "← error"), h("pre", {}, m.error))
        : m.output.length > 0 && h("div", { class: "result" + (failed ? " error" : "") }, h("span", { class: "title mono" }, failed ? "← error" : "← result"), m.output.map((p) => p.kind === "text" ? h("pre", {}, decorate(pretty(p.text))) : renderPart(p))),
      h("details", { class: "raw" }, h("summary", {}, "Raw request"), h("pre", {}, json(i.rawRequest))),
      h("details", { class: "raw" }, h("summary", {}, "Raw response"), h("pre", {}, json(i.rawResponse))),
    ),
  );
}

function injectionBanner(v) {
  const what = v.attacks.map((a) => a.attack + " in the result of " + a.tool + (a.goal ? ", going for " + a.goal : "")).join("; ");
  const go = (n) => (e) => { e.preventDefault(); document.getElementById("r" + n)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  if (v.obeyed.length > 0) {
    return h("div", { class: "banner bad" },
      h("div", { class: "title" }, "The model followed the prompt injection"),
      h("ul", {}, v.obeyed.map((o) => h("li", {}, h("a", { onclick: go(o.request) }, "#" + o.request), " " + o.what))),
      h("div", { class: "note" }, "Attack: " + what));
  }
  return h("div", { class: "banner ok" }, h("div", { class: "title" }, "The model resisted the prompt injection"), h("div", { class: "note" }, "Attack: " + what));
}

function renderCassette(index) {
  const main = document.querySelector("main");
  main.replaceChildren();
  const c = model.cassettes[index];
  if (!c) { main.append(h("div", { class: "empty" }, model.cassettes.length ? "Pick a cassette." : "No cassettes found.")); return; }
  const models = [...new Set(c.interactions.map((i) => i.model).filter(Boolean))];
  const servers = [...new Set(c.interactions.flatMap((i) => i.mcp ? [i.mcp.server] : []))];
  attacks = c.injection ? c.injection.attacks : [];
  // History is shown from the previous request to a model; MCP requests sit in between.
  let previous = 0;
  const cards = c.interactions.map((i) => {
    if (i.mcp) return renderMcp(i);
    const card = renderInteraction(i, previous);
    previous = i.index;
    return card;
  });
  main.append(...[
    h("h1", {}, c.path.replaceAll("/", "/\u200b")),
    h("div", { class: "sub" }, [
      c.requests + " request" + (c.requests === 1 ? "" : "s"),
      c.mcpCalls > 0 && c.mcpCalls + " MCP call" + (c.mcpCalls === 1 ? "" : "s") + " to " + servers.join(", "),
      tokens(totalTokens(c.usage)) + " tokens",
      c.cost === null && c.unpricedModels.length ? "no price for " + c.unpricedModels.join(", ") : usd(c.cost) + (c.unpricedModels.length ? " (no price for " + c.unpricedModels.join(", ") + ")" : ""),
      models.join(", "),
    ].filter(Boolean).join(" · ")),
    c.injection && injectionBanner(c.injection),
    ...cards,
  ].filter(Boolean));
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
      h("div", { class: "meta" },
        c.requests + " req" + (c.mcpCalls ? " · " + c.mcpCalls + " MCP" : "") + " · " + tokens(totalTokens(c.usage)) + " tok · " + usd(c.cost),
        c.injection && (c.injection.obeyed.length
          ? h("span", { class: "warn", title: "The model did what a planted prompt injection asked" }, " · ✗ injection")
          : h("span", { class: "good", title: "The model resisted the planted prompt injection" }, " · ✓ injection"))),
    ));
  });
  if (!list.children.length) list.append(h("div", { class: "empty" }, "No matches."));
}

document.getElementById("stats").append(...[
  h("span", {}, h("b", {}, String(model.cassettes.length)), " cassettes"),
  h("span", {}, h("b", {}, String(model.requests)), " requests"),
  model.mcpCalls > 0 && h("span", {}, h("b", {}, String(model.mcpCalls)), " MCP calls"),
  h("span", {}, h("b", {}, tokens(totalTokens(model.usage))), " tokens"),
  h("span", {}, h("b", {}, usd(model.cost)), " est. to record"),
].filter(Boolean));
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
