import { shellQuote } from './git-prepare.js';

export const PREVIEW_GATEWAY_PORT = 49152;
export const PREVIEW_GATEWAY_VERSION = '1';
export const PREVIEW_DIAGNOSTIC_PATH = '/__ephemeral/readiness';
export const PREVIEW_DIAGNOSTIC_HEADER = 'x-ephemeral-preview-diagnostic';
export const PREVIEW_DIAGNOSTIC_TIMEOUT_MS = 3000;
export const PREVIEW_GATEWAY_DIRECTORY = '/opt/ephemeral-preview';
export const PREVIEW_GATEWAY_SOURCE = `${PREVIEW_GATEWAY_DIRECTORY}/gateway.mjs`;
export const PREVIEW_GATEWAY_READY = `${PREVIEW_GATEWAY_DIRECTORY}/ready.json`;

/** No credentials are embedded. Native ingress auth is consumed only in root memory. */
export function previewGatewaySource(port = PREVIEW_GATEWAY_PORT, readyPath = PREVIEW_GATEWAY_READY): string {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway listener.');
  return `import http from 'node:http';
import fs from 'node:fs';
const port = ${port};
const readyPath = ${JSON.stringify(readyPath)};
const version = ${JSON.stringify(PREVIEW_GATEWAY_VERSION)};
const diagnosticPath = ${JSON.stringify(PREVIEW_DIAGNOSTIC_PATH)};
const diagnosticHeader = ${JSON.stringify(PREVIEW_DIAGNOSTIC_HEADER)};
const REQUEST_HEADERS = ['accept','accept-encoding','accept-language','cache-control','content-type','content-length','range','if-none-match','if-modified-since'];
const RESPONSE_HEADERS = ['content-type','content-length','content-encoding','cache-control','etag','last-modified','accept-ranges','content-range','vary','expires','location'];
const WS_HEADERS = ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'];
const active = new Set();
const MAX_BODY = 16 * 1024 * 1024, MAX_RESPONSE = 64 * 1024 * 1024;
function failure(res, status) { if (!res.headersSent) { res.writeHead(status, {'content-type':'text/plain','cache-control':'no-store'}); res.end('Application preview is unavailable.'); } else res.destroy(); }
function target(req) {
  const token = req.headers['e2b-traffic-access-token'], raw = req.headers['x-ephemeral-preview-port'];
  if (typeof token !== 'string' || !/^[\\x21-\\x7e]{1,4096}$/.test(token) || typeof raw !== 'string' || !/^[1-9][0-9]{3,4}$/.test(raw)) return null;
  const appPort = Number(raw);
  if (appPort < 1024 || appPort > 49151 || !req.url || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\\\\\r\\n]/.test(req.url)) return null;
  return appPort;
}
function headers(req, appPort, websocket = false) {
  const selected = {};
  for (const name of REQUEST_HEADERS) if (typeof req.headers[name] === 'string') selected[name] = req.headers[name];
  selected.host = 'localhost:' + appPort;
  if (req.headers.origin) selected.origin = 'http://localhost:' + appPort;
  if (websocket) { for (const name of WS_HEADERS) if (typeof req.headers[name] === 'string') selected[name] = req.headers[name]; selected.connection = 'Upgrade'; selected.upgrade = 'websocket'; }
  return selected;
}
function location(value, appPort) {
  try {
    const localOrigins = ['http://localhost:' + appPort, 'http://127.0.0.1:' + appPort];
    if (!localOrigins.some(origin => value === origin || ['/', '?', '#'].some(separator => value.startsWith(origin + separator)))) return value;
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password && parsed.protocol === 'http:' && parsed.port === String(appPort) &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return parsed.pathname + parsed.search + parsed.hash;
  } catch {}
  return value;
}
function track(socket) {
  active.add(socket); socket.on('close', () => active.delete(socket));
  socket.on('error', () => {}); socket.setTimeout(120000, () => socket.destroy());
}
function diagnose(req, res, appPort) {
  let settled = false;
  const finish = (state, httpStatus = null) => {
    if (settled) return; settled = true; clearTimeout(timer);
    upstream.destroy();
    if (!res.destroyed) {
      res.writeHead(200, {'content-type':'application/json','cache-control':'no-store',[diagnosticHeader]:'1'});
      res.end(JSON.stringify({protocol:1,state,port:appPort,httpStatus}));
    }
  };
  // No application credentials, request body, redirects, or application response body are consumed.
  const upstream = http.request({hostname:'127.0.0.1',port:appPort,path:'/',method:'HEAD',headers:{host:'localhost:'+appPort},agent:false,maxHeaderSize:16384}, reply => {
    const status = reply.statusCode; reply.destroy();
    if (Number.isInteger(status) && status >= 200 && status <= 599) finish('responded', status);
    else finish('unknown');
  });
  const timer = setTimeout(() => finish('timed_out'), ${PREVIEW_DIAGNOSTIC_TIMEOUT_MS});
  upstream.on('error', error => finish(error.code === 'ECONNREFUSED' ? 'connection_refused' : 'unknown'));
  req.on('aborted', () => { settled = true; clearTimeout(timer); upstream.destroy(); });
  res.on('close', () => { settled = true; clearTimeout(timer); upstream.destroy(); });
  req.resume(); upstream.end();
}
const server = http.createServer({maxHeaderSize:16384}, (req, res) => {
  const appPort = target(req);
  if (appPort === null) { failure(res, 403); req.resume(); return; }
  if (req.url === diagnosticPath || req.headers[diagnosticHeader] !== undefined) {
    if (req.url !== diagnosticPath || req.method !== 'GET' || req.headers[diagnosticHeader] !== '1' ||
      req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) !== 0) {
      failure(res, 403); req.resume(); return;
    }
    diagnose(req, res, appPort); return;
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) { failure(res, 413); req.resume(); return; }
  let body = 0, responseBytes = 0;
  const upstream = http.request({hostname:'127.0.0.1',port:appPort,path:req.url,method:req.method,headers:headers(req,appPort),agent:false,maxHeaderSize:16384}, reply => {
    const selected = {};
    for (const name of RESPONSE_HEADERS) if (typeof reply.headers[name] === 'string') selected[name] = reply.headers[name];
    if (selected.location) selected.location = location(selected.location, appPort);
    res.writeHead(reply.statusCode || 502, selected);
    reply.on('data', chunk => { responseBytes += chunk.length; if (responseBytes > MAX_RESPONSE) { reply.destroy(); res.destroy(); } });
    reply.on('error', () => failure(res, 502)); reply.pipe(res);
  });
  upstream.setTimeout(30000, () => { upstream.destroy(); failure(res, 504); });
  upstream.on('error', () => failure(res, 502));
  req.on('data', chunk => { body += chunk.length; if (body > MAX_BODY) { upstream.destroy(); failure(res,413); req.destroy(); } });
  req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
});
server.maxConnections = 64; server.maxHeadersCount = 80; server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
server.on('connection', socket => { if (active.size >= 64) socket.destroy(); else track(socket); });
server.on('clientError', (_error, socket) => socket.destroy());
server.on('upgrade', (req, socket, head) => {
  const appPort = target(req);
  if (appPort === null || req.url === diagnosticPath || req.headers[diagnosticHeader] !== undefined || head.length > 65536 || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n'); return; }
  const upstream = http.request({hostname:'127.0.0.1',port:appPort,path:req.url,method:'GET',headers:headers(req,appPort,true),agent:false,maxHeaderSize:16384});
  const timer = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 10000);
  const fail = () => { clearTimeout(timer); upstream.destroy(); socket.destroy(); };
  upstream.on('error', fail); socket.on('close', fail);
  upstream.on('response', reply => { reply.destroy(); fail(); });
  upstream.on('upgrade', (reply, peer, initial) => {
    clearTimeout(timer);
    if (reply.statusCode !== 101 || initial.length > 65536) { peer.destroy(); fail(); return; }
    peer.on('error', () => socket.destroy()); peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy());
    peer.setTimeout(120000, () => peer.destroy());
    let handshake = 'HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n';
    for (const name of ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions']) {
      const value = reply.headers[name]; if (typeof value === 'string' && !/[\\r\\n]/.test(value)) handshake += name + ': ' + value + '\\r\\n';
    }
    socket.write(handshake + '\\r\\n'); if (initial.length) socket.write(initial); if (head.length) peer.write(head);
    socket.pipe(peer); peer.pipe(socket);
  }); upstream.end();
});
server.on('error', () => process.exit(1));
server.listen(port, '0.0.0.0', () => { fs.writeFileSync(readyPath, JSON.stringify({version,pid:process.pid,uid:process.getuid?.(),port:server.address().port}), {mode:0o600,flag:'wx'}); });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { for (const socket of active) socket.destroy(); server.close(() => process.exit(0)); });
`;
}

export function previewGatewayInstallCommand(): string {
  const parentCheck = `const fs=require('fs');for(const p of ['/','/opt']){const s=fs.lstatSync(p);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022))process.exit(1);}`;
  return `set -eu; test "$(id -u)" -eq 0; node -e ${shellQuote(parentCheck)}; test ! -e ${shellQuote(PREVIEW_GATEWAY_DIRECTORY)}; ` +
    `install -d -m 700 -o root -g root ${shellQuote(PREVIEW_GATEWAY_DIRECTORY)}; test ! -e ${shellQuote(PREVIEW_GATEWAY_SOURCE)}; test ! -e ${shellQuote(PREVIEW_GATEWAY_READY)}`;
}

/** The operator's image may ship root-owned Node paths with mode 777. Harden them before user work. */
export function previewGatewayNodeHardeningSource(): string {
  return `const fs=require('fs'),path=require('path');const executable=process.argv[1];` +
    `if(!executable||!path.isAbsolute(executable)||path.normalize(executable)!==executable||executable!==process.execPath)process.exit(1);` +
    `const entries=[];let p=executable;for(;;){const s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==0||` +
    `(p===executable?!s.isFile():!s.isDirectory()))process.exit(1);entries.push([p,s.mode&0o777]);if(p==='/')break;p=path.dirname(p);}` +
    `for(const [file,mode] of entries){fs.chmodSync(file,mode&~0o022);const s=fs.lstatSync(file);if(s.uid!==0||s.isSymbolicLink()||(s.mode&0o022))process.exit(1);}`;
}

export function previewGatewayStartCommand(): string {
  const verify = `const fs=require('fs');const p=${JSON.stringify(PREVIEW_GATEWAY_SOURCE)},r=${JSON.stringify(PREVIEW_GATEWAY_READY)};` +
    `for(const f of [p,r]){const s=fs.lstatSync(f);if(!s.isFile()||s.uid!==0||(s.mode&0o077))process.exit(1);}` +
    `const info=JSON.parse(fs.readFileSync(r,'utf8'));if(info.version!=='1'||info.uid!==0||info.port!==49152||!Number.isSafeInteger(info.pid))process.exit(1);` +
    `const status=fs.readFileSync('/proc/'+info.pid+'/status','utf8');if(!/^Uid:\\s+0\\s+0\\s+0\\s+0$/m.test(status))process.exit(1);` +
    `const argv=fs.readFileSync('/proc/'+info.pid+'/cmdline','utf8').split('\\0').filter(Boolean);if(argv.length!==2||argv[1]!==p)process.exit(1);`;
  const executableCheck = `const fs=require('fs'),path=require('path');let p=fs.realpathSync(process.execPath);for(;;){const s=fs.lstatSync(p);if(s.uid!==0||(s.mode&0o022))process.exit(1);if(p==='/')break;p=path.dirname(p);}`;
  return `set -eu; chmod 600 ${shellQuote(PREVIEW_GATEWAY_SOURCE)}; test "$(stat -c %u ${shellQuote(PREVIEW_GATEWAY_SOURCE)})" -eq 0; ` +
    `node_path=$(command -v node); "$node_path" -e ${shellQuote(previewGatewayNodeHardeningSource())} "$node_path"; "$node_path" -e ${shellQuote(executableCheck)}; ` +
    `nohup env -i PATH=/usr/local/bin:/usr/bin:/bin "$node_path" ${shellQuote(PREVIEW_GATEWAY_SOURCE)} >/dev/null 2>&1 </dev/null & ` +
    `for attempt in 1 2 3 4 5 6 7 8 9 10; do if test -f ${shellQuote(PREVIEW_GATEWAY_READY)}; then break; fi; sleep 0.1; done; node -e ${shellQuote(verify)}`;
}
