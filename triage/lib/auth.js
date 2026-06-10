// lib/auth.js
// Auth is delegated to Supabase. The browser signs in directly with Supabase and
// gets a JWT (access token). It sends that token as `Authorization: Bearer <token>`
// on every call to our API. Here we verify the token with Supabase before serving
// any data, so the only way to reach the protected endpoints is with a valid
// Supabase session.
//
// Env vars required (server-side):
//   SUPABASE_URL        e.g. https://abcdxyz.supabase.co
//   SUPABASE_ANON_KEY   the project's public anon key (safe to expose)

import { createClient } from "@supabase/supabase-js";

let _client = null;
function client() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not set.");
  if (!_client) {
    _client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _client;
}

function bearerToken(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Protected-route guard. Verifies the Supabase access token and returns the user,
// or sends 401/500 and returns null. Usage in a route:
//   const user = await requireAuth(req, res); if (!user) return;
export async function requireAuth(req, res) {
  try {
    const token = bearerToken(req);
    if (!token) { res.status(401).json({ error: "Not authenticated" }); return null; }
    const { data, error } = await client().auth.getUser(token);
    if (error || !data || !data.user) {
      res.status(401).json({ error: "Invalid or expired session" });
      return null;
    }
    return data.user;
  } catch (e) {
    res.status(500).json({ error: "Auth check failed: " + (e.message || String(e)) });
    return null;
  }
}

// Body parser that works whether or not Vercel pre-parsed req.body.
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
