"""Optional loopback-only speech enhancement for the existing viewer.

Only explicitly selected ZJU MP4 ranges are read. No cookies, audio files,
URLs or voiceprints are saved. The server never accepts an arbitrary host.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import io, json, math, re, select, shutil, socket, struct, subprocess, sys, threading, time, traceback, uuid
from runtime import runtime_home

LAB=runtime_home()

SR=48000
BUILD=10
MAX_FRAME_DIMENSION=16384
MAX_FRAME_PIXELS=33554432
MAX_FRAME_BYTES=72*1024*1024-65536
PORT=8771
ORIGINS={'https://classroom.zju.edu.cn','https://onlineroom.cmc.zju.edu.cn','https://interactivemeta.cmc.zju.edu.cn','https://webvpn.zju.edu.cn',
         'http://127.0.0.1:8769','http://localhost:8769'}
MEDIA_HOSTS={'vod.cmc.zju.edu.cn','resource.cmc.zju.edu.cn'}
LOCK=threading.Lock()
FRAME_LOCK=threading.Lock()
PROCESS_LOCK=threading.Lock()
PROCESSES=set()
STOPPING=threading.Event()
INSTANCE_ID=uuid.uuid4().hex
INITIALIZE_LOCK=threading.Lock()
MODEL=None
STATS={'requests':0,'errors':0,'cancelled':0,'last_ms':0,'last_error':None}
INITIALIZED=threading.Event()
STARTUP={'status':'loading','message':'正在加载声音组件…'}

def load_components():
    global np, wavfile, torch, moss_segment, MODEL, STARTUP
    try:
        if not shutil.which('ffmpeg'):
            STARTUP={'status':'error','message':'未找到音频解码器 FFmpeg'};return
        if not (LAB/'models/MossFormer2_SE_48K/last_best_checkpoint.pt').is_file():
            STARTUP={'status':'error','message':'清晰人声模型文件缺失'};return
        import numpy as np
        from scipy.io import wavfile
        import torch
        sys.path.insert(0,str(LAB/'cv-runtime'))
        from mossformer import moss_segment, load_weights
        from models.mossformer2_se.mossformer2_se_wrapper import MossFormer2_SE_48K
        if not torch.cuda.is_available():
            STARTUP={'status':'error','message':'清晰人声所需的 GPU 暂不可用'};return
        STARTUP={'status':'loading','message':'正在准备人声模型…'}
        MODEL=load_weights(MossFormer2_SE_48K(None).model,'MossFormer2_SE_48K')
        # Pay the CUDA/first-inference cost before the first media range.
        with torch.inference_mode():moss_segment(MODEL,np.zeros(4*SR,dtype=np.float32))
        STARTUP={'status':'ready','message':''}
    except Exception:
        MODEL=None
        STARTUP={'status':'error','message':'声音组件加载失败，请检查本机启动日志'}
        traceback.print_exc()  # Initialization only; never includes media URLs.

def finish_initialization():
    try:load_components()
    finally:
        INITIALIZED.set()
        INITIALIZE_LOCK.release()

def initialize(background=False):
    """Only one cold start/retry may own the model; HTTP remains responsive."""
    global STARTUP
    if STOPPING.is_set():return False
    if not INITIALIZE_LOCK.acquire(blocking=False):return False
    if STARTUP['status']=='ready':
        INITIALIZE_LOCK.release();return False
    INITIALIZED.clear()
    STARTUP={'status':'loading','message':'正在加载声音组件…'}
    if background:threading.Thread(target=finish_initialization,daemon=True).start()
    else:finish_initialization()
    return True

def valid_request(data):
    url=data.get('url','')
    if not isinstance(url,str):raise ValueError('unsupported source')
    u=urlsplit(url)
    if u.scheme!='https' or u.hostname not in MEDIA_HOSTS or u.port not in (None,443):
        raise ValueError('unsupported source')
    if u.username or u.password or not u.path.lower().endswith('.mp4'):
        raise ValueError('unsupported media')
    start=float(data['start']);rate=float(data.get('rate',1))
    if not math.isfinite(start) or not 0<=start<86400 or rate not in (.75,1,1.25,1.5,2):
        raise ValueError('unsupported range')
    seconds=float(data.get('seconds',24))
    if not math.isfinite(seconds) or not 4<=seconds<=24:raise ValueError('unsupported window')
    return url,start,rate,seconds

class ProcessingCancelled(Exception):pass

class AudioProcessingError(RuntimeError):
    def __init__(self,stage,kind):
        super().__init__('audio processing unavailable')
        self.stage=stage;self.kind=kind

def check_cancelled(cancelled):
    if STOPPING.is_set() or cancelled and cancelled():raise ProcessingCancelled()

def stop_processing():
    STOPPING.set()
    with PROCESS_LOCK:processes=list(PROCESSES)
    for process in processes:
        try:
            if process.poll() is None:process.kill()
        except OSError:pass
    for process in processes:
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:raise RuntimeError('decoder did not stop') from None

def ffmpeg(args, data=None, timeout=24, cancelled=None, stage='decode', metadata=False, executable='ffmpeg'):
    # A discarded seek must not keep a decoder and GPU queue occupied.
    with PROCESS_LOCK:
        check_cancelled(cancelled)
        try:process=subprocess.Popen([executable,*(['-hide_banner','-loglevel','error','-nostdin'] if executable=='ffmpeg' else ['-hide_banner','-loglevel','error']),*args],
            stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        except OSError:raise AudioProcessingError(stage,'unavailable') from None
        PROCESSES.add(process)
    try:
        with process:
            end=time.monotonic()+timeout;first=True
            try:
                while True:
                    check_cancelled(cancelled)
                    remaining=end-time.monotonic()
                    if remaining<=0:raise AudioProcessingError(stage,'timeout')
                    try:
                        output,diagnostic=process.communicate(input=data if first else None,timeout=min(.2,remaining));break
                    except subprocess.TimeoutExpired:first=False
            except BaseException:
                process.kill();process.communicate();raise
            code=process.returncode
    finally:
        with PROCESS_LOCK:PROCESSES.discard(process)
    if code:
        # ffmpeg stderr may include an expiring media URL. Never echo or save it.
        raise AudioProcessingError(stage,'exit')
    return (output,diagnostic) if metadata else output

def process_frame(url,start,cancelled=None):
    # Decode one original frame without changing any on-screen player geometry.
    # The browser must first prove CORS/range access, as for enhanced audio.
    # Accurate seek normally returns the next frame. Keep the last presentation
    # at/before the requested clock instead, so a crop never uses future writing.
    if not shutil.which('ffprobe'):raise AudioProcessingError('frame-index','unavailable')
    probe=ffmpeg(['-rw_timeout','15000000','-read_intervals',f'{max(0,start-.35)}%{start+2}',
        '-select_streams','v','-show_streams','-show_packets','-show_entries','stream=index,width,height:packet=stream_index,pts_time','-of','json',url],
        cancelled=cancelled,stage='frame-index',executable='ffprobe')
    index=json.loads(probe);streams=index.get('streams',[])
    # A URL identifies a container, not the track shown by the browser.
    # Without a selected-track contract, keep the verified visible crop.
    if len(streams)!=1:raise AudioProcessingError('frame','ambiguous-track')
    width,height=int(streams[0].get('width',0)),int(streams[0].get('height',0))
    if not 1<=width<=MAX_FRAME_DIMENSION or not 1<=height<=MAX_FRAME_DIMENSION or width*height>MAX_FRAME_PIXELS:
        raise AudioProcessingError('frame','dimensions')
    stream=streams[0]['index']
    stamps=sorted({float(packet['pts_time']) for packet in index.get('packets',[]) if packet.get('stream_index')==stream and 'pts_time' in packet and math.isfinite(float(packet['pts_time']))})
    prior=[stamp for stamp in stamps if stamp<=start+.000001]
    if not prior:raise AudioProcessingError('frame','missing')
    chosen=prior[-1];following=next((stamp for stamp in stamps if stamp>start+.000001),None)
    read_start=max(0,chosen-.000002)
    filters=f"select='gte(t,{chosen-.000002})',showinfo"
    png,diagnostic=ffmpeg(['-loglevel','info','-rw_timeout','15000000','-copyts',
        '-ss',str(read_start),'-t',str(max(.12,start-read_start+.12)),'-i',url,'-map','0:v:0','-an','-vf',filters,
        '-frames:v','1','-fps_mode','passthrough','-c:v','png','-f','image2pipe','pipe:1'],
        cancelled=cancelled,stage='frame',metadata=True)
    stamps=re.findall(rb'\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-+\d.eE]+)',diagnostic)
    if len(png)>MAX_FRAME_BYTES or len(png)<24 or png[:8]!=b'\x89PNG\r\n\x1a\n' or not stamps:
        raise AudioProcessingError('frame','invalid')
    width,height=struct.unpack('>II',png[16:24]);timestamp=float(stamps[0])
    # pts_time is formatted for a log and loses precision during long lessons.
    # The integer PTS and the filter time base retain the actual frame clock.
    base=re.search(rb'config in time_base:\s*(\d+)/(\d+)',diagnostic)
    ticks=re.findall(rb'\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:',diagnostic)
    if base and ticks:timestamp=int(ticks[0])*int(base[1])/int(base[2])
    indexed=abs(timestamp-chosen)<=.000002 and (following is None or start<following)
    if not 1<=width<=MAX_FRAME_DIMENSION or not 1<=height<=MAX_FRAME_DIMENSION or width*height>MAX_FRAME_PIXELS or not math.isfinite(timestamp) or timestamp>start+.000002 or not indexed:
        raise AudioProcessingError('frame','mismatch')
    return png,{'requested':start,'time':timestamp,'width':width,'height':height,'indexed':indexed,'next_time':following,'video_tracks':1,'original_pixels':True}

def process_range(url,start,rate,seconds=24,cancelled=None):
    end=time.monotonic()+45
    while not INITIALIZED.wait(.2):
        check_cancelled(cancelled)
        if time.monotonic()>=end:raise AudioProcessingError('initialize','timeout')
    check_cancelled(cancelled)
    if STARTUP['status']!='ready':
        raise AudioProcessingError('initialize','unavailable')
    begin=time.perf_counter()
    # Include context before the requested range, then crop it after enhancement.
    read_start=max(0,start-2);offset=round((start-read_start)*SR)
    duration=seconds+(start-read_start)
    raw=ffmpeg(['-rw_timeout','15000000','-ss',str(read_start),'-i',url,
        '-t',str(duration),'-vn','-ac','1','-ar',str(SR),'-f','f32le','pipe:1'],cancelled=cancelled)
    x=np.frombuffer(raw,dtype='<f4').copy()
    if len(x)<offset+SR//2 or not np.isfinite(x).all():
        raise AudioProcessingError('decode','invalid')
    window=4*SR;stride=3*SR;edge=SR//2
    padded=np.pad(x,(0,window));y=np.zeros_like(padded)
    with torch.inference_mode():
        for pos in range(0,len(x),stride):
            check_cancelled(cancelled)
            try:segment=moss_segment(MODEL,padded[pos:pos+window])
            except Exception as error:
                raise AudioProcessingError('model','oom' if isinstance(error,torch.cuda.OutOfMemoryError) else 'exception') from None
            a=0 if pos==0 else edge;b=window-edge
            y[pos+a:pos+b]=segment[a:b]
    y=y[:len(x)]
    # Speech-level proxy, not identity recognition: bounded level normalization.
    frame=1920;n=len(x)//frame*frame
    levels=np.sqrt(np.mean(x[:n].reshape(-1,frame)**2,axis=1))
    lo,hi=np.quantile(levels,[.4,.7])
    mask=np.repeat((levels>=lo)&(levels<=hi)&(levels>.0005),frame)
    out_rms=np.sqrt(np.mean(y[:n][mask]**2)) if mask.any() else 0
    gain=float(np.clip(.07/max(out_rms,.0001),.5,8)) if out_rms>.0001 else 1
    y=(y*gain).astype('<f4')
    # Same dynamics used in the accepted listening candidate. Compensation
    # removes limiter lookahead from file timing. Tempo preserves voice pitch.
    filters='acompressor=threshold=0.16:ratio=2.5:attack=3:release=150:makeup=1:knee=2.828:detection=rms,alimiter=limit=0.8:attack=5:release=70:level=0:latency=1'
    filters+=f',atrim=start_sample={offset}'
    if rate!=1:filters+=f',atempo={rate}'
    pcm=ffmpeg(['-f','f32le','-ar',str(SR),'-ac','1','-i','pipe:0','-af',filters,
        '-ar',str(SR),'-ac','1','-f','f32le','pipe:1'],y.tobytes(),timeout=8,cancelled=cancelled,stage='output')
    result=np.frombuffer(pcm,dtype='<f4')
    if not len(result) or not np.isfinite(result).all() or np.max(np.abs(result))>.82:
        raise AudioProcessingError('output','invalid')
    f=io.BytesIO()
    try:wavfile.write(f,SR,(result*32767).astype('<i2'))
    except Exception:raise AudioProcessingError('encode','exception') from None
    elapsed=round((time.perf_counter()-begin)*1000)
    return f.getvalue(),{'start':start,'rate':rate,'duration':len(result)/SR*rate,
                         'processing_ms':elapsed,'gain':gain}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def setup(self):
        super().setup();self.connection.settimeout(5)
    def allowed(self):
        return self.headers.get('Origin') in ORIGINS and self.headers.get('Host') in {f'127.0.0.1:{PORT}',f'localhost:{PORT}'}
    def client_closed(self):
        try:
            readable,_,_=select.select([self.connection],[],[],0)
            return bool(readable) and self.connection.recv(1,socket.MSG_PEEK)==b''
        except OSError:return True
    def reply(self,code,data=b'',mime='application/json',extra=None):
        self.send_response(code)
        origin=self.headers.get('Origin')
        if origin in ORIGINS:self.send_header('Access-Control-Allow-Origin',origin)
        self.send_header('Vary','Origin');self.send_header('Cache-Control','no-store')
        self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)))
        self.send_header('Access-Control-Expose-Headers','X-ZJF-Result')
        if extra:self.send_header('X-ZJF-Result',json.dumps(extra))
        self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_OPTIONS(self):
        if not self.allowed():self.reply(403);return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type, X-ZJF-Protocol, X-ZJF-Instance')
        self.send_header('Access-Control-Allow-Private-Network','true')
        self.send_header('Vary','Origin');self.end_headers()
    def do_GET(self):
        if not self.allowed():self.reply(403);return
        if self.path!='/health':self.reply(404);return
        self.reply(200,json.dumps({'protocol':1,'engine':'MossFormer2_SE_48K',
            'local_only':True,'build':BUILD,'instance_id':INSTANCE_ID,'short_ranges':True,'retry_initialization':True,'frame_decode':int(bool(shutil.which('ffprobe'))),'frame_original_pixels':True,
            'ready':STARTUP['status']=='ready','stats':STATS,**STARTUP}).encode())
    def do_POST(self):
        if not self.allowed() or self.headers.get('X-ZJF-Protocol')!='1':self.reply(403);return
        if self.path=='/shutdown' and self.headers.get('Origin')=='http://127.0.0.1:8769':
            if self.headers.get('X-ZJF-Instance')!=INSTANCE_ID:
                self.reply(409,b'{"error":"service_instance_changed"}');return
            stop_processing()
            self.reply(200,b'{"stopping":true}')
            threading.Thread(target=self.server.shutdown,daemon=True).start();return
        if self.path=='/retry':
            initialize(background=True)
            self.reply(200 if STARTUP['status']=='ready' else 202,
                json.dumps({'protocol':1,**STARTUP}).encode());return
        if self.path not in ('/enhance','/frame'):self.reply(404);return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 1<=size<=8192:raise ValueError('bad request')
            self.connection.settimeout(5)
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict):raise ValueError('bad request')
            url,start,rate,seconds=valid_request(data)
        except (ValueError,KeyError,TypeError,OSError):self.reply(400);return
        lock=FRAME_LOCK if self.path=='/frame' else LOCK
        if not lock.acquire(blocking=False):self.reply(429);return
        started=time.monotonic()
        try:
            if self.path=='/frame':
                png,meta=process_frame(url,start,cancelled=self.client_closed)
                self.reply(200,png,'image/png',meta)
            else:
                wav,meta=process_range(url,start,rate,seconds,cancelled=self.client_closed)
                STATS['requests']+=1;STATS['last_ms']=meta['processing_ms']
                self.reply(200,wav,'audio/wav',meta)
        except ProcessingCancelled:STATS['cancelled']+=1;self.close_connection=True
        except Exception as error:
            # Retain only a fixed category in memory. Exception text and decoder
            # stderr can contain private media addresses and must never escape.
            failure={'stage':error.stage,'kind':error.kind} if isinstance(error,AudioProcessingError) else {'stage':'processing','kind':'exception'}
            failure['elapsed_ms']=round((time.monotonic()-started)*1000)
            STATS['errors']+=1;STATS['last_error']=failure
            self.reply(502,json.dumps({'error':'audio processing unavailable',**failure}).encode())
        finally:lock.release()

if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    server.daemon_threads=True
    print(f'Zhiyun local voice helper: 127.0.0.1:{PORT}; no audio is saved.',flush=True)
    threading.Thread(target=initialize,daemon=True).start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        stop_processing()
        server.server_close()
