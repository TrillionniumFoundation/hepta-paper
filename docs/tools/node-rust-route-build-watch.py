"""Bounded Linux observation for development Cargo preparation; no product authority."""
import ctypes,errno,hashlib,json,os,select,struct,sys,time
FIELDS=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
def identity(stat):return [str(getattr(stat,key)) for key in FIELDS]
def namespace(fd):
 names=[];total=0
 with os.scandir(fd) as entries:
  for entry in entries:
   if len(names)>=16384:raise RuntimeError('cargo_preparation_namespace_limit')
   total+=len(entry.name.encode('utf-8'))
   if total>1024*1024:raise RuntimeError('cargo_preparation_namespace_limit')
   names.append(entry.name)
 names.sort()
 return {'namesCount':len(names),'namesSha256':'sha256:'+hashlib.sha256(json.dumps(names,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}
def lock_hash(fd, captured):
 hash=hashlib.sha256();offset=0
 while True:
  raw=os.pread(fd,min(65536,captured.st_size-offset+1),offset)
  if not raw:break
  offset+=len(raw)
  if offset>captured.st_size or offset>65536:raise RuntimeError('cargo_preparation_lock_grew')
  hash.update(raw)
 if offset!=captured.st_size or identity(captured)!=identity(os.fstat(fd)):raise RuntimeError('cargo_preparation_lock_changed')
 return 'sha256:'+hash.hexdigest()
def emit(value):print(json.dumps(value,separators=(',',':')),flush=True)
parent=None;directory=None;notify=None;held={};cache_files={};cache_proof={};journal_proof=[];events=[];failure=None;result=None
try:
 line=sys.stdin.buffer.readline(65537)
 if len(line)>65536 or not line.endswith(b'\n'):raise RuntimeError('cargo_preparation_request_limit')
 request=json.loads(line)
 if sorted(request)!=['parent'] or not isinstance(request['parent'],str):raise RuntimeError('cargo_preparation_request_invalid')
 parent=request['parent']
 if not os.path.isabs(parent) or os.path.normpath(parent)!=parent or os.path.realpath(parent)!=parent:raise RuntimeError('cargo_preparation_parent_alias')
 directory=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
 before=os.fstat(directory)
 if identity(before)!=identity(os.stat(parent,follow_symlinks=False)):raise RuntimeError('cargo_preparation_parent_changed')
 libc=ctypes.CDLL(None,use_errno=True)
 libc.inotify_init1.argtypes=[ctypes.c_int];libc.inotify_init1.restype=ctypes.c_int
 libc.inotify_add_watch.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_uint32];libc.inotify_add_watch.restype=ctypes.c_int
 notify=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
 if notify<0:raise OSError(ctypes.get_errno(),'inotify_init1')
 # MODIFY, ATTRIB, CLOSE_WRITE, MOVED_FROM/TO, CREATE/DELETE, DELETE_SELF/MOVE_SELF,
 # UNMOUNT/Q_OVERFLOW/IGNORED are all fail-closed except the exact journal events below.
 mask=0x2|0x4|0x8|0x40|0x80|0x100|0x200|0x400|0x800|0x2000|0x4000|0x8000
 watch=libc.inotify_add_watch(notify,f'/proc/self/fd/{directory}'.encode(),mask)
 if watch<0:raise OSError(ctypes.get_errno(),'inotify_add_watch')
 if identity(before)!=identity(os.fstat(directory)) or identity(before)!=identity(os.stat(parent,follow_symlinks=False)):raise RuntimeError('cargo_preparation_watch_setup_changed')
 before_names=namespace(directory)
 for name in ['.global-cache','.package-cache','.package-cache-mutate']:
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
  metadata=os.fstat(fd)
  if not __import__('stat').S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_size>(16*1024*1024 if name=='.global-cache' else 65536):
   os.close(fd);raise RuntimeError('cargo_preparation_existing_cache_identity')
  if identity(metadata)!=identity(os.stat(name,dir_fd=directory,follow_symlinks=False)) or metadata.st_mode&0o2 or metadata.st_uid!=before.st_uid or metadata.st_gid!=before.st_gid:
   os.close(fd);raise RuntimeError('cargo_preparation_existing_cache_identity')
  cache_files[name]=(fd,metadata)
  cache_proof[name]={'beforeIdentity':identity(metadata),'beforeSha256':None if name=='.global-cache' else lock_hash(fd,metadata)}
 emit({'ready':True,'parent':parent,'identity':identity(before),'namespace':before_names})
 deadline=time.monotonic()+600;bytes_read=0;journal_creates=0;journal_deletes=0
 def drain():
  global bytes_read,journal_creates,journal_deletes
  while True:
   try:raw=os.read(notify,65536)
   except BlockingIOError:return
   if not raw:return
   bytes_read+=len(raw)
   if bytes_read>1024*1024:raise RuntimeError('cargo_preparation_event_limit')
   offset=0
   while offset<len(raw):
    if offset+16>len(raw):raise RuntimeError('cargo_preparation_event_shape')
    wd,flags,cookie,length=struct.unpack_from('iIII',raw,offset);offset+=16
    if offset+length>len(raw):raise RuntimeError('cargo_preparation_event_shape')
    name=os.fsdecode(raw[offset:offset+length].split(b'\0',1)[0]);offset+=length
    if len(events)>=4096:raise RuntimeError('cargo_preparation_event_limit')
    events.append({'name':name,'mask':flags,'cookie':cookie})
    if wd!=watch or cookie or flags&~(0x2|0x8|0x100|0x200):raise RuntimeError('cargo_preparation_unknown_event')
    if name=='.global-cache':
     if flags&~(0x2|0x8):raise RuntimeError('cargo_preparation_cache_namespace_changed')
    elif name in ['.package-cache','.package-cache-mutate']:
     if flags!=0x8:raise RuntimeError('cargo_preparation_lock_changed')
    elif name=='.global-cache-journal':
     if flags&0x100:
      if held:raise RuntimeError('cargo_preparation_journal_overlap')
      fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
      metadata=os.fstat(fd)
      if not __import__('stat').S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=before.st_uid or metadata.st_gid!=before.st_gid or metadata.st_mode&0o2 or metadata.st_size>16*1024*1024:
       os.close(fd);raise RuntimeError('cargo_preparation_journal_identity')
      held['fd']=fd;held['identity']=identity(metadata);journal_creates+=1
     if flags&0x200:
      if not held:raise RuntimeError('cargo_preparation_journal_missing_creation')
      metadata=os.fstat(held['fd'])
      if metadata.st_nlink!=0 or identity(metadata)[:5]!=held['identity'][:5] or metadata.st_size>16*1024*1024:raise RuntimeError('cargo_preparation_journal_identity')
      try:os.stat(name,dir_fd=directory,follow_symlinks=False);raise RuntimeError('cargo_preparation_journal_named_after_delete')
      except FileNotFoundError:pass
      journal_proof.append({'createdIdentity':held['identity'],'deletedIdentity':identity(metadata)})
      os.close(held.pop('fd'));held.clear();journal_deletes+=1
    else:raise RuntimeError('cargo_preparation_configuration_or_unknown_path_changed')
 while True:
  if time.monotonic()>=deadline:raise RuntimeError('cargo_preparation_observer_timeout')
  ready,_,_=select.select([notify,sys.stdin.fileno()],[],[],min(.1,deadline-time.monotonic()))
  if notify in ready:
   try:drain()
   except Exception as error:failure=failure or str(error)[:256]
  if sys.stdin.fileno() in ready:
   command=sys.stdin.buffer.readline(32)
   if command!=b'finish\n':raise RuntimeError('cargo_preparation_finish_invalid')
   try:drain()
   except Exception as error:failure=failure or str(error)[:256]
   for name,(fd,initial) in cache_files.items():
    current=os.fstat(fd);named_cache=os.stat(name,dir_fd=directory,follow_symlinks=False)
    observed=lambda value:identity(value)[:6] if name=='.global-cache' else identity(value)
    if observed(initial)!=observed(current) or identity(current)!=identity(named_cache) or current.st_size>(16*1024*1024 if name=='.global-cache' else 65536):failure=failure or 'cargo_preparation_existing_cache_changed'
    cache_proof[name]['afterIdentity']=identity(current)
    cache_proof[name]['afterSha256']=None if name=='.global-cache' else lock_hash(fd,current)
    if name!='.global-cache' and cache_proof[name]['beforeSha256']!=cache_proof[name]['afterSha256']:failure=failure or 'cargo_preparation_lock_changed'
   after=os.fstat(directory);named=os.stat(parent,follow_symlinks=False);after_names=namespace(directory)
   if identity(after)!=identity(named) or identity(before)[:7]!=identity(after)[:7] or before_names!=after_names:failure=failure or 'cargo_preparation_parent_changed'
   if held or journal_creates!=journal_deletes:failure=failure or 'cargo_preparation_journal_incomplete'
   if identity(before)!=identity(after) and journal_creates==0:failure=failure or 'cargo_preparation_parent_epoch_without_journal'
   result={'complete':True,'parent':parent,'beforeIdentity':identity(before),'afterIdentity':identity(after),'namespace':after_names,'events':events,'cacheFiles':cache_proof,'journals':journal_proof,'journalCreates':journal_creates,'journalDeletes':journal_deletes,'failure':failure}
   break
except Exception as error:
 failure=str(error)[:256];result={'complete':False,'parent':parent,'events':events,'failure':failure}
finally:
 if held.get('fd') is not None:os.close(held['fd'])
 for fd,_ in cache_files.values():os.close(fd)
 if notify is not None:os.close(notify)
 if directory is not None:os.close(directory)
 emit(result);sys.exit(1 if failure else 0)
