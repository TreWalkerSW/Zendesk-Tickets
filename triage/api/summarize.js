// api/summarize.js
// Generates a ticket summary server-side so the Anthropic key never reaches the
// browser. Requires a valid session. Reads { subject, content } and returns
// { summary }.
//
// Env vars:
//   ANTHROPIC_API_KEY   your key (kept server-side)
//   ANTHROPIC_MODEL     optional, defaults to claude-sonnet-4-6
//
// NOTE: SUMMARY_PROMPT below mirrors the SUMMARY_PROMPT constant in App.jsx.
// If you edit one, edit the other (or factor it into a shared module both import).

import { requireAuth, readJsonBody } from "../lib/auth.js";

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

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured." });
    return;
  }

  try {
    const { subject = "", content = "", prompt = "" } = await readJsonBody(req);
    const instructions = (typeof prompt === "string" && prompt.trim()) ? prompt.trim() : SUMMARY_PROMPT;
    const log = content && content.trim()
      ? content.trim()
      : "(No conversation thread was provided. Treat the ticket subject as the only available detail and keep the summary brief; do not invent a thread that was not given.)";
    const fullPrompt = `${instructions}\n\nTicket subject: ${subject}\n\nMessage log:\n${log}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: fullPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const summary = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const u = d.usage || {};
    res.status(200).json({
      summary,
      usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 },
      model: d.model || "",
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
