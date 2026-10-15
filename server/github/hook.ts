/** Server-owned pre-receive hook. The VM never sees this script or its environment. */
export const PRE_RECEIVE = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
function reject(message) { process.stderr.write('Ephemeral: ' + message + '\n'); process.exit(1); }
const input = fs.readFileSync(0, 'utf8');
if (input.length > 8192) reject('too many ref updates');
const lines = input.trim().split('\n');
if (lines.length !== 1) reject('only one session branch update is permitted');
const parts = lines[0].split(' ');
if (parts.length !== 3) reject('invalid ref update');
const [oldOid, newOid, ref] = parts;
const zero = '0'.repeat(40);
if (!/^[a-f0-9]{40}$/.test(oldOid) || !/^[a-f0-9]{40}$/.test(newOid)) reject('invalid object id');
if (ref !== 'refs/heads/' + process.env.EP_BRANCH) reject('only the assigned session branch may be pushed');
if (newOid === zero) reject('branch deletion is disabled');
const run = args => spawnSync('git', args, { env: process.env, encoding: 'utf8', timeout: 90000, maxBuffer: 1048576 });
if (run(['cat-file', '-e', newOid + '^{commit}']).status !== 0) reject('branch must point to a commit');
if (oldOid === zero && !process.env.EP_BASE_OID) reject(process.env.EP_BASE_ERROR || 'the original clone base is unavailable; start a fresh session');
const ancestor = oldOid === zero ? process.env.EP_BASE_OID : oldOid;
if (!ancestor || run(['merge-base', '--is-ancestor', ancestor, newOid]).status !== 0) reject('non-fast-forward push is disabled');
const request = http.request({ socketPath: process.env.EP_GATE_SOCKET, path: '/', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.EP_GATE_SECRET } }, response => {
  response.resume();
  response.on('end', () => {
    if (response.statusCode !== 204) reject('session expired, disabled, or no longer authorized');
    // The source can read Git's quarantined incoming objects. Do not remove GIT_OBJECT_DIRECTORY.
    // No upstream ref is updated until the entire incoming ref set and ancestry have been checked.
    const result = run(['-c', 'credential.helper=', '-c', 'core.askPass=' + process.env.GIT_ASKPASS,
      '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', 'push', '--porcelain',
      '--force-with-lease=' + ref + ':' + (oldOid === zero ? '' : oldOid), process.env.EP_UPSTREAM, newOid + ':' + ref]);
    if (result.status !== 0) reject('upstream push rejected; fetch and retry (repository rules or concurrent update)');
  });
});
request.on('error', () => reject('authorization service unavailable'));
request.setTimeout(20000, () => { request.destroy(); reject('authorization timed out'); });
request.end(JSON.stringify({ sessionId: process.env.EP_SESSION }));
`;
