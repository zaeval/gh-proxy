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
    },
    docs: 'https://github.com/zaeval/gh-proxy/blob/main/docs/API-CONTRACT.md',
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
