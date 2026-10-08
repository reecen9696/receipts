import { config } from "./config.js";
import { haptic, installButtonHaptics } from "./haptics.js";

/* ---------------- helpers ---------------- */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
  close: svg("M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"),
  trash: svg("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"),
  doc: svg("M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"),
  open: svg("M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"),
};
const isPdf = (r) => r.mime === "application/pdf";
const added = (r) => new Date(r.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------------- data (Supabase, same project and passcode account as the house moodboard) ---------------- */

const BUCKET = "receipts";
const SIGN_FOR = 3600; // seconds a signed file link stays valid
const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
const sb = createClient(config.supabaseUrl, config.supabaseAnonKey);
const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const state = { user: null, receipts: [], claims: [], thumbs: new Map(), signedAt: 0, pending: 0, tab: location.hash === "#claims" ? "claims" : "receipts" };

async function unlock(pin) {
  const { data, error } = await sb.auth.signInWithPassword({ email: "owner@house-moodboard.app", password: `house-moodboard-${pin}` });
  if (error) throw new Error("Wrong passcode");
  state.user = data.user;
}

async function load() {
  [state.receipts, state.claims] = await Promise.all([
    sb.from("receipts").select("*").order("created_at", { ascending: false }).then(check),
    sb.from("claims").select("*").order("created_at", { ascending: true }).then(check),
  ]);
  const paths = state.receipts.map((r) => r.thumb_path || (!isPdf(r) && r.file_path)).filter(Boolean);
  if (paths.length) for (const s of check(await sb.storage.from(BUCKET).createSignedUrls(paths, SIGN_FOR))) if (s.signedUrl) state.thumbs.set(s.path, s.signedUrl);
  state.signedAt = Date.now();
}
const thumbUrl = (r) => state.thumbs.get(r.thumb_path) || (!isPdf(r) && state.thumbs.get(r.file_path));
const fileUrl = async (r) => check(await sb.storage.from(BUCKET).createSignedUrl(r.file_path, SIGN_FOR)).signedUrl;

/* ---------------- adding ---------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that file"));
    img.src = src;
  });
}
function toJpeg(source, w, h, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", quality));
}

// First page of a PDF as an image, with pdf.js (loaded only when a PDF is added)
async function pdfThumb(file) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.append(s);
    });
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 600 / page.getViewport({ scale: 1 }).width });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.82));
}

// The original is kept as it is; HEIC becomes a full-size JPEG so every browser can show it. Plus a 600px preview.
async function prepare(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return { full: file, mime: "application/pdf", ext: "pdf", thumb: await pdfThumb(file).catch(() => null) };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { naturalWidth: w, naturalHeight: h } = img;
    const native = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
    const full = native ? file : await toJpeg(img, w, h, 99999, 0.95);
    return { full, mime: native ? file.type : "image/jpeg", ext: native || "jpg", thumb: await toJpeg(img, w, h, 600, 0.82) };
  } finally { URL.revokeObjectURL(url); }
}

async function addFiles(files) {
  state.pending += files.length;
  render();
  let ok = 0;
  for (const file of files) {
    try {
      const { full, mime, ext, thumb } = await prepare(file);
      const id = crypto.randomUUID(), dir = state.user.id;
      const file_path = `${dir}/${id}.${ext}`, thumb_path = thumb ? `${dir}/${id}_t.jpg` : null;
      await Promise.all([
        sb.storage.from(BUCKET).upload(file_path, full, { contentType: mime, upsert: false }).then(check),
        thumb && sb.storage.from(BUCKET).upload(thumb_path, thumb, { contentType: "image/jpeg", upsert: false }).then(check),
      ]);
      const row = check(await sb.from("receipts").insert({ id, file_path, thumb_path, file_name: file.name, mime }).select().single());
      if (thumb) state.thumbs.set(thumb_path, URL.createObjectURL(thumb)); // show it straight away, no signing round trip
      state.receipts.unshift(row);
      ok++;
    } catch (e) {
      toast(`Couldn't add ${file.name}: ${e.message}`);
    }
    state.pending--;
    render();
  }
  if (ok) { haptic("success"); toast(ok === 1 ? "Saved" : `${ok} saved`); }
}

/* ---------------- grid ---------------- */

function tile(r) {
  const thumb = thumbUrl(r);
  return `<button class="tile" data-id="${r.id}" aria-label="Receipt added ${added(r)}">
    ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" onload="this.classList.add('loaded')">` : ICON.doc}
    ${isPdf(r) ? `<span class="kind">PDF</span>` : ""}
  </button>`;
}

function render() {
  const claims = state.tab === "claims";
  $("#add").hidden = claims; $("#line").hidden = !claims;
  const tabs = `<div class="tabs" role="tablist">
    <button role="tab" data-tab="receipts" aria-selected="${!claims}">Receipts</button>
    <button role="tab" data-tab="claims" aria-selected="${claims}">To claim</button>
  </div>`;
  $("#view").innerHTML = `<h1 class="title">${claims ? "To claim" : "Receipts"}</h1>${tabs}${claims ? claimsView() : receiptsView()}`;
}

function receiptsView() {
  const n = state.receipts.length;
  return `<p class="sub">${n ? `${n} saved` : "Snap a receipt to keep it"}</p>
    ${!n && !state.pending ? `<div class="empty"><b>No receipts yet</b>Tap Add receipts to get started.</div>` : ""}
    <div class="grid">${`<div class="tile pending"></div>`.repeat(state.pending)}${state.receipts.map(tile).join("")}</div>`;
}

/* ---------------- to claim: one line per thing you remember ---------------- */

function claimsView() {
  if (!state.claims.length) return `<div class="empty"><b>Nothing yet</b>Write down anything you remember you can claim, one line at a time.</div>`;
  return `<ul class="claims">${state.claims.map((c) => `<li data-id="${c.id}"><span>${esc(c.body)}</span><button data-act="del" aria-label="Delete">${ICON.close}</button></li>`).join("")}</ul>`;
}

async function addClaim(body) {
  const temp = { id: `temp-${crypto.randomUUID()}`, body };
  state.claims.push(temp);
  render();
  $("#main").scrollTo({ top: $("#main").scrollHeight, behavior: "smooth" });
  try {
    Object.assign(temp, check(await sb.from("claims").insert({ body }).select().single()));
    render();
  } catch (e) {
    state.claims = state.claims.filter((c) => c !== temp); render();
    $("#line").body.value = body; // give the text back so nothing is lost
    toast(`Couldn't save: ${e.message}`);
  }
}

async function deleteClaim(btn) {
  if (!btn.classList.contains("armed")) {
    document.querySelectorAll(".claims .armed").forEach((b) => { b.classList.remove("armed"); b.innerHTML = ICON.close; });
    btn.classList.add("armed"); btn.textContent = "Delete"; return;
  }
  const c = state.claims.find((x) => x.id === btn.closest("li").dataset.id);
  if (!c || c.id.startsWith("temp-")) return;
  state.claims = state.claims.filter((x) => x !== c); render(); haptic("success");
  try { check(await sb.from("claims").delete().eq("id", c.id)); }
  catch (e) { state.claims.push(c); state.claims.sort((a, b) => a.created_at.localeCompare(b.created_at)); render(); toast(`Couldn't delete: ${e.message}`); }
}

/* ---------------- viewer ---------------- */

function closeViewer() { const v = $("#viewer"); v.hidden = true; v.innerHTML = ""; }

function openReceipt(id) {
  const r = state.receipts.find((x) => x.id === id);
  if (!r) return;
  const v = $("#viewer");
  const thumb = thumbUrl(r);
  v.innerHTML = `
    <div class="top">
      <button class="round" data-act="close" aria-label="Close">${ICON.close}</button>
      <span>${added(r)}</span>
      <button class="round" data-act="delete" aria-label="Delete">${ICON.trash}</button>
    </div>
    <div class="stage">${thumb ? `<img src="${esc(thumb)}" alt="Receipt">` : ICON.doc}</div>
    ${isPdf(r) ? `<a class="pill" data-act="open" target="_blank" rel="noopener">${ICON.open}Open PDF</a>` : ""}`;
  v.hidden = false;

  // full-size photo (or the PDF) behind a fresh signed link
  fileUrl(r).then((url) => {
    if (isPdf(r)) $("[data-act=open]", v).href = url;
    else $(".stage img", v).src = url;
  }).catch((e) => toast(e.message));

  v.onclick = async (e) => {
    const btn = e.target.closest("[data-act]");
    const act = btn?.dataset.act;
    if (act === "close" || e.target.classList.contains("stage")) closeViewer();
    if (act === "delete") {
      if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.innerHTML = "Delete"; return; }
      try {
        await sb.storage.from(BUCKET).remove([r.file_path, r.thumb_path].filter(Boolean));
        check(await sb.from("receipts").delete().eq("id", r.id));
        state.receipts = state.receipts.filter((x) => x !== r);
        haptic("success"); closeViewer(); render(); toast("Deleted");
      } catch (err) { toast(`Couldn't delete: ${err.message}`); }
    }
  };
}

/* ---------------- boot ---------------- */

function showLogin() {
  const el = $("#login");
  el.hidden = false;
  el.innerHTML = `<form autocomplete="off">
    <h1>Receipts</h1>
    <p class="hint">Enter passcode</p>
    <label class="pin">
      <input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" aria-label="Passcode">
      <span></span><span></span><span></span><span></span>
    </label>
    <p class="err"></p>
  </form>`;
  const form = $("form", el), input = form.pin, boxes = [...el.querySelectorAll(".pin span")];
  let busy = false;
  const paint = () => boxes.forEach((b, i) => { b.classList.toggle("on", i < input.value.length); b.classList.toggle("at", i === Math.min(input.value.length, 3) && !busy); });
  input.oninput = async () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    $(".err", el).textContent = "";
    paint();
    if (input.value.length < 4 || busy) return;
    busy = true; paint();
    try {
      await unlock(input.value);
      el.hidden = true;
      start();
    } catch (e) {
      $(".err", el).textContent = e.message;
      form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
      input.value = "";
    }
    busy = false; paint();
  };
  form.onsubmit = (e) => e.preventDefault();
  el.onclick = () => input.focus();
  paint(); input.focus();
}

async function start() {
  render();
  try { await load(); } catch (e) { toast(`Couldn't load receipts: ${e.message}`); }
  render();
}

function bindEvents() {
  installButtonHaptics();
  const menu = (open) => { $("#menu").hidden = !open; $("#backdrop").hidden = !open; };
  $("#add").onclick = () => menu(true);
  $("#backdrop").onclick = () => menu(false);
  for (const input of document.querySelectorAll("input[type=file]")) {
    input.onclick = () => menu(false);
    input.onchange = () => { const files = [...input.files]; input.value = ""; if (files.length) addFiles(files); };
  }
  $("#view").onclick = (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; history.replaceState(null, "", state.tab === "claims" ? "#claims" : location.pathname); render(); return; }
    const del = e.target.closest("[data-act=del]");
    if (del) return deleteClaim(del);
    const t = e.target.closest(".tile:not(.pending)"); if (t) openReceipt(t.dataset.id);
  };
  $("#line").onsubmit = (e) => {
    e.preventDefault();
    const input = e.target.body, body = input.value.trim();
    if (!body) return;
    input.value = ""; input.focus(); // keyboard stays up for the next line
    addClaim(body);
  };
  addEventListener("keydown", (e) => { if (e.key === "Escape") { closeViewer(); menu(false); } });
  // signed links last an hour; coming back to the app later gets fresh ones
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user && Date.now() - state.signedAt > (SIGN_FOR - 300) * 1000) load().then(render).catch(() => {});
  });
}

bindEvents();
const { data: { session } } = await sb.auth.getSession();
state.user = session?.user || null;
if (state.user) start(); else showLogin();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
