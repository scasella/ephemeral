import { shellQuote } from './git-prepare.js';
import { isChangePath } from '../workspace-changes.js';

export const CHANGES_FRAME = '\nEPHEMERAL_CHANGES_COMPLETE\n';

/** Isolated Python gives us descriptor-relative O_NOFOLLOW reads, including every ancestor.
 * Git reads only metadata/HEAD blobs. It never opens the selected working file itself.
 */
export function changeInspectionSource(workspace: string, path?: string): string {
  if (path !== undefined && !isChangePath(path)) throw new Error('Invalid change path.');
  return String.raw`
import os, sys, json, subprocess, selectors, time, stat, difflib, datetime
WORKSPACE = ${JSON.stringify(workspace)}
SELECTED = json.loads(${JSON.stringify(JSON.stringify(path ?? null))})
LIMIT = 65536
DEADLINE = time.monotonic() + 8
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
result = dict(state='unknown', checkedAt=now(), reason='Could not inspect workspace changes. Refresh while the session is running.', headSha=None, files=[], listTruncated=False, selected=None)
def valid_path(path):
    return isinstance(path,str) and 0 < len(path.encode('utf-8')) <= 4096 and '\x00' not in path and not path.startswith('/') and not (len(path)>1 and path[0].isascii() and path[0].isalpha() and path[1]==':') and all(p not in ('','.', '..') for p in path.split('/'))
env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_PAGER='cat', LC_ALL='C')
def git(args, cap=1048576):
    left = min(2.0, DEADLINE-time.monotonic())
    if left <= 0: raise RuntimeError()
    command = ['/usr/bin/git','--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-c','core.pager=cat','-c','diff.external=','-c','submodule.recurse=false'] + args
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    chunks=[]; size=0; end=time.monotonic()+left
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(p.stdout, selectors.EVENT_READ)
            while True:
                remaining=end-time.monotonic()
                if remaining<=0 or not selector.select(remaining): raise RuntimeError()
                block=os.read(p.stdout.fileno(),8192)
                if not block: break
                size+=len(block)
                if size>cap: raise RuntimeError()
                chunks.append(block)
        if p.wait(timeout=max(.001,end-time.monotonic()))!=0: raise RuntimeError()
        return b''.join(chunks)
    finally:
        if p.poll() is None: p.kill(); p.wait()
        p.stdout.close()
def selected(state, reason=None, text=None):
    return dict(path=SELECTED,state=state,text=text,reason=reason,truncated=False)
def read_current(root, path):
    directory=os.dup(root)
    try:
        pieces=path.split('/')
        for piece in pieces[:-1]:
            following=os.open(piece,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory); directory=following
        try:
            fd=os.open(pieces[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        except FileNotFoundError:
            return ('deleted',b'')
        except OSError:
            try:
                if stat.S_ISLNK(os.stat(pieces[-1],dir_fd=directory,follow_symlinks=False).st_mode): return ('symlink',b'')
            except OSError: pass
            return ('unavailable',b'')
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode): return ('unavailable',b'')
            if before.st_size>LIMIT: return ('too_large',b'')
            chunks=[]; size=0
            while size<=LIMIT:
                block=os.read(fd,min(8192,LIMIT+1-size))
                if not block: break
                chunks.append(block); size+=len(block)
            after=os.fstat(fd)
            if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): return ('unavailable',b'')
            return ('too_large',b'') if size>LIMIT else ('file',b''.join(chunks))
        finally: os.close(fd)
    except FileNotFoundError: return ('deleted',b'')
    except OSError: return ('unavailable',b'')
    finally: os.close(directory)
def preview(root, file):
    if 'U' in file['status'] or file['status'] in ('AA','DD'):
        return selected('unavailable','Resolve merge conflicts before reviewing this file.'),None
    current=read_current(root,SELECTED)
    if current[0] in ('symlink','too_large','unavailable'):
        return selected(current[0],dict(symlink='Symbolic links are not followed.',too_large='File exceeds the 64 KiB preview limit.',unavailable='File could not be read safely.')[current[0]]),current
    if file['kind']=='untracked':
        if current[0]=='deleted': return selected('unavailable','The selected file no longer exists.'),current
        base=b''
    else:
        old=file['oldPath'] or SELECTED
        entries=git(['ls-tree','-z','HEAD','--',old])
        base=b''
        if entries:
            records=entries[:-1].split(b'\x00')
            if not entries.endswith(b'\x00') or len(records)!=1: raise RuntimeError()
            metadata,name=records[0].split(b'\t',1)
            mode,kind,sha=metadata.split(b' ')
            if name.decode('utf-8')!=old: raise RuntimeError()
            if mode==b'120000': return selected('symlink','HEAD contains a symbolic link; link targets are not followed.'),current
            if kind!=b'blob': return selected('unavailable','Submodule content is not included in file previews.'),current
            size=git(['cat-file','-s',sha.decode('ascii')],100)
            if int(size)>LIMIT: return selected('too_large','HEAD file exceeds the 64 KiB preview limit.'),current
            base=git(['cat-file','blob',sha.decode('ascii')],LIMIT)
    try:
        if b'\x00' in base or b'\x00' in current[1]: raise UnicodeError()
        before=base.decode('utf-8'); after=current[1].decode('utf-8')
    except UnicodeError: return selected('binary','Binary or non-UTF-8 content has no text preview.'),current
    if file['kind']=='untracked': text=after
    else:
        lines=difflib.unified_diff(before.splitlines(keepends=True),after.splitlines(keepends=True),fromfile='HEAD '+json.dumps(file['oldPath'] or SELECTED),tofile='WORKSPACE '+json.dumps(SELECTED),n=3)
        text=''.join(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n' for line in lines)
        if not text: text='No text content difference from HEAD. Git status: '+file['status']+'.\n'
    if len(text.encode('utf-8'))>LIMIT: return selected('too_large','Combined diff exceeds the 64 KiB preview limit.'),current
    return selected('text',text=text),current
try:
    root=os.open(WORKSPACE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.fchdir(root)
        head=git(['rev-parse','--verify','HEAD'],100).decode('ascii').strip()
        if len(head) not in (40,64) or any(c not in '0123456789abcdef' for c in head): raise RuntimeError()
        status_args=['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=dirty']
        raw=git(status_args)
        if raw and not raw.endswith(b'\x00'): raise RuntimeError()
        records=raw[:-1].split(b'\x00') if raw else []
        files=[]; i=0; seen=set()
        while i<len(records):
            record=records[i].decode('utf-8'); i+=1
            if len(record)<4 or record[2]!=' ': raise RuntimeError()
            code=record[:2]; path=record[3:]; old=None
            if code!='??' and (code=='  ' or any(c not in ' MADRCUT' for c in code)): raise RuntimeError()
            if 'R' in code or 'C' in code:
                old=records[i].decode('utf-8'); i+=1
                if not valid_path(old): raise RuntimeError()
            if not valid_path(path) or path in seen: raise RuntimeError()
            seen.add(path)
            if len(files)<200: files.append(dict(path=path,oldPath=old,status=code,kind='untracked' if code=='??' else 'tracked'))
        result.update(headSha=head,files=files,listTruncated=len(seen)>200)
        observation=None
        if SELECTED is not None:
            file=next((f for f in files if f['path']==SELECTED),None)
            if file is None: result['selected']=selected('unavailable','The selected path is absent from this bounded change list. Refresh the list.')
            else: result['selected'],observation=preview(root,file)
        if git(['rev-parse','--verify','HEAD'],100).decode('ascii').strip()!=head or git(status_args)!=raw: raise RuntimeError()
        if observation is not None and read_current(root,SELECTED)!=observation: raise RuntimeError()
        result.update(state='known',reason=None)
    finally: os.close(root)
except Exception:
    result.update(state='unknown',reason='Could not obtain a stable, bounded change snapshot. Refresh while the session is running.',headSha=None,files=[],listTruncated=False,selected=None)
result['checkedAt']=now()
sys.stdout.write(json.dumps(result,ensure_ascii=True)+'\nEPHEMERAL_CHANGES_COMPLETE\n')
`;
}

export function changeInspectionCommand(workspace: string, path?: string): string {
  return `exec /usr/bin/python3 -I -c ${shellQuote(changeInspectionSource(workspace, path))}`;
}
