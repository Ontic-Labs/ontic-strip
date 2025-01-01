import { AppLayout } from "@/components/layout/AppLayout";
import { SEOHead } from "@/lib/seo";

export default function Privacy() {
  return (
    <AppLayout>
      <SEOHead
        title="Privacy Policy"
        description="Ontic Strip privacy policy — data processing, third-party services, and contact information."
        path="/privacy"
      />
      <div className="container py-8 sm:py-12 px-4 sm:px-6 max-w-2xl space-y-6">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">Privacy Policy</h1>
        <div className="prose prose-sm text-muted-foreground space-y-4">
          <p>
            Ontic Strip collects and processes publicly available news articles via RSS feeds for
            the purpose of veracity analysis. No personal user data is collected or stored unless
            you explicitly connect a third-party account (e.g. Inoreader).
          </p>
          <h2 className="text-base font-semibold text-foreground">Data We Process</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>Publicly available article content fetched from RSS feeds</li>
            <li>OAuth tokens for connected services (stored securely, never shared)</li>
          </ul>
          <h2 className="text-base font-semibold text-foreground">Third-Party Services</h2>
          <p>
            We may use third-party APIs for content retrieval and analysis. Each service has its own
            privacy policy governing data it processes.
          </p>
          <h2 className="text-base font-semibold text-foreground">Contact</h2>
          <p>For questions about this policy, reach out via the project repository.</p>
        </div>
      </div>
    </AppLayout>
  );
}
