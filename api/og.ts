// @ts-nocheck — Runs in Vercel's Node.js serverless runtime, not the Vite build.
/**
 * Vercel Serverless Function — /api/og
 *
 * Returns an HTML shell with route-specific OpenGraph meta tags for social
 * crawlers. The Vercel Edge Middleware (middleware.ts) rewrites bot requests
 * here so that Twitter, Facebook, Slack, etc. see correct per-page OG tags
 * without needing SSR for the full React app.
 *
 * For dynamic pages (documents, stories, publishers) the function queries
 * Supabase to build the title/description. For static pages it uses a
 * hard-coded map.
 */

import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SITE_NAME = "Ontic Strip";
const BASE_URL = "https://onticstrip.com";
const DEFAULT_DESC =
  "Ontic Strip analyzes news articles for factual grounding, claim veracity, and editorial integrity using multi-stage AI pipelines.";
const OG_IMAGE = `${BASE_URL}/og-default.png`;

// Static route metadata
const STATIC_ROUTES: Record<string, { title: string; description: string }> = {
  "/": {
    title: "Ontic Strip — Real-Time News Integrity Analysis",
    description: DEFAULT_DESC,
  },
  "/feed": {
    title: "Feed | Ontic Strip",
    description:
      "Real-time integrity analysis of ingested articles, grouped by publisher with grounding and integrity scores.",
  },
  "/leaderboard": {
    title: "Publisher Leaderboard | Ontic Strip",
    description:
      "Publishers ranked by evidence-backed reporting quality, with grounding and integrity scores over 7-day and 30-day periods.",
  },
  "/docs": {
    title: "Documentation | Ontic Strip",
    description:
      "Technical reference — methodology, tech stack, and prompt architecture for Ontic Strip's news analysis pipeline.",
  },
  "/methodology": {
    title: "Methodology | Ontic Strip",
    description:
      "How Ontic Strip analyzes news articles — the 10-stage pipeline, proposition-based IRT ideology scoring, MBFC-inspired factuality, and full mathematical specification.",
  },
  "/stories": {
    title: "Stories | Ontic Strip",
    description:
      "Multi-source story clusters showing how different publishers cover the same events.",
  },
  "/publishers": {
    title: "Publishers | Ontic Strip",
    description: "Browse all tracked publishers with integrity baselines and scoring history.",
  },
  "/compare": {
    title: "Compare Publishers | Ontic Strip",
    description:
      "Compare up to 3 publishers side by side on integrity metrics, grounding scores, and segment label distributions.",
  },
  "/claims": {
    title: "Claim Search | Ontic Strip",
    description: "Search and explore extracted claims across all analyzed articles.",
  },
  "/trending": {
    title: "Trending Claims | Ontic Strip",
    description:
      "Claims trending across multiple sources, ranked by recurrence and veracity divergence.",
  },
  "/privacy": {
    title: "Privacy Policy | Ontic Strip",
    description: "Ontic Strip privacy policy.",
  },
  "/terms": {
    title: "Terms of Service | Ontic Strip",
    description: "Ontic Strip terms of service.",
  },
};

function html(
  title: string,
  description: string,
  url: string,
  ogType = "website",
  image = OG_IMAGE,
) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(url)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(url)}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:site_name" content="${SITE_NAME}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(image)}" />
</head>
<body></body>
</html>`;
}

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = (req.query.path as string) || "/";
  const url = `${BASE_URL}${path}`;

  // 1. Check static routes
  const staticMeta = STATIC_ROUTES[path];
  if (staticMeta) {
    return res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("Cache-Control", "public, s-maxage=3600")
      .status(200)
      .send(html(staticMeta.title, staticMeta.description, url));
  }

  // 2. Dynamic routes — need Supabase
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .status(200)
      .send(html(`${SITE_NAME}`, DEFAULT_DESC, url));
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // /document/:id
  const docMatch = path.match(/^\/document\/([a-f0-9-]+)$/);
  if (docMatch) {
    const { data } = await supabase
      .from("documents")
      .select("title, synthesis_text, feeds(name)")
      .eq("id", docMatch[1])
      .single();

    if (data) {
      const title = `${data.title ?? "Document Analysis"} | ${SITE_NAME}`;
      const desc =
        data.synthesis_text?.slice(0, 160) ??
        `Integrity analysis of ${data.title ?? "this article"}.`;
      return res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Cache-Control", "public, s-maxage=600")
        .status(200)
        .send(html(title, desc, url, "article"));
    }
  }

  // /stories/:id
  const storyMatch = path.match(/^\/stories\/([a-f0-9-]+)$/);
  if (storyMatch) {
    const { data } = await supabase
      .from("story_clusters")
      .select("title, summary")
      .eq("id", storyMatch[1])
      .single();

    if (data) {
      const title = `${data.title ?? "Event Detail"} | ${SITE_NAME}`;
      const desc = data.summary?.slice(0, 160) ?? "Multi-source event coverage.";
      return res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Cache-Control", "public, s-maxage=600")
        .status(200)
        .send(html(title, desc, url, "article"));
    }
  }

  // /publishers/:slug
  const pubMatch = path.match(/^\/publishers\/(.+)$/);
  if (pubMatch) {
    const slug = decodeURIComponent(pubMatch[1]);
    const { data } = await supabase
      .from("feeds")
      .select("name, description")
      .eq("slug", slug)
      .single();

    if (data) {
      const title = `${data.name} | ${SITE_NAME}`;
      const desc =
        data.description?.slice(0, 160) ??
        `Integrity analysis and scoring history for ${data.name}.`;
      return res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Cache-Control", "public, s-maxage=3600")
        .status(200)
        .send(html(title, desc, url));
    }
  }

  // Fallback
  return res
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "public, s-maxage=3600")
    .status(200)
    .send(html(SITE_NAME, DEFAULT_DESC, url));
}
