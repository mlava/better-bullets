const BULLET_TYPES = [
  { id: "equal", label: 'Equal / definition (prefix "=")', prefix: "=", icon: "=" },
  { id: "arrow", label: 'Single arrow / leads to (prefix "->")', prefix: "->", icon: "→" },
  { id: "doubleArrow", label: 'Double arrow / result (prefix "=>")', prefix: "=>", icon: "⇒" },
  { id: "question", label: 'Question (prefix "?")', prefix: "?", icon: "?" },
  { id: "important", label: 'Important / warning (prefix "!")', prefix: "!", icon: "!" },
  { id: "plus", label: 'Idea / addition (prefix "+")', prefix: "+", icon: "+" },
  { id: "downRight90", label: 'Right-angle arrow (prefix "v>")', prefix: "v>", icon: "⤷", configurablePrefix: true },
  { id: "contrast", label: 'Contrast / however (prefix "~")', prefix: "~", icon: "≠" },
  { id: "evidence", label: 'Evidence / support (prefix "^")', prefix: "^", icon: "▸" },
  { id: "conclusion", label: 'Conclusion / synthesis (prefix "∴")', prefix: "∴", icon: "∴", configurablePrefix: true },
  { id: "hypothesis", label: 'Hypothesis / tentative (prefix "??")', prefix: "??", icon: "◊" },
  { id: "depends", label: 'Depends on / prerequisite (prefix "<-")', prefix: "<-", icon: "↤" },
  { id: "decision", label: 'Decision / choice (prefix "|")', prefix: "|", icon: "⎇" },
  { id: "reference", label: 'Reference / related (prefix "@")', prefix: "@", icon: "↗" },
  { id: "process", label: 'Process / ongoing (prefix "...")', prefix: "...", icon: "↻" },
];

// Every provenance type has a configurable prefix: the emoji defaults are hard to
// type and easy to confuse with lookalikes (U+1F4E8 vs U+1F4E7), so users need to
// be able to swap in something typeable. The prefix input is only revealed once
// the type is enabled.
const PROVENANCE_TYPES = [
  { id: "calendar", label: "Calendar event", prefix: "\u{1F4C5}", icon: "\u{1F4C5}", configurablePrefix: true },
  { id: "email", label: "Email", prefix: "\u{1F4E8}", icon: "\u{1F4E8}", configurablePrefix: true },
  { id: "phone", label: "Phone call", prefix: "\u{1F4DE}", icon: "\u{1F4DE}", configurablePrefix: true },
  { id: "chat", label: "Chat message", prefix: "\u{1F4AC}", icon: "\u{1F4AC}", configurablePrefix: true },
  { id: "mail", label: "Scanned post", prefix: "\u{1F4EA}", icon: "\u{1F4EA}", configurablePrefix: true },
  // Prefix is "%", not "#": a leading "#" is Roam's H1 heading shortcut *and* its
  // tag autocomplete trigger. The badge still renders the fullwidth "\uFF03" (U+FF03),
  // which is Slack-evocative but effectively untypeable \u2014 prefix and badge are
  // independent, so the prefix is chosen purely for typeability.
  { id: "slack", label: "Slack", prefix: "%", icon: "\uFF03", configurablePrefix: true },
];

// Default enabled set for new installs (existing installs keep saved settings)
const DEFAULT_ENABLED = new Set();

const bulletSettings = {
  enabled: {}, // id -> boolean (default ON)
  stripMarkers: false,
  requireSpaceAfterMarker: true, // default ON
  prefixes: {}, // id -> string (configurable prefix overrides)
  provEnabled: {}, // id -> boolean (provenance types)
  provPrefixes: {}, // id -> string (provenance prefix overrides)
  stripProvMarkers: false,
};

const GLOBAL_KEY = "__better_bullets__v2";

const PERSIST_PROP_TYPE_KEYS = [
  "::better-bullets/type",
  ":better-bullets/type",
  "better-bullets/type",
  "::better-bullets",
  ":better-bullets",
  "better-bullets",
];

const PERSIST_WRITE_KEY = "better-bullets/type";

const PERSIST_PROV_PROP_KEYS = [
  "::better-bullets/provenance",
  ":better-bullets/provenance",
  "better-bullets/provenance",
];
const PERSIST_PROV_WRITE_KEY = "better-bullets/provenance";
const UID_RE = /^[-_A-Za-z0-9]{9}$/;

let domObserver = null;
let watchRefreshTimer = null;
let watchRefreshBurstUntil = 0;
let watchRefreshQueued = false;
let navCleanupFns = [];
let sidebarWatchObserver = null;
let refreshInFlight = false;
let warnedMissingBlockUid = false;

const activeWatches = new Map(); // key -> unwatchFn
let lastWatchSignature = "";

const pendingFocusedStrip = new Map(); // uid -> timer
let focusoutTimerByUid = new Map();
let focusOutListener = null;

const typeCache = new Map(); // uid -> typeId|null (short-lived)
const provCache = new Map(); // uid -> provId|null (short-lived)
let cacheEvictTimer = null;

const dirtyContainers = new Set(); // Set<HTMLElement>
let applyQueued = false;
let applyContinuationTimer = null;

let lastPrefixSig = "";
let prefixDetectTimer = null;

const DEBUG_DETECT = false;

function parseBool(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "on" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "off" || v === "no" || v === "0") return false;
  }
  return null;
}

function coerceBoolInput(input) {
  let value = input;
  if (value && typeof value === "object") {
    if ("target" in value) {
      value = value.target?.checked ?? value.target?.value;
    } else if ("value" in value) {
      value = value.value;
    }
  }
  const parsed = parseBool(value);
  return parsed === null ? !!value : parsed;
}

function getSettingBool(extensionAPI, key, defaultValue) {
  const v = extensionAPI.settings.get(key);
  const parsed = parseBool(v);
  return parsed === null ? defaultValue : parsed;
}

function getSettingStr(extensionAPI, key, defaultValue) {
  const v = extensionAPI.settings.get(key);
  if (typeof v === "string") return v;
  return defaultValue;
}

function isValidUid(uid) {
  return typeof uid === "string" && UID_RE.test(uid);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingInvisibles(text) {
  return String(text || "").replace(
    /^[\s\u00A0\u202F\u200B\u200C\u200D\uFEFF\u2060\u200E\u200F\u202A-\u202E\u2066-\u2069]+/,
    ""
  );
}

function isBulletTypeEnabled(id) {
  if (Object.prototype.hasOwnProperty.call(bulletSettings.enabled, id)) {
    return !!bulletSettings.enabled[id];
  }
  return true;
}

function getBulletTypeById(id) {
  return BULLET_TYPES.find((b) => b.id === id) || null;
}

function getEffectivePrefix(bt) {
  const override = bulletSettings.prefixes?.[bt.id];
  if (typeof override === "string" && override.length) return override;
  return bt.prefix;
}

function getPropValue(props, keys) {
  if (!props) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
  }
  return undefined;
}

// Serialises prop writes per block. Roam's updateBlock replaces :block/props
// wholesale, so each write is a read-modify-write to avoid clobbering props owned
// by other extensions. That makes concurrent writes to the SAME block unsafe: a
// combined block persists provenance and type in the same tick, and without this
// queue the second write would pull props before the first had landed and drop
// the first key. The in-memory caches hide the damage until a reload, and with
// stripping on the props are the only source of truth — so the loss is permanent.
//
// staleKeys lists every key spelling our value may already be stored under; they
// are dropped before the patch is applied, otherwise an older spelling would
// shadow the fresh value in getPropValue's ordered lookup.
const propWriteQueue = new Map(); // uid -> Promise (tail of that block's write chain)

function safeMergeProps(uid, patch, staleKeys = []) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return;

  const prev = propWriteQueue.get(uid) || Promise.resolve();

  const next = prev
    .then(async () => {
      const pulled = window.roamAlphaAPI.pull("[:block/props]", [":block/uid", uid]);
      const current = { ...(pulled?.[":block/props"] || {}) };
      for (const k of staleKeys) delete current[k];

      const res = window.roamAlphaAPI.updateBlock({
        block: { uid, props: { ...current, ...patch } },
      });
      if (res?.then) await res;
    })
    .catch(() => {
      // A failed write must not poison the rest of the chain.
    })
    .finally(() => {
      if (propWriteQueue.get(uid) === next) propWriteQueue.delete(uid);
    });

  propWriteQueue.set(uid, next);
}

function getFocusedUidFromDom() {
  const el = document.activeElement;
  if (!el?.closest) return null;
  const container = el.closest(".roam-block-container");
  if (!container) return null;
  return getBlockUidFromContainer(container);
}

function getBlockUidFromContainer(container) {
  if (!container) return null;

  const directUid = container.getAttribute?.("data-block-uid");
  if (isValidUid(directUid)) return directUid;

  if (!warnedMissingBlockUid) {
    warnedMissingBlockUid = true;
    console.warn("[Better Bullets] Missing data-block-uid on block container:", container);
  }

  return null;
}

const VISIBLE_SPACE_AFTER = "(?:[\\t \\u00A0\\u202F]|$)";

function getBulletTypeByPrefixFromString(blockString) {
  const trimmed = stripLeadingInvisibles(blockString);

  for (const bt of BULLET_TYPES) {
    if (!isBulletTypeEnabled(bt.id)) continue;

    const prefix = getEffectivePrefix(bt);

    const re = bulletSettings.requireSpaceAfterMarker
      ? new RegExp(`^${escapeRegExp(prefix)}${VISIBLE_SPACE_AFTER}`)
      : new RegExp(`^${escapeRegExp(prefix)}`);

    if (re.test(trimmed)) {
      if (DEBUG_DETECT) {
        const after = trimmed.slice(prefix.length, prefix.length + 6);
        console.info("[Better Bullets][detect]", prefix, "matched; chars after:", JSON.stringify(after));
      }
      return bt;
    }
  }
  return null;
}

function buildStripRegex(prefix) {
  return new RegExp(
    `^[\\s\\u00A0\\u202F\\u200B\\u200C\\u200D\\uFEFF\\u2060\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*(?:${escapeRegExp(
      prefix
    )}[\\s\\u00A0\\u202F\\u200B\\u200C\\u200D\\uFEFF\\u2060\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*)+`
  );
}

function readPersistedType(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return null;

  if (typeCache.has(uid)) return typeCache.get(uid);

  try {
    const pulled = window.roamAlphaAPI.pull("[:block/props]", [":block/uid", uid]);
    const props = pulled?.[":block/props"];
    const typeId = getPropValue(props, PERSIST_PROP_TYPE_KEYS);
    const val = typeof typeId === "string" && typeId ? typeId : null;
    typeCache.set(uid, val);

    // Opportunistically warm provCache from the same pull
    if (!provCache.has(uid)) {
      const provId = getPropValue(props, PERSIST_PROV_PROP_KEYS);
      provCache.set(uid, typeof provId === "string" && provId ? provId : null);
    }

    return val;
  } catch {
    typeCache.set(uid, null);
    return null;
  }
}

function persistType(uid, bulletType) {
  if (!window.roamAlphaAPI || !isValidUid(uid) || !bulletType) return;

  typeCache.set(uid, bulletType.id);
  safeMergeProps(uid, { [PERSIST_WRITE_KEY]: bulletType.id }, PERSIST_PROP_TYPE_KEYS);
}

function clearPersistedType(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return;

  typeCache.set(uid, null);
  safeMergeProps(uid, { [PERSIST_WRITE_KEY]: null }, PERSIST_PROP_TYPE_KEYS);
}

// --- Provenance helpers (mirrors reasoning helpers above) ---

function isProvTypeEnabled(id) {
  if (Object.prototype.hasOwnProperty.call(bulletSettings.provEnabled, id)) {
    return !!bulletSettings.provEnabled[id];
  }
  return false; // all disabled by default
}

function getProvTypeById(id) {
  return PROVENANCE_TYPES.find((p) => p.id === id) || null;
}

function getEffectiveProvPrefix(pt) {
  const override = bulletSettings.provPrefixes?.[pt.id];
  if (typeof override === "string" && override.length) return override;
  return pt.prefix;
}

function getProvTypeByPrefixFromString(blockString) {
  const trimmed = stripLeadingInvisibles(blockString);

  for (const pt of PROVENANCE_TYPES) {
    if (!isProvTypeEnabled(pt.id)) continue;

    const prefix = getEffectiveProvPrefix(pt);

    const re = bulletSettings.requireSpaceAfterMarker
      ? new RegExp(`^${escapeRegExp(prefix)}${VISIBLE_SPACE_AFTER}`)
      : new RegExp(`^${escapeRegExp(prefix)}`);

    if (re.test(trimmed)) {
      // Strip the provenance prefix (+ optional trailing space) to produce remainder
      const stripRe = new RegExp(
        `^${escapeRegExp(prefix)}[\\t \\u00A0\\u202F]*`
      );
      const remainder = trimmed.replace(stripRe, "");
      return { provType: pt, remainder };
    }
  }
  return null;
}

function readPersistedProv(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return null;

  if (provCache.has(uid)) return provCache.get(uid);

  try {
    const pulled = window.roamAlphaAPI.pull("[:block/props]", [":block/uid", uid]);
    const props = pulled?.[":block/props"];
    const provId = getPropValue(props, PERSIST_PROV_PROP_KEYS);
    const val = typeof provId === "string" && provId ? provId : null;
    provCache.set(uid, val);
    return val;
  } catch {
    provCache.set(uid, null);
    return null;
  }
}

function persistProvenance(uid, provType) {
  if (!window.roamAlphaAPI || !isValidUid(uid) || !provType) return;

  provCache.set(uid, provType.id);
  safeMergeProps(uid, { [PERSIST_PROV_WRITE_KEY]: provType.id }, PERSIST_PROV_PROP_KEYS);
}

function clearPersistedProv(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return;

  provCache.set(uid, null);
  safeMergeProps(uid, { [PERSIST_PROV_WRITE_KEY]: null }, PERSIST_PROV_PROP_KEYS);
}

function buildProvStripRegex(prefix) {
  return new RegExp(
    `^[\\s\\u00A0\\u202F\\u200B\\u200C\\u200D\\uFEFF\\u2060\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*(?:${escapeRegExp(
      prefix
    )}[\\s\\u00A0\\u202F\\u200B\\u200C\\u200D\\uFEFF\\u2060\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*)+`
  );
}

async function stripProvMarkerFromUid(uid, provType, focusedUid) {
  if (!window.roamAlphaAPI) return false;
  if (!bulletSettings.stripProvMarkers) return true;
  if (!isValidUid(uid)) return false;
  if (!provType) return false;
  if (focusedUid && uid === focusedUid) return false;

  const prefix = getEffectiveProvPrefix(provType);
  if (!prefix) return false;

  const re = buildProvStripRegex(prefix);

  let pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  let orig = pulled?.[":block/string"];
  if (typeof orig !== "string") return false;

  if (!re.test(orig)) return true;

  const next = orig.replace(re, "");
  if (next === orig) return true;

  try {
    const res = window.roamAlphaAPI.updateBlock({ block: { uid, string: next } });
    if (res?.then) await res;
  } catch {
    // ignore; verify below
  }

  await new Promise((r) => setTimeout(r, 90));
  pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  const after = pulled?.[":block/string"];
  if (typeof after !== "string") return false;
  if (re.test(after)) return false;

  return true;
}

// --- End provenance helpers ---

async function stripMarkerFromUid(uid, bulletType, focusedUid) {
  if (!window.roamAlphaAPI) return false;
  if (!bulletSettings.stripMarkers) return true;
  if (!isValidUid(uid)) return false;
  if (!bulletType) return false;
  if (focusedUid && uid === focusedUid) return false;

  const prefix = getEffectivePrefix(bulletType);
  if (!prefix) return false;

  const re = buildStripRegex(prefix);

  let pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  let orig = pulled?.[":block/string"];
  if (typeof orig !== "string") return false;

  if (!re.test(orig)) return true;

  const next = orig.replace(re, "");
  if (next === orig) return true;

  try {
    const res = window.roamAlphaAPI.updateBlock({ block: { uid, string: next } });
    if (res?.then) await res;
  } catch {
    // ignore; verify below
  }

  await new Promise((r) => setTimeout(r, 90));
  pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  const after = pulled?.[":block/string"];
  if (typeof after !== "string") return false;
  if (re.test(after)) return false;

  return true;
}

function scheduleStripWhenUnfocused(uid, markerType, isProv) {
  if (isProv && !bulletSettings.stripProvMarkers) return;
  if (!isProv && !bulletSettings.stripMarkers) return;
  if (!isValidUid(uid)) return;

  const key = isProv ? `prov:${uid}` : uid;
  if (pendingFocusedStrip.has(key)) clearTimeout(pendingFocusedStrip.get(key));

  const t = setTimeout(async () => {
    pendingFocusedStrip.delete(key);

    const nowFocused = getFocusedUidFromDom();
    if (nowFocused === uid) {
      scheduleStripWhenUnfocused(uid, markerType, isProv);
      return;
    }

    try {
      if (isProv) {
        await stripProvMarkerFromUid(uid, markerType, null);
      } else {
        await stripMarkerFromUid(uid, markerType, null);
      }
      markAllVisibleContainersDirtyLight();
      scheduleDomApplyPass();
    } catch {
      // ignore
    }
  }, 250);

  pendingFocusedStrip.set(key, t);
}

// Runs on every blur, even with both strip settings off. Blurring makes Roam
// re-render the block (textarea back to .rm-block-text) and rewrite className,
// and the DOM observer only watches for added .roam-block-container nodes — so
// it never sees that swap. Without an unconditional repaint here, a block that
// lost its marker state while focused would only recover on a page nav or when
// a sibling block is inserted.
function scheduleStripAfterFocusout(uid) {
  if (!isValidUid(uid)) return;

  if (focusoutTimerByUid.has(uid)) clearTimeout(focusoutTimerByUid.get(uid));

  const t = setTimeout(async () => {
    focusoutTimerByUid.delete(uid);

    try {
      // --- Provenance stripping ---
      if (bulletSettings.stripProvMarkers) {
        const provId = readPersistedProv(uid);
        const ptFromProp = provId ? getProvTypeById(provId) : null;

        if (ptFromProp && isProvTypeEnabled(ptFromProp.id)) {
          await stripProvMarkerFromUid(uid, ptFromProp, null);
        } else {
          const pulled = window.roamAlphaAPI?.pull?.("[:block/string]", [":block/uid", uid]);
          const str = pulled?.[":block/string"];
          if (typeof str === "string") {
            const provResult = getProvTypeByPrefixFromString(str);
            if (provResult && isProvTypeEnabled(provResult.provType.id)) {
              persistProvenance(uid, provResult.provType);
              await stripProvMarkerFromUid(uid, provResult.provType, null);
            }
          }
        }
      }

      // --- Reasoning stripping ---
      if (bulletSettings.stripMarkers) {
        const typeId = readPersistedType(uid);
        const btFromProp = typeId ? getBulletTypeById(typeId) : null;

        if (btFromProp && isBulletTypeEnabled(btFromProp.id)) {
          await stripMarkerFromUid(uid, btFromProp, null);
        } else {
          const pulled = window.roamAlphaAPI?.pull?.("[:block/string]", [":block/uid", uid]);
          const str = pulled?.[":block/string"];
          if (typeof str === "string") {
            const detected = getBulletTypeByPrefixFromString(str);
            if (detected && isBulletTypeEnabled(detected.id)) {
              persistType(uid, detected);
              await stripMarkerFromUid(uid, detected, null);
            }
          }
        }
      }

      // Unconditional: the block was just re-rendered by the blur itself.
      markAllVisibleContainersDirtyLight();
      scheduleDomApplyPass();
    } catch {
      // ignore
    }
  }, 140);

  focusoutTimerByUid.set(uid, t);
}

function startFocusOutListener() {
  if (focusOutListener) return;

  focusOutListener = (evt) => {
    try {
      const target = evt?.target;
      if (!target?.closest) return;

      const container = target.closest(".roam-block-container");
      if (!container) return;

      const uid = getBlockUidFromContainer(container);
      if (!uid) return;

      scheduleStripAfterFocusout(uid);
    } catch {
      // ignore
    }
  };

  document.addEventListener("focusout", focusOutListener, true);
}

function stopFocusOutListener() {
  if (!focusOutListener) return;
  document.removeEventListener("focusout", focusOutListener, true);
  focusOutListener = null;

  for (const t of focusoutTimerByUid.values()) clearTimeout(t);
  focusoutTimerByUid.clear();
}

function clearReasoningClasses(container) {
  const toRemove = [];
  container.classList.forEach((c) => {
    if (c.startsWith("better-bullet-") && !c.startsWith("better-bullet-prov-")) toRemove.push(c);
  });
  toRemove.forEach((c) => container.classList.remove(c));
}

function clearProvClasses(container) {
  const toRemove = [];
  container.classList.forEach((c) => {
    if (c.startsWith("better-bullet-prov-")) toRemove.push(c);
  });
  toRemove.forEach((c) => container.classList.remove(c));
}

function applyBulletClass(container, typeId) {
  clearReasoningClasses(container);

  if (!typeId) {
    container.removeAttribute("data-better-bullet");
    return;
  }

  container.classList.add(`better-bullet-${typeId}`);
  container.setAttribute("data-better-bullet", typeId);
}

function applyProvClass(container, provId) {
  clearProvClasses(container);

  if (!provId) {
    container.removeAttribute("data-better-bullet-prov");
    return;
  }

  container.classList.add(`better-bullet-prov-${provId}`);
  container.setAttribute("data-better-bullet-prov", provId);
}

function applyFromPropsOrPrefix(container) {
  const uid = getBlockUidFromContainer(container);
  const textEl = container.querySelector(".rm-block-text");
  const raw = textEl?.innerText || "";

  // Mirrors handleChangedBlock: provenance is read off the front of the string
  // first, and reasoning is detected on what remains. Only disabled-type-free
  // results come back, so a null here means "no provenance prefix".
  const provResult = raw ? getProvTypeByPrefixFromString(raw) : null;

  // --- Provenance dimension ---
  let provApplied = false;
  if (uid) {
    const provId = readPersistedProv(uid);
    const pt = provId ? getProvTypeById(provId) : null;
    if (pt && isProvTypeEnabled(pt.id)) {
      applyProvClass(container, pt.id);
      provApplied = true;
    }
  }
  if (!provApplied) {
    applyProvClass(container, provResult ? provResult.provType.id : null);
  }

  // --- Reasoning dimension ---
  let reasoningApplied = false;
  if (uid) {
    const typeId = readPersistedType(uid);
    const bt = typeId ? getBulletTypeById(typeId) : null;
    if (bt && isBulletTypeEnabled(bt.id)) {
      applyBulletClass(container, bt.id);
      reasoningApplied = true;
    }
  }
  if (!reasoningApplied) {
    const reasoningInput = provResult ? provResult.remainder : raw;
    const detected = reasoningInput ? getBulletTypeByPrefixFromString(reasoningInput) : null;
    if (detected && isBulletTypeEnabled(detected.id)) {
      applyBulletClass(container, detected.id);
    } else {
      applyBulletClass(container, null);
    }
  }
}

function markContainerDirty(container) {
  if (!container || container.nodeType !== 1) return;
  if (!container.classList?.contains("roam-block-container")) return;
  dirtyContainers.add(container);
}


function getBulletRoots() {
  const roots = [];
  try {
    const main = document.querySelector(".roam-main");
    if (main) roots.push(main);
  } catch { }
  try {
    const rs = document.querySelector(".rm-right-sidebar");
    if (rs) roots.push(rs);
  } catch { }
  if (!roots.length) roots.push(document.body);
  return roots;
}

function safeCssEscape(s) {
  try {
    return CSS && typeof CSS.escape === "function" ? CSS.escape(s) : s;
  } catch {
    return s;
  }
}

function markContainersDirtyForUids(uids) {
  let marked = 0;
  if (!uids || !uids.length) return marked;

  const roots = getBulletRoots();

  for (const uid of uids) {
    if (!uid || typeof uid !== "string") continue;

    const sel = `[id$="${safeCssEscape(uid)}"]`;
    let foundForUid = false;

    for (const root of roots) {
      if (!root || !root.querySelectorAll) continue;

      const els = root.querySelectorAll(sel);
      for (const el of els) {
        const c = el.closest?.(".roam-block-container");
        if (c) {
          markContainerDirty(c);
          marked++;
          foundForUid = true;
          break;
        }
      }
      if (foundForUid) break;
    }
  }

  return marked;
}

function markAllVisibleContainersDirtyLight() {
  try {
    const nodes = document.querySelectorAll(".roam-block-container");
    const max = 250; // hard cap to prevent huge work
    let i = 0;
    for (const n of nodes) {
      markContainerDirty(n);
      i++;
      if (i >= max) break;
    }
  } catch {
    // ignore
  }
}

function markAllVisibleContainersDirtyFull() {
  try {
    document.querySelectorAll(".roam-block-container").forEach((n) => {
      markContainerDirty(n);
    });
  } catch {
    // ignore
  }
}

function scheduleDomApplyPass() {
  if (applyQueued) return;
  applyQueued = true;

  requestAnimationFrame(() => {
    applyQueued = false;
    processDirtyContainers();
  });
}

function processDirtyContainers() {
  const BUDGET_MS = 10;
  const start = performance.now();

  let processed = 0;

  for (const el of dirtyContainers) {
    dirtyContainers.delete(el);

    try {
      applyFromPropsOrPrefix(el);
    } catch {
      // ignore
    }

    processed++;
    if (processed >= 300) break; // hard cap per slice

    if (performance.now() - start > BUDGET_MS) break;
  }

  if (dirtyContainers.size) {
    if (applyContinuationTimer) clearTimeout(applyContinuationTimer);
    applyContinuationTimer = setTimeout(() => scheduleDomApplyPass(), 25);
  }
}

function flattenTreeToMap(node, map) {
  if (!node) return;

  const uid = node[":block/uid"];
  if (uid) {
    map.set(uid, {
      uid,
      string: node[":block/string"] || "",
      props: node[":block/props"] || null,
    });
  }

  const kids = node[":block/children"];
  if (Array.isArray(kids)) {
    kids.forEach((k) => flattenTreeToMap(k, map));
  }
}

function diffChangedUids(beforeMap, afterMap) {
  const changed = [];
  for (const [uid, after] of afterMap) {
    const before = beforeMap.get(uid);
    if (!before) {
      changed.push(uid);
      continue;
    }
    if ((before.string || "") !== (after.string || "")) changed.push(uid);
  }
  return changed;
}

async function handleChangedBlock(uid, afterEntry, focusedUid) {
  const str = afterEntry?.string;
  if (typeof str !== "string") return;

  // Phase 1: Provenance detection (emoji prefix at start of string)
  let reasoningInput = str;
  const provResult = getProvTypeByPrefixFromString(str);
  if (provResult && isProvTypeEnabled(provResult.provType.id)) {
    persistProvenance(uid, provResult.provType);
    reasoningInput = provResult.remainder;

    if (bulletSettings.stripProvMarkers && focusedUid === uid) {
      scheduleStripWhenUnfocused(uid, provResult.provType, true);
    } else {
      await stripProvMarkerFromUid(uid, provResult.provType, focusedUid);
      // Re-read string after provenance strip for reasoning detection
      if (bulletSettings.stripProvMarkers) {
        const pulled = window.roamAlphaAPI?.pull?.("[:block/string]", [":block/uid", uid]);
        reasoningInput = pulled?.[":block/string"] || reasoningInput;
      }
    }
  }

  // Phase 2: Reasoning detection (ASCII prefix on remainder)
  const detected = getBulletTypeByPrefixFromString(reasoningInput);
  if (detected && isBulletTypeEnabled(detected.id)) {
    persistType(uid, detected);

    if (bulletSettings.stripMarkers && focusedUid === uid) {
      scheduleStripWhenUnfocused(uid, detected, false);
      return;
    }

    await stripMarkerFromUid(uid, detected, null);
  }
}
const PULL_SPEC = "[:block/uid :block/string :block/props {:block/children ...}]";

async function initialScanForRootUid(rootUid) {
  if (!window.roamAlphaAPI?.pull) return;
  if (!rootUid) return;

  try {
    const focusedUid = getFocusedUidFromDom();
    const root = window.roamAlphaAPI.pull(PULL_SPEC, [":block/uid", rootUid]);
    if (!root) return;

    const map = new Map();
    flattenTreeToMap(root, map);

    for (const [uid, entry] of map) {
      await handleChangedBlock(uid, entry, focusedUid);
    }
    
    markAllVisibleContainersDirtyLight();
    scheduleDomApplyPass();
  } catch {
    // ignore
  }
}

function addWatchForUid(key, uid) {
  if (!window.roamAlphaAPI?.data?.addPullWatch) return;
  if (!uid) return;
  if (activeWatches.has(key)) return;

  const query = `[:block/uid "${uid}"]`;

  const unwatch = window.roamAlphaAPI.data.addPullWatch(PULL_SPEC, query, async function (before, after) {
    try {
      const focusedUid = getFocusedUidFromDom();

      const beforeMap = new Map();
      const afterMap = new Map();

      if (before) flattenTreeToMap(before, beforeMap);
      if (after) flattenTreeToMap(after, afterMap);

      const changedUids = diffChangedUids(beforeMap, afterMap);

      for (const changedUid of changedUids) {
        const entry = afterMap.get(changedUid);
        if (!entry) continue;
        await handleChangedBlock(changedUid, entry, focusedUid);
      }
      
      const marked = markContainersDirtyForUids(changedUids);
      if (!marked) markAllVisibleContainersDirtyLight();
      scheduleDomApplyPass();
    } catch {
      // ignore
    }
  });

  const unwatchFn = typeof unwatch === "function" ? unwatch : null;
  activeWatches.set(key, unwatchFn || (() => { }));

  initialScanForRootUid(uid);
}

function removeWatch(key) {
  const unwatch = activeWatches.get(key);
  if (!unwatch) return;
  try {
    unwatch();
  } catch {
    // ignore
  }
  activeWatches.delete(key);
}

async function getMainUid() {
  try {
    const fn = window.roamAlphaAPI?.ui?.mainWindow?.getOpenPageOrBlockUid;
    if (typeof fn !== "function") return null;

    const val = fn.call(window.roamAlphaAPI.ui.mainWindow);
    const uid = val && typeof val.then === "function" ? await val : val;

    return typeof uid === "string" ? uid : null;
  } catch {
    return null;
  }
}

function getSidebarWindows() {
  try {
    return window.roamAlphaAPI?.ui?.rightSidebar?.getWindows?.() || [];
  } catch {
    return [];
  }
}

async function computeDesiredWatchKeys() {
  const desired = new Map(); // key -> uid

  const mainUid = await getMainUid();
  if (mainUid) desired.set(`main:${mainUid}`, mainUid);

  const wins = getSidebarWindows();
  for (const w of wins) {
    const wid = w?.["window-id"] || w?.windowId || "";
    const type = w?.type;

    let uid = null;
    if (type === "outline") uid = w?.["page-uid"] || w?.pageUid || null;
    if (type === "block") uid = w?.["block-uid"] || w?.blockUid || null;

    if (uid) desired.set(`rs:${wid}:${uid}`, uid);
  }

  return desired;
}

function signatureForDesired(desired) {
  try {
    const parts = [];
    for (const [k, u] of desired) parts.push(`${k}=${u}`);
    parts.sort();
    return parts.join("|");
  } catch {
    return "";
  }
}

async function refreshWatches() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const desired = await computeDesiredWatchKeys();
    const sig = signatureForDesired(desired);

    if (sig === lastWatchSignature) return;
    lastWatchSignature = sig;

    for (const key of Array.from(activeWatches.keys())) {
      if (!desired.has(key)) removeWatch(key);
    }

    for (const [key, uid] of desired) {
      if (!activeWatches.has(key)) addWatchForUid(key, uid);
    }
  } finally {
    refreshInFlight = false;
  }
}


function scheduleRefreshWatches(reason) {
  try {
    watchRefreshBurstUntil = Date.now() + 8000;
  } catch { }

  if (watchRefreshQueued) return;
  watchRefreshQueued = true;

  setTimeout(() => {
    watchRefreshQueued = false;
    refreshWatches();
  }, 150);
}

function installNavigationRefreshHooks() {
  const cleanups = [];

  try {
    const onVis = () => {
      if (!document.hidden) scheduleRefreshWatches("visibility");
    };
    document.addEventListener("visibilitychange", onVis);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
  } catch { }

  try {
    const onHash = () => scheduleRefreshWatches("hashchange");
    window.addEventListener("hashchange", onHash);
    cleanups.push(() => window.removeEventListener("hashchange", onHash));
  } catch { }

  try {
    const onPop = () => scheduleRefreshWatches("popstate");
    window.addEventListener("popstate", onPop);
    cleanups.push(() => window.removeEventListener("popstate", onPop));
  } catch { }
  
  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    const wrap = (orig) =>
      function () {
        const res = orig.apply(this, arguments);
        scheduleRefreshWatches("history");
        return res;
      };

    history.pushState = wrap(origPush);
    history.replaceState = wrap(origReplace);

    cleanups.push(() => {
      try { history.pushState = origPush; } catch { }
      try { history.replaceState = origReplace; } catch { }
    });
  } catch { }
  
  try {
    const rs = document.querySelector(".rm-right-sidebar");
    if (rs) {
      sidebarWatchObserver = new MutationObserver(() => scheduleRefreshWatches("sidebar"));
      sidebarWatchObserver.observe(rs, { childList: true, subtree: true });
      cleanups.push(() => {
        try { sidebarWatchObserver.disconnect(); } catch { }
        sidebarWatchObserver = null;
      });
    }
  } catch { }

  navCleanupFns = cleanups;
}

function uninstallNavigationRefreshHooks() {
  try {
    navCleanupFns.forEach((fn) => {
      try { fn(); } catch { }
    });
  } catch { }
  navCleanupFns = [];
}

function startWatchRefreshLoop() {
  if (watchRefreshTimer) return;

  installNavigationRefreshHooks();

  watchRefreshTimer = setInterval(() => {
    const now = Date.now();
    const shouldPoll = now < watchRefreshBurstUntil;
    if (shouldPoll) {
      refreshWatches();
    } else {
      // Slow poll when idle
      refreshWatches();
    }
  }, 8000);
}

function stopWatchRefreshLoop() {
  try {
    if (watchRefreshTimer) clearInterval(watchRefreshTimer);
  } catch { }
  watchRefreshTimer = null;

  uninstallNavigationRefreshHooks();
}

function startDomObserver() {
  if (domObserver) return;

  domObserver = new MutationObserver((muts) => {
    let saw = false;

    for (const m of muts) {
      if (m.addedNodes?.length) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;

          if (n.classList?.contains("roam-block-container")) {
            markContainerDirty(n);
            saw = true;
          }

          if (n.querySelectorAll) {
            n.querySelectorAll(".roam-block-container").forEach((c) => {
              markContainerDirty(c);
              saw = true;
            });
          }
        });
      }
    }

    if (saw) scheduleDomApplyPass();
  });

  getBulletRoots().forEach((root) => {
    try {
      domObserver.observe(root, { childList: true, subtree: true });
    } catch { }
  });
}

function stopDomObserver() {
  domObserver?.disconnect();
  domObserver = null;
}

function startCacheEvictor() {
  if (cacheEvictTimer) return;
  cacheEvictTimer = setInterval(() => {
    if (typeCache.size > 2000) typeCache.clear();
    if (provCache.size > 2000) provCache.clear();
  }, 30000);
}

function stopCacheEvictor() {
  if (!cacheEvictTimer) return;
  clearInterval(cacheEvictTimer);
  cacheEvictTimer = null;
}

function computePrefixSignature() {
  const parts = [];

  for (const bt of BULLET_TYPES) {
    if (!isBulletTypeEnabled(bt.id)) continue;
    const prefix = getEffectivePrefix(bt) || "";
    parts.push(`r:${bt.id}:${prefix}`);
  }

  for (const pt of PROVENANCE_TYPES) {
    if (!isProvTypeEnabled(pt.id)) continue;
    const prefix = getEffectiveProvPrefix(pt) || "";
    parts.push(`p:${pt.id}:${prefix}`);
  }

  parts.sort();
  return parts.join("|");
}

function detectPrefixCollisions() {
  const enabledReasoning = BULLET_TYPES.filter((bt) => isBulletTypeEnabled(bt.id));
  const enabledProv = PROVENANCE_TYPES.filter((pt) => isProvTypeEnabled(pt.id));

  // Collect all prefixes from both dimensions into a single map
  const prefixToIds = new Map();

  for (const bt of enabledReasoning) {
    const p = getEffectivePrefix(bt) || "";
    if (!prefixToIds.has(p)) prefixToIds.set(p, []);
    prefixToIds.get(p).push(`reasoning:${bt.id}`);
  }

  for (const pt of enabledProv) {
    const p = getEffectiveProvPrefix(pt) || "";
    if (!prefixToIds.has(p)) prefixToIds.set(p, []);
    prefixToIds.get(p).push(`provenance:${pt.id}`);
  }

  const lines = [];

  for (const [p, ids] of prefixToIds) {
    if (!p) continue;
    if (ids.length > 1) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          lines.push(` - WARNING: Prefix "${p}" is duplicated between "${ids[i]}" and "${ids[j]}"`);
        }
      }
    }
  }

  // Check substring overlaps across all enabled types
  const allEnabled = [
    ...enabledReasoning.map((bt) => ({ id: `reasoning:${bt.id}`, prefix: getEffectivePrefix(bt) || "" })),
    ...enabledProv.map((pt) => ({ id: `provenance:${pt.id}`, prefix: getEffectiveProvPrefix(pt) || "" })),
  ];

  for (let i = 0; i < allEnabled.length; i++) {
    for (let j = 0; j < allEnabled.length; j++) {
      if (i === j) continue;
      const a = allEnabled[i];
      const b = allEnabled[j];
      if (!a.prefix || !b.prefix) continue;
      if (a.prefix !== b.prefix && a.prefix.startsWith(b.prefix)) {
        lines.push(` - note: Prefix "${a.prefix}" ( ${a.id} ) starts with "${b.prefix}" ( ${b.id} )`);
      }
    }
  }

  console.info("[Better Bullets] Prefix collision detector:");
  if (lines.length) {
    lines.forEach((l) => console.info(l));
  } else {
    console.info(" - none detected");
  }
}

function schedulePrefixCollisionDetect(force = false) {
  const sig = computePrefixSignature();
  if (!force && sig === lastPrefixSig) return;

  lastPrefixSig = sig;

  if (prefixDetectTimer) clearTimeout(prefixDetectTimer);
  prefixDetectTimer = setTimeout(() => {
    try {
      detectPrefixCollisions();
    } catch {
      // ignore
    }
  }, 180);
}

// Provenance lives in block props, so it can be set directly on the focused block
// without typing a marker at all. One command per *enabled* type, re-synced when
// the enabled set changes so the palette never lists types the user turned off.
// Registered via extensionAPI, so they group under Better Bullets in the Hotkeys
// window and users can bind their own keys.
let provMarkCommandLabels = [];

function provMarkCommandLabel(pt) {
  return `Better Bullets: Mark as ${pt.icon} ${pt.label}`;
}

function syncProvMarkCommands(extensionAPI) {
  try {
    for (const label of provMarkCommandLabels) {
      extensionAPI.ui.commandPalette.removeCommand({ label });
    }
    provMarkCommandLabels = [];

    for (const pt of PROVENANCE_TYPES) {
      if (!isProvTypeEnabled(pt.id)) continue;

      const label = provMarkCommandLabel(pt);
      extensionAPI.ui.commandPalette.addCommand({
        label,
        callback: () => {
          try {
            const uid = getFocusedUidFromDom();
            if (!uid) return;
            persistProvenance(uid, pt);
            markAllVisibleContainersDirtyLight();
            scheduleDomApplyPass();
          } catch {
            // ignore
          }
        },
      });
      provMarkCommandLabels.push(label);
    }
  } catch (err) {
    console.warn("[Better Bullets] failed to sync provenance commands", err);
  }
}

function registerCommands(extensionAPI) {
  syncProvMarkCommands(extensionAPI);

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Clear bullet type from focused block",
    callback: () => {
      try {
        const uid = getFocusedUidFromDom();
        if (!uid) return;
        clearPersistedType(uid);
        typeCache.delete(uid);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    },
  });

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Clear provenance from focused block",
    callback: () => {
      try {
        const uid = getFocusedUidFromDom();
        if (!uid) return;
        clearPersistedProv(uid);
        provCache.delete(uid);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    },
  });

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Clear all markers from focused block",
    callback: () => {
      try {
        const uid = getFocusedUidFromDom();
        if (!uid) return;
        clearPersistedType(uid);
        clearPersistedProv(uid);
        typeCache.delete(uid);
        provCache.delete(uid);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    },
  });

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Enable all bullet types",
    callback: () => {
      try {
        BULLET_TYPES.forEach((bt) => {
          bulletSettings.enabled[bt.id] = true;
          extensionAPI.settings.set(`bb-enable-${bt.id}`, true);
        });
        rebuildSettingsPanel(extensionAPI, { skipHydrate: true });
        typeCache.clear();
        schedulePrefixCollisionDetect(true);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    },
  });

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Disable all bullet types",
    callback: () => {
      try {
        BULLET_TYPES.forEach((bt) => {
          bulletSettings.enabled[bt.id] = false;
          extensionAPI.settings.set(`bb-enable-${bt.id}`, false);
        });
        rebuildSettingsPanel(extensionAPI, { skipHydrate: true });
        typeCache.clear();
        schedulePrefixCollisionDetect(true);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    },
  });

  extensionAPI.ui.commandPalette.addCommand({
    label: "Better Bullets: Show cheat sheet",
    callback: () => {
      try {
        const lines = [];
        lines.push("Better Bullets — Cheat Sheet");
        lines.push("----------------------------------------");
        BULLET_TYPES.forEach((bt) => {
          const prefix = getEffectivePrefix(bt);
          const on = isBulletTypeEnabled(bt.id);
          const status = on ? "" : " (disabled)";
          lines.push(`${bt.icon}  ${bt.id}  —  ${prefix}  —  ${bt.label}${status}`);
        });

        showBetterBulletsCheatSheet();
      } catch {
        // ignore
      }
    },
  });

  function showBetterBulletsCheatSheet() {
    const CORE_IDS = new Set([
      "equal",
      "arrow",
      "doubleArrow",
      "question",
      "important",
    ]);

    const lines = [];

    lines.push(
      "Better Bullets — Cheat Sheet",
      "----------------------------",
      "",
      "Core (enabled by default)"
    );

    BULLET_TYPES
      .filter(b => CORE_IDS.has(b.id))
      .forEach(b => {
        lines.push(
          `${b.icon}               ${b.label.padEnd(22)} `
        );
      });

    lines.push(
      "",
      "Optional (enable in settings)"
    );

    BULLET_TYPES
      .filter(b => !CORE_IDS.has(b.id))
      .forEach(b => {
        lines.push(
          `${b.icon}               ${b.label.padEnd(22)} `
        );
      });

    lines.push(
      "",
      "Provenance (enable in settings)"
    );

    PROVENANCE_TYPES.forEach(p => {
      const prefix = getEffectiveProvPrefix(p);
      const on = isProvTypeEnabled(p.id);
      const status = on ? "" : " (disabled)";
      lines.push(
        `${p.icon}  ${prefix.padEnd(4)}  ${p.label}${status}`
      );
    });

    alert(lines.join("\n"));
  }
}

function hydrateSettingsFromRoam(extensionAPI) {
  const stripKey = "bb-strip-markers";
  const reqSpaceKey = "bb-require-space";

  const stripRaw = extensionAPI.settings.get(stripKey);
  const reqSpaceRaw = extensionAPI.settings.get(reqSpaceKey);

  bulletSettings.stripMarkers = getSettingBool(extensionAPI, stripKey, false);
  bulletSettings.requireSpaceAfterMarker = getSettingBool(extensionAPI, reqSpaceKey, true);

  if (stripRaw === undefined || stripRaw === null) {
    extensionAPI.settings.set(stripKey, bulletSettings.stripMarkers);
  }
  if (reqSpaceRaw === undefined || reqSpaceRaw === null) {
    extensionAPI.settings.set(reqSpaceKey, bulletSettings.requireSpaceAfterMarker);
  }

  BULLET_TYPES.forEach((bt) => {
    const enableKey = `bb-enable-${bt.id}`;
    const enableRaw = extensionAPI.settings.get(enableKey);
    const enabled = getSettingBool(extensionAPI, enableKey, DEFAULT_ENABLED.has(bt.id));
    bulletSettings.enabled[bt.id] = enabled;

    if (enableRaw === undefined || enableRaw === null) {
      extensionAPI.settings.set(enableKey, enabled);
    }

    if (bt.configurablePrefix) {
      const prefixKey = `bb-prefix-${bt.id}`;
      const prefixRaw = extensionAPI.settings.get(prefixKey);
      const prefix = getSettingStr(extensionAPI, prefixKey, bt.prefix);
      bulletSettings.prefixes[bt.id] = prefix;
      if (prefixRaw === undefined || prefixRaw === null) {
        extensionAPI.settings.set(prefixKey, prefix);
      }
    }
  });

  // --- Provenance settings ---
  const stripProvKey = "bb-strip-prov-markers";
  const stripProvRaw = extensionAPI.settings.get(stripProvKey);
  bulletSettings.stripProvMarkers = getSettingBool(extensionAPI, stripProvKey, false);
  if (stripProvRaw === undefined || stripProvRaw === null) {
    extensionAPI.settings.set(stripProvKey, bulletSettings.stripProvMarkers);
  }

  PROVENANCE_TYPES.forEach((pt) => {
    const enableKey = `bb-prov-enable-${pt.id}`;
    const enableRaw = extensionAPI.settings.get(enableKey);
    const enabled = getSettingBool(extensionAPI, enableKey, false);
    bulletSettings.provEnabled[pt.id] = enabled;

    if (enableRaw === undefined || enableRaw === null) {
      extensionAPI.settings.set(enableKey, enabled);
    }

    if (pt.configurablePrefix) {
      const prefixKey = `bb-prov-prefix-${pt.id}`;
      const prefixRaw = extensionAPI.settings.get(prefixKey);
      const prefix = getSettingStr(extensionAPI, prefixKey, pt.prefix);
      bulletSettings.provPrefixes[pt.id] = prefix;
      if (prefixRaw === undefined || prefixRaw === null) {
        extensionAPI.settings.set(prefixKey, prefix);
      }
    }
  });
}

function buildSettingsConfig(extensionAPI) {
  const settings = [];

  settings.push({
    id: "bb-require-space",
    name: "Require a space after marker",
    description:
      'If enabled (default), markers only trigger when followed by a space/tab/NBSP or end-of-line (e.g. "-> hello"). Turn off to allow "->hello".',
    action: {
      type: "switch",
      value: bulletSettings.requireSpaceAfterMarker,
      onChange: (e) => {
        const enabled = coerceBoolInput(e);
        bulletSettings.requireSpaceAfterMarker = enabled;
        extensionAPI.settings.set("bb-require-space", enabled);

        typeCache.clear();
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      },
    },
  });

  settings.push({
    id: "bb-strip-markers",
    name: "Strip marker prefix from text",
    description:
      'If enabled, leading markers like "->", "=>", "??", "..." are removed after recognition. Bullet type is preserved via block props.',
    action: {
      type: "switch",
      value: bulletSettings.stripMarkers,
      onChange: (e) => {
        const enabled = coerceBoolInput(e);
        bulletSettings.stripMarkers = enabled;
        extensionAPI.settings.set("bb-strip-markers", enabled);

        typeCache.clear();
        refreshWatches();
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      },
    },
  });

  BULLET_TYPES.forEach((bt) => {
    const enabledNow = isBulletTypeEnabled(bt.id);

    settings.push({
      id: `bb-enable-${bt.id}`,
      name: `Enable: ${bt.label}`,
      description: "Toggle this bullet type.",
      action: {
        type: "switch",
        value: enabledNow,
        onChange: (e) => {
          const enabled = coerceBoolInput(e);
          bulletSettings.enabled[bt.id] = enabled;
          extensionAPI.settings.set(`bb-enable-${bt.id}`, enabled);
          
          rebuildSettingsPanel(extensionAPI, { skipHydrate: true });

          typeCache.clear();
          schedulePrefixCollisionDetect();
          markAllVisibleContainersDirtyFull();
          scheduleDomApplyPass();
        },
      },
    });
    
    if (bt.configurablePrefix && enabledNow) {
      settings.push({
        id: `bb-prefix-${bt.id}`,
        name: `Prefix for: ${bt.id}`,
        description: `Customize the trigger prefix for "${bt.id}" (default: "${bt.prefix}").`,
        action: {
          type: "input",
          placeholder: bt.prefix,
          onChange: (v) => {
            const raw = (v?.target?.value ?? v?.value ?? v ?? "").toString();
            const next = raw.length ? raw : bt.prefix;

            bulletSettings.prefixes[bt.id] = next;
            extensionAPI.settings.set(`bb-prefix-${bt.id}`, next);

            typeCache.clear();
            schedulePrefixCollisionDetect();
            markAllVisibleContainersDirtyLight();
            scheduleDomApplyPass();
          },
        },
      });
    }
  });

  // --- Provenance section (progressive disclosure) ---
  const showProv = getSettingBool(extensionAPI, "bb-show-provenance", false);

  settings.push({
    id: "bb-show-provenance",
    name: "Show provenance settings",
    description: "Provenance types mark the source of content (e.g. email, phone, calendar). Enable this to configure them.",
    action: {
      type: "switch",
      value: showProv,
      onChange: () => {
        setTimeout(() => {
          rebuildSettingsPanel(extensionAPI, { skipHydrate: false });
        }, 60);
      },
    },
  });

  if (showProv) {
    settings.push({
      id: "bb-strip-prov-markers",
      name: "Strip provenance prefix from text",
      description:
        'If enabled, provenance marker prefixes (emoji) are removed after recognition. Provenance type is preserved via block props.',
      action: {
        type: "switch",
        value: bulletSettings.stripProvMarkers,
        onChange: (e) => {
          const enabled = coerceBoolInput(e);
          bulletSettings.stripProvMarkers = enabled;
          extensionAPI.settings.set("bb-strip-prov-markers", enabled);

          provCache.clear();
          refreshWatches();
          markAllVisibleContainersDirtyLight();
          scheduleDomApplyPass();
        },
      },
    });

    PROVENANCE_TYPES.forEach((pt) => {
      const enabledNow = isProvTypeEnabled(pt.id);

      settings.push({
        id: `bb-prov-enable-${pt.id}`,
        name: `Enable: ${pt.icon} ${pt.label}`,
        description: `Toggle this provenance type (prefix: ${getEffectiveProvPrefix(pt)}).`,
        action: {
          type: "switch",
          value: enabledNow,
          onChange: (e) => {
            const enabled = coerceBoolInput(e);
            bulletSettings.provEnabled[pt.id] = enabled;
            extensionAPI.settings.set(`bb-prov-enable-${pt.id}`, enabled);

            rebuildSettingsPanel(extensionAPI, { skipHydrate: true });
            syncProvMarkCommands(extensionAPI);

            provCache.clear();
            schedulePrefixCollisionDetect();
            markAllVisibleContainersDirtyFull();
            scheduleDomApplyPass();
          },
        },
      });

      if (pt.configurablePrefix && enabledNow) {
        settings.push({
          id: `bb-prov-prefix-${pt.id}`,
          name: `Prefix for: ${pt.id}`,
          description: `Customise the trigger prefix for "${pt.id}" (default: "${pt.prefix}").`,
          action: {
            type: "input",
            placeholder: pt.prefix,
            onChange: (v) => {
              const raw = (v?.target?.value ?? v?.value ?? v ?? "").toString();
              const next = raw.length ? raw : pt.prefix;

              bulletSettings.provPrefixes[pt.id] = next;
              extensionAPI.settings.set(`bb-prov-prefix-${pt.id}`, next);

              provCache.clear();
              schedulePrefixCollisionDetect();
              markAllVisibleContainersDirtyLight();
              scheduleDomApplyPass();
            },
          },
        });
      }
    });
  }

  return {
    tabTitle: "Better Bullets",
    settings,
  };
}

function rebuildSettingsPanel(extensionAPI, options = {}) {
  try {
    if (!options.skipHydrate) {
      hydrateSettingsFromRoam(extensionAPI);
    }
    extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
  } catch (err) {
    console.warn("[Better Bullets] failed to rebuild settings panel", err);
  }
}

export default {
  onload: ({ extensionAPI }) => {
    if (window[GLOBAL_KEY]?.unload) {
      try {
        window[GLOBAL_KEY].unload();
      } catch {
        // ignore
      }
    }

    // Hydrate settings first so the panel shows correct dynamic fields immediately
    hydrateSettingsFromRoam(extensionAPI);
    rebuildSettingsPanel(extensionAPI);
    
    registerCommands(extensionAPI);

    // Observer + cache + focus
    startDomObserver();
    startCacheEvictor();
    startFocusOutListener();

    // Watches
    refreshWatches();
    
    markAllVisibleContainersDirtyLight();
    scheduleDomApplyPass();
    
    schedulePrefixCollisionDetect(true);
    
    startWatchRefreshLoop();

    window[GLOBAL_KEY] = {
      unload: () => {
        try {
          stopDomObserver();
        } catch { }

        try {
          stopCacheEvictor();
        } catch { }

        try {
          stopFocusOutListener();
        } catch { }

        try {
          stopWatchRefreshLoop();
        } catch { }

        try {
          if (prefixDetectTimer) {
            clearTimeout(prefixDetectTimer);
            prefixDetectTimer = null;
          }
        } catch { }

        try {
          if (applyContinuationTimer) {
            clearTimeout(applyContinuationTimer);
            applyContinuationTimer = null;
          }
        } catch { }

        try {
          for (const t of pendingFocusedStrip.values()) clearTimeout(t);
          pendingFocusedStrip.clear();
        } catch { }

        try {
          for (const key of Array.from(activeWatches.keys())) removeWatch(key);
          activeWatches.clear();
        } catch { }

        try {
          const nodes = document.querySelectorAll(".roam-block-container");
          const max = 300;
          let i = 0;
          for (const c of nodes) {
            c.removeAttribute("data-better-bullet");
            c.removeAttribute("data-better-bullet-prov");
            const toRemove = [];
            c.classList.forEach((cls) => {
              if (cls.startsWith("better-bullet-")) toRemove.push(cls);
            });
            toRemove.forEach((cls) => c.classList.remove(cls));
            i++;
            if (i >= max) break;
          }
        } catch { }

        // extensionAPI commands are removed automatically on unload; just drop the
        // labels so a re-load starts from a clean slate.
        provMarkCommandLabels = [];

        try {
          typeCache.clear();
          provCache.clear();
          propWriteQueue.clear();
          dirtyContainers.clear();
        } catch { }
      },
    };
  },

  onunload: () => {
    try {
      window[GLOBAL_KEY]?.unload?.();
    } catch {
      // ignore
    }
  },
};
