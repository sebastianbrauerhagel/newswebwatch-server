// Matching logic — ported verbatim in spirit from the original client-side matcher.
//
// CRITICAL: a keyword matches ONLY when it equals the message's issuerSign (ticker)
// EXACTLY. We never substring-match the title. This is the bug we hit before, where
// ticker "RING" matched the word "plasseRING" inside an unrelated title.

// Returns the array of desk keys that match this message.
export function matchDesks(msg, desks) {
  const issuer = (msg.issuerSign || '').toUpperCase().trim();
  if (!issuer) return [];

  // ignoreWords are checked as substrings against the combined text, same as before.
  const fullText = `${msg.title || ''} ${msg.issuerSign || ''} ${msg.issuerName || ''}`.toLowerCase();

  const matched = [];
  for (const desk of Object.values(desks)) {
    // keywords are pre-uppercased in config.loadDesks(); compare exactly.
    const tickerHit = desk.keywords.includes(issuer);
    if (!tickerHit) continue;

    const ignored = desk.ignoreWords.some((w) => fullText.includes(w));
    if (ignored) continue;

    matched.push(desk.key);
  }
  return matched;
}
