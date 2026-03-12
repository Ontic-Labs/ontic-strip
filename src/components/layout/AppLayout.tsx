import { StripLegend } from "@/components/strip/StripLegend";
import { cn } from "@/lib/utils";

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "../../i18n";

const NAV_ITEMS = [
  { href: "/stories", key: "nav.stories", icon: "◫" },
  { href: "/feed", key: "nav.feed", icon: "◉" },
  { href: "/claims", key: "nav.claims", icon: "◆" },
  { href: "/leaderboard", key: "nav.leaderboard", icon: "▲" },
  { href: "/search", key: "nav.search", icon: "⌕" },
];

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t, i18n: i18nInstance } = useTranslation("layout");

  // Close mobile menu on route change
  const { pathname } = location;
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is intentionally a trigger dep
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen flex flex-col" dir={i18nInstance.dir()}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-card/80 backdrop-blur-sm">
        <div className="container flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3 sm:gap-6">
            <Link to="/" className="flex items-center gap-2 shrink-0">
              <div className="flex gap-px">
                <div className="h-4 w-1 rounded-full bg-strip-supported" />
                <div className="h-4 w-1 rounded-full bg-strip-contradicted" />
                <div className="h-4 w-1 rounded-full bg-strip-mixed" />
                <div className="h-4 w-1 rounded-full bg-strip-opinion" />
                <div className="h-4 w-1 rounded-full bg-strip-unknown" />
              </div>
              <span className="font-mono font-bold text-sm tracking-tight hidden sm:inline">
                {t("brand")}
              </span>
              <span className="font-mono font-bold text-sm tracking-tight sm:hidden">
                {t("brandShort")}
              </span>
            </Link>
            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-1">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                    location.pathname === item.href
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                  )}
                >
                  <span className="mr-1.5">{item.icon}</span>
                  {t(item.key)}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {/* Language switcher */}
            <div className="flex items-center rounded-md border border-border text-xs font-medium overflow-hidden">
              <button
                type="button"
                className={cn(
                  "px-2 py-1.5 transition-colors",
                  !i18nInstance.language.startsWith("pt")
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
                onClick={() => void i18nInstance.changeLanguage("en")}
                aria-label="English"
              >
                🇺🇸 EN
              </button>
              <button
                type="button"
                className={cn(
                  "px-2 py-1.5 transition-colors",
                  i18nInstance.language.startsWith("pt")
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
                onClick={() => void i18nInstance.changeLanguage("pt-BR")}
                aria-label="Português"
              >
                🇧🇷 PT
              </button>
            </div>
            {/* Mobile menu button */}
            <button
              type="button"
              className="md:hidden p-2 rounded-md text-muted-foreground hover:bg-accent"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={t("aria.toggleMenu")}
            >
              {mobileMenuOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t bg-card px-4 py-3 space-y-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                  location.pathname === item.href
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
              >
                <span>{item.icon}</span>
                {t(item.key)}
              </Link>
            ))}
          </div>
        )}
      </header>

      {/* Legend sub-bar */}
      <div className="sticky top-14 z-40 border-b bg-card/60 backdrop-blur-sm py-1.5 px-4">
        <StripLegend />
      </div>

      {/* Main */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="border-t bg-card/60 py-4 sm:py-6">
        <div className="container px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="font-mono">
            {t("footer.copyright", { year: new Date().getFullYear() })}
          </span>
          <nav className="flex items-center gap-4 flex-wrap justify-center">
            <Link to="/publishers" className="hover:text-foreground transition-colors">
              {t("nav.publishers")}
            </Link>
            <Link to="/docs" className="hover:text-foreground transition-colors">
              {t("nav.docs")}
            </Link>
            <Link to="/admin/feeds" className="hover:text-foreground transition-colors">
              {t("nav.feedManagement")}
            </Link>
            <Link to="/health" className="hover:text-foreground transition-colors">
              {t("nav.health")}
            </Link>
            <a
              href="https://github.com/Ontic-Labs/ontic-strip/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              {t("nav.contributing")}
            </a>
            <Link to="/privacy" className="hover:text-foreground transition-colors">
              {t("nav.privacy")}
            </Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">
              {t("nav.terms")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
