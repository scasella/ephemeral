import { shellQuote } from './git-prepare.js';
import { isChangePath } from '../workspace-changes.js';

export const CHANGES_FRAME = '\nEPHEMERAL_CHANGES_COMPLETE\n';

/** Selected preview bytes use descriptor-relative O_NOFOLLOW reads, including every ancestor.
 * Git status and HEAD reads use isolated metadata/configuration without repository filters.
 */
export function changeInspectionSource(workspace: string, path?: string): string {
  if (path !== undefined && !isChangePath(path)) throw new Error('Invalid change path.');
  return String.raw`
import os, sys, json, subprocess, selectors, time, stat, difflib, datetime, tempfile
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
env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_PAGER='cat', GIT_ATTR_NOSYSTEM='1', LC_ALL='C')
inspection_env=None
def git(args, cap=1048576):
    left = min(2.0, DEADLINE-time.monotonic())
    if left <= 0: raise RuntimeError()
    command = ['/usr/bin/git','--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-c','core.pager=cat','-c','diff.external=','-c','submodule.recurse=false','-c','core.attributesFile=/dev/null'] + args
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=inspection_env or env)
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
def metadata_bytes(path, cap=16777216):
    try: fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError: return None
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size>cap: raise RuntimeError()
        chunks=[]; size=0
        while size<=cap:
            block=os.read(fd,min(8192,cap+1-size))
            if not block: break
            chunks.append(block); size+=len(block)
        after=os.fstat(fd)
        if size>cap or (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise RuntimeError()
        return b''.join(chunks)
    finally: os.close(fd)
def isolated_metadata(head):
    global inspection_env
    # A mutable repository config cannot be fenced by enumerating current filter
    # names. Use an isolated Git directory with no configured filter commands.
    # Worktree attributes remain data only, even if a new filter appears mid-read.
    index_path=os.path.abspath(git(['rev-parse','--git-path','index'],8192).decode('utf-8').removesuffix('\n'))
    objects=os.path.abspath(git(['rev-parse','--git-path','objects'],8192).decode('utf-8').removesuffix('\n'))
    info_path=os.path.abspath(git(['rev-parse','--git-path','info/attributes'],8192).decode('utf-8').removesuffix('\n'))
    exclude_path=os.path.abspath(git(['rev-parse','--git-path','info/exclude'],8192).decode('utf-8').removesuffix('\n'))
    algorithm=git(['rev-parse','--show-object-format'],100).decode('ascii').strip()
    if algorithm not in ('sha1','sha256'): raise RuntimeError()
    index=metadata_bytes(index_path)
    index_stat=os.stat(index_path,follow_symlinks=False) if index is not None else None
    info=metadata_bytes(info_path,65536)
    exclude=metadata_bytes(exclude_path,65536)
    directory=tempfile.TemporaryDirectory(prefix='ephemeral-review-')
    try:
        with open(os.path.join(directory.name,'HEAD'),'w') as target: target.write(head+'\n')
        config='[core]\nrepositoryformatversion = '+('1' if algorithm=='sha256' else '0')+'\nbare = false\n'
        if algorithm=='sha256': config+='[extensions]\nobjectFormat = sha256\n'
        with open(os.path.join(directory.name,'config'),'w') as target: target.write(config)
        # Git requires an objects and refs directory even with an explicit store.
        os.mkdir(os.path.join(directory.name,'objects')); os.mkdir(os.path.join(directory.name,'refs'))
        if index is not None:
            snapshot_index=os.path.join(directory.name,'index')
            with open(snapshot_index,'wb') as target: target.write(index)
            # Preserve Git's racy-stat detection: a fresh copy timestamp could
            # hide a same-size edit made within the source index's timestamp.
            os.utime(snapshot_index,ns=(index_stat.st_atime_ns,index_stat.st_mtime_ns))
        if info is not None or exclude is not None:
            os.mkdir(os.path.join(directory.name,'info'))
        for name,content in (('attributes',info),('exclude',exclude)):
            if content is not None:
                with open(os.path.join(directory.name,'info',name),'wb') as target: target.write(content)
        inspection_env=dict(env,GIT_DIR=directory.name,GIT_WORK_TREE=os.getcwd(),GIT_OBJECT_DIRECTORY=objects)
        return directory,index_path,index,info_path,info,exclude_path,exclude
    except Exception:
        directory.cleanup(); raise
def attributes(path):
    raw=git(['check-attr','-z','text','eol','filter','working-tree-encoding','ident','diff','--',path],65536)
    pieces=raw.split(b'\x00')
    if len(pieces)!=19 or pieces[-1]!=b'': raise RuntimeError()
    values={}
    for i in range(0,18,3):
        if pieces[i].decode('utf-8')!=path: raise RuntimeError()
        values[pieces[i+1].decode('ascii')]=pieces[i+2].decode('utf-8')
    return values
def comparison_text(before, after, file):
    attrs=attributes(SELECTED)
    old=file['oldPath'] or SELECTED
    same=old==SELECTED or attributes(old)==attrs
    unsupported=attrs['diff']!='unspecified' or any(attrs[name] not in ('unspecified','unset') for name in ('filter','working-tree-encoding','ident'))
    # Normalize only declarative, explicit EOL rules with canonical LF HEAD text.
    # Mixed EOL or lone CR stays raw, as do custom filters and encodings.
    mixed=lambda text: '\r\n' in text and '\n' in text.replace('\r\n','')
    lone_cr=lambda text: '\r' in text.replace('\r\n','')
    if same and not unsupported and attrs['eol'] in ('lf','crlf') and attrs['text'] in ('set','unspecified') and '\r' not in before and not mixed(after) and not lone_cr(after):
        return before,after.replace('\r\n','\n'),'EOL-normalized text comparison: explicit eol='+attrs['eol']+' attribute; CRLF is compared as LF. Repository filters and text conversions are not run.'
    return before,after,'Raw UTF-8 byte comparison against HEAD. EOL normalization, repository filters, working-tree encodings, ident and textconv are not applied; Git’s transformed diff may differ.'
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
    reason=None
    if file['kind']=='untracked': text=after
    else:
        before,after,reason=comparison_text(before,after,file)
        # Split only at LF: str.splitlines would also treat lone CR and Unicode
        # separators as line endings, obscuring the original byte differences.
        split=lambda text: [line+'\n' for line in text.split('\n')[:-1]]+([text.rsplit('\n',1)[-1]] if text and not text.endswith('\n') else [])
        lines=difflib.unified_diff(split(before),split(after),fromfile='HEAD '+json.dumps(file['oldPath'] or SELECTED),tofile='WORKSPACE '+json.dumps(SELECTED),n=3)
        text=''.join(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n' for line in lines)
        if not text: text='No text content difference from HEAD. Git status: '+file['status']+'.\n'
    if len(text.encode('utf-8'))>LIMIT: return selected('too_large','Combined diff exceeds the 64 KiB preview limit.'),current
    return selected('text',reason=reason,text=text),current
try:
    root=os.open(WORKSPACE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.fchdir(root)
        head=git(['rev-parse','--verify','HEAD'],100).decode('ascii').strip()
        if len(head) not in (40,64) or any(c not in '0123456789abcdef' for c in head): raise RuntimeError()
        metadata,index_path,index,info_path,info,exclude_path,exclude=isolated_metadata(head)
        status_args=['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']
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
        if git(status_args)!=raw or metadata_bytes(index_path)!=index or metadata_bytes(info_path,65536)!=info: raise RuntimeError()
        if metadata_bytes(exclude_path,65536)!=exclude: raise RuntimeError()
        inspection_env=None
        if git(['rev-parse','--verify','HEAD'],100).decode('ascii').strip()!=head: raise RuntimeError()
        if observation is not None and read_current(root,SELECTED)!=observation: raise RuntimeError()
        result.update(state='known',reason=None)
    finally:
        inspection_env=None
        if 'metadata' in locals(): metadata.cleanup()
        os.close(root)
except Exception:
    result.update(state='unknown',reason='Could not obtain a stable, bounded change snapshot. Refresh while the session is running.',headSha=None,files=[],listTruncated=False,selected=None)
result['checkedAt']=now()
sys.stdout.write(json.dumps(result,ensure_ascii=True)+'\nEPHEMERAL_CHANGES_COMPLETE\n')
`;
}

export function changeInspectionCommand(workspace: string, path?: string): string {
  return `exec /usr/bin/python3 -I -c ${shellQuote(changeInspectionSource(workspace, path))}`;
}
