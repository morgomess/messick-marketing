var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// mm-ai-proxy-worker.js
var AIRTABLE_BASE = "appLm4Zgt3H2vxKdj";
var TBL_BRIEF = "tbllmnoa802Vp3Fwu";
var TBL_GENERATED = "tblmuO1jm0DduY1zP";
var BRAND_BRAIN = "tbl7pjvjhQl7U1OPe";
var TBL_INBOX = "tblTKxhO77Uqh3BVY";
var INTAKE_BATCH = 5;
var MODEL_PRIMARY = "claude-sonnet-4-6";
var MODEL_FALLBACK = "claude-haiku-4-5-20251001";
var CYCLE_BATCH = 5;
var IMAGE_TYPES = /* @__PURE__ */ new Set(["Social Post"]);
var REEL_STORYBOARD_FRAMES = 0;
var PIN_W = 1e3;
var PIN_H = 1500;
var FEED_W = 1080;
var FEED_H = 1350;
async function callClaude(env, { system, prompt, model = MODEL_PRIMARY, max_tokens = 4096 }) {
  const body = {
    model,
    max_tokens,
    messages: [{ role: "user", content: prompt }]
  };
  if (system) body.system = system;
  let res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if ((res.status === 429 || res.status === 529) && model !== MODEL_FALLBACK) {
    return callClaude(env, { system, prompt, model: MODEL_FALLBACK, max_tokens });
  }
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
__name(callClaude, "callClaude");
function stripMarkdown(input) {
  if (!input) return input;
  let t = String(input).replace(/\r\n/g, "\n");
  t = t.replace(/```[a-zA-Z0-9]*\n?/g, "");
  t = t.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");
  t = t.replace(/^#{1,6}[ \t]+/gm, "");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  t = t.replace(/^>[ \t]?/gm, "");
  t = t.replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ");
  t = t.replace(/[—–]/g, "-");
  t = t.replace(/-{2,}/g, "-");
  t = t.replace(/[ \t]+$/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
__name(stripMarkdown, "stripMarkdown");
var GEMINI_IMG_MODEL_TEXT = "gemini-3-pro-image-preview";
var GEMINI_IMG_MODEL_VISUAL = "gemini-3.1-flash-image-preview";
function geminiImageModel(env, tier) {
  return tier === "text-critical" ? env.GEMINI_IMAGE_MODEL_TEXT || GEMINI_IMG_MODEL_TEXT : env.GEMINI_IMAGE_MODEL_VISUAL || GEMINI_IMG_MODEL_VISUAL;
}
__name(geminiImageModel, "geminiImageModel");
function extractGeminiImageB64(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && typeof inline.data === "string" && inline.data) return inline.data;
  }
  return null;
}
__name(extractGeminiImageB64, "extractGeminiImageB64");
async function generateImage(env, prompt, aspectRatio = "3:4", tier = "visual") {
  const model = geminiImageModel(env, tier);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio } }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini image ${res.status} (${model}): ${data.error?.message || "error"}`);
  const b64 = extractGeminiImageB64(data);
  if (!b64) {
    const note = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(`Gemini (${model}) returned no image data${note ? `: ${note.slice(0, 180)}` : ""}`);
  }
  return b64;
}
__name(generateImage, "generateImage");
function classifySlideType(f) {
  const raw = f["Slide Type"];
  const explicit = raw && (raw.name || raw);
  if (explicit) {
    const v = String(explicit).toLowerCase();
    if (v.includes("text")) return "text-critical";
    if (v.includes("visual")) return "visual";
  }
  const hay = [f["Title"], f["Angle/Hook"], f["Notes"], f["Image Prompt"]].filter(Boolean).map(String).join("\n");
  const h = hay.toLowerCase();
  if (/overlay text\s*:/.test(h)) return "text-critical";
  if (/[""].{5,}[""]/.test(hay) || /"[^"]{5,}"/.test(hay)) return "text-critical";
  if (/\d{1,3}\s?%/.test(hay)) return "text-critical";
  if (/\d+\s*(?:in|out of)\s*\d+/i.test(hay)) return "text-critical";
  if (/\bstat(?:istic)?s?\b/.test(h)) return "text-critical";
  return "visual";
}
__name(classifySlideType, "classifySlideType");
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
__name(b64ToBytes, "b64ToBytes");
async function uploadImageToR2(env, b64, keyHint = "img") {
  const key = `aios/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${keyHint}.png`;
  await env.MM_MEDIA.put(key, b64ToBytes(b64), {
    httpMetadata: { contentType: "image/png" }
  });
  const base = (env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
  return `${base}/${key}`;
}
__name(uploadImageToR2, "uploadImageToR2");
function buildImagePrompt(f, brand, variant) {
  const custom = f["Image Prompt"];
  if (custom && String(custom).trim()) return String(custom).trim();
  const subject = cleanHeadline(f["Title"]) || "the topic";
  const art = brand && brand["Art Direction"] && String(brand["Art Direction"]).trim() || "a clean, modern editorial photograph with soft natural light";
  return assembleImagePrompt({
    scene: `Photorealistic photograph representing "${subject}". Natural lighting, a realistic real-world setting, shallow depth of field.`,
    art,
    shot: null,
    zone: ZONE_INSTRUCTION[variant && variant.zone || "top"] || ZONE_INSTRUCTION.top,
    orientation: (variant && variant.zone) === "landscape" ? "horizontal landscape orientation" : "vertical portrait orientation"
  });
}
__name(buildImagePrompt, "buildImagePrompt");
function humanImagePrompt(rawFields) {
  const v = rawFields && rawFields["Image Prompt"];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}
__name(humanImagePrompt, "humanImagePrompt");
async function resolveImagePrompt(env, f, brand, caption, variant, ordinal, phaseSeed, rawFields) {
  const human = humanImagePrompt(rawFields);
  if (human) return human;
  const zone = ZONE_INSTRUCTION[variant && variant.zone || "top"] || ZONE_INSTRUCTION.top;
  const orientation = (variant && variant.zone) === "landscape" ? "horizontal landscape orientation" : "vertical portrait orientation";
  const art = brand && brand["Art Direction"] && String(brand["Art Direction"]).trim() || "a clean, modern editorial photograph with soft natural light";
  const shot = rotationEnabled(brand) ? rotationPick(PHOTO_TREATMENTS, ordinal, "photo", phaseSeed) || PHOTO_TREATMENTS[0] : null;
  const system = `You describe ONE photographic SCENE for a text-to-image model. The image sits BEHIND a social post headline, so it is visual-only.
Return ONLY the scene description, two or three sentences, as a single paragraph. No preamble, no quotes, no explanation.
Describe WHAT IS IN FRAME and nothing else: the people, objects, room, surfaces and light. Do NOT write instructions about orientation, composition, text, framing or style - those are added separately and anything you write about them is discarded.
The scene must be a LITERAL, realistic depiction of the real people, tools, workspace or setting the post is about. No visual metaphors, symbols, mascots, mythical figures or abstract concept art: a post about SEO shows a person at a computer, never a wizard. Favor one clear focal subject over clutter.
${shot ? `The scene must be built around this shot type, which is not negotiable: ${shot}.
` : ""}It must also fit this art direction, which constrains who and what may appear:
${art}`;
  const user = `Brand: ${brand ? brand["Account Name"] || "" : ""}
Post title: ${f["Title"] || ""}
Audience: ${f["Target Audience"] || ""}
Caption:
${caption || ""}`;
  let scene = String(f["Image Prompt"] || "").trim();
  if (!scene) {
    try {
      scene = stripMarkdown(await callClaude(env, { system, prompt: user, max_tokens: 400 })).replace(/^["']+|["']+$/g, "").trim();
    } catch (e) {
      console.log("AIOS image-prompt gen failed for", f["Title"], String(e));
    }
  }
  if (!scene) return buildImagePrompt(f, brand, variant);
  return assembleImagePrompt({ scene, art, shot, zone, orientation });
}
__name(resolveImagePrompt, "resolveImagePrompt");
var NO_TEXT_RULE = "Absolutely NO text, letters, numbers, words, captions, handwriting, signage, logos or watermarks anywhere in the image. Any screen, whiteboard, notebook, document or label in frame must be blank, turned away from camera, or thrown far enough out of focus that nothing on it is legible.";
function assembleImagePrompt({ scene, art, shot, zone, orientation }) {
  return [
    scene,
    // The scene text often carries its own framing claims - an auto-generated Image Prompt
    // typically ends "Vertical 2:3 portrait, top third clear" - which contradicts whatever
    // layout the rotation picked. Neutralise them before the authoritative rules land.
    "Disregard any orientation, aspect ratio, cropping or framing instruction in the description above; the framing rules below are authoritative.",
    shot ? `Shot type, which is not negotiable: ${shot}.` : "",
    `Art direction, which overrides anything above that conflicts with it: ${art}`,
    NO_TEXT_RULE,
    `${orientation.charAt(0).toUpperCase()}${orientation.slice(1)}.`,
    zone
  ].filter(Boolean).join(" ");
}
__name(assembleImagePrompt, "assembleImagePrompt");
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
__name(escapeHtml, "escapeHtml");
function cleanHeadline(title) {
  return String(title || "").replace(/^\s*\[[^\]]*\]\s*/, "").replace(/^\s*(pin|short|reel|blog|post|linkedin|social)\s*[:\-]\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*[-–]\s*(social post|linkedin|reel|youtube|blog|content)\s*$/i, "").trim();
}
__name(cleanHeadline, "cleanHeadline");
function deriveHeadline(f) {
  const angle = f["Angle/Hook"] || "";
  const m = angle.match(/overlay text:\s*(.+?)\s*(?:\r?\n|description:|link target:|$)/i);
  const raw = m && m[1] ? m[1] : cleanHeadline(f["Title"]);
  return sanitizeHeadline(raw);
}
__name(deriveHeadline, "deriveHeadline");
function sanitizeHeadline(s) {
  return String(s || "").replace(/\s*\blink target:.*$/is, "").replace(/https?:\/\/\S+/gi, "").replace(/^["'‘’“”\s]+|["'‘’“”\s]+$/g, "").replace(/\s*\.\s*$/, "").replace(/\s+/g, " ").trim();
}
__name(sanitizeHeadline, "sanitizeHeadline");
function parseBrandColors(str) {
  const hexes = String(str || "").match(/#[0-9a-fA-F]{6}/g) || [];
  return {
    primary: hexes[0] || "#FFD600",
    accent: hexes[1] || hexes[0] || "#FF5C00",
    all: hexes
  };
}
__name(parseBrandColors, "parseBrandColors");
function hexLuminance(hex) {
  const h = String(hex || "#000000").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
__name(hexLuminance, "hexLuminance");
function rotatePalette(colors, ordinal, phaseSeed, enabled) {
  if (!enabled) return { primary: colors.primary, accent: colors.accent };
  const all = (colors.all && colors.all.length ? colors.all : [colors.primary, colors.accent]).filter(Boolean);
  const light = all.filter((h) => hexLuminance(h) > 0.82);
  const usable = all.filter((h) => hexLuminance(h) <= 0.82);
  const paper = light[0] || "#F7F5F2";
  if (usable.length < 2) {
    return { primary: colors.primary, accent: colors.accent, paper };
  }
  const pairs = [];
  for (const a of usable) for (const b of usable) if (a !== b) pairs.push({ primary: a, accent: b });
  const pick = rotationPick(pairs, ordinal, "palette", phaseSeed) || pairs[0];
  return { primary: pick.primary, accent: pick.accent, paper };
}
__name(rotatePalette, "rotatePalette");
function parseDisplayFont(fontsStr) {
  if (!fontsStr) return "Poppins";
  const first = String(fontsStr).split(/[,(\/]/)[0].trim();
  return first || "Poppins";
}
__name(parseDisplayFont, "parseDisplayFont");
function readableText(hex) {
  const h = String(hex || "#000000").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.6 ? "#1a1a1a" : "#ffffff";
}
__name(readableText, "readableText");
var PIN_VARIANTS = {
  bold: [
    { name: "bold-top", zone: "top", ratio: "3:4", aspect: 0.75 },
    { name: "bold-bottom", zone: "bottom", ratio: "3:4", aspect: 0.75 },
    { name: "bold-band", zone: "lower-middle", ratio: "3:4", aspect: 0.75 },
    { name: "bold-split", zone: "landscape", ratio: "3:2", aspect: 1.5 },
    { name: "bold-poster", zone: "landscape", ratio: "4:3", aspect: 1.333 }
  ],
  minimal: [
    { name: "minimal-bottom", zone: "bottom", ratio: "3:4", aspect: 0.75 },
    { name: "minimal-card", zone: "bottom", ratio: "3:4", aspect: 0.75 },
    { name: "minimal-top", zone: "top", ratio: "3:4", aspect: 0.75 },
    { name: "minimal-split", zone: "landscape", ratio: "4:3", aspect: 1.333 }
  ]
};
var ZONE_INSTRUCTION = {
  top: "Composition: place the main subject in the BOTTOM TWO THIRDS of the frame. The top third must be near-empty - plain wall, sky, or open surface - because a headline will be laid over it.",
  bottom: "Composition: place the main subject in the TOP TWO THIRDS of the frame. The bottom third must be near-empty - floor, table surface, or plain background - because a headline will be laid over it.",
  "lower-middle": "Composition: place the main subject, and any face, entirely in the TOP HALF of the frame. Everything from roughly the middle of the frame down to the bottom must be plain and uninterrupted, because a solid headline band will be laid across it.",
  landscape: "The frame is landscape and no text will sit on it, so fill it properly: one clear subject, centred, with nothing important touching the extreme edges."
};
var PHOTO_TREATMENTS = [
  "a tight close-up detail shot - hands, tools or objects filling the frame, faces out of shot, very shallow depth of field",
  "a wide environmental shot with the person small in a large real room, lots of air around them",
  // Flat-lay is the treatment most likely to smuggle text back in - an open notebook or a
  // printed page reads as legible handwriting even when the prompt says no text. So this
  // one names the objects it will accept: closed, blank, or turned over.
  "a directly overhead flat-lay of the real objects involved arranged on a surface in soft even daylight, using only objects with no writing on them - closed notebooks, blank paper, face-down phones, tools, fabric, plants, crockery",
  "a candid mid-shot caught mid-action in warm low-angle late-afternoon light, slight motion in the frame",
  "a quiet still-life of the workspace with no people in it at all, one strong shaft of natural light",
  "an over-the-shoulder view from just behind the person, their back and hands in frame, the room falling out of focus",
  "a low-light interior lit by a single practical lamp, deep shadows, moody and high-contrast",
  "a clean high-key shot against a plain seamless wall, the subject sharply lit and isolated"
];
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
__name(hashStr, "hashStr");
function publishDayIndex(f) {
  const d = Date.parse(String(f["Publishing Date"] || f["Publish Date"] || ""));
  return Number.isFinite(d) ? Math.floor(d / 864e5) : 0;
}
__name(publishDayIndex, "publishDayIndex");
var ROTATION_STRIDE = 7;
var DAY_SLOTS = 3;
function rotationOrdinal(f, rank) {
  return publishDayIndex(f) * DAY_SLOTS + Math.max(0, rank | 0) % DAY_SLOTS;
}
__name(rotationOrdinal, "rotationOrdinal");
function rotationPick(list, ordinal, salt, phaseSeed) {
  if (!list.length) return null;
  const n = list.length;
  const i = (Math.round(ordinal) * ROTATION_STRIDE + hashStr(`${phaseSeed || ""}|${salt}`)) % n;
  return list[(i % n + n) % n];
}
__name(rotationPick, "rotationPick");
function sameDayRank(brief, f, batch) {
  const day = publishDayIndex(f);
  const brandOf = /* @__PURE__ */ __name((r) => (Array.isArray(r.fields && r.fields["Brand"]) ? r.fields["Brand"][0] : "") || "", "brandOf");
  const mine = brandOf(brief);
  const peers = (batch || []).filter((r) => brandOf(r) === mine && publishDayIndex(normalizeFields(r.fields)) === day).map((r) => r.id).sort();
  const idx = peers.indexOf(brief.id);
  return idx < 0 ? 0 : idx;
}
__name(sameDayRank, "sameDayRank");
function graphicVariantPool(brandFields, family) {
  const raw = String(brandFields && brandFields["Graphic Variants"] || "").trim();
  if (!raw) return null;
  const pool = PIN_VARIANTS[family];
  if (/^all$/i.test(raw)) return pool;
  const allow = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const narrowed = pool.filter((v) => allow.includes(v.name) || allow.includes(v.name.replace(`${family}-`, "")));
  return narrowed.length ? narrowed : pool;
}
__name(graphicVariantPool, "graphicVariantPool");
function rotationEnabled(brandFields) {
  return !!String(brandFields && brandFields["Graphic Variants"] || "").trim();
}
__name(rotationEnabled, "rotationEnabled");
function pickPinVariant(brandFields, f, ordinal, phaseSeed) {
  const family = String(brandFields && brandFields["Graphic Style"] || "Bold").toLowerCase() === "minimal" ? "minimal" : "bold";
  const pool = PIN_VARIANTS[family];
  const override = String(f["Graphic Variant"] && (f["Graphic Variant"].name || f["Graphic Variant"]) || "").trim().toLowerCase();
  if (override) {
    const hit = pool.find((v) => v.name === override || v.name === `${family}-${override}`);
    if (hit) return hit;
  }
  const rotating = graphicVariantPool(brandFields, family);
  if (!rotating) return pool[0];
  return rotationPick(rotating, ordinal, "layout", phaseSeed) || pool[0];
}
__name(pickPinVariant, "pickPinVariant");
function buildPinTemplate(opts) {
  const style = String(opts.style || "Bold").toLowerCase();
  if (style === "minimal") return buildPinTemplateMinimal(opts);
  return buildPinTemplateBold(opts);
}
__name(buildPinTemplate, "buildPinTemplate");
function buildPinTemplateBold({ photoUrl, headline, brandName, colors, font, w = PIN_W, h = PIN_H }) {
  const primary = colors.primary;
  const accent = colors.accent;
  const headlineText = readableText(primary);
  const len = headline.length;
  const size = len > 46 ? 66 : len > 30 ? 82 : 104;
  const html = `<div class="pin"><img class="photo" src="${photoUrl}"><div class="scrim"></div><div class="hl"><h1>${escapeHtml(headline)}</h1></div>` + (brandName ? `<div class="foot"><span>${escapeHtml(brandName)}</span></div>` : "") + `</div>`;
  const css = `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:${w}px; height:${h}px; }
.pin { position:relative; width:${w}px; height:${h}px; overflow:hidden; background:#000; }
.photo { position:absolute; inset:0; width:${w}px; height:${h}px; object-fit:cover; }
.scrim { position:absolute; inset:0;
  background:linear-gradient(to bottom, rgba(0,0,0,.32) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,0) 60%, rgba(0,0,0,.55) 100%); }
.hl { position:absolute; top:54px; left:46px; right:46px; }
.hl h1 {
  font-family:'${font}','Bangers','Poppins',sans-serif;
  font-size:${size}px; line-height:1.07; letter-spacing:.5px; text-transform:uppercase;
  color:${headlineText}; background:${primary};
  -webkit-box-decoration-break:clone; box-decoration-break:clone;
  padding:8px 20px; display:inline;
}
.foot { position:absolute; left:46px; bottom:44px; right:46px; }
.foot span {
  font-family:'${font}','Bangers','Poppins',sans-serif;
  font-size:36px; letter-spacing:1px; text-transform:uppercase;
  color:#fff; background:${accent}; padding:6px 18px; display:inline-block;
}
`;
  return { html, css, googleFonts: font, w, h };
}
__name(buildPinTemplateBold, "buildPinTemplateBold");
function buildPinTemplateMinimal({ photoUrl, headline, brandName, colors, font, w = PIN_W, h = PIN_H }) {
  const accent = colors.accent || colors.primary;
  const len = headline.length;
  const size = len > 66 ? 54 : len > 40 ? 66 : 82;
  const html = `<div class="pin"><img class="photo" src="${photoUrl}"><div class="scrim"></div><div class="wrap"><div class="rule"></div><h1>${escapeHtml(headline)}</h1>` + (brandName ? `<div class="brand">${escapeHtml(brandName)}</div>` : "") + `</div></div>`;
  const css = `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:${w}px; height:${h}px; }
.pin { position:relative; width:${w}px; height:${h}px; overflow:hidden; background:#111; }
.photo { position:absolute; inset:0; width:${w}px; height:${h}px; object-fit:cover; }
.scrim { position:absolute; inset:0;
  background:linear-gradient(to bottom, rgba(0,0,0,.12) 0%, rgba(0,0,0,0) 42%, rgba(12,18,24,.86) 100%); }
.wrap { position:absolute; left:72px; right:72px; bottom:96px; }
.rule { width:64px; height:4px; background:${accent}; margin-bottom:30px; }
.wrap h1 {
  font-family:'${font}','Georgia',serif; font-weight:600;
  font-size:${size}px; line-height:1.14; letter-spacing:.3px; color:#ffffff;
}
.brand {
  margin-top:28px; font-family:'Jost','Helvetica Neue',sans-serif;
  font-size:25px; letter-spacing:5px; text-transform:uppercase; color:rgba(255,255,255,.85);
}
`;
  return { html, css, googleFonts: `${font}|Jost`, w, h };
}
__name(buildPinTemplateMinimal, "buildPinTemplateMinimal");
async function renderPinViaHCTI(env, { html, css, googleFonts, w = PIN_W, h = PIN_H }) {
  const auth = "Basic " + btoa(`${env.HCTI_USER_ID}:${env.HCTI_API_KEY}`);
  const res = await fetch("https://hcti.io/v1/image", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: auth },
    body: JSON.stringify({
      html,
      css,
      google_fonts: googleFonts,
      viewport_width: w,
      viewport_height: h,
      device_scale: 1
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    throw new Error(`HCTI ${res.status}: ${data.error || JSON.stringify(data)}`);
  }
  return data.url;
}
__name(renderPinViaHCTI, "renderPinViaHCTI");
async function uploadBytesToR2(env, bytes, keyHint = "img", ext = "png", contentType = "image/png") {
  const key = `aios/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${keyHint}.${ext}`;
  await env.MM_MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  const base = (env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
  return `${base}/${key}`;
}
__name(uploadBytesToR2, "uploadBytesToR2");
function filenameToTitle(fn) {
  const t = String(fn || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_\-]+/g, " ").replace(/\bBBS\b/gi, "").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  return t || "Untitled";
}
__name(filenameToTitle, "filenameToTitle");
async function renderPinViaSatori(env, spec) {
  const endpoint = String(env.PIN_RENDER_URL || "").replace(/\/$/, "") + "/render";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-render-key": env.PIN_RENDER_KEY || "" },
    body: JSON.stringify(spec)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`pin-render ${res.status}: ${detail.slice(0, 200)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return uploadBytesToR2(env, bytes, "pin");
}
__name(renderPinViaSatori, "renderPinViaSatori");
async function airtableGet(env, table, params = "") {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable GET ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}
__name(airtableGet, "airtableGet");
async function airtableGetRecord(env, table, recordId) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Airtable GET ${table}/${recordId} ${res.status}: ${await res.text()}`);
  return res.json();
}
__name(airtableGetRecord, "airtableGetRecord");
async function airtablePatch(env, table, payload) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}
__name(airtablePatch, "airtablePatch");
async function airtablePost(env, table, payload) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Airtable POST ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}
__name(airtablePost, "airtablePost");
var SYSTEM_PROMPT = `You are the content writer for Messick Marketing, a healthcare marketing practice.
Voice: professional and warm. You write for a clinical/healthcare audience with credibility and empathy.
Be specific and substantive - no filler, no generic marketing fluff. Respect medical accuracy and avoid
overpromising clinical outcomes. Match the format to the requested content type.

Always write in plain text with no markdown (no #, **, or --- markers). Never use em dashes or double
hyphens; use a single hyphen only.

Return ONLY the finished content copy, ready to review and post. Do not include preamble, explanations,
or meta-commentary about the task.`;
function buildSystemPrompt(brand) {
  if (!brand) return SYSTEM_PROMPT;
  const name = brand["Account Name"] || "the brand";
  const parts = [
    `You are the content writer for ${name}.`,
    brand["Voice & Tone"] ? `Voice and tone: ${brand["Voice & Tone"]}` : "",
    brand["Hard Rules"] ? `Hard rules you must always follow: ${brand["Hard Rules"]}` : "",
    brand["Emoji Rules"] ? `Emoji rules: ${brand["Emoji Rules"]}` : "",
    "Be specific and substantive - no filler. Respect accuracy and avoid overpromising outcomes.",
    "Always write in plain text with no markdown (no #, **, or --- markers). Never use em dashes or double hyphens; use a single hyphen only.",
    "Return ONLY the finished content copy, ready to review and post. No preamble or meta-commentary."
  ];
  return parts.filter(Boolean).join("\n");
}
__name(buildSystemPrompt, "buildSystemPrompt");
var DEFAULT_TZ = "America/New_York";
function zonedWallTimeToUTC(y, mo, d, hh, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, hh, mi, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || DEFAULT_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(guess));
  const g = /* @__PURE__ */ __name((t) => Number(parts.find((p) => p.type === t).value), "g");
  let hourSeen = g("hour");
  if (hourSeen === 24) hourSeen = 0;
  const seenUTC = Date.UTC(g("year"), g("month") - 1, g("day"), hourSeen, g("minute"), g("second"));
  const offset = seenUTC - guess;
  return new Date(guess - offset);
}
__name(zonedWallTimeToUTC, "zonedWallTimeToUTC");
function parseSlotTime(text) {
  const s = String(text || "");
  const m = s.match(/TARGET SLOT:\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i) || s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i) || s.match(/\b(?:post|publish|schedule)\b[^.\n]*?\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) hh += 12;
  return { hh, mi: Number(m[2] || 0) };
}
__name(parseSlotTime, "parseSlotTime");
function computePublishDateISO(f, tz) {
  const raw = f["Publishing Date"];
  const dm = raw && String(raw).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return new Date(Date.now() + 24 * 3600 * 1e3).toISOString();
  const isSocial = /social post|reel|linkedin|youtube/i.test(String(f["Content Type"] || ""));
  const slot = isSocial && parseSlotTime(f["Angle/Hook"]) || { hh: 10, mi: 0 };
  return zonedWallTimeToUTC(Number(dm[1]), Number(dm[2]), Number(dm[3]), slot.hh, slot.mi, tz || DEFAULT_TZ).toISOString();
}
__name(computePublishDateISO, "computePublishDateISO");
function buildPrompt(f) {
  const type = f["Content Type"] || "post";
  const lines = [
    `Write a ${type} piece for the following content brief.`,
    "",
    `Title / Working concept: ${f["Title"] || "(untitled)"}`,
    `Target audience: ${f["Target Audience"] || "n/a"}`,
    `Success metrics (KPIs): ${f["KPIs"] || "n/a"}`,
    `Angle / Hook: ${f["Angle/Hook"] || "n/a"}`,
    `Target keywords: ${f["Target Keywords"] || "n/a"}`,
    f["Notes"] ? `Additional context: ${f["Notes"]}` : "",
    ""
  ];
  const guides = {
    "Social Post": `Format as a social media CAPTION, not a blog post or article. Open with a
scroll-stopping first line. Keep it tight and conversational - a few short lines or a small set of
punchy sentences, the way a real brand posts on Instagram or Facebook. One clear idea, a human voice,
and a single clear call to action or question at the end. Do NOT include hashtags in the caption -
they are generated separately. Aim for roughly 50-120 words and keep the caption UNDER 550 characters
total - it must clear Pinterest's 800-character description limit with hashtags appended.`,
    LinkedIn: `Format as a LinkedIn post: a strong scroll-stopping first line, short readable paragraphs,
one concrete insight or story, and a closing line that invites professional engagement (a question or
takeaway). Keep it ~150-300 words. No hashtag spam - 3-5 relevant hashtags max at the end.`,
    Blog: `Format as a STRUCTURED blog post a publishing script can parse. Start with exactly these
labeled lines, one per line:
SEO Title: <60 chars max, keyword-aware>
Slug: <url-slug-lowercase-hyphenated>
Meta Description: <150-160 chars, compelling, includes the primary keyword>
Suggested Social Hook: <one line a pin/reel promoting this post could lead with>
Then a line with only --- followed by the post body: a compelling intro, clear sections with plain
headings on their own lines, and a conclusion with a clear next step. Weave the target keywords in
naturally. ~800-1200 words. Where a topic overlaps other likely posts on the brand's blog, mention it
inline as "Related: <topic>" on its own line so internal links can be added at publish time.`,
    Reel: `You are directing a short-form vertical (9:16) video. FIRST decide the single best video
format for THIS specific topic and open with one line: "Recommended format: <format> - <one-line why>".
Choose from formats like talking-head to camera, screen-recording walkthrough, B-roll montage with
voiceover, text-on-screen listicle, or day-in-the-life - pick what actually fits the subject (a how-to
leans screen-record, a mindset piece leans talking-head, a listicle leans text-on-screen B-roll). THEN
write the brief for that format: a 3-second hook, the spoken VO lines, on-screen text cues in [brackets],
suggested B-roll or screen-capture cues, and a clear CTA. Target a tight 20-40 second short unless the
topic clearly needs longer.`,
    YouTube: `You are directing a video for this topic. FIRST recommend the best shape for THIS subject
and open with one line: "Recommended format: <Short or longer explainer> - <one-line why>". THEN provide
a title, a keyword-aware description with a timestamps placeholder, suggested tags, and a
retention-focused script: a strong hook plus clear sections with spoken VO and on-screen text cues in
[brackets].`
  };
  lines.push(guides[type] || "Write polished, ready-to-publish copy appropriate to the content type.");
  return lines.filter(Boolean).join("\n");
}
__name(buildPrompt, "buildPrompt");
async function generateVideoPrompt(env, f, brand, script) {
  const art = brand && brand["Art Direction"] && String(brand["Art Direction"]).trim() || "clean, modern, natural light, authentic and un-staged";
  const system = `You write ONE text-to-video generation prompt for a short-form vertical (9:16) video.
It will be pasted into an AI video tool (CapCut's AI generator, Veo, or a Claude design flow) or used as a
visual brief in CapCut. Read the script and honor the video format it recommends. Describe ONLY the visuals:
the setting, the subjects, the shot-by-shot progression, camera movement, pacing, lighting, color palette,
and mood. Do NOT write any spoken words or the literal on-screen text - those already live in the script.
Keep it a literal, realistic depiction for this brand's audience: no metaphors, mascots, or fantasy imagery.
Render in this style: ${art}. Return ONLY the prompt as one or two short paragraphs, no preamble or quotes.`;
  const user = `Brand: ${brand ? brand["Account Name"] || "" : ""}
Topic / title: ${f["Title"] || ""}
Audience: ${f["Target Audience"] || ""}
Script (match its recommended format and beats):
${script || ""}`;
  try {
    const p = await callClaude(env, { system, prompt: user, max_tokens: 500 });
    return stripMarkdown(p).replace(/^["']+|["']+$/g, "").trim();
  } catch (e) {
    console.log("AIOS video-prompt gen failed for", f["Title"], String(e));
    return "";
  }
}
__name(generateVideoPrompt, "generateVideoPrompt");
function normalizeFields(fields) {
  const out = {};
  for (const k in fields || {}) {
    const v = fields[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
  }
  return out;
}
__name(normalizeFields, "normalizeFields");
var VIDEO_TYPES = /* @__PURE__ */ new Set(["Reel", "YouTube"]);
function resolveChannels(f, brandFields, type) {
  const toNames = /* @__PURE__ */ __name((v) => (Array.isArray(v) ? v : []).map((c) => c && typeof c === "object" ? c.name : c).filter(Boolean), "toNames");
  if (type === "Blog") return [];
  const own = toNames(f["Channels"]);
  if (own.length) return own;
  if (!brandFields) return [];
  const key = VIDEO_TYPES.has(type) ? "Video Channels" : "Image Channels";
  return toNames(brandFields[key]);
}
__name(resolveChannels, "resolveChannels");
async function setInboxStatus(env, id, status) {
  await airtablePatch(env, TBL_INBOX, { typecast: true, records: [{ id, fields: { "Status": status } }] });
}
__name(setInboxStatus, "setInboxStatus");
async function runInboxIntake(env) {
  const formula = encodeURIComponent(`{Status} = "New"`);
  const data = await airtableGet(env, TBL_INBOX, `?filterByFormula=${formula}`);
  const rows = (data.records || []).slice(0, INTAKE_BATCH);
  if (!rows.length) return { phase: "inbox-intake", processed: 0, results: [] };
  const brandData = await airtableGet(env, BRAND_BRAIN, "");
  const brands = (brandData.records || []).map((r) => ({ id: r.id, name: (r.fields || {})["Account Name"] || "" })).filter((b) => b.name);
  const norm = /* @__PURE__ */ __name((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""), "norm");
  const normList = brands.map((b) => ({ ...b, key: norm(b.name) }));
  const brandList = brands.map((b) => b.name).join(", ");
  const results = [];
  for (const row of rows) {
    const f = row.fields || {};
    const idea = String(f["Message"] || f["Subject"] || "").trim();
    try {
      if (!idea) {
        await setInboxStatus(env, row.id, "Archived");
        results.push({ id: row.id, ok: false, error: "empty idea" });
        continue;
      }
      const linked = Array.isArray(f["Related Brand"]) && f["Related Brand"].length ? f["Related Brand"][0] : null;
      const system = `You convert a raw content idea into a structured content brief for a social/content pipeline.
Return ONLY minified JSON (no prose, no code fence) with exactly these keys:
{"brand":"<one of: ${brandList}>","contentType":"<one of: Social Post, Reel, YouTube, Blog, LinkedIn>","title":"<short working title, max 70 chars>","angle":"<1-2 sentences telling the writer the specific take, audience, and any call to action>"}
Choose the brand whose audience best fits the idea. Default contentType to "Social Post" unless the idea clearly implies a long educational piece (Blog) or a video (Reel/YouTube). Never invent facts beyond the idea.`;
      const prompt = `Idea: ${idea}${linked ? "" : `
Available brands: ${brandList}`}`;
      const raw = await callClaude(env, { system, prompt, max_tokens: 400 });
      let j = {};
      try {
        j = JSON.parse((raw.match(/\{[\s\S]*\}/) || ["{}"])[0]);
      } catch (_) {
        j = {};
      }
      let brandId = linked;
      if (!brandId) {
        const q = norm(j.brand);
        let b = q && normList.find((x) => x.key === q);
        if (!b && q) b = normList.find((x) => x.key.includes(q) || q.includes(x.key));
        brandId = b ? b.id : null;
      }
      if (!brandId) {
        await setInboxStatus(env, row.id, "Read");
        results.push({ id: row.id, ok: false, error: "could not infer brand - set Related Brand and mark New to retry" });
        continue;
      }
      const CANON = /* @__PURE__ */ new Set(["Social Post", "Reel", "YouTube", "Blog", "LinkedIn"]);
      const contentType = CANON.has(j.contentType) ? j.contentType : "Social Post";
      const title = String(j.title || idea).trim().slice(0, 90);
      const angle = String(j.angle || idea).trim();
      const fields = { "Title": title, "Content Type": contentType, "Angle/Hook": angle, "Status": "Ready for Generation" };
      if (brandId) fields["Brand"] = [brandId];
      const created = await airtablePost(env, TBL_BRIEF, { typecast: true, records: [{ fields }] });
      const briefId = created.records && created.records[0] && created.records[0].id;
      await setInboxStatus(env, row.id, "Completed");
      results.push({ id: row.id, ok: true, brief: briefId, title, contentType, brand: brandId });
    } catch (e) {
      results.push({ id: row.id, ok: false, error: String(e) });
    }
  }
  return { phase: "inbox-intake", processed: rows.length, results };
}
__name(runInboxIntake, "runInboxIntake");
async function runGenerationCycle(env) {
  const formula = encodeURIComponent(`{Status} = "Ready for Generation"`);
  const data = await airtableGet(env, TBL_BRIEF, `?filterByFormula=${formula}`);
  const allReady = data.records || [];
  const briefs = allReady.slice(0, CYCLE_BATCH);
  const r2Ready = !!(env.MM_MEDIA && env.R2_PUBLIC_BASE);
  const renderReady = !!(env.PIN_RENDER_URL && env.PIN_RENDER_KEY);
  const hctiReady = !!(env.HCTI_USER_ID && env.HCTI_API_KEY);
  const brandCache = {};
  const results = [];
  for (const brief of briefs) {
    const f = normalizeFields(brief.fields);
    try {
      const CANON_TYPES = /* @__PURE__ */ new Set(["Social Post", "LinkedIn", "Reel", "YouTube", "Blog"]);
      let type = (f["Content Type"] || "").trim();
      if (!CANON_TYPES.has(type)) type = "Social Post";
      f["Content Type"] = type;
      let brandFields = null;
      const brandLink = f["Brand"];
      if (Array.isArray(brandLink) && brandLink.length) {
        const brandId = brandLink[0];
        if (brandCache[brandId] !== void 0) {
          brandFields = brandCache[brandId];
        } else {
          try {
            const rec = await airtableGetRecord(env, BRAND_BRAIN, brandId);
            brandFields = rec.fields || null;
          } catch (be) {
            console.log("Brand Brain fetch failed for", brief.id, String(be));
            brandFields = null;
          }
          brandCache[brandId] = brandFields;
        }
      }
      const atts = Array.isArray(brief.fields["Attachments"]) ? brief.fields["Attachments"] : [];
      const vid = atts.find((a) => /video/i.test(a.type || "") || /\.(mp4|mov|m4v|webm)$/i.test(a.filename || a.url || ""));
      if (vid && r2Ready) {
        const topic = f["Title"] && String(f["Title"]).trim() || filenameToTitle(vid.filename || "");
        const vtype = VIDEO_TYPES.has(type) ? type : "Reel";
        const caption = stripMarkdown(await callClaude(env, {
          system: buildSystemPrompt(brandFields),
          prompt: `Write the social CAPTION/description for a FINISHED short-form vertical video (it posts to YouTube Shorts and TikTok). This is the video's caption, NOT a script. Video topic/title: "${topic}". Hook hard in the first line, stay in the brand voice, build curiosity about the story, and end with a light follow/subscribe CTA. Under ~150 words, plain text, no markdown, no hashtags (generated separately).`,
          model: MODEL_PRIMARY,
          max_tokens: 500
        }));
        let vtags = "";
        try {
          const t = await callClaude(env, { system: "You generate social media hashtags only. Return about 5 (never more than 5) relevant, specific hashtags as one space-separated line. No commentary. Spell every word correctly.", prompt: `Hashtags for a short-form video titled "${topic}" for ${brandFields ? brandFields["Account Name"] || "" : ""}.
Caption:
${caption}`, max_tokens: 150 });
          vtags = stripMarkdown(t).replace(/\n+/g, " ").trim().split(/\s+/).filter((x) => x.startsWith("#")).slice(0, 5).join(" ");
        } catch (_) {
        }
        const vresp = await fetch(vid.url);
        if (!vresp.ok) throw new Error(`fetch attachment ${vresp.status}`);
        const vbytes = new Uint8Array(await vresp.arrayBuffer());
        const ext = ((vid.filename || vid.url || "").match(/\.(mp4|mov|m4v|webm)(?:$|\?)/i) || [, "mp4"])[1].toLowerCase();
        const ctype = vid.type || (ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4");
        const r2Url = await uploadBytesToR2(env, vbytes, "vid", ext, ctype);
        const channels2 = resolveChannels({ ...f, "Content Type": vtype }, brandFields, vtype);
        const genFields2 = {
          "Name": `${topic} - ${vtype}`,
          "Brief": [brief.id],
          "Content Type": vtype,
          "Generated Copy": caption,
          "Approval Status": "Ready for Review",
          "Visual Asset": [{ url: r2Url }],
          "Publish Date": computePublishDateISO(f, DEFAULT_TZ)
        };
        if (vtags) genFields2["Hashtags"] = vtags;
        if (channels2.length) genFields2["Channels"] = channels2;
        await airtablePost(env, TBL_GENERATED, { records: [{ fields: genFields2 }], typecast: true });
        await airtablePatch(env, TBL_BRIEF, { records: [{ id: brief.id, fields: { "Status": "Generated" } }] });
        results.push({ brief: brief.id, ok: true, video: true, topic, channels: channels2 });
        continue;
      }
      const system = buildSystemPrompt(brandFields);
      let text = await callClaude(env, { system, prompt: buildPrompt(f), model: MODEL_PRIMARY });
      text = stripMarkdown(text);
      let hashtags = "";
      if (type === "Social Post" || VIDEO_TYPES.has(type)) {
        try {
          const tagText = await callClaude(env, {
            system: "You generate social media hashtags only. Return about 5 (never more than 5) relevant, specific hashtags as a single space-separated line. No commentary, no caption, no markdown - just the hashtags. Spell every word correctly.",
            prompt: `Generate hashtags for this post.
Title: ${f["Title"] || ""}
Audience: ${f["Target Audience"] || ""}
Keywords: ${f["Target Keywords"] || ""}
Copy:
${text}`,
            model: MODEL_PRIMARY,
            max_tokens: 200
          });
          hashtags = stripMarkdown(tagText).replace(/\n+/g, " ").trim().split(/\s+/).filter((t) => t.startsWith("#")).slice(0, 5).join(" ");
        } catch (he) {
          console.log("Hashtag gen failed for", brief.id, String(he));
        }
      }
      let videoPrompt = "";
      if (VIDEO_TYPES.has(type)) {
        videoPrompt = await generateVideoPrompt(env, f, brandFields, text);
      }
      const channels = resolveChannels(f, brandFields, type);
      const autoGraphics = !!(brandFields && brandFields["Auto Graphics"] === true);
      let visualAttachments = null;
      let imageTier = null, imageModel = null;
      let pinVariant = null;
      let imagePrompt = null;
      if (r2Ready && autoGraphics) {
        try {
          if (IMAGE_TYPES.has(type)) {
            const pinterestOnly = channels.length > 0 && channels.every((c) => c === "Pinterest");
            const canvasW = pinterestOnly ? PIN_W : FEED_W;
            const canvasH = pinterestOnly ? PIN_H : FEED_H;
            const slideType = classifySlideType(f);
            imageTier = slideType;
            imageModel = geminiImageModel(env, slideType);
            const ordinal = rotationOrdinal(f, sameDayRank(brief, f, allReady));
            const phaseSeed = Array.isArray(brandLink) && brandLink[0] || "";
            const variant = pickPinVariant(brandFields, f, ordinal, phaseSeed);
            imagePrompt = await resolveImagePrompt(env, f, brandFields, text, variant, ordinal, phaseSeed, brief.fields);
            const b64 = await generateImage(env, imagePrompt, variant.ratio, slideType);
            const photoUrl = await uploadImageToR2(env, b64, "photo");
            const headline = deriveHeadline(f);
            const style = String(brandFields && brandFields["Graphic Style"] || "Bold").toLowerCase();
            const brandName = brandFields && brandFields["Account Name"] || "";
            const colors = rotatePalette(
              parseBrandColors(brandFields && brandFields["Brand Colors"]),
              ordinal,
              phaseSeed,
              rotationEnabled(brandFields)
            );
            const font = parseDisplayFont(brandFields && brandFields["Fonts"]);
            pinVariant = variant.name;
            let pinUrl = null;
            if (renderReady && headline) {
              try {
                pinUrl = await renderPinViaSatori(env, {
                  template: style === "minimal" ? "minimal" : "bold",
                  variant: variant.name,
                  photo: photoUrl,
                  headline,
                  brandName,
                  colors,
                  displayFont: font,
                  photoAspect: variant.aspect,
                  w: canvasW,
                  h: canvasH
                });
              } catch (e) {
                console.log("AIOS Satori composite failed for", brief.id, "- trying HCTI:", String(e));
              }
            }
            if (!pinUrl && hctiReady && headline) {
              try {
                const tpl = buildPinTemplate({
                  photoUrl,
                  headline,
                  brandName,
                  colors,
                  font,
                  style: brandFields && brandFields["Graphic Style"] || "Bold",
                  w: canvasW,
                  h: canvasH
                });
                pinUrl = await renderPinViaHCTI(env, tpl);
              } catch (e) {
                console.log("AIOS HCTI composite failed for", brief.id, "- using bare photo:", String(e));
              }
            }
            visualAttachments = [{ url: pinUrl || photoUrl }];
          } else if (type === "Reel" && REEL_STORYBOARD_FRAMES > 0) {
            const frames = [];
            for (let i = 0; i < REEL_STORYBOARD_FRAMES; i++) {
              const b64 = await generateImage(
                env,
                `${buildImagePrompt(f, brandFields)} Storyboard frame ${i + 1} of ${REEL_STORYBOARD_FRAMES}.`,
                "9:16",
                "visual"
              );
              const urlR2 = await uploadImageToR2(env, b64, `reel-frame${i + 1}`);
              frames.push({ url: urlR2 });
            }
            if (frames.length) visualAttachments = frames;
          }
        } catch (visErr) {
          console.log("AIOS visual skipped for", brief.id, String(visErr));
        }
      }
      const genFields = {
        "Name": `${f["Title"] || "Untitled"} - ${f["Content Type"] || "Content"}`,
        "Brief": [brief.id],
        "Content Type": f["Content Type"] || null,
        "Generated Copy": text,
        "Approval Status": "Ready for Review"
      };
      if (f["Publishing Date"]) genFields["Publish Date"] = computePublishDateISO(f, DEFAULT_TZ);
      if (hashtags) genFields["Hashtags"] = hashtags;
      if (videoPrompt) genFields["Video Prompt"] = videoPrompt;
      if (visualAttachments) genFields["Visual Asset"] = visualAttachments;
      if (channels.length) genFields["Channels"] = channels;
      await airtablePost(env, TBL_GENERATED, { records: [{ fields: genFields }], typecast: true });
      await airtablePatch(env, TBL_BRIEF, {
        records: [{ id: brief.id, fields: { "Status": "Generated" } }]
      });
      results.push({ brief: brief.id, ok: true, brand: brandFields ? brandFields["Account Name"] || true : false, visual: !!visualAttachments, imageTier, imageModel, pinVariant, hashtags: !!hashtags, imagePrompt });
    } catch (err) {
      results.push({ brief: brief.id, ok: false, error: String(err) });
    }
  }
  return { processed: briefs.length, totalReady: allReady.length, results };
}
__name(runGenerationCycle, "runGenerationCycle");
async function migList(env, table) {
  const recs = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`);
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    const j = await r.json();
    recs.push(...j.records || []);
    offset = j.offset;
  } while (offset);
  return recs;
}
__name(migList, "migList");
var cleanKeys = /* @__PURE__ */ __name((obj) => {
  const out = {};
  for (const k in obj) out[k.replace(/^﻿/, "")] = obj[k];
  return out;
}, "cleanKeys");
async function handleBackfillMarkdown(request, env) {
  if ((request.headers.get("x-admin-key") || "").trim() !== String(env.ADMIN_KEY || "").trim()) {
    return new Response("forbidden", { status: 403 });
  }
  const all = await migList(env, TBL_GENERATED);
  const needsFix = [];
  for (const rec of all) {
    const fields = cleanKeys(rec.fields);
    const copy = fields["Generated Copy"];
    if (!copy) continue;
    const cleaned = stripMarkdown(copy);
    if (cleaned !== copy) needsFix.push({ id: rec.id, cleaned });
  }
  const matched = needsFix.length;
  const MAX_BATCHES = 4;
  let fixed = 0;
  for (let b = 0; b < MAX_BATCHES && needsFix.length; b++) {
    const slice = needsFix.splice(0, 10);
    await airtablePatch(env, TBL_GENERATED, {
      records: slice.map((r) => ({ id: r.id, fields: { "Generated Copy": r.cleaned } }))
    });
    fixed += slice.length;
  }
  return Response.json({
    scanned: all.length,
    matchedNeedingFix: matched,
    fixedThisCall: fixed,
    remaining: needsFix.length,
    done: needsFix.length === 0
  });
}
__name(handleBackfillMarkdown, "handleBackfillMarkdown");
var mm_ai_proxy_worker_default = {
  async fetch(request, env) {
    const statePath = new URL(request.url).pathname;
    if (statePath === "/state") return handleState(request, env);
    if (statePath === "/login") return handleLogin(request, env);
    if (statePath === "/revenue") return handleRevenue(request, env);
    if (statePath === "/moxie-webhook") return handleMoxieWebhook(request, env);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/claude") {
        const { prompt, image, system: claudeSystem } = await request.json();
        const userContent = image ? [
          { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: prompt }
        ] : prompt;
        const primaryModel2 = "claude-sonnet-4-6";
        const fallbackModel2 = "claude-haiku-4-5-20251001";
        const makeRequest = /* @__PURE__ */ __name((model) => fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model,
            max_tokens: 16000,
            ...claudeSystem && { system: claudeSystem },
            messages: [{ role: "user", content: userContent }]
          })
        }), "makeRequest");
        let response2 = await makeRequest(primaryModel2);
        if (response2.status === 529 || response2.status === 429) {
          response2 = await makeRequest(fallbackModel2);
        }
        const data2 = await response2.json();
        if (data2.error) return new Response(JSON.stringify({ error: data2.error.message }), { status: 400, headers: corsHeaders });
        return new Response(JSON.stringify({ text: data2.content[0].text }), { headers: corsHeaders });
      }
      if (url.pathname === "/imagen") {
        const { prompt, count = 1, aspectRatio = "3:4" } = await request.json();
        try {
          const n = Math.min(Math.max(count | 0, 1), 4);
          const predictions = [];
          for (let i = 0; i < n; i++) {
            const b64 = await generateImage(env, prompt, aspectRatio, "visual");
            predictions.push({ bytesBase64Encoded: b64 });
          }
          return new Response(JSON.stringify({ predictions }), { headers: corsHeaders });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message || "Imagen error" }), { status: 500, headers: corsHeaders });
        }
      }
      if (url.pathname === "/backfill-markdown" && request.method === "POST") {
        return handleBackfillMarkdown(request, env);
      }
      if (url.pathname === "/run-generation" && request.method === "POST") {
        if ((request.headers.get("x-admin-key") || "").trim() !== String(env.ADMIN_KEY || "").trim()) {
          return new Response("forbidden", { status: 403, headers: corsHeaders });
        }
        const result = await runGenerationCycle(env);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }
      if (url.pathname === "/run-inbox" && request.method === "POST") {
        if ((request.headers.get("x-admin-key") || "").trim() !== String(env.ADMIN_KEY || "").trim()) {
          return new Response("forbidden", { status: 403, headers: corsHeaders });
        }
        const result = await runInboxIntake(env);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }
      const body = await request.json();
      if (body.action === "scrape") {
        const scrapeResults = await scrapeProspect(body);
        return new Response(JSON.stringify(scrapeResults), { headers: corsHeaders });
      }
      const primaryModel = "claude-sonnet-4-6";
      const fallbackModel = "claude-haiku-4-5-20251001";
      const createPayload = /* @__PURE__ */ __name((modelName) => ({
        model: modelName,
        max_tokens: 4096,
        system: body.system || "You are a senior marketing strategist.",
        messages: body.messages
      }), "createPayload");
      let response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(createPayload(primaryModel))
      });
      if (response.status === 529 || response.status === 429) {
        response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify(createPayload(fallbackModel))
        });
      }
      const data = await response.json();
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error.message }), { status: 400, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ text: data.content[0].text }), { headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  },
  // ----- AIOS cron entry point -----
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        console.log("AIOS inbox intake:", JSON.stringify(await runInboxIntake(env)));
      } catch (e) {
        console.log("AIOS inbox intake error:", String(e));
      }
      try {
        console.log("AIOS generation cycle:", JSON.stringify(await runGenerationCycle(env)));
      } catch (e) {
        console.log("AIOS generation error:", String(e));
      }
    })());
  }
};
async function scrapeProspect(body) {
  const { website } = body;
  let text = "No site data.";
  if (website) {
    try {
      const res = await fetch(website, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0" },
        cf: { timeout: 5e3 }
      });
      const html = await res.text();
      text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6e3);
    } catch (e) {
      text = "Unreachable.";
    }
  }
  return { webData: text };
}
__name(scrapeProspect, "scrapeProspect");
var CORS_STATE = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
var TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var LOGIN_MAX_FAILS = 8;
var LOGIN_WINDOW_S = 900;
function jsonState(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_STATE, "Content-Type": "application/json" } });
}
__name(jsonState, "jsonState");
function b64url(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64url, "b64url");
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
__name(hmacSign, "hmacSign");
function timingSafeEq(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(timingSafeEq, "timingSafeEq");
async function verifyToken(env, token) {
  if (!token || !env.DASH_TOKEN_SECRET) return false;
  const dot = String(token).indexOf(".");
  if (dot < 1) return false;
  const exp = String(token).slice(0, dot), sig = String(token).slice(dot + 1);
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return timingSafeEq(sig, await hmacSign(env.DASH_TOKEN_SECRET, exp));
}
__name(verifyToken, "verifyToken");
async function requireAuth(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  return m ? verifyToken(env, m[1]) : false;
}
__name(requireAuth, "requireAuth");
async function handleLogin(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_STATE });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_STATE });
  if (!env.DASH_PASSWORD || !env.DASH_TOKEN_SECRET) return jsonState({ error: "auth not configured" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const failKey = `login_fail_${ip}`;
  const fails = Number(await env.MM_STATE.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAILS) return jsonState({ error: "too many attempts" }, 429);
  let password = "";
  try {
    password = (await request.json()).password || "";
  } catch (e) {
  }
  if (!timingSafeEq(password, env.DASH_PASSWORD)) {
    await env.MM_STATE.put(failKey, String(fails + 1), { expirationTtl: LOGIN_WINDOW_S });
    return jsonState({ error: "invalid password" }, 401);
  }
  if (fails) await env.MM_STATE.delete(failKey);
  const exp = Date.now() + TOKEN_TTL_MS;
  return jsonState({ token: `${exp}.${await hmacSign(env.DASH_TOKEN_SECRET, String(exp))}`, exp });
}
__name(handleLogin, "handleLogin");
async function handleState(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_STATE });
  if (!await requireAuth(request, env)) return jsonState({ error: "unauthorized" }, 401);
  if (request.method === "GET") {
    const v = await env.MM_STATE.get("dashboard");
    return new Response(v || JSON.stringify({ v: 0, data: {} }), { headers: { ...CORS_STATE, "Content-Type": "application/json" } });
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (body.length > 4 * 1024 * 1024) return jsonState({ error: "too large" }, 413);
    await env.MM_STATE.put("dashboard", body);
    return jsonState({ ok: true });
  }
  return new Response("Method not allowed", { status: 405, headers: CORS_STATE });
}
__name(handleState, "handleState");
var REVENUE_KEY = "revenue";
async function loadRevenue(env) {
  try {
    const raw = await env.MM_STATE.get(REVENUE_KEY);
    if (raw) {
      const r = JSON.parse(raw);
      r.byMonth = r.byMonth || {};
      r.seen = r.seen || {};
      r.invTotals = r.invTotals || {};
      return r;
    }
  } catch (e) {
  }
  return { v: 0, byMonth: {}, seen: {}, invTotals: {}, updatedAt: 0 };
}
__name(loadRevenue, "loadRevenue");
function revAddMonth(rev, ym, amount) {
  const amt = Number(amount) || 0;
  if (!ym || !amt) return;
  rev.byMonth[ym] = Math.round(((rev.byMonth[ym] || 0) + amt) * 100) / 100;
}
__name(revAddMonth, "revAddMonth");
function revSummary(rev) {
  const now = /* @__PURE__ */ new Date();
  const ym = now.toISOString().slice(0, 7);
  const yr = ym.slice(0, 4);
  let ytd = 0, total = 0;
  for (const k in rev.byMonth) {
    total += rev.byMonth[k];
    if (k.slice(0, 4) === yr) ytd += rev.byMonth[k];
  }
  return {
    thisMonth: Math.round((rev.byMonth[ym] || 0) * 100) / 100,
    ytd: Math.round(ytd * 100) / 100,
    total: Math.round(total * 100) / 100,
    byMonth: rev.byMonth,
    updatedAt: rev.updatedAt || 0
  };
}
__name(revSummary, "revSummary");
async function handleRevenue(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_STATE });
  const rev = await loadRevenue(env);
  if (request.method === "GET") return jsonState(revSummary(rev));
  if (request.method === "POST") {
    if ((request.headers.get("x-admin-key") || "").trim() !== String(env.ADMIN_KEY || "").trim()) {
      return jsonState({ error: "forbidden" }, 403);
    }
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return jsonState({ error: "bad body" }, 400);
    }
    const month = String(body.month || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return jsonState({ error: "month must be YYYY-MM" }, 400);
    rev.byMonth[month] = Math.round((Number(body.amount) || 0) * 100) / 100;
    if (body.invTotals && typeof body.invTotals === "object") {
      for (const id in body.invTotals) rev.invTotals[String(id)] = Number(body.invTotals[id]) || 0;
    }
    rev.updatedAt = Date.now();
    rev.v = Date.now();
    await env.MM_STATE.put(REVENUE_KEY, JSON.stringify(rev));
    return jsonState({ ok: true, seeded: { month, amount: rev.byMonth[month], invTotals: rev.invTotals }, summary: revSummary(rev) });
  }
  return new Response("Method not allowed", { status: 405, headers: CORS_STATE });
}
__name(handleRevenue, "handleRevenue");
async function handleMoxieWebhook(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_STATE });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_STATE });
  const secret = env.MOXIE_WEBHOOK_SECRET;
  if (!secret) return jsonState({ error: "webhook not configured" }, 503);
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m || !timingSafeEq(m[1], secret)) return jsonState({ error: "unauthorized" }, 401);
  const eventType = request.headers.get("X-Event-Type") || "";
  let inv = {};
  try {
    inv = await request.json();
  } catch (e) {
    return jsonState({ error: "bad body" }, 400);
  }
  if (eventType && eventType !== "PaymentReceived") return jsonState({ ok: true, ignored: eventType });
  const rev = await loadRevenue(env);
  const invId = String(inv.id || inv.invoiceId || "");
  const fallbackYM = (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
  let added = 0;
  if (inv.paymentTotal != null && invId) {
    const newTotal = Number(inv.paymentTotal) || 0;
    const prev = Number(rev.invTotals[invId]) || 0;
    const delta = Math.round((newTotal - prev) * 100) / 100;
    if (delta > 0) {
      const ym = String(inv.datePaid || "").slice(0, 7) || fallbackYM;
      revAddMonth(rev, ym, delta);
      added += delta;
    }
    rev.invTotals[invId] = newTotal;
  } else {
    const payments = Array.isArray(inv.payments) ? inv.payments : null;
    if (payments && payments.length) {
      payments.forEach((p, idx) => {
        const amt = Number(p.amount) || 0;
        if (!amt) return;
        const ym = String(p.datePaid || inv.datePaid || "").slice(0, 7) || fallbackYM;
        const key = p.id ? `p:${p.id}` : `i:${invId}|${p.datePaid || ""}|${amt}|${p.paidBy || ""}|${p.paymentProvider || ""}|${idx}`;
        if (rev.seen[key]) return;
        rev.seen[key] = true;
        revAddMonth(rev, ym, amt);
        added += amt;
      });
    }
  }
  rev.updatedAt = Date.now();
  rev.v = Date.now();
  await env.MM_STATE.put(REVENUE_KEY, JSON.stringify(rev));
  return jsonState({ ok: true, added: Math.round(added * 100) / 100, summary: revSummary(rev) });
}
__name(handleMoxieWebhook, "handleMoxieWebhook");
export {
  mm_ai_proxy_worker_default as default
};
//# sourceMappingURL=mm-ai-proxy-worker.js.map
