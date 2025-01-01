import { MarkdownRenderer } from "@/components/docs/MarkdownRenderer";
import { AppLayout } from "@/components/layout/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SEOHead } from "@/lib/seo";
import { useSearchParams } from "react-router-dom";

import methodologyMd from "../../docs/methodology.md?raw";
import promptSpecMd from "../../docs/prompt-spec.md?raw";
import techStackMd from "../../docs/tech-stack.md?raw";

const TAB_KEYS = ["methodology", "tech-stack", "prompt-spec"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_META: Record<
  TabKey,
  { label: string; title: string; description: string; content: string }
> = {
  methodology: {
    label: "Methodology",
    title: "Methodology",
    description:
      "How Ontic Strip analyzes news articles — the 10-stage pipeline, proposition-based IRT ideology scoring, MBFC-inspired factuality, and full mathematical specification.",
    content: methodologyMd,
  },
  "tech-stack": {
    label: "Tech Stack",
    title: "Tech Stack",
    description: "Full technology and tooling reference for the Ontic Strip platform.",
    content: techStackMd,
  },
  "prompt-spec": {
    label: "Prompt Architecture",
    title: "Prompt Architecture (CFPO v2)",
    description:
      "The CFPO v2 prompt architecture specification — compiled, not authored. Section contracts, enforcement blocks, and the compilation pipeline.",
    content: promptSpecMd,
  },
};

export default function Docs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: TabKey = TAB_KEYS.includes(tabParam as TabKey)
    ? (tabParam as TabKey)
    : "methodology";

  const meta = TAB_META[activeTab];

  function handleTabChange(value: string) {
    setSearchParams({ tab: value }, { replace: true });
  }

  return (
    <AppLayout>
      <SEOHead
        title={meta.title}
        description={meta.description}
        path={`/docs${activeTab !== "methodology" ? `?tab=${activeTab}` : ""}`}
      />

      <div className="container py-8 sm:py-12 px-4 sm:px-6 max-w-4xl">
        <div className="space-y-2 mb-8">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">Documentation</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Technical reference for contributors and researchers.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="mb-6">
            {TAB_KEYS.map((key) => (
              <TabsTrigger key={key} value={key}>
                {TAB_META[key].label}
              </TabsTrigger>
            ))}
          </TabsList>

          {TAB_KEYS.map((key) => (
            <TabsContent key={key} value={key}>
              <MarkdownRenderer content={TAB_META[key].content} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AppLayout>
  );
}
