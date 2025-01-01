// =============================================================
// Entity & Geo normalization for deterministic EventKey generation.
// =============================================================

/**
 * Common entity alias mappings for canonicalization.
 * Keys are lowercase normalized forms, values are canonical names.
 */
const ENTITY_ALIASES: Record<string, string> = {
  // Countries
  "us": "united states",
  "usa": "united states",
  "u.s.": "united states",
  "u.s.a.": "united states",
  "america": "united states",
  "uk": "united kingdom",
  "u.k.": "united kingdom",
  "britain": "united kingdom",
  "great britain": "united kingdom",
  "uae": "united arab emirates",
  "u.a.e.": "united arab emirates",
  "eu": "european union",
  "e.u.": "european union",
  "prc": "china",
  "peoples republic of china": "china",
  "people's republic of china": "china",
  "dprk": "north korea",
  "rok": "south korea",
  "ksa": "saudi arabia",

  // Leaders & politicians (common aliases)
  "biden": "joe biden",
  "joseph biden": "joe biden",
  "joseph r. biden": "joe biden",
  "president biden": "joe biden",
  "trump": "donald trump",
  "donald j. trump": "donald trump",
  "president trump": "donald trump",
  "netanyahu": "benjamin netanyahu",
  "bibi": "benjamin netanyahu",
  "pm netanyahu": "benjamin netanyahu",
  "putin": "vladimir putin",
  "xi": "xi jinping",
  "xi jinping": "xi jinping",
  "zelensky": "volodymyr zelensky",
  "zelenskyy": "volodymyr zelensky",
  "macron": "emmanuel macron",
  "starmer": "keir starmer",
  "scholz": "olaf scholz",
  "modi": "narendra modi",

  // Institutions
  "pentagon": "us department of defense",
  "dod": "us department of defense",
  "state department": "us department of state",
  "state dept": "us department of state",
  "white house": "white house",
  "scotus": "supreme court of the united states",
  "supreme court": "supreme court of the united states",
  "fed": "federal reserve",
  "the fed": "federal reserve",
  "federal reserve": "federal reserve",
  "nato": "nato",
  "un": "united nations",
  "u.n.": "united nations",
  "who": "world health organization",
  "w.h.o.": "world health organization",
  "imf": "international monetary fund",
  "i.m.f.": "international monetary fund",
  "icc": "international criminal court",
  "centcom": "us central command",
  "u.s. central command": "us central command",
  "u.s. central command (centcom)": "us central command",
  "epa": "environmental protection agency",
  "fbi": "federal bureau of investigation",
  "cia": "central intelligence agency",
  "nsa": "national security agency",
  "dhs": "department of homeland security",
};

/**
 * Geo normalization: maps common free-text geography to canonical ISO-ish codes.
 */
const GEO_CANONICAL: Record<string, string> = {
  "united states": "US",
  "usa": "US",
  "u.s.": "US",
  "us": "US",
  "america": "US",
  "washington": "US-DC",
  "washington dc": "US-DC",
  "washington d.c.": "US-DC",
  "new york": "US-NY",
  "california": "US-CA",
  "florida": "US-FL",
  "texas": "US-TX",
  "united kingdom": "GB",
  "uk": "GB",
  "london": "GB-LDN",
  "france": "FR",
  "paris": "FR-PAR",
  "germany": "DE",
  "berlin": "DE-BER",
  "china": "CN",
  "beijing": "CN-BEI",
  "shanghai": "CN-SHA",
  "russia": "RU",
  "moscow": "RU-MOW",
  "ukraine": "UA",
  "kyiv": "UA-KYV",
  "israel": "IL",
  "jerusalem": "IL-JER",
  "tel aviv": "IL-TLV",
  "iran": "IR",
  "tehran": "IR-THR",
  "iraq": "IQ",
  "baghdad": "IQ-BGD",
  "syria": "SY",
  "damascus": "SY-DAM",
  "lebanon": "LB",
  "beirut": "LB-BEY",
  "saudi arabia": "SA",
  "riyadh": "SA-RUH",
  "turkey": "TR",
  "ankara": "TR-ANK",
  "istanbul": "TR-IST",
  "india": "IN",
  "new delhi": "IN-DEL",
  "mumbai": "IN-BOM",
  "japan": "JP",
  "tokyo": "JP-TYO",
  "south korea": "KR",
  "seoul": "KR-SEL",
  "north korea": "KP",
  "taiwan": "TW",
  "taipei": "TW-TPE",
  "australia": "AU",
  "canada": "CA",
  "mexico": "MX",
  "brazil": "BR",
  "egypt": "EG",
  "cairo": "EG-CAI",
  "gaza": "PS-GZA",
  "west bank": "PS-WBK",
  "palestine": "PS",
  "middle east": "MENA",
  "european union": "EU",
  "global": "GLOBAL",
  "worldwide": "GLOBAL",
  "nationwide": "US",
  "nationwide u.s.": "US",
};

/**
 * Normalize an entity string: lowercase, strip punctuation, apply alias mapping.
 */
export function normalizeEntity(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.toLowerCase().trim().replace(/[.,;:!?"'()[\]{}]/g, "").replace(/\s+/g, " ");
  return ENTITY_ALIASES[cleaned] || cleaned;
}

/**
 * Normalize a geography string to a canonical code.
 * Tries exact match first, then prefix match on the first meaningful word.
 */
export function normalizeGeo(raw: string | string[] | null): string {
  if (!raw) return "unknown";
  // Handle array geo values (some LLM outputs are arrays)
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "unknown";
    return normalizeGeo(raw[0]);
  }
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.toLowerCase().trim().replace(/[.,;:!?"'()[\]{}]/g, "").replace(/\s+/g, " ");

  // Exact match
  if (GEO_CANONICAL[cleaned]) return GEO_CANONICAL[cleaned];

  // Try extracting first city/country from comma-separated or compound geo
  const parts = cleaned.split(/[,/&]+/).map(p => p.trim());
  for (const part of parts) {
    if (GEO_CANONICAL[part]) return GEO_CANONICAL[part];
  }

  // Fallback: return cleaned text
  return cleaned || "unknown";
}

/**
 * Deduplicate and sort entities after normalization, keeping top N by frequency.
 */
export function deduplicateEntities(entities: string[], topN = 5): string[] {
  const counts = new Map<string, number>();
  for (const e of entities) {
    const norm = normalizeEntity(e);
    if (norm.length < 2) continue; // skip very short/empty
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([entity]) => entity);
}

/**
 * Floor a timestamp to the nearest 6-hour bucket.
 */
export function floorToTimeBucket(date: Date): string {
  const d = new Date(date);
  const hours = Math.floor(d.getUTCHours() / 6) * 6;
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

/**
 * Compute Jaccard similarity between two string arrays.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
