// app.js — wires the UI
const { parse } = globalThis.ArcEscapeParser;
const { toBookmarksHtml, toBookmarksHtmlForSpace, filenameForSpace } = globalThis.ArcEscapeExporter;

const $ = (sel) => document.querySelector(sel);

const state = {
  sidebar: null,
  archive: null,
};

function status(msg, kind = "info") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status status--${kind}`;
}

function readFileAsJson(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.onload = () => {
      try {
        resolve(JSON.parse(r.result));
      } catch (e) {
        reject(e);
      }
    };
    r.readAsText(file);
  });
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    try {
      const data = await readFileAsJson(file);
      if (data && data.sidebar) {
        state.sidebar = data;
        $("#sidebar-filename").textContent = file.name;
      } else if (data && Array.isArray(data.items) && data.items.some((x) => x && typeof x === "object" && x.sidebarItem)) {
        state.archive = data;
        $("#archive-filename").textContent = file.name;
      } else if (file.name.toLowerCase().includes("archive")) {
        state.archive = data;
        $("#archive-filename").textContent = file.name;
      } else {
        state.sidebar = data;
        $("#sidebar-filename").textContent = file.name;
      }
    } catch (err) {
      status(`Failed to parse ${file.name}: ${err.message}`, "error");
      return;
    }
  }

  if (!state.sidebar) {
    status("Waiting for StorableSidebar.json", "info");
    return;
  }

  try {
    const tree = parse(state.sidebar, state.archive);
    renderPreview(tree);
    $("#export-btn").disabled = false;
    $("#export-btn").onclick = () => doExport(toBookmarksHtml(tree), "arc-bookmarks.html");
    $("#export-all-btn").disabled = false;
    $("#export-all-btn").onclick = () => doExportAll(tree);
    renderPerSpaceButtons(tree);
    status("Ready to export", "ok");
  } catch (err) {
    status(`Parse error: ${err.message}`, "error");
    console.error(err);
  }
}

function renderPreview(tree) {
  const s = tree.stats;
  const lines = [];
  lines.push(`<strong>${s.spaces}</strong> spaces`);
  for (const sp of s.perSpace) {
    const emoji = sp.emoji ? `${escape(sp.emoji)} ` : "";
    lines.push(`&nbsp;&nbsp;${emoji}${escape(sp.title)}: <strong>${sp.tabs}</strong> tabs`);
  }
  if (s.orphanFavorites) lines.push(`<strong>${s.orphanFavorites}</strong> orphan favorites`);
  if (s.orphanArchive) lines.push(`<strong>${s.orphanArchive}</strong> orphan archived tabs`);
  $("#preview").innerHTML = lines.join("<br>");

  const w = tree.warnings || [];
  const wEl = $("#warnings");
  if (w.length === 0) {
    wEl.hidden = true;
  } else {
    wEl.hidden = false;
    wEl.innerHTML = `<summary>Warnings (${w.length})</summary><pre>${escape(w.join("\n"))}</pre>`;
  }
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function doExport(html, filename) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doExportAll(tree) {
  const entries = [
    { name: "arc-bookmarks.html", data: toBookmarksHtml(tree) },
  ];
  for (const sp of tree.spaces) {
    entries.push({ name: filenameForSpace(sp), data: toBookmarksHtmlForSpace(sp) });
  }
  const blob = globalThis.ArcEscapeZip.createZip(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "arc-export.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(`Downloaded arc-export.zip (${entries.length} files).`, "ok");
}

function renderPerSpaceButtons(tree) {
  const host = $("#per-space");
  const wrap = $("#per-space-wrap");
  host.innerHTML = "";
  for (const sp of tree.spaces) {
    const btn = document.createElement("button");
    btn.className = "btn-small";
    const emoji = sp.emoji ? `${sp.emoji} ` : "";
    btn.textContent = `${emoji}${sp.title}`;
    btn.onclick = () => doExport(toBookmarksHtmlForSpace(sp), filenameForSpace(sp));
    host.appendChild(btn);
  }
  if (wrap) wrap.hidden = tree.spaces.length === 0;
}

function wire() {
  const pick = $("#file-input");
  pick.addEventListener("change", (e) => handleFiles([...e.target.files]));

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("is-hover");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("is-hover");
    }),
  );
  drop.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) handleFiles(files);
  });

  // Radial hover highlight follows cursor on the drop zone.
  drop.addEventListener("mousemove", (e) => {
    const r = drop.getBoundingClientRect();
    drop.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
    drop.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
  });
}

wire();
status("Drop both JSON files to begin.", "info");
