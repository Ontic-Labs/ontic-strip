import { AppLayout } from "@/components/layout/AppLayout";
import { SEOHead } from "@/lib/seo";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "../i18n";

const NotFound = () => {
  const location = useLocation();
  const { t } = useTranslation("pages");

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <AppLayout>
      <SEOHead
        title={t("notFound.title")}
        description={t("notFound.message")}
        path={location.pathname}
        noIndex
      />
      <div className="flex items-center justify-center py-20 sm:py-32">
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-mono font-bold">404</h1>
          <p className="text-sm text-muted-foreground">{t("notFound.message")}</p>
          <Link to="/" className="text-sm text-primary hover:underline">
            {t("notFound.returnHome")}
          </Link>
        </div>
      </div>
    </AppLayout>
  );
};

export default NotFound;
