/** Title matching helpers shared by every provider. */

export function normalizeTitle(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(value) {
  return new Set(normalizeTitle(value).split(" ").filter(Boolean));
}

/**
 * Score how well a candidate title matches the wanted title.
 * 100 = exact, then partial token overlap, penalties for extra noise.
 */
export function titleScore(candidate, wanted) {
  const a = normalizeTitle(candidate);
  const b = normalizeTitle(wanted);
  if (!a || !b) return 0;
  if (a === b) return 100;

  const tokensA = titleTokens(candidate);
  const tokensB = titleTokens(wanted);
  let shared = 0;
  for (const token of tokensB) if (tokensA.has(token)) shared += 1;
  const coverage = shared / Math.max(tokensB.size, 1);

  let score = coverage * 70;
  if (a.startsWith(b) || b.startsWith(a)) score += 14;
  if (a.includes(b) || b.includes(a)) score += 8;
  if (tokensA.size > tokensB.size * 2) score -= 10;
  return Math.max(0, Math.round(score));
}

export function yearOf(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

export function pickBest(candidates, wanted, { type, year, typeOf } = {}) {
  let best = null;
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.title) continue;
    let score = titleScore(candidate.title, wanted);
    if (score < 45) continue;

    if (type && typeof typeOf === "function") {
      const candidateType = typeOf(candidate);
      if (candidateType === type) score += 12;
      else score -= 20;
    }

    const candidateYear = yearOf(candidate.year || candidate.releaseDate || candidate.publishTime);
    if (year && candidateYear) {
      const delta = Math.abs(Number(year) - candidateYear);
      if (delta === 0) score += 16;
      else if (delta <= 1) score += 8;
      else if (delta > 6) score -= 12;
    }

    if (!best || score > best.score) best = { item: candidate, score };
  }
  return best && best.score >= 45 ? best.item : null;
}
