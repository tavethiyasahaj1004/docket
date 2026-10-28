# Design System

## Philosophy

**Ocean Blue.** Clean, professional, and trustworthy. Docket uses a cool blue
palette that feels modern and calm — clear skies over deep water. Customers feel
confident submitting requests; agents feel focused working in it.

---

## Architecture

Docket's UI is built from layers, and each one has a job it is not allowed to
take from the others:

**daisyUI is the primary component styling system.** Everything else exists to
supply behaviour daisyUI's CSS-only patterns cannot, or layout daisyUI has no
opinion about.

| Layer | Owns | Never used for |
|-------|------|----------------|
| **daisyUI component classes** | Component appearance: `btn`, `badge`, `card`, `modal-box`, `menu`, `input`, `textarea`, `select`, `table`, `checkbox`, `toggle`, `skeleton`, `divider`, `card-actions`, `menu-title`, `rounded-box`/`rounded-field` | Behaviour. daisyUI's state machines (`modal`'s visibility, `dropdown`'s `:focus-within`, `collapse`'s peer checkbox, `tooltip`'s `data-tip`) are **not** used |
| **daisyUI theme tokens** | Every colour, radius and size in the app (`base-100`, `primary`, `--radius-field`, …) | — |
| **Headless UI** | Behaviour where real interaction logic is needed: `Dialog`, `Menu`, `Listbox` — focus traps, roving tabindex, typeahead, ARIA | Styling. It ships none |
| **Floating UI** | Behaviour Headless UI has no equivalent for: controlled `Popover`, `Tooltip`, collision-aware placement, arrows | Anything Headless UI already covers |
| **Native HTML** | Controls the platform already implements: `<input type="checkbox">` behind `checkbox`/`toggle` | — |
| **Tailwind utilities** | Layout, positioning, responsive behaviour, and the brand details daisyUI has no opinion about (`uppercase`, `tracking-ui`, icon sizing) | Re-implementing anything daisyUI already ships |

The rule of thumb when adding or changing a primitive: **reach for the daisyUI
class first, accept its native appearance, and only add a Tailwind override
where daisyUI is factually wrong for this app** — every such override in
`components/ui/*` carries a comment saying why.

There is **no shadcn, no Radix, and no `class-variance-authority`** in this
project. Do not reintroduce them. Variants are plain lookup objects that map
onto daisyUI's own modifiers (see `components/ui/button.tsx`).

### Pairing daisyUI with Headless UI

daisyUI and Headless UI are not alternatives — they are layers. Headless UI
owns open state, focus and keyboard; daisyUI owns what the thing looks like.
Two mechanics make the pairing work:

1. **Render the DOM shape daisyUI expects.** `menu`'s rules are scoped to a
   `<ul><li>` tree, so `MenuItems`/`ListboxOptions` render `as="ul"` and
   `MenuItem`/`ListboxOption` render `as="li"` with the row's content in a
   `<span>` inside — which is exactly `.menu :where(li > *)`.
2. **Map Headless UI's state onto daisyUI's own state classes.** Headless UI
   uses a roving tabindex and never moves DOM focus, so `:focus-visible` never
   fires. Its render prop exposes `focus`/`selected`, which are mapped to
   daisyUI's `menu-focus`, `menu-active` and `menu-disabled` rather than
   re-implemented in Tailwind. Real `:hover` daisyUI still handles itself.

The same idea applies to `Dialog`: Headless UI owns mount, Escape, focus trap
and transition, while `modal-box` supplies the surface. The one thing
`modal-box` cannot own is its own visibility (it ships `opacity: 0; scale: .95`
that only `.modal[open]`/`.modal-open` undo), so the panel pins
`opacity-100 scale-100` and hands the closed state to `data-closed`.

### Why Tailwind utilities always win

daisyUI 5 emits its component classes into a *nested* cascade layer
(`@layer utilities { @layer daisyui.l1.l2.l3 { … } }`), while Tailwind emits
utilities unlayered inside `@layer utilities`. Unlayered declarations beat
nested-layer ones **regardless of specificity**, so:

```tsx
<button className="btn bg-primary" />   // bg-primary wins, always
```

This is the mechanism the whole system leans on. It means:

- A daisyUI component class can be adopted for structure while the brand's
  colours stay in Tailwind utilities — including in states like `:disabled`,
  where daisyUI would otherwise recolour the control.
- A caller's `className` always wins over the primitive's defaults.
- `cn()` (clsx + tailwind-merge) only dedupes *Tailwind* classes. daisyUI class
  names pass through untouched — with one exception worth knowing: `table` is
  also a Tailwind `display` utility, so `cn("table", "hidden")` drops it. That
  is the desired behaviour, but do not pass other `display` classes to `Table`.

### Where the daisyUI theme is defined

`app/globals.css` holds the whole thing:

- `@plugin "daisyui" { themes: false }` — no stock themes are shipped.
- `@plugin "daisyui/theme" { name: "docket"; … }` — aliases daisyUI's expected
  variable names onto Docket's own tokens, so `btn-primary`, `card`, `input`
  etc. resolve to brand values rather than a second palette.
- `@theme inline { … }` — exposes those same tokens as Tailwind utilities
  (`bg-base-100`, `text-base-content-muted`, …).
- `:root` / `.dark` — the light and dark values.

Sizing knobs set on the theme, worth knowing because primitives depend on them:

| Variable | Value | Effect |
|----------|-------|--------|
| `--radius-selector` | `--radius-sm` (0.3rem) | checkbox, toggle, badge |
| `--radius-field` | `--radius-md` (0.4rem) | `btn`, `input`, `select`, `textarea` — identical to `rounded-md` |
| `--radius-box` | `--radius-xl` (0.7rem) | `card`, `modal-box`, `skeleton` — identical to `rounded-xl` |
| `--size-field` | `0.25rem` | `btn`/`input`/`select` height = `--size-field × 10` = `2.5rem` (`h-10`) |
| `--border` | `1px` | every daisyUI component border |
| `--depth`, `--noise` | `0` | flat surfaces — no gradients, insets or texture |

---

## Color System

### Agent + admin portals — daisyUI theme tokens

These are the tokens to reach for in `(agent)`, `(admin)`, `(orbit)` and any
shared component. They are defined for **both** light and dark mode and follow
the admin's chosen preset.

| Token | Role |
|-------|------|
| `base-100` | Elevated surface — cards, popovers, modals, menus, the top bar |
| `base-200` | Page / body surface, and input fills |
| `base-300` | Border tier and hover fill |
| `base-content` | Primary text |
| `base-content-muted` | Secondary text, captions, timestamps, placeholders |
| `primary` / `primary-content` | Primary buttons, links, focus rings, active accents |
| `secondary` / `secondary-content` | Secondary buttons, subdued fills |
| `sidebar`, `sidebar-content`, `sidebar-accent`, `sidebar-border`, `sidebar-primary` | The app frame |
| `success`, `warning`, `error` (+ `-content`) | Status only — never layout |
| `chart-1` … `chart-8`, `chart-other` | Categorical series colour |

`base-100/200/300` are **neutral in every preset**. Brand colour lives in
`primary`/`secondary`/`sidebar`, matching how every stock daisyUI theme works —
so switching preset recolours buttons, links, the sidebar and focus rings, while
borders and hover fills stay a fixed neutral gray-blue.

### Customer portal — the 4 brand utilities

The customer portal (`app/(customer)/`) has no `ThemeProvider` and is
**light-only**, so it uses the brand colours directly. These utilities are
*static* — they do not flip in dark mode, which is exactly why they must not be
used in the agent/admin UI.

```css
/* app/globals.css — runtime-overridable by ThemeProvider */
:root {
  --brand-cream: #bdddfc;  /* lightest — page backgrounds        */
  --brand-sand:  #88bdf2;  /* light    — borders, muted fills    */
  --brand-stone: #6a89a7;  /* mid      — secondary text, icons   */
  --brand-bark:  #384959;  /* darkest  — headings, primary CTA   */
}
```

Used as `bg-cream`, `border-sand`, `text-stone`, `text-bark`, plus the
`.bg-public` gradient wash for public pages. **Never hardcode hex values.**

### Translation table

If you are touching agent/admin code and reach for one of the old static
utilities, use the token instead:

| Old (static, light-only) | Use instead (adapts to dark + preset) |
|---|---|
| `bg-white` | `bg-base-100` |
| `bg-cream` | `bg-base-300` |
| `text-bark` | `text-base-content` |
| `text-stone` | `text-base-content-muted` |
| `border-sand` | `border-base-300` |
| `bg-bark` / `text-cream` | `bg-primary` / `text-primary-content` |
| `ring-bark` | `ring-primary` |
| sidebar chrome | `bg-sidebar`, `text-sidebar-content`, `bg-sidebar-accent`, `border-sidebar-border` |

### Accessibility

| Combination | Contrast | Pass |
|-------------|----------|------|
| `base-content` (#384959) on `base-100` (#ffffff) | ~8.1:1 | AAA ✓ |
| `base-content` on `--page` (#bdddfc) | ~5.2:1 | AA ✓ |
| `primary-content` on `primary` | ~8.1:1 | AAA ✓ |
| `base-content-muted` (#6a89a7) on `base-100` | ~3.5:1 | AA large text only |

**Rule:** never use `base-content-muted` for body text or form labels — only
captions, timestamps and helper text. Primary text and labels use
`base-content`.

### Theme presets

Admins pick a colour preset and an appearance mode (light / dark / auto) at
`/admin/appearance`; both persist to `platform_settings` and apply at runtime
with no CSS rebuild. Six presets ship: `default`, `ocean`, `forest`, `sunset`,
`indigo`, `slate`. To add one, extend `LIGHT_THEME_VARS` **and**
`DARK_THEME_VARS` in `components/theme/theme-provider.tsx`, then add the swatch
to `appearance-settings-form.tsx`.

---

## Component Inventory

Every primitive in `components/ui/*`, what it is built from, and — where it is
not a daisyUI component — why.

**17 of the 20 primitives now carry daisyUI component classes.** The three that
do not are `label`, `collapsible` and `chart`, for the reasons in the last
column.

| Component | daisyUI class | Behaviour layer | Tailwind still doing | Why not more daisyUI |
|---|---|---|---|---|
| `button` | `btn`, `btn-primary`/`-secondary`/`-outline`/`-ghost`/`-link`, `btn-error btn-soft`, `btn-xs`/`-sm`/`-lg`, `btn-square` | — | `uppercase` + `tracking-ui`, icon sizing | Nothing — colour, size, radius, hover, active, focus and disabled are all daisyUI |
| `badge` | `badge`, `badge-soft`, `badge-outline`, `badge-ghost`, `badge-error` | — | `uppercase` + `tracking-ui`, icon sizing | Nothing |
| `card` | `card`, `card-border`, `card-title`, `card-actions` | — | Section padding model, border colour | `card-border` paints its frame in `base-200`, and this theme sets `base-200 == base-100` in light mode, so the stock border would be invisible → `border-base-300`. `card-body` is not used because this card puts padding on the sections, not on one wrapper |
| `input` | `input` | Native `<input>` | `w-full` (daisyUI caps at 20rem), placeholder colour, `text-base` below `md` | Placeholder colour: daisyUI only styles placeholders on *nested* inputs. `text-base` below `md` stops iOS Safari zooming the page on focus |
| `textarea` | `textarea` | Native `<textarea>` | `field-sizing-content`, `min-h-16`, `resize-none`, placeholder colour, `text-base` below `md` | As `input`, plus the auto-growing behaviour daisyUI has no opinion about |
| `select` | `select`, `select-sm` (trigger); `menu`, `menu-focus`, `menu-active`, `menu-disabled`, `menu-title`, `rounded-box` (popup) | Headless UI `Listbox` | `bg-none` to drop daisyUI's CSS caret (a Phosphor caret is drawn instead), `px-3` for symmetric padding, popup elevation | Nothing |
| `table` | `table` | — | Header fill, uppercase head type, separator colour, row hover | daisyUI draws separators in `base-content 5%` and hovers rows in `base-200` (== `base-100` here) — both are invisible at this palette, so the border tier and hover fill use `base-300` |
| `checkbox` | `checkbox`, `checkbox-primary`, `checkbox-sm`/`-xs` | Native `<input type=checkbox>` | Resting border colour, `aria-invalid` state | `--input-color` drives *both* the resting border and the checked fill, so `checkbox-primary` alone frames an unchecked box in full-strength `primary`. The resting border drops to `base-300` and returns to `primary` only when checked/indeterminate |
| `switch` | `toggle`, `toggle-primary`, `toggle-sm`/`-xs` | Native `<input type=checkbox>` | Track and knob fill, `aria-invalid` state | daisyUI 5's toggle is outline-only — the track is transparent when off and `base-100` when on, so the only difference between states is a dot moving and changing colour. Both states get a filled track instead (`base-300`/`base-content-muted` off, `primary`/`primary-content` on), which is the conventional switch affordance. All four are theme tokens |
| `skeleton` | `skeleton` | — | — | Nothing — fill, `--radius-box` rounding and the reduced-motion-gated sweep are all daisyUI |
| `separator` | `divider`, `divider-vertical`/`-horizontal` | — | — | Nothing. Note daisyUI's axis naming is the reverse of ARIA's: `divider-horizontal` draws a *vertical* rule |
| `dialog` | `modal-box`, `modal-action` | Headless UI `Dialog` | Overlay, panel grid, `opacity-100 scale-100` + `data-closed:` | `modal`/`modal-open` are a CSS-only visibility machine; Headless UI already owns open state, mount, focus trap, Escape and transitions, so only the *surface* is taken from daisyUI |
| `dropdown-menu` | `menu`, `menu-focus`, `menu-active`, `menu-disabled`, `menu-title`, `rounded-box` | Headless UI `Menu` (+ Floating UI for submenus) | Popup elevation/stacking, destructive-row colour, icon sizing | `dropdown` opens on `:focus-within` with no way to drive it from React state, so positioning stays with Headless UI's `anchor` |
| `popover` | `rounded-box` + theme tokens | Floating UI | Panel surface | daisyUI has no *controlled* popover: `dropdown-content` only applies inside a `.dropdown` ancestor, so it cannot reach a portalled panel, and flip/shift/size collision handling has no daisyUI equivalent. An `as="ul"` escape hatch lets list-shaped content adopt `menu` (the dropdown submenu does) |
| `tooltip` | daisyUI's tooltip *appearance*, reproduced from the same tokens (`--color-neutral` surface, `--radius-field`, 0.25/0.5rem padding) | Floating UI | Bubble surface, arrow fill | The `tooltip` class positions `.tooltip-content` absolutely inside a `.tooltip` ancestor and reveals it on `:hover` — it cannot be portalled out of a clipping ancestor, never flips at a viewport edge, and has no controlled open state |
| `calendar` | via `buttonVariants` → `btn` | react-day-picker | Grid, day-cell states | daisyUI's `calendar` only styles Cally's `<calendar-date>` (through `::part()`) and Pikaday's `.pika-*` markup — it has no react-day-picker selectors |
| `sonner` | — (themed from daisyUI tokens via CSS variables) | Sonner | Icons, CSS-variable theming | daisyUI's `toast` is only a fixed-position stacking container; Sonner owns the toast DOM, positioning and stack animation |
| `label` | — | — | Uppercase field label | `label` sets four properties and three must be undone: it mutes the colour to 60% (below this palette's 4.5:1 for form labels), makes the label `inline-flex` (it is a block-level sibling above its control), and forces `white-space: nowrap` (labels wrap in narrow columns) |
| `collapsible` | — | React state | — (callers style it) | daisyUI's `collapse` toggles from a peer checkbox or `:focus`. This disclosure is state-driven and drops content with `hidden`, keeping it out of the a11y tree. It ships no styling to migrate |
| `chart` | — | Recharts | Container, legend, tooltip | daisyUI has no charting component and Recharts renders SVG that component classes cannot reach. Series colour comes from the `chart-1…8` tokens |

`components/common/searchable-select.tsx` is not a primitive but follows the
same pattern — a `select` trigger over a Floating UI popover whose list is a
daisyUI `menu`, with its keyboard cursor mapped onto `menu-focus`.

**Rule:** always use these primitives. Never build a one-off control when one of
them covers it, and never reach for a UI library that was removed.

---

## Typography

Font: **Inter**, with `cv02`/`cv03`/`cv04`/`cv11` feature settings.

| Role | Class |
|------|-------|
| Page title | `text-2xl font-semibold text-base-content` |
| Section title | `text-lg font-semibold text-base-content` |
| Card title | `card-title font-heading tracking-ui uppercase` (via `CardTitle`) |
| Body text | `text-sm text-base-content` |
| Secondary / muted | `text-sm text-base-content-muted` |
| Caption / timestamp | `text-xs text-base-content-muted` |
| Form label | `<Label>` — `text-xs font-semibold tracking-wide uppercase` |
| Eyebrow | `text-2xs tracking-eyebrow uppercase` |
| Button / badge type | `uppercase tracking-ui` over daisyUI's own size ramp — `btn`/`badge` set the font size (0.6875 / 0.75 / 0.875 / 1.125rem across `btn-xs`…`btn-lg`), Docket only adds the case and tracking |

`tracking-ui` (0.1em) and `tracking-eyebrow` (0.16em) are theme tokens, not
arbitrary values.

---

## Buttons

Use `<Button>`; do not hand-roll `btn`. Every variant and size is a daisyUI
modifier — there is no Tailwind colour, height or padding left in the
primitive.

| Variant | daisyUI class | Result |
|---------|---------------|--------|
| `default` | `btn-primary` | Solid `primary` on `primary-content` |
| `outline` | `btn-outline` | Transparent on a `base-content` border, hover fills |
| `secondary` | `btn-secondary` | Solid `secondary` on `secondary-content` |
| `ghost` | `btn-ghost` | Transparent, hover fills `base-content/10` |
| `destructive` | `btn-error btn-soft` | 8% `error` wash, 10% `error` border, `error` text |
| `link` | `btn-link` | `primary`, underlined, no chrome |

| Size | daisyUI class | Height (`--size-field × n`) |
|------|---------------|----------------------------|
| `xs` | `btn-xs` | 1.5rem |
| `sm` | `btn-sm` | 2rem |
| `default` | — | 2.5rem |
| `lg` | `btn-lg` | 3rem |
| `icon`, `icon-xs`, `icon-sm`, `icon-lg` | `btn-square` (+ size) | square, `--btn-p` zeroed |

Focus is daisyUI's own 2px `outline` in the button's colour at `2px` offset —
not a Tailwind ring. Disabled is daisyUI's `base-content/10` fill with
`base-content/20` text. A caller may still override any of it with a Tailwind
utility (unlayered utilities beat daisyUI's nested layer), and a number of
customer-portal buttons do exactly that to pin the static brand palette.

Loading state: spinner replaces or precedes the label. The button never resizes.

---

## Form Fields

```
┌─────────────────────────────────────────┐
│ FULL NAME *                             │  ← <Label>: text-xs font-semibold uppercase
│ ┌─────────────────────────────────────┐ │
│ │ Enter your full name                │ │  ← <Input>: daisyUI `input`
│ └─────────────────────────────────────┘ │
│                                         │
│ DESCRIPTION *                           │
│ ┌─────────────────────────────────────┐ │
│ │   Describe your issue in detail...  │ │  ← <Textarea>: field-sizing-content
│ └─────────────────────────────────────┘ │
│ Helper text or error message            │  ← text-xs text-base-content-muted / text-error
└─────────────────────────────────────────┘
```

- Surface, border and focus are daisyUI's: `base-100` fill on a
  `base-content/20` border, focus raises `--input-color` to `base-content` and
  draws a 2px `outline` at `2px` offset. Height is `--size-field × 10`
  (2.5rem), identical to `Button` and `SelectTrigger`.
- Error state: `aria-invalid` → `border-error`
- Labels always above the field — never floating or placeholder-as-label
- Required fields: `*` in the label colour, not red
- Build forms from controlled inputs (`useState`) + `components/ui/*` — no form
  library

---

## Border Radius

Radius is proportional: `--radius: 0.5rem`, and every step is a multiple of it,
so a preset can rescale the whole UI at once.

Prefer daisyUI's own radius utilities (`rounded-box`, `rounded-field`,
`rounded-selector`) over the Tailwind scale for anything that sits next to a
daisyUI component — they read from the same variables, so a preset rescales
them together.

| Surface | daisyUI source | Tailwind equivalent |
|---------|----------------|---------------------|
| Cards, modals, dialogs, popovers, dropdowns | `--radius-box` — applied automatically by `card`, `modal-box`, `skeleton`; `rounded-box` for anything else | `rounded-xl` |
| Buttons, inputs, selects, textareas, menu rows | `--radius-field` — applied automatically by `btn`/`input`/`select`/`textarea`/`menu`; `rounded-field` for anything else | `rounded-md` |
| Checkboxes, toggles, badges | `--radius-selector` — applied automatically by `checkbox`/`toggle`/`badge` | — |
| Avatars | — | `rounded-full` |

Because `btn`, `badge`, `input`, `select`, `textarea`, `card`, `modal-box`,
`menu` and `skeleton` all carry their own radius, **do not add
`rounded-md`/`rounded-xl` to them** — it is redundant and breaks preset
rescaling.

---

## Spacing

| Token | Value |
|-------|-------|
| Card padding | `p-6` (`--card-spacing`, `p-4` at `size="sm"`) |
| Section gap | `space-y-6` |
| Form field gap | `space-y-4` |
| Sidebar width | `w-60`, `w-16` collapsed |
| Top bar height | `h-14` |
| Nav item padding | `px-3 py-2` |
| Page content padding | `p-6 lg:p-8` |

---

## Status & Category Badges

`<Badge>` is daisyUI's `badge` — a chip with `--radius-selector` rounding, a
1.5rem height and a 1px border. `default`/`secondary`/`destructive` use
`badge-soft`, which mixes 8% of the badge colour into `base-100` for the fill
and 10% for the border, so it stays legible in light *and* dark mode. Status
colour comes from semantic tokens, never from the brand palette:

```tsx
<Badge className="text-success">Closed</Badge>
<Badge className="text-warning">In Progress</Badge>
<Badge variant="destructive">Failed</Badge>
```

| Semantic | Token | Use |
|----------|-------|-----|
| Error | `error` | Destructive actions, validation errors, failed deliveries |
| Warning | `warning` | In-progress / needs attention |
| Success | `success` | Closed, delivered, healthy |
| Neutral | `base-content-muted` | Everything else |

Never use a semantic colour for layout — only for status and errors.

---

## Icons

Use **Phosphor Icons** (`@phosphor-icons/react`) — not Lucide, not Heroicons.
Default `weight="regular"`; `weight="bold"` for active/selected states and
`weight="duotone"` for stat-card glyphs.

| Usage | Icon |
|-------|------|
| Dashboard | `SquaresFourIcon` |
| Ticket | `TicketIcon` |
| Users | `UsersIcon` |
| Internal note | `LockSimpleIcon` |
| Attachment | `PaperclipIcon` |
| Delete | `TrashIcon` |
| Deactivate / reactivate user | `UserMinusIcon` / `UserPlusIcon` |
| Close ticket | `CheckCircleIcon` |
| Reopen ticket | `ArrowCounterClockwiseIcon` |
| Send reply | `PaperPlaneRightIcon` |
| Search | `MagnifyingGlassIcon` |
| Filter | `FunnelsIcon` |
| Admin shield | `ShieldCheckIcon` |
| Sign out | `SignOutIcon` |
| Settings | `GearIcon` |
| Warning / confirm | `WarningIcon` |
| Info | `InfoIcon` |
| Add / new | `PlusIcon` |
| Close / dismiss | `XIcon` |
| Email | `EnvelopeIcon` |
| Calendar | `CalendarIcon` |
| Clock / time | `ClockIcon` |
| Chevron | `CaretRightIcon` / `CaretDownIcon` |

Sizes: `size-4` inline, `size-5` nav, `size-6` standalone/empty states. Buttons
size their own icons (`size-3.5`, or `size-3` at `xs`).

---

## Layout Architecture

### Customer Portal

```
┌─────────────────────────────────────────────────────────┐
│  [Logo] Docket        [Find My Tickets]  [Submit]       │  ← white header, sand border
├─────────────────────────────────────────────────────────┤
│                  .bg-public wash                        │
│          ┌──────────────────────────────────┐           │
│          │  white card — rounded-xl          │          │
│          │  max-w-2xl mx-auto                │          │
│          └──────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

- Background: `.bg-public` (a soft gradient derived from `--brand-cream`)
- Header: white, bottom border `sand`, sticky
- Content: `max-w-2xl mx-auto` for forms, `max-w-3xl mx-auto` for lists/detail
- No sidebar, light-only — brand utilities are correct here

### Agent Portal

```
┌──────────┬──────────────────────────────────────────────┐
│          │ top bar: bg-base-100, border-b border-base-300│
│  SIDEBAR ├──────────────────────────────────────────────┤
│  w-60    │                                              │
│ bg-sidebar│          bg-base-200 surface                │
│          │        [main content area]                   │
│  logo    │                                              │
│  ──────  │                                              │
│  nav     │                                              │
│  ──────  │                                              │
│  profile │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- Sidebar: `bg-sidebar w-60 h-full flex flex-col` (`w-16` collapsed, animated
  with `transition-[width]`)
- Main area: `flex-1`, page surface `bg-base-200`
- Top bar: `h-14 border-b border-base-300 bg-base-100 px-6`

**Page title + description live in the top bar, not in the page.** Every
agent/admin route registers an icon, title, and one-line description in
`ROUTE_META` in `components/agent/topbar.tsx`, keyed by pathname — a route with
no entry renders a blank top bar. So when adding a page under `(agent)` or
`(admin)`, add its `ROUTE_META` entry and **don't** repeat the title as a
page-level `<h1>`. Card/section headings inside the page are separate and still
expected. Standalone docs pages (`/admin/api-keys/docs`,
`/admin/webhooks/docs`) are the one exception — they keep their own in-page
hero heading.

### Ticket Detail (Agent)

```
┌──────────┬────────────────────────────┬─────────────────┐
│ SIDEBAR  │   THREAD                   │   INFO SIDEBAR  │
│  (nav)   │   (flex-1, min-w-0)        │   w-80          │
│          │  Subject + badges          │  Status         │
│          │  [customer msg]            │  Category       │
│          │  [internal note]           │  Assigned       │
│          │  [agent reply]             │  Customer info  │
│          │  [Reply form]              │  [Close Ticket] │
└──────────┴────────────────────────────┴─────────────────┘
```

- Thread: `flex-1 overflow-y-auto`
- Info sidebar: `w-80 border-l border-base-300 bg-base-100`
- Mobile: single column, info sidebar becomes a collapsible section below

---

## Sidebar (Agent/Admin)

```
┌────────────────────────┐
│                        │  bg-sidebar
│  ◈  Docket             │  ← logo + name: text-sidebar-content
│  ────────────────────  │  ← border-sidebar-border
│  ⊞  Dashboard          │  ← inactive: hover:bg-sidebar-accent
│  ✉  All Tickets        │  ← active: bg-sidebar-accent + border-l-2 border-sidebar-primary
│  ── Admin only ──      │  ← section label: text-xs uppercase tracking-wider
│  👥 Users              │
│  ────────────────────  │
│  ○  Jane Smith         │  ← avatar: bg-sidebar-primary
│     jane@example.com   │
└────────────────────────┘
```

- Container: `bg-sidebar h-full flex flex-col shrink-0 transition-[width]`,
  `w-60` / `w-16`
- Logo area: `h-14 border-b border-sidebar-border`
- Nav item: `flex items-center gap-3 px-3 py-2 rounded-md hover:bg-sidebar-accent`
- Active: `font-medium bg-sidebar-accent border-l-2 border-sidebar-primary`
- Divider: `h-px bg-sidebar-border`
- Footer: `py-3 border-t border-sidebar-border`

---

## Ticket Thread

The thread is chat-bubble shaped: customer messages align left, agent replies
right, both capped at `max-w-[85%]`.

| Element | Styling |
|---------|---------|
| Bubble (shared) | `rounded-xl border p-4 min-w-0 max-w-[85%] wrap-break-word` |
| Customer message | `bg-base-300 border-base-300` |
| Agent reply | `bg-base-100 border-base-300` |
| Internal note | `bg-amber-50 border-amber-200`, dark: `bg-amber-950/40 border-amber-900/70` |
| Avatar | `size-7 rounded-full bg-primary text-primary-content` (initials) |

Internal notes are the one place a non-token colour is deliberate: the amber
wash must read as "not the brand, not a status" at a glance, and it is paired
with a `LockSimpleIcon` and an explicit label so colour is never the only signal.

### Reply Form

The composer is a **Tiptap rich text editor**
(`components/common/rich-text-editor.tsx`), not a `Textarea`. Same component for
customer and agent; pass `tone="warning"` for internal notes.

```
┌──────────────────────────────────────────────────┐
│  B  I  U  S  <>  •≡  1≡  ▢  ❝                    │  ← Tiptap toolbar
├──────────────────────────────────────────────────┤
│  [   Type your reply...                       ]  │
├──────────────────────────────────────────────────┤
│  📎 Attach file          [Send Reply →]          │  ← action bar
└──────────────────────────────────────────────────┘
```

- Container: `overflow-hidden rounded-xl border bg-base-100 focus-within:ring-2`
- Rest: `border-base-300 focus-within:border-primary focus-within:ring-primary/20`
- Rendered rich text uses the scoped `.tiptap-content` styles in
  `app/globals.css` — there is no `@tailwindcss/typography` plugin

---

## Confirmation Dialogs

Never use `window.confirm()`. Use `Dialog` from `components/ui/dialog.tsx`.

```
┌─────────────────────────────────┐
│    ┌──────────┐                 │
│    │  🗑  ◉   │  ← icon in rounded-full, bg-error/10 (destructive)
│    └──────────┘                 │
│    Delete Ticket #1042          │  ← <DialogTitle>
│    This cannot be undone.       │  ← <DialogDescription>
│  ┌──────────┐  ┌──────────────┐ │
│  │  Cancel  │  │  Delete      │ │  ← outline + destructive
│  └──────────┘  └──────────────┘ │
└─────────────────────────────────┘
```

- Loading state on the action button: spinner + "Deleting…", both buttons
  disabled
- Non-destructive confirms (close ticket): icon in `bg-primary/10`, action
  button uses `default`, not `destructive`

---

## Dashboard Stat Cards

```
┌──────────────────────────────┐
│  [icon]              254     │  ← number: text-3xl font-bold
│  Total Tickets               │  ← text-sm font-medium
│  All time                    │  ← text-xs text-base-content-muted
└──────────────────────────────┘
```

- Card: `bg-base-100 rounded-xl border border-base-300 shadow-soft p-5`
- Hover: `hover:shadow-md hover:-translate-y-0.5 hover:border-primary/40`
- Icon: in a `rounded-lg` tinted container, `size-5`, `weight="duotone"`
- Grid: `grid grid-cols-2 lg:grid-cols-4 gap-4`
- Each card is a `<Link>` that opens the ticket list with its filter applied

---

## Empty States

Layout: `flex flex-col items-center justify-center text-center py-20 gap-3`

```
       [Icon — size-10 text-base-content-muted]

         No open tickets                          ← text-base font-medium
  All caught up! Open tickets will appear here.   ← text-sm text-base-content-muted

         [CTA button if applicable]
```

| Page | Icon | Heading | Subtext |
|------|------|---------|---------|
| Agent ticket list (all) | `TicketIcon` | No tickets yet | Customers can submit tickets at your support portal. |
| Agent ticket list (filtered) | `FunnelsIcon` | No tickets match | Try adjusting your filters. [Clear filters] |
| Dashboard "My Tickets" | `CheckCircleIcon` | All caught up! | No tickets are assigned to you right now. |
| Customer ticket list | `TicketIcon` | No tickets yet | You haven't submitted a ticket yet. [Submit a ticket →] |
| User list | `UsersIcon` | No agents yet | Add a teammate and assign them the agent role. |

---

## Loading States

- **Page load:** `<Skeleton>` blocks matching the layout shape. The daisyUI
  `skeleton` class supplies the `base-300` fill, `--radius-box` rounding and a
  sweep animation correctly gated behind `prefers-reduced-motion`. The daisyUI
  default is already rounded; pass `rounded-full` only for avatar placeholders.
- **Button actions:** spinner (`CircleNotchIcon weight="bold" className="animate-spin"`)
  plus the disabled state.
- **Ticket list:** 5 skeleton rows matching table row height.
- **Ticket detail:** skeleton for the thread area; the real sidebar loads first.

---

## Toasts

Use `Toaster` / `toast()` from `components/ui/sonner.tsx`. Sonner is themed
through CSS variables wired to the daisyUI tokens (`--normal-bg` →
`--base-100`, `--normal-text` → `--base-content`, `--normal-border` →
`--base-300`), so toasts follow appearance mode automatically.

Keep messages short and action-confirming:

- "Reply sent" (not "Your reply was successfully submitted")
- "Ticket closed"
- "Agent assigned"
- "File too large — max 10 MB"

---

## Responsive Breakpoints

| Breakpoint | Width | Behavior |
|-----------|-------|---------|
| Mobile | < 768px | Single column, sidebar → drawer |
| Tablet | 768–1024px | Sidebar + content, info sidebar collapses |
| Desktop | > 1024px | Full 3-column layout |

- Customer submit form: fully usable at 375px
- Agent ticket table: columns collapse (hide Category, Assigned) on tablet
- Info sidebar: collapsible accordion on mobile/tablet

---

## Shadows

Elevation is mostly carried by borders, not shadows — `--depth` is `0` on the
daisyUI theme, so components ship flat by design.

| Token | Use |
|-------|-----|
| `shadow-soft` | Bordered cards and tables — dark-mode aware, defined in `:root`/`.dark` |
| `shadow-md` | Popovers and dropdowns, hover lift on stat cards |
| — | Inputs, textareas and dialogs ship daisyUI's own elevation (`input`/`textarea` are flat at `--depth: 0`; `modal-box` carries its own drop shadow) |

---

## Component Checklist (before shipping any UI)

- [ ] Built from `components/ui/*` — no one-off control that duplicates one
- [ ] A daisyUI component class was considered first; any Tailwind override on
      top of one is justified in a comment
- [ ] No shadcn, Radix, or `class-variance-authority` imports
- [ ] Agent/admin surfaces use daisyUI tokens (`base-*`, `primary`, `sidebar-*`),
      not `bg-white`/`text-bark`/`border-sand`
- [ ] No redundant `rounded-md`/`rounded-xl` on `Button`, `Badge`, `Input`,
      `Select`, `Textarea`, `Card`, `Skeleton` or `DialogContent` — they carry
      their own radius
- [ ] Containers that are *not* primitives get `rounded-box`
- [ ] No `window.confirm()` — confirms use `Dialog`
- [ ] Phosphor icons only
- [ ] `base-content-muted` never used for body text or labels
- [ ] Loading state on every submit button
- [ ] Empty state on every list view
- [ ] Checked in both light and dark mode, and on a non-default preset
- [ ] Mobile viewport tested at 375px
- [ ] Internal notes visually distinct from public replies
- [ ] `customerToken` never appears in any agent-facing API response
