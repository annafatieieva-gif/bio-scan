// My BioScan — сервер сповіщень (Cloudflare Worker)
//
// Робить ОДНЕ: раз на день перевіряє, чи не настав час якогось аналізу,
// і якщо так — надсилає справжнє push-сповіщення на телефон, навіть якщо
// додаток закритий. Не бачить і не зберігає жодних медичних даних —
// тільки назви аналізів, дати й підписку на сповіщення.
//
// Розгортається через веб-панель Cloudflare (Quick Edit), без термінала.
// Потрібно: KV namespace "REMINDERS" + Cron Trigger + 3 Environment Variables
// (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT) — інструкції в README.

// ============ CORS ============
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ============ base64url helpers ============
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============ Web Push encryption — RFC 8291 (aes128gcm) ============
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(subscriptionKeys, payloadBytes) {
  const clientPublicRaw = b64urlToBytes(subscriptionKeys.p256dh);
  const authSecret = b64urlToBytes(subscriptionKeys.auth);

  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));

  const clientPublicKey = await crypto.subtle.importKey('raw', clientPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);
  const ecdhSecret = new Uint8Array(sharedBits);

  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), clientPublicRaw, serverPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const padded = concatBytes(payloadBytes, new Uint8Array([2])); // RFC8188 delimiter, single record
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const header = concatBytes(salt, u32be(4096), new Uint8Array([serverPublicRaw.length]), serverPublicRaw);
  return concatBytes(header, ciphertext);
}

// ============ VAPID JWT — RFC 8292 (ES256) ============
async function buildVapidHeader(endpoint, vapidPublicB64url, vapidPrivateB64url, subjectMailto) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: subjectMailto };

  const encHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;

  const privRaw = b64urlToBytes(vapidPrivateB64url);
  const pubRaw = b64urlToBytes(vapidPublicB64url);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: bytesToB64url(privRaw), x: bytesToB64url(pubRaw.slice(1, 33)), y: bytesToB64url(pubRaw.slice(33, 65)),
    ext: true,
  };
  const signKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, new TextEncoder().encode(signingInput));
  return `vapid t=${signingInput}.${bytesToB64url(new Uint8Array(sig))}, k=${vapidPublicB64url}`;
}

async function sendPush(env, subscription, payloadObj) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(subscription.keys, payloadBytes);
  const authHeader = await buildVapidHeader(subscription.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': authHeader,
    },
    body,
  });
  return res;
}

// ============ due-date logic (mirrors app.js statusOf) ============
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dueReminders(entry) {
  const today = todayISO();
  const due = [];
  for (const t of entry.reminders || []) {
    if (!t.lastDate) continue; // без базової дати нема від чого рахувати — не спамимо
    const daysSince = daysBetween(t.lastDate, today);
    const daysLeft = t.freq - daysSince;
    if (daysLeft > 0) continue; // ще не час
    const lastNotified = (entry.lastNotified || {})[t.key];
    if (lastNotified && daysBetween(lastNotified, today) < 7) continue; // вже нагадували цього тижня
    due.push(t);
  }
  return due;
}

// ============ HTTP handlers ============
async function handleSubscribe(request, env) {
  const data = await request.json();
  if (!data.subscription || !data.subscription.endpoint) return json({ error: 'no subscription' }, 400);
  const id = await sha256hex(data.subscription.endpoint);
  const existing = await env.REMINDERS.get(id, 'json');
  const entry = {
    subscription: data.subscription,
    reminders: data.reminders || [],
    lastNotified: (existing && existing.lastNotified) || {},
  };
  await env.REMINDERS.put(id, JSON.stringify(entry));
  return json({ ok: true, id });
}

async function handleUnsubscribe(request, env) {
  const data = await request.json();
  if (!data.endpoint) return json({ error: 'no endpoint' }, 400);
  const id = await sha256hex(data.endpoint);
  await env.REMINDERS.delete(id);
  return json({ ok: true });
}

async function handleTest(request, env) {
  const data = await request.json();
  if (!data.subscription) return json({ error: 'no subscription' }, 400);
  const res = await sendPush(env, data.subscription, {
    title: 'My BioScan',
    body: 'Тестове сповіщення — якщо ти це бачиш, все працює 🌿',
  });
  return json({ ok: res.ok, status: res.status });
}

async function runDailyCheck(env) {
  const list = await env.REMINDERS.list();
  for (const k of list.keys) {
    const entry = await env.REMINDERS.get(k.name, 'json');
    if (!entry) continue;
    const due = dueReminders(entry);
    if (!due.length) continue;

    const title = due.length === 1 ? due[0].label : `${due.length} аналізи час пройти`;
    const body = due.map((t) => t.label).join(', ');
    try {
      const res = await sendPush(env, entry.subscription, { title: `My BioScan: ${title}`, body });
      if (res.status === 404 || res.status === 410) {
        // підписка більше не дійсна (додаток видалили/переустановили) — приберемо
        await env.REMINDERS.delete(k.name);
        continue;
      }
    } catch (e) {
      continue; // одна невдала відправка не повинна ламати решту
    }
    const today = todayISO();
    entry.lastNotified = entry.lastNotified || {};
    due.forEach((t) => { entry.lastNotified[t.key] = today; });
    await env.REMINDERS.put(k.name, JSON.stringify(entry));
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/subscribe') return await handleSubscribe(request, env);
      if (request.method === 'POST' && url.pathname === '/unsubscribe') return await handleUnsubscribe(request, env);
      if (request.method === 'POST' && url.pathname === '/test') return await handleTest(request, env);
      if (request.method === 'GET' && url.pathname === '/run-check-now') {
        // ручний запуск для перевірки (той самий код, що й cron) — зручно для діагностики
        await runDailyCheck(env);
        return json({ ok: true, ran: true });
      }
      return json({ ok: true, hint: 'My BioScan push server' });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyCheck(env));
  },
};
