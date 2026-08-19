import { readFileSync } from "fs";

const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  throw new Error("Missing Spotify credentials");
}

async function run() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const value = await response.json();
  if (!response.ok || !value.access_token) {
      throw new Error(`Token failed: ${response.status} ${JSON.stringify(value)}`);
  }
  const token = value.access_token;
  
  const query = encodeURIComponent(`track:Blinding Lights artist:The Weeknd`);
  const search = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=10&market=CA`, {
      headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!search.ok) {
      let body = "";
      try { body = await search.text(); } catch (e) {}
      throw new Error(`Search failed: ${search.status} ${body}`);
  }
  
  const data = await search.json();
  console.log(`Smoke test success! HTTP 200. Found ${data.tracks?.items?.length} tracks.`);
  console.log(`First track: ${data.tracks?.items[0]?.name} by ${data.tracks?.items[0]?.artists[0]?.name}`);
}

run().catch(console.error);
