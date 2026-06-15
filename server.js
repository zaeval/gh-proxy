#!/usr/bin/env node
/**
 * gh-proxy — GitHub relay server.
 *
 * Lets machines that can reach THIS machine (but not github.com /
 * api.github.com) use `gh`, `git`, and the GitHub REST/GraphQL API.
 *
 * Two modes are served on a single port:
 *
 *  1. Forward proxy (HTTP CONNECT tunnel)
 *     Client sets HTTPS_PROXY=http://<this-host>:<port> and gh/git work
 *     unmodified. TLS stays end-to-end; only allow-listed GitHub hosts
 *     can be tunneled.
 *
 *  2. Reverse proxy (GitHub-Enterprise-style path layout)
 *     /api/v3/*      -> https://api.github.com/*
 *     /api/graphql   -> https://api.github.com/graphql
 *     /api/uploads/* -> https://uploads.github.com/*
 *     /login/*       -> https://github.com/login/*       (OAuth/device flow)
 *     /raw/*         -> https://raw.githubusercontent.com/*
 *     /:owner/:repo(.git)/(info/refs|git-upload-pack|git-receive-pack)
 *                    -> https://github.com/*              (git smart HTTP)
 *     Link / Location headers and JSON body URLs pointing at
 *     api.github.com / uploads.github.com are rewritten to PUBLIC_HOST.
 *
 * Zero runtime dependencies. Node.js >= 18. See docs/API-CONTRACT.md.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
).version;
const VIA = `1.1 gh-proxy/${VERSION}`;
const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ */
/* .env loading (process env takes precedence over .env file)          */
/* ------------------------------------------------------------------ */

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function envBool(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

const cfg = {
  port: Number(process.env.PORT || 8788),
  bindHost: process.env.BIND_HOST || '0.0.0.0',
  publicHost: process.env.PUBLIC_HOST || '',
  proxyToken: process.env.PROXY_TOKEN || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  rewriteBodyUrls: envBool('REWRITE_BODY_URLS', true),
  followRedirects: envBool('FOLLOW_REDIRECTS', true),
  maxRedirects: Number(process.env.MAX_REDIRECTS || 5),
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 30000),
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 10000),
  logRequests: envBool('LOG_REQUESTS', true),
  extraAllowedHosts: (process.env.EXTRA_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  tlsCertFile: process.env.TLS_CERT_FILE || '',
  tlsKeyFile: process.env.TLS_KEY_FILE || '',
};

const useTls = Boolean(cfg.tlsCertFile && cfg.tlsKeyFile);

const PUBLIC_BASE = (() => {
  let h = cfg.publicHost || `localhost:${cfg.port}`;
  if (!/^https?:\/\//i.test(h)) h = `${useTls ? 'https' : 'http'}://${h}`;
  return h.replace(/\/+$/, '');
})();

/* Hosts that may be tunneled (CONNECT) or fetched (absolute-form).     */
const ALLOWED_HOSTS = [
  'github.com',
  '*.github.com',
  'githubusercontent.com',
  '*.githubusercontent.com',
  'ghcr.io',
  '*.ghcr.io',
  'githubcopilot.com',
  '*.githubcopilot.com',
  ...cfg.extraAllowedHosts,
];
const ALLOWED_CONNECT_PORTS = new Set([443, 80, 22]);

function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return ALLOWED_HOSTS.some((p) =>
    p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p,
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const upstreamAgentHttp = new http.Agent({ keepAlive: true, maxSockets: 16 });

function log(...args) {
  if (cfg.logRequests) console.log(new Date().toISOString(), ...args);
}

function remoteAddr(reqOrSocket) {
  const s = reqOrSocket.socket || reqOrSocket;
  return `${s.remoteAddress || '?'}:${s.remotePort || '?'}`;
}

/** Copy client request headers, dropping hop-by-hop and proxy-internal ones. */
function cleanRequestHeaders(headers) {
  const drop = new Set(HOP_BY_HOP);
  drop.add('host');
  drop.add('x-proxy-token');
  for (const name of String(headers.connection || '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n) drop.add(n);
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Copy upstream response headers, dropping hop-by-hop ones. */
function cleanResponseHeaders(headers) {
  const drop = new Set(HOP_BY_HOP);
  for (const name of String(headers.connection || '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n) drop.add(n);
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  out.via = out.via ? `${out.via}, ${VIA}` : VIA;
  return out;
}

/** Rewrite absolute GitHub URLs to point back at this proxy. */
function rewriteGithubUrls(s) {
  return s
    .split('https://api.github.com')
    .join(`${PUBLIC_BASE}/api/v3`)
    .split('https://uploads.github.com')
    .join(`${PUBLIC_BASE}/api/uploads`);
}

function sendProxyError(res, status, code, message) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(
    { error: { code, message, source: `gh-proxy/${VERSION}` } },
    null,
    2,
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-gh-proxy-error': code,
    via: VIA,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    via: VIA,
  });
  res.end(body);
}

/** Validate the optional shared secret (PROXY_TOKEN). */
function proxyAuthOk(req) {
  if (!cfg.proxyToken) return true;
  const xt = req.headers['x-proxy-token'];
  if (xt && xt === cfg.proxyToken) return true;
  const pa = String(req.headers['proxy-authorization'] || '');
  const bearer = pa.match(/^Bearer\s+(.+)$/i);
  if (bearer && bearer[1] === cfg.proxyToken) return true;
  const basic = pa.match(/^Basic\s+(.+)$/i);
  if (basic) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return false;
    }
    if (decoded === cfg.proxyToken) return true;
    const colon = decoded.indexOf(':');
    if (colon >= 0 && decoded.slice(colon + 1) === cfg.proxyToken) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Reverse-proxy routing                                               */
/* ------------------------------------------------------------------ */

const GIT_SMART_HTTP_RE =
  /^\/[^/]+\/[^/]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Map an incoming proxy path to an upstream host + path.
 * Returns { host, path, kind } or null when no route matches.
 * kind: 'api' | 'uploads' | 'login' | 'raw' | 'git'
 */
function resolveRoute(url) {
  const qIdx = url.indexOf('?');
  const p = qIdx === -1 ? url : url.slice(0, qIdx);
  const q = qIdx === -1 ? '' : url.slice(qIdx);

  if (p === '/api/graphql' || p === '/api/v3/graphql') {
    return { host: 'api.github.com', path: `/graphql${q}`, kind: 'api' };
  }
  if (p === '/api/v3' || p.startsWith('/api/v3/')) {
    return {
      host: 'api.github.com',
      path: (p.slice('/api/v3'.length) || '/') + q,
      kind: 'api',
    };
  }
  if (p.startsWith('/api/uploads/')) {
    return {
      host: 'uploads.github.com',
      path: p.slice('/api/uploads'.length) + q,
      kind: 'uploads',
    };
  }
  if (p === '/login' || p.startsWith('/login/')) {
    return { host: 'github.com', path: p + q, kind: 'login' };
  }
  if (p.startsWith('/raw/')) {
    return {
      host: 'raw.githubusercontent.com',
      path: p.slice('/raw'.length) + q,
      kind: 'raw',
    };
  }
  if (GIT_SMART_HTTP_RE.test(p)) {
    return { host: 'github.com', path: p + q, kind: 'git' };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reverse proxy implementation                                        */
/* ------------------------------------------------------------------ */

const MAX_REWRITE_BODY_BYTES = 16 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function handleReverse(clientReq, clientRes, route) {
  const started = Date.now();
  const headers = cleanRequestHeaders(clientReq.headers);
  headers.host = route.host;
  if (!headers['user-agent']) headers['user-agent'] = `gh-proxy/${VERSION}`;

  // Optional server-side token injection (REST/GraphQL/uploads only).
  if (
    cfg.githubToken &&
    !headers.authorization &&
    (route.kind === 'api' || route.kind === 'uploads')
  ) {
    headers.authorization = `Bearer ${cfg.githubToken}`;
  }

  // URL rewriting requires an uncompressed body we can inspect.
  const wantRewrite = cfg.rewriteBodyUrls && route.kind === 'api';
  if (wantRewrite) headers['accept-encoding'] = 'identity';

  const done = (status, note) =>
    log(
      `${remoteAddr(clientReq)} ${clientReq.method} ${clientReq.url} -> ${route.host} ${status}${note ? ` ${note}` : ''} (${Date.now() - started}ms)`,
    );

  proxyHop({
    clientReq,
    clientRes,
    host: route.host,
    path: route.path,
    method: clientReq.method,
    headers,
    wantRewrite,
    redirectCount: 0,
    sendBody: true,
    done,
  });
}

function proxyHop(ctx) {
  const { clientReq, clientRes, host, path: upPath, method, headers } = ctx;

  const upReq = https.request({
    hostname: host,
    port: 443,
    path: upPath,
    method,
    headers,
    agent: upstreamAgent,
    timeout: cfg.upstreamTimeoutMs,
  });

  upReq.on('timeout', () => upReq.destroy(new Error('UPSTREAM_TIMEOUT')));
  upReq.on('error', (err) => {
    const timedOut = /UPSTREAM_TIMEOUT|ETIMEDOUT/.test(String(err.message));
    ctx.done(timedOut ? 504 : 502, `upstream error: ${err.message}`);
    sendProxyError(
      clientRes,
      timedOut ? 504 : 502,
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      `Request to https://${host}${upPath} failed: ${err.message}`,
    );
  });

  upReq.on('response', (upRes) => handleUpstreamResponse(ctx, upRes));

  if (ctx.sendBody) {
    clientReq.pipe(upReq);
    clientReq.on('error', () => upReq.destroy());
  } else {
    upReq.end();
  }
}

function handleUpstreamResponse(ctx, upRes) {
  const { clientReq, clientRes, host, method } = ctx;
  const status = upRes.statusCode;
  const loc = upRes.headers.location;

  // Follow redirects server-side so clients never see hosts they cannot
  // reach (codeload.github.com, objects.githubusercontent.com, ...).
  if (
    loc &&
    REDIRECT_STATUSES.has(status) &&
    cfg.followRedirects &&
    ctx.redirectCount < cfg.maxRedirects &&
    (method === 'GET' || method === 'HEAD')
  ) {
    let target = null;
    try {
      target = new URL(loc, `https://${host}${ctx.path}`);
    } catch {
      /* fall through to the non-follow path */
    }
    if (target && target.protocol === 'https:' && hostAllowed(target.hostname)) {
      upRes.resume(); // drain and discard the redirect body
      const nextHeaders = { ...ctx.headers, host: target.hostname };
      if (target.hostname !== host) {
        // Cross-host redirects (e.g. to objects.githubusercontent.com)
        // must not carry the GitHub credential.
        delete nextHeaders.authorization;
      }
      proxyHop({
        ...ctx,
        host: target.hostname,
        path: target.pathname + target.search,
        headers: nextHeaders,
        redirectCount: ctx.redirectCount + 1,
        sendBody: false,
      });
      return;
    }
  }

  const respHeaders = cleanResponseHeaders(upRes.headers);
  if (respHeaders.link) {
    respHeaders.link = rewriteGithubUrls(String(respHeaders.link));
  }
  if (respHeaders.location) {
    respHeaders.location = rewriteGithubUrls(String(respHeaders.location));
  }

  const contentType = String(upRes.headers['content-type'] || '');
  const rewritable =
    ctx.wantRewrite &&
    method !== 'HEAD' &&
    status !== 204 &&
    status !== 304 &&
    /\bjson\b|^text\//i.test(contentType);

  if (!rewritable) {
    clientRes.writeHead(status, respHeaders);
    upRes.pipe(clientRes);
    upRes.on('error', () => clientRes.destroy());
    ctx.done(status);
    return;
  }

  // Buffer, decompress if needed, rewrite URLs, send.
  let chunks = [];
  let size = 0;
  let overflowed = false;

  upRes.on('data', (chunk) => {
    if (overflowed) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REWRITE_BODY_BYTES) {
      // Too large to rewrite — fall back to streaming the original bytes.
      overflowed = true;
      clientRes.writeHead(status, respHeaders);
      for (const c of chunks) clientRes.write(c);
      chunks = null;
      upRes.pipe(clientRes);
      ctx.done(status, 'rewrite skipped: body too large');
    }
  });

  upRes.on('error', () => clientRes.destroy());

  upRes.on('end', () => {
    if (overflowed) return;
    let body = Buffer.concat(chunks);
    const encoding = String(upRes.headers['content-encoding'] || '')
      .trim()
      .toLowerCase();
    try {
      if (encoding === 'gzip') body = zlib.gunzipSync(body);
      else if (encoding === 'deflate') body = zlib.inflateSync(body);
      else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
      else if (encoding && encoding !== 'identity') throw new Error('unknown');
    } catch {
      // Unknown/broken encoding: pass the original bytes through untouched.
      clientRes.writeHead(status, respHeaders);
      clientRes.end(Buffer.concat(chunks));
      ctx.done(status, 'rewrite skipped: unsupported content-encoding');
      return;
    }
    const out = Buffer.from(rewriteGithubUrls(body.toString('utf8')), 'utf8');
    delete respHeaders['content-encoding'];
    respHeaders['content-length'] = String(out.length);
    clientRes.writeHead(status, respHeaders);
    clientRes.end(out);
    ctx.done(status);
  });
}

/* ------------------------------------------------------------------ */
/* Service endpoints                                                   */
/* ------------------------------------------------------------------ */

function handleServiceInfo(res) {
  const publicHasPath = new URL(PUBLIC_BASE).pathname !== '/';
  sendJson(res, 200, {
    name: 'gh-proxy',
    version: VERSION,
    public_base: PUBLIC_BASE,
    auth_required: Boolean(cfg.proxyToken),
    endpoints: {
      forward_proxy: publicHasPath
        ? 'CONNECT tunnel is not available through a path-prefixed deployment — use the REST/git endpoints below, or connect directly to the proxy port for HTTPS_PROXY mode'
        : `Set HTTPS_PROXY=${PUBLIC_BASE} (CONNECT tunnel, gh/git work unmodified)`,
      rest: `${PUBLIC_BASE}/api/v3/{path}`,
      graphql: `${PUBLIC_BASE}/api/graphql`,
      uploads: `${PUBLIC_BASE}/api/uploads/{path}`,
      oauth: `${PUBLIC_BASE}/login/{path}`,
      raw: `${PUBLIC_BASE}/raw/{owner}/{repo}/{ref}/{path}`,
      git_http: `${PUBLIC_BASE}/{owner}/{repo}.git`,
      health: `${PUBLIC_BASE}/healthz`,
      contract: `${PUBLIC_BASE}/contract`,
      install: `${PUBLIC_BASE}/install`,
      skill: `${PUBLIC_BASE}/skill`,
    },
    docs: `${PUBLIC_BASE}/contract`,
    source: 'https://github.com/zaeval/gh-proxy',
  });
}

function handleHealthz(req, res) {
  const wantUpstream = /[?&]upstream=1\b/.test(req.url);
  const base = {
    status: 'ok',
    version: VERSION,
    uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
  };
  if (!wantUpstream) {
    sendJson(res, 200, base);
    return;
  }
  const started = Date.now();
  const probe = https.request(
    {
      hostname: 'api.github.com',
      path: '/',
      method: 'GET',
      headers: { 'user-agent': `gh-proxy/${VERSION}` },
      agent: upstreamAgent,
      timeout: 5000,
    },
    (r) => {
      r.resume();
      sendJson(res, 200, {
        ...base,
        upstream: {
          reachable: true,
          status: r.statusCode,
          latency_ms: Date.now() - started,
        },
      });
    },
  );
  probe.on('timeout', () => probe.destroy(new Error('timeout')));
  probe.on('error', (err) => {
    sendJson(res, 200, {
      ...base,
      status: 'degraded',
      upstream: { reachable: false, error: err.message },
    });
  });
  probe.end();
}

/* ------------------------------------------------------------------ */
/* Contract documentation (rendered Markdown, zero dependencies)       */
/* ------------------------------------------------------------------ */

const CONTRACT_FILE = path.join(__dirname, 'docs', 'API-CONTRACT.md');
const GH_BLOB_BASE = 'https://github.com/zaeval/gh-proxy/blob/main';

const htmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** GitHub-compatible heading slug (so the doc's TOC anchors resolve). */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Inline markdown: code spans, bold, links. Repo-relative links -> GitHub. */
function renderInline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = htmlEscape(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    let href = url;
    if (/^#/.test(url)) {
      href = url; // in-page anchor
    } else if (!/^[a-z]+:/i.test(url)) {
      // repo-relative path (e.g. ../server.js, ../README.md#x) -> GitHub blob
      href = `${GH_BLOB_BASE}/${url.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '')}`;
    }
    return `<a href="${href}">${label}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${htmlEscape(codes[i])}</code>`);
  return s;
}

/** Minimal block-level Markdown -> HTML, scoped to features used in the doc. */
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const isBlockStart = (l) =>
    /^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(l) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
    l.includes('|');

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)/);
    if (fence) {
      i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      html += `<pre><code>${htmlEscape(code.join('\n'))}</code></pre>\n`;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/\s+#+\s*$/, '');
      html += `<h${level} id="${slugify(text)}">${renderInline(text)}</h${level}>\n`;
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }

    // GFM pipe table: header row followed by a |---|---| separator row.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const parseRow = (l) =>
        l
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseRow(lines[i]));
        i++;
      }
      html +=
        '<table>\n<thead><tr>' +
        headers.map((c) => `<th>${renderInline(c)}</th>`).join('') +
        '</tr></thead>\n<tbody>\n' +
        rows
          .map(
            (r) =>
              '<tr>' + r.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>',
          )
          .join('\n') +
        '\n</tbody>\n</table>\n';
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html += `<blockquote>${renderInline(quote.join(' '))}</blockquote>\n`;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      html +=
        '<ul>\n' +
        items.map((it) => `<li>${renderInline(it)}</li>`).join('\n') +
        '\n</ul>\n';
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html +=
        '<ol>\n' +
        items.map((it) => `<li>${renderInline(it)}</li>`).join('\n') +
        '\n</ol>\n';
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${renderInline(para.join(' '))}</p>\n`;
  }
  return html;
}

const CONTRACT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.2rem 1.2rem 5rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR",
    Helvetica, Arial, sans-serif;
  line-height: 1.66; color: #1f2328; background: #ffffff;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 60rem; margin: 0 auto; }
.bar {
  max-width: 60rem; margin: 0 auto 1.6rem; padding-bottom: 1rem;
  border-bottom: 1px solid #d0d7de; font-size: .86rem; color: #59636e;
  display: flex; gap: 1rem; flex-wrap: wrap;
}
.bar a { color: #0969da; text-decoration: none; }
.bar a:hover { text-decoration: underline; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.8em 0 .6em; font-weight: 600; }
h1 { font-size: 1.9rem; margin-top: .2em; }
h2 { font-size: 1.45rem; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 1.18rem; }
h4 { font-size: 1rem; }
h1, h2, h3, h4 { scroll-margin-top: 1rem; }
p { margin: .7em 0; }
a { color: #0969da; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: .88em; background: rgba(129,139,152,.16);
  padding: .15em .4em; border-radius: 6px;
}
pre {
  background: #f6f8fa; border-radius: 8px; padding: 1rem; overflow: auto;
  border: 1px solid #d0d7de;
}
pre code { background: none; padding: 0; font-size: .85em; line-height: 1.5; }
table {
  border-collapse: collapse; width: 100%; margin: 1em 0; display: block;
  overflow-x: auto; font-size: .92rem;
}
th, td { border: 1px solid #d0d7de; padding: .5em .8em; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
tr:nth-child(2n) td { background: #f6f8fa66; }
blockquote {
  margin: 1em 0; padding: .3em 1em; color: #59636e;
  border-left: .25em solid #d0d7de;
}
ul, ol { padding-left: 1.6em; }
li { margin: .25em 0; }
hr { height: 1px; border: 0; background: #d0d7de; margin: 2em 0; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  .bar { border-color: #30363d; color: #9198a1; }
  h2 { border-color: #30363d; }
  code { background: rgba(110,118,129,.4); }
  pre { background: #161b22; border-color: #30363d; }
  th, td { border-color: #30363d; }
  th { background: #161b22; }
  tr:nth-child(2n) td { background: #161b2255; }
  blockquote { color: #9198a1; border-color: #30363d; }
  hr { background: #30363d; }
  .bar a, a { color: #4493f8; }
}`;

function sendBody(req, res, contentType, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': buf.length,
    via: VIA,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/** Wrap rendered HTML in the shared page chrome (nav bar + CSS). */
function htmlPage(title, innerHtml) {
  return (
    '<!doctype html>\n<html lang="ko">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${htmlEscape(title)}</title>\n` +
    `<style>${CONTRACT_CSS}</style>\n</head>\n<body>\n` +
    `<div class="bar"><span>gh-proxy v${VERSION}</span>` +
    `<a href="${PUBLIC_BASE}/">service info</a>` +
    `<a href="${PUBLIC_BASE}/contract">contract</a>` +
    `<a href="${PUBLIC_BASE}/install">install</a>` +
    '<a href="https://github.com/zaeval/gh-proxy">GitHub</a></div>\n' +
    `<main>\n${innerHtml}</main>\n</body>\n</html>\n`
  );
}

function handleContract(req, res) {
  const wantRaw = /[?&]raw=1\b/.test(req.url) || req.url.split('?')[0].endsWith('.md');
  let md;
  try {
    md = fs.readFileSync(CONTRACT_FILE, 'utf8');
  } catch (err) {
    sendProxyError(res, 500, 'CONTRACT_UNAVAILABLE', `Cannot read contract: ${err.message}`);
    return;
  }
  if (wantRaw) {
    sendBody(req, res, 'text/markdown; charset=utf-8', md);
    return;
  }
  sendBody(
    req,
    res,
    'text/html; charset=utf-8',
    htmlPage(`gh-proxy API Contract v${VERSION}`, renderMarkdown(md)),
  );
}

/* ------------------------------------------------------------------ */
/* Skill file + install guide                                          */
/* ------------------------------------------------------------------ */

const SKILL_FILE = path.join(__dirname, 'skills', 'gh-proxy', 'SKILL.md');

/** Serve the gh-proxy SKILL.md. ?codex=1 strips frontmatter for AGENTS.md use. */
function handleSkill(req, res) {
  let md;
  try {
    md = fs.readFileSync(SKILL_FILE, 'utf8');
  } catch (err) {
    sendProxyError(res, 500, 'SKILL_UNAVAILABLE', `Cannot read skill: ${err.message}`);
    return;
  }
  if (/[?&]codex=1\b/.test(req.url)) {
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
    md = `# gh-proxy — use GitHub through a relay (added by gh-proxy installer)\n\n${body}`;
  }
  sendBody(req, res, 'text/markdown; charset=utf-8', md);
}

const INSTALL_SH = `#!/bin/sh
# gh-proxy installer — installs the gh-proxy skill into Claude Code and/or Codex.
# Usage:  curl -fsSL ${PUBLIC_BASE}/install.sh | sh           # both
#         curl -fsSL ${PUBLIC_BASE}/install.sh | sh -s -- claude
#         curl -fsSL ${PUBLIC_BASE}/install.sh | sh -s -- codex
set -eu
BASE="${PUBLIC_BASE}"
TARGET="\${1:-both}"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "gh-proxy: need curl or wget" >&2; exit 1; fi
}

install_skill() {
  label="$1"; base_dir="$2"
  mkdir -p "$base_dir/gh-proxy"
  fetch "$BASE/skill" > "$base_dir/gh-proxy/SKILL.md"
  echo "  installed $label -> $base_dir/gh-proxy/SKILL.md"
}

echo "gh-proxy installer ($BASE)"
case "$TARGET" in
  claude|both) install_skill "Claude Code" "$HOME/.claude/skills" ;;
esac
case "$TARGET" in
  codex|both) install_skill "Codex CLI" "$HOME/.codex/skills" ;;
esac

echo ""
echo "Add these to your shell profile (the skill reads them):"
echo "  export GH_PROXY_URL=$BASE"${cfg.proxyToken ? `
echo "  export GH_PROXY_TOKEN=<the proxy token you were given>"` : ''}
echo ""
echo "Restart Claude Code / Codex to load the skill. Docs: $BASE/contract"
`;

const INSTALL_PS1 = `# gh-proxy installer — installs the gh-proxy skill into Claude Code and/or Codex.
# Usage:  irm ${PUBLIC_BASE}/install.ps1 | iex            # installs to both
#         (single target: download then run with 'claude' or 'codex' argument)
$ErrorActionPreference = "Stop"
$Base = "${PUBLIC_BASE}"
$Target = if ($args.Count -ge 1) { $args[0] } else { "both" }

function Install-GhProxySkill($label, $baseDir) {
  $dir = Join-Path $baseDir "gh-proxy"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Invoke-RestMethod "$Base/skill" -OutFile (Join-Path $dir "SKILL.md")
  Write-Host "  installed $label -> $dir\\SKILL.md"
}

Write-Host "gh-proxy installer ($Base)"
if ($Target -in @("claude","both")) { Install-GhProxySkill "Claude Code" "$HOME\\.claude\\skills" }
if ($Target -in @("codex","both"))  { Install-GhProxySkill "Codex CLI" "$HOME\\.codex\\skills" }

Write-Host ""
Write-Host "Set these user environment variables (the skill reads them):"
Write-Host "  setx GH_PROXY_URL $Base"${cfg.proxyToken ? `
Write-Host "  setx GH_PROXY_TOKEN <the proxy token you were given>"` : ''}
Write-Host ""
Write-Host "Restart Claude Code / Codex to load the skill. Docs: $Base/contract"
`;

function buildInstallGuide() {
  const B = PUBLIC_BASE;
  const tokenSection = cfg.proxyToken
    ? `## 2. 토큰 설정 (필수)

이 프록시는 토큰 인증이 켜져 있습니다. 전달받은 토큰을 환경변수로 설정하세요 —
스킬이 \`GH_PROXY_URL\`/\`GH_PROXY_TOKEN\`으로 프록시 주소와 토큰을 찾습니다.
설치 스크립트에는 토큰이 포함되지 않으므로 직접 설정해야 합니다.

\`\`\`sh
# Linux / macOS / WSL — 셸 프로파일(~/.profile, ~/.zshrc 등)에 추가
export GH_PROXY_URL=${B}
export GH_PROXY_TOKEN=<발급받은 토큰>
\`\`\`

\`\`\`powershell
# Windows (PowerShell) — 사용자 환경변수로 영구 설정
[Environment]::SetEnvironmentVariable("GH_PROXY_URL", "${B}", "User")
[Environment]::SetEnvironmentVariable("GH_PROXY_TOKEN", "<발급받은 토큰>", "User")
\`\`\`
`
    : `## 2. 프록시 주소 설정

스킬이 \`GH_PROXY_URL\`로 프록시 주소를 찾습니다. 이 프록시는 토큰이 필요 없습니다.

\`\`\`sh
export GH_PROXY_URL=${B}
\`\`\`
`;

  return `# gh-proxy 설치 가이드

GitHub에 직접 접근할 수 없는 머신의 **Claude Code** 또는 **Codex CLI**가
이 프록시(\`${B}\`)를 통해 \`gh\`·\`git\`·GitHub API를 쓰도록 \`gh-proxy\` 스킬을 설치합니다.

Claude Code와 Codex CLI는 **동일한 스킬 포맷(\`SKILL.md\`)**을 사용하므로, 같은 파일을
각자의 \`skills\` 디렉터리에 넣으면 됩니다.

| 도구 | 설치 위치 |
|------|-----------|
| Claude Code | \`~/.claude/skills/gh-proxy/SKILL.md\` |
| Codex CLI | \`~/.codex/skills/gh-proxy/SKILL.md\` |

## 1. 원터치 설치

### Linux / macOS / WSL

\`\`\`sh
curl -fsSL ${B}/install.sh | sh           # Claude + Codex 모두
curl -fsSL ${B}/install.sh | sh -s -- claude   # Claude만
curl -fsSL ${B}/install.sh | sh -s -- codex    # Codex만
\`\`\`

### Windows (PowerShell)

\`\`\`powershell
irm ${B}/install.ps1 | iex
\`\`\`

> 스크립트를 먼저 검토하려면 [${B}/install.sh](${B}/install.sh) (또는 \`/install.ps1\`)을 열어보세요.
> 스크립트는 토큰을 포함하지 않으며, \`${B}/skill\`에서 스킬 본문을 내려받아 설치합니다.

${tokenSection}
## 3. 수동 설치

### Claude Code

\`\`\`sh
mkdir -p ~/.claude/skills/gh-proxy
curl -fsSL ${B}/skill -o ~/.claude/skills/gh-proxy/SKILL.md
\`\`\`

### Codex CLI

\`\`\`sh
mkdir -p ~/.codex/skills/gh-proxy
curl -fsSL ${B}/skill -o ~/.codex/skills/gh-proxy/SKILL.md
\`\`\`

설치 후 **Claude Code / Codex를 재시작**하면 스킬 목록에 \`gh-proxy\`가 나타납니다.

> **대안(Codex 전역 가이드):** 스킬 대신 Codex의 전역 지침에 넣으려면
> [${B}/skill?codex=1](${B}/skill?codex=1) 의 내용(프론트매터 제거 버전)을
> \`~/.codex/AGENTS.md\`에 붙여넣으세요. 모든 프로젝트에 적용됩니다.

## 4. 확인

\`\`\`sh
curl ${B}/healthz
\`\`\`

설치 후 Claude Code/Codex에게 "gh-proxy로 cli/cli 레포 정보 가져와줘"처럼 요청하면
스킬이 자동으로 발동합니다. 자세한 사용법은 설치된 \`SKILL.md\`와
[API 계약 문서](${B}/contract)를 참고하세요.
`;
}

function handleInstall(req, res) {
  const p = req.url.split('?')[0];
  if (p === '/install.sh') {
    sendBody(req, res, 'text/x-shellscript; charset=utf-8', INSTALL_SH);
    return;
  }
  if (p === '/install.ps1') {
    sendBody(req, res, 'text/plain; charset=utf-8', INSTALL_PS1);
    return;
  }
  sendBody(
    req,
    res,
    'text/html; charset=utf-8',
    htmlPage('gh-proxy 설치 가이드', renderMarkdown(buildInstallGuide())),
  );
}

/* ------------------------------------------------------------------ */
/* Absolute-form plain-HTTP proxying (GET http://github.com/... )      */
/* ------------------------------------------------------------------ */

function handleAbsoluteForm(clientReq, clientRes) {
  let target;
  try {
    target = new URL(clientReq.url);
  } catch {
    sendProxyError(clientRes, 400, 'BAD_REQUEST', 'Unparseable absolute-form URL.');
    return;
  }
  if (target.protocol === 'https:') {
    sendProxyError(
      clientRes,
      400,
      'USE_CONNECT',
      'https:// targets must use the CONNECT method (set HTTPS_PROXY to this server).',
    );
    return;
  }
  if (!hostAllowed(target.hostname)) {
    sendProxyError(
      clientRes,
      403,
      'HOST_NOT_ALLOWED',
      `Host "${target.hostname}" is not in the GitHub allowlist.`,
    );
    return;
  }
  const started = Date.now();
  const headers = cleanRequestHeaders(clientReq.headers);
  headers.host = target.host;
  const upReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: clientReq.method,
      headers,
      agent: upstreamAgentHttp,
      timeout: cfg.upstreamTimeoutMs,
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode, cleanResponseHeaders(upRes.headers));
      upRes.pipe(clientRes);
      log(
        `${remoteAddr(clientReq)} ${clientReq.method} ${clientReq.url} -> ${upRes.statusCode} (${Date.now() - started}ms)`,
      );
    },
  );
  upReq.on('timeout', () => upReq.destroy(new Error('UPSTREAM_TIMEOUT')));
  upReq.on('error', (err) =>
    sendProxyError(clientRes, 502, 'UPSTREAM_ERROR', err.message),
  );
  clientReq.pipe(upReq);
}

/* ------------------------------------------------------------------ */
/* Main request handler                                                */
/* ------------------------------------------------------------------ */

function handleRequest(req, res) {
  // Absolute-form: the client is using us as a plain forward proxy.
  if (/^https?:\/\//i.test(req.url)) {
    if (!proxyAuthOk(req)) {
      res.writeHead(407, {
        'proxy-authenticate': 'Basic realm="gh-proxy"',
        'content-type': 'application/json; charset=utf-8',
        'x-gh-proxy-error': 'PROXY_AUTH_REQUIRED',
      });
      res.end(JSON.stringify({ error: { code: 'PROXY_AUTH_REQUIRED' } }));
      return;
    }
    handleAbsoluteForm(req, res);
    return;
  }

  const pathOnly = req.url.split('?')[0];

  if (pathOnly === '/' && req.method === 'GET') {
    handleServiceInfo(res);
    return;
  }
  if (pathOnly === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
    handleHealthz(req, res);
    return;
  }
  if (
    (pathOnly === '/contract' || pathOnly === '/contract.md') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    handleContract(req, res);
    return;
  }
  if (
    (pathOnly === '/skill' || pathOnly === '/skill.md') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    handleSkill(req, res);
    return;
  }
  if (
    (pathOnly === '/install' ||
      pathOnly === '/install.sh' ||
      pathOnly === '/install.ps1') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    handleInstall(req, res);
    return;
  }

  if (!proxyAuthOk(req)) {
    sendProxyError(
      res,
      401,
      'PROXY_AUTH_REQUIRED',
      'This proxy requires a token. Send it as "X-Proxy-Token: <token>" or "Proxy-Authorization: Bearer <token>".',
    );
    return;
  }

  const route = resolveRoute(req.url);
  if (!route) {
    sendProxyError(
      res,
      404,
      'ROUTE_NOT_FOUND',
      `No proxy route matches "${pathOnly}". See ${PUBLIC_BASE}/ for available endpoints.`,
    );
    return;
  }
  handleReverse(req, res, route);
}

/* ------------------------------------------------------------------ */
/* CONNECT tunnel (forward proxy for HTTPS)                            */
/* ------------------------------------------------------------------ */

function splitHostPort(authority) {
  const m6 = authority.match(/^\[([^\]]+)\]:(\d+)$/); // [v6]:port
  if (m6) return [m6[1], Number(m6[2])];
  const idx = authority.lastIndexOf(':');
  if (idx === -1) return [authority, 443];
  return [authority.slice(0, idx), Number(authority.slice(idx + 1)) || 443];
}

function handleConnect(req, clientSocket, head) {
  const [host, port] = splitHostPort(req.url || '');
  const peer = remoteAddr(clientSocket);

  const refuse = (statusLine, why) => {
    log(`${peer} CONNECT ${req.url} refused: ${why}`);
    clientSocket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  };

  if (!proxyAuthOk(req)) {
    log(`${peer} CONNECT ${req.url} refused: proxy auth`);
    clientSocket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="gh-proxy"\r\n' +
        'Connection: close\r\n\r\n',
    );
    return;
  }
  if (!hostAllowed(host)) return refuse('403 Forbidden', 'host not in allowlist');
  if (!ALLOWED_CONNECT_PORTS.has(port)) {
    return refuse('403 Forbidden', `port ${port} not allowed`);
  }

  const started = Date.now();
  const target = net.connect(port, host);
  const connectTimer = setTimeout(() => {
    target.destroy(new Error('connect timeout'));
  }, cfg.connectTimeoutMs);

  target.on('connect', () => {
    clearTimeout(connectTimer);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) target.write(head);
    target.pipe(clientSocket);
    clientSocket.pipe(target);
    log(`${peer} CONNECT ${host}:${port} established`);
  });

  const teardown = (err) => {
    clearTimeout(connectTimer);
    if (err && !target.writableEnded && Date.now() - started < cfg.connectTimeoutMs + 50 && !clientSocket.destroyed && clientSocket.bytesWritten === 0) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    target.destroy();
    clientSocket.destroy();
  };
  target.on('error', (err) => {
    log(`${peer} CONNECT ${host}:${port} error: ${err.message}`);
    teardown(err);
  });
  clientSocket.on('error', () => teardown());
  target.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => target.destroy());
}

/* ------------------------------------------------------------------ */
/* Server bootstrap                                                    */
/* ------------------------------------------------------------------ */

const server = useTls
  ? https.createServer(
      {
        cert: fs.readFileSync(cfg.tlsCertFile),
        key: fs.readFileSync(cfg.tlsKeyFile),
      },
      handleRequest,
    )
  : http.createServer(handleRequest);

server.on('connect', handleConnect);
server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// A relay daemon should survive stray socket errors.
process.on('uncaughtException', (err) => {
  console.error(new Date().toISOString(), 'uncaught exception:', err);
});

server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`gh-proxy v${VERSION}`);
  console.log(`  listening   : ${useTls ? 'https' : 'http'}://${cfg.bindHost}:${cfg.port}`);
  console.log(`  public base : ${PUBLIC_BASE}`);
  console.log(`  proxy auth  : ${cfg.proxyToken ? 'enabled (PROXY_TOKEN)' : 'disabled'}`);
  console.log(`  gh token    : ${cfg.githubToken ? 'configured (server-side injection)' : 'not configured'}`);
  console.log(`  allowlist   : ${ALLOWED_HOSTS.join(', ')}`);
  console.log('');
  console.log('  Client quick start:');
  if (new URL(PUBLIC_BASE).pathname === '/') {
    console.log(`    HTTPS_PROXY=${PUBLIC_BASE}  gh api rate_limit`);
  } else {
    console.log(`    curl ${PUBLIC_BASE}/api/v3/rate_limit   (path-prefixed deployment: CONNECT/HTTPS_PROXY unavailable)`);
  }
  console.log(`    curl ${PUBLIC_BASE}/healthz`);
});
