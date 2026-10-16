import { shellQuote } from './git-prepare.js';
import { validateWorkspacePath, validateWorkspaceWrite } from '../workspace-files.js';
import type { WriteWorkspaceFileInput } from '../../shared/workspace-files.js';
export const WORKSPACE_FILES_FRAME = '\nEPHEMERAL_FILES_COMPLETE\n';
export type WorkspaceFileRequest = { operation: 'list' | 'read'; path: string } | ({ operation: 'write' } & WriteWorkspaceFileInput);
/** The alternate root is a local filesystem test seam; production commands always use the fixed repository root.
 * Descriptor-relative no-follow operations prevent symlink traversal. Atomic replacement avoids partial files.
 * Directory locks serialize this helper's saves; arbitrary same-user writers do not honor those locks. We
 * recheck content, inode, metadata and ancestor identities immediately before rename, but Linux provides no
 * conditional rename by content hash. An external writer in that final check/rename window can still win/lose.
 */
export function workspaceFilesSource(request: WorkspaceFileRequest, root = '/home/user/workspace', inputFromStdin = false): string {
  if (request.operation === 'write') { const { operation: _, ...input } = request; validateWorkspaceWrite(input); }
  else validateWorkspacePath(request.path, request.operation === 'list');
  return String.raw`
import os, sys, json, stat, hashlib, errno, signal, time, fcntl, secrets, unicodedata
ROOT = ${JSON.stringify(root)}
LIMIT = 131072
DEADLINE = time.monotonic()+8
class Failure(Exception):
    def __init__(self,status,code): self.status=status; self.code=code
def fail(status,code): raise Failure(status,code)
def deadline(*args): fail(503,'unavailable')
signal.signal(signal.SIGALRM,deadline)
signal.signal(signal.SIGTERM,deadline)
signal.alarm(8)
def tick():
    if time.monotonic()>DEADLINE: deadline()
def valid(path,root=False):
    if not isinstance(path,str): return False
    try: data=path.encode('utf-8','strict')
    except UnicodeError: return False
    if len(data)>1024 or (not path and not root) or '\\' in path or any(unicodedata.category(c)=='Cc' for c in path): return False
    if len(path)>1 and path[0].isascii() and path[0].isalpha() and path[1]==':': return False
    return not path or (len(path.split('/'))<=32 and all(p not in ('','.','..') and p.lower()!='.git' for p in path.split('/')))
def identity(st): return (st.st_dev,st.st_ino)
def snapshot(st): return (st.st_dev,st.st_ino,st.st_mode,st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
def open_directory(parent,name):
    return os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
def root_fd():
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in ROOT.strip('/').split('/'):
            tick(); child=open_directory(fd,part); os.close(fd); fd=child
        return fd
    except BaseException: os.close(fd); raise
def walk(root,parts):
    fd=os.dup(root)
    try:
        for part in parts:
            tick(); child=open_directory(fd,part); os.close(fd); fd=child
        return fd
    except BaseException: os.close(fd); raise
def verify_parent(root,parent,parts):
    check=root_fd()
    try:
        if identity(os.fstat(check))!=identity(os.fstat(root)): fail(409,'conflict')
        current=walk(check,parts)
        try:
            if identity(os.fstat(current))!=identity(os.fstat(parent)): fail(409,'conflict')
        finally: os.close(current)
    finally: os.close(check)
def text(data):
    try: content=data.decode('utf-8','strict')
    except UnicodeError: fail(415,'unsupported')
    if any(unicodedata.category(c)=='Cc' and c not in '\t\n\r' for c in content): fail(415,'unsupported')
    return content
def read_at(parent,name):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: fail(415,'unsupported')
        if before.st_size>LIMIT: fail(413,'too_large')
        data=b''
        while len(data)<=LIMIT:
            tick(); block=os.read(fd,min(8192,LIMIT+1-len(data)))
            if not block: break
            data+=block
        if len(data)>LIMIT: fail(413,'too_large')
        after=os.fstat(fd)
        if snapshot(before)!=snapshot(after) or snapshot(after)!=snapshot(os.stat(name,dir_fd=parent,follow_symlinks=False)): fail(409,'conflict')
        content=text(data)
        return content,hashlib.sha256(data).hexdigest(),after
    finally: os.close(fd)
def run():
    if not isinstance(REQUEST,dict): fail(400,'invalid_request')
    path=REQUEST.get('path'); op=REQUEST.get('operation')
    if op not in ('list','read','write') or not valid(path,op=='list'): fail(400,'invalid_path')
    root=root_fd()
    try:
        if op=='list':
            directory=walk(root,path.split('/') if path else [])
            try:
                entries=[]; truncated=False; scanned=0
                with os.scandir(directory) as items:
                    for item in items:
                        tick(); scanned+=1
                        if scanned>1000 or len(entries)>=200: truncated=True; break
                        name=item.name; relative=(path+'/' if path else '')+name
                        if not valid(relative): continue
                        try:
                            st=item.stat(follow_symlinks=False)
                            kind='directory' if stat.S_ISDIR(st.st_mode) else ('file' if stat.S_ISREG(st.st_mode) and st.st_nlink==1 else 'unavailable')
                        except OSError: kind='unavailable'
                        entries.append(dict(name=name,path=relative,kind=kind))
                verify_parent(root,directory,path.split('/') if path else [])
                entries.sort(key=lambda e:(e['kind']!='directory',e['name']))
                return dict(path=path,entries=entries,truncated=truncated,simulation=False)
            finally: os.close(directory)
        parts=path.split('/'); name=parts.pop(); parent=walk(root,parts)
        try:
            if op=='read':
                content,version,_=read_at(parent,name); verify_parent(root,parent,parts)
                return dict(path=path,content=content,version=version,simulation=False)
            content=REQUEST.get('content'); expected=REQUEST.get('expectedVersion')
            if not isinstance(content,str) or (expected is not None and (not isinstance(expected,str) or len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected))): fail(400,'invalid_request')
            try: data=content.encode('utf-8','strict')
            except UnicodeError: fail(400,'invalid_request')
            if len(data)>LIMIT: fail(413,'too_large')
            text(data)
            # A directory inode lock needs no attacker-controlled lock file and never truncates a target.
            while True:
                try: fcntl.flock(parent,fcntl.LOCK_EX|fcntl.LOCK_NB); break
                except BlockingIOError: tick(); time.sleep(.01)
            temp=None; tempfd=None
            try:
                verify_parent(root,parent,parts)
                if expected is None:
                    try: os.stat(name,dir_fd=parent,follow_symlinks=False)
                    except FileNotFoundError: pass
                    else: fail(409,'conflict')
                    previous=None; mode=0o644
                else:
                    try: _,version,previous=read_at(parent,name)
                    except FileNotFoundError: fail(409,'conflict')
                    if version!=expected: fail(409,'conflict')
                    mode=stat.S_IMODE(previous.st_mode)&0o777
                temp='.ephemeral-save-'+secrets.token_hex(16)
                tempfd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
                offset=0
                while offset<len(data): tick(); offset+=os.write(tempfd,data[offset:])
                os.fchmod(tempfd,mode); os.fsync(tempfd)
                verify_parent(root,parent,parts)
                if snapshot(os.fstat(tempfd))!=snapshot(os.stat(temp,dir_fd=parent,follow_symlinks=False)): fail(409,'conflict')
                if expected is None:
                    # link is an atomic no-replace publication; an existing file always wins.
                    try: os.link(temp,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
                    except FileExistsError: fail(409,'conflict')
                else:
                    try: _,version,current=read_at(parent,name)
                    except FileNotFoundError: fail(409,'conflict')
                    if version!=expected or snapshot(current)!=snapshot(previous): fail(409,'conflict')
                    os.rename(temp,name,src_dir_fd=parent,dst_dir_fd=parent); temp=None
                return dict(path=path,content=content,version=hashlib.sha256(data).hexdigest(),simulation=False)
            finally:
                if tempfd is not None: os.close(tempfd)
                if temp is not None:
                    try: os.unlink(temp,dir_fd=parent)
                    except FileNotFoundError: pass
                fcntl.flock(parent,fcntl.LOCK_UN)
        finally: os.close(parent)
    finally: os.close(root)
def request_input():
${inputFromStdin ? String.raw`    # JSON.stringify escapes embedded newlines. Read exactly one bounded frame;
    # do not wait for EOF, which may be retained by the command transport.
    line=sys.stdin.buffer.readline(1000001)
    if len(line)>1000000 or not line.endswith(b'\n'): fail(400,'invalid_request')
    try: return json.loads(line)
    except (ValueError,UnicodeError): fail(400,'invalid_request')` : `    return json.loads(${JSON.stringify(JSON.stringify(request))})`}
try:
    REQUEST=request_input()
    result=dict(ok=True,value=run())
except Failure as e: result=dict(ok=False,status=e.status,code=e.code)
except OSError as e:
    if e.errno==errno.ENOENT: status,code=404,'not_found'
    elif e.errno in (errno.ELOOP,errno.ENOTDIR,errno.EISDIR,errno.ENXIO): status,code=415,'unsupported'
    else: status,code=503,'unavailable'
    result=dict(ok=False,status=status,code=code)
except BaseException: result=dict(ok=False,status=503,code='unavailable')
signal.alarm(0)
sys.stdout.write(json.dumps(result,ensure_ascii=True,separators=(',',':'))+${JSON.stringify(WORKSPACE_FILES_FRAME)})
`;
}
export function workspaceFilesCommand(request: WorkspaceFileRequest): string {
  return `exec python3 -I -c ${shellQuote(workspaceFilesSource(request, '/home/user/workspace', true))}`;
}
