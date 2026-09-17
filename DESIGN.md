# EchoVoice — Design System
> Voice rehearsal instrument on a midnight canvas

**Theme:** dark
**Based on:** Linear's design system (adapted for an audio/rehearsal tool UI)

EchoVoice's interface is a dark instrument panel — near-black canvas with paper-white type, one electric accent color reserved for the single primary action per screen, and hairline borders instead of shadows. The UI stays quiet so the waveforms, pitch contours, and audio playback are the visual focus. Components feel precision-machined: compact paddings, tight tracking on headings, no decorative ornament. The product's data (audio waveforms, comparison overlays, recording states) is the only texture.

---

## Color Tokens

```css
:root {
  /* ── Surfaces ── */
  --color-void: #08090a;        /* Page canvas — full-bleed background */
  --color-carbon: #0f1011;      /* Cards, modals, nav bar */
  --color-obsidian: #161718;    /* Elevated panels, modal overlays */
  --color-graphite: #23252a;    /* Hairline borders, dividers, ghost button outlines */
  --color-smoke: #383b3f;       /* Higher-contrast borders, section separators */

  /* ── Text ── */
  --color-ash: #62666d;         /* Muted body text, inactive icons, metadata */
  --color-fog: #8a8f98;         /* Tertiary text, placeholders */
  --color-mist: #d0d6e0;       /* Secondary headings, body text on dark surfaces */
  --color-paper: #ffffff;       /* Primary headings, max-contrast text */

  /* ── Accent ── */
  --color-accent: #e4f222;      /* Primary CTA only — Record, Compare, Generate */
  --color-accent-text: #08090a; /* Text on accent buttons */

  /* ── Semantic ── */
  --color-success: #27a644;     /* Verification pass, match indicators */
  --color-error: #eb5757;       /* Errors, mismatch highlights, recording stop */
  --color-info: #02b8cc;        /* Informational badges, tips */
  --color-tag: #6366f1;         /* Tags, badges, category labels */

  /* ── Waveform & Pitch ── */
  --color-waveform-ideal: #e4f222;  /* AI-generated ideal delivery waveform */
  --color-waveform-user: #02b8cc;   /* User's recorded attempt waveform */
  --color-waveform-bg: #0f1011;     /* Waveform container background */
  --color-divergence: #eb5757;      /* Pitch divergence highlight zones */
}
```

## Typography

**Primary:** Inter (variable), fallback: system-ui, -apple-system, sans-serif
**Mono (timestamps, technical labels):** JetBrains Mono, ui-monospace, monospace

```css
:root {
  --font-primary: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  /* Weights — never exceed 590, no bold */
  --fw-regular: 400;
  --fw-medium: 510;
  --fw-semi: 590;
}
```

### Type Scale

| Role | Size | Weight | Line Height | Letter Spacing | Use |
|------|------|--------|-------------|----------------|-----|
| display | 48px | 510 | 1.0 | -0.022em | App title on landing/onboarding |
| heading | 32px | 510 | 1.13 | -0.022em | Section headers (Clone Voice, Compare) |
| subheading | 24px | 400 | 1.33 | -0.012em | Modal titles, step labels |
| body-lg | 20px | 590 | 1.33 | -0.012em | Emphasis text, key instructions |
| body | 16px | 400 | 1.5 | default | Default body text |
| body-sm | 15px | 400 | 1.6 | -0.011em | Secondary descriptions |
| caption | 13px | 400 | 1.2 | default | Metadata, timestamps, labels |
| mono | 12–14px | 400 | 1.4 | -0.013em | Duration counters, pitch values |

**Rules:**
- No bold (700+) anywhere — weight 510 for headings, 590 max for emphasis
- Tight tracking (-0.022em) on anything 32px+ — non-negotiable
- Body text always --color-mist, never pure white
- Pure white (--color-paper) for headings only

## Spacing & Shape

```css
:root {
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-48: 48px;
  --spacing-64: 64px;

  --radius-sm: 2px;      /* badges, tiny elements */
  --radius-md: 6px;       /* buttons, inputs */
  --radius-lg: 12px;      /* cards, modals */
  --radius-pill: 9999px;  /* pills, record button */

  --page-max-width: 960px;
  --card-padding: 24px;
  --element-gap: 8px;
  --section-gap: 48px;
}
```

**Rules:**
- No drop shadows for elevation — use hairline borders (1px --color-graphite) and surface-color shifts
- Three radii max: 6px (buttons/inputs), 12px (cards/modals), 9999px (pills/record button)
- 12px is the max card radius — never rounder

## Elevation (no shadows)

| Level | Surface | Value | Use |
|-------|---------|-------|-----|
| 0 | Void | #08090a | Page background |
| 1 | Carbon | #0f1011 | Cards, waveform containers, nav |
| 2 | Obsidian | #161718 | Modals, elevated panels, dropdowns |
| 3 | Graphite | #23252a | Borders, dividers, ghost fills |

Depth = surface color shift, not shadow. A card on the void canvas is #0f1011 with a 1px inset border of #23252a. A modal is #161718 over a dimmed backdrop.

---

## EchoVoice Components

### Record Button (Primary Action)
The single accent element per screen.

- **Idle:** 64×64 circle, background --color-accent (#e4f222), icon: microphone in --color-accent-text (#08090a). border-radius: 9999px.
- **Recording:** background pulses between --color-error (#eb5757) and a slightly darker red. Icon swaps to square (stop). Subtle CSS pulse animation, no complex JS animation.
- **Disabled:** background --color-graphite, icon --color-ash.
- Only ONE accent-colored element visible at a time — if the record button is showing, no other element is accent-colored.

### Waveform Visualizer
- Container: background --color-waveform-bg (#0f1011), border-radius 12px, border 1px --color-graphite, padding 16px.
- Waveform stroke: 2px, color --color-mist during recording.
- Height: 120px for single view, 200px for comparison split.
- Time axis labels: --font-mono, 12px, --color-fog.

### Comparison Split View (core differentiator)
- Two stacked waveform containers inside a single card (--color-carbon, 12px radius, 1px --color-graphite border).
- Top: "Ideal Delivery" — waveform in --color-waveform-ideal (#e4f222), label in --color-fog caption text.
- Bottom: "Your Attempt" — waveform in --color-waveform-user (#02b8cc), label in --color-fog caption text.
- Divergence zones: semi-transparent overlay bands in --color-divergence (#eb5757) at 10% opacity over regions where pitch contours diverge beyond threshold.
- Sync playhead: a 1px vertical line in --color-paper that moves across both waveforms simultaneously.
- Score badge: top-right corner of the card, --color-tag background, white text, border-radius 4px, caption size. Shows match percentage.

### Playback Controls
- Row: horizontal flex, 8px gap, centered below waveform.
- Play/Pause: ghost button — transparent bg, 1px --color-graphite border, --color-mist icon, 6px radius, 36×36.
- Skip buttons (±5s): same ghost style, smaller (28×28).
- Speed toggle (0.5×/1×/1.5×): pill button — rgba(255,255,255,0.05) bg, --color-mist text, 9999px radius, 13px caption.
- Progress bar: thin (4px) horizontal bar, --color-graphite track, --color-accent fill for ideal playback, --color-info fill for user playback.

### Cloning Modal (5-Step Flow)
- Backdrop: rgba(8, 9, 10, 0.8).
- Modal: background --color-obsidian (#161718), border-radius 12px, border 1px --color-graphite, max-width 520px, padding 32px.
- Step indicator: horizontal dots row, 8px gap. Active dot: --color-accent, 8px circle. Inactive: --color-graphite, 8px circle.
- Step titles: 24px, --fw-medium (510), --color-paper.
- Step descriptions: 15px, --fw-regular, --color-fog.

**Step 1 — Upload or Record:**
- Two option cards side by side: --color-carbon bg, 12px radius, 1px --color-graphite border. Icon + label centered. Hover: border brightens to --color-smoke.

**Step 2 — Active Recording:**
- Live waveform visualizer (120px, same spec as above).
- Timer in --font-mono, 20px, --color-mist, centered below waveform.
- "Recording..." label with pulsing red dot (--color-error).

**Step 3 — Review & Metadata:**
- Playback of recorded clip with mini waveform.
- Voice name input: bg rgba(255,255,255,0.02), border 1px rgba(255,255,255,0.08), 6px radius, 14px Inter, --color-mist text. Focus: border → --color-mist.

**Step 4 — Verification (optional):**
- Prompt sentence displayed in --color-paper, 16px.
- User records themselves reading it; browser SpeechRecognition compares text.
- Pass: --color-success badge. Fail: --color-error badge with retry option.

**Step 5 — Completion:**
- Success icon (checkmark) in --color-accent.
- "Voice cloned" heading, 24px.
- "Start rehearsing" button — the single accent CTA.

### Script Input
- Textarea: bg rgba(255,255,255,0.02), border 1px rgba(255,255,255,0.08), border-radius 6px, padding 12px 14px, --color-mist text, 16px Inter. Placeholder in --color-fog.
- Character count: caption size, --color-ash, bottom-right.
- Generate button below: accent CTA (only if no other accent element is on screen).

### Navigation Bar
- Full-width, bg --color-carbon, height 56px, border-bottom 1px --color-graphite.
- Logo: "EchoVoice" wordmark in --color-paper, 16px, --fw-medium.
- Nav items: --color-mist, 13px, --fw-regular. Active: --color-paper with 2px bottom accent line.
- Right side: ghost settings icon button.

### Toast / Error Messages
- Fixed bottom-center, max-width 400px.
- Background --color-obsidian, border 1px --color-graphite, border-radius 6px, padding 12px 16px.
- Error: left border 2px --color-error. Info: left border 2px --color-info. Success: left border 2px --color-success.
- Text: 14px, --color-mist. Dismiss: ghost × button.
- Always ends with actionable guidance ("Try again" / "Use backup clip").

### Status Badges
- Background rgba(255,255,255,0.05), border-radius 4px, padding 2px 8px, 12px Inter, --color-fog text.
- Variants: success (--color-success bg at 15% opacity, --color-success text), error (same pattern with --color-error), info (--color-info).

---

## Do

- Use --color-accent for ONE primary action per screen — never for decoration
- Use hairline borders (1px --color-graphite) for all surface separation — no box-shadows
- Keep all headings at weight 510 max — the system deliberately avoids heavy type
- Use --color-mist for body text, --color-paper for headings only
- Let waveforms and pitch contours be the visual centerpiece — the chrome stays quiet
- Use --font-mono for all time-based data: durations, timestamps, pitch values
- Every error state must end with actionable next-step text

## Don't

- Don't use bold (700+) anywhere — cap at weight 590 for emphasis text
- Don't use colored text for body copy — body sits in the grey scale (--color-mist / --color-fog / --color-ash)
- Don't add shadows to cards or modals — depth comes from surface color shifts
- Don't use radii above 12px on cards/modals — only the record button and pills get 9999px
- Don't have two accent-colored elements visible simultaneously
- Don't use gradients on buttons, cards, or text
- Don't apply the waveform accent colors (lime, teal) to non-audio UI elements
