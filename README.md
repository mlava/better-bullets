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
- A second, independent set of **provenance markers** can tag where a block’s content came from (email, phone, calendar…) with a small badge. Off by default — see [Provenance markers](#provenance-markers-optional-off-by-default).

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
| Decision / choice | `\|` | `⎇` |
| Reference / related | `@` | `↗` |
| Process / ongoing | `...` | `↻` |

---

## Provenance markers (optional, off by default)

Bullet types say *what kind of thinking* a block is. Provenance says *where the content came from*. The two are independent, so a block can carry both.

Provenance markers are emoji you type at the start of a block. When recognised, they:

1. **Persist** the detected source into the block’s props (`better-bullets/provenance`), separately from `better-bullets/type`.
2. **Render** a small badge just before the block text, alongside (not instead of) your normal bullet.

All provenance types are **disabled by default**. Turn them on in **Settings → Better Bullets → Show provenance settings**.

| Source | Default marker | Badge |
|---|---:|:---:|
| Calendar event | 📅 | 📅 |
| Email | 📨 | 📨 |
| Phone call | 📞 | 📞 |
| Chat message | 💬 | 💬 |
| Scanned post | 📪 | 📪 |
| Slack | `%` | `＃` |

> **Why isn’t Slack’s marker `#`?** A leading `#` is Roam’s H1 heading shortcut, and `#` anywhere also opens Roam’s tag autocomplete — so it’s unusable as a prefix. Slack triggers on `%` instead, while the badge still renders the fullwidth `＃` (U+FF03).

Slack is the one type whose marker and badge differ, which is worth knowing in general: **the prefix is only the trigger, and the badge is only the visual.** They’re independent. Changing a prefix never changes how the block looks.

**Every provenance prefix is configurable** — see [Setting provenance without typing emoji](#setting-provenance-without-typing-emoji) below.

### Combining the two

Put the provenance marker first, then the bullet marker:

```
📨 -> chase the contract by Friday
```

That block gets an email badge **and** a “leads to” bullet. Recognition runs in two passes: provenance is matched off the front of the string, then the bullet marker is matched on what remains.

The badge is hidden while the block is focused for editing (Roam swaps the rendered text for a textarea) and reappears on blur.

---

## Setting provenance without typing emoji

Typing the default emoji is awkward, and some of them have near-identical lookalikes — 📨 (U+1F4E8, *incoming envelope*) is not 📧 (U+1F4E7, *e-mail*), and picking the wrong one from an OS emoji picker silently won’t match. There are three ways around this; the first is the one to reach for.

### 1. Command palette + hotkey (recommended)

Provenance is stored in block props, not in the text — so you never actually have to type a marker. Each **enabled** provenance type gets its own command:

- **Better Bullets: Mark as 📨 Email**
- **Better Bullets: Mark as 📅 Calendar event**
- …and so on, one per enabled type

Run it with the focused block and the badge is applied directly. Because these are registered through the Roam Depot extension API, they appear grouped under *Better Bullets* in Roam’s **Hotkeys** window, so you can bind whatever keys you like.

Commands are only registered for types you have enabled, and re-sync when you toggle one — so the palette never fills up with sources you don’t use.

### 2. Custom prefixes

Each provenance type has a **Prefix for: …** input in settings, revealed once that type is enabled. Set it to anything typeable — `em`, `cal`, `ph` — and it works exactly like a bullet marker, honouring **Require a space after marker**.

Two things to avoid when choosing one:

- **Characters Roam already claims at the start of a block.** `#` becomes an H1 heading (and opens tag autocomplete), `>` becomes a blockquote, `/` opens the slash-command menu, and `[[`, `((`, `{{`, `$$` all open their own autocompletes. Roam wins these races — your prefix will never be seen.
- **Prefixes you’d plausibly type by accident.** Short ASCII is far easier to trigger unintentionally than an emoji (`em ` at the start of a block is not an unusual thing to write), so pick something you wouldn’t otherwise start a block with.

Prefix collision detection covers both dimensions and will warn you if your choice clashes with a bullet marker — but it can’t know about Roam’s own syntax, so the first point is on you.

### 3. OS text replacement

Leave the emoji defaults in place and map them at the OS level — on macOS, System Settings → Keyboard → Text Replacements, e.g. `;;em` → `📨 `. Per-machine and outside the extension, but it makes the defaults fast to type and removes the lookalike risk.

> The typed prefix remains useful regardless: it’s what lets provenance survive a paste from another tool, or content synced in from a capture pipeline that already prefixes its blocks.

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

### Show provenance settings (default: OFF)
Reveals the provenance section. Nothing about provenance is active until you enable at least one type there.

### Strip provenance prefix from text (default: OFF)
The provenance equivalent of marker stripping: removes the leading emoji after the block is recognised. The source is preserved in block props, so the badge stays. Independent of the bullet-marker strip setting — you can strip one and not the other.

### Enable toggles per provenance type (default: OFF)
All provenance types start disabled. Enabling one reveals its **Prefix for: …** input and registers its **Mark as …** command.

> Prefix collision detection covers **both** dimensions, so it will warn you if a custom provenance prefix clashes with a bullet marker.

---

## Command palette actions

- **Better Bullets: Mark as … ** *(one per enabled provenance type)*  
  Applies that provenance to the focused block directly — no marker typing. Bindable in Roam’s Hotkeys window.

- **Better Bullets: Clear bullet type from focused block**  
  Removes the persisted `better-bullets/type` prop from the focused block.

- **Better Bullets: Clear provenance from focused block**  
  Removes the persisted `better-bullets/provenance` prop from the focused block.

- **Better Bullets: Clear all markers from focused block**  
  Removes both props at once.

- **Better Bullets: Enable all bullet types**
- **Better Bullets: Disable all bullet types**
- **Better Bullets: Show cheat sheet**  
  Prints a quick reference of enabled bullets and provenance types, markers, and meanings.

---

## CSS variables (optional)

You can customise sizing/alignment by overriding these variables (e.g. in your theme CSS):

```css
:root {
  --bb-bullet-size: 14px;
  --bb-bullet-font-size: 12px;
  --bb-bullet-translate-y: 0px;

  /* Provenance badges */
  --bb-prov-badge-size: 10px;
  --bb-prov-badge-gap: 4px;
  --bb-prov-badge-opacity: 0.75;
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
- Only writes to Roam via standard block updates when persisting `better-bullets/type` and `better-bullets/provenance`, and (optionally) when stripping marker prefixes you explicitly enabled.
- Prop writes are read-modify-write, so props belonging to other extensions on the same block are preserved.

---

## License
MIT.
