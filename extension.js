/* =========================
   Better Bullets — DB WATCH BUILD (addPullWatch) — ROBUST + LIGHTWEIGHT
   Includes:
   ✅ Require visible whitespace after marker (prevents v>test triggers when ON)
   ✅ Strip markers optional, never while focused
   ✅ Persisted type drives rendering; prefix fallback for instant UI
   ✅ Command palette:
      - Clear bullet type from focused block
      - Enable all bullet types
      - Disable all bullet types
      - Show cheat sheet (console)
   ✅ Configurable prefixes (currently: v> and ∴) — prefix input only shown when that glyph is enabled
   ✅ Prefix collision detector is deduped + debounced (won’t spam console)
   ✅ DOM apply pass is incremental + time-sliced (avoids full-page sweeps on every change)
   ✅ Watch refresh is signature-based (won’t thrash addPullWatch when nothing changed)
   ========================= */

/* =========================
   Bullet definitions
   ========================= */

const BULLET_TYPES = [
  { id: "equal", label: 'Equal / definition (prefix "=")', prefix: "=", icon: "≡" },
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

/* =========================
   Settings state
   ========================= */

const bulletSettings = {
  enabled: {}, // id -> boolean (default ON)
  stripMarkers: false,
  requireSpaceAfterMarker: true, // default ON
  prefixes: {}, // id -> string (configurable prefix overrides)
};

const GLOBAL_KEY = "__better_bullets__v2";

/* =========================
   Persisted prop keys (read) + write key
   ========================= */

const PERSIST_PROP_TYPE_KEYS = [
  "::better-bullets/type",
  ":better-bullets/type",
  "better-bullets/type",
  "::better-bullets",
  ":better-bullets",
  "better-bullets",
];

const PERSIST_WRITE_KEY = "better-bullets/type";

/* =========================
   UID rules (CRITICAL FIX)
   - Roam block UIDs are 9 chars and commonly include "-" / "_"
   ========================= */

const UID_RE = /^[-_A-Za-z0-9]{9}$/;

/* =========================
   Watch/observer state
   ========================= */

let domObserver = null;
let watchRefreshTimer = null;
let refreshInFlight = false;

// Watches keyed by "main:<uid>" or "rs:<window-id>:<uid>"
const activeWatches = new Map(); // key -> unwatchFn
let lastWatchSignature = "";

// Avoid stripping while focused; retry shortly after blur
const pendingFocusedStrip = new Map(); // uid -> timer
let focusoutTimerByUid = new Map();
let focusOutListener = null;

// Cache to avoid pulling props repeatedly in DOM observer
const typeCache = new Map(); // uid -> typeId|null (short-lived)
let cacheEvictTimer = null;

// DOM apply batching
const dirtyContainers = new Set(); // Set<HTMLElement>
let applyQueued = false;
let applyContinuationTimer = null;

// Prefix collision detector dedupe/debounce
let lastPrefixSig = "";
let prefixDetectTimer = null;

// Optional debug
const DEBUG_DETECT = false;

/* =========================
   Utilities
   ========================= */

function getSettingBool(extensionAPI, key, defaultValue) {
  const v = extensionAPI.settings.get(key);
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return defaultValue;
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

function safeUpdateBlock(payload) {
  if (!window.roamAlphaAPI?.updateBlock) return;
  try {
    const res = window.roamAlphaAPI.updateBlock(payload);
    if (res?.catch) res.catch(() => {});
  } catch {
    // ignore
  }
}

function getFocusedUidFromDom() {
  const el = document.activeElement;
  if (!el?.closest) return null;
  const container = el.closest(".roam-block-container");
  if (!container) return null;
  return getBlockUidFromContainer(container);
}

function getBlockUidFromContainer(container) {
  if (!container || !container.querySelectorAll) return null;

  const candidates = container.querySelectorAll(
    "textarea[id], .rm-block__input[id], [id^='block-input-'], [id*='block-input-']"
  );

  for (const el of candidates) {
    const id = el && typeof el.id === "string" ? el.id : "";
    if (!id || id.length < 9) continue;
    const uid = id.slice(-9);
    if (UID_RE.test(uid)) return uid;
  }

  const any = container.querySelectorAll("[id]");
  for (const el of any) {
    const id = el && typeof el.id === "string" ? el.id : "";
    if (!id || id.length < 9) continue;
    const uid = id.slice(-9);
    if (UID_RE.test(uid)) return uid;
  }

  return null;
}

/* =========================
   Prefix detection
   - Require VISIBLE whitespace when requireSpaceAfterMarker is ON
   ========================= */

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

/* =========================
   Persistence
   ========================= */

function readPersistedType(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return null;

  if (typeCache.has(uid)) return typeCache.get(uid);

  try {
    const pulled = window.roamAlphaAPI.pull("[:block/props]", [":block/uid", uid]);
    const props = pulled?.[":block/props"];
    const typeId = getPropValue(props, PERSIST_PROP_TYPE_KEYS);
    const val = typeof typeId === "string" && typeId ? typeId : null;
    typeCache.set(uid, val);
    return val;
  } catch {
    typeCache.set(uid, null);
    return null;
  }
}

function persistType(uid, bulletType) {
  if (!window.roamAlphaAPI || !isValidUid(uid) || !bulletType) return;

  typeCache.set(uid, bulletType.id);
  safeUpdateBlock({
    block: {
      uid,
      props: {
        [PERSIST_WRITE_KEY]: bulletType.id,
      },
    },
  });
}

function clearPersistedType(uid) {
  if (!window.roamAlphaAPI || !isValidUid(uid)) return;

  typeCache.set(uid, null);
  safeUpdateBlock({
    block: {
      uid,
      props: {
        [PERSIST_WRITE_KEY]: null,
      },
    },
  });
}

/* =========================
   Stripping (verified, skip focused uid)
   ========================= */

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

/* =========================
   Focus-handling: strip after unfocus (for focused blocks)
   ========================= */

function scheduleStripWhenUnfocused(uid, bulletType) {
  if (!bulletSettings.stripMarkers) return;
  if (!isValidUid(uid)) return;

  if (pendingFocusedStrip.has(uid)) clearTimeout(pendingFocusedStrip.get(uid));

  const t = setTimeout(async () => {
    pendingFocusedStrip.delete(uid);

    const nowFocused = getFocusedUidFromDom();
    if (nowFocused === uid) {
      scheduleStripWhenUnfocused(uid, bulletType);
      return;
    }

    try {
      await stripMarkerFromUid(uid, bulletType, null);
      markAllVisibleContainersDirtyLight();
      scheduleDomApplyPass();
    } catch {
      // ignore
    }
  }, 250);

  pendingFocusedStrip.set(uid, t);
}

function scheduleStripAfterFocusout(uid) {
  if (!bulletSettings.stripMarkers) return;
  if (!isValidUid(uid)) return;

  if (focusoutTimerByUid.has(uid)) clearTimeout(focusoutTimerByUid.get(uid));

  const t = setTimeout(async () => {
    focusoutTimerByUid.delete(uid);

    try {
      const typeId = readPersistedType(uid);
      const btFromProp = typeId ? getBulletTypeById(typeId) : null;

      if (btFromProp && isBulletTypeEnabled(btFromProp.id)) {
        await stripMarkerFromUid(uid, btFromProp, null);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
        return;
      }

      const pulled = window.roamAlphaAPI?.pull?.("[:block/string]", [":block/uid", uid]);
      const str = pulled?.[":block/string"];
      if (typeof str !== "string") return;

      const detected = getBulletTypeByPrefixFromString(str);
      if (detected && isBulletTypeEnabled(detected.id)) {
        persistType(uid, detected);
        await stripMarkerFromUid(uid, detected, null);
        markAllVisibleContainersDirtyLight();
        scheduleDomApplyPass();
      }
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

/* =========================
   Rendering (classes)
   ========================= */

function clearBetterBulletClasses(container) {
  const toRemove = [];
  container.classList.forEach((c) => {
    if (c.startsWith("better-bullet-")) toRemove.push(c);
  });
  toRemove.forEach((c) => container.classList.remove(c));
}

function applyBulletClass(container, typeId) {
  clearBetterBulletClasses(container);

  if (!typeId) {
    container.removeAttribute("data-better-bullet");
    return;
  }

  container.classList.add(`better-bullet-${typeId}`);
  container.setAttribute("data-better-bullet", typeId);
}

function applyFromPropsOrPrefix(container) {
  const uid = getBlockUidFromContainer(container);

  if (uid) {
    const typeId = readPersistedType(uid);
    const bt = typeId ? getBulletTypeById(typeId) : null;
    if (bt && isBulletTypeEnabled(bt.id)) {
      applyBulletClass(container, bt.id);
      return;
    }
  }

  const textEl = container.querySelector(".rm-block-text");
  const raw = textEl?.innerText || "";
  const detected = raw ? getBulletTypeByPrefixFromString(raw) : null;

  if (detected && isBulletTypeEnabled(detected.id)) {
    applyBulletClass(container, detected.id);
    return;
  }

  applyBulletClass(container, null);
}

/* =========================
   Incremental DOM apply pass (time-sliced)
   ========================= */

function markContainerDirty(container) {
  if (!container || container.nodeType !== 1) return;
  if (!container.classList?.contains("roam-block-container")) return;
  dirtyContainers.add(container);
}

function markAllVisibleContainersDirtyLight() {
  // “Light” fallback: only mark a limited number of containers to avoid massive sweeps.
  // This is used after operations where we can’t easily locate exact containers.
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

function scheduleDomApplyPass() {
  if (applyQueued) return;
  applyQueued = true;

  requestAnimationFrame(() => {
    applyQueued = false;
    processDirtyContainers();
  });
}

function processDirtyContainers() {
  // Time-slice to avoid long rAF handlers
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
    // Continue soon (not necessarily next rAF) to keep UI responsive
    if (applyContinuationTimer) clearTimeout(applyContinuationTimer);
    applyContinuationTimer = setTimeout(() => scheduleDomApplyPass(), 25);
  }
}

/* =========================
   DB watch diff processing
   ========================= */

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

  const detected = getBulletTypeByPrefixFromString(str);
  if (detected && isBulletTypeEnabled(detected.id)) {
    persistType(uid, detected);

    if (bulletSettings.stripMarkers && focusedUid === uid) {
      scheduleStripWhenUnfocused(uid, detected);
      return;
    }

    await stripMarkerFromUid(uid, detected, null);
  }
}

/* =========================
   addPullWatch wiring + initial scan
   ========================= */

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

    // Don’t sweep whole page; just do a light mark and apply incrementally
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

      // Avoid full sweep; mark light set and apply incrementally
      markAllVisibleContainersDirtyLight();
      scheduleDomApplyPass();
    } catch {
      // ignore
    }
  });

  const unwatchFn = typeof unwatch === "function" ? unwatch : null;
  activeWatches.set(key, unwatchFn || (() => {}));

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

/* =========================
   Watch refresh logic (main + sidebar)
   ========================= */

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

/* =========================
   Minimal DOM observer: mark containers dirty on added nodes
   ========================= */

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

  domObserver.observe(document.body, { childList: true, subtree: true });
}

function stopDomObserver() {
  domObserver?.disconnect();
  domObserver = null;
}

/* =========================
   Cache eviction (keep memory bounded)
   ========================= */

function startCacheEvictor() {
  if (cacheEvictTimer) return;
  cacheEvictTimer = setInterval(() => {
    if (typeCache.size > 2000) typeCache.clear();
  }, 5000);
}

function stopCacheEvictor() {
  if (!cacheEvictTimer) return;
  clearInterval(cacheEvictTimer);
  cacheEvictTimer = null;
}

/* =========================
   Prefix collision detector (deduped + debounced)
   ========================= */

function computePrefixSignature() {
  const parts = [];

  for (const bt of BULLET_TYPES) {
    if (!isBulletTypeEnabled(bt.id)) continue;
    const prefix = getEffectivePrefix(bt) || "";
    parts.push(`${bt.id}:${prefix}`);
  }

  parts.sort();
  return parts.join("|");
}

function detectPrefixCollisions() {
  const enabled = BULLET_TYPES.filter((bt) => isBulletTypeEnabled(bt.id));

  const prefixToIds = new Map();
  for (const bt of enabled) {
    const p = getEffectivePrefix(bt) || "";
    if (!prefixToIds.has(p)) prefixToIds.set(p, []);
    prefixToIds.get(p).push(bt.id);
  }

  const lines = [];

  // Duplicates
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

  // Starts-with collisions (note)
  for (let i = 0; i < enabled.length; i++) {
    for (let j = 0; j < enabled.length; j++) {
      if (i === j) continue;
      const a = enabled[i];
      const b = enabled[j];
      const pa = getEffectivePrefix(a) || "";
      const pb = getEffectivePrefix(b) || "";
      if (!pa || !pb) continue;
      if (pa !== pb && pa.startsWith(pb)) {
        lines.push(` - note: Prefix "${pa}" ( ${a.id} ) starts with "${pb}" ( ${b.id} )`);
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

/* =========================
   Command palette
   ========================= */

function registerCommands(extensionAPI) {
  // Note (per you): Roam auto-cleans command palette registrations on unload,
  // so we do NOT removeCommand().
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
    label: "Better Bullets: Enable all bullet types",
    callback: () => {
      try {
        BULLET_TYPES.forEach((bt) => {
          bulletSettings.enabled[bt.id] = true;
          extensionAPI.settings.set(`bb-enable-${bt.id}`, true);
        });
        rebuildSettingsPanel(extensionAPI);
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
        rebuildSettingsPanel(extensionAPI);
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
    label: "Better Bullets: Show cheat sheet (console)",
    callback: () => {
      try {
        console.info("[Better Bullets] Cheat sheet");
        console.info("Better Bullets — Cheat Sheet");
        console.info("----------------------------------------");
        BULLET_TYPES.forEach((bt) => {
          const prefix = getEffectivePrefix(bt);
          const on = isBulletTypeEnabled(bt.id);
          const status = on ? "" : " (disabled)";
          console.info(`${bt.icon}  ${bt.id}  —  ${prefix}  —  ${bt.label}${status}`);
        });
      } catch {
        // ignore
      }
    },
  });
}

/* =========================
   Settings UI (dynamic rebuild)
   ========================= */

function hydrateSettingsFromRoam(extensionAPI) {
  bulletSettings.stripMarkers = getSettingBool(extensionAPI, "bb-strip-markers", false);
  bulletSettings.requireSpaceAfterMarker = getSettingBool(extensionAPI, "bb-require-space", true);

  BULLET_TYPES.forEach((bt) => {
    bulletSettings.enabled[bt.id] = getSettingBool(extensionAPI, `bb-enable-${bt.id}`, true);
    if (bt.configurablePrefix) {
      bulletSettings.prefixes[bt.id] = getSettingStr(extensionAPI, `bb-prefix-${bt.id}`, bt.prefix);
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
      onChange: (e) => {
        const enabled = !!(e?.target?.checked ?? e?.value ?? e);
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
      onChange: (e) => {
        const enabled = !!(e?.target?.checked ?? e?.value ?? e);
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
        onChange: (e) => {
          const enabled = !!(e?.target?.checked ?? e?.value ?? e);
          bulletSettings.enabled[bt.id] = enabled;
          extensionAPI.settings.set(`bb-enable-${bt.id}`, enabled);

          // Rebuild panel so configurable prefix inputs show/hide immediately
          rebuildSettingsPanel(extensionAPI);

          typeCache.clear();
          schedulePrefixCollisionDetect(); // signature-based, won’t spam
          markAllVisibleContainersDirtyLight();
          scheduleDomApplyPass();
        },
      },
    });

    // Configurable prefix input ONLY when enabled is ON (default hidden when OFF)
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
            schedulePrefixCollisionDetect(); // signature-based
            markAllVisibleContainersDirtyLight();
            scheduleDomApplyPass();
          },
        },
      });
    }
  });

  return {
    tabTitle: "Better Bullets",
    settings,
  };
}

function rebuildSettingsPanel(extensionAPI) {
  try {
    // Ensure our in-memory reflects latest persisted settings before building
    hydrateSettingsFromRoam(extensionAPI);
    extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
  } catch (err) {
    console.warn("[Better Bullets] failed to rebuild settings panel", err);
  }
}

/* =========================
   Lifecycle
   ========================= */

export default {
  onload: ({ extensionAPI }) => {
    // Kill any previous instance (dev reload safety)
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

    // Command palette (no removeCommand needed)
    registerCommands(extensionAPI);

    // Observer + cache + focus
    startDomObserver();
    startCacheEvictor();
    startFocusOutListener();

    // Watches
    refreshWatches();

    // Initial apply: don’t sweep everything; mark a light set and apply incrementally
    markAllVisibleContainersDirtyLight();
    scheduleDomApplyPass();

    // Prefix collision detector: run once on load (deduped thereafter)
    schedulePrefixCollisionDetect(true);

    // Refresh watches periodically, but signature-based to avoid thrash
    watchRefreshTimer = setInterval(() => {
      refreshWatches();
    }, 1200);

    window[GLOBAL_KEY] = {
      unload: () => {
        try {
          stopDomObserver();
        } catch {}

        try {
          stopCacheEvictor();
        } catch {}

        try {
          stopFocusOutListener();
        } catch {}

        try {
          if (watchRefreshTimer) {
            clearInterval(watchRefreshTimer);
            watchRefreshTimer = null;
          }
        } catch {}

        try {
          if (prefixDetectTimer) {
            clearTimeout(prefixDetectTimer);
            prefixDetectTimer = null;
          }
        } catch {}

        try {
          if (applyContinuationTimer) {
            clearTimeout(applyContinuationTimer);
            applyContinuationTimer = null;
          }
        } catch {}

        try {
          for (const t of pendingFocusedStrip.values()) clearTimeout(t);
          pendingFocusedStrip.clear();
        } catch {}

        try {
          for (const key of Array.from(activeWatches.keys())) removeWatch(key);
          activeWatches.clear();
        } catch {}

        try {
          // Best-effort cleanup of classes (light)
          const nodes = document.querySelectorAll(".roam-block-container");
          const max = 300;
          let i = 0;
          for (const c of nodes) {
            c.removeAttribute("data-better-bullet");
            const toRemove = [];
            c.classList.forEach((cls) => {
              if (cls.startsWith("better-bullet-")) toRemove.push(cls);
            });
            toRemove.forEach((cls) => c.classList.remove(cls));
            i++;
            if (i >= max) break;
          }
        } catch {}

        try {
          typeCache.clear();
          dirtyContainers.clear();
        } catch {}
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
