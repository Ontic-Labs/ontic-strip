import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INOREADER_AUTH_URL = "https://www.inoreader.com/oauth2/auth";
const INOREADER_TOKEN_URL = "https://www.inoreader.com/oauth2/token";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const appId = Deno.env.get("INOREADER_APP_ID");
    const appKey = Deno.env.get("INOREADER_APP_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (!appId || !appKey) {
      return new Response(
        JSON.stringify({ error: "Inoreader credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, code, redirect_uri } = await req.json();

    // Action: "auth_url" — generate the consent page URL
    if (action === "auth_url") {
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirect_uri,
        response_type: "code",
        scope: "read",
        state,
      });
      return new Response(
        JSON.stringify({ url: `${INOREADER_AUTH_URL}?${params}`, state }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action: "exchange" — exchange authorization code for tokens
    if (action === "exchange") {
      if (!code) {
        return new Response(
          JSON.stringify({ error: "Missing authorization code" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const body = new URLSearchParams({
        code,
        redirect_uri: redirect_uri,
        client_id: appId,
        client_secret: appKey,
        scope: "",
        grant_type: "authorization_code",
      });

      const tokenResp = await fetch(INOREADER_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        console.error("Token exchange failed:", errText);
        return new Response(
          JSON.stringify({ error: "Token exchange failed", details: errText }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const tokens = await tokenResp.json();
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Upsert — delete existing rows and insert new one (single-row table)
      await supabase.from("inoreader_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      const { error: insertErr } = await supabase.from("inoreader_tokens").insert({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
      });

      if (insertErr) {
        console.error("Token storage error:", insertErr);
        return new Response(
          JSON.stringify({ error: "Failed to store tokens" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, expires_at: expiresAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action: "refresh" — refresh the access token
    if (action === "refresh") {
      const { data: tokenRow } = await supabase
        .from("inoreader_tokens")
        .select("*")
        .limit(1)
        .single();

      if (!tokenRow) {
        return new Response(
          JSON.stringify({ error: "No Inoreader tokens found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const body = new URLSearchParams({
        client_id: appId,
        client_secret: appKey,
        grant_type: "refresh_token",
        refresh_token: tokenRow.refresh_token,
      });

      const tokenResp = await fetch(INOREADER_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        return new Response(
          JSON.stringify({ error: "Token refresh failed", details: errText }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const tokens = await tokenResp.json();
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await supabase.from("inoreader_tokens").update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
      }).eq("id", tokenRow.id);

      return new Response(
        JSON.stringify({ success: true, expires_at: expiresAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Action: "status" — check if connected
    if (action === "status") {
      const { data: tokenRow } = await supabase
        .from("inoreader_tokens")
        .select("expires_at")
        .limit(1)
        .single();

      return new Response(
        JSON.stringify({
          connected: !!tokenRow,
          expires_at: tokenRow?.expires_at ?? null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Inoreader auth error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
