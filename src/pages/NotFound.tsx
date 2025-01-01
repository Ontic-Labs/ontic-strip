import { AppLayout } from "@/components/layout/AppLayout";
import { SEOHead } from "@/lib/seo";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <AppLayout>
      <SEOHead
        title="Page Not Found"
        description="The page you're looking for doesn't exist."
        path={location.pathname}
        noIndex
      />
      <div className="flex items-center justify-center py-20 sm:py-32">
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-mono font-bold">404</h1>
          <p className="text-sm text-muted-foreground">Page not found</p>
          <Link to="/" className="text-sm text-primary hover:underline">
            ← Return to Home
          </Link>
        </div>
      </div>
    </AppLayout>
  );
};

export default NotFound;
