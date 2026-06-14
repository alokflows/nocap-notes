/**
 * LLM-Wiki — a personal, honest notes assistant that lives inside Telegram and chats like ChatGPT.
 *
 *   Telegram ─► Cloudflare Worker (instant 200, no retries) ─► this Apps Script web app ─► Drive
 *
 * KNOWLEDGE MODEL
 *   archives/  raw text you send, saved verbatim & NEVER edited (the immutable source of truth)
 *   wiki/      clean, structured pages the bot writes/curates from what it understands
 *   trash/     soft-deleted wiki pages (recover or purge from the menu)
 *
 * DESIGN
 *   • LLM: provider+key fallback chain — every Groq key, then every Gemini key, then Cerebras.
 *   • Web: groq/compound-mini browses the live web when the notes don't hold the answer.
 *   • Honesty: the bot acts only through verified tools and never claims an action that didn't happen.
 *   • Voice: plain, warm, ChatGPT-like — no meta-commentary, no raw file paths unless asked.
 *   • Secrets (bot token, API keys, webhook secret) live in Script Properties, never in this source.
 */

// ============ NON-SECRET CONFIG ============
var GEMINI_MODEL  = "gemini-2.5-flash";
var TIMEZONE      = "Asia/Kolkata";
var MAX_STEPS     = 7;     // hard cap on tool-loop turns per message
var TRASH_DAYS    = 30;    // default trash retention (overridable in Settings)
var HISTORY_TURNS = 12;    // default short-term memory entries (~6 exchanges)
var SYSTEM_DOCS   = ["index.md", "log.md", "reminders.md", "_lint-report.md", "bot-identity.md"];
// ===========================================

// ---- Script Properties ----
function getProp(k)    { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function delProp(k)    { PropertiesService.getScriptProperties().deleteProperty(k); }
function cfg(k, def)   { var v = getProp(k); return (v === null || v === undefined) ? def : v; }

// ---- Secrets (from Script Properties, loaded each execution) ----
var BOT_TOKEN      = getProp("BOT_TOKEN");
var USER_ID        = getProp("USER_ID");
var WEBHOOK_SECRET = getProp("WEBHOOK_SECRET");
var TG_SECRET      = getProp("TG_SECRET");
var RELAY_URL      = getProp("RELAY_URL");

function getKeys(p)     { try { var a = JSON.parse(getProp(p) || "[]"); return Array.isArray(a) ? a.filter(Boolean) : []; } catch(e) { return []; } }
function groqKeys()     { return getKeys("GROQ_KEYS"); }
function geminiKeys()   { return getKeys("GEMINI_KEYS"); }
function cerebrasKeys() { return getKeys("CEREBRAS_KEYS"); }
function addKey(p, key) { var a = getKeys(p); if (a.indexOf(key) < 0) a.push(key); setProp(p, JSON.stringify(a)); return a.length; }

// ---- Telegram ----
function tg(method, payload) {
  return UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method,
    {method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true});
}
function mdToHtml(s) {
  s = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/```([\s\S]*?)```/g, "<pre>$1</pre>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>").replace(/^\s*[-*]\s+/gm, "• ");
  return s;
}
function say(text) {
  var res = tg("sendMessage", {chat_id: USER_ID, text: mdToHtml(text), parse_mode: "HTML", disable_web_page_preview: true});
  if (res.getResponseCode() !== 200) tg("sendMessage", {chat_id: USER_ID, text: String(text)});
}
function typing() { tg("sendChatAction", {chat_id: USER_ID, action: "typing"}); }
function sendDocument(blob, caption) {
  UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendDocument",
    {method: "post", muteHttpExceptions: true, payload: {chat_id: USER_ID, caption: caption || "", document: blob}});
}

// ================= MULTI-PROVIDER / MULTI-KEY LLM =================
function groqModel() { return getProp("GROQ_MODEL") || "openai/gpt-oss-120b"; }
function modelLabel() {
  if ((getProp("PRIMARY") || "groq") === "gemini") return "Gemini first";
  return groqModel().indexOf("20b") >= 0 ? "Groq 20B" : "Groq 120B";
}
function providerChain() {
  var groq = groqKeys().map(function(k) { return {provider: "groq", key: k, model: groqModel()}; });
  var gem  = geminiKeys().map(function(k) { return {provider: "gemini", key: k, model: GEMINI_MODEL}; });
  var cer  = cerebrasKeys().map(function(k) { return {provider: "cerebras", key: k, model: "llama-3.3-70b"}; });
  return (getProp("PRIMARY") || "groq") === "gemini" ? gem.concat(groq, cer) : groq.concat(gem, cer);
}
function toGemini(msgs) {
  return msgs.map(function(m) {
    if (m.role === "user") return {role: "user", parts: [{text: m.text}]};
    if (m.role === "assistant" && m.calls) return {role: "model", parts: m.calls.map(function(c) { var fc = {functionCall: {name: c.name, args: c.args || {}}}; if (c.id) fc.functionCall.id = c.id; return fc; })};
    if (m.role === "assistant") return {role: "model", parts: [{text: m.text}]};
    var fr = {functionResponse: {name: m.name, response: m.result}}; if (m.id) fr.functionResponse.id = m.id; return {role: "user", parts: [fr]};
  });
}
function toOpenAI(system, msgs) {
  var out = [{role: "system", content: system}];
  msgs.forEach(function(m) {
    if (m.role === "user") out.push({role: "user", content: m.text});
    else if (m.role === "assistant" && m.calls) out.push({role: "assistant", content: "", tool_calls: m.calls.map(function(c) { return {id: c.id, type: "function", function: {name: c.name, arguments: JSON.stringify(c.args || {})}}; })});
    else if (m.role === "assistant") out.push({role: "assistant", content: m.text});
    else out.push({role: "tool", tool_call_id: m.id, content: JSON.stringify(m.result)});
  });
  return out;
}
function callGemini(system, msgs, tools, model, key) {
  var body = {systemInstruction: {parts: [{text: system}]}, contents: toGemini(msgs)};
  if (tools) { body.tools = [{functionDeclarations: tools}]; body.toolConfig = {functionCallingConfig: {mode: "AUTO"}}; }
  var res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key,
    {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
  var code = res.getResponseCode();
  if (code === 429) return {error: "quota"};
  if (code !== 200) { console.error("gemini", code, res.getContentText().slice(0, 200)); return {error: "http"}; }
  try {
    var parts = JSON.parse(res.getContentText()).candidates[0].content.parts || [], calls = [], text = "";
    parts.forEach(function(p) { if (p.functionCall) calls.push({id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {}}); else if (p.text) text += p.text; });
    return {text: text.trim(), calls: calls};
  } catch(e) { return {error: "parse"}; }
}
function callOpenAI(provider, model, system, msgs, tools, key) {
  var url = provider === "cerebras" ? "https://api.cerebras.ai/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions";
  var body = {model: model, messages: toOpenAI(system, msgs), temperature: 0.3};
  if (tools) { body.tools = tools.map(function(t) { return {type: "function", function: {name: t.name, description: t.description, parameters: t.parameters}}; }); body.tool_choice = "auto"; }
  var res = UrlFetchApp.fetch(url, {method: "post", contentType: "application/json", headers: {Authorization: "Bearer " + key}, payload: JSON.stringify(body), muteHttpExceptions: true});
  var code = res.getResponseCode();
  if (code === 429) return {error: "quota"};
  if (code !== 200) { console.error(provider, code, res.getContentText().slice(0, 200)); return {error: "http"}; }
  try {
    var msg = JSON.parse(res.getContentText()).choices[0].message, calls = [];
    if (msg.tool_calls) msg.tool_calls.forEach(function(tc) { var a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch(e) {} calls.push({id: tc.id, name: tc.function.name, args: a}); });
    return {text: (msg.content || "").trim(), calls: calls};
  } catch(e) { return {error: "parse"}; }
}
function llmChain(system, msgs, tools, exhausted) {
  var chain = providerChain();
  for (var i = 0; i < chain.length; i++) {
    var c = chain[i];
    if (exhausted[c.key]) continue;
    var out = c.provider === "gemini" ? callGemini(system, msgs, tools, c.model, c.key) : callOpenAI(c.provider, c.model, system, msgs, tools, c.key);
    if (!out.error) return out;
    if (out.error === "quota") exhausted[c.key] = true;
  }
  return {error: "exhausted"};
}
function callText(system, user) {
  var chain = providerChain(), msgs = [{role: "user", text: user}];
  for (var i = 0; i < chain.length; i++) { var c = chain[i]; var out = c.provider === "gemini" ? callGemini(system, msgs, null, c.model, c.key) : callOpenAI(c.provider, c.model, system, msgs, null, c.key); if (!out.error) return out.text; }
  return "";
}

// ---- Drive helpers ----
function getFolder(parent, name) { var it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); }
function writeFile(folder, name, content) { var it = folder.getFilesByName(name); if (it.hasNext()) { var f = it.next(); f.setContent(content); return f; } return folder.createFile(name, content, MimeType.PLAIN_TEXT); }
function readFile(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next().getBlob().getDataAsString() : ""; }
function stripFences(s) { s = (s || "").trim(); if (s.startsWith("```json")) s = s.slice(7); else if (s.startsWith("```")) s = s.slice(3); if (s.endsWith("```")) s = s.slice(0, -3); return s.trim(); }
function getRoot()     { return DriveApp.getFolderById(getProp("WIKI_ROOT_ID")); }
function getArchives() { return getFolder(getRoot(), "archives"); }
function getWiki()     { return getFolder(getRoot(), "wiki"); }
function getTrash()    { return getFolder(getRoot(), "trash"); }
function isWikiDoc(n)  { return n.endsWith(".md") && SYSTEM_DOCS.indexOf(n) < 0; }
function wikiFiles()   { var out = [], it = getWiki().getFiles(); while (it.hasNext()) { var f = it.next(); if (isWikiDoc(f.getName())) out.push(f); } return out; }
function botIdentity() { return readFile(getWiki(), "bot-identity.md") || "Name: Aria\nDescription: a sharp, warm personal notes assistant."; }

// ---- Conversation memory ----
function memTurns()  { return Number(cfg("MEM_TURNS", Math.floor(HISTORY_TURNS / 2))); }
function getHistory() { try { return JSON.parse(getProp("HISTORY") || "[]"); } catch(e) { return []; } }
function pushHistory(role, text) { var h = getHistory(); h.push({role: role, text: String(text)}); var max = memTurns() * 2; if (h.length > max) h = h.slice(h.length - max); setProp("HISTORY", JSON.stringify(h)); }

// ---- Compact index of the structured wiki (internal context only) ----
// Lean index: page NAMES only (no body reads) — tiny token cost, scales to thousands of notes.
// The agent pulls actual content on demand via search/read.
function buildIndex() {
  var names = wikiFiles().map(function(f) { return f.getName().replace(/\.md$/, ""); });
  if (!names.length) return "(none yet)";
  return names.slice(0, 60).join(", ") + (names.length > 60 ? " …(+" + (names.length - 60) + " more)" : "");
}

// ================= TOOLS (deterministic; results cannot be faked) =================
function tool_search(query) {
  var terms = String(query || "").toLowerCase().split(/\s+/).filter(function(t) { return t.length >= 2; }), hits = [];
  wikiFiles().forEach(function(f) {
    var c = f.getBlob().getDataAsString(), lc = c.toLowerCase(), n = f.getName().toLowerCase(), score = 0, at = -1;
    terms.forEach(function(t) { var i = lc.indexOf(t); if (i >= 0 || n.indexOf(t) >= 0) { score++; if (at < 0 && i >= 0) at = i; } });
    if (!terms.length || score) { var s = Math.max(0, (at < 0 ? 0 : at) - 40); hits.push({file: f.getName(), score: score, snippet: c.slice(s, s + 200).replace(/\n/g, " ")}); }
  });
  hits.sort(function(a, b) { return b.score - a.score; });
  return {matches: hits.slice(0, 8)};
}
function tool_read(file) { var c = readFile(getWiki(), file); return c ? {file: file, content: c} : {error: "no page named '" + file + "'"}; }
function tool_write(file, content) {
  var name = String(file).replace(/^wiki\//, ""); if (!name.endsWith(".md")) name += ".md";
  content = String(content || ""); writeFile(getWiki(), name, content);
  return {ok: readFile(getWiki(), name) === content, file: name};
}
function tool_trash(file) {
  var name = String(file).replace(/^wiki\//, ""); if (!name.endsWith(".md")) name += ".md";
  var it = getWiki().getFilesByName(name);
  if (!it.hasNext()) return {ok: false, error: "no page named '" + name + "'"};
  var f = it.next(); f.setName("del-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd") + "__" + name); f.moveTo(getTrash());
  return {ok: !getWiki().getFilesByName(name).hasNext(), verified_gone: !getWiki().getFilesByName(name).hasNext(), file: name};
}
// ---- Reminder engine: structured store + proactive 1-minute watchdog ----
function loadRem() { try { return JSON.parse(getProp("REMINDERS") || "[]"); } catch(e) { return []; } }
function saveRem(a) { setProp("REMINDERS", JSON.stringify(a)); }
function fmtAt(ms)  { return Utilities.formatDate(new Date(ms), TIMEZONE, "MMM d, HH:mm"); }
function tool_setReminder(when, task, lead, in_minutes) {
  var now = Date.now(), at, hasTime;
  if (in_minutes != null && in_minutes !== "" && !isNaN(Number(in_minutes))) {
    at = now + Math.round(Number(in_minutes)) * 6e4; hasTime = true;       // relative: "in 3 min", "in 2 hours"
  } else {
    var w = String(when || "").trim(); hasTime = /\d{1,2}:\d{2}/.test(w);
    var d; try { d = Utilities.parseDate(w, TIMEZONE, hasTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd"); } catch(e) { d = null; }
    if (!d || isNaN(d.getTime())) return {ok: false, error: "need a time — pass in_minutes for relative, or when as YYYY-MM-DD HH:mm"};
    at = hasTime ? d.getTime() : d.getTime() + 9 * 36e5;                    // all-day → 9am
  }
  // lead = minutes before to pre-alert, from the user ("half an hour before"→30, "on time only"→0; default 10).
  var pre = hasTime ? (lead == null || lead === "" ? 10 : Math.max(0, Math.round(Number(lead)) || 0)) : 0;
  if (pre * 6e4 >= at - now) pre = 0;                                       // too soon for a pre-alert → just fire on time
  var ev = {id: String(now) + Math.floor(Math.random() * 1e4), at: at, text: String(task || "reminder"), pre: pre, firedPre: false, firedDue: false};
  var list = loadRem(); list.push(ev); saveRem(list);
  return {ok: true, when: fmtAt(at), task: ev.text, alerts: pre ? pre + " min before + on time" : "on time only"};
}
// Runs every minute; fires due reminders and messages the user proactively.
function checkReminders() {
  var now = Date.now(), list = loadRem(), changed = false;
  list.forEach(function(e) {
    if (e.pre > 0 && !e.firedPre && now >= e.at - e.pre * 6e4 && now < e.at) { say("⏰ Coming up at " + Utilities.formatDate(new Date(e.at), TIMEZONE, "HH:mm") + " — " + e.text); e.firedPre = true; changed = true; }
    if (!e.firedDue && now >= e.at) { say("⏰ Now — " + e.text); e.firedDue = true; changed = true; }
  });
  var kept = list.filter(function(e) { return !e.firedDue; }); // a reminder is removed the moment it fires
  if (changed || kept.length !== list.length) saveRem(kept);
}
// Proactive morning briefing: each morning, surface what's on the plate today (the "Jarvis" touch).
function morningBriefing() {
  var now = Date.now(), end = now + 17 * 36e5;
  var today = loadRem().filter(function(e) { return !e.firedDue && e.at >= now && e.at <= end; }).sort(function(a, b) { return a.at - b.at; });
  if (!today.length) return;
  var lines = today.map(function(e) { return "• " + Utilities.formatDate(new Date(e.at), TIMEZONE, "HH:mm") + " — " + e.text; });
  say("☀️ Good morning! Here's your day:\n" + lines.join("\n"));
}
function tool_web(query) {
  var keys = groqKeys();
  for (var i = 0; i < keys.length; i++) {
    var out = callOpenAI("groq", "groq/compound-mini", "Research the query using current web information. Be concise and list the source URLs you used.", [{role: "user", text: String(query || "")}], null, keys[i]);
    if (!out.error) return {result: out.text};
  }
  return {error: "web search unavailable"};
}
var TOOLS = [
  {name: "search", description: "Search the user's saved notes by keyword. Use FIRST to answer questions or before editing/deleting.",
   parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}},
  {name: "read", description: "Read one note page's full content by name.",
   parameters: {type: "object", properties: {file: {type: "string"}}, required: ["file"]}},
  {name: "write", description: "Create or update a clean, well-titled note page (complete content). Use to record/structure what the user shares, or to rewrite a page without a removed fact.",
   parameters: {type: "object", properties: {file: {type: "string", description: "short page name e.g. profile.md"}, content: {type: "string"}}, required: ["file", "content"]}},
  {name: "trash", description: "Soft-delete a whole note page (recoverable). Verifies it is gone.",
   parameters: {type: "object", properties: {file: {type: "string"}}, required: ["file"]}},
  {name: "set_reminder", description: "Schedule a reminder/meeting. For relative timing ('in 3 minutes','in 2 hours','after 30 min') pass in_minutes. For a clock time or day ('today 3pm','tomorrow','Monday 9am') pass when as 'YYYY-MM-DD HH:mm' (use the current time given in the prompt to compute it). Never ask the user for an exact timestamp — you have the current time, just compute it.",
   parameters: {type: "object", properties: {when: {type: "string", description: "YYYY-MM-DD HH:mm (or YYYY-MM-DD for all-day)"}, in_minutes: {type: "integer", description: "minutes from now, for relative reminders ('in 3 min'→3, 'in 2 hours'→120)"}, task: {type: "string"}, lead_minutes: {type: "integer", description: "advance pre-alert in minutes from the user: 'half an hour before'→30, 'on time only'→0. Default 10."}}, required: ["task"]}},
  {name: "web_search", description: "Search the live internet when the notes don't have the answer and the question is factual or about the world/current events. Returns a researched answer with sources.",
   parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}}
];
function dispatchTool(name, args) {
  args = args || {};
  switch (name) {
    case "search":       return tool_search(args.query);
    case "read":         return tool_read(args.file);
    case "write":        return tool_write(args.file, args.content);
    case "trash":        return tool_trash(args.file);
    case "set_reminder": return tool_setReminder(args.when, args.task, args.lead_minutes, args.in_minutes);
    case "web_search":   return tool_web(args.query);
    default:             return {error: "unknown tool " + name};
  }
}

// ================= AGENT LOOP =================
function buildSystemPrompt() {
  return "You are " + botIdentity() + " Chat like ChatGPT: plain, warm, brief.\n" +
    "Rules: Never mention being an AI, your tools, files, paths or limits — just answer. " +
    "Never show note names/paths/'sources' unless the user says 'show references'. " +
    "Answer from the user's notes via search/read; if they lack a factual or current answer, web_search and weave it in (cite web links). " +
    "When the user shares info, save it as a tidy well-titled page (ask first only if truly unclear). To forget something, trash its page or rewrite without that fact. " +
    "Reminders/meetings → set_reminder. For 'in N minutes/hours' use in_minutes; for a clock time/day compute when ('YYYY-MM-DD HH:mm') from the current time below — NEVER ask the user for an exact timestamp. Set lead_minutes from their words ('half an hour before'→30, 'on time only'→0; default 10). If they share a plan/intention for a future time, set a reminder so it resurfaces — be proactive. " +
    "Only claim an action if its tool returned ok this turn — never bluff 'Done'; if something fails, say so in one short sentence.\n" +
    "Current time: " + Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm") + " (" + TIMEZONE + "). Note pages: " + buildIndex();
}
function runAgent(text, m, archiveName) {
  var sys = buildSystemPrompt(), msgs = [];
  getHistory().forEach(function(h) { msgs.push({role: h.role === "model" ? "assistant" : "user", text: h.text}); });
  msgs.push({role: "user", text: text});
  var finalReply = "", exhausted = {};
  for (var step = 0; step < MAX_STEPS; step++) {
    typing();
    var out = llmChain(sys, msgs, TOOLS, exhausted);
    if (out.error === "exhausted") { say("My AI keys are all at their free-tier limit right now, so I can't think this through yet — but your message is safely saved and I'll organize it automatically once a key frees up. Tip: add another key in the menu → Settings → ➕ Add API key."); return; }
    if (!out.calls || !out.calls.length) { finalReply = out.text || "Done."; break; }
    msgs.push({role: "assistant", calls: out.calls});
    out.calls.forEach(function(c) { var r; try { r = dispatchTool(c.name, c.args); } catch(e) { r = {error: e.message}; } msgs.push({role: "tool", id: c.id, name: c.name, result: r}); });
  }
  if (!finalReply) finalReply = "Hmm, I couldn't quite finish that — mind rephrasing?";
  say(finalReply);
  pushHistory("user", text); pushHistory("model", finalReply);
  if (archiveName) setProp("LAST_ORG", archiveName); // this message was handled live; organizer can skip it
}

// Benchmark-only: run the agent and RETURN the reply text (no Telegram send). Used by the eval endpoint.
// TEMP benchmark helper — returns reply text (no Telegram send); stripped before final commit.
// ================= MESSAGE ROUTING =================
function handleMessage(m) {
  if (!m || !m.from || String(m.from.id) !== String(USER_ID)) return;
  if (!m.text) { say("I can only read text for now."); return; }
  var t = m.text.trim(), tl = t.toLowerCase();
  if (getProp("AWAIT_KEY") === "1")      { handleKeyInput(t, m); return; }
  if (getProp("AWAIT_IDENTITY") === "1") { delProp("AWAIT_IDENTITY"); writeFile(getWiki(), "bot-identity.md", t); say("Done — I'm " + t.split("\n")[0] + " now. 👋"); return; }
  if (t.charAt(0) === "/")  { handleCommand(t); return; }
  if (tl === "menu")        { sendMainMenu(); return; }
  if (tl === "settings")    { sendMenuTracked("⚙️ Settings", settingsRows()); return; }
  typing();
  var archiveName = captureRaw(m, t);   // immutable raw save — nothing is ever lost
  if (isBulk(t)) { handleBulk(t, archiveName); return; }
  runAgent(t, m, archiveName);
}
// A long list is processed deterministically in small chunks (reliable at any size) and the bot
// reports the REAL counts — never a bluffed "Done".
function isBulk(t) {
  var lines = t.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length >= 8) return true;
  return lines.filter(function(l) { return /^\s*(\d+[.)]|[-*•])\s+/.test(l); }).length >= 6;
}
// Deterministically pull list items out of the message (so the count is always exact).
function extractItems(text) {
  var items = [];
  text.split("\n").forEach(function(l) { var m = l.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/); if (m) items.push(m[1].trim()); });
  if (items.length < 3) items = text.split("\n").map(function(l) { return l.trim(); })
    .filter(function(l) { return l && !/^(please|organize|here (is|are)|process|following|categor)/i.test(l) && !/:$/.test(l); });
  return items;
}
function bulkOrganize(text, archiveName) {
  var items = extractItems(text), cats = {}, uncat = 0;
  for (var i = 0; i < items.length; i += 25) {
    typing();
    var group = items.slice(i, i + 25);
    // Feed the categories chosen so far so later chunks REUSE them (consistent, non-fragmented buckets).
    var existing = Object.keys(cats).filter(function(c) { return c !== "Uncategorized"; });
    var hint = existing.length ? " Reuse these existing categories whenever an item fits; only invent a new one if none fits: " + existing.join(", ") + "." : "";
    var res = callText("Group these items into broad categories (5-8 total across the whole list)." + hint + " Return STRICT JSON only: {\"categories\":{\"<Category>\":[\"item\",...]}}", group.join("\n"));
    var parsed = null; if (res) try { parsed = JSON.parse(stripFences(res)).categories; } catch(e) {}
    if (parsed && Object.keys(parsed).length) Object.keys(parsed).forEach(function(k) { cats[k] = (cats[k] || []).concat(parsed[k]); });
    else { cats["Uncategorized"] = (cats["Uncategorized"] || []).concat(group); uncat += group.length; }  // nothing is ever dropped
  }
  var names = Object.keys(cats);
  names.forEach(function(cat) {
    var name = cat.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".md";
    var prev = readFile(getWiki(), name), body = cats[cat].map(function(x) { return "- " + x; }).join("\n");
    writeFile(getWiki(), name, prev ? prev + "\n" + body : "# " + cat + "\n" + body);
  });
  if (archiveName) setProp("LAST_ORG", archiveName);
  return {total: items.length, names: names, uncat: uncat};
}
function handleBulk(text, archiveName) {
  var r = bulkOrganize(text, archiveName);
  if (!r.total) { runAgent(text, null, archiveName); return; }   // not really a list — let the agent handle it
  var msg = "✅ Saved all " + r.total + " items into " + r.names.length + " categories: " + r.names.join(", ") + ".";
  if (r.uncat) msg += "\n(" + r.uncat + " couldn't be auto-sorted — saved under Uncategorized; my AI was busy.)";
  say(msg);
}
function handleKeyInput(t, m) {
  delProp("AWAIT_KEY");
  var prop = t.indexOf("gsk_") === 0 ? "GROQ_KEYS" : (t.indexOf("AIza") === 0 || t.indexOf("AQ.") === 0) ? "GEMINI_KEYS" : t.indexOf("csk-") === 0 ? "CEREBRAS_KEYS" : null;
  if (!prop) { say("That doesn't look like an API key. Open the menu → Settings → ➕ Add API key to try again."); return; }
  var n = addKey(prop, t), label = prop === "GROQ_KEYS" ? "Groq" : prop === "GEMINI_KEYS" ? "Gemini" : "Cerebras";
  try { tg("deleteMessage", {chat_id: USER_ID, message_id: m.message_id}); } catch(e) {}
  say("✅ Added a " + label + " key — you now have " + n + ". (I removed your message so the key isn't left in the chat.)");
}
function handleCommand(t) {
  var cmd = t.substring(1).split(" ")[0].toLowerCase();
  if      (cmd === "menu" || cmd === "start") sendMainMenu();
  else if (cmd === "organize") say(organizeWiki() ? "Tidied up your notes." : "Nothing new to tidy.");
  else if (cmd === "audit")    lintWiki();
  else if (cmd === "reset")    { delProp("HISTORY"); say("Fresh start — memory cleared."); }
  else if (cmd === "help")     say("Just talk to me naturally. Tap the menu for notes, trash, identity and settings.");
  else sendMainMenu();
}

// ================= MENU ENGINE (inline keyboards — 0 AI cost, one click) =================
function btn(text, data)          { return {text: text, callback_data: data}; }
function kb(rows)                 { return {inline_keyboard: rows}; }
function editMenu(cq, text, rows) { tg("editMessageText", {chat_id: USER_ID, message_id: cq.message.message_id, text: text, reply_markup: kb(rows)}); }
function ackCb(cq)                { tg("answerCallbackQuery", {callback_query_id: cq.id}); }
function sendMenuTracked(text, rows) {
  var prev = getProp("MENU_MSG");
  if (prev) tg("deleteMessage", {chat_id: USER_ID, message_id: Number(prev)});
  var res = tg("sendMessage", {chat_id: USER_ID, text: text, reply_markup: kb(rows)});
  try { setProp("MENU_MSG", String(JSON.parse(res.getContentText()).result.message_id)); } catch(e) {}
}
function closeMenu(cq) { tg("deleteMessage", {chat_id: USER_ID, message_id: cq.message.message_id}); delProp("MENU_MSG"); }
function mainMenuRows() {
  return [[btn("📒  My Notes", "m:notes")], [btn("📅  Reminders", "m:rem")], [btn("🗑  Trash", "m:trash")],
          [btn("🪪  Identity", "m:id")], [btn("⚙️  Settings", "m:set")], [btn("✖  Close", "x")]];
}
function showReminders(cq) {
  var list = loadRem().filter(function(e) { return !e.firedDue; }).sort(function(a, b) { return a.at - b.at; });
  var rows = list.slice(0, 10).map(function(e) { return [btn("⏰ " + fmtAt(e.at) + " · " + e.text.slice(0, 18), "noop"), btn("❌", "rmdel:" + e.id)]; });
  rows.push([btn("⬅ Menu", "m:main"), btn("❌ Close", "x")]);
  editMenu(cq, list.length ? "📅 Upcoming reminders:" : "📅 No upcoming reminders.\nJust say e.g. “remind me to call mom at 6pm”.", rows);
}
function sendMainMenu() { sendMenuTracked("🏠 Menu", mainMenuRows()); }
function title(name, content) {
  var lines = (content || "").split("\n"), t = name.replace(/\.md$/, "");
  for (var i = 0; i < lines.length; i++) { var l = lines[i].trim(); if (l && l.indexOf("from:") !== 0 && l.indexOf("date:") !== 0 && l !== "---") { t = l.replace(/^#+\s*/, ""); break; } }
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}
// Notes: each row is one note with inline title / send / delete — no extra navigation.
function showNotes(cq) {
  var files = wikiFiles().slice(0, 8), rows = [];
  files.forEach(function(f) {
    var id = f.getId();
    rows.push([btn("📄  " + title(f.getName(), f.getBlob().getDataAsString()), "vw:" + id)]);
    rows.push([btn("📤  Send", "snd:" + id), btn("🗑  Delete", "del:" + id)]);
  });
  rows.push([btn("⬅  Menu", "m:main"), btn("✖  Close", "x")]);
  editMenu(cq, files.length ? "📒 Your notes — tap a title to read:" : "📒 Nothing saved yet — just send me a note!", rows);
}
function showNoteText(cq, id) {
  var f; try { f = DriveApp.getFileById(id); } catch(e) { showNotes(cq); return; }
  var c = f.getBlob().getDataAsString();
  editMenu(cq, title(f.getName(), c) + "\n\n" + (c.length > 1200 ? c.slice(0, 1200) + "\n…" : c),
    [[btn("📤 Send file", "snd:" + id), btn("🗑 Delete", "del:" + id)], [btn("⬅ Notes", "m:notes"), btn("❌ Close", "x")]]);
}
function sendFile(id) { var f; try { f = DriveApp.getFileById(id); } catch(e) { return; } sendDocument(f.getBlob().setName(f.getName()), title(f.getName(), f.getBlob().getDataAsString())); }
function trashFile(id) { var f; try { f = DriveApp.getFileById(id); } catch(e) { return; } var n = f.getName(); if (n.indexOf("del-") !== 0) f.setName("del-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd") + "__" + n); f.moveTo(getTrash()); }
// Trash: each row inline — name / send / recover / permanent delete.
function showTrash(cq) {
  var all = [], it = getTrash().getFiles();
  while (it.hasNext()) all.push(it.next());
  var files = all.slice(0, 8), rows = [];
  files.forEach(function(f) {
    var id = f.getId(), n = f.getName().replace(/^del-\d{4}-\d{2}-\d{2}__/, "");
    rows.push([btn("🗑  " + title(n, f.getBlob().getDataAsString()), "vw:" + id)]);
    rows.push([btn("📤  Send", "snd:" + id), btn("♻️  Recover", "rec:" + id), btn("✖  Delete", "perm:" + id)]);
  });
  if (files.length) rows.push([btn("🔥  Purge everything", "purge")]);
  rows.push([btn("⬅  Menu", "m:main"), btn("✖  Close", "x")]);
  editMenu(cq, files.length ? "🗑 Trash — ♻️ recover, or ✖ delete forever:" : "🗑 Trash is empty.", rows);
}
function recoverFile(id) { var f; try { f = DriveApp.getFileById(id); } catch(e) { return; } f.setName(f.getName().replace(/^del-\d{4}-\d{2}-\d{2}__/, "")); f.moveTo(getWiki()); }
function showIdentity(cq) {
  editMenu(cq, "🪪 I am:\n\n" + botIdentity(), [[btn("✏️ Change", "id:edit")], [btn("⬅ Menu", "m:main"), btn("❌ Close", "x")]]);
}
function settingsRows() {
  return [[btn("🧠 Model: " + modelLabel(), "set:model")],
          [btn("🔑 Keys: Groq " + groqKeys().length + " · Gemini " + geminiKeys().length, "set:keys")],
          [btn("➕ Add API key", "set:addkey")],
          [btn("📏 Memory: " + memTurns() + " turns", "set:mem")],
          [btn("🗑 Trash keep: " + cfg("TRASH_DAYS", TRASH_DAYS) + "d", "set:trash")],
          [btn("⬅ Menu", "m:main"), btn("❌ Close", "x")]];
}
function showSettings(cq) { editMenu(cq, "⚙️ Settings", settingsRows()); }
function applySetting(cq, w) {
  if (w === "model") return editMenu(cq, "🧠 Primary model (auto-falls back across your keys):", [[btn("🧠 Groq 120B", "val:oss120")], [btn("⚡ Groq 20B", "val:oss20")], [btn("🌟 Gemini first", "val:gemini")], [btn("⬅ Back", "m:set"), btn("❌", "x")]]);
  if (w === "keys") return editMenu(cq, "🔑 Keys — Groq " + groqKeys().length + ", Gemini " + geminiKeys().length + ".\nMore keys = more daily capacity; I roll to the next when one is limited.", [[btn("➕ Add API key", "set:addkey")], [btn("⬅ Back", "m:set"), btn("❌", "x")]]);
  if (w === "addkey") { setProp("AWAIT_KEY", "1"); return editMenu(cq, "➕ Send your API key as a normal message now (Groq gsk_… or Gemini AIza…/AQ.…). I'll store it and delete your message.", [[btn("⬅ Back", "m:set"), btn("❌", "x")]]); }
  if (w === "mem")   return editMenu(cq, "📏 Remember how many recent exchanges?", [[btn("4", "val:mem=4"), btn("6", "val:mem=6"), btn("10", "val:mem=10"), btn("20", "val:mem=20")], [btn("⬅ Back", "m:set"), btn("❌", "x")]]);
  if (w === "trash") return editMenu(cq, "🗑 Keep trash for how long?", [[btn("7d", "val:trash=7"), btn("30d", "val:trash=30"), btn("90d", "val:trash=90")], [btn("⬅ Back", "m:set"), btn("❌", "x")]]);
}
function setValue(cq, kv) {
  if (kv === "oss120") { setProp("PRIMARY", "groq"); setProp("GROQ_MODEL", "openai/gpt-oss-120b"); }
  else if (kv === "oss20") { setProp("PRIMARY", "groq"); setProp("GROQ_MODEL", "openai/gpt-oss-20b"); }
  else if (kv === "gemini") setProp("PRIMARY", "gemini");
  else if (kv.indexOf("mem=") === 0) setProp("MEM_TURNS", kv.slice(4));
  else if (kv.indexOf("trash=") === 0) setProp("TRASH_DAYS", kv.slice(6));
  showSettings(cq);
}
// Single dispatcher — distinct prefixes, one tap, no collisions.
function handleCallback(cq) {
  if (!cq || !cq.from || String(cq.from.id) !== String(USER_ID)) return;
  ackCb(cq);
  if (cq.message) setProp("MENU_MSG", String(cq.message.message_id));
  var d = cq.data || "", i = d.indexOf(":"), pfx = i < 0 ? d : d.slice(0, i), a = i < 0 ? "" : d.slice(i + 1);
  try {
    switch (pfx) {
      case "x":     closeMenu(cq); break;
      case "purge": var it = getTrash().getFiles(); while (it.hasNext()) it.next().setTrashed(true); showTrash(cq); break;
      case "m":
        if (a === "notes") showNotes(cq); else if (a === "trash") showTrash(cq);
        else if (a === "rem") showReminders(cq);
        else if (a === "id") showIdentity(cq); else if (a === "set") showSettings(cq);
        else editMenu(cq, "🏠 Menu", mainMenuRows());
        break;
      case "rmdel": saveRem(loadRem().filter(function(e) { return e.id !== a; })); showReminders(cq); break;
      case "noop":  break;
      case "vw":   showNoteText(cq, a); break;
      case "snd":  sendFile(a); break;                                  // sends a document; menu stays
      case "del":  trashFile(a); showNotes(cq); break;                  // delete from notes → refresh
      case "rec":  recoverFile(a); showTrash(cq); break;                // recover from trash → refresh
      case "perm": try { DriveApp.getFileById(a).setTrashed(true); } catch(e) {} showTrash(cq); break;
      case "id":   if (a === "edit") { setProp("AWAIT_IDENTITY", "1"); editMenu(cq, "✏️ Send my new name and description in one message, e.g.\n“Aria — your sharp, friendly notes keeper.”", [[btn("⬅ Back", "m:id"), btn("❌", "x")]]); } break;
      case "set":  applySetting(cq, a); break;
      case "val":  setValue(cq, a); break;
    }
  } catch(e) { /* keep the UI silent and clean */ }
}

// ---- Immutable raw capture (every message, no AI) ----
function captureRaw(m, text) {
  var ts = new Date((m && m.date ? m.date : Date.now() / 1000) * 1000), name = Utilities.formatDate(ts, TIMEZONE, "yyyy-MM-dd-HHmmss") + ".md";
  writeFile(getArchives(), name, "date: " + Utilities.formatDate(ts, TIMEZONE, "yyyy-MM-dd HH:mm:ss") + "\n---\n" + (text || ""));
  return name;
}

// ================= WEBHOOK (relay → here) =================
function doGet() { return ContentService.createTextOutput("LLM-Wiki is live."); }
function alreadyProcessed(id) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch(e) { return false; }
  try { var seen = JSON.parse(getProp("SEEN_IDS") || "[]"); if (seen.indexOf(id) >= 0) return true; seen.push(id); if (seen.length > 60) seen = seen.slice(-60); setProp("SEEN_IDS", JSON.stringify(seen)); return false; }
  finally { lock.releaseLock(); }
}
function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.s !== WEBHOOK_SECRET) return ContentService.createTextOutput("forbidden");
    var u = JSON.parse(e.postData.contents);
    if (u.update_id != null && alreadyProcessed(u.update_id)) return ContentService.createTextOutput("dup");
    if (u.callback_query) handleCallback(u.callback_query);
    else if (u.message)   handleMessage(u.message);
  } catch(err) { console.error("doPost", err.message); }
  return ContentService.createTextOutput("ok");
}
function setupWebhook() {
  var res = tg("setWebhook", {url: RELAY_URL, secret_token: TG_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true});
  say("Webhook → relay set ✓"); console.log(res.getContentText());
}
// Daily self-heal: re-affirm the webhook and flush any stuck pending update so an old message
// can never get re-delivered in a loop again.
function healthCheck() {
  tg("setWebhook", {url: RELAY_URL, secret_token: TG_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true});
}

// ================= BACKGROUND JOBS =================
// Fold archives the bot didn't handle live (e.g. arrived while keys were exhausted) into the wiki.
function organizeWiki() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return false;
  try {
    var files = [], it = getArchives().getFiles();
    while (it.hasNext()) files.push(it.next());
    files.sort(function(a, b) { return a.getName() > b.getName() ? 1 : -1; });
    var last = getProp("LAST_ORG") || "", pending = files.filter(function(f) { return f.getName() > last; });
    if (!pending.length) return false;
    var w = getWiki(), idx = readFile(w, "index.md"), count = 0;
    for (var i = 0; i < pending.length && count < 5; i++) {
      var file = pending[i], note = file.getBlob().getDataAsString();
      var res = callText("You curate a personal wiki. Fold the note into clean, well-titled pages. Return STRICT JSON only.",
        "Current index.md:\n" + idx + "\n\nNote:\n" + note + "\n\nReturn:\n{\"pages\":[{\"name\":\"<page>.md\",\"content\":\"<full markdown>\"}],\"index\":\"<full new index.md>\"}");
      if (res) try { var p = JSON.parse(stripFences(res)); if (p.pages) p.pages.forEach(function(x) { writeFile(w, x.name, x.content); }); if (p.index) { writeFile(w, "index.md", p.index); idx = p.index; } } catch(e) { console.error("organize", e.message); }
      setProp("LAST_ORG", file.getName()); count++;
    }
    return count > 0;
  } finally { lock.releaseLock(); }
}
function lintWiki() {
  var context = wikiFiles().map(function(f) { return "=== " + f.getName() + " ===\n" + f.getBlob().getDataAsString(); }).join("\n\n");
  var raw = callText("Audit a personal wiki. Be direct.", "Find contradictions, stale info, duplicates to merge, and gaps. Return STRICT JSON only: {\"report\":\"<md>\",\"shortMsg\":\"<2 sentences>\",\"questions\":[\"q\"]}\n\n" + context);
  if (!raw) { say("Couldn't run the audit just now."); return; }
  try { var p = JSON.parse(stripFences(raw)); if (p.report) writeFile(getWiki(), "_lint-report.md", p.report); say((p.shortMsg || "Audit done.") + "\n\n" + (p.questions || []).map(function(q) { return "• " + q; }).join("\n")); }
  catch(e) { say("Audit hiccup — try again later."); }
}
function purgeTrash() {
  var it = getTrash().getFiles(), cutoff = Date.now() - Number(cfg("TRASH_DAYS", TRASH_DAYS)) * 864e5;
  while (it.hasNext()) { var f = it.next(), mt = f.getName().match(/^del-(\d{4}-\d{2}-\d{2})__/), when = mt ? new Date(mt[1] + "T00:00:00").getTime() : f.getDateCreated().getTime(); if (when < cutoff) try { f.setTrashed(true); } catch(e) {} }
}

// ---- Setup (run once from the editor; use setupWebhook() to bind delivery) ----
function setup() {
  var root, id = getProp("WIKI_ROOT_ID");
  if (id) try { root = DriveApp.getFolderById(id); } catch(e) { root = null; }
  if (!root) { root = getFolder(DriveApp.getRootFolder(), "LLM-Wiki"); setProp("WIKI_ROOT_ID", root.getId()); }
  getFolder(root, "archives"); getFolder(root, "trash");
  var w = getFolder(root, "wiki");
  if (!readFile(w, "index.md")) writeFile(w, "index.md", "");
  if (!readFile(w, "bot-identity.md")) writeFile(w, "bot-identity.md", "Name: Aria\nDescription: a sharp, warm personal notes assistant who keeps your knowledge tidy.");
  tg("setMyCommands", {commands: [{command: "menu", description: "Open the menu"}, {command: "audit", description: "Find duplicates & gaps"}, {command: "reset", description: "Clear short-term memory"}, {command: "help", description: "How to use"}]});
  tg("setChatMenuButton", {menu_button: {type: "commands"}});
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("checkReminders").timeBased().everyMinutes(1).create();   // proactive reminder watchdog
  ScriptApp.newTrigger("morningBriefing").timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger("organizeWiki").timeBased().everyHours(6).create();
  ScriptApp.newTrigger("lintWiki").timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(9).create();
  ScriptApp.newTrigger("purgeTrash").timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger("healthCheck").timeBased().everyDays(1).atHour(4).create();
  say("Ready. Just talk to me, or tap /menu.");
}
