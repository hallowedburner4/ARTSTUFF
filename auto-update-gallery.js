#!/usr/bin/env node
/* =================================================================
   auto-update-gallery.js   —  runs automatically in GitHub Actions

   What it does, on a schedule, with NObody touching any code:
     1. asks the Neocities API which files are in your art/ folder
     2. rebuilds art/gallery.json to match (newest first)
     3. uploads the new gallery.json back to your site
     4. keeps any titles / descriptions you set, and skips uploading
        when nothing changed

   So the artist just drops images into the Neocities art/ folder
   through the normal Neocities website, and the gallery catches up
   on its own a few minutes later.

   SECURITY: the API key is read from the NEOCITIES_API_KEY
   environment variable, which GitHub stores as an encrypted secret.
   It is never written into the site or into this file.

   Needs Node 18+ (built-in fetch / FormData / Blob).
   ================================================================= */
"use strict";

const API_ROOT = "https://neocities.org/api";
const IMAGE_RE = /^art\/[^/]+\.(png|jpe?g|webp|gif|avif)$/i;

function titleFromFilename(file) {
  return String(file)
    .split("/").pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function isValidDate(d) {
  return !!d && !Number.isNaN(Date.parse(d));
}

// Put each entry into the same canonical shape, so we can compare
// "what's live now" against "what it should be" reliably.
function canonical(item) {
  return {
    file: item.file,
    title: (item.title && String(item.title).trim()) || titleFromFilename(item.file || ""),
    description: typeof item.description === "string" ? item.description : "",
    date: isValidDate(item.date) ? item.date : null,
    width: item.width || null,
    height: item.height || null
  };
}

async function apiGet(path, key) {
  const res = await fetch(API_ROOT + path, {
    headers: { Authorization: "Bearer " + key }
  });
  if (!res.ok) throw new Error("GET " + path + " returned HTTP " + res.status +
                               " (is the API key correct?)");
  const data = await res.json();
  if (data && data.result === "error") {
    throw new Error("GET " + path + " error: " + (data.message || "unknown"));
  }
  return data;
}

async function main() {
  const key = process.env.NEOCITIES_API_KEY;
  if (!key) throw new Error("NEOCITIES_API_KEY is not set.");
  if (typeof fetch !== "function" || typeof FormData !== "function") {
    throw new Error("This needs Node 18 or newer.");
  }

  // 1. Which site is this, and what's its public address?
  const info = await apiGet("/info", key);
  const site = info && info.info ? info.info : {};
  const sitename = site.sitename;
  if (!sitename) throw new Error("Couldn't read the site name from /api/info.");
  const host = site.domain ? site.domain : sitename + ".neocities.org";

  // 2. List the image files inside art/
  const listing = await apiGet("/list", key);
  const files = Array.isArray(listing.files) ? listing.files : [];
  const artFiles = files.filter(f =>
    f && f.is_directory === false &&
    IMAGE_RE.test(f.path) &&
    !/^art\/_/.test(f.path)            // names starting with _ are skipped
  );

  // 3. Read the CURRENT gallery.json so we can keep titles/descriptions.
  //    IMPORTANT: if we can't read it for certain, we stop instead of
  //    risking overwriting hand-set titles with auto ones.
  const existing = new Map();
  let manifestKnown = false;
  try {
    const url = "https://" + host + "/art/gallery.json?nocache=" + Date.now();
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 404) {
      manifestKnown = true;                 // first run — nothing to preserve
    } else if (r.ok) {
      const data = JSON.parse(await r.text());
      const arr = Array.isArray(data) ? data : (data.images || []);
      arr.forEach(it => { if (it && it.file) existing.set(it.file, it); });
      manifestKnown = true;
    }
  } catch (e) {
    manifestKnown = false;
  }
  if (!manifestKnown) {
    console.log("Could not read the current gallery.json — skipping this run " +
                "so nothing gets overwritten. It'll try again next time.");
    return;
  }

  // 4. Build the new list, preserving anything already set.
  const images = artFiles.map(f => {
    const file = f.path.replace(/^art\//, "");
    const prev = existing.get(file) || {};
    let date = isValidDate(prev.date) ? prev.date : null;
    if (!date && isValidDate(f.updated_at)) {
      date = new Date(f.updated_at).toISOString().slice(0, 10);
    }
    return canonical({
      file,
      title: prev.title,
      description: prev.description,
      date,
      width: prev.width,
      height: prev.height
    });
  });

  images.sort((a, b) => {
    const da = isValidDate(a.date), db = isValidDate(b.date);
    if (da && db) { const d = Date.parse(b.date) - Date.parse(a.date); if (d) return d; }
    else if (da) { return -1; }
    else if (db) { return 1; }
    return a.title.localeCompare(b.title);
  });

  // 5. Has anything actually changed? If not, don't upload.
  const liveImages = Array.from(existing.values()).map(canonical);
  // (re-sort live the same way so order differences don't cause false diffs)
  liveImages.sort((a, b) => {
    const da = isValidDate(a.date), db = isValidDate(b.date);
    if (da && db) { const d = Date.parse(b.date) - Date.parse(a.date); if (d) return d; }
    else if (da) { return -1; }
    else if (db) { return 1; }
    return a.title.localeCompare(b.title);
  });
  if (JSON.stringify(images) === JSON.stringify(liveImages)) {
    console.log("No changes — " + images.length + " work(s) already up to date.");
    return;
  }

  // 6. Upload the refreshed gallery.json
  const out = {
    _comment: "Auto-generated from the live Neocities art/ folder by GitHub " +
              "Actions. Titles and descriptions you set are kept. New images " +
              "appear here automatically.",
    generated: new Date().toISOString(),
    images
  };
  const json = JSON.stringify(out, null, 2) + "\n";

  const form = new FormData();
  form.append("art/gallery.json", new Blob([json], { type: "application/json" }), "gallery.json");
  const up = await fetch(API_ROOT + "/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },   // let fetch set the multipart boundary
    body: form
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || upData.result === "error") {
    throw new Error("Upload failed (HTTP " + up.status + "): " + JSON.stringify(upData));
  }

  console.log("\u2713 Updated art/gallery.json on " + host + " with " +
              images.length + " work(s):");
  images.forEach((im, i) =>
    console.log("   " + String(i + 1).padStart(2, "0") + ". " + im.file + "  \u2192  " + im.title));
}

if (require.main === module) {
  main().catch(err => { console.error("\u2716 " + err.message); process.exit(1); });
}

module.exports = { main, titleFromFilename, canonical };
