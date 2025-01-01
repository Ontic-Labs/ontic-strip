import { AppLayout } from "@/components/layout/AppLayout";
import { SEOHead } from "@/lib/seo";

export default function Terms() {
  return (
    <AppLayout>
      <SEOHead
        title="Terms of Service"
        description="Ontic Strip terms of service — use of service, content sourcing, and limitation of liability."
        path="/terms"
      />
      <div className="container py-8 sm:py-12 px-4 sm:px-6 max-w-2xl space-y-6">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">Terms of Service</h1>
        <div className="prose prose-sm text-muted-foreground space-y-4">
          <p>
            By using Ontic Strip you agree to these terms. The service is provided "as is" without
            warranty of any kind.
          </p>
          <h2 className="text-base font-semibold text-foreground">Use of Service</h2>
          <p>
            Ontic Strip is a research tool for analysing the veracity of news content. Results are
            informational and should not be treated as definitive fact-checks.
          </p>
          <h2 className="text-base font-semibold text-foreground">Content</h2>
          <p>
            All analysed content is sourced from publicly available RSS feeds. We do not claim
            ownership of third-party content.
          </p>
          <h2 className="text-base font-semibold text-foreground">Limitation of Liability</h2>
          <p>
            We are not liable for any decisions made based on information provided by this service.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
