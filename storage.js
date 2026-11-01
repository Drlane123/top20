"use strict";
// Cloudflare R2 storage — a small dependency-free S3 client (AWS SigV4).
//
// The site talks to the owner's R2 bucket with the keys he installed as
// Render environment variables (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY). The values never appear in code or in git — this
// module only reads them from process.env at runtime. When they are not
// set, every function degrades gracefully and the site runs exactly as
// before (media served from the built-in copies).
const crypto = require("node:crypto");
const fs = require("node:fs");

const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

function cfg() {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey };
}
function configured() { return cfg() !== null; }

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
function signingKey(secret, dateStamp) {
  const kDate = hmac("AWS4" + secret, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}
function amzDates(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}
// S3 path encoding: encode each segment, keep the slashes.
const encKey = (key) => String(key).split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");

function signHeaders({ method, key, query = {}, payloadHash, contentType, extraHeaders = {} }) {
  const c = cfg();
  const host = new URL(c.endpoint).host;
  const { amzDate, dateStamp } = amzDates();
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
  if (contentType) headers["content-type"] = contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const qs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  const canonicalRequest = [method, `/${c.bucket}/${encKey(key)}`, qs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(c.secretAccessKey, dateStamp)).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${c.endpoint}/${c.bucket}/${encKey(key)}${qs ? "?" + qs : ""}`;
  return { url, headers };
}

async function request(method, key, { query, body, contentType } = {}) {
  const c = cfg();
  if (!c) throw new Error("R2 is not configured (environment variables missing).");
  const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
  const { url, headers } = signHeaders({ method, key, query, payloadHash, contentType });
  const res = await fetch(url, { method, headers, body: body || undefined });
  return res;
}

async function putObject(key, data, contentType) {
  const body = Buffer.isBuffer(data) ? data : fs.readFileSync(data);
  const res = await request("PUT", key, { body, contentType: contentType || "application/octet-stream" });
  if (!res.ok) throw new Error(`R2 put ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { key, size: body.length, etag: res.headers.get("etag") || null };
}

async function putFile(key, filePath, contentType) {
  return putObject(key, fs.readFileSync(filePath), contentType);
}

async function getObject(key) {
  const res = await request("GET", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get ${key} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function headObject(key) {
  const res = await request("HEAD", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 head ${key} failed: HTTP ${res.status}`);
  return {
    key,
    size: Number(res.headers.get("content-length") || 0),
    contentType: res.headers.get("content-type") || null,
    etag: res.headers.get("etag") || null,
    lastModified: res.headers.get("last-modified") || null,
  };
}

async function deleteObject(key) {
  const res = await request("DELETE", key);
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${key} failed: HTTP ${res.status}`);
  return true;
}

// List objects under a prefix (single page — plenty for the admin panel).
async function listObjects(prefix = "", maxKeys = 100) {
  const res = await request("GET", "", { query: { "list-type": "2", prefix, "max-keys": String(maxKeys) } });
  if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const xml = await res.text();
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => { const mm = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block); return mm ? mm[1] : null; };
    out.push({ key: pick("Key"), size: Number(pick("Size") || 0), lastModified: pick("LastModified") });
  }
  return out;
}

// A time-limited public link to a private object (query-string signing).
// The bucket itself stays private; the link carries the permission and
// expires. Range requests (video seeking/looping) work natively on R2.
function presignGet(key, expiresSec = 3600) {
  const c = cfg();
  if (!c) return null;
  const host = new URL(c.endpoint).host;
  const { amzDate, dateStamp } = amzDates();
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(60, Math.min(604800, expiresSec))),
    "X-Amz-SignedHeaders": "host",
  };
  const qs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  const canonicalRequest = ["GET", `/${c.bucket}/${encKey(key)}`, qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(c.secretAccessKey, dateStamp)).update(stringToSign).digest("hex");
  return `${c.endpoint}/${c.bucket}/${encKey(key)}?${qs}&X-Amz-Signature=${signature}`;
}

// One cheap call that proves the installed keys actually work.
async function testConnection() {
  if (!configured()) return { ok: false, error: "not-configured" };
  try {
    await listObjects("", 1);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { configured, cfg, putObject, putFile, getObject, headObject, deleteObject, listObjects, presignGet, testConnection, _signingKey: signingKey, _sha256hex: sha256hex };
