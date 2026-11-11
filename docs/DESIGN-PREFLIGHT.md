# Design preflight: Epoch brand surfaces

This receipt covers the README hero, social cards, site marks, favicon, touch icon and the Hermes plugin banner. The icon itself is unchanged: it is the round-16 C brass hourglass that Simon picked on 2026-11-10 and that landed in #112.

## 1. Purpose

Epoch gives AI agents grounded time and effort estimates in place of guessed timelines.

## 2. Title, stone and purpose

| Item | Value | Evidence |
|---|---|---|
| Material | Brass hourglass, family style, ¾ view | r16 C picked 2026-11-10; `branding/epoch-512.png` on main (#112) |
| Rule | Keep the hourglass and change only the family style | Simon's direction for round 16 |

## 3. Rejected metaphors

- The chrome front-view hourglass, which was superseded.
- The green clock in the nav and footer, which isn't the family mark.

## 4. Material reference

The source is `branding/epoch-512.png`, composited unchanged into:

- `assets/epoch-hero.webp`
- `og-social-preview.png`
- `assets/og.jpg` and `site/og.jpg`
- `plugins/epoch-hermes/docs/banner.png`

## 5. Family icon law and form

The small sizes sit on a light tile (`#F2F2F2`) so the brass holds on dark tabs:

- favicon: 64 px, rounded
- apple-touch: 180 px, opaque, with the glyph at 85% height

The on-page marks are the trimmed brass mark (`site/epoch-mark.png`).

## 6. Typography

The hero and wordmark use Chakra Petch Bold 700, as set out in `assets/BRANDING.md`.

## 7. Platform conventions

| Surface | File |
|---|---|
| GitHub social preview 1280×720 | `og-social-preview.png` (uploaded by hand in repo Settings) |
| Open Graph 1200×630 | `site/og.jpg` |
| Hermes plugin | `plugins/epoch-hermes/icon.png` and `docs/banner.png` |

## 8. UI colour

The existing dark UI and green accent are unchanged. Muted text is raised to `#8A8AAA` for 4.5:1 contrast on `#050510`.

**Assumption:** the favicon tile colour has not been reviewed by Simon.
