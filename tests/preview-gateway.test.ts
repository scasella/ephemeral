import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { PREVIEW_DIAGNOSTIC_HEADER, PREVIEW_DIAGNOSTIC_PATH, previewGatewayInstallCommand, previewGatewayNodeHardeningSource, previewGatewaySource, previewGatewayStartCommand } from '../server/infra/preview-gateway.js';
import vm from 'node:vm';

let directory: string, child: ChildProcess, app: http.Server, ws: WebSocketServer, gatewayPort: number, appPort: number;
let observed: http.IncomingHttpHeaders, redirect: string | null, appStatus: number, holdResponse: boolean;
let observedMethod: string | undefined, observedPath: string | undefined, appRequests: number;
const auth = () => ({ 'e2b-traffic-access-token': 'native-test-secret', 'x-ephemeral-preview-port': String(appPort), origin: `http://localhost:${appPort}` });
async function request(headers: Record<string,string> = auth(), body = '', pathname = '/echo') {
  return new Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}>((resolve,reject) => {
    const req = http.request({hostname:'127.0.0.1',port:gatewayPort,path:pathname,method:body ? 'POST':'GET',headers}, res => {
      let output=''; res.on('data', chunk=>output+=chunk); res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:output}));
    }); req.on('error',reject); req.end(body);
  });
}
beforeEach(async () => {
  observed = {}; redirect = null; appStatus = 200; holdResponse = false; appRequests = 0;
  observedMethod = undefined; observedPath = undefined;
  app = http.createServer((req,res) => {
    appRequests++; observed=req.headers; observedMethod=req.method; observedPath=req.url;
    if (holdResponse) return;
    if (redirect !== null) { res.writeHead(302, { location: redirect }); res.end(); return; }
    observed=req.headers; let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
      res.writeHead(appStatus,{'content-type':'application/json','set-cookie':'stolen=x','e2b-traffic-access-token':'untrusted-header'});
      res.end(JSON.stringify({headers:req.headers,body,url:req.url}));
    });
  });
  appPort=20000+Math.floor(Math.random()*20000); app.listen(appPort,'127.0.0.1'); await once(app,'listening');
  ws=new WebSocketServer({server:app}); ws.on('connection',(socket,req)=>{observed=req.headers;socket.on('message',data=>socket.send(data));});
  directory=await mkdtemp(path.join(tmpdir(),'ephemeral-root-preview-test-'));
  const ready=path.join(directory,'ready.json'), source=path.join(directory,'gateway.mjs');
  await writeFile(source,previewGatewaySource(0,ready)); child=spawn(process.execPath,[source],{stdio:'ignore'});
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {
    try { gatewayPort=(JSON.parse(await readFile(ready,'utf8')) as {port:number}).port; return; }
    catch { if(child.exitCode!==null) throw new Error('Gateway fixture failed to start.'); await new Promise(resolve=>setTimeout(resolve,10)); }
  }
  throw new Error('Gateway fixture did not become ready.');
});
afterEach(async () => {
  if(child && child.exitCode===null) { const exited=once(child,'exit'); child.kill('SIGTERM'); await exited; }
  ws?.clients.forEach(socket=>socket.terminate()); if(ws) await new Promise<void>(resolve=>ws.close(()=>resolve()));
  app?.closeAllConnections(); if(app?.listening) await new Promise<void>(resolve=>app.close(()=>resolve()));
  if(directory) await rm(directory,{recursive:true,force:true});
});

describe('trusted application ingress stripping gateway',()=>{
  it.each([200, 404, 500])('reports HTTP %s without claiming readiness or forwarding credentials', async status => {
    appStatus = status;
    const result = await request({ ...auth(), [PREVIEW_DIAGNOSTIC_HEADER]: '1', authorization: 'private-auth', cookie: 'private-cookie',
      'x-custom-secret': 'private-secret' }, '', PREVIEW_DIAGNOSTIC_PATH);
    expect(result.status).toBe(200); expect(result.headers[PREVIEW_DIAGNOSTIC_HEADER]).toBe('1');
    expect(JSON.parse(result.body)).toEqual({ protocol: 1, state: 'responded', port: appPort, httpStatus: status });
    expect(observedMethod).toBe('HEAD'); expect(observedPath).toBe('/'); expect(appRequests).toBe(1);
    expect(observed.host).toBe(`localhost:${appPort}`);
    for (const name of ['authorization', 'cookie', 'e2b-traffic-access-token', 'x-ephemeral-preview-port', 'origin', PREVIEW_DIAGNOSTIC_HEADER, 'x-custom-secret']) {
      expect(observed).not.toHaveProperty(name);
    }
    expect(result.body).not.toMatch(/private|native-test-secret|healthy|ready/i);
  });
  it('reports a redirect status without following its application destination', async () => {
    redirect = 'http://127.0.0.1:22/private?token=secret';
    const result = await request({ ...auth(), [PREVIEW_DIAGNOSTIC_HEADER]: '1' }, '', PREVIEW_DIAGNOSTIC_PATH);
    expect(JSON.parse(result.body)).toEqual({ protocol: 1, state: 'responded', port: appPort, httpStatus: 302 });
    expect(result.headers).not.toHaveProperty('location'); expect(appRequests).toBe(1);
    expect(result.body).not.toContain('secret');
  });
  it('reports connection refusal separately from HTTP responses', async () => {
    await new Promise<void>(resolve => app.close(() => resolve()));
    const result = await request({ ...auth(), [PREVIEW_DIAGNOSTIC_HEADER]: '1' }, '', PREVIEW_DIAGNOSTIC_PATH);
    expect(JSON.parse(result.body)).toEqual({ protocol: 1, state: 'connection_refused', port: appPort, httpStatus: null });
  });
  it('bounds stalled application diagnostics to three seconds', async () => {
    holdResponse = true; const start = Date.now();
    const result = await request({ ...auth(), [PREVIEW_DIAGNOSTIC_HEADER]: '1' }, '', PREVIEW_DIAGNOSTIC_PATH);
    expect(JSON.parse(result.body)).toEqual({ protocol: 1, state: 'timed_out', port: appPort, httpStatus: null });
    expect(Date.now() - start).toBeLessThan(4500);
  });
  it('requires private authentication, the exact diagnostic path/header, and GET without a body', async () => {
    const diagnostic = { ...auth(), [PREVIEW_DIAGNOSTIC_HEADER]: '1' };
    for (const headers of [auth(), { ...diagnostic, [PREVIEW_DIAGNOSTIC_HEADER]: '2' },
      { 'x-ephemeral-preview-port': String(appPort), [PREVIEW_DIAGNOSTIC_HEADER]: '1' }]) {
      expect((await request(headers, '', PREVIEW_DIAGNOSTIC_PATH)).status).toBe(403);
    }
    expect((await request(diagnostic, 'body', PREVIEW_DIAGNOSTIC_PATH)).status).toBe(403);
    for (const pathname of ['/', `${PREVIEW_DIAGNOSTIC_PATH}?url=http://evil.test`, `${PREVIEW_DIAGNOSTIC_PATH}/other`]) {
      expect((await request(diagnostic, '', pathname)).status).toBe(403);
    }
    expect(appRequests).toBe(0);
  });
  it('strips diagnostic response headers supplied by an application through ordinary preview traffic', async () => {
    app.prependListener('request', (_req, res) => res.setHeader(PREVIEW_DIAGNOSTIC_HEADER, '1'));
    const result = await request();
    expect(result.headers).not.toHaveProperty(PREVIEW_DIAGNOSTIC_HEADER);
  });
  it('strips every credential and forwarding header, rewrites Host/Origin and preserves HTTP bodies',async()=>{
    const result=await request({...auth(),authorization:'Bearer browser-secret',cookie:'session=browser-secret',
      'x-access-token':'envd-secret','x-ephemeral-gateway-token':'git-secret','x-forwarded-host':'evil.test','x-forwarded-for':'1.2.3.4',
      'x-custom-secret':'untrusted-secret',origin:'https://viewer.test','content-type':'text/plain'},'hello app');
    expect(result.status).toBe(200);
    const parsed=JSON.parse(result.body) as {headers:Record<string,string>;body:string};
    expect(parsed.headers).toMatchObject({host:`localhost:${appPort}`,origin:`http://localhost:${appPort}`,'content-type':'text/plain'});
    for(const name of ['authorization','cookie','e2b-traffic-access-token','x-ephemeral-preview-port','x-access-token',
      'x-ephemeral-gateway-token','x-forwarded-host','x-forwarded-for','x-custom-secret']) expect(parsed.headers).not.toHaveProperty(name);
    expect(parsed.body).toBe('hello app'); expect(result.body).not.toContain('native-test-secret');
    expect(result.headers).not.toHaveProperty('set-cookie'); expect(result.headers).not.toHaveProperty('e2b-traffic-access-token');
  });
  it('preserves the controlled selected-port Origin when the viewer supplies no browser Origin', async () => {
    const result = await request(auth(), 'framework form');
    expect(result.status).toBe(200);
    expect(observed.origin).toBe(`http://localhost:${appPort}`); expect(observed.host).toBe(`localhost:${appPort}`);
  });
  it('rejects unauthenticated, reserved, out-of-range and SSRF port expressions',async()=>{
    expect((await request({'x-ephemeral-preview-port':String(appPort)})).status).toBe(403);
    for(const port of ['22','1023','49152','49983','50005','65536','3000@evil.test','http://127.0.0.1:3000','03000','3000.0','-3000']) {
      expect((await request({...auth(),'x-ephemeral-preview-port':port})).status).toBe(403);
    }
    expect(observed).toEqual({});
  });
  it('rejects network-path URLs and oversized bodies before app delivery',async()=>{
    expect((await request(auth(),'','//evil.test/resource')).status).toBe(403);
    expect((await request({...auth(),'content-length':String(16*1024*1024+1)})).status).toBe(413);
    expect(observed).toEqual({});
  });
  it('returns generic failures without reflecting native auth or private SDK data',async()=>{
    const result=await request({...auth(),'x-ephemeral-preview-port':'1024'});
    expect(result.status).toBe(502); expect(result.body).toBe('Application preview is unavailable.');
    expect(result.body).not.toContain('native-test-secret');
  });
  it('rewrites only credential-free absolute redirects to the selected local application', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      redirect = `http://${host}:${appPort}/login?next=%2Fhome#form`;
      const result = await request();
      expect(result.status).toBe(302); expect(result.headers.location).toBe('/login?next=%2Fhome#form');
    }
    for (const location of ['/relative?x=1#part', `http://localhost:${appPort+1}/elsewhere`, `https://localhost:${appPort}/elsewhere`,
      `http://user:secret@localhost:${appPort}/elsewhere`, `http://@localhost:${appPort}/elsewhere`,
      `http:localhost:${appPort}/elsewhere`, 'https://external.example/redirect']) {
      redirect = location; const result = await request();
      expect(result.status).toBe(302); expect(result.headers.location).toBe(location);
    }
  });
  it('tunnels WebSocket messages with native and browser credentials stripped',async()=>{
    const client=new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`,{headers:{...auth(),cookie:'private-cookie',authorization:'private-auth',
      'x-access-token':'envd-secret','x-forwarded-host':'evil.test',origin:'https://viewer.test'}});
    await once(client,'open');
    expect(observed.host).toBe(`localhost:${appPort}`);expect(observed.origin).toBe(`http://localhost:${appPort}`);
    for(const name of ['cookie','authorization','e2b-traffic-access-token','x-ephemeral-preview-port','x-access-token','x-forwarded-host']) expect(observed).not.toHaveProperty(name);
    const received=once(client,'message');client.send('HMR message');expect(String((await received)[0])).toBe('HMR message');
    client.close();await once(client,'close');
  });
  it('refuses unauthenticated WebSocket upgrades',async()=>{
    const client=new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`,{headers:{'x-ephemeral-preview-port':String(appPort)}});
    client.on('error',()=>{});
    const response=await once(client,'unexpected-response');
    expect((response[1] as http.IncomingMessage).statusCode).toBe(403);client.terminate();expect(observed).toEqual({});
  });
  it('generates fixed, root-owned launch and readiness checks without credential material',()=>{
    const install=previewGatewayInstallCommand(),start=previewGatewayStartCommand(),source=previewGatewaySource();
    expect(install).toContain('install -d -m 700 -o root -g root'); expect(install).toContain('test ! -e');
    expect(start).toContain('chmod 600');expect(start).toContain('env -i');expect(start).toContain('/proc/');
    expect(start).toContain('info.uid!==0');expect(start).toContain('info.port!==49152');expect(start).toContain('argv.length!==2');
    expect(source).toContain("server.listen(port, '0.0.0.0'"); expect(source).toContain("hostname:'127.0.0.1'");
    for(const artifact of [install,start,source]) for(const secret of ['native-test-secret','API-SECRET','envd-secret','git-secret']) expect(artifact).not.toContain(secret);
  });
  it('hardens root-owned mode777 Node paths while rejecting unsafe ownership and symlinks', () => {
    const executable='/usr/local/bin/node';
    const fixture=(changes:Record<string,{uid?:number;mode?:number;symlink?:boolean;directory?:boolean}|undefined>={})=>{
      const entries=new Map(['/','/usr','/usr/local','/usr/local/bin',executable].map(file=>[file,
        {uid:0,mode:file.startsWith('/usr/local')?0o777:0o755,symlink:false,directory:file!==executable,...changes[file]}]));
      const changed:string[]=[];
      const fakeFs={lstatSync:(file:string)=>{
        const entry=entries.get(file)!;return{...entry,isFile:()=>!entry.directory,isDirectory:()=>entry.directory,isSymbolicLink:()=>entry.symlink};
      },chmodSync:(file:string,mode:number)=>{entries.get(file)!.mode=mode;changed.push(file);}};
      const execute=()=>vm.runInNewContext(previewGatewayNodeHardeningSource(),{
        require:(name:string)=>name==='fs'?fakeFs:path,process:{execPath:executable,argv:['node',executable],exit:()=>{throw new Error('Unsafe Node path.');}}});
      return{entries,changed,execute};
    };
    const safe=fixture();safe.execute();
    for(const entry of safe.entries.values()) expect(entry.mode).toBe(0o755);
    for(const changes of [{'/usr/local':{uid:1000}}, {'/usr/local/bin':{symlink:true}}, {[executable]:{symlink:true}}, {'/usr':{directory:false}}]) {
      const unsafe=fixture(changes);expect(unsafe.execute).toThrow('Unsafe Node path.');expect(unsafe.changed).toEqual([]);
    }
  });
});
