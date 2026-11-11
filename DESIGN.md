---
name: Novedu
description: A school's AI learning workbench, quiet ink on white, with one playful start page for students.
colors:
  ink: "#171717"
  paper: "#ffffff"
  card: "#ffffff"
  primary: "#171717"
  primary-foreground: "#ffffff"
  canvas: "#f1f5f9"
  status-bar: "#0f172a"
  border: "oklch(0.87 0 0)"
  ring: "oklch(0.708 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  destructive: "#b91c1c"
  success: "#15803d"
  warning: "#b45309"
  brand-deep: "#0a529a"
  brand-amber: "#dc931a"
  amber-wash: "#fdf4e3"
  amber-line: "#efd29a"
  amber-halo: "#f6dfae"
  amber-ink: "#5a3c06"
  heat-0: "#e2e8f0"
  heat-1: "#c3d9ee"
  heat-2: "#74a8d6"
  heat-3: "#0a529a"
  fam-rhythm: "#13805a"
  fam-practice: "#2a78d6"
  fam-coding: "#4a3aa7"
  fam-secret: "#0f172a"
  fam-quiz: "#e3a21a"
  fam-reach: "#0b7285"
  fam-authoring: "#9c36b5"
  gold: "#e3a21a"
  gold-ink: "#3d2a00"
  silver: "#aab4c3"
  silver-ink: "#1e2633"
  bronze: "#c07a45"
  bronze-ink: "#2e1606"
  chart-1: "#2a78d6"
  chart-2: "#1baf7a"
  chart-3: "#eda100"
  chart-4: "#008300"
  chart-5: "#4a3aa7"
  chart-6: "#e34948"
  chart-7: "#e87ba4"
  chart-8: "#eb6834"
  chart-9: "#7a5c3e"
  chart-other: "#898781"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.75rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.05em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.333
    letterSpacing: "-0.025em"
  stat:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  title-sm:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.429
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.429
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "0.025em"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.429
    letterSpacing: "0.05em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  hairline: "1px"
  cell-gap: "4px"
  control-gap: "8px"
  section-gap: "16px"
  card-pad-x: "16px"
  card-pad-x-md: "24px"
  card-pad-y: "20px"
  page-gutter: "20px"
  control-height: "36px"
  control-height-sm: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "{spacing.control-height}"
  button-primary-hover:
    backgroundColor: "rgb(23 23 23 / 0.9)"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "{spacing.control-height}"
  button-outline-hover:
    backgroundColor: "rgb(23 23 23 / 0.05)"
  button-outline-sm:
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "{spacing.control-height-sm}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "{spacing.control-height}"
  badge-neutral:
    backgroundColor: "rgb(23 23 23 / 0.1)"
    textColor: "rgb(23 23 23 / 0.8)"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "16px"
  home-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
    padding: "20px 24px"
  news-strip:
    backgroundColor: "{colors.amber-wash}"
    textColor: "{colors.amber-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  badge-disc:
    backgroundColor: "{colors.fam-rhythm}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    size: "40px"
  badge-disc-sm:
    rounded: "{rounded.full}"
    size: "32px"
  badge-disc-locked:
    backgroundColor: "{colors.card}"
    textColor: "rgb(23 23 23 / 0.55)"
    rounded: "{rounded.full}"
    size: "40px"
  calendar-cell:
    backgroundColor: "{colors.heat-0}"
    rounded: "{rounded.md}"
  calendar-pin:
    backgroundColor: "{colors.fam-practice}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    size: "24px"
  meter:
    backgroundColor: "{colors.heat-0}"
    rounded: "{rounded.full}"
    height: "14px"
  tooltip:
    backgroundColor: "{colors.status-bar}"
    textColor: "{colors.paper}"
    typography: "{typography.caption}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  status-bar:
    backgroundColor: "{colors.status-bar}"
    textColor: "{colors.paper}"
    padding: "8px 20px"
---

# Design System: Novedu

Implementation rules (Tailwind v4 CSS-first setup, layer discipline, the `cn()` contract, the reuse boundary) live in [docs/styling.md](docs/styling.md). This file describes the visual system those rules produce; where the two touch, docs/styling.md is the authority.

## Overview

**Creative North Star: "The Classroom Workbench"**

Novedu is a working tool that a school uses mid-lesson. Its surfaces are near-black ink on white cards laid on a cool gray canvas, under a dark status bar. Everything is light, flat and hairline-bordered; controls are round pills; type is one family (Geist) at small, dense sizes. The teacher back office reads like a well-kept ledger: tables, forms, stat tiles, and colour only where it labels a kind or a status. A teacher's start page belongs to that ledger: one line of to-dos over a ranked board, with the student page's badge shelf, in the teacher's own family colours, at the foot.

The student start page (`/`) is the one surface where the workbench is allowed to glow. It keeps the same shell, cards and type, and adds the brand blue, a family colour per badge ladder, and amber for "new since your last visit". The page's spine is a 26-week activity calendar with earned badges pinned to the day they were reached. Rewards are pinned, never popped: no overlay, no confetti, no motion beyond a small hover lift on the pins.

Density is moderate to high: 14px body text, 36px controls, 16px between page sections. The system has a light and a dark theme; each device picks Light, Dark or "Same as device" on the Settings page (docs/styling.md, "Theme"). This file describes the light theme; the dark one is the same system on near-black paper.

**Key Characteristics:**
- Ink-on-white cards on a slate-100 canvas, under a slate-900 status bar.
- Flat at rest: depth comes from hairlines and tonal canvas, shadows only on floating layers.
- Pill-round controls, softly cornered containers.
- One type family, Geist Sans and Geist Mono, with tabular figures for every number.
- Colour encodes something (status, kind, series, intensity, family, newness) or is absent.

## Colors

A neutral ink-and-paper base carries the whole app; saturated colour enters only to encode meaning, and the start page owns the brand blue and amber.

### Primary
- **Workbench Ink** (#171717): text, the primary button fill, active segmented-nav items, and the base of every derived tint. Borders, washes and muted text are opacity steps of this ink, never new greys (the ramp is tabled in docs/styling.md: /5 hover wash, /10 chip fill, /15 hairline, /25 control border, /55 to /70 muted text).
- **Novedu Deep Blue** (`brand-deep`): the brand symbol's blue. On the start page it fills the XP meter, colours the "How XP works" link and its underline, draws the calendar's day cursor, and is the darkest calendar intensity step.

### Secondary
- **Amber of the New** (`brand-amber`, with `amber-wash`, `amber-line`, `amber-halo`, `amber-ink`): reserved for "new since your last visit". The ring around a new badge disc or calendar pin, the dot and wash of the new-badges strip, and the small "New" chip next to a badge name.
- **Badge family colours** (`fam-rhythm` Rhythm Green, `fam-practice` Practice Blue, `fam-coding` Coding Violet, `fam-secret` Secret Slate): one solid colour per badge family, filling earned badge discs, calendar pins, Almost-there meters and the weekly-streak squares (Rhythm Green). Glyphs on them are white, except on Secret Slate, where the glyph is `brand-amber`: a secret badge is the one earned surprise on the page. `fam-quiz` (Quiz Gold) shares the gold medal's colour and is light, so its glyph is the dark `gold-ink`. The teacher start page reuses the Badges section and discs for its own two families, `fam-reach` (Reach Teal) and `fam-authoring` (Authoring Grape), with white glyphs; they never appear on the student page.
- **Medal colours** (`gold`, `silver`, `bronze`, each with its dark `-ink` glyph colour): the "Time to refresh" medal discs and the medal count dots. A quiz without a medal gets the outlined locked disc. Medals are practice results, never grades, and the section says so.

### Tertiary
- **Calendar heat ramp** (`heat-0` to `heat-3`): day intensity for 0, 1, 2 to 3, and 4 or more active hours, stepping from cool slate to Novedu Deep Blue. `heat-0` doubles as the empty track of every meter and the inactive streak square.
- **Chart palette** (`chart-1` to `chart-9`, `chart-other`): the categorical series colours for the teacher dashboards, validated for colour-vision deficiency on the light surface, with their own dark steps validated on the dark card. Slots 1 to 8 are the validated order; slot 9 is only the ninth pie slice; `chart-other` is the muted "Other" grey. Charts read these tokens, never a bare hex.

The shipped start page draws its calendar ramp from the brand blue and its streak green from `fam-rhythm`, not from the chart palette; the two sets are deliberately separate.

### Neutral
- **Paper** (`paper`, `card`, #ffffff): the body background and every content surface (cards, tables, editors, inputs, outline buttons).
- **Slate Canvas** (`canvas`, Tailwind slate-100): the full-bleed page backdrop that content cards sit on.
- **Status Night** (`status-bar`, Tailwind slate-900): the top status bar and the calendar tooltip, both with white ink.
- **Control Line** (`border`) and **Focus Grey** (`ring`): the shadcn-named neutrals; `ring` is the focus outline colour on buttons, inputs and icon buttons.
- **Status colours** (`destructive`, `success`, `warning`): red-700, green-700 and amber-700 for inline errors, success lines and warnings.

### Named Rules
**The Foreground Ramp Rule.** A tint is an opacity step of the ink, not a new hex. Anything outside the ramp snaps to a token or a stock Tailwind palette colour.

**The Colour Has a Job Rule.** Saturated colour appears only where it encodes something: a kind or status badge, a chart series, calendar intensity, a badge family, or newness. Decorative colour is not part of the system.

**The Amber Means New Rule.** `brand-amber` and its tints mark exactly one thing: what was earned since the last visit. They never mark warnings, emphasis or selection.

## Typography

**Display Font:** Geist Sans (with ui-sans-serif, system-ui, sans-serif)
**Body Font:** Geist Sans (same stack)
**Label/Mono Font:** Geist Mono (with ui-monospace, monospace)

**Character:** One neutral grotesque at small, dense sizes, tightened slightly at heading sizes. Hierarchy comes from weight and a few size steps, not from a second family. Geist Mono marks things a person types or copies: codes, keys, YAML.

### Hierarchy
- **Display** (800, 48px on phones and 60px from md up, line-height 1, tracking -0.05em): the single big figure of the start page, the student's level number.
- **Headline** (700, 24px, tracking -0.025em): the page's h1, e.g. the start page greeting.
- **Stat** (700, 24px, line-height 1, tabular figures): big numbers in stat tiles and the weekly-streak count.
- **Title** (600, 16px, tracking -0.025em; 18px for the start page's "Your progress"): start-page section titles.
- **Title Small** (600, 14px): dashboard card titles and button labels.
- **Body** (400, 14px): the working size for nearly all running text, list rows, inputs and muted lines (ink at 65 to 70 percent for secondary text). Explanatory paragraphs are capped at `max-w-prose`.
- **Label** (600, 12px, uppercase, tracking 0.025em, ink at 65 percent): the shared META_LABEL. It names a value (Level, a stat tile) or a group (Recently used, a badge family); it is a heading or a field name in its own right, never a decorative line above another heading.
- **Caption** (400, 12px, ink at 65 percent): criteria, legends, dates, axis labels.
- **Mono** (Geist Mono, 14px, tracking 0.05em in the code field): codes and other literal strings.

### Named Rules
**The One Family Rule.** Components never name a font. Geist Sans is the default; `font-mono` is the only switch.

**The Tabular Figures Rule.** Every number that can change (XP, counts, ratios like 14 / 16, the level) is set in tabular figures so values align and do not jitter.

## Layout

Every page renders inside `Main` (a centered column, max 1280px) and, when it scrolls, `PageBody`: the full-bleed slate-100 canvas with the window-edge scrollbar, a 20px side gutter, 16px top and 24px bottom padding, and a 16px vertical gap between stacked sections. List pages use PageBody's `wide` column (1280 to 1760px, sized by the table). The status bar sits above, the environment ribbon directly below it.

Breakpoints are Tailwind's defaults, mobile-first; `md` (48rem) is the main switch and is shared with JavaScript on the writing surface.

The student start page stacks full-width blocks in one column: Continue, then the new-badges strip (only when there is something new), Your progress, the 26-week calendar, Time to refresh beside Almost there (two columns from lg, stacked below), Badges. Inside cards it splits with internal hairline dividers rather than separate cards:
- Continue: 5 of 12 columns for greeting and code field, 7 for Recently used (two columns from md), from lg; stacked below lg with a bottom hairline.
- Your progress: level and XP on the left, the streak in a fixed panel (min 288px) on the right from md; stacked with a top hairline on phones.
- Almost there: its items in two columns from md, one again from lg, where it shares the row with Time to refresh. Badges: one family per column, two from md; the students' five families three from lg and five from xl, the teachers' two stay two.
- The calendar: 26 flexible 3:2 columns from md (min width 760px); on phones fixed 20px day cells that scroll horizontally inside the card, starting at today.

A teacher's start page is a different stack, also one column of full-width blocks 16px apart:
- The header: the h1 greeting on the left, the outline Teacher Guide pill on the right; it wraps under the greeting on phones. A teacher without any code sees this header with one muted line, and the Badges card.
- The new-badges strip, as on the student page, only when there is something new.
- The attention bar ("Needs you"): one card holding the title and three counters in a wrapping row; the open counter's codes unfold below a hairline inside the same card. On phones the title and every counter take the full width, one per row.
- "Last 30 days", a bare section title with its scope caption on the right, over six stat tiles in a grid: six columns from lg, three from md, two on phones. A footnote caption sits under the grid.
- Top activities: a card with a five-column table (rank, activity, kind, interactions, outside school hours) and a hairline-topped footer caption with the link to the usage dashboard. On phones the table head becomes screen-reader-only and each row folds into a grid entry: the rank on the left, the label with the kind pill on the right, then interactions and the share as plain lines.
- Badges: the student page's Badges card with the teacher's two families (Reach, Authoring); no XP on earned badges.

Card padding is 16px horizontal on phones and 24px from md, 20px vertical.

## Elevation & Depth

The system is flat. Cards rest on the canvas with a 1px hairline (ink at 15 percent) and no shadow; depth is the tonal step from slate-100 canvas to white card. Inside a card, regions are separated by hairlines, never by nested shadows. Shadows exist only on things that float over other content.

### Shadow Vocabulary
- **Floating panel** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): dropdown menus and the dark tooltip.
- **Pin lift** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): badge pins sitting on top of calendar cells.

### Named Rules
**The Hairline Not Shadow Rule.** A resting surface is separated by a hairline and the canvas tone. If it does not float above other content, it has no shadow.

## Shapes

Two shape families. Everything you press or type into is a full pill: buttons, inputs and selects, icon buttons, status and kind badges, meters, badge discs and pins. Containers are softly cornered: 8px for app cards, tables, stat tiles, menus and the new-badges strip; 12px for the start page's cards, dialogs and centered notices; 6px for segmented-nav items, menu rows and calendar day cells from md (4px on phones). Rings mark state on round things: an inset 1px ring for a locked badge disc, a 2px ring with a 2px card-coloured gap for today and for new items.

### Named Rules
**The Pill Control Rule.** If it is a control or a chip, it is fully round. If it holds content, it has an 8px or 12px corner.

## Components

### Buttons
Confident, compact pills.
- **Shape:** full pill (9999px), 36px high (32px for `sm`), semibold 14px label, 16px icon with a 6px gap.
- **Primary:** ink fill, white label; hover drops to 90 percent ink.
- **Outline:** white fill, 1px control border (ink at 25 percent), ink label; hover adds the 5 percent ink wash. Used for secondary actions such as "Show all badges".
- **Destructive outline:** red border at 45 percent, red label, 10 percent red wash on hover.
- **Link:** plain underlined text at 70 percent ink, full ink on hover.
- **Focus:** 2px outline in `ring`, offset 2px. **Disabled:** 50 percent opacity, not-allowed cursor.
- **Icon button:** a 36px round outline button holding one 16px icon, labelled by `aria-label`.

### Chips
- **Style:** the shared Badge, a 12px semibold pill. Soft tones (10 to 20 percent tint, 800-weight ink) for statuses; `solid` (filled, white text) for module or kind identity; optional uppercase.
- **On the start page:** Recently used rows carry the neutral activity-kind badge; a new badge carries a small "New" chip in `amber-wash` with `amber-ink` text.
- **Module badge:** a code's kind on teacher pages (the Codes list, the teacher start page) is the one shared ModuleBadge: the solid, uppercase pill in the module's identity tone with its 12px icon before the label (Tutor teal-700, Quiz amber-700, Writing green-700, Coding blue-800). Teacher surfaces use it rather than restyling a kind.
- **Count chip:** a small ink pill (22px high, at least 22px wide, bold 12px tabular figures, white text) holding a count inside a control, as on the attention counters.

### Cards / Containers
- **Corner Style:** 8px (app card, dashboard card, stat tile); 12px (start-page card, dialog, centered notice).
- **Background:** white `card` on the slate-100 canvas; centered notices use a 5 percent ink wash instead.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px hairline, ink at 15 percent.
- **Internal Padding:** 16px (dashboard card), 16px by 12px (stat tile), 16px/24px by 20px (start-page card).
- **States:** a card whose data failed to load shows the shared muted "This data could not be loaded right now" line in place of its content, never an error colour. Loading skeletons are the empty card at its expected height.

### Inputs / Fields
- **Style:** the same pill as buttons: 36px high, white fill, 1px control border, 12px side padding, 14px text, placeholder at 40 percent ink. The code field sets its value in Geist Mono with wide tracking.
- **Focus:** 2px `ring` outline, offset 2px.
- **Error / Disabled:** inline `destructive` line below the control (FieldError, announced as an alert); disabled at 50 percent opacity. Field labels are 12px semibold at 70 percent ink.

### Navigation
- **Status bar:** slate-900, white ink, 8px by 20px, holding the burger menu, the app and school name, and the user menu pill.
- **Menus:** an 8px-cornered white panel with a hairline and the floating-panel shadow; rows are 14px with a 5 percent hover wash and 6px corners.
- **Segmented nav:** a carded row of links (8px corner, hairline, 4px inner padding); the current item is filled with ink and white text, others are 70 percent ink with a hover wash.

### Season Calendar (signature)
The start page's spine: 26 ISO weeks by 7 days, one cell per day coloured by the heat ramp, month labels above and Mon/Wed/Fri/Sun beside it in caption type. Future days are an inset hairline outline. Today carries a 2px ink ring with a 2px card gap; the keyboard day cursor is a 2px `brand-deep` outline offset 4px, drawn over today's ring so it stays visible there. The whole grid is one tab stop; arrow keys move the cursor. Cells darken slightly on hover. A legend sits below: the four heat swatches, a pin sample, a new-pin sample, and the time-zone note.

### Badge Pin and Badge Disc (signature)
- **Disc:** a round 40px (32px in lists) disc in the badge family colour with a white 20px (16px) Feather-style stroke icon. A locked badge is a white disc with an inset hairline ring and a 55 percent ink icon. A new badge adds a 2px `brand-amber` ring with a 2px card-coloured gap.
- **Pin:** the disc shrunk to 24px (20px on phones) and centred on the calendar day it was earned, with a 2px card-coloured ring and the pin lift shadow; when a day holds several badges, an ink count bubble sits on its top-right corner. Pins are buttons: hover and focus scale them to 110 percent over 200ms ease-out, focus adds a 2px ink outline offset 4px, and hover, focus or tap shows the dark tooltip.

### Meter
A pill track in `heat-0` with a pill fill scaled on the x axis (a transform fed by a CSS variable, never an animated width). 14px high for XP in `brand-deep`, 6px for Almost-there rows in the badge's family colour, and 6px by 72px in `chart-1` for a share column on the teacher start page (decorative there, beside its tabular percentage, and hidden on phones). Paired with a tabular ratio and, for XP, the "to next level" line.

### Attention Counter (signature)
The teacher start page's to-do list. Each counter is an outline pill button (36px) holding a 16px icon, its label, an ink count chip and a chevron. It opens its codes in place, one panel at a time: the open counter inverts to an ink fill with white label, its count chip turns white with ink figures, and the chevron turns half a turn over 200ms. The first counter with something in it starts open. The panel lists up to five codes as hover-washed rows (label in semibold 14px, the code in 12px mono at 65 percent ink, the detail right-aligned in tabular muted text), separated by 10 percent ink hairlines, with a caption footer explaining the list and how many codes are not shown.
- **Empty:** a counter with nothing in it is not a button but a quiet green pill (emerald wash, emerald-800 semibold text, a `success` check icon) saying what is clear, so a calm week reads calm.
- **Unavailable:** a neutral 5 percent ink pill naming the counter and saying it could not be loaded, never an error colour.
- **Status colour:** a code whose window closes today shows its detail in semibold `destructive`; open reports carry the soft orange status badge. Nothing else on the bar is coloured.

### Tooltip
The dark floating label shared by the calendar pins and the info button beside a column header: `status-bar` fill, white 12px text at a snug line height, 8px corners, 8px by 10px padding, the floating-panel shadow, at most 256 to 288px wide. It opens on hover and keyboard focus, stays open while the pointer moves onto it, and closes on Escape. The info button is a 20px round ghost holding a 14px info icon at 60 percent ink, with a 5 percent wash and full ink on hover.

### New-badges Strip
A single quiet line, shown only when there is something new — between Continue and Your progress on the student page, under the header on the teacher page: `amber-wash` fill, `amber-line` border, 8px corners, `amber-ink` 14px text, led by a 10px `brand-amber` dot with a 3px `amber-halo` ring. It carries a count, nothing to click, and no animation.

### Icons
Feather-style inline SVGs: 24px viewBox, 2px round-capped stroke in `currentColor`, always decorative (`aria-hidden`), sized by the parent (16px in buttons, 14px beside muted text, 28px beside the streak count).

## Do's and Don'ts

### Do:
- **Do** lay every scrolling page on PageBody's slate-100 canvas and put content on white cards with a 1px ink-at-15-percent hairline.
- **Do** take every colour from a token or the foreground opacity ramp (/5, /10, /15, /25, /55 to /70); snap anything else to a stock Tailwind colour.
- **Do** keep controls and chips fully round and 36px high (32px small), with the 2px `ring` focus outline offset 2px.
- **Do** set changing numbers in tabular figures, and use the 12px uppercase META_LABEL to name a value or a group.
- **Do** reserve `brand-amber` and its tints for "new since your last visit", shown as a ring, a dot, a wash or a "New" chip — the one other use is the glyph on a secret badge's slate disc.
- **Do** colour badge discs, pins and their meters by family token (`fam-rhythm`, `fam-practice`, `fam-quiz`, `fam-coding`, `fam-secret`; the teachers' `fam-reach`, `fam-authoring`), and calendar intensity by the `heat-0` to `heat-3` ramp.
- **Do** separate regions inside a card with hairlines, and stack start-page sections as full-width cards 16px apart.
- **Do** promote any look used in two places into `components/ui/` or the owning shared recipe (`app/_home/home-ui.ts` for the start page), as docs/styling.md requires.

### Don't:
- **Don't** set the `dark` class from React or add a colour that has no dark value: every token has one in `:root.dark`, and a stock palette class carries a `dark:` partner.
- **Don't** put a bare hex in a component, use `@apply`, or write app CSS outside the declared layers.
- **Don't** give a resting card a shadow; shadows belong only to menus, tooltips and calendar pins.
- **Don't** use amber for warnings, emphasis or selection; warnings use `warning`, selection uses ink.
- **Don't** celebrate on the start page with overlays, confetti or entrance animation; a new badge gets its amber ring and the quiet strip.
- **Don't** add decorative colour: if a colour does not encode a status, kind, series, intensity, family or newness, use ink.
- **Don't** introduce a second typeface or name a font in a component.
- **Don't** set an uppercase label above a heading as decoration; META_LABEL is itself the heading or field name.
