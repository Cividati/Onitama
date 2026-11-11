// Small HTTP helpers shared by the server modules.
'use strict';

function json(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location, headers) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Behind Railway's proxy the original scheme and client address arrive in headers.
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function setCookie(req, name, value, maxAgeSeconds) {
  return (
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (isHttps(req) ? '; Secure' : '')
  );
}

module.exports = { json, redirect, readJson, cookies, isHttps, clientIp, setCookie };
