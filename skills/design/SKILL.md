---
name: design
description: UI and UX work — layout, colour, typography, spacing, responsive behaviour, accessibility, component styling. Use for anything a human looks at.
triggers: [ui, ux, design, css, scss, tailwind, layout, colour, color, typography, font, spacing, responsive, mobile, button, navbar, sidebar, card, modal, dark mode, theme, accessibility, a11y, contrast, animation, hover, figma, styling, look better, beautiful, ugly]
---

# Design skill

## First, look at what already exists

Read the project's existing components, CSS variables, and design tokens before
proposing anything. Your job is to extend a system, not to invent a competing one.
Find and reuse: the colour palette, the spacing scale, the type scale, the border
radius, the shadow values, the breakpoint list.

If none exist, create them as variables/tokens first, then use them. Never
hardcode `#3b82f6` in eleven places.

## Layout

- **One layout method, consistently.** Flexbox for one-dimensional rows/columns,
  Grid for two-dimensional areas. Do not mix them for the same job.
- **Space with a scale, not by eye.** Use 4px or 8px steps: 4, 8, 12, 16, 24, 32,
  48, 64. Arbitrary `13px` margins are how UIs start to look amateur.
- **Constrain reading width.** Body text maxes out around 65–75 characters
  (`max-width: 65ch`). Full-width paragraphs on a 27" monitor are unreadable.
- **Design mobile-first.** Write the small-screen layout as the default, then add
  `min-width` media queries. Retrofitting responsiveness is always worse.
- **Whitespace is the main tool.** When something looks wrong, the fix is usually
  more space or a stronger size contrast — not another border or background.

## Typography

- **Two families maximum**, often one is enough.
- **A clear scale with real jumps:** 12 / 14 / 16 / 20 / 24 / 32 / 48. Steps of
  1px create no hierarchy.
- **Hierarchy through weight and size, not colour.** Grey text everywhere makes
  everything look disabled.
- `line-height`: ~1.5 for body text, ~1.2 for headings.
- Never set body text below 14px. Never use pure `#000` on pure `#fff` for long
  reading — `#111` on `#fff` or `#1a1a1a` on `#fafafa` is softer.

## Colour

- **60-30-10:** ~60% neutral background, ~30% secondary surface, ~10% accent.
- **One accent colour.** Multiple competing accents read as noise.
- **Contrast is not optional.** Body text must hit WCAG AA: 4.5:1 for normal text,
  3:1 for large text (24px+, or 19px bold). Check it, do not guess.
- **Do not use colour as the only signal.** A red border alone does not
  communicate an error to a colour-blind user. Add an icon and text.
- Derive shades from one hue by changing lightness, not by picking unrelated hexes.

## Components

- **State coverage.** Every interactive element needs: default, hover, focus,
  active, disabled, loading, error, empty. Missing states are the most common
  cause of a UI feeling broken.
- **Focus rings are mandatory.** Never `outline: none` without a replacement.
  Keyboard users must be able to see where they are.
- **Touch targets ≥ 44×44px** on mobile.
- **Loading beats layout shift.** Reserve space for content that arrives later
  (`min-height`, aspect-ratio, skeleton blocks). Content jumping down the page is
  the single most annoying UI defect.
- **Empty states need design too.** "No results" is a screen; give it a helpful
  next action.

## Accessibility checklist

- Semantic HTML first: `button` for actions, `a` for navigation, `label` for
  inputs, `table` for tabular data. A `div` with `onClick` is not a button.
- Every image has `alt` (or `alt=""` when decorative).
- Every input has a real `<label for>`, not just a placeholder.
- Headings nest without skipping levels (no `h1` → `h4`).
- Animations respect `prefers-reduced-motion`.
- Everything reachable by keyboard, in a sensible order.

## What you deliver

Describe the visual result concretely: the exact spacing values, the colour
tokens, the breakpoints, the states. Then write the code. Do not hand over
"make it look nice" prose.
