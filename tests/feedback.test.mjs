import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import handler from "../api/feedback.ts";

// Stands in for Discord so the relay is exercised over a real request rather
// than a stubbed fetch.
async function withWebhook(run, { status = 204, envName = "DISCORD_WEBHOOK_URL" } = {}) {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(status).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const previous = process.env.DISCORD_WEBHOOK_URL;
  const previousVite = process.env.VITE_DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.VITE_DISCORD_WEBHOOK_URL;
  process.env[envName] = url;
  try {
    return await run(received);
  } finally {
    if (previous !== undefined) process.env.DISCORD_WEBHOOK_URL = previous;
    else delete process.env.DISCORD_WEBHOOK_URL;
    if (previousVite !== undefined) process.env.VITE_DISCORD_WEBHOOK_URL = previousVite;
    else delete process.env.VITE_DISCORD_WEBHOOK_URL;
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (body, headers = {}) => new Request("https://songless.test/api/feedback", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

test("feedback reaches the webhook with the round's song attached", async () => {
  await withWebhook(async (received) => {
    const response = await handler(post(
      { message: "Careless Whisper is the wrong version.", song: "Careless Whisper — George Michael (george-michael-careless-whisper)" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    assert.equal(response.status, 202);
    assert.equal(received.length, 1);
    assert.match(received[0].content, /Careless Whisper is the wrong version\./u);
    assert.match(received[0].content, /george-michael-careless-whisper/u);
  });
});

test("untrusted feedback cannot ping the channel", async () => {
  await withWebhook(async (received) => {
    const response = await handler(post(
      { message: "@everyone look at this" },
      { "x-forwarded-for": "203.0.113.11" },
    ));
    assert.equal(response.status, 202);
    assert.deepEqual(received[0].allowed_mentions, { parse: [] });
  });
});

test("an over-long message is trimmed below the Discord limit", async () => {
  await withWebhook(async (received) => {
    const response = await handler(post(
      { message: "x".repeat(5000) },
      { "x-forwarded-for": "203.0.113.12" },
    ));
    assert.equal(response.status, 202);
    assert.ok(received[0].content.length < 2000, `content was ${received[0].content.length} characters`);
  });
});

test("an empty message is rejected before the webhook is called", async () => {
  await withWebhook(async (received) => {
    const response = await handler(post({ message: "   " }, { "x-forwarded-for": "203.0.113.13" }));
    assert.equal(response.status, 400);
    assert.equal(received.length, 0);
  });
});

test("a VITE_ webhook name still delivers on the server", async () => {
  await withWebhook(async (received) => {
    const response = await handler(post({ message: "hello from vite name" }, { "x-forwarded-for": "203.0.113.16" }));
    assert.equal(response.status, 202);
    assert.equal(received.length, 1);
  }, { envName: "VITE_DISCORD_WEBHOOK_URL" });
});

test("a missing webhook reports unavailable rather than pretending to send", async () => {
  const previous = process.env.DISCORD_WEBHOOK_URL;
  const previousVite = process.env.VITE_DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.VITE_DISCORD_WEBHOOK_URL;
  try {
    const response = await handler(post({ message: "hello" }, { "x-forwarded-for": "203.0.113.14" }));
    assert.equal(response.status, 503);
  } finally {
    if (previous !== undefined) process.env.DISCORD_WEBHOOK_URL = previous;
    if (previousVite !== undefined) process.env.VITE_DISCORD_WEBHOOK_URL = previousVite;
  }
});

test("a rejecting webhook surfaces a delivery failure", async () => {
  await withWebhook(async () => {
    const response = await handler(post({ message: "hello" }, { "x-forwarded-for": "203.0.113.15" }));
    assert.equal(response.status, 502);
  }, { status: 500 });
});

test("a flood from one client is rate limited", async () => {
  await withWebhook(async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await handler(post({ message: `spam ${attempt}` }, { "x-forwarded-for": "203.0.113.99" }));
      statuses.push(response.status);
    }
    assert.equal(statuses.filter((status) => status === 202).length, 5);
    assert.equal(statuses.filter((status) => status === 429).length, 2);
  });
});

test("only POST is accepted", async () => {
  const response = await handler(new Request("https://songless.test/api/feedback", { method: "GET" }));
  assert.equal(response.status, 405);
});
