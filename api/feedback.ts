// Feedback relay. The Discord webhook URL stays on the server: a `VITE_`
// variable is inlined into the client bundle, and anyone reading it could post
// to, or delete, the channel. Everything below treats the message as hostile
// public input.

import type { IncomingMessage, ServerResponse } from "node:http";

// Discord rejects payloads over 2000 characters, and the heading needs room.
const messageLimit = 1800;
const contextLimit = 200;

// Serverless instances are not shared, so this only blunts naive flooding from
// a single client. It is not a substitute for a platform rate limit.
const windowMs = 60_000;
const maxPerWindow = 5;
const recentPosts = new Map<string, number[]>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentPosts.get(key) ?? []).filter((at) => now - at < windowMs);
  hits.push(now);
  recentPosts.set(key, hits);
  if (recentPosts.size > 500) {
    for (const [entry, times] of recentPosts) {
      if (times.every((at) => now - at >= windowMs)) recentPosts.delete(entry);
    }
  }
  return hits.length > maxPerWindow;
}

function readText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function webhookUrl(): string {
  // DISCORD_WEBHOOK_URL is the documented name. A VITE_ copy is accepted only
  // as a server-side fallback so an already-deployed project env still works;
  // it must never be read from the client bundle.
  return (process.env.DISCORD_WEBHOOK_URL || process.env.VITE_DISCORD_WEBHOOK_URL || "").trim();
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = `https://${host}${req.url ?? "/api/feedback"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

export async function handleFeedback(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);

  const hook = webhookUrl();
  if (!hook) {
    console.error("DISCORD_WEBHOOK_URL is not set, so feedback cannot be delivered.");
    return json({ error: "Feedback is not configured yet." }, 503);
  }

  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(client)) return json({ error: "Too many messages. Try again shortly." }, 429);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Send a JSON body." }, 400);
  }

  const body = payload as Record<string, unknown> | null;
  const message = readText(body?.message, messageLimit);
  if (!message) return json({ error: "The message is empty." }, 400);

  // Song-specific reports are the common case, so carry the round's song.
  const song = readText(body?.song, contextLimit);
  const lines = ["**New Songless feedback**"];
  if (song) lines.push(`Current song: ${song}`);
  lines.push("", message);

  let response: Response;
  try {
    response = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: lines.join("\n"),
        // Untrusted text must never be able to ping the channel.
        allowed_mentions: { parse: [] },
      }),
    });
  } catch (error) {
    console.error("The Discord webhook could not be reached.", error);
    return json({ error: "Feedback could not be delivered." }, 502);
  }

  if (!response.ok) {
    console.error(`Discord rejected the feedback with ${response.status}.`);
    return json({ error: "Feedback could not be delivered." }, 502);
  }

  return json({ ok: true }, 202);
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Vercel may invoke this as a Web Request handler or as Node (req, res).
export default async function handler(
  requestOrReq: Request | IncomingMessage,
  res?: ServerResponse,
): Promise<Response | void> {
  const request = requestOrReq instanceof Request ? requestOrReq : await toWebRequest(requestOrReq);
  const response = await handleFeedback(request);
  if (res) {
    await writeNodeResponse(res, response);
    return;
  }
  return response;
}

export { handler as POST };
