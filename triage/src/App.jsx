import React, { useState, useEffect, useRef, useMemo } from "react";
import { Upload, Download, Settings, X, Plus, Trash2, ChevronLeft, ChevronRight, RefreshCw, Sparkles, LogOut } from "lucide-react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

/* Supabase owns authentication. These two values are safe to expose in the
   browser (the anon key is public by design). They're injected at build time
   from Vercel env vars -- Vite only exposes vars prefixed with VITE_. */
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

/* Wrap fetch so every call to our API carries the Supabase access token.
   The backend verifies it before returning any data. */
async function authFetch(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  return fetch(url, { ...options, headers });
}


/* status (next-action) colors -- the only colors that carry meaning */
const STATUS = {
  red:   { label: "Needs action",   line: "#c0392b", tint: "#fbeae8", text: "#8c2d22" },
  blue:  { label: "Needs response", line: "#2563aa", tint: "#e8f0fa", text: "#1d4d86" },
  green: { label: "Solved",         line: "#1a7f37", tint: "#e8f5ec", text: "#155d28" },
  none:  { label: "Unset",          line: "#b0b0b0", tint: "#f4f4f4", text: "#6b6b6b" },
};
const ORDER = ["red", "blue", "green", "none"];

const UI = {
  text: "#1c1c1c", muted: "#6b6b6b", border: "#d6d6d6", borderSoft: "#e8e8e8",
  bg: "#ffffff", panel: "#fafafa",
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Helvetica, Arial, sans-serif',
};

/* ---------- helpers ---------- */
const norm = (s) => (s == null ? "" : String(s)).trim();
const lc = (s) => norm(s).toLowerCase();

function statusToColor(status) {
  const s = lc(status);
  if (s === "open" || s === "new") return "red";
  if (s === "pending" || s === "hold" || s === "on-hold") return "blue";
  if (s === "solved" || s === "closed") return "green";
  return "none";
}
function deriveCustomer(requester) {
  const r = norm(requester);
  if (r.includes("@")) {
    const base = (r.split("@")[1] || "").split(".")[0] || "";
    if (base) return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return "";
}
function fmtDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return norm(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return norm(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* Decode HTML entities, strip tags, and tighten whitespace. Applied at render
   time so threads already saved before this fix still display cleanly. */
const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&mdash;": "\u2014", "&ndash;": "\u2013", "&hellip;": "\u2026", "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&rdquo;": "\u201D", "&ldquo;": "\u201C", "&copy;": "\u00A9", "&reg;": "\u00AE", "&trade;": "\u2122" };
function cleanText(s) {
  if (!s) return "";
  const cp = (n) => { try { return String.fromCodePoint(n); } catch (e) { return ""; } };
  return String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => (ENTITIES[m] != null ? ENTITIES[m] : m))
    .replace(/\u00a0/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function pick(row, names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const hit = keys.find((k) => lc(k) === lc(n));
    if (hit != null) return row[hit];
  }
  return "";
}
function rowsToTickets(rows) {
  return rows
    .map((row) => {
      const status = norm(pick(row, ["Ticket status", "Status"]));
      const requester = norm(pick(row, ["Requester name", "Requester"]));
      return {
        id: norm(pick(row, ["Ticket ID", "Id", "ID"])),
        subject: norm(pick(row, ["Ticket subject", "Subject"])),
        created: norm(pick(row, ["Ticket created - Timestamp", "Created", "Created at"])),
        status, requester,
        customer: deriveCustomer(requester),
        summary: "", color: statusToColor(status), comments: [], emailDraft: "",
      };
    })
    .filter((t) => t.id);
}
const isUnsolved = (t) => { const s = lc(t.status); return s !== "closed" && s !== "solved"; };

/* The DEFAULT summarizer instructions, lifted verbatim from support_summary_prompt.md.
   This is just the starting value -- users can edit the live prompt in Settings,
   and the edited version is what gets sent to the backend. */
const SUMMARY_PROMPT = `You are a summarization assistant. You will be given a message log -- a chat thread or email exchange between a customer and a support/technical team. Produce a single summary of the conversation in the exact style described below.

## Output style
- Write ONE paragraph. No headings, no bullet points, no labels. Do NOT begin with the word "Summary."
- Use third person and past tense. Keep the tone neutral and factual.
- Length scales with how much was actually discussed -- typically 60-150 words. A short, simple exchange gets a short summary; a dense, multi-part one gets more.

## What to identify and preserve
- Identify the customer by name, company, and/or role whenever the log provides it (e.g., "The customer, Hien Nguyen from Hit Promotional Products,..."). If no identity is given, just write "The customer."
- Name any support agents, engineers, artists, colleagues, or third parties mentioned (e.g., Bob, James, Alexander, Marabu).
- Preserve exact technical details verbatim: machine/model names and serial numbers, pressure and power values (e.g., -38.5, 100 PSI, 40% Pin 1), resolutions (e.g., 900x980), thread sizes, part names (printhead, meniscus/vacuum filter, KNF pump motor, tail stock air cylinder, etc.), error messages, and settings.
- Note when files, photos, videos, screenshots, or part images were shared, and when a Zoom, phone, or screen-sharing session occurred.
- Capture substantive non-technical content too -- requests for quotes / parts / lead times, account or service concerns, staffing changes, and customer sentiment (e.g., a customer feeling unsupported). These belong in the summary just like technical issues do.

## Handling multiple topics
- Always produce ONE combined summary, even when the conversation covers several separate matters.
- Make every topic switch explicit. When the conversation moves to a different matter, mark the transition with a phrase such as "Separately,...", "On a different matter,...", "The customer also...", or "In the same thread,..." so each distinct topic is clearly delineated inside the single summary.

## What to EXCLUDE (important)
- Strip greetings, well-wishes, sign-offs, email signatures, and any "this email originated outside the organization" warning boilerplate.
- Do NOT add any closing or wrap-up sentence about status, resolution, next steps, outstanding items, the "main concern," or the absence of any of these. These are not part of the conversation and must be omitted wherever they would appear, not just at the end. Never write sentences like: "No resolution yet; next steps involve...", "No actions or next steps were mentioned.", "The current status is...", "The main concern is...", "No issues or deadlines are explicitly stated.", "No definitive root cause or resolution has been identified yet.", "The issue remains under investigation, awaiting further feedback."
- You MAY report an action or agreement a participant actually stated within the conversation (e.g., "Robert agreed to be ready at 1 PM"). What you must not do is append your own interpretive summary of next steps, status, or resolution.
- End the summary on the last substantive point that was actually discussed.

## Reference examples (target style)
Example 1: The customer reported an issue with PeriOne machine SN 245002806 where white ink is weeping despite negative pressure at -38.5, causing drips on tooling and sensors. Support suggested a possible blocked meniscus/vacuum filter on the white channel or a loose connection causing a vacuum leak. The customer confirmed no white ink in the header tank line. Support requested a Zoom session to troubleshoot remotely. The customer connected to Zoom and shared the screen. Support also asked a colleague to call the customer for further discussion.

Example 2: The customer reviewed a shared video of the P1 curing process and noted that the second lamp segment for lamp 6 does not turn on. They were unsure how many cure lamps are active, suspecting six at one point, and asked if all seven lamps are in service. They also requested a similar video for P2. The agent clarified that only six lamps are active on both P1 and P2, with lamp 7 disabled due to spot colors being off, making lamp 6 the final cure lamp. Additionally, the second half segments on lamp 5 are not activating as they are beyond the last light black print head. The customer only received the P1 video so far.

Example 3: The customer, Hien Nguyen from Hit Promotional Products, requested a recommended spare parts list for their newly purchased PeriH machine, specifically including the printhead. They also highlighted the need to stock the tail stock air cylinder/assembly and the motor for raising/lowering the print carriage. The request was initially overlooked, and a follow-up emphasized the urgency to provide this information so the customer can stock up on these parts.

Now summarize the message log that follows. Respond with the paragraph only -- no preamble, no labels.`;

function buildLog(content) {
  return (content && content.trim())
    ? content.trim()
    : "(No conversation thread was provided. Treat the ticket subject as the only available detail and keep the summary brief; do not invent a thread that was not given.)";
}

/* Pull the full comment thread for one ticket from the backend (auth-gated).
   Returns { conversation, messages } or null if it isn't available. */
async function fetchThread(id) {
  try {
    const r = await authFetch("/api/ticket?id=" + encodeURIComponent(id));
    if (r.ok) {
      const d = await r.json();
      const conversation = (d.conversation || "").trim();
      const messages = Array.isArray(d.messages) ? d.messages : [];
      if (conversation || messages.length) return { conversation, messages };
    }
  } catch (e) { /* no backend / not reachable -- caller falls back */ }
  return null;
}

/* Summaries are generated server-side (the Anthropic key stays on the server).
   Returns { summary, usage } so callers can track token consumption. */
async function getSummary(subject, content, prompt) {
  const r = await authFetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, content: buildLog(content), prompt }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 200));
  const d = await r.json();
  return {
    summary: (d.summary || "").trim(),
    usage: d.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

/* Persistence: use the canvas storage when it exists, otherwise the real
   browser's localStorage (which is what runs on the deployed site). */
const store = {
  async get(k) {
    try { if (typeof window !== "undefined" && window.storage) { const r = await window.storage.get(k); return r ? r.value : null; } } catch (e) {}
    try { return localStorage.getItem(k); } catch (e) { return null; }
  },
  async set(k, v) {
    try { if (typeof window !== "undefined" && window.storage) { await window.storage.set(k, v); return; } } catch (e) {}
    try { localStorage.setItem(k, v); } catch (e) {}
  },
};

/* ---------- auth gate ----------
   Sign-in goes straight to Supabase from the browser; Supabase issues a JWT that
   authFetch attaches to every API call. The backend (api/*) verifies that token,
   so the protected endpoints can't be reached without a valid Supabase session. */

async function checkSession() {
  try {
    const { data } = await supabase.auth.getSession();
    return !!(data && data.session);
  } catch (e) { return false; }
}

async function doLogin(email, password) {
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message || "Sign-in failed." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Couldn't reach the sign-in service. Try again." };
  }
}

async function doLogout() {
  try { await supabase.auth.signOut(); } catch (e) {}
}

function LoginScreen({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (busy) return;
    if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
    setBusy(true); setErr("");
    try {
      const res = await doLogin(email.trim(), password);
      if (res.ok) onSuccess();
      else setErr(res.error || "Sign-in failed.");
    } catch (e) { setErr("Sign-in failed: " + e.message); }
    setBusy(false);
  }

  const field = {
    width: "100%", padding: "10px 12px", border: `1px solid ${UI.border}`, borderRadius: 6,
    fontSize: 14, color: UI.text, boxSizing: "border-box", background: UI.bg,
  };
  const labelStyle = { fontSize: 12, color: UI.muted, fontWeight: 600, marginBottom: 6, display: "block" };

  return (
    <div style={{ fontFamily: UI.font, color: UI.text, background: UI.panel, minHeight: "100vh", colorScheme: "light", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <style>{`input{font-family:${UI.font};background:${UI.bg};color:${UI.text}}`}</style>
      <div style={{ width: "min(380px, 100%)", background: UI.bg, border: `1px solid ${UI.border}`, borderTop: `4px solid ${STATUS.blue.line}`, borderRadius: 10, padding: "28px 26px", boxShadow: "0 10px 40px rgba(0,0,0,.08)" }}>
        {/* status-dot motif, echoing the dashboard's color system */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {ORDER.map((k) => <span key={k} style={{ width: 9, height: 9, borderRadius: 999, background: STATUS[k].line }} />)}
        </div>
        <h1 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 4px" }}>Zendesk Tickets</h1>
        <p style={{ fontSize: 13, color: UI.muted, margin: "0 0 22px", lineHeight: 1.5 }}>Sign in to view support tickets.</p>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle} htmlFor="login-email">Email</label>
          <input id="login-email" type="email" value={email} autoComplete="username" autoFocus
            onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={field} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle} htmlFor="login-pass">Password</label>
          <input id="login-pass" type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={field} />
        </div>

        {err && <div style={{ fontSize: 13, color: STATUS.red.text, background: STATUS.red.tint, border: `1px solid ${STATUS.red.line}`, borderRadius: 6, padding: "8px 10px", marginBottom: 14, lineHeight: 1.45 }}>{err}</div>}

        <button onClick={submit} disabled={busy} style={{ width: "100%", cursor: busy ? "default" : "pointer", fontFamily: UI.font, fontSize: 14, fontWeight: 600, padding: "11px 12px", borderRadius: 6, border: "none", background: UI.text, color: "#fff", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => { const ok = await checkSession(); if (mounted) { setAuthed(ok); setAuthChecked(true); } })();
    // Keep in sync with Supabase: token refreshes, sign-out in another tab, etc.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setAuthed(!!session);
    });
    return () => { mounted = false; if (data && data.subscription) data.subscription.unsubscribe(); };
  }, []);

  async function logout() { await doLogout(); setAuthed(false); }

  if (!authChecked) return <div style={{ fontFamily: UI.font, padding: 32, color: UI.muted }}>Loading...</div>;
  if (!authed) return <LoginScreen onSuccess={() => setAuthed(true)} />;
  return <Dashboard onLogout={logout} />;
}

/* ---------- main ---------- */
function Dashboard({ onLogout }) {
  const [tickets, setTickets] = useState([]);
  const [dismissed, setDismissed] = useState([]); // ids deleted from the board; kept out on refresh
  const [summaryPrompt, setSummaryPrompt] = useState(SUMMARY_PROMPT);
  const [usage, setUsage] = useState({ input: 0, output: 0, calls: 0 });
  const [rates, setRates] = useState({ in: 3, out: 15 }); // $ per million tokens (Sonnet 4.6 defaults)
  const [loaded, setLoaded] = useState(false);

  function recordUsage(u) {
    if (!u) return;
    setUsage((p) => ({
      input: p.input + (u.input_tokens || 0),
      output: p.output + (u.output_tokens || 0),
      calls: p.calls + 1,
    }));
  }
  const [view, setView] = useState("table");
  const [openId, setOpenId] = useState(null);
  const [meetingIdx, setMeetingIdx] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState("");
  const [busyAll, setBusyAll] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      const t = await store.get("triage_tickets");
      if (t) { try { const p = JSON.parse(t); if (Array.isArray(p)) setTickets(p); } catch (e) {} }
      const p = await store.get("triage_prompt");
      if (p) setSummaryPrompt(p);
      const u = await store.get("triage_usage");
      if (u) { try { const v = JSON.parse(u); if (v && typeof v === "object") setUsage({ input: v.input || 0, output: v.output || 0, calls: v.calls || 0 }); } catch (e) {} }
      const rt = await store.get("triage_rates");
      if (rt) { try { const v = JSON.parse(rt); if (v && typeof v === "object") setRates({ in: Number(v.in) || 0, out: Number(v.out) || 0 }); } catch (e) {} }
      const dm = await store.get("triage_dismissed");
      if (dm) { try { const v = JSON.parse(dm); if (Array.isArray(v)) setDismissed(v); } catch (e) {} }
      setLoaded(true);
    })();
  }, []);
  useEffect(() => { if (loaded) store.set("triage_tickets", JSON.stringify(tickets)); }, [tickets, loaded]);
  useEffect(() => { if (loaded) store.set("triage_prompt", summaryPrompt); }, [summaryPrompt, loaded]);
  useEffect(() => { if (loaded) store.set("triage_usage", JSON.stringify(usage)); }, [usage, loaded]);
  useEffect(() => { if (loaded) store.set("triage_rates", JSON.stringify(rates)); }, [rates, loaded]);
  useEffect(() => { if (loaded) store.set("triage_dismissed", JSON.stringify(dismissed)); }, [dismissed, loaded]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };
  const update = (id, patch) => setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  // Delete one ticket: drop it from the board and remember it so a Zendesk
  // refresh won't pull it back in.
  const remove = (id) => {
    setTickets((ts) => ts.filter((t) => t.id !== id));
    setDismissed((d) => (d.includes(id) ? d : [...d, id]));
  };
  // Delete everything: clear the board and forget prior deletions (clean slate).
  // A subsequent "Refresh from Zendesk" repopulates with the current live list.
  const deleteAll = () => { setTickets([]); setDismissed([]); };
  // Un-hide individually deleted tickets so a refresh pulls them back in.
  const restoreHidden = () => { setDismissed([]); };

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      const all = rowsToTickets(rows);
      const unsolved = all.filter(isUnsolved);
      setTickets((prev) => {
        const byId = Object.fromEntries(prev.map((t) => [t.id, t]));
        return unsolved.map((n) => {
          const old = byId[n.id];
          return old ? { ...n, summary: old.summary || n.summary, comments: old.comments || [], color: old.color || n.color, customer: old.customer || n.customer, emailDraft: old.emailDraft || "" } : n;
        });
      });
      flash(`Imported ${all.length} rows, kept ${unsolved.length} unsolved (dropped ${all.length - unsolved.length} closed/solved).`);
    } catch (err) { flash("Couldn't read that file. Make sure it's the Zendesk .xlsx export."); }
    e.target.value = "";
  }

  function exportXlsx() {
    if (!tickets.length) { flash("Nothing to export yet."); return; }
    const data = tickets.map((t) => ({
      "Customer": t.customer, "Ticket ID": t.id, "Ticket subject": t.subject,
      "Summary": t.summary,
      "Notes / Actions": (t.comments || []).map((c) => c.text).join("\n"),
      "Ticket created - Timestamp": t.created, "Requester name": t.requester,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{ wch: 16 }, { wch: 9 }, { wch: 40 }, { wch: 90 }, { wch: 50 }, { wch: 22 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Unsolved Ticket Count");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const url = URL.createObjectURL(new Blob([out], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url; a.download = "support_update.xlsx"; a.click();
    URL.revokeObjectURL(url);
    flash("Exported support_update.xlsx");
  }

  async function refreshZendesk() {
    setBusyAll("Pulling tickets from Zendesk...");
    try {
      const r = await authFetch("/api/zendesk");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      const dismissedSet = new Set(dismissed);
      const incoming = (d.tickets || []).filter((n) => !dismissedSet.has(String(n.id)));
      const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
      const merged = incoming.map((n) => {
        const old = byId[n.id];
        const customer = (old && old.customer) || n.customer || deriveCustomer(n.email || n.requester);
        return {
          id: n.id, subject: n.subject, created: n.created, status: n.status, requester: n.requester,
          email: n.email || "",
          customer,
          summary: old ? old.summary : "",
          color: old ? old.color : statusToColor(n.status),
          comments: old ? old.comments : [],
          emailDraft: n.conversation || (old ? old.emailDraft : ""),
          thread: old ? old.thread : undefined,
        };
      });
      setTickets(merged);
      flash(`Pulled ${incoming.length} unsolved tickets from Zendesk.`);

      // Auto-load the full chat thread for any ticket that doesn't have one yet,
      // a few at a time so we don't hammer the Zendesk API.
      const need = merged.filter((t) => !(t.thread && t.thread.length));
      if (need.length) {
        let done = 0;
        const CONCURRENCY = 4;
        const queue = [...need];
        const worker = async () => {
          while (queue.length) {
            const t = queue.shift();
            try {
              const thread = await fetchThread(t.id);
              if (thread) update(t.id, { emailDraft: thread.conversation, thread: thread.messages });
            } catch (e) { /* leave this one for a manual load */ }
            done++;
            setBusyAll(`Loading conversations ${done}/${need.length}...`);
          }
        };
        setBusyAll(`Loading conversations 0/${need.length}...`);
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, need.length) }, worker));
      }
    } catch (e) {
      flash("Zendesk pull failed: " + e.message);
    }
    setBusyAll("");
  }

  async function summarizeAll() {
    const todo = tickets.filter((t) => !t.summary);
    if (!todo.length) { flash("Nothing to summarize - every ticket already has one."); return; }
    let done = 0;
    setBusyAll(`Summarizing 0/${todo.length}...`);
    for (const t of todo) {
      try {
        const thread = await fetchThread(t.id);
        const content = (thread && thread.conversation) || (t.emailDraft || "").trim();
        if (thread) update(t.id, { emailDraft: thread.conversation, thread: thread.messages });
        const res = await getSummary(t.subject, content, summaryPrompt);
        if (res.summary) { update(t.id, { summary: res.summary }); recordUsage(res.usage); }
      } catch (e) { /* skip this one, keep going */ }
      done++;
      setBusyAll(`Summarizing ${done}/${todo.length}...`);
    }
    setBusyAll("");
    flash(`Summarized ${done} ticket(s).`);
  }

  const counts = useMemo(() => {
    const c = { total: tickets.length, red: 0, blue: 0, green: 0, none: 0 };
    tickets.forEach((t) => (c[t.color] = (c[t.color] || 0) + 1));
    return c;
  }, [tickets]);

  const openTicket = tickets.find((t) => t.id === openId) || null;
  if (!loaded) return <div style={{ fontFamily: UI.font, padding: 32, color: UI.muted }}>Loading...</div>;

  const btn = (extra = {}) => ({
    display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: UI.font,
    fontSize: 13, padding: "7px 12px", borderRadius: 6, border: `1px solid ${UI.border}`,
    background: UI.bg, color: UI.text, ...extra,
  });

  return (
    <div style={{ fontFamily: UI.font, color: UI.text, background: UI.bg, minHeight: "100%", colorScheme: "light" }}>
      <style>{`textarea,input{font-family:${UI.font};background:${UI.bg};color:${UI.text}} ::-webkit-scrollbar{height:9px;width:9px} ::-webkit-scrollbar-thumb{background:#d0d0d0;border-radius:6px}`}</style>

      {/* header */}
      <header style={{ borderBottom: `1px solid ${UI.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Zendesk Tickets</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={onFile} style={{ display: "none" }} />
          <button style={btn(busyAll ? { opacity: 0.5 } : {})} onClick={refreshZendesk} disabled={!!busyAll}><RefreshCw size={14} /> Refresh Zendesk</button>
          <button style={btn(busyAll ? { opacity: 0.5 } : {})} onClick={summarizeAll} disabled={!!busyAll}><Sparkles size={14} /> Summarize all</button>
          <button style={btn()} onClick={() => fileRef.current?.click()}><Upload size={14} /> Import</button>
          <button style={btn()} onClick={exportXlsx}><Download size={14} /> Export Excel</button>
          <button style={btn()} onClick={() => { setView(view === "table" ? "meeting" : "table"); setMeetingIdx(0); }}>
            {view === "table" ? "Meeting mode" : "Table"}
          </button>
          <button style={btn(showSettings ? { background: UI.panel } : {})} onClick={() => setShowSettings((s) => !s)}><Settings size={14} /></button>
          <button style={btn()} onClick={onLogout} title="Sign out"><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      {/* settings */}
      {showSettings && (
        <div style={{ background: UI.panel, borderBottom: `1px solid ${UI.border}`, padding: "14px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, maxWidth: 760 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Summary prompt</div>
            <button
              style={btn({ fontSize: 12, padding: "5px 10px" })}
              onClick={() => { if (window.confirm("Reset the summary prompt to the default?")) { setSummaryPrompt(SUMMARY_PROMPT); flash("Prompt reset to default."); } }}
            >Reset to default</button>
          </div>
          <textarea
            value={summaryPrompt}
            onChange={(e) => setSummaryPrompt(e.target.value)}
            rows={12}
            spellCheck={false}
            style={{ width: "100%", maxWidth: 760, padding: "10px 12px", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: 1.5, color: UI.text, boxSizing: "border-box", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
          />
          <div style={{ fontSize: 12, color: UI.muted, marginTop: 7, lineHeight: 1.5, maxWidth: 760 }}>
            These instructions are sent with every summary. The ticket subject and conversation thread are appended automatically, so don't include them here. Changes save automatically.
          </div>

          {/* token usage */}
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${UI.border}`, maxWidth: 760 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Token usage</div>
              <button
                style={btn({ fontSize: 12, padding: "5px 10px" })}
                onClick={() => { if (window.confirm("Reset the token counter to zero?")) { setUsage({ input: 0, output: 0, calls: 0 }); flash("Token counter reset."); } }}
              >Reset counter</button>
            </div>
            {(() => {
              const cost = (usage.input / 1e6) * (rates.in || 0) + (usage.output / 1e6) * (rates.out || 0);
              const cell = { background: UI.bg, border: `1px solid ${UI.border}`, borderRadius: 6, padding: "10px 12px" };
              const num = { fontSize: 18, fontWeight: 600, color: UI.text };
              const cap = { fontSize: 11.5, color: UI.muted, marginTop: 2 };
              return (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
                    <div style={cell}><div style={num}>{usage.calls.toLocaleString()}</div><div style={cap}>summaries</div></div>
                    <div style={cell}><div style={num}>{usage.input.toLocaleString()}</div><div style={cap}>input tokens</div></div>
                    <div style={cell}><div style={num}>{usage.output.toLocaleString()}</div><div style={cap}>output tokens</div></div>
                    <div style={cell}><div style={num}>${cost.toFixed(2)}</div><div style={cap}>est. cost</div></div>
                  </div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                    <label style={{ fontSize: 12, color: UI.muted, display: "flex", alignItems: "center", gap: 6 }}>
                      Input $/M
                      <input type="number" min="0" step="0.01" value={rates.in}
                        onChange={(e) => setRates((r) => ({ ...r, in: Number(e.target.value) }))}
                        style={{ width: 70, padding: "5px 8px", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 13 }} />
                    </label>
                    <label style={{ fontSize: 12, color: UI.muted, display: "flex", alignItems: "center", gap: 6 }}>
                      Output $/M
                      <input type="number" min="0" step="0.01" value={rates.out}
                        onChange={(e) => setRates((r) => ({ ...r, out: Number(e.target.value) }))}
                        style={{ width: 70, padding: "5px 8px", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 13 }} />
                    </label>
                  </div>
                  <div style={{ fontSize: 12, color: UI.muted, marginTop: 9, lineHeight: 1.5 }}>
                    Counts tokens reported by each summary on this browser - a rough running tally, not a bill. Rates default to Claude Sonnet 4.6 ($3 / $15 per million). For exact, account-wide spend see the Anthropic Console usage page.
                  </div>
                </>
              );
            })()}
          </div>

          {/* danger zone */}
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${UI.border}`, maxWidth: 760 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tickets</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => { if (window.confirm("Delete ALL tickets from the board? This also clears the list of individually deleted tickets. Your Zendesk tickets are not affected - a refresh repopulates the board.")) { deleteAll(); flash("Cleared all tickets."); } }}
                style={{ cursor: "pointer", fontFamily: UI.font, fontSize: 12.5, fontWeight: 600, padding: "8px 13px", borderRadius: 6, border: `1px solid ${STATUS.red.line}`, background: STATUS.red.tint, color: STATUS.red.text, display: "inline-flex", alignItems: "center", gap: 6 }}
              ><Trash2 size={13} /> Delete all tickets</button>
              <button
                onClick={() => { restoreHidden(); flash("Hidden tickets restored - hit Refresh Zendesk to pull them back."); }}
                disabled={!dismissed.length}
                style={{ cursor: dismissed.length ? "pointer" : "default", fontFamily: UI.font, fontSize: 12.5, fontWeight: 600, padding: "8px 13px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.bg, color: UI.text, opacity: dismissed.length ? 1 : 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}
              ><RefreshCw size={13} /> Restore hidden{dismissed.length ? ` (${dismissed.length})` : ""}</button>
            </div>
            <div style={{ fontSize: 12, color: UI.muted, marginTop: 8, lineHeight: 1.5 }}>
              Delete all clears the board and forgets individually deleted tickets. Restore hidden un-hides tickets you deleted one by one - they reappear on the next Refresh Zendesk. Nothing in Zendesk changes either way.
            </div>
          </div>
        </div>
      )}

      {/* working indicator */}
      {busyAll && (
        <div style={{ padding: "8px 20px", background: "#fff7e0", borderBottom: `1px solid ${UI.border}`, fontSize: 13, color: UI.text }}>{busyAll}</div>
      )}

      {/* counts */}
      {tickets.length > 0 && (
        <div style={{ display: "flex", gap: 18, padding: "10px 20px", borderBottom: `1px solid ${UI.borderSoft}`, fontSize: 13, color: UI.muted, flexWrap: "wrap" }}>
          <span><b style={{ color: UI.text }}>{counts.total}</b> unsolved</span>
          {["red", "blue", "green", "none"].filter((k) => counts[k]).map((k) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: STATUS[k].line }} />
              {STATUS[k].label} <b style={{ color: UI.text }}>{counts[k]}</b>
            </span>
          ))}
        </div>
      )}

      {/* body */}
      <main style={{ padding: 20 }}>
        {tickets.length === 0 ? (
          <div style={{ textAlign: "center", padding: "70px 20px", color: UI.muted }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: UI.text, marginBottom: 8 }}>No tickets loaded</div>
            <p style={{ maxWidth: 420, margin: "0 auto 18px", lineHeight: 1.5 }}>
              Import your Zendesk unsolved-ticket export. Closed and solved rows are dropped automatically.
            </p>
            <button style={btn({ padding: "9px 14px" })} onClick={() => fileRef.current?.click()}><Upload size={15} /> Import export</button>
          </div>
        ) : view === "table" ? (
          <TableView tickets={tickets} onOpen={setOpenId}
            onCycle={(t) => update(t.id, { color: ORDER[(ORDER.indexOf(t.color) + 1) % ORDER.length] })} />
        ) : (
          <MeetingView tickets={tickets} idx={meetingIdx} setIdx={setMeetingIdx} update={update} flash={flash} />
        )}
      </main>

      {openTicket && <Detail ticket={openTicket} onClose={() => setOpenId(null)} update={update} summaryPrompt={summaryPrompt} recordUsage={recordUsage} remove={remove} flash={flash} />}

      {toast && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: UI.text, color: "#fff", padding: "10px 16px", borderRadius: 6, fontSize: 13, zIndex: 60 }}>{toast}</div>
      )}
    </div>
  );
}

/* ---------- table ---------- */
function TableView({ tickets, onOpen, onCycle }) {
  const cell = { padding: "10px 12px", textAlign: "left", verticalAlign: "top", borderBottom: `1px solid ${UI.borderSoft}` };
  const head = { ...cell, fontSize: 12, color: UI.muted, fontWeight: 600, background: UI.panel, position: "sticky", top: 0, borderBottom: `1px solid ${UI.border}` };
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr>
              <th style={{ ...head, width: 40 }}></th>
              <th style={head}>Customer</th>
              <th style={{ ...head, width: 64 }}>ID</th>
              <th style={head}>Subject</th>
              <th style={{ ...head, minWidth: 300 }}>Summary</th>
              <th style={{ ...head, minWidth: 200 }}>Notes / Actions</th>
              <th style={{ ...head, width: 100 }}>Created</th>
              <th style={{ ...head, width: 140 }}>Requester</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const s = STATUS[t.color] || STATUS.none;
              return (
                <tr key={t.id} onClick={() => onOpen(t.id)} style={{ cursor: "pointer", background: t.color === "none" ? UI.bg : s.tint, borderLeft: `3px solid ${t.color === "none" ? "transparent" : s.line}` }}>
                  <td style={{ ...cell }} onClick={(e) => { e.stopPropagation(); onCycle(t); }} title="Click to change status">
                    <span style={{ display: "block", width: 14, height: 14, borderRadius: 999, background: s.line, margin: "2px auto" }} />
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>{t.customer || <span style={{ color: "#aaa" }}>-</span>}</td>
                  <td style={{ ...cell, color: UI.muted }}>{t.id}</td>
                  <td style={{ ...cell, fontWeight: 600, maxWidth: 210 }}>{t.subject}</td>
                  <td style={{ ...cell, color: t.summary ? UI.text : "#999", lineHeight: 1.5, fontStyle: t.summary ? "normal" : "italic" }}>
                    {t.summary ? (t.summary.length > 200 ? t.summary.slice(0, 200) + "..." : t.summary) : "No summary yet"}
                  </td>
                  <td style={{ ...cell, maxWidth: 240, lineHeight: 1.45 }}>
                    {t.comments && t.comments.length ? (
                      <span>
                        <span style={{ whiteSpace: "pre-wrap" }}>{(() => { const v = t.comments[t.comments.length - 1].text; return v.length > 140 ? v.slice(0, 140) + "..." : v; })()}</span>
                        {t.comments.length > 1 && <span style={{ color: UI.muted, fontSize: 11.5 }}> (+{t.comments.length - 1} earlier)</span>}
                      </span>
                    ) : <span style={{ color: "#bbb" }}>-</span>}
                  </td>
                  <td style={{ ...cell, fontSize: 12.5, color: UI.muted, whiteSpace: "nowrap" }}>{fmtDate(t.created)}</td>
                  <td style={{ ...cell, color: UI.muted }}>{t.requester}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- meeting mode ---------- */
function MeetingView({ tickets, idx, setIdx, update, flash }) {
  const t = tickets[Math.min(idx, tickets.length - 1)];
  if (!t) return null;
  const s = STATUS[t.color] || STATUS.none;
  const btn = { display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontFamily: UI.font, fontSize: 13, padding: "7px 12px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.bg, color: UI.text };
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button style={{ ...btn, opacity: idx === 0 ? 0.4 : 1 }} onClick={() => idx > 0 && setIdx(idx - 1)}><ChevronLeft size={15} /> Prev</button>
        <span style={{ fontSize: 13, color: UI.muted }}>{idx + 1} / {tickets.length}</span>
        <button style={{ ...btn, opacity: idx === tickets.length - 1 ? 0.4 : 1 }} onClick={() => idx < tickets.length - 1 && setIdx(idx + 1)}>Next <ChevronRight size={15} /></button>
      </div>
      <div style={{ border: `1px solid ${UI.border}`, borderLeft: `4px solid ${s.line}`, borderRadius: 8, padding: 22 }}>
        <div style={{ fontSize: 12.5, color: UI.muted, marginBottom: 4 }}>#{t.id} · {t.customer || "Unassigned"} · {t.requester}</div>
        <h2 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 16px", lineHeight: 1.25 }}>{t.subject}</h2>
        <StatusButtons value={t.color} onChange={(c) => update(t.id, { color: c })} />
        <div style={{ marginTop: 18 }}>
          <Label>Summary</Label>
          <div style={{ color: t.summary ? UI.text : "#999", lineHeight: 1.6, fontSize: 14.5, fontStyle: t.summary ? "normal" : "italic" }}>
            {t.summary || "No summary yet. Open this ticket in table view to generate one."}
          </div>
        </div>
        <div style={{ marginTop: 18 }}>
          <Label>Resolution plan &amp; notes</Label>
          <Comments ticket={t} update={update} placeholder="What's the plan? Who's on it?" />
        </div>
      </div>
    </div>
  );
}

/* ---------- detail modal ---------- */
function Detail({ ticket, onClose, update, summaryPrompt, recordUsage, remove, flash }) {
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [rawView, setRawView] = useState(false);

  function deleteTicket() {
    if (window.confirm(`Delete ticket #${ticket.id}? It won't come back on the next Zendesk refresh.`)) {
      remove(ticket.id);
      onClose();
      flash(`Deleted ticket #${ticket.id}.`);
    }
  }

  async function summarize() {
    setBusy(true);
    try {
      let content = (ticket.emailDraft || "").trim();
      const thread = await fetchThread(ticket.id);
      if (thread) { content = thread.conversation || content; update(ticket.id, { emailDraft: thread.conversation, thread: thread.messages }); }
      const res = await getSummary(ticket.subject, content, summaryPrompt);
      if (res.summary) { update(ticket.id, { summary: res.summary }); recordUsage(res.usage); flash("Summary generated."); }
      else flash("No summary came back. Try again.");
    } catch (e) { flash("Summarize failed: " + e.message); }
    setBusy(false);
  }

  async function loadThread() {
    setLoadingThread(true);
    try {
      const thread = await fetchThread(ticket.id);
      if (thread) update(ticket.id, { emailDraft: thread.conversation, thread: thread.messages });
      else flash("Couldn't load the thread from Zendesk.");
    } catch (e) { flash("Thread load failed: " + e.message); }
    setLoadingThread(false);
  }
  const s = STATUS[ticket.color] || STATUS.none;
  const field = { width: "100%", padding: "9px 11px", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 14, color: UI.text, boxSizing: "border-box" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 20, overflowY: "auto", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(680px,100%)", background: UI.bg, borderRadius: 10, borderLeft: `4px solid ${s.line}`, boxShadow: "0 16px 50px rgba(0,0,0,.25)", marginTop: 10 }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${UI.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12.5, color: UI.muted, marginBottom: 4 }}>#{ticket.id} · {ticket.status} · {fmtDate(ticket.created)}</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, lineHeight: 1.25 }}>{ticket.subject}</h2>
          </div>
          <button onClick={onClose} style={{ cursor: "pointer", background: "none", border: "none", color: UI.muted }}><X size={20} /></button>
        </div>

        <div style={{ padding: 20, display: "grid", gap: 18 }}>
          <div>
            <Label>Customer</Label>
            <input value={ticket.customer} onChange={(e) => update(ticket.id, { customer: e.target.value })} placeholder="Company name" style={field} />
          </div>
          <div>
            <Label>Status / next action</Label>
            <StatusButtons value={ticket.color} onChange={(c) => update(ticket.id, { color: c })} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
              <Label noMargin>Summary</Label>
              <button onClick={summarize} disabled={busy} style={{ cursor: busy ? "default" : "pointer", fontFamily: UI.font, fontSize: 12.5, padding: "6px 11px", borderRadius: 6, border: `1px solid ${UI.text}`, background: UI.text, color: "#fff", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Summarizing..." : "Generate summary"}
              </button>
            </div>
            <textarea value={ticket.summary} onChange={(e) => update(ticket.id, { summary: e.target.value })} rows={5} placeholder="Generated summary appears here. Fully editable." style={{ ...field, lineHeight: 1.55, resize: "vertical" }} />
          </div>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: UI.muted }}>Conversation thread</summary>
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                <button onClick={loadThread} disabled={loadingThread}
                  style={{ cursor: loadingThread ? "default" : "pointer", fontFamily: UI.font, fontSize: 12.5, padding: "6px 11px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.bg, color: UI.text, opacity: loadingThread ? 0.6 : 1 }}>
                  {loadingThread ? "Loading..." : (ticket.thread && ticket.thread.length ? "Reload from Zendesk" : "Load full thread")}
                </button>
                {((ticket.thread && ticket.thread.length) || ticket.emailDraft) && (
                  <button onClick={() => setRawView((v) => !v)}
                    style={{ cursor: "pointer", fontFamily: UI.font, fontSize: 12.5, padding: "6px 11px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.bg, color: UI.muted }}>
                    {rawView ? "Chat view" : "Raw text"}
                  </button>
                )}
              </div>
              {rawView ? (
                <>
                  <textarea value={ticket.emailDraft} onChange={(e) => update(ticket.id, { emailDraft: e.target.value })} rows={8} placeholder="The full Zendesk thread loads here. You can also paste or edit it manually." style={{ ...field, lineHeight: 1.5, resize: "vertical", border: `1px dashed ${UI.border}` }} />
                  <div style={{ fontSize: 12, color: UI.muted, marginTop: 6 }}>This text is what gets summarized.</div>
                </>
              ) : ticket.thread && ticket.thread.length ? (
                <Thread messages={ticket.thread} />
              ) : (
                <div style={{ fontSize: 13, color: UI.muted, lineHeight: 1.5, padding: "4px 0" }}>
                  No thread loaded yet. Click "Load full thread" to pull it from Zendesk, or switch to Raw text to paste one in.
                </div>
              )}
            </div>
          </details>
          <div>
            <Label>Comments &amp; meeting notes</Label>
            <Comments ticket={ticket} update={update} placeholder="Add a note or resolution plan..." />
          </div>
          <div style={{ borderTop: `1px solid ${UI.borderSoft}`, paddingTop: 14, display: "flex", justifyContent: "flex-end" }}>
            <button onClick={deleteTicket}
              style={{ cursor: "pointer", fontFamily: UI.font, fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 6, border: `1px solid ${STATUS.red.line}`, background: STATUS.red.tint, color: STATUS.red.text, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Trash2 size={13} /> Delete ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- shared ---------- */
function Thread({ messages }) {
  if (!messages || !messages.length) {
    return <div style={{ fontSize: 13, color: UI.muted }}>This thread has no messages.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 8, maxHeight: 460, overflowY: "auto", padding: "2px 2px 4px" }}>
      {messages.map((m, i) => {
        const note = m.public === false;
        const customer = m.role === "customer";
        const bg = note ? "#fff7e0" : customer ? UI.panel : STATUS.blue.tint;
        const brd = note ? "#e6cf8a" : customer ? UI.borderSoft : STATUS.blue.line;
        const justify = note ? "center" : customer ? "flex-start" : "flex-end";
        const body = cleanText(m.body);
        return (
          <div key={i} style={{ display: "flex", justifyContent: justify }}>
            <div style={{ maxWidth: note ? "94%" : "82%", background: bg, border: `1px solid ${brd}`, borderRadius: 10, padding: "7px 11px" }}>
              <div style={{ fontSize: 11.5, color: UI.muted, marginBottom: 3, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, color: UI.text }}>{m.author || "Unknown"}</span>
                {note && <span style={{ color: "#9a7b1f", fontWeight: 600 }}>Internal note</span>}
                {m.when && <span>{fmtDateTime(m.when)}</span>}
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word", color: UI.text }}>
                {body || <span style={{ color: "#aaa", fontStyle: "italic" }}>(no text)</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusButtons({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      {ORDER.map((k) => {
        const s = STATUS[k]; const on = value === k;
        return (
          <button key={k} onClick={() => onChange(k)} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: UI.font, fontSize: 13, fontWeight: on ? 600 : 400, padding: "6px 12px", borderRadius: 6, border: `1.5px solid ${on ? s.line : UI.border}`, background: on ? s.tint : UI.bg, color: on ? s.text : UI.muted }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: s.line }} />{s.label}
          </button>
        );
      })}
    </div>
  );
}

function Comments({ ticket, update, placeholder }) {
  const [text, setText] = useState("");
  const list = ticket.comments || [];
  const add = () => { const v = text.trim(); if (!v) return; update(ticket.id, { comments: [...list, { id: Date.now(), text: v, at: new Date().toISOString() }] }); setText(""); };
  const field = { flex: 1, padding: "9px 11px", border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 13.5, color: UI.text, boxSizing: "border-box" };
  return (
    <div>
      {list.length > 0 && (
        <div style={{ display: "grid", gap: 7, marginBottom: 9 }}>
          {list.map((c) => (
            <div key={c.id} style={{ border: `1px solid ${UI.borderSoft}`, borderRadius: 6, padding: "8px 10px", display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{c.text}</div>
                <div style={{ fontSize: 11, color: UI.muted, marginTop: 3 }}>{new Date(c.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
              </div>
              <button onClick={() => update(ticket.id, { comments: list.filter((x) => x.id !== c.id) })} style={{ cursor: "pointer", background: "none", border: "none", color: "#aaa", alignSelf: "start" }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={placeholder} style={field} />
        <button onClick={add} style={{ cursor: "pointer", fontFamily: UI.font, fontSize: 13, padding: "9px 13px", borderRadius: 6, border: `1px solid ${UI.text}`, background: UI.text, color: "#fff", display: "inline-flex", alignItems: "center", gap: 5 }}><Plus size={15} /> Add</button>
      </div>
    </div>
  );
}

function Label({ children, noMargin }) {
  return <div style={{ fontSize: 12, color: UI.muted, fontWeight: 600, marginBottom: noMargin ? 0 : 7 }}>{children}</div>;
}
