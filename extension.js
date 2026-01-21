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

// Default enabled set for new installs (existing installs keep saved settings)
const DEFAULT_ENABLED = new Set();

const bulletSettings = {
  enabled: {}, // id -> boolean (default ON)
  stripMarkers: false,
  requireSpaceAfterMarker: true, // default ON
  prefixes: {}, // id -> string (configurable prefix overrides)
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

function safeUpdateBlock(payload) {
  if (!window.roamAlphaAPI?.updateBlock) return;
  try {
    const res = window.roamAlphaAPI.updateBlock(payload);
    if (res?.catch) res.catch(() => { });
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

function registerCommands(extensionAPI) {
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
            const toRemove = [];
            c.classList.forEach((cls) => {
              if (cls.startsWith("better-bullet-")) toRemove.push(cls);
            });
            toRemove.forEach((cls) => c.classList.remove(cls));
            i++;
            if (i >= max) break;
          }
        } catch { }

        try {
          typeCache.clear();
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
