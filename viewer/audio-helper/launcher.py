"""Start/stop only this project's optional loopback helper. No policy changes."""
from pathlib import Path
from contextlib import contextmanager
import ctypes, json, os, subprocess, sys, time, urllib.error, urllib.request
from runtime import runtime_python

HERE=Path(__file__).resolve().parent
MINIMUM_BUILD=10
HEADERS={'Origin':'http://127.0.0.1:8769','X-ZJF-Protocol':'1'}
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
@contextmanager
def lifecycle_lock():
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.CreateMutexW.argtypes=[ctypes.c_void_p,ctypes.c_bool,ctypes.c_wchar_p];kernel.CreateMutexW.restype=ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_ulong];kernel.WaitForSingleObject.restype=ctypes.c_ulong
        kernel.ReleaseMutex.argtypes=[ctypes.c_void_p];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.CreateMutexW(None,False,'Local\\ZhiyunFocusAudioLifecycle-v1')
        if not handle:raise RuntimeError('声音服务的启动协调暂不可用。')
        acquired=False
        try:
            status=kernel.WaitForSingleObject(handle,15000);acquired=status in (0,0x80)
            if status==258:raise RuntimeError('另一请求仍在准备声音服务，请稍后再连接。')
            if not acquired:raise RuntimeError('声音服务的启动协调暂不可用。')
            yield
        finally:
            if acquired:kernel.ReleaseMutex(handle)
            kernel.CloseHandle(handle)
    else:
        import fcntl
        folder=Path.home()/'.zhiyun-focus';folder.mkdir(exist_ok=True)
        with (folder/'audio-helper.lock').open('a+b') as lock:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
            try:yield
            finally:fcntl.flock(lock.fileno(),fcntl.LOCK_UN)

def call(path,method='GET',instance=None):
    request=urllib.request.Request('http://127.0.0.1:8771'+path,headers={**HEADERS,**({'X-ZJF-Instance':instance} if instance else {})},method=method)
    with OPENER.open(request,timeout=6 if path=='/shutdown' else .4) as response:return json.load(response)

def service_state():
    result=call('/health')
    if not isinstance(result,dict) or result.get('engine')!='MossFormer2_SE_48K' or result.get('protocol')!=1:
        raise RuntimeError('声音服务端口由其他程序占用。')
    return result

def _start_locked():
    try:state=service_state()
    except (OSError,ValueError):state=None
    if state is not None and isinstance(state.get('build'),int) and state['build']<MINIMUM_BUILD:
        try:call('/shutdown','POST',instance=state.get('instance_id'))
        except urllib.error.HTTPError as error:
            if error.code!=409:raise
            state=service_state()
            if state.get('build',0)<MINIMUM_BUILD:raise RuntimeError('声音服务已更替，请重新连接当前实例。')
        else:
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                try:
                    live=service_state()
                    if live.get('instance_id')!=state.get('instance_id') and live.get('build',0)>=MINIMUM_BUILD:state=live;break
                except (OSError,ValueError):state=None;break
                time.sleep(.1)
            if state is not None and state.get('build',0)<MINIMUM_BUILD:raise RuntimeError('媒体组件正在退出，请稍后再连接。')
    if state is None:
        with (HERE/'startup.log').open('ab') as log:
            p=subprocess.Popen([str(runtime_python()),'-X','utf8',str(HERE/'server.py')],
                cwd=str(HERE),stdin=subprocess.DEVNULL,stdout=log,stderr=log,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        (HERE/'helper.pid').write_text(str(p.pid),encoding='ascii')
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            try:state=service_state()
            except (OSError,ValueError):pass
            if state is not None:break
            if p.poll() is not None:break
            time.sleep(.1)
        if state is None:raise RuntimeError('声音服务启动失败，请查看 viewer/audio-helper/startup.log。')
    if state.get('status')=='error':
        if not state.get('retry_initialization'):raise RuntimeError(state.get('message') or '声音组件加载失败。')
        state=call('/retry','POST')
        if state.get('status')=='error':raise RuntimeError(state.get('message') or '声音组件加载失败。')
    if state.get('status')=='loading':
        print('声音服务已启动，正在准备人声模型。原声保持播放。')
    elif state.get('status')=='ready':
        print('清晰人声模块已就绪。回到课程，在“设置”中选择清晰人声。')
    else:
        print('声音服务已启动。回到课程启用清晰人声后，会继续确认模型状态。')

def _stop_locked():
    try:
        state=service_state()
        call('/shutdown','POST',instance=state.get('instance_id'))
        for _ in range(20):
            time.sleep(.1)
            try:call('/health')
            except Exception:break
        else:raise RuntimeError('shutdown not confirmed')
        print('清晰人声模块已停止。课程会恢复原声。')
    except Exception:raise RuntimeError('未能确认声音服务已停止。')

def start():
    with lifecycle_lock():return _start_locked()

def stop():
    with lifecycle_lock():return _stop_locked()

def main():
    try:
        if len(sys.argv)>1 and sys.argv[1]=='stop':stop()
        else:start()
    except Exception as error:
        print(str(error));return 1
    return 0

if __name__=='__main__':sys.exit(main())
