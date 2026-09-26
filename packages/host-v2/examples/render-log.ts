import { resolve, dirname, basename } from "node:path"
import { writeFile } from "node:fs/promises"
import { Schema } from "effect"
import { AgentInput } from "@clavia/tardigrade-agent-v2"

const Run = Schema.Struct({ status: Schema.String, message: Schema.String, events: Schema.Array(AgentInput), stream: Schema.optionalKey(Schema.String) })
const [source = ".tardigrade/research-robots.json", target = source.replace(/\.json$/, "") + ".html"] = process.argv.slice(2)
const raw = await Bun.file(source).json()
const run = Schema.decodeUnknownSync(Run)(raw)
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
const cost = run.events.reduce((sum, event) => sum + (event.type === "ModelReturned" ? event.reply.cost : 0), 0)
const count = (type: string) => run.events.filter(event => event.type === type).length
const rows = run.events.map((event, index) => {
  const label = "name" in event ? event.name : "callId" in event ? event.callId : event.type === "MessageReceived" ? event.turnId : ""
  const note = event.type === "ModelReturned" ? "$" + event.reply.cost.toFixed(6)
    : event.type === "PermissionResolved" ? event.decision.allowed ? "Allowed" : "Denied"
    : event.type === "ToolReturned" ? event.error === null ? "Returned" : "Error" : ""
  return '<details data-search="' + escape(event.type + " " + label) + '"><summary><span class="index">' + String(index + 1).padStart(2, "0") + '</span><strong>' + event.type + '</strong><span class="label">' + escape(label) + '</span><span class="note">' + escape(note) + '</span></summary><pre>' + escape(JSON.stringify(event, null, 2)) + '</pre></details>'
}).join("")
const jsonName = basename(target).replace(/\.html$/, "") + ".json"
await writeFile(resolve(dirname(target), jsonName), JSON.stringify(raw, null, 2))
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research · Event log</title><style>' +
'*{box-sizing:border-box}html{color-scheme:dark;background:#11151c;color:#edf0f5;font-family:system-ui,sans-serif}body{max-width:1180px;margin:auto;padding:40px 28px}header{border-bottom:1px solid #303846;padding-bottom:24px}.eyebrow{color:#8fa3ff;font:11px ui-monospace,monospace;letter-spacing:.14em}h1{font-size:30px;font-weight:500;letter-spacing:-.04em;margin:12px 0}.meta{color:#abb4c2;font-size:13px;line-height:1.8}.status{color:#96c7ac}h2{font-size:13px;font-weight:500;color:#abb4c2;margin:28px 0 12px}.answer{white-space:pre-wrap;font-size:14px;line-height:1.8;max-width:95ch}nav{display:flex;gap:8px;flex-wrap:wrap;margin:28px 0 18px}button,input,a{font:12px system-ui;color:#abb4c2}button,input{background:#181d26;border:1px solid #303846;padding:8px 12px;border-radius:3px}input{flex:1;min-width:160px}a{color:#8fa3ff;align-self:center;padding:8px}details{border-top:1px solid #303846}details:last-child{border-bottom:1px solid #303846}summary{display:flex;align-items:center;gap:16px;padding:15px 0;cursor:pointer;font:12px ui-monospace,monospace;list-style:none}summary::-webkit-details-marker{display:none}summary:before{content:"+";color:#818da0;width:10px}details[open] summary:before{content:"−"}.index{color:#818da0}strong{font-weight:500;min-width:165px}.label{color:#abb4c2;overflow-wrap:anywhere}.note{margin-left:auto;color:#96c7ac}pre{background:#0d1117;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;margin:0 0 16px}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #8fa3ff;outline-offset:3px}[hidden]{display:none}@media(max-width:650px){body{padding:24px 16px}summary{gap:8px;flex-wrap:wrap}.label{flex-basis:100%;padding-left:38px}strong{min-width:0}}' +
'</style></head><body><header><div class="eyebrow">TARDIGRADE / ACTOR V2</div><h1>Research event log</h1><div class="meta"><span class="status">' + escape(run.status) + '</span> · ' + escape(run.stream ?? "actor") + ' · ' + run.events.length + ' events<br>' + count("ModelCalled") + ' model calls · ' + count("ToolCalled") + ' tool calls · $' + cost.toFixed(6) + ' recorded inference cost<br>Append order; no timestamps recorded.</div></header><h2>ANSWER</h2><div class="answer">' + escape(run.message) + '</div><nav><button id="expand">Expand all</button><button id="collapse">Collapse all</button><input id="filter" aria-label="Filter events" placeholder="Filter by event or call ID"><a href="' + escape(jsonName) + '" download>Download JSON</a></nav><main>' + rows + '</main><script>' +
'const rows=[...document.querySelectorAll("details")];document.getElementById("expand").onclick=()=>rows.filter(r=>!r.hidden).forEach(r=>r.open=true);document.getElementById("collapse").onclick=()=>rows.forEach(r=>r.open=false);document.getElementById("filter").oninput=e=>rows.forEach(r=>r.hidden=!r.dataset.search.toLowerCase().includes(e.target.value.toLowerCase()));' +
'</script></body></html>'
await writeFile(target, html)
console.log(resolve(target))
