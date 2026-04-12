// zip.js — minimal ZIP writer using STORE method (no compression).
// Good enough for bundling a handful of HTML files.
// Produces a single Blob from [{name, data: string|Uint8Array}, ...].
(function (root) {
"use strict";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  return new TextEncoder().encode(String(data));
}

function dosTime(d = new Date()) {
  const t =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dd =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time: t, date: dd };
}

function writeUint16(view, offset, value) { view.setUint16(offset, value, true); }
function writeUint32(view, offset, value) { view.setUint32(offset, value, true); }

function createZip(entries) {
  const now = dosTime();
  const fileRecords = []; // { localHeader, data, centralHeader }
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const size = data.length;

    // Local file header: 30 bytes + name
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    writeUint32(lv, 0, 0x04034b50);
    writeUint16(lv, 4, 20); // version
    writeUint16(lv, 6, 0);  // flags
    writeUint16(lv, 8, 0);  // method: STORE
    writeUint16(lv, 10, now.time);
    writeUint16(lv, 12, now.date);
    writeUint32(lv, 14, crc);
    writeUint32(lv, 18, size); // compressed
    writeUint32(lv, 22, size); // uncompressed
    writeUint16(lv, 26, nameBytes.length);
    writeUint16(lv, 28, 0);
    lh.set(nameBytes, 30);

    // Central directory header: 46 bytes + name
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    writeUint32(cv, 0, 0x02014b50);
    writeUint16(cv, 4, 20);
    writeUint16(cv, 6, 20);
    writeUint16(cv, 8, 0);
    writeUint16(cv, 10, 0);
    writeUint16(cv, 12, now.time);
    writeUint16(cv, 14, now.date);
    writeUint32(cv, 16, crc);
    writeUint32(cv, 20, size);
    writeUint32(cv, 24, size);
    writeUint16(cv, 28, nameBytes.length);
    writeUint16(cv, 30, 0);
    writeUint16(cv, 32, 0);
    writeUint16(cv, 34, 0);
    writeUint16(cv, 36, 0);
    writeUint32(cv, 38, 0);
    writeUint32(cv, 42, offset);
    ch.set(nameBytes, 46);

    fileRecords.push({ localHeader: lh, data, centralHeader: ch });
    offset += lh.length + data.length;
  }

  // End of central directory
  const centralStart = offset;
  const centralSize = fileRecords.reduce((s, r) => s + r.centralHeader.length, 0);
  offset += centralSize;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  writeUint32(ev, 0, 0x06054b50);
  writeUint16(ev, 4, 0);
  writeUint16(ev, 6, 0);
  writeUint16(ev, 8, fileRecords.length);
  writeUint16(ev, 10, fileRecords.length);
  writeUint32(ev, 12, centralSize);
  writeUint32(ev, 16, centralStart);
  writeUint16(ev, 20, 0);

  const parts = [];
  for (const r of fileRecords) parts.push(r.localHeader, r.data);
  for (const r of fileRecords) parts.push(r.centralHeader);
  parts.push(eocd);
  return new Blob(parts, { type: "application/zip" });
}

root.ArcEscapeZip = { createZip };
})(typeof globalThis !== "undefined" ? globalThis : this);
