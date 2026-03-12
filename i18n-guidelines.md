# Internationalization (i18n) Guidelines

## Accessibility & RTL
- All user-facing text, ARIA labels, and alt text must use translation keys.
- Layouts must support RTL: set `dir={i18n.dir()}` on `<html>` or root container.
- Test with long translations for layout resilience.

## Adding/Updating Translations
- Add new keys to the appropriate namespace in `public/locales/{locale}/{namespace}.json`.
- Use descriptive, namespaced keys (e.g., `feed.newStories`).
- Run `npm run lint:i18n` to check for untranslated strings and missing keys.
- For new locales, copy `en` as a template and translate all values.

## Coding Patterns
- Use `useTranslation('namespace')` and `t('key')` for all user-facing text.
- Use `<Trans>` for rich text or embedded elements.
- Use formatting helpers for dates, numbers, and currency (see `src/lib/format.ts`).
- For pluralization/interpolation, use translation library features (e.g., `t('key', { count })`).

## Linting & CI
- All PRs must pass the i18n lint check (see below).
- No hardcoded user-facing strings in JSX/TSX files.
- All translation keys must exist in all supported locales.

## Linting Script Example
- Use [eslint-plugin-i18next](https://github.com/gilbsgilbs/eslint-plugin-i18next) or a custom script to detect hardcoded strings and missing keys.
- Example npm script:

```json
"lint:i18n": "eslint --ext .ts,.tsx src/ --rule 'i18next/no-literal-string: [2, { markupOnly: true, ignoreAttribute: ['data-testid'] }] '"
```

## Review Checklist
- [ ] All user-facing text is externalized.
- [ ] ARIA/alt text is localized.
- [ ] Layouts are RTL-resilient.
- [ ] No untranslated strings in code.
- [ ] All translation keys exist for all locales.
