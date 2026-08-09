---
name: DealerShot
description: Precision automotive inventory and photo operations.
colors:
  steel-signal: "#2868ca"
  cool-canvas: "#f3f5f7"
  paper-surface: "#fefefe"
  graphite-rail: "#17202b"
  ink-primary: "#202b39"
  ink-muted: "#6d7580"
  line-subtle: "#d9dde2"
  success: "#27845c"
  warning: "#d29a32"
  destructive: "#c43d36"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.01em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.steel-signal}"
    textColor: "{colors.paper-surface}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  card:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    height: "44px"
---

# Design System: DealerShot

## Overview

**Creative North Star: “The Precision Bay”**

DealerShot should feel like a well-run dealership preparation bay: every tool has a clear place, the current job is unmistakable, and visual noise never competes with the vehicle. A cool, light working canvas handles bright showroom and outdoor conditions while a graphite navigation rail gives the product a durable automotive frame.

The system is compact but comfortable. Image workspaces receive the largest visual area; metadata, filters, and administrative controls use crisp alignment and predictable density. It explicitly rejects generic SaaS styling, repetitive card grids, ornamental gradients, neon accents, pervasive glassmorphism, toy-like radii, oversized empty areas, heavy shadows, and slow animation.

**Key Characteristics:**

- Light-first operational canvas with a graphite application frame.
- Steel-blue reserved for navigation, selection, focus, and primary action.
- Borders and tonal layers establish hierarchy before shadows.
- Dense desktop information with purpose-built mobile reflow.
- Photo-first workspaces with visible progress and persistent next actions.

## Colors

The palette uses cool neutral surfaces and one disciplined blue signal, supported by three status roles.

### Primary

- **Steel Signal** (`#2868ca`): Primary actions, active navigation details, selected controls, focus, and informational progress.

### Neutral

- **Cool Canvas** (`#f3f5f7`): Default page background.
- **Paper Surface** (`#fefefe`): Cards, dialogs, inputs, and top bars.
- **Graphite Rail** (`#17202b`): Persistent navigation and dark image stages.
- **Primary Ink** (`#202b39`): Titles and operational content.
- **Muted Ink** (`#6d7580`): Supporting copy and metadata.
- **Subtle Line** (`#d9dde2`): Borders, dividers, and table rules.

### Named Rules

**The Signal Rule.** Steel blue is an action and state signal, not decoration. A screen should rarely have more than one visually dominant primary action.

**The Three-State Rule.** Success, warning, and destructive colors communicate state only. Do not introduce unrelated badge colors.

## Typography

**Display Font:** Inter with system sans-serif fallback

**Body Font:** Inter with system sans-serif fallback

**Character:** Practical, highly legible, and slightly condensed through tracking rather than a specialty font. Tabular figures keep operational metrics and prices steady.

### Hierarchy

- **Headline** (600, 28–32px, 1.15): Route titles and vehicle identity.
- **Title** (600, 14–16px, 1.35): Sections, cards, and rows.
- **Body** (400, 14px, 1.5): Instructions, descriptions, and forms.
- **Label** (600, 11–12px): Controls and metadata; uppercase only for brief eyebrow or data labels.

### Named Rules

**The Working Type Rule.** Avoid thin text and marketing-scale headlines inside authenticated workflows. Important values use weight and alignment, not decorative size.

## Elevation

DealerShot is flat by default. Surface hierarchy comes from background tone and one-pixel borders. Low ambient shadows appear only on overlays, menus, or genuinely lifted interactive content.

### Shadow Vocabulary

- **Ambient control** (`0 1px 2px rgb(20 30 45 / 0.06)`): Selected segmented controls and small lifted controls.
- **Overlay** (`0 24px 60px -24px rgb(15 23 34 / 0.35)`): Dialogs, sheets, and menus.

### Named Rules

**The Flat-by-Default Rule.** Cards do not float merely because they are cards. Elevation must communicate layering or interaction.

## Components

### Buttons

- **Shape:** Restrained 8px radius, 44px default touch height.
- **Primary:** Steel Signal background with white text; concise verb-first label.
- **Hover / Focus:** 120ms color response and visible two-pixel steel focus ring.
- **Secondary / Ghost:** Neutral surface or transparent background; destructive remains visually separate.

### Chips

- **Style:** Small rounded status pill with border, subtle tonal fill, and optional dot.
- **State:** Neutral, success, warning, danger, or information only.

### Cards / Containers

- **Corner Style:** 8–10px.
- **Background:** Paper Surface on Cool Canvas.
- **Shadow Strategy:** Flat by default.
- **Border:** One-pixel Subtle Line.
- **Internal Padding:** 16px mobile, 20px desktop.

### Inputs / Fields

- **Style:** 44px minimum height, white surface, strong label, one-pixel border.
- **Focus:** Steel border and two-pixel external focus ring.
- **Error / Disabled:** Destructive border with associated text; disabled controls retain legible labels.

### Navigation

Desktop uses a collapsible graphite rail with compact icon-and-label rows. Mobile uses a full-height drawer and never compresses the desktop rail. The active route has a tonal background and narrow steel indicator.

### Guided Capture

One current shot owns the stage. Guidance, capture/replace action, progress, and the next unfinished step stay visible. The full sequence is a compact selectable rail, not a long checklist.

## Do's and Don'ts

### Do:

- **Do** prioritize the vehicle image and current operational action.
- **Do** keep page gutters at 16px mobile, 24px tablet, and 32px wide desktop.
- **Do** use 120ms, 180ms, and 240ms motion tokens with reduced-motion support.
- **Do** provide mobile card/list alternatives for dense desktop tables.
- **Do** use explicit labels, actionable errors, layout-matched skeletons, and useful empty-state actions.

### Don't:

- **Don't** make DealerShot feel like a generic SaaS dashboard or an AI-generated Tailwind template.
- **Don't** use excessive gradients, neon effects, pervasive glassmorphism, or random bright colors.
- **Don't** use toy-like rounded cards, huge empty spaces, excessive shadows, or giant marketing typography inside the app.
- **Don't** rely on thin low-contrast text, hover-only actions, compressed desktop tables on mobile, or animation to communicate required state.
- **Don't** animate vehicle photography itself in a way that interferes with evaluating the image.
