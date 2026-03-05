import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function cleanRssContent(html: string): string {
  return html
    .replace(/<img[^>]*>/gi, "")
    .replace(/\(Image credit:[^)]*\)/gi, "")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function getTagContent(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? (m[1] || m[2] || "").trim() : null;
}

function parseRSSItems(xml: string): Array<{
  title: string;
  link: string;
  pubDate: string | null;
  author: string | null;
  description: string | null;
}> {
  const items: Array<any> = [];

  // Try RSS <item> format first
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const link = getTagContent(block, "link") || getTagContent(block, "guid") || "";
    if (!link) continue;
    items.push({
      title: decodeEntities(getTagContent(block, "title") || "Untitled"),
      link,
      pubDate: getTagContent(block, "pubDate") || null,
      author: getTagContent(block, "dc:creator") || getTagContent(block, "author") || null,
      description: getTagContent(block, "description") || getTagContent(block, "content:encoded") || null,
    });
  }

  // If no RSS items found, try Atom <entry> format
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      // Atom <link> is self-closing: <link rel="alternate" href="..." />
      const linkMatch = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/) ||
                        block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
      const link = linkMatch?.[1] || "";
      if (!link) continue;

      const authorMatch = block.match(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/);
      items.push({
        title: decodeEntities(getTagContent(block, "title") || "Untitled"),
        link,
        pubDate: getTagContent(block, "published") || getTagContent(block, "updated") || null,
        author: authorMatch?.[1]?.trim() || null,
        description: getTagContent(block, "summary") || getTagContent(block, "content") || null,
      });
    }
  }

  return items;
}

async function collectFeed(
  supabase: any,
  feed: { id: string; url: string; publisher_name: string },
  maxItems: number
): Promise<{ collected: number; errors: string[] }> {
  const errors: string[] = [];
  let totalCollected = 0;

  const rssResp = await fetch(feed.url, {
    headers: { "User-Agent": "OnticStrip/1.0 (+https://onticstrip.com)" },
  });
  if (!rssResp.ok) {
    return { collected: 0, errors: [`${feed.publisher_name}: HTTP ${rssResp.status}`] };
  }

  const xml = await rssResp.text();
  const rssItems = parseRSSItems(xml).slice(0, maxItems);

  for (const item of rssItems) {
    try {
      if (!item.link) continue;

      const { data: existing } = await supabase
        .from("documents")
        .select("id")
        .eq("url", item.link)
        .limit(1)
        .single();

      if (existing) continue;

      const rawContent = item.description ? cleanRssContent(item.description) : null;
      const wordCount = rawContent
        ? rawContent.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length
        : 0;
      const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;

      const doc = {
        feed_id: feed.id,
        url: item.link,
        title: item.title,
        published_at: publishedAt,
        author: item.author,
        raw_content: rawContent,
        normalized_content: null,
        word_count: wordCount || null,
        fetch_status: rawContent ? "fetched" : "pending",
        pipeline_status: rawContent ? "normalizing" : "pending",
      };

      const { data: insertedDoc, error: insertErr } = await supabase.from("documents").insert(doc).select("id").single();
      if (insertErr) {
        errors.push(`${item.link}: ${insertErr.message}`);
      } else {
        totalCollected++;
        if (insertedDoc?.id) {
          try {
            const { data: enqueued, error: enqueueErr } = await supabase.rpc("enqueue_graphile_stage_job", {
              p_doc_id: insertedDoc.id,
              p_stage: "NORMALIZE",
              p_status_token: "normalizing",
              p_attempt: 1,
            });

            if (enqueueErr) {
              errors.push(`${item.link}: enqueue failed (${enqueueErr.message})`);
              console.warn(`Queue enqueue RPC failed for ${insertedDoc.id}:`, enqueueErr.message);
            } else if (enqueued !== true) {
              errors.push(`${item.link}: enqueue_graphile_stage_job returned false`);
              console.warn(`Queue enqueue returned false for ${insertedDoc.id}`);
            }
          } catch (qErr) {
            errors.push(`${item.link}: enqueue failed (${qErr instanceof Error ? qErr.message : String(qErr)})`);
            console.warn(`Queue enqueue failed for ${insertedDoc.id}:`, qErr);
          }
        }
      }
    } catch (e) {
      errors.push(`${item.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Update last_polled_at
  await supabase
    .from("feeds")
    .update({ last_polled_at: new Date().toISOString() })
    .eq("id", feed.id);

  return { collected: totalCollected, errors };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient<any>(supabaseUrl, serviceRoleKey);

    const { feed_id, max_items } = await req.json().catch(() => ({ feed_id: null, max_items: 10 }));
    const itemLimit = max_items || 10;

    // --- Single feed mode ---
    if (feed_id) {
      const { data: feed, error: feedErr } = await supabase
        .from("feeds")
        .select("id, url, publisher_name")
        .eq("id", feed_id)
        .single();

      if (feedErr || !feed) {
        return new Response(
          JSON.stringify({ error: "Feed not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const result = await collectFeed(supabase, feed, itemLimit);
      console.log(`RSS collector: ${result.collected} from ${feed.publisher_name}`);

      return new Response(
        JSON.stringify({
          collected: result.collected,
          feed: feed.publisher_name,
          errors: result.errors.length ? result.errors : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Bulk mode: poll all active feeds due for refresh ---
    const { data: feeds, error: feedsErr } = await supabase
      .from("feeds")
      .select("id, url, publisher_name, polling_interval_minutes, last_polled_at")
      .eq("is_active", true);

    if (feedsErr || !feeds) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch feeds" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const dueFeeds = feeds.filter((f) => {
      if (!f.last_polled_at) return true;
      const elapsed = now - new Date(f.last_polled_at).getTime();
      return elapsed >= (f.polling_interval_minutes || 15) * 60 * 1000;
    });

    if (dueFeeds.length === 0) {
      return new Response(
        JSON.stringify({ message: "No feeds due for polling", totalFeeds: feeds.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalCollected = 0;
    const allErrors: string[] = [];
    const feedResults: Array<{ feed: string; collected: number }> = [];

    // Process feeds sequentially to stay within timeout (max ~10 feeds per cycle)
    const batch = dueFeeds.slice(0, 10);
    for (const feed of batch) {
      try {
        const result = await collectFeed(supabase, feed, itemLimit);
        totalCollected += result.collected;
        allErrors.push(...result.errors);
        if (result.collected > 0) {
          feedResults.push({ feed: feed.publisher_name, collected: result.collected });
        }
      } catch (e) {
        allErrors.push(`${feed.publisher_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`RSS bulk poll: ${totalCollected} articles from ${batch.length} feeds`);

    return new Response(
      JSON.stringify({
        collected: totalCollected,
        feedsPolled: batch.length,
        feedsDue: dueFeeds.length,
        feedResults: feedResults.length ? feedResults : undefined,
        errors: allErrors.length ? allErrors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("RSS collector error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
