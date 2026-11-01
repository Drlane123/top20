"use strict";
// Pre-boot record-book restore (storage phase 2, owner Nov 1, 2026).
//
// server.js runs this synchronously BEFORE opening the database. Render's
// disk is wiped on every deploy, so on a fresh boot the local record book
// (data/top20.db) is missing — if cloud storage is configured and holds a
// snapshot, pull it down first and the site picks up exactly where it
// left off: profiles, songs, scores, charts, the owner's own settings.
//
// Rules:
//  - Local file present  -> do nothing (a plain restart keeps its disk,
//    and that copy is fresher than any snapshot).
//  - Storage not set up  -> do nothing (the site runs as it always has).
//  - No snapshot yet     -> do nothing (first boot seeds fresh, and the
//    running app takes the first snapshot shortly after it starts).
const fs = require("node:fs");
const path = require("node:path");
const storage = require("./storage");
const { DB_PATH } = require("./db");

(async () => {
  try {
    if (fs.existsSync(DB_PATH)) return;
    if (!storage.configured()) return;
    const buf = await storage.getObject("db/top20.db");
    if (buf && buf.length > 0) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, buf);
      console.log(`[restore] record book restored from storage (${buf.length} bytes)`);
    }
  } catch (e) {
    console.error("[restore] snapshot not restored:", e.message);
  }
})();
