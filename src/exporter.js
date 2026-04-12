// exporter.js — ExportTree → Netscape bookmark HTML
// Pure function, no DOM.
(function (root) {
"use strict";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Only export URLs with safe schemes. Blocks javascript:, data:, vbscript:,
// and similar that could run code when a bookmark is clicked after import.
const SAFE_URL_SCHEMES = /^(https?|ftp|file|mailto|tel):/i;
function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  // Protocol-relative URLs are fine (//example.com/...); schemeless relative also fine.
  if (trimmed.startsWith("//") || /^[^:]*\//.test(trimmed) && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return true;
  }
  return SAFE_URL_SCHEMES.test(trimmed);
}

function renderFolder(title, children, indent) {
  const pad = "    ".repeat(indent);
  const inner = "    ".repeat(indent + 1);
  const lines = [];
  lines.push(`${pad}<DT><H3>${escapeHtml(title)}</H3>`);
  lines.push(`${pad}<DL><p>`);
  for (const node of children) {
    if (node.kind === "tab") {
      if (!isSafeUrl(node.url)) continue; // drop unsafe scheme URLs silently
      const attrs = [`HREF="${escapeHtml(node.url)}"`];
      if (typeof node.addDateUnix === "number") attrs.push(`ADD_DATE="${node.addDateUnix}"`);
      lines.push(`${inner}<DT><A ${attrs.join(" ")}>${escapeHtml(node.title || node.url)}</A>`);
    } else {
      lines.push(renderFolder(node.title, node.children, indent + 1));
    }
  }
  lines.push(`${pad}</DL><p>`);
  return lines.join("\n");
}

function spaceDisplayTitle(sp) {
  return sp.emoji ? `${sp.emoji} ${sp.title}` : sp.title;
}

function wrapHtml(body) {
  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    body,
    "</DL><p>",
    "",
  ].join("\n");
}

// Full tree → combined HTML file.
function toBookmarksHtml(tree) {
  const root = [];
  for (const sp of tree.spaces) {
    root.push({ kind: "folder", title: spaceDisplayTitle(sp), children: sp.children });
  }
  if (tree.orphanFavorites && tree.orphanFavorites.length > 0) {
    root.push({ kind: "folder", title: "Favorites (orphan)", children: tree.orphanFavorites });
  }
  if (tree.orphanArchive) root.push(tree.orphanArchive);
  return wrapHtml(renderFolder("Arc Export", root, 0));
}

// One space → standalone HTML file.
function toBookmarksHtmlForSpace(space) {
  return wrapHtml(renderFolder(spaceDisplayTitle(space), space.children, 0));
}

// Suggest a safe filename for a given space.
function filenameForSpace(space) {
  const base = (space.title || "space").replace(/[^\w\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `arc-${base || "space"}.html`;
}

const api = { toBookmarksHtml, toBookmarksHtmlForSpace, filenameForSpace };
root.ArcEscapeExporter = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
