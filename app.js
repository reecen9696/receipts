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
const money = (n) => n == null ? "" : Number(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const dayOf = (r) => r.receipt_date || r.created_at.slice(0, 10);
const niceDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
// Australian financial year: 1 July to 30 June. Returns the starting year.
const fyOf = (d) => { const [y, m] = d.split("-").map(Number); return m >= 7 ? y : y - 1; };
const isPdf = (r) => r.mime === "application/pdf";

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

const state = { user: null, receipts: [], thumbs: new Map(), signedAt: 0, pending: [] };

async function unlock(pin) {
  const { data, error } = await sb.auth.signInWithPassword({ email: "owner@house-moodboard.app", password: `house-moodboard-${pin}` });
  if (error) throw new Error("Wrong passcode");
  state.user = data.user;
}

async function load() {
  state.receipts = check(await sb.from("receipts").select("*")
    .order("receipt_date", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }));
  await signThumbs(state.receipts);
  state.signedAt = Date.now();
}

async function signThumbs(rows) {
  const paths = rows.map((r) => r.thumb_path || (!isPdf(r) && r.file_path)).filter(Boolean);
  if (!paths.length) return;
  for (const s of check(await sb.storage.from(BUCKET).createSignedUrls(paths, SIGN_FOR))) if (s.signedUrl) state.thumbs.set(s.path, s.signedUrl);
}
const thumbUrl = (r) => state.thumbs.get(r.thumb_path) || (!isPdf(r) && state.thumbs.get(r.file_path));
const fileUrl = async (r) => check(await sb.storage.from(BUCKET).createSignedUrl(r.file_path, SIGN_FOR)).signedUrl;

/* ---------------- adding ---------------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't read ${file.name}`)); };
    img.src = url;
  });
}
function toJpeg(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", quality));
}

// The original is kept as it is (it's the record the ATO wants); HEIC becomes a full-size JPEG so every browser can show it.
async function prepare(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return { full: file, mime: "application/pdf", ext: "pdf", thumb: null };
  const img = await loadImage(file);
  const native = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
  const full = native ? file : await toJpeg(img, 99999, 0.95);
  return { full, mime: native ? file.type : "image/jpeg", ext: native || "jpg", thumb: await toJpeg(img, 600, 0.82) };
}

async function addFiles(files) {
  const placeholders = files.map((f) => ({ id: `pending-${crypto.randomUUID()}`, created_at: new Date().toISOString(), merchant: "Uploading…", pending: true, file_name: f.name }));
  state.pending.push(...placeholders);
  render();
  const added = [];
  for (const [i, file] of files.entries()) {
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
      added.push(row);
    } catch (e) {
      toast(`Couldn't add ${file.name}: ${e.message}`);
    }
    state.pending = state.pending.filter((p) => p !== placeholders[i]);
    render();
  }
  if (!added.length) return;
  haptic("success");
  // One receipt: open it so the store and amount can go in while it's in your hand
  if (added.length === 1) openReceipt(added[0].id);
  else toast(`${added.length} receipts saved`);
}

/* ---------------- list ---------------- */

function card(r) {
  const thumb = r.pending ? null : thumbUrl(r);
  const sub = r.pending ? esc(r.file_name) : [niceDate(dayOf(r)), money(r.amount)].filter(Boolean).join(" · ");
  return `<button class="card${r.pending ? " pending" : ""}" data-id="${r.id}">
    <div class="pic">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" onload="this.classList.add('loaded')">` : r.pending ? "" : ICON.doc}
      ${!r.pending && isPdf(r) ? `<span class="kind">PDF</span>` : ""}</div>
    <div class="meta"><b>${esc(r.merchant || "Receipt")}</b><small>${sub}</small></div>
  </button>`;
}

function render() {
  const all = state.receipts;
  const groups = new Map();
  for (const r of all) { const fy = fyOf(dayOf(r)); (groups.get(fy) || groups.set(fy, []).get(fy)).push(r); }
  const total = (rows) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const thisFy = fyOf(new Date().toLocaleDateString("en-CA"));
  const pending = state.pending.length ? `<div class="grid">${state.pending.map(card).join("")}</div>` : "";

  $("#view").innerHTML = `
    <h1 class="title">Receipts</h1>
    <p class="sub">${all.length ? `${all.length} saved · ${money(total(groups.get(thisFy) || []))} this financial year` : "For tax time"}</p>
    ${pending}
    ${!all.length && !state.pending.length ? `<div class="empty"><b>No receipts yet</b>Tap Add receipt to snap one.</div>` : ""}
    ${[...groups].map(([fy, rows]) => `
      <div class="fy"><h2>FY ${fy}–${String(fy + 1).slice(2)}</h2><span>${money(total(rows))}</span></div>
      <div class="grid">${rows.map(card).join("")}</div>`).join("")}`;
}

/* ---------------- one receipt ---------------- */

function closeSheet() { $("#sheet").hidden = true; $("#backdrop").hidden = true; $("#sheet").innerHTML = ""; }

async function openReceipt(id) {
  const r = state.receipts.find((x) => x.id === id);
  if (!r) return;
  const sheet = $("#sheet");
  const thumb = thumbUrl(r);
  sheet.innerHTML = `
    <div class="grab"></div>
    <div class="head"><h3>${esc(r.merchant || "Receipt")}</h3><button class="round" data-act="close" aria-label="Close">${ICON.close}</button></div>
    ${isPdf(r)
      ? `<a class="preview doc" target="_blank" rel="noopener">${thumb ? `<img src="${esc(thumb)}" alt="">` : ICON.doc}<span>${esc(r.file_name || "Receipt.pdf")}</span></a>`
      : `<a class="preview" target="_blank" rel="noopener"><img src="${esc(thumb || "")}" alt="Receipt"></a>`}
    <form class="fields" autocomplete="off">
      <label class="wide">Store<input name="merchant" value="${esc(r.merchant)}" placeholder="e.g. Officeworks"></label>
      <label>Amount<input name="amount" inputmode="decimal" value="${r.amount ?? ""}" placeholder="$0.00"></label>
      <label>Date<input name="receipt_date" type="date" value="${dayOf(r)}"></label>
      <label class="wide">Note<textarea name="note" placeholder="What it was for">${esc(r.note)}</textarea></label>
    </form>
    <div class="actions">
      <a data-act="open" target="_blank" rel="noopener">${ICON.open}Open</a>
      <button class="danger" data-act="delete">${ICON.trash}Delete</button>
    </div>`;
  sheet.hidden = false; $("#backdrop").hidden = false;

  // full-size file behind a fresh signed link
  fileUrl(r).then((url) => {
    sheet.querySelectorAll("a.preview, a[data-act=open]").forEach((a) => (a.href = url));
    if (!isPdf(r)) $(".preview img", sheet).src = url;
  }).catch((e) => toast(e.message));

  const form = $("form", sheet);
  form.onsubmit = (e) => e.preventDefault();
  form.onchange = async (e) => {
    const { name, value } = e.target;
    let v = value.trim() || null;
    if (name === "amount" && v) {
      v = Number(v.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(v)) return toast("Amount should be a number");
      e.target.value = v.toFixed(2);
    }
    try {
      Object.assign(r, check(await sb.from("receipts").update({ [name]: v }).eq("id", r.id).select().single()));
      if (name === "merchant") $(".head h3", sheet).textContent = r.merchant || "Receipt";
      render();
    } catch (err) { toast(`Couldn't save: ${err.message}`); }
  };

  sheet.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeSheet();
    if (act === "delete") {
      const btn = e.target.closest("button");
      if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.lastChild.textContent = "Tap to delete"; return; }
      try {
        await sb.storage.from(BUCKET).remove([r.file_path, r.thumb_path].filter(Boolean));
        check(await sb.from("receipts").delete().eq("id", r.id));
        state.receipts = state.receipts.filter((x) => x !== r);
        haptic("success"); closeSheet(); render(); toast("Receipt deleted");
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
  $("#files").onchange = (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) addFiles(files); };
  $("#view").onclick = (e) => { const c = e.target.closest(".card:not(.pending)"); if (c) openReceipt(c.dataset.id); };
  $("#backdrop").onclick = closeSheet;
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
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
