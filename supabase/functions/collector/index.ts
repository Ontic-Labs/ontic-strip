import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INOREADER_API = "https://www.inoreader.com/reader/api/0";

function cleanRssContent(html: string): string {
  return html
    .replace(/<img[^>]*>/gi, "")
    .replace(/\(Image credit:[^)]*\)/gi, "")
    .trim();
}

// --------------- Inoreader Token Management ---------------

async function getValidToken(supabase: any): Promise<string | null> {
  const { data: tokenRow } = await supabase
    .from("inoreader_tokens")
    .select("*")
    .limit(1)
    .single();

  if (!tokenRow) return null;

  const expiresAt = new Date(tokenRow.expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const appId = Deno.env.get("INOREADER_APP_ID")!;
    const appKey = Deno.env.get("INOREADER_APP_KEY")!;

    const body = new URLSearchParams({
      client_id: appId,
      client_secret: appKey,
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token,
    });

    const resp = await fetch("https://www.inoreader.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      console.error("Token refresh failed:", await resp.text());
      return null;
    }

    const tokens = await resp.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase.from("inoreader_tokens").update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: newExpiresAt,
    }).eq("id", tokenRow.id);

    return tokens.access_token;
  }

  return tokenRow.access_token;
}

// --------------- Inoreader API helpers ---------------

async function inoreaderFetch(path: string, token: string, appId: string, appKey: string) {
  const resp = await fetch(`${INOREADER_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      AppId: appId,
      AppKey: appKey,
    },
  });
  if (resp.status === 429) {
    const retryAfter = resp.headers.get("Retry-After") || "300";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }
  if (!resp.ok) {
    throw new Error(`Inoreader API ${path} failed: HTTP ${resp.status}`);
  }
  return resp.json();
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

// --------------- Main Handler ---------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const appId = Deno.env.get("INOREADER_APP_ID")!;
    const appKey = Deno.env.get("INOREADER_APP_KEY")!;
    const supabase = createClient<any>(supabaseUrl, serviceRoleKey);

    // 1. Basic poll cooldown to avoid upstream rate limiting
    const { data: latestPoll } = await supabase
      .from("feeds")
      .select("last_polled_at")
      .eq("is_active", true)
      .not("last_polled_at", "is", null)
      .order("last_polled_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const minPollIntervalMs = 90 * 1000;
    const lastPolledAt = latestPoll?.last_polled_at ? new Date(latestPoll.last_polled_at).getTime() : null;
    if (lastPolledAt && Date.now() - lastPolledAt < minPollIntervalMs) {
      const retrySec = Math.max(1, Math.ceil((minPollIntervalMs - (Date.now() - lastPolledAt)) / 1000));
      return new Response(
        JSON.stringify({ error: `Polling too frequently. Retry in ~${retrySec}s.` }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": String(retrySec),
          },
        }
      );
    }

    // 2. Get a valid Inoreader access token
    const token = await getValidToken(supabase);
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Inoreader not connected. Please authorize first.", collected: 0 }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Optionally sync subscriptions (skip if rate-limited)
    let subscriptions: any[] = [];
    try {
      const subs = await inoreaderFetch("/subscription/list", token, appId, appKey);
      subscriptions = subs.subscriptions || [];

      // 3. Sync subscriptions to feeds table
      for (const sub of subscriptions) {
        const feedUrl = sub.url || sub.id?.replace("feed/", "") || "";
        if (!feedUrl) continue;

        const { data: existing } = await supabase
          .from("feeds")
          .select("id")
          .eq("url", feedUrl)
          .limit(1)
          .single();

        if (!existing) {
          await supabase.from("feeds").insert({
            url: feedUrl,
            publisher_name: sub.title || "Unknown",
            source_category: "mainstream",
            is_active: true,
          });
        }
      }
    } catch (subErr) {
      const msg = subErr instanceof Error ? subErr.message : "";
      if (msg.startsWith("RATE_LIMITED:")) {
        console.warn("Subscription sync skipped (rate limited), proceeding to fetch articles");
      } else {
        throw subErr;
      }
    }

    // 4. Fetch unread articles from Inoreader reading list
    let items: any[] = [];
    try {
      const streamId = encodeURIComponent("user/-/state/com.google/reading-list");
      const excludeRead = encodeURIComponent("user/-/state/com.google/read");
      const streamData = await inoreaderFetch(
        `/stream/contents/${streamId}?n=50&xt=${excludeRead}`,
        token, appId, appKey
      );
      items = streamData.items || [];
    } catch (streamErr) {
      const msg = streamErr instanceof Error ? streamErr.message : "";
      if (msg.startsWith("RATE_LIMITED:")) {
        return new Response(
          JSON.stringify({ error: "Inoreader rate limited on all endpoints. Wait a few minutes and retry.", collected: 0 }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw streamErr;
    }

    // items already declared above
    let totalCollected = 0;
    const errors: string[] = [];

    for (const item of items) {
      try {
        const articleUrl = item.canonical?.[0]?.href || item.alternate?.[0]?.href || "";
        if (!articleUrl) continue;

        const title = decodeEntities(item.title || "Untitled");
        const publishedAt = item.published
          ? new Date(item.published * 1000).toISOString()
          : null;
        const feedStreamId = item.origin?.streamId || "";
        const feedUrl = feedStreamId.replace("feed/", "");

        // Find matching feed
        const { data: feedRow } = await supabase
          .from("feeds")
          .select("id")
          .eq("url", feedUrl)
          .limit(1)
          .single();

        if (!feedRow) continue;

        // Check if document already exists
        const { data: existingDoc } = await supabase
          .from("documents")
          .select("id")
          .eq("url", articleUrl)
          .limit(1)
          .single();

        if (existingDoc) continue;

        // Use RSS summary content directly (no Firecrawl)
        const rssHtml = item.summary?.content || null;
        const rawContent = rssHtml ? cleanRssContent(rssHtml) : null;
        const fetchStatus = rawContent ? "fetched" : "pending";

        const wordCount = rawContent
          ? rawContent.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length
          : 0;

        const doc = {
          feed_id: feedRow.id,
          url: articleUrl,
          title,
          published_at: publishedAt,
          author: item.author || null,
          raw_content: rawContent,
          normalized_content: null,
          word_count: wordCount || null,
          fetch_status: fetchStatus,
          pipeline_status: rawContent ? "normalizing" : "pending",
        };

        const { data: insertedDoc, error: insertErr } = await supabase.from("documents").insert(doc).select("id").single();
        if (insertErr) {
          errors.push(`Doc ${articleUrl}: ${insertErr.message}`);
        } else {
          totalCollected++;
          // Enqueue into pgmq pipeline
          if (insertedDoc?.id) {
            try {
              await supabase.rpc("pgmq_send", {
                queue_name: "pipeline_jobs",
                msg: { doc_id: insertedDoc.id, stage: "NORMALIZE", attempt: 1 },
              });
            } catch (qErr) {
              console.warn(`Queue enqueue failed for ${insertedDoc.id}:`, qErr);
            }
          }
        }
      } catch (e) {
        errors.push(`Item: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5. Update last_polled_at for all active feeds
    const now = new Date().toISOString();
    await supabase
      .from("feeds")
      .update({ last_polled_at: now })
      .eq("is_active", true);

    console.log(`Collector complete: ${totalCollected} articles (RSS-only)`);
    if (errors.length) console.warn("Collector errors:", errors);

    return new Response(
      JSON.stringify({
        collected: totalCollected,
        subscriptions: subscriptions.length,
        itemsProcessed: items.length,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("Collector fatal error:", e);

    if (msg.startsWith("RATE_LIMITED:")) {
      const retrySec = msg.split(":")[1];
      return new Response(
        JSON.stringify({ error: `Inoreader rate limited. Try again in ~${Math.ceil(Number(retrySec) / 60)} minutes.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
