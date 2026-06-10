// api/zendesk.js
// Returns unsolved tickets in the shape the frontend expects:
//   { tickets: [{ id, subject, created, status, requester, conversation }] }
// Requires a valid session — unauthenticated callers get 401, so hitting this
// URL directly no longer exposes your tickets.
//
// Env vars required:
//   ZENDESK_SUBDOMAIN   e.g. "acme"  (from acme.zendesk.com)
//   ZENDESK_EMAIL       the agent email used for API access
//   ZENDESK_API_TOKEN   an API token from Admin > Apps and integrations > APIs

import { requireAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;

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
    // 1) Search for unsolved tickets (paginated, capped at 5 pages = 500 tickets).
    const raw = [];
    let url = `${base}/search.json?query=${encodeURIComponent("type:ticket status<solved")}&sort_by=created_at&sort_order=desc`;
    let pages = 0;
    while (url && pages < 5) {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`Zendesk search ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      for (const t of d.results || []) {
        if (t.result_type && t.result_type !== "ticket") continue;
        raw.push(t);
      }
      url = d.next_page || null;
      pages++;
    }

    // 2) Resolve requester names + emails in bulk (one call per 100 ids).
    const ids = [...new Set(raw.map((t) => t.requester_id).filter(Boolean))];
    const userMap = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const ur = await fetch(`${base}/users/show_many.json?ids=${chunk.join(",")}`, { headers });
      if (ur.ok) {
        const ud = await ur.json();
        for (const u of ud.users || []) userMap[u.id] = { name: u.name || "", email: u.email || "" };
      }
    }

    const tickets = raw.map((t) => {
      const u = userMap[t.requester_id] || {};
      return {
        id: String(t.id),
        subject: t.subject || t.raw_subject || "",
        created: t.created_at || "",
        status: t.status || "",
        // Name for display in the Requester column (falls back to email).
        requester: u.name || u.email || "",
        // Email is used by the frontend to derive the customer/company name.
        email: u.email || "",
        // The ticket description is the first message. For the full thread used by
        // the summarizer, call /api/ticket?id=<id> (see api/ticket.js).
        conversation: t.description || "",
      };
    });

    res.status(200).json({ tickets });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
