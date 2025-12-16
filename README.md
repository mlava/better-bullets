# Better Bullets (Roam Research extension)

Replace Roam’s default bullet dot with meaningful, user-configurable glyph bullets — triggered by simple prefix markers you type at the start of a block.

This extension is designed to be **fast**, **reliable across Roam DB + DOM**, and safe for daily use (no destructive edits unless you explicitly enable marker stripping).

---

## What it does

When you type a marker at the beginning of a block (e.g. `-> `), Better Bullets:

1. **Recognises** the marker (with optional “require space after marker” safety).
2. **Persists** the detected bullet “type” into the block’s props (`better-bullets/type`), so the UI stays correct even after you strip the marker.
3. **Renders** a matching bullet glyph via CSS by applying a class like `better-bullet-arrow` to the block container.

Optional:
- If **Strip marker prefix from text** is enabled, the marker is removed *after* recognition (never while the block is focused).

---

## Quick start

1. Install the extension (Roam Depot).
2. Open **Settings → Better Bullets**.
3. Leave defaults as-is to start:
   - ✅ **Require a space after marker** = ON  
   - ⛔ **Strip marker prefix from text** = OFF  
4. Try a few markers at the start of a block:
   - `= `, `-> `, `=> `, `?? `, `... `

---

## Marker → bullet map (default)

> Tip: With “Require a space after marker” ON (default), markers only trigger when followed by a visible space/tab/NBSP or end-of-line.

| Meaning | Marker | Bullet |
|---|---:|:---:|
| Equal / definition | `=` | `=` |
| Leads to | `->` | `→` |
| Result | `=>` | `⇒` |
| Question | `?` | `?` |
| Important / warning | `!` | `!` |
| Idea / addition | `+` | `+` |
| Right-angle arrow | `v>` (configurable) | `⤷` |
| Contrast / however | `~` | `≠` |
| Evidence / support | `^` | `▸` |
| Conclusion / synthesis | `∴` (configurable) | `∴` |
| Hypothesis / tentative | `??` | `◊` |
| Depends on / prerequisite | `<-` | `↤` |
| Decision / choice | `|` | `⎇` |
| Reference / related | `@` | `↗` |
| Process / ongoing | `...` | `↻` |

---

## Settings

### Require a space after marker (default: ON)
Prevents accidental triggers inside words. Example: with this ON, `->hello` **won’t** trigger; `-> hello` **will**.

### Strip marker prefix from text (default: OFF)
If enabled, leading markers are removed after the block is recognised.  
Bullet type is preserved using block props, so the bullet stays even after the prefix disappears.

### Enable toggles per bullet type (default: ON)
Disable any bullet type you don’t want.  
For bullet types with configurable prefixes, the prefix input only appears when that bullet type is enabled.

---

## Command palette actions

- **Better Bullets: Clear bullet type from focused block**  
  Removes the persisted `better-bullets/type` prop from the focused block.

- **Better Bullets: Enable all bullet types**
- **Better Bullets: Disable all bullet types**
- **Better Bullets: Show cheat sheet (console)**  
  Prints a quick reference of enabled bullets, markers, and meanings.

---

## CSS variables (optional)

You can customise sizing/alignment by overriding these variables (e.g. in your theme CSS):

```css
:root {
  --bb-bullet-size: 14px;
  --bb-bullet-font-size: 12px;
  --bb-bullet-translate-y: 0px;
}
```

---

## Notes & troubleshooting

- If markers don’t trigger, check:
  - The bullet type is enabled
  - You’re using the correct marker
  - “Require a space after marker” behaviour matches how you’re typing
- If you enable marker stripping: stripping never happens while the block is focused, and is applied shortly after blur (focus-out) to avoid fighting the editor.

---

## Privacy & safety

- Runs entirely in your browser.
- Only writes to Roam via standard block updates when persisting `better-bullets/type`, and (optionally) when stripping marker prefixes you explicitly enabled.

---

## License
MIT (or your chosen license).
