using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Accessibility;

// Locate the content surface inside the already authenticated browser window.
// Browser chrome is never inferred from client-minus-inner dimensions.
static class BrowserCaptureViewport {
    public sealed class Surface {
        public IntPtr Owner,Handle;
        public Rectangle Bounds;
        public Rectangle NativeBounds,OwnerBounds,DocumentBounds;
        public string Kind,Identity,Name;
        public bool Visible=true;
    }
    public sealed class CaptureGeometry {
        public string Instance;
        public long Epoch;
        public double Width,Height,Dpr,Aside,VisualWidth,VisualHeight,OffsetX,OffsetY,VisualScale,MainX,MainY,MainWidth,MainHeight,X,Y,W,H;
        public Rectangle Pixels(Surface surface) {
            return BrowserCaptureViewport.Pixels(surface,VisualWidth,VisualHeight,Dpr*VisualScale,0,X-OffsetX,Y-OffsetY,W,H);
        }
    }
    public sealed class PaintProof {public string Nonce;public double X,Y;}
    public static PaintProof ReadPaint(Dictionary<string,object> request,CaptureGeometry g){
        var value=ObjectValue(request,"paint");if(value==null)return null;object raw;Guid nonce;
        string code=value.TryGetValue("nonce",out raw)?raw as string:null;
        if(code==null||!Guid.TryParseExact(code,"N",out nonce))throw new Exception("截图刷新身份无效，请重试。");
        var proof=new PaintProof{Nonce=code,X=Value(value,"x"),Y=Value(value,"y")};
        if(!Finite(proof.X)||!Finite(proof.Y)||proof.X<g.MainX-.01||proof.Y<g.MainY-.01||proof.X+64>g.MainX+g.MainWidth+.01||proof.Y+8>g.MainY+g.MainHeight+.01)throw new Exception("截图刷新区域无效，请重试。");
        return proof;
    }
    static Rectangle PaintBounds(Surface surface,CaptureGeometry g,PaintProof proof){return Pixels(surface,g.VisualWidth,g.VisualHeight,g.Dpr*g.VisualScale,0,proof.X-g.OffsetX,proof.Y-g.OffsetY,64,8);}
    public static bool PaintVisible(Surface surface,CaptureGeometry g,PaintProof proof){
        if(proof==null)return true;var bounds=PaintBounds(surface,g,proof);if(!System.Windows.Forms.SystemInformation.VirtualScreen.Contains(bounds))return false;
        using(var bitmap=new Bitmap(bounds.Width,bounds.Height))using(var graphics=Graphics.FromImage(bitmap)){
            graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size,CopyPixelOperation.SourceCopy);
            double scale=g.Dpr*g.VisualScale;
            for(int bit=0;bit<128;bit++){
                int x=(int)Math.Floor(surface.Bounds.Left+(proof.X-g.OffsetX+(bit%32+.5)*2)*scale)-bounds.Left;
                int y=(int)Math.Floor(surface.Bounds.Top+(proof.Y-g.OffsetY+(bit/32+.5)*2)*scale)-bounds.Top;
                if(x<0||y<0||x>=bitmap.Width||y>=bitmap.Height)return false;
                var color=bitmap.GetPixel(x,y);int level=color.R+color.G+color.B;bool white=(Convert.ToInt32(proof.Nonce.Substring(bit/4,1),16)&(1<<(3-bit%4)))!=0;
                if(white?level<600:level>150)return false;
            }
            return true;
        }
    }
    public static void WaitForPaint(IntPtr owner,Surface surface,CaptureGeometry g,PaintProof proof,Func<bool> current){
        if(proof==null)return;var bounds=PaintBounds(surface,g,proof);var clock=Stopwatch.StartNew();
        while(current()&&clock.ElapsedMilliseconds<800){EnsureUnobscured(owner,bounds);if(PaintVisible(surface,g,proof))return;Thread.Sleep(12);}
        throw new Exception("课程画面尚未完成刷新，请保持窗口可见后重试。");
    }
    static readonly ViewportResolverCache<Surface> fallback=new ViewportResolverCache<Surface>();
    public sealed class FocusProof {
        public IntPtr Owner;public string Marker,Session,GeometryInstance;
        public long WorkspaceRevision,GeometryEpoch,RequestedAt,CapturedAt;
        public bool Consumed;
        public bool Fresh {
            get{var now=Stopwatch.GetTimestamp();return CapturedAt>0&&now>=CapturedAt&&now>=RequestedAt&&
                (now-CapturedAt)/(double)Stopwatch.Frequency<=.3&&(now-RequestedAt)/(double)Stopwatch.Frequency<=.8;}
        }
    }
    static readonly ViewportResolverCache<FocusProof> focusResolver=new ViewportResolverCache<FocusProof>();

    // Chromium's Aura widgets can keep Win32 focus on the browser frame even
    // when a DOM element is focused. The focused accessibility entry, rather
    // than the compatibility render HWND, distinguishes the page from the URL bar.
    public static FocusProof LocateFocusedEntry(FocusProof expected){
        if(expected==null)return null;var owner=expected.Owner;var marker=expected.Marker;
        if(owner==IntPtr.Zero||Native.GetForegroundWindow()!=owner)return null;
        var result=focusResolver.Resolve(Guid.NewGuid().ToString("N"),delegate{
            var focused=AutomationElement.FocusedElement;
            if(focused==null)return null;
            var current=focused.Current;
            if(!current.HasKeyboardFocus||current.AutomationId!="chat-focus")return null;
            var node=focused;
            for(int depth=0;node!=null&&depth<64;depth++,node=TreeWalker.ControlViewWalker.GetParent(node)){
                var value=node.Current;
                if(value.ControlType==ControlType.Document&&value.Name.Contains(marker)){
                    if(Native.GetForegroundWindow()!=owner||!focused.Current.HasKeyboardFocus)return null;
                    expected.CapturedAt=Stopwatch.GetTimestamp();return expected;
                }
            }
            return null;
        },proof=>proof!=null&&proof.Owner==owner&&proof.Marker==marker&&Native.GetForegroundWindow()==owner,300);
        return result.State=="ready"?result.Value:null;
    }
    delegate bool EnumChild(IntPtr child,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window,EnumChild callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int count);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out int value,int size);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window,uint objectId,ref Guid interfaceId,[MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    static bool Finite(double n){return !Double.IsNaN(n)&&!Double.IsInfinity(n);}

    static double Value(Dictionary<string,object> values,string key,double fallback=Double.NaN) {
        object raw;double value;
        if(values==null||!values.TryGetValue(key,out raw))return fallback;
        if(raw is double)value=(double)raw;
        else if(raw is float)value=(float)raw;
        else if(raw==null||!Double.TryParse(Convert.ToString(raw,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out value))throw new Exception("截图的视区数据无效，请重新截图。");
        if(!Finite(value))throw new Exception("截图的视区数据无效，请重新截图。");
        return value;
    }
    static Dictionary<string,object> ObjectValue(Dictionary<string,object> values,string key) {
        object raw;if(values==null||!values.TryGetValue(key,out raw))return null;
        var result=raw as Dictionary<string,object>;
        if(result==null)throw new Exception("截图的视区数据无效，请重新截图。");
        return result;
    }
    public static CaptureGeometry ReadRequest(Dictionary<string,object> request,double aside) {return ReadGeometry(request,aside,true);}
    public static CaptureGeometry ReadViewportMetrics(Dictionary<string,object> request) {return ReadGeometry(request,0,false);}
    static CaptureGeometry ReadGeometry(Dictionary<string,object> request,double aside,bool capture) {
        var geometry=ObjectValue(request,"geometry");object raw;
        string instance=geometry!=null&&geometry.TryGetValue("instance",out raw)?raw as string:null;
        double epoch=Value(geometry,"epoch");
        if(String.IsNullOrWhiteSpace(instance)||instance.Length>128||!Finite(epoch)||epoch<1||epoch>9007199254740991d||epoch!=Math.Floor(epoch))throw new Exception("截图任务的画面身份无效，请重新截图。");
        var g=new CaptureGeometry{Instance=instance,Epoch=(long)epoch,Width=Value(request,"width"),Height=Value(request,"height"),Dpr=Value(request,"dpr"),Aside=Value(geometry,"aside",aside),X=Value(request,"x"),Y=Value(request,"y"),W=Value(request,"w"),H=Value(request,"h")};
        var visual=ObjectValue(geometry,"visual");var main=ObjectValue(geometry,"mainRect");
        g.VisualScale=Value(visual,"scale",1);g.OffsetX=Value(visual,"offsetLeft",0);g.OffsetY=Value(visual,"offsetTop",0);
        g.VisualWidth=Value(visual,"width",g.Width/g.VisualScale);g.VisualHeight=Value(visual,"height",g.Height/g.VisualScale);
        g.MainX=Value(main,"x",g.OffsetX);g.MainY=Value(main,"y",g.OffsetY);g.MainWidth=Value(main,"w",g.VisualWidth-g.Aside);g.MainHeight=Value(main,"h",g.VisualHeight);
        if(!capture){g.X=g.MainX;g.Y=g.MainY;g.W=g.MainWidth;g.H=g.MainHeight;}
        foreach(double value in new[]{g.Width,g.Height,g.Dpr,g.Aside,g.VisualWidth,g.VisualHeight,g.OffsetX,g.OffsetY,g.VisualScale,g.MainX,g.MainY,g.MainWidth,g.MainHeight,g.X,g.Y,g.W,g.H,g.Dpr*g.VisualScale})if(!Finite(value))throw new Exception("截图的视区数据无效，请重新截图。");
        if(g.Width<1||g.Height<1||g.Width>10000||g.Height>10000||g.Dpr<.5||g.Dpr>5||g.Aside<0||(capture&&Math.Abs(g.Aside-aside)>.01)||g.VisualScale<=0||g.OffsetX<0||g.OffsetY<0||g.VisualWidth<=0||g.VisualHeight<=0||g.VisualWidth*g.VisualScale>g.Width+2/g.Dpr||g.VisualHeight*g.VisualScale>g.Height+2/g.Dpr||g.MainWidth<=0||g.MainHeight<=0||g.MainX<g.OffsetX-.01||g.MainY<g.OffsetY-.01||g.MainX+g.MainWidth>g.OffsetX+g.VisualWidth+.01||g.MainY+g.MainHeight>g.OffsetY+g.VisualHeight+.01||g.X<g.MainX-.01||g.Y<g.MainY-.01||g.W<1||g.H<1||g.X+g.W>g.MainX+g.MainWidth+.01||g.Y+g.H>g.MainY+g.MainHeight+.01)throw new Exception("选区不在当前课程画面内。");
        return g;
    }

    static bool Matches(Surface s,IntPtr owner,double width,double height,double dpr) {
        return s!=null&&s.Owner==owner&&s.Visible&&s.Bounds.Width>0&&s.Bounds.Height>0&&Math.Abs(s.Bounds.Width-Math.Round(width*dpr,MidpointRounding.AwayFromZero))<=2&&Math.Abs(s.Bounds.Height-Math.Round(height*dpr,MidpointRounding.AwayFromZero))<=2;
    }
    static List<Surface> DistinctBounds(List<Surface> surfaces) {
        var result=new List<Surface>();
        foreach(var s in surfaces)if(!result.Exists(x=>x.Bounds==s.Bounds))result.Add(s);
        return result;
    }
    // A marker-bearing Document is an identity proof. A unique visible native
    // render surface is a geometry proof inside the already bound browser owner.
    public static Surface Select(IEnumerable<Surface> candidates,IntPtr owner,string marker,double width,double height,double dpr) {
        if(width<=0||height<=0||dpr<=0||double.IsNaN(width)||double.IsNaN(height)||double.IsNaN(dpr)||double.IsInfinity(width)||double.IsInfinity(height)||double.IsInfinity(dpr))throw new Exception("课程视区尺寸无效。");
        var native=new List<Surface>();var documents=new List<Surface>();
        foreach(var s in candidates)if(Matches(s,owner,width,height,dpr)){
            if(s.Kind=="chrome-render-widget")native.Add(s);
            if((s.Kind=="uia-document"||s.Kind=="msaa-document")&&!String.IsNullOrEmpty(marker)&&!String.IsNullOrEmpty(s.Name)&&s.Name.Contains(marker))documents.Add(s);
        }
        var docs=DistinctBounds(documents);
        if(docs.Count>1)throw new Exception("课程内容位置暂时不明确，请等画面稳定后重试。");
        if(docs.Count==1)return docs[0];
        var choices=DistinctBounds(native);
        if(choices.Count!=1)throw new Exception("暂时无法确认课程内容位置，请等窗口稳定后重试。");
        return choices[0];
    }
    static bool TryScreenClient(IntPtr window,out Rectangle value) {
        Rect rect;var origin=new Point();
        value=Rectangle.Empty;
        if(!GetClientRect(window,out rect)||!ClientToScreen(window,ref origin)||rect.Right<=rect.Left||rect.Bottom<=rect.Top)return false;
        value=new Rectangle(origin.X,origin.Y,rect.Right-rect.Left,rect.Bottom-rect.Top);return true;
    }
    static Rectangle ScreenClient(IntPtr window) {
        Rectangle value;if(!TryScreenClient(window,out value))throw new InvalidOperationException("无法读取课程内容位置。");return value;
    }
    static bool OwnerUnchanged(IntPtr owner,Rectangle expected) {
        Rectangle current;return TryScreenClient(owner,out current)&&current==expected;
    }
    static bool Inside(Rectangle outer,Rectangle inner,int padding=2) {
        var tolerance=outer;tolerance.Inflate(padding,padding);return tolerance.Contains(inner);
    }
    static List<Surface> NativeSurfaces(IntPtr owner) {
        var result=new List<Surface>();var bounds=ScreenClient(owner);int count=0;bool exhausted=false;
        EnumChild callback=delegate(IntPtr child,IntPtr ignored){
            if(++count>2048){exhausted=true;return false;}
            if(!IsWindowVisible(child)||GetAncestor(child,2)!=owner)return true;
            var name=new StringBuilder(256);GetClassName(child,name,name.Capacity);
            if(name.ToString()!="Chrome_RenderWidgetHostHWND")return true;
            Rectangle rect;if(!TryScreenClient(child,out rect))return true;
            // Raw widget and clipped document sizes each allow two physical
            // pixels of rounding. A named document must still pass both checks.
            if(Inside(bounds,rect,4))result.Add(new Surface{Owner=owner,Handle=child,Bounds=rect,Kind="chrome-render-widget",Identity="hwnd:"+child.ToInt64().ToString("x")});
            return true;
        };
        EnumChildWindows(owner,callback,IntPtr.Zero);GC.KeepAlive(callback);
        if(exhausted)throw new InvalidOperationException("课程内容层级正在变化，请等窗口稳定后重试。");
        return result;
    }
    static List<Surface> DocumentSurfaces(IntPtr owner,string marker) {
        var result=new List<Surface>();var ownerBounds=ScreenClient(owner);var clock=Stopwatch.StartNew();
        var pending=new Queue<AutomationElement>();pending.Enqueue(AutomationElement.FromHandle(owner));
        int visited=0;bool exhausted=false;
        // Never descend into page DOMs. Read only browser chrome and top-level
        // Documents to avoid enumerating a large lesson or another page's text.
        while(pending.Count>0&&visited++<256&&clock.ElapsedMilliseconds<300){
            var node=pending.Dequeue();var current=node.Current;
            if(current.ControlType==ControlType.Document){
                if(current.IsOffscreen||String.IsNullOrEmpty(current.Name)||!current.Name.Contains(marker))continue;
                var r=current.BoundingRectangle;
                if(r.IsEmpty||!Finite(r.X)||!Finite(r.Y)||!Finite(r.Width)||!Finite(r.Height)||r.Width<=0||r.Height<=0||Math.Abs(r.X)>Int32.MaxValue/2||Math.Abs(r.Y)>Int32.MaxValue/2||r.Width>Int32.MaxValue/2||r.Height>Int32.MaxValue/2)continue;
                var rect=new Rectangle((int)Math.Floor(r.X+.5),(int)Math.Floor(r.Y+.5),(int)Math.Floor(r.Width+.5),(int)Math.Floor(r.Height+.5));
                if(Inside(ownerBounds,rect))result.Add(new Surface{Owner=owner,Handle=IntPtr.Zero,Bounds=rect,Kind="uia-document",Name=current.Name,Identity="uia:"+String.Join(".",node.GetRuntimeId())});
                continue;
            }
            var walker=TreeWalker.ControlViewWalker;
            for(var child=walker.GetFirstChild(node);child!=null;child=walker.GetNextSibling(child)){
                if(pending.Count+visited>=256){exhausted=true;break;}
                pending.Enqueue(child);
            }
        }
        if(exhausted||pending.Count>0)throw new Exception("课程内容位置仍在读取，请稍后重试。");
        return result;
    }
    // Chromium's compatibility HWND may have the correct size at (0,0), even
    // while the actual document starts below tabs, bookmarks and an infobar.
    // Its named document supplies the origin; the HWND only anchors later moves.
    static Surface MeasureDocument(Surface native,string marker,double width,double height,double dpr){
        if(!Matches(native,native.Owner,width,height,dpr)||String.IsNullOrEmpty(marker))return null;
        var ownerBefore=ScreenClient(native.Owner);var id=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");IAccessible accessible=null;
        try{
            if(AccessibleObjectFromWindow(native.Handle,0xFFFFFFFC,ref id,out accessible)!=0||accessible==null)return null;
            string name=accessible.get_accName(0)??"";
            if(Convert.ToInt32(accessible.get_accRole(0))!=15||(Convert.ToInt32(accessible.get_accState(0))&0x18000)!=0||!name.Contains(marker))return null;
            int x,y,w,h;accessible.accLocation(out x,out y,out w,out h,0);
            var raw=new Rectangle(x,y,w,h);
            var document=new Surface{Owner=native.Owner,Handle=native.Handle,Bounds=raw,Kind="msaa-document",Name=name,Identity="msaa:"+native.Handle.ToInt64().ToString("x")+":"+marker};
            if(!Matches(document,native.Owner,width,height,dpr)||!OwnerUnchanged(native.Owner,ownerBefore)||!name.Equals(accessible.get_accName(0)))return null;
            // Clip only window-frame rounding, then reapply the original strict
            // viewport-size check. Never accept a smaller/offscreen document.
            document.Bounds=Rectangle.Intersect(raw,ownerBefore);
            if(!Matches(document,native.Owner,width,height,dpr)||ScreenClient(native.Handle)!=native.Bounds)return null;
            document.NativeBounds=native.Bounds;document.OwnerBounds=ownerBefore;document.DocumentBounds=raw;return document;
        }catch(COMException){return null;}
        finally{if(accessible!=null&&Marshal.IsComObject(accessible))Marshal.ReleaseComObject(accessible);}
    }
    static Surface MeasureContent(IntPtr owner,string marker,double width,double height,double dpr){
        var native=NativeSurfaces(owner);var measured=new List<Surface>();
        foreach(var candidate in native){var document=MeasureDocument(candidate,marker,width,height,dpr);if(document!=null)measured.Add(document);}
        if(measured.Count>0)return Select(measured,owner,marker,width,height,dpr);
        // UIA is retained for providers that expose no MSAA document. A raw
        // compatibility HWND alone no longer proves the content's screen origin.
        var proof=Select(DocumentSurfaces(owner,marker),owner,marker,width,height,dpr);
        return SelectLiveAnchor(proof,native,owner,marker,width,height,dpr)??proof;
    }
    static string CacheKey(IntPtr owner,string marker,double width,double height,double dpr,string instance,Rectangle ownerBounds) {
        return owner.ToInt64()+"|"+marker+"|"+(instance??"")+"|"+width.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+"|"+height.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+"|"+dpr.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+"|"+ownerBounds;
    }
    static bool ValidCached(Surface surface,IntPtr owner,Rectangle ownerBounds,double width,double height,double dpr){
        if(!Matches(surface,owner,width,height,dpr)||!OwnerUnchanged(owner,ownerBounds))return false;
        // A dock/menu move can preserve owner and CSS dimensions. Do not keep
        // returning a native proof that the layout path already knows is stale.
        return surface.Kind!="msaa-document"&&surface.Kind!="chrome-render-widget"||Same(surface,RefreshNative(surface,width,height,dpr));
    }
    // Safe for layout timers/input setup: one shared background provider lane,
    // no cross-process accessibility calls or waiting on the caller's thread.
    public static Surface TryLocateKnown(IntPtr owner,string marker,double width,double height,double dpr,string instance) {
        Rectangle ownerBounds;if(!TryScreenClient(owner,out ownerBounds))return null;var key=CacheKey(owner,marker,width,height,dpr,instance,ownerBounds);
        var value=fallback.Resolve(key,()=>MeasureContent(owner,marker,width,height,dpr),s=>ValidCached(s,owner,ownerBounds,width,height,dpr));
        return value.State=="ready"?value.Value:null;
    }
    // Only HTTP/background work calls this. The native path stays synchronous;
    // UIA fallback has one worker and this caller can wait at most 300 ms.
    public static Surface Locate(IntPtr owner,string marker,double width,double height,double dpr,string instance=null,int waitMilliseconds=300,bool fresh=false) {
        var ownerBounds=ScreenClient(owner);var key=CacheKey(owner,marker,width,height,dpr,instance,ownerBounds);
        // Captures use a distinct probe before and after copying. The short-lived
        // layout cache cannot prove that a UIA Document did not move inside an
        // unchanged browser client rectangle.
        if(fresh)key+="|capture:"+Guid.NewGuid().ToString("N");
        var value=fallback.Resolve(key,()=>MeasureContent(owner,marker,width,height,dpr),s=>ValidCached(s,owner,ownerBounds,width,height,dpr),waitMilliseconds);
        if(value.State=="ready")return value.Value;
        if(value.State=="failed")throw new Exception("课程内容位置暂时不稳定，请稍后重试。",value.Error);
        throw new Exception("正在确认课程内容位置，请稍后重试。");
    }
    // A Document can disambiguate equally sized Chromium widgets. Persistent
    // native panes need a real HWND to follow; UIA events/caches do not prove
    // that a Document has remained at its old location.
    public static Surface SelectLiveAnchor(Surface proof,IEnumerable<Surface> candidates,IntPtr owner,string marker,double width,double height,double dpr) {
        if(proof==null||owner==IntPtr.Zero||!Matches(proof,owner,width,height,dpr))return null;
        bool document=proof.Kind=="uia-document"&&!String.IsNullOrEmpty(marker)&&!String.IsNullOrEmpty(proof.Name)&&proof.Name.Contains(marker);
        if(!document&&proof.Kind!="chrome-render-widget")return null;
        Surface found=null;
        foreach(var candidate in candidates){
            if(candidate==null||candidate.Kind!="chrome-render-widget"||candidate.Handle==IntPtr.Zero||!Matches(candidate,owner,width,height,dpr)||candidate.Bounds!=proof.Bounds||(!document&&candidate.Handle!=proof.Handle))continue;
            if(found!=null&&found.Handle!=candidate.Handle)return null;
            found=candidate;
        }
        return found;
    }
    // Only background work may call this. UIA is used once to find a matching
    // native anchor; a genuinely UIA-only Document cannot support a live pane.
    public static Surface LocateLiveAnchor(IntPtr owner,string marker,double width,double height,double dpr,string instance=null,int waitMilliseconds=300) {
        var proof=Locate(owner,marker,width,height,dpr,instance,waitMilliseconds);
        if(proof.Kind=="msaa-document")return proof;
        try{return SelectLiveAnchor(proof,NativeSurfaces(owner),owner,marker,width,height,dpr);}
        catch(InvalidOperationException){return null;}
    }
    public static bool TryClientProjection(Surface first,Surface last,Rectangle ownerBefore,Rectangle ownerAfter,out Rectangle content) {
        content=Rectangle.Empty;
        if(!Same(first,last)||(first.Kind!="chrome-render-widget"&&first.Kind!="msaa-document")||first.Handle==IntPtr.Zero||first.Handle!=last.Handle||ownerBefore!=ownerAfter||ownerAfter.Width<=0||ownerAfter.Height<=0||!Inside(ownerAfter,last.Bounds))return false;
        content=last.Bounds;content.Offset(-ownerAfter.X,-ownerAfter.Y);return true;
    }
    // Read the native surface and parent origin within one stable observation.
    // A window move between the two Win32 samples is retried next tick instead
    // of mixing an old screen rectangle with a new client origin.
    public static bool TryLiveClientBounds(Surface registered,double width,double height,double dpr,out Rectangle content) {
        content=Rectangle.Empty;if(registered==null)return false;
        Rectangle before,after;if(!TryScreenClient(registered.Owner,out before))return false;
        var first=RefreshNative(registered,width,height,dpr);if(first==null)return false;
        if(!TryScreenClient(registered.Owner,out after))return false;
        var last=RefreshNative(first,width,height,dpr);
        return TryClientProjection(first,last,before,after,out content);
    }
    public static Rectangle ToOwnerClient(IntPtr owner,Rectangle screenRectangle) {
        var origin=ScreenClient(owner).Location;screenRectangle.Offset(-origin.X,-origin.Y);return screenRectangle;
    }
    // Input hooks may refresh this already registered handle, never traverse UIA
    // or enumerate all children. CSS dimensions/ratio and owner identity stay fixed.
    public static Surface RefreshNative(Surface registered,double width,double height,double dpr) {
        if(registered==null||(registered.Kind!="chrome-render-widget"&&registered.Kind!="msaa-document")||registered.Handle==IntPtr.Zero||!IsWindowVisible(registered.Handle)||GetAncestor(registered.Handle,2)!=registered.Owner)return null;
        var name=new StringBuilder(256);GetClassName(registered.Handle,name,name.Capacity);if(name.ToString()!="Chrome_RenderWidgetHostHWND")return null;
        Rectangle rect,ownerBounds;if(!TryScreenClient(registered.Handle,out rect)||!TryScreenClient(registered.Owner,out ownerBounds)||!Inside(ownerBounds,rect,registered.Kind=="msaa-document"?4:2))return null;
        if(registered.Kind=="msaa-document"){
            if(rect.Size!=registered.NativeBounds.Size||ownerBounds.Size!=registered.OwnerBounds.Size||rect.X-ownerBounds.X!=registered.NativeBounds.X-registered.OwnerBounds.X||rect.Y-ownerBounds.Y!=registered.NativeBounds.Y-registered.OwnerBounds.Y)return null;
            rect=registered.DocumentBounds;rect.Offset(ownerBounds.X-registered.OwnerBounds.X,ownerBounds.Y-registered.OwnerBounds.Y);rect=Rectangle.Intersect(rect,ownerBounds);
        }
        var value=new Surface{Owner=registered.Owner,Handle=registered.Handle,Bounds=rect,Kind=registered.Kind,Identity=registered.Identity,Name=registered.Name,NativeBounds=registered.NativeBounds,OwnerBounds=registered.OwnerBounds,DocumentBounds=registered.DocumentBounds};
        return Matches(value,value.Owner,width,height,dpr)?value:null;
    }
    public static bool Same(Surface a,Surface b) {
        return a!=null&&b!=null&&a.Owner==b.Owner&&a.Identity==b.Identity&&a.Kind==b.Kind&&a.Bounds==b.Bounds;
    }
    public static Rectangle Pixels(Surface surface,double width,double height,double dpr,double aside,double x,double y,double w,double h) {
        // Match ReadGeometry and the page validator: fitted board edges can
        // be a few floating-point ulps below zero before rounding to pixels.
        if(surface==null||!Finite(width)||!Finite(height)||!Finite(dpr)||!Finite(aside)||!Finite(x)||!Finite(y)||!Finite(w)||!Finite(h)||width<=0||height<=0||dpr<=0||aside<0||aside>=width||x<-.01||y<-.01||w<=0||h<=0||x+w>width-aside+.01||y+h>height+.01)throw new Exception("选区不在当前课程画面内。");
        int x1=Math.Max(0,(int)Math.Round(x*dpr,MidpointRounding.AwayFromZero)),y1=Math.Max(0,(int)Math.Round(y*dpr,MidpointRounding.AwayFromZero));
        int x2=Math.Min(surface.Bounds.Width,(int)Math.Round((x+w)*dpr,MidpointRounding.AwayFromZero)),y2=Math.Min(surface.Bounds.Height,(int)Math.Round((y+h)*dpr,MidpointRounding.AwayFromZero));
        if(x2<=x1||y2<=y1)throw new Exception("截图区域太小，请重新圈选。");
        return new Rectangle(surface.Bounds.Left+x1,surface.Bounds.Top+y1,x2-x1,y2-y1);
    }
    public static void EnsureClear(IEnumerable<Rectangle> overlays,Rectangle pixels) {
        foreach(var overlay in overlays)if(overlay.IntersectsWith(pixels))throw new Exception("课程区域被其它窗口遮挡，请等画面无遮挡后重试。");
    }
    public static void EnsureUnobscured(IntPtr owner,Rectangle pixels) {
        var overlays=new List<Rectangle>();int count=0;
        for(var window=GetWindow(owner,3);window!=IntPtr.Zero;window=GetWindow(window,3)){
            if(++count>256)throw new Exception("窗口层级正在变化，请稍后重试。");
            if(!IsWindowVisible(window)||IsIconic(window))continue;
            int cloaked;int hr=DwmGetWindowAttribute(window,14,out cloaked,4);
            if(hr==0&&cloaked!=0)continue;
            Rect r;if(GetWindowRect(window,out r))overlays.Add(Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom));
        }
        EnsureClear(overlays,pixels);
    }
}
