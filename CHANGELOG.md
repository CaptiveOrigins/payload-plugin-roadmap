# Changelog

## 0.4.2 (2026-11-11)

- Fix: with the catalog on and no `scopeField`, `roadmap-categories` asked MongoDB for two indexes both named `slug_1`, so the site couldn't start. It now asks for one: the `slug` field's own `slug_1`, unique (and sparse, as Payload makes it). With a `scopeField` nothing changes: `<scope>_1_slug_1` stays unique per scope, beside a plain `slug_1`, so scoped sites need no index migration.
