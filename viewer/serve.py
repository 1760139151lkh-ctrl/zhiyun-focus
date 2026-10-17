"""Loopback-only development preview. Not required by the installed bookmark."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import re
import shutil

ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT/'dist'),**kwargs)
    def send_head(self):
        self._byte_range = None
        path=Path(self.translate_path(self.path))
        if path.is_file() and path.suffix in ('.mp4','.webm'):
            size=path.stat().st_size
            header=self.headers.get('Range')
            start,end=0,size-1
            if header:
                match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
                if not match or not any(match.groups()):
                    self.send_error(416);return None
                a,b=match.groups()
                if a: start=int(a);end=min(int(b),size-1) if b else size-1
                else: start=max(0,size-int(b))
                if start>end or start>=size:
                    self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.end_headers();return None
            stream=path.open('rb')
            stream.seek(start)
            self.send_response(206 if header else 200)
            self.send_header('Content-Type',self.guess_type(str(path)))
            self.send_header('Accept-Ranges','bytes')
            self.send_header('Content-Length',str(end-start+1))
            if header:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            self.end_headers()
            self._byte_range=end-start+1
            return stream
        return super().send_head()
    def copyfile(self,source,outputfile):
        if self._byte_range is None:return shutil.copyfileobj(source,outputfile)
        remaining=self._byte_range
        while remaining:
            chunk=source.read(min(65536,remaining))
            if not chunk:break
            outputfile.write(chunk);remaining-=len(chunk)
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def log_message(self,fmt,*args): pass

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8769);args=p.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Local preview http://127.0.0.1:{args.port}/',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
