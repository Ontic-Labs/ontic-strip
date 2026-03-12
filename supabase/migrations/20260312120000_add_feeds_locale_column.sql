-- Add locale column to feeds table for multi-language source filtering
ALTER TABLE public.feeds ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

-- Index for fast locale filtering
CREATE INDEX IF NOT EXISTS idx_feeds_locale ON public.feeds (locale);

-- Insert 3 verified Brazilian RSS feeds
INSERT INTO public.feeds (url, publisher_name, source_category, locale, is_active, description)
VALUES
  ('https://feeds.folha.uol.com.br/emcimadahora/rss091.xml', 'Folha de S.Paulo', 'mainstream', 'pt-BR', true, 'Últimas notícias do jornal Folha de S.Paulo'),
  ('https://g1.globo.com/rss/g1/', 'G1 Globo', 'mainstream', 'pt-BR', true, 'Últimas notícias do Brasil e do mundo — G1'),
  ('https://rss.uol.com.br/feed/noticias.xml', 'UOL Notícias', 'mainstream', 'pt-BR', true, 'Portal UOL — últimas notícias do Brasil')
ON CONFLICT (url) DO UPDATE SET locale = EXCLUDED.locale;
