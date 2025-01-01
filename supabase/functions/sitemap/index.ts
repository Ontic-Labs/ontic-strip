import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE_URL = "https://onticstrip.com";

const STATIC_ROUTES = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/feed", changefreq: "hourly", priority: "0.9" },
  { path: "/stories", changefreq: "daily", priority: "0.9" },
  { path: "/claims", changefreq: "daily", priority: "0.8" },
  { path: "/leaderboard", changefreq: "daily", priority: "0.8" },

  { path: "/compare", changefreq: "weekly", priority: "0.6" },
  { path: "/search", changefreq: "weekly", priority: "0.5" },
  { path: "/publishers", changefreq: "daily", priority: "0.7" },
  { path: "/methodology", changefreq: "monthly", priority: "0.4" },
  { path: "/privacy", changefreq: "yearly", priority: "0.2" },
  { path: "/terms", changefreq: "yearly", priority: "0.2" },
];

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: documents } = await supabase
      .from("documents")
      .select("id, updated_at")
      .eq("pipeline_status", "aggregated")
      .order("updated_at", { ascending: false });

    const { data: stories } = await supabase
      .from("story_clusters")
      .select("id, updated_at")
      .order("updated_at", { ascending: false });

    const { data: feeds } = await supabase
      .from("feeds")
      .select("publisher_name, updated_at")
      .eq("is_active", true);

    // Deduplicate publishers (take most recent updated_at per name)
    const publisherMap = new Map<string, string>();
    for (const feed of feeds ?? []) {
      const existing = publisherMap.get(feed.publisher_name);
      if (!existing || feed.updated_at > existing) {
        publisherMap.set(feed.publisher_name, feed.updated_at);
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const route of STATIC_ROUTES) {
      xml += `  <url>\n    <loc>${BASE_URL}${route.path}</loc>\n    <changefreq>${route.changefreq}</changefreq>\n    <priority>${route.priority}</priority>\n  </url>\n`;
    }

    for (const doc of documents ?? []) {
      const lastmod = new Date(doc.updated_at).toISOString().split("T")[0];
      xml += `  <url>\n    <loc>${BASE_URL}/document/${doc.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    }

    for (const story of stories ?? []) {
      const lastmod = new Date(story.updated_at).toISOString().split("T")[0];
      xml += `  <url>\n    <loc>${BASE_URL}/stories/${story.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
    }

    for (const [name, updatedAt] of publisherMap) {
      const lastmod = new Date(updatedAt).toISOString().split("T")[0];
      xml += `  <url>\n    <loc>${BASE_URL}/publisher/${escapeXml(encodeURIComponent(name))}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    }

    xml += "</urlset>";

    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    });
  } catch (e) {
    console.error("sitemap error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
});
