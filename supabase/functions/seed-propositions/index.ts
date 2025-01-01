import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// 50 propositions from §1.5 of the design doc
const PROPOSITIONS = [
  // Immigration (5)
  { domain: "immigration", dimension: "social", text: "The federal government should increase funding for physical barriers along the U.S.–Mexico border.", liberal_is_pro: false, keywords: ["border", "wall", "barrier", "immigration", "mexico"] },
  { domain: "immigration", dimension: "social", text: "Undocumented immigrants brought to the U.S. as children should be granted a pathway to citizenship.", liberal_is_pro: true, keywords: ["DACA", "dreamers", "undocumented", "citizenship", "immigration"] },
  { domain: "immigration", dimension: "social", text: "Local law enforcement should be required to cooperate with federal immigration authorities.", liberal_is_pro: false, keywords: ["sanctuary", "ICE", "immigration", "enforcement", "deportation"] },
  { domain: "immigration", dimension: "social", text: "The U.S. should reduce the total number of legal immigrants admitted annually.", liberal_is_pro: false, keywords: ["immigration", "legal immigration", "visa", "quota"] },
  { domain: "immigration", dimension: "social", text: "Employers who knowingly hire undocumented workers should face criminal penalties.", liberal_is_pro: false, keywords: ["employer", "undocumented", "hiring", "e-verify", "immigration"] },
  // Fiscal Policy (5)
  { domain: "fiscal_policy", dimension: "economic", text: "The top marginal income tax rate should be increased above current levels.", liberal_is_pro: true, keywords: ["tax", "income tax", "marginal rate", "wealthy", "taxation"] },
  { domain: "fiscal_policy", dimension: "economic", text: "The federal government should pursue a balanced budget amendment to the Constitution.", liberal_is_pro: false, keywords: ["balanced budget", "deficit", "debt", "spending", "amendment"] },
  { domain: "fiscal_policy", dimension: "economic", text: "Social Security benefits should be expanded, funded by raising the payroll tax cap.", liberal_is_pro: true, keywords: ["social security", "payroll tax", "retirement", "benefits", "entitlement"] },
  { domain: "fiscal_policy", dimension: "economic", text: "Federal spending on means-tested welfare programs should be reduced.", liberal_is_pro: false, keywords: ["welfare", "spending", "means-tested", "food stamps", "SNAP"] },
  { domain: "fiscal_policy", dimension: "economic", text: "Capital gains should be taxed at the same rate as ordinary income.", liberal_is_pro: true, keywords: ["capital gains", "tax", "investment", "income", "wealth"] },
  // Regulation (5)
  { domain: "regulation", dimension: "economic", text: "The federal government should impose stricter regulations on large financial institutions.", liberal_is_pro: true, keywords: ["regulation", "banks", "financial", "Wall Street", "Dodd-Frank"] },
  { domain: "regulation", dimension: "economic", text: "Occupational licensing requirements should be reduced to lower barriers to entry.", liberal_is_pro: false, keywords: ["licensing", "regulation", "barriers", "occupational", "deregulation"] },
  { domain: "regulation", dimension: "economic", text: "The government should break up technology companies that hold monopoly power.", liberal_is_pro: true, keywords: ["antitrust", "monopoly", "tech", "big tech", "breakup"] },
  { domain: "regulation", dimension: "economic", text: "Federal environmental review requirements for infrastructure projects should be streamlined.", liberal_is_pro: false, keywords: ["NEPA", "environmental review", "infrastructure", "permitting", "streamline"] },
  { domain: "regulation", dimension: "economic", text: "Pharmaceutical companies should face price controls on prescription drugs.", liberal_is_pro: true, keywords: ["drug prices", "pharmaceutical", "prescription", "price controls", "medicare"] },
  // Social Policy (5)
  { domain: "social_policy", dimension: "social", text: "Abortion access should be protected as a federal legal right.", liberal_is_pro: true, keywords: ["abortion", "reproductive rights", "Roe", "pro-choice", "pro-life"] },
  { domain: "social_policy", dimension: "social", text: "Transgender athletes should compete in sports categories matching their gender identity.", liberal_is_pro: true, keywords: ["transgender", "sports", "gender identity", "Title IX", "athletics"] },
  { domain: "social_policy", dimension: "social", text: "Religious organizations should be exempt from anti-discrimination laws in hiring.", liberal_is_pro: false, keywords: ["religious liberty", "exemption", "discrimination", "hiring", "faith"] },
  { domain: "social_policy", dimension: "social", text: "Public school curricula should include comprehensive sex education.", liberal_is_pro: true, keywords: ["sex education", "school", "curriculum", "abstinence", "health"] },
  { domain: "social_policy", dimension: "social", text: "Affirmative action in college admissions should be prohibited.", liberal_is_pro: false, keywords: ["affirmative action", "admissions", "diversity", "race", "university"] },
  // Criminal Justice (5)
  { domain: "criminal_justice", dimension: "social", text: "Mandatory minimum sentences for nonviolent drug offenses should be eliminated.", liberal_is_pro: true, keywords: ["mandatory minimum", "sentencing", "drug", "prison", "reform"] },
  { domain: "criminal_justice", dimension: "social", text: "Qualified immunity for law enforcement officers should be ended.", liberal_is_pro: true, keywords: ["qualified immunity", "police", "accountability", "lawsuit", "reform"] },
  { domain: "criminal_justice", dimension: "social", text: "The death penalty should be abolished at the federal level.", liberal_is_pro: true, keywords: ["death penalty", "capital punishment", "execution", "abolish"] },
  { domain: "criminal_justice", dimension: "social", text: "Funding for local police departments should be increased.", liberal_is_pro: false, keywords: ["police", "funding", "law enforcement", "public safety", "defund"] },
  { domain: "criminal_justice", dimension: "social", text: "Possession of small amounts of marijuana should be fully decriminalized nationwide.", liberal_is_pro: true, keywords: ["marijuana", "cannabis", "decriminalize", "drug policy", "legalize"] },
  // Foreign Policy (5)
  { domain: "foreign_policy", dimension: "foreign", text: "The U.S. should increase military aid to allies facing territorial aggression.", liberal_is_pro: false, keywords: ["military aid", "defense", "NATO", "alliance", "aggression"] },
  { domain: "foreign_policy", dimension: "foreign", text: "The U.S. should reduce its permanent military presence overseas.", liberal_is_pro: true, keywords: ["military", "overseas", "troops", "bases", "withdrawal"] },
  { domain: "foreign_policy", dimension: "foreign", text: "Free trade agreements generally benefit the U.S. economy.", liberal_is_pro: false, keywords: ["trade", "free trade", "tariff", "NAFTA", "TPP"] },
  { domain: "foreign_policy", dimension: "foreign", text: "The U.S. should impose sanctions on nations that violate human rights.", liberal_is_pro: true, keywords: ["sanctions", "human rights", "diplomacy", "foreign policy"] },
  { domain: "foreign_policy", dimension: "foreign", text: "Defense spending should be reduced from current levels.", liberal_is_pro: true, keywords: ["defense spending", "military budget", "Pentagon", "spending cuts"] },
  // Labor (5)
  { domain: "labor", dimension: "economic", text: "The federal minimum wage should be raised to $15 per hour or higher.", liberal_is_pro: true, keywords: ["minimum wage", "wages", "workers", "labor", "$15"] },
  { domain: "labor", dimension: "economic", text: "Public-sector employees should have the right to collectively bargain.", liberal_is_pro: true, keywords: ["collective bargaining", "union", "public sector", "labor rights"] },
  { domain: "labor", dimension: "economic", text: "Gig economy workers should be classified as employees rather than independent contractors.", liberal_is_pro: true, keywords: ["gig economy", "Uber", "contractor", "employee", "AB5"] },
  { domain: "labor", dimension: "economic", text: "Right-to-work laws that prohibit mandatory union dues should be enacted nationwide.", liberal_is_pro: false, keywords: ["right-to-work", "union", "dues", "labor", "open shop"] },
  { domain: "labor", dimension: "economic", text: "Companies should be required to provide paid family and medical leave.", liberal_is_pro: true, keywords: ["paid leave", "family leave", "FMLA", "parental leave", "benefits"] },
  // Environment (5)
  { domain: "environment", dimension: "economic", text: "The U.S. should achieve net-zero carbon emissions by 2050.", liberal_is_pro: true, keywords: ["net-zero", "carbon", "climate", "emissions", "2050"] },
  { domain: "environment", dimension: "economic", text: "The federal government should expand oil and gas drilling on public lands.", liberal_is_pro: false, keywords: ["drilling", "oil", "gas", "public lands", "fossil fuel"] },
  { domain: "environment", dimension: "economic", text: "Nuclear energy should be expanded as part of the clean energy transition.", liberal_is_pro: false, keywords: ["nuclear", "energy", "clean energy", "power", "reactor"] },
  { domain: "environment", dimension: "economic", text: "Carbon emissions should be taxed to reflect their social cost.", liberal_is_pro: true, keywords: ["carbon tax", "emissions", "climate", "social cost", "pricing"] },
  { domain: "environment", dimension: "economic", text: "The Endangered Species Act should be strengthened, not weakened.", liberal_is_pro: true, keywords: ["endangered species", "ESA", "conservation", "wildlife", "habitat"] },
  // Executive Power (5)
  { domain: "executive_power", dimension: "executive", text: "The president should have the authority to impose tariffs without congressional approval.", liberal_is_pro: false, keywords: ["tariff", "president", "executive power", "trade", "congress"] },
  { domain: "executive_power", dimension: "executive", text: "Executive orders should be subject to mandatory congressional review after 180 days.", liberal_is_pro: false, keywords: ["executive order", "congressional review", "oversight", "president"] },
  { domain: "executive_power", dimension: "executive", text: "The president should be able to remove inspectors general without cause.", liberal_is_pro: false, keywords: ["inspector general", "IG", "oversight", "removal", "president"] },
  { domain: "executive_power", dimension: "executive", text: "Congress should reclaim war powers currently delegated to the executive branch.", liberal_is_pro: true, keywords: ["war powers", "AUMF", "congress", "military", "executive"] },
  { domain: "executive_power", dimension: "executive", text: "Presidential emergency declarations should require congressional reauthorization within 30 days.", liberal_is_pro: true, keywords: ["emergency", "declaration", "president", "congress", "authorization"] },
  // Corporate Governance (5)
  { domain: "corporate_governance", dimension: "economic", text: "Publicly traded companies should be required to disclose political spending.", liberal_is_pro: true, keywords: ["political spending", "disclosure", "corporate", "transparency", "Citizens United"] },
  { domain: "corporate_governance", dimension: "economic", text: "Corporations should be required to include worker representatives on their boards.", liberal_is_pro: true, keywords: ["codetermination", "board", "workers", "corporate governance", "representation"] },
  { domain: "corporate_governance", dimension: "economic", text: "Antitrust enforcement should be strengthened to prevent industry consolidation.", liberal_is_pro: true, keywords: ["antitrust", "merger", "consolidation", "monopoly", "competition"] },
  { domain: "corporate_governance", dimension: "economic", text: "ESG (environmental, social, governance) disclosure mandates for public companies should be expanded.", liberal_is_pro: true, keywords: ["ESG", "disclosure", "climate risk", "corporate", "sustainability"] },
  { domain: "corporate_governance", dimension: "economic", text: "Stock buybacks by publicly traded companies should be restricted.", liberal_is_pro: true, keywords: ["buyback", "stock", "shareholders", "corporate", "Wall Street"] },
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Check if already seeded
    const { count } = await supabase
      .from("proposition_bank")
      .select("*", { count: "exact", head: true });

    if (count && count >= 50) {
      return new Response(
        JSON.stringify({ message: `Already seeded (${count} propositions)` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate embeddings via OpenRouter (same as indexer/oracle-evidence)
    const embeddingUrl = "https://openrouter.ai/api/v1/embeddings";

    const texts = PROPOSITIONS.map((p) => p.text);

    const embResp = await fetch(embeddingUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-large",
        input: texts,
        dimensions: 1536, // Matryoshka truncation — fits existing vector(1536) columns
      }),
    });

    if (!embResp.ok) {
      const errText = await embResp.text();
      throw new Error(`Embedding API error ${embResp.status}: ${errText}`);
    }

    const embData = await embResp.json();
    const embeddings = embData.data as Array<{ embedding: number[]; index: number }>;
    // Sort by index to align with PROPOSITIONS
    embeddings.sort((a, b) => a.index - b.index);

    // Build rows
    const rows = PROPOSITIONS.map((p, i) => ({
      axis: "US_1D",
      dimension: p.dimension,
      domain: p.domain,
      text: p.text,
      keywords: p.keywords,
      embedding: JSON.stringify(embeddings[i].embedding),
      liberal_is_pro: p.liberal_is_pro,
      discrimination_a: 1.0,
      difficulty_b: 0.0,
      status: "active",
      version: 1,
    }));

    // Insert in batches of 10
    let inserted = 0;
    const errors: string[] = [];
    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);
      const { error } = await supabase.from("proposition_bank").insert(batch);
      if (error) {
        errors.push(`Batch ${i}: ${error.message}`);
      } else {
        inserted += batch.length;
      }
    }

    console.log(`Seeded ${inserted}/${PROPOSITIONS.length} propositions`);
    if (errors.length) console.error("Seed errors:", errors);

    return new Response(
      JSON.stringify({ inserted, total: PROPOSITIONS.length, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Seed propositions error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
