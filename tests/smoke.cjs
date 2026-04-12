// Smoke test: run parser against real files and print stats.
// Usage: node tests/smoke.cjs <sidebar.json> [<archive.json>]
const { readFileSync } = require("node:fs");
const { parse } = require("../src/parser.js");
const { toBookmarksHtml } = require("../src/exporter.js");

const [, , sidebarPath, archivePath] = process.argv;
if (!sidebarPath) {
  console.error("Usage: node tests/smoke.cjs <sidebar.json> [<archive.json>]");
  process.exit(2);
}

const sidebar = JSON.parse(readFileSync(sidebarPath, "utf8"));
const archive = archivePath ? JSON.parse(readFileSync(archivePath, "utf8")) : null;

const tree = parse(sidebar, archive);
console.log("warnings:", tree.warnings.length);
for (const w of tree.warnings.slice(0, 10)) console.log("  -", w);

console.log("\n=== Stats ===");
console.log(JSON.stringify(tree.stats, null, 2));

const html = toBookmarksHtml(tree);
console.log("\nbookmarks.html bytes:", html.length);

const folderMatches = html.match(/<H3>/g) || [];
const tabMatches = html.match(/<A HREF=/g) || [];
console.log(`folders: ${folderMatches.length}, tabs: ${tabMatches.length}`);
