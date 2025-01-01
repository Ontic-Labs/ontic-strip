

## Landing Page + Tooltip Fix

### Bug Fix: Tooltip clipped above viewport

The legend tooltip on desktop uses Radix `TooltipContent` which defaults to `side="top"`, placing it above the sticky sub-bar and outside the viewport. Fix: set `side="bottom"` on the `TooltipContent` so it appears below the legend items.

### Landing Page: Dashboard Overview at `/`

Rather than pure marketing, the landing page serves as a **live dashboard** -- an at-a-glance summary of the system's current state that gives users immediate value before diving into Stories, Feed, or Sources.

#### Layout (single scrollable page, no sidebar)

```text
+------------------------------------------+
| ONTIC STRIP   Stories  Feed  Sources     |
| Legend sub-bar                           |
+------------------------------------------+
|                                          |
|  HERO: Tagline + brief explainer         |
|  "Multi-source news integrity analysis"  |
|                                          |
+------------------------------------------+
|  LIVE PULSE (3 stat cards in a row)      |
|  [ Articles   ] [ Stories  ] [ Sources ] |
|  [ analyzed   ] [ tracked  ] [ active  ] |
+------------------------------------------+
|  LATEST STORIES (top 3 clusters)         |
|  Compact StoryCards w/ "View all" link   |
+------------------------------------------+
|  RECENT ARTICLES (top 5 from feed)       |
|  Compact ArticleCards w/ "View all" link |
+------------------------------------------+
|  HOW IT WORKS (3-step explainer)         |
|  1. Collect  2. Analyze  3. Compare     |
|  (with strip color examples)             |
+------------------------------------------+
|  Footer                                  |
+------------------------------------------+
```

#### Sections

1. **Hero** -- App name, one-line description ("See how different outlets cover the same story, with automated fact-checking"), and the strip color bar as a visual motif. Not a marketing CTA -- just orientation for new and returning users.

2. **Live Pulse** -- Three stat cards pulling real counts from the database:
   - Total documents analyzed (count from `documents` where pipeline_status = 'aggregated')
   - Active story clusters (count from `story_clusters`)
   - Active sources (count from `feeds` where is_active = true)
   
   These give returning users a quick health check of the system.

3. **Latest Stories** -- Top 3 story clusters by document count, rendered as compact `StoryCard` components with a "View all stories" link to `/stories`.

4. **Recent Articles** -- Top 5 most recent analyzed articles as compact `ArticleCard` components with a "View full feed" link to `/`.  Route the Feed page to `/feed` instead of `/`.

5. **How It Works** -- A static 3-step explainer using the strip colors:
   - **Collect**: RSS feeds from diverse sources
   - **Analyze**: AI extracts claims, finds evidence, assigns veracity
   - **Compare**: See coverage gaps and bias across outlets
   
   This is useful context, not marketing fluff -- helps users interpret what they see.

#### Route Changes

- Current `/` (FeedView) moves to `/feed`
- New `/` becomes the landing/dashboard page
- Update nav links and any internal links accordingly

### Files to Create/Edit

| File | Action |
|------|--------|
| `src/pages/Landing.tsx` | Create -- new dashboard landing page |
| `src/pages/Index.tsx` | Rename usage to FeedView at `/feed` |
| `src/App.tsx` | Update routes: `/` = Landing, `/feed` = FeedView |
| `src/components/layout/AppLayout.tsx` | Update Feed nav href to `/feed` |
| `src/components/strip/StripLegend.tsx` | Fix tooltip: add `side="bottom"` to `TooltipContent` |

### Technical Notes

- All stats use simple `supabase.from(...).select("*", { count: "exact", head: true })` for efficient count-only queries
- Story and article previews reuse existing `StoryCard` and `ArticleCard` components
- No new database tables or migrations needed
- The landing page uses `AppLayout` for consistent header/footer/legend
