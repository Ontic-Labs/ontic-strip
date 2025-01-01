import { useToast } from "@/hooks/use-toast";
import { SEOHead } from "@/lib/seo";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

const INOREADER_AUTH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inoreader-auth`;

export default function InoreaderCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [status, setStatus] = useState("Exchanging authorization code…");

  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) {
      setStatus("No authorization code received.");
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setStatus("Connection timed out. Please try again from the admin panel.");
      }
    }, 15000);

    const exchange = async () => {
      try {
        const resp = await fetch(INOREADER_AUTH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            action: "exchange",
            code,
            redirect_uri: `${window.location.origin}/inoreader/callback`,
          }),
        });

        if (cancelled) return;
        const data = await resp.json();
        if (data.success) {
          toast({ title: "Inoreader connected!", description: "Your account is now linked." });
          navigate("/admin/feeds");
        } else {
          setStatus(`Error: ${data.error || "Token exchange failed"}`);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
        }
      }
    };

    exchange();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [searchParams, navigate, toast]);

  const isError = status.startsWith("Error") || status.includes("timed out");

  return (
    <>
      <SEOHead
        title="Inoreader Callback"
        description="OAuth callback handler"
        path="/inoreader/callback"
        noIndex
      />
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-3">
          <div className={`text-lg font-mono ${isError ? "text-destructive" : ""}`}>{status}</div>
          {isError && (
            <Link to="/admin/feeds" className="text-sm text-primary hover:underline">
              ← Back to Feed Management
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
