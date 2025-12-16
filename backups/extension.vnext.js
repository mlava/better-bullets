/* =========================
   Better Bullets — DB WATCH BUILD (addPullWatch) — ROBUST
   Fixes:
   ✅ getOpenPageOrBlockUid() can be async (await it)
   ✅ On watch add, do an initial pull+scan so existing prefixes are processed
   ✅ DOM renderer: paint from persisted props, but fallback to visible prefix if not yet persisted
   ✅ Strip prefixes (repeatable, verified, avoids focused block)
   ========================= */

const BULLET_TYPES = [
  { id: "equal", label: 'Equal / definition (prefix "=")', prefix: "=", icon: "≡" },
  { id: "arrow", label: 'Single arrow / leads to (prefix "->")', prefix: "->", icon: "→" },
  { id: "doubleArrow", label: 'Double arrow / result (prefix "=>")', prefix: "=>", icon: "⇒" },
  { id: "question", label: 'Question (prefix "?")', prefix: "?", icon: "?" },
  { id: "important", label: 'Important / warning (prefix "!")', prefix: "!", icon: "!" },
  { id: "plus", label: 'Idea / addition (prefix "+")', prefix: "+", icon: "+" },
  { id: "downRight90", label: 'Right-angle arrow (prefix "v>")', prefix: "v>", icon: "⤷" },
  { id: "contrast", label: 'Contrast / however (prefix "~")', prefix: "~", icon: "≠" },
  { id: "evidence", label: 'Evidence / support (prefix "^")', prefix: "^", icon: "▸" },
  { id: "conclusion", label: 'Conclusion / synthesis (prefix "∴")', prefix: "∴", icon: "∴" },
  { id: "hypothesis", label: 'Hypothesis / tentative (prefix "??")', prefix: "??", icon: "◊" },
  { id: "depends", label: 'Depends on / prerequisite (prefix "<-")', prefix: "<-", icon: "↤" },
  { id: "decision", label: 'Decision / choice (prefix "|")', prefix: "|", icon: "⎇" },
  { id: "reference", label: 'Reference / related (prefix "@")', prefix: "@", icon: "↗" },
  { id: "process", label: 'Process / ongoing (prefix "...")', prefix: "...", icon: "↻" },
];

const bulletSettings = {
  enabled: {}, // id -> boolean (default ON)
  stripMarkers: false,
  requireSpaceAfterMarker: true, // default ON (prevents accidental triggers like '=1+1')
};

const PERSIST_PROP_TYPE_KEYS = [
  "::better-bullets/type",
  ":better-bullets/type",
  "better-bullets/type",
  "::better-bullets",
  ":better-bullets",
  "better-bullets",
];

const PERSIST_WRITE_KEY = "better-bullets/type";

let domObserver = null;

// Watches keyed by "main:<uid>" or "rs:<window-id>:<uid>"
const activeWatches = new Map(); // key -> unwatchFn
let watchRefreshTimer = null;
let refreshInFlight = false;

// Cache to avoid pulling props repeatedly in DOM observer
const typeCache = new Map(); // uid -> typeId|null (short-lived)
let cacheEvictTimer = null;

/* =========================
   Utilities
   ========================= */

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

/**
 * Robust UID extraction from a block container
 */
function getBlockUidFromContainer(container) {
  if (!container?.querySelectorAll) return null;

  const tryExtract = (id) => {
    if (typeof id !== "string") return null;
    const m = id.match(/-([A-Za-z0-9]{9})$/);
    return m ? m[1] : null;
  };

  const candidates = [
    container.querySelector(".rm-block__input[id^='block-input-']"),
    container.querySelector(".rm-block-text[id^='block-input-']"),
    container.querySelector("[id^='block-input-']"),
  ].filter(Boolean);

  for (const el of candidates) {
    const uid = tryExtract(el.id);
    if (uid) return uid;
  }

  const all = container.querySelectorAll("[id*='block-input-']");
  for (const el of all) {
    const uid = tryExtract(el.id);
    if (uid) return uid;
  }

  const allWithId = container.querySelectorAll("[id]");
  for (const el of allWithId) {
    const uid = tryExtract(el.id);
    if (uid) return uid;
  }

  return null;
}

function getBulletTypeByPrefixFromString(blockString) {
  const trimmed = stripLeadingInvisibles(blockString);

  for (const bt of BULLET_TYPES) {
    if (!isBulletTypeEnabled(bt.id)) continue;

    // Default behaviour requires a trailing space (or end-of-line) after the marker.
    // Turn off "requireSpaceAfterMarker" if you prefer triggers like "->foo" or "=def".
    const re = bulletSettings.requireSpaceAfterMarker
      ? new RegExp(
          `^${escapeRegExp(bt.prefix)}(?:[\s\u00A0\u200B\u200C\u200D\uFEFF]|$)`
        )
      : new RegExp(`^${escapeRegExp(bt.prefix)}`);

    if (re.test(trimmed)) return bt;
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
  if (!window.roamAlphaAPI || !uid) return null;

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
  if (!window.roamAlphaAPI || !uid || !bulletType) return;
  if (!/^[A-Za-z0-9]{9}$/.test(uid)) return;

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

/* =========================
   Stripping (verified, skip focused uid)
   ========================= */

async function stripMarkerFromUid(uid, bulletType, focusedUid) {
  if (!window.roamAlphaAPI) return false;
  if (!bulletSettings.stripMarkers) return true;
  if (!uid || !/^[A-Za-z0-9]{9}$/.test(uid)) return false;
  if (!bulletType?.prefix) return false;
  if (focusedUid && uid === focusedUid) return false;

  const re = buildStripRegex(bulletType.prefix);

  let pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  let orig = pulled?.[":block/string"];
  if (typeof orig !== "string") return false;

  if (!re.test(orig)) return true;

  const next = orig.replace(re, "");
  if (next === orig) return true;

  await Promise.resolve(window.roamAlphaAPI.updateBlock({ block: { uid, string: next } }));

  await new Promise((r) => setTimeout(r, 90));
  pulled = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
  const after = pulled?.[":block/string"];
  if (typeof after !== "string") return false;
  if (re.test(after)) return false;

  return true;
}



/* =========================
   Focus-out stripping (fixes "skip focused block" flakiness)
   ========================= */

let focusoutTimerByUid = new Map();

function scheduleStripAfterFocusout(uid) {
  if (!bulletSettings.stripMarkers) return;
  if (!uid || !/^[A-Za-z0-9]{9}$/.test(uid)) return;

  if (focusoutTimerByUid.has(uid)) clearTimeout(focusoutTimerByUid.get(uid));

  const t = setTimeout(async () => {
    focusoutTimerByUid.delete(uid);

    try {
      // Prefer persisted type (most reliable)
      const typeId = readPersistedType(uid);
      const btFromProp = typeId ? getBulletTypeById(typeId) : null;

      if (btFromProp && isBulletTypeEnabled(btFromProp.id)) {
        await stripMarkerFromUid(uid, btFromProp, null);
        scheduleDomApplyPass();
        return;
      }

      // Fallback: detect from current string
      const pulled = window.roamAlphaAPI?.pull?.("[:block/string]", [":block/uid", uid]);
      const str = pulled?.[":block/string"];
      if (typeof str !== "string") return;

      const detected = getBulletTypeByPrefixFromString(str);
      if (detected && isBulletTypeEnabled(detected.id)) {
        persistType(uid, detected);
        await stripMarkerFromUid(uid, detected, null);
        scheduleDomApplyPass();
      }
    } catch {
      // ignore
    }
  }, 140);

  focusoutTimerByUid.set(uid, t);
}

let focusOutListener = null;
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
   Apply CSS classes (rendering)
   - Primary: persisted props
   - Fallback: visible prefix (instant UI, even before persistence catches up)
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

  // 1) persisted props win
  if (uid) {
    const typeId = readPersistedType(uid);
    const bt = typeId ? getBulletTypeById(typeId) : null;
    if (bt && isBulletTypeEnabled(bt.id)) {
      applyBulletClass(container, bt.id);
      return;
    }
  }

  // 2) fallback: visible prefix (instant UI)
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
    await stripMarkerFromUid(uid, detected, focusedUid);
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

  const unwatch = window.roamAlphaAPI.data.addPullWatch(
    PULL_SPEC,
    query,
    async function (before, after) {
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

        scheduleDomApplyPass();
      } catch {
        // ignore
      }
    }
  );

  const unwatchFn = typeof unwatch === "function" ? unwatch : null;
  activeWatches.set(key, unwatchFn || (() => {}));

  // ✅ critical: process existing prefixes immediately
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

async function refreshWatches() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const desired = await computeDesiredWatchKeys();

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
   DOM apply pass (debounced)
   ========================= */

let domApplyQueued = false;
function scheduleDomApplyPass() {
  if (domApplyQueued) return;
  domApplyQueued = true;
  requestAnimationFrame(() => {
    domApplyQueued = false;
    document.querySelectorAll(".roam-block-container").forEach(applyFromPropsOrPrefix);
  });
}

/* =========================
   Minimal DOM observer: apply classes on newly added blocks
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
            applyFromPropsOrPrefix(n);
            saw = true;
          }
          if (n.querySelectorAll) {
            n.querySelectorAll(".roam-block-container").forEach((c) => {
              applyFromPropsOrPrefix(c);
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
   Settings
   ========================= */

function buildSettings(extensionAPI) {
  const settings = [];

  settings.push({
    id: "bb-require-space",
    name: "Require a space after marker",
    description:
      'If enabled (default), markers only trigger when followed by a space/end-of-line (e.g. "-> hello"). Turn off to allow "->hello".',
    action: {
      type: "switch",
      onChange: (e) => {
        const enabled = !!(e?.target?.checked ?? e?.value ?? e);
        bulletSettings.requireSpaceAfterMarker = enabled;
        extensionAPI.settings.set("bb-require-space", enabled);

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

        // force a refresh + apply + initial scans will run for any new watches
        refreshWatches();
        scheduleDomApplyPass();
      },
    },
  });

  BULLET_TYPES.forEach((bt) => {
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

          typeCache.clear();
          scheduleDomApplyPass();
        },
      },
    });
  });

  extensionAPI.settings.panel.create({
    tabTitle: "Better Bullets",
    settings,
  });

  bulletSettings.stripMarkers = extensionAPI.settings.get("bb-strip-markers") === true;
  const spaceSetting = extensionAPI.settings.get("bb-require-space");
  bulletSettings.requireSpaceAfterMarker = spaceSetting !== false;

  BULLET_TYPES.forEach((bt) => {
    const stored = extensionAPI.settings.get(`bb-enable-${bt.id}`);
    bulletSettings.enabled[bt.id] = stored !== false;
  });
}

/* =========================
   Lifecycle
   ========================= */

export default {
  onload: ({ extensionAPI }) => {
    buildSettings(extensionAPI);

    startDomObserver();
    startCacheEvictor();
    startFocusOutListener();

    refreshWatches();
    scheduleDomApplyPass();

    watchRefreshTimer = setInterval(() => {
      refreshWatches();
    }, 800);
  },

  onunload: () => {
    stopDomObserver();
    stopCacheEvictor();
    stopFocusOutListener();

    if (watchRefreshTimer) {
      clearInterval(watchRefreshTimer);
      watchRefreshTimer = null;
    }

    for (const key of Array.from(activeWatches.keys())) removeWatch(key);
    activeWatches.clear();

    document.querySelectorAll(".roam-block-container").forEach((c) => {
      c.removeAttribute("data-better-bullet");
      const toRemove = [];
      c.classList.forEach((cls) => {
        if (cls.startsWith("better-bullet-")) toRemove.push(cls);
      });
      toRemove.forEach((cls) => c.classList.remove(cls));
    });

    typeCache.clear();
  },
};
