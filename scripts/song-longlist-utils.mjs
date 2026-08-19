function normalizedHeader(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const LANGUAGE_REVIEWS = new Set(["pending", "english", "non_english", "multilingual"]);

export function languageReviewFor(value, fallback = "english") {
  const review = value ?? fallback;
  if (!LANGUAGE_REVIEWS.has(review)) {
    throw new Error(`Invalid languageReview: ${review}.`);
  }
  return review;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Founder playlist export contains an unterminated quoted value.");
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

export function parseFounderPlaylistExport(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/u, ""));
  if (rows.length < 2) throw new Error("Founder playlist export has no track rows.");
  const headers = rows[0].map(normalizedHeader);
  const titleIndex = headers.findIndex((header) => new Set(["track name", "title", "song"]).has(header));
  const artistIndex = headers.findIndex((header) => new Set(["artist name s", "artist name", "artist", "artists"]).has(header));
  if (titleIndex < 0 || artistIndex < 0) {
    throw new Error("Founder playlist export needs Track Name/Title and Artist Name(s)/Artist columns.");
  }
  return rows
    .slice(1)
    .map((cells) => ({ title: cells[titleIndex]?.trim(), artist: cells[artistIndex]?.trim() }))
    .filter((track) => track.title && track.artist && !/[\p{Script=Han}]/u.test(`${track.title} ${track.artist}`));
}
