// parser.js — Arc JSON → ExportTree
// Pure functions. No DOM, no I/O.
(function (root) {
"use strict";

const APPLE_EPOCH_OFFSET = 978307200; // seconds from Unix epoch to Apple epoch

function appleToDate(appleSeconds) {
  return new Date((appleSeconds + APPLE_EPOCH_OFFSET) * 1000);
}

function yyyymm(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Walk an alternating [id, obj, id, obj, ...] array into a Map<id, obj>.
// Skips malformed pairs, logs to warnings.
function pairsToMap(arr, warnings, label) {
  const map = new Map();
  if (!Array.isArray(arr)) {
    warnings.push(`${label}: expected array, got ${typeof arr}`);
    return map;
  }
  for (let i = 0; i < arr.length - 1; i += 2) {
    const key = arr[i];
    const val = arr[i + 1];
    if (typeof key !== "string" || !val || typeof val !== "object") {
      warnings.push(`${label}: bad pair at index ${i}`);
      continue;
    }
    map.set(key, val);
  }
  return map;
}

// containerIDs arrays sometimes interleave plain labels ("pinned", "unpinned")
// with wrapped forms ({ pinned: {} }, { unpinned: { _0: { shared: {} } } }).
// We care about: paired entries where a label (string or single-key object)
// is followed by a container UUID.
function parseSpaceContainers(space, warnings) {
  const out = { pinned: [], unpinned: [] };
  const ids = space.containerIDs;
  if (!Array.isArray(ids)) return out;
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    let label = null;
    if (a === "pinned" || a === "unpinned") label = a;
    else if (a && typeof a === "object") {
      if ("pinned" in a) label = "pinned";
      else if ("unpinned" in a) label = "unpinned";
    }
    if (label && typeof b === "string") {
      out[label].push(b);
      i++; // consume b
    }
  }
  return out;
}

// Stringify a profile tag to a comparable key.
// Shapes observed:
//   { default: true }
//   { custom: { _0: { machineID, directoryBasename } } }
function profileKeyOf(tag) {
  if (!tag || typeof tag !== "object") return "__unknown__";
  if (tag.default === true) return "default";
  if (tag.custom && tag.custom._0) {
    const c = tag.custom._0;
    return `custom:${c.machineID || ""}:${c.directoryBasename || ""}`;
  }
  return "__unknown__";
}

function cleanTitle(item) {
  return (
    (typeof item.title === "string" && item.title.trim()) ||
    (item.data && item.data.tab && typeof item.data.tab.savedTitle === "string" && item.data.tab.savedTitle.trim()) ||
    ""
  );
}

function extractUrl(item) {
  return item && item.data && item.data.tab && typeof item.data.tab.savedURL === "string"
    ? item.data.tab.savedURL
    : null;
}

// Recursively walk an item's children, returning [Tab | Folder].
// Skips self, drops empty folders.
function walkChildren(itemId, itemMap, warnings, seen = new Set()) {
  if (seen.has(itemId)) {
    warnings.push(`cycle detected at item ${itemId}`);
    return [];
  }
  seen.add(itemId);
  const item = itemMap.get(itemId);
  if (!item) return [];
  const out = [];
  const children = Array.isArray(item.childrenIds) ? item.childrenIds : [];
  for (const childId of children) {
    const child = itemMap.get(childId);
    if (!child) continue;
    const url = extractUrl(child);
    if (url) {
      out.push({
        kind: "tab",
        title: cleanTitle(child) || url,
        url,
      });
    } else {
      // folder (or empty tab — skip if no children and no URL)
      const grand = walkChildren(childId, itemMap, warnings, new Set(seen));
      if (grand.length > 0) {
        out.push({
          kind: "folder",
          title: cleanTitle(child) || "Untitled folder",
          children: grand,
        });
      }
    }
  }
  seen.delete(itemId);
  return out;
}

function collectUrls(nodes, set) {
  for (const n of nodes) {
    if (n.kind === "tab") set.add(n.url);
    else if (n.kind === "folder") collectUrls(n.children, set);
  }
}

function parse(sidebarJson, archiveJson = null) {
  const warnings = [];
  if (!sidebarJson || !sidebarJson.sidebar || !Array.isArray(sidebarJson.sidebar.containers)) {
    throw new Error("Unrecognized StorableSidebar.json schema: missing sidebar.containers");
  }

  // Arc's sidebar has two containers; the second holds spaces/items.
  const main =
    sidebarJson.sidebar.containers.find((c) => c && Array.isArray(c.items)) ||
    sidebarJson.sidebar.containers[1];
  if (!main) throw new Error("No container with items[] found");

  const itemMap = pairsToMap(main.items, warnings, "sidebar.items");
  const spaceMap = pairsToMap(main.spaces, warnings, "sidebar.spaces");

  // ---- Spaces ----
  const spaces = [];
  const spaceIdByUuid = new Map();

  for (const [uuid, space] of spaceMap) {
    const { pinned, unpinned } = parseSpaceContainers(space, warnings);
    const pinnedChildren = [];
    const openChildren = [];
    for (const cid of pinned) pinnedChildren.push(...walkChildren(cid, itemMap, warnings));
    for (const cid of unpinned) openChildren.push(...walkChildren(cid, itemMap, warnings));

    // Dedup: if a URL is pinned, drop it from open tabs.
    const pinnedUrls = new Set();
    collectUrls(pinnedChildren, pinnedUrls);
    const openFiltered = filterByUrls(openChildren, pinnedUrls);

    const children = [...pinnedChildren];
    if (openFiltered.length > 0) {
      children.push({ kind: "folder", title: "Open tabs", children: openFiltered });
    }

    spaceIdByUuid.set(uuid, spaces.length);
    spaces.push({
      id: uuid,
      title: space.title || "Untitled space",
      emoji: space.customInfo && space.customInfo.iconType && space.customInfo.iconType.emoji_v2,
      children,
      archivedByMonth: new Map(), // filled below
    });
  }

  // ---- Favorites (top apps) — alternating [profileTag, containerID] ----
  // Arc stores one favorites container per profile. Match to spaces by profile tag.
  const topIds = Array.isArray(main.topAppsContainerIDs) ? main.topAppsContainerIDs : [];
  const favByProfile = []; // [{ profileKey, children }]
  for (let i = 0; i < topIds.length - 1; i++) {
    const profileTag = topIds[i];
    const cid = topIds[i + 1];
    if (typeof cid !== "string") continue;
    if (profileTag === null || typeof profileTag !== "object") continue;
    const kids = walkChildren(cid, itemMap, warnings);
    if (kids.length === 0) {
      i++;
      continue;
    }
    favByProfile.push({ profileKey: profileKeyOf(profileTag), children: kids });
    i++; // consume cid
  }

  // Attach matching favorites at the top of each space's children.
  for (const sp of spaces) {
    const spaceObj = spaceMap.get(sp.id);
    const key = profileKeyOf(spaceObj && spaceObj.profile);
    const match = favByProfile.find((f) => f.profileKey === key);
    if (match && match.children.length > 0) {
      sp.children.unshift({ kind: "folder", title: "Favorites", children: match.children });
    }
  }

  // Collect orphan favorites (profiles with no matching space — e.g., old machine IDs).
  const matchedKeys = new Set(spaces.map((sp) => profileKeyOf(spaceMap.get(sp.id)?.profile)));
  const orphanFavorites = favByProfile
    .filter((f) => !matchedKeys.has(f.profileKey))
    .flatMap((f) => f.children);

  // ---- Archive ----
  const orphanArchive = new Map(); // YYYY-MM -> Tab[]
  if (archiveJson && Array.isArray(archiveJson.items)) {
    const archMap = pairsToMap(archiveJson.items, warnings, "archive.items");

    // Bucket by space UUID
    const bySpace = new Map(); // uuid -> Array<{ tab, date }>
    const urlSeenBySpace = new Map(); // uuid -> Map<url, date>

    for (const [, entry] of archMap) {
      if (!entry || entry.reason !== "auto") continue;
      const sItem = entry.sidebarItem;
      const url = extractUrl(sItem);
      if (!url) continue;
      const title = cleanTitle(sItem) || url;
      const archivedAt = typeof entry.archivedAt === "number" ? entry.archivedAt : null;
      if (archivedAt == null) continue;
      const spaceUuid = entry.source && entry.source.space && entry.source.space._0;
      const tabRec = { url, title, archivedAt };

      const bucketKey = spaceUuid && spaceIdByUuid.has(spaceUuid) ? spaceUuid : "__orphan__";
      if (!bySpace.has(bucketKey)) bySpace.set(bucketKey, []);
      if (!urlSeenBySpace.has(bucketKey)) urlSeenBySpace.set(bucketKey, new Map());

      const seen = urlSeenBySpace.get(bucketKey);
      const prev = seen.get(url);
      if (prev == null || archivedAt > prev) {
        seen.set(url, archivedAt);
      }
      bySpace.get(bucketKey).push(tabRec);
    }

    // Keep only the latest archivedAt per URL per space bucket,
    // then group by YYYY-MM.
    for (const [bucketKey, tabs] of bySpace) {
      const seen = urlSeenBySpace.get(bucketKey);
      const kept = tabs.filter((t) => seen.get(t.url) === t.archivedAt);
      // In case two records tied on archivedAt, dedup by URL in final pass.
      const finalSeen = new Set();
      const finalKept = [];
      for (const t of kept) {
        if (finalSeen.has(t.url)) continue;
        finalSeen.add(t.url);
        finalKept.push(t);
      }

      const byMonth = new Map();
      for (const t of finalKept) {
        const key = yyyymm(appleToDate(t.archivedAt));
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push({
          kind: "tab",
          title: t.title,
          url: t.url,
          addDateUnix: Math.floor(t.archivedAt + APPLE_EPOCH_OFFSET),
        });
      }

      if (bucketKey === "__orphan__") {
        for (const [k, v] of byMonth) orphanArchive.set(k, v);
      } else {
        const sp = spaces[spaceIdByUuid.get(bucketKey)];
        sp.archivedByMonth = byMonth;
      }
    }
  }

  // Attach Archived/ subfolder per space (descending months).
  for (const sp of spaces) {
    if (sp.archivedByMonth.size === 0) continue;
    const months = [...sp.archivedByMonth.keys()].sort().reverse();
    sp.children.push({
      kind: "folder",
      title: "Archived",
      children: months.map((m) => ({
        kind: "folder",
        title: m,
        children: sp.archivedByMonth.get(m),
      })),
    });
    delete sp.archivedByMonth;
  }

  const orphanFolder = orphanArchive.size
    ? {
        kind: "folder",
        title: "Archived (orphan)",
        children: [...orphanArchive.keys()]
          .sort()
          .reverse()
          .map((m) => ({ kind: "folder", title: m, children: orphanArchive.get(m) })),
      }
    : null;

  return {
    orphanFavorites,
    spaces: spaces.map(({ archivedByMonth, ...rest }) => rest),
    orphanArchive: orphanFolder,
    warnings,
    stats: computeStats(orphanFavorites, spaces, orphanFolder),
  };
}

function filterByUrls(nodes, excludeUrls) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === "tab") {
      if (!excludeUrls.has(n.url)) out.push(n);
    } else if (n.kind === "folder") {
      const kids = filterByUrls(n.children, excludeUrls);
      if (kids.length > 0) out.push({ ...n, children: kids });
    }
  }
  return out;
}

function computeStats(favorites, spaces, orphan) {
  const countTabs = (nodes) => {
    let n = 0;
    for (const x of nodes) {
      if (x.kind === "tab") n++;
      else n += countTabs(x.children);
    }
    return n;
  };
  return {
    orphanFavorites: countTabs(favorites),
    spaces: spaces.length,
    perSpace: spaces.map((s) => ({
      title: s.title,
      emoji: s.emoji,
      tabs: countTabs(s.children),
    })),
    orphanArchive: orphan ? countTabs(orphan.children) : 0,
  };
}

const api = { parse, appleToDate, APPLE_EPOCH_OFFSET };
root.ArcEscapeParser = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
