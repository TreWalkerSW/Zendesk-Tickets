// api/ticket.js
// Returns the full comment thread for one ticket as a plain transcript:
//   { conversation: "Name (date): message\n\nName (date): reply\n..." }
// Optional but recommended: the summarizer produces much better output from a
// full thread than from the one-line ticket description. Call this when a user
// opens a ticket or clicks "Generate summary" (see wiring note in README).

import { requireAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;

  const id = String((req.query && req.query.id) || "").replace(/[^0-9]/g, "");
  if (!id) {
    res.status(400).json({ error: "Missing ticket id" });
    return;
  }

  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_TOKEN || process.env.ZENDESK_API_TOKEN;
  if (!subdomain || !email || !token) {
    res.status(500).json({ error: "Zendesk env vars are not configured." });
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64");
  const base = `https://${subdomain}.zendesk.com/api/v2`;
  const headers = { Authorization: authHeader };

  try {
    const cr = await fetch(`${base}/tickets/${id}/comments.json?sort_order=asc`, { headers });
    if (!cr.ok) throw new Error(`Zendesk comments ${cr.status}: ${(await cr.text()).slice(0, 200)}`);
    const cd = await cr.json();
    const comments = cd.comments || [];

    // Who is the customer? The ticket requester. Used to put their messages on
    // the customer side; everyone else (agents/admins) goes on the support side.
    let requesterId = null;
    try {
      const tr = await fetch(`${base}/tickets/${id}.json`, { headers });
      if (tr.ok) {
        const td = await tr.json();
        requesterId = (td.ticket && td.ticket.requester_id) || null;
      }
    } catch (e) { /* role still falls back to the user's Zendesk role below */ }

    // Resolve author name + role for each comment author.
    const ids = [...new Set(comments.map((c) => c.author_id).filter(Boolean))];
    const users = {};
    if (ids.length) {
      const ur = await fetch(`${base}/users/show_many.json?ids=${ids.join(",")}`, { headers });
      if (ur.ok) {
        const ud = await ur.json();
        for (const u of ud.users || []) {
          users[u.id] = { name: u.name || u.email || `User ${u.id}`, role: u.role || "" };
        }
      }
    }

    // Decode HTML entities and strip tags/extra whitespace that Zendesk bodies carry.
    const ENT = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&mdash;": "\u2014", "&ndash;": "\u2013", "&hellip;": "\u2026", "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&rdquo;": "\u201D", "&ldquo;": "\u201C", "&copy;": "\u00A9", "&reg;": "\u00AE", "&trade;": "\u2122" };
    const codePoint = (n) => { try { return String.fromCodePoint(n); } catch (e) { return ""; } };
    const clean = (s) =>
      String(s || "")
        .replace(/\r\n?/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
        .replace(/&[a-zA-Z]+;/g, (m) => (ENT[m] != null ? ENT[m] : m))
        .replace(/\u00a0/g, " ")
        .split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const messages = comments.map((c) => {
      const u = users[c.author_id] || {};
      const isCustomer = (requesterId && c.author_id === requesterId) || u.role === "end-user";
      return {
        author: u.name || `User ${c.author_id}`,
        role: isCustomer ? "customer" : "agent",
        when: c.created_at || "",
        public: c.public !== false,
        body: clean(c.plain_body || c.body || ""),
      };
    });

    // Plain-text transcript for the summarizer.
    const transcript = messages
      .map((m) => {
        const tag = m.public ? "" : " [internal note]";
        const when = m.when ? new Date(m.when).toLocaleString() : "";
        return `${m.author}${tag} (${when}):\n${m.body}`;
      })
      .join("\n\n");

    res.status(200).json({ conversation: transcript, messages });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
