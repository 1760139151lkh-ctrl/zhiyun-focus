// Local, opt-in companion. No device disabling, key logging, browser profile access,
// remote debugging or injected input. Optional login startup is per-user.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class GuardPolicy {
    public static bool ValidOrigin(string origin) {
        Uri u;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out u) || u.AbsolutePath != "/" || u.Query != "" || u.Fragment != "" || u.UserInfo != "") return false;
        if (u.Scheme == "http" && (u.Host == "127.0.0.1" || u.Host == "localhost")) return u.Port == 8769;
        return u.Scheme == "https" && u.IsDefaultPort && (u.Host == "classroom.zju.edu.cn" || u.Host == "onlineroom.cmc.zju.edu.cn" || u.Host == "interactivemeta.cmc.zju.edu.cn" || u.Host == "webvpn.zju.edu.cn");
    }
    public static bool Touch(ulong info) { return (info & 0xFFFFFF00UL) == 0xFF515700UL; }
    public static bool Block(bool armed, bool ownerForeground, bool ownerTab, bool leaseAlive) { return armed && ownerForeground && ownerTab && leaseAlive; }
    public static bool Marker(string marker) { return marker != null && Regex.IsMatch(marker, @"^\[ZJF:[a-f0-9]{32}\]$"); }
}

sealed class ReturnToStudyGesture {
    readonly HashSet<int> held=new HashSet<int>();
    bool down,cancelled;
    long started;
    public void Reset(bool alreadyDown=false){down=alreadyDown;cancelled=alreadyDown;started=0;held.Clear();}
    public bool Key(int key,bool pressed,long now){
        if(key!=27){if(pressed)held.Add(key);else held.Remove(key);if(down)cancelled=true;return false;}
        if(pressed){if(!down){down=true;cancelled=held.Count!=0;started=now;}return false;}
        bool activate=down&&!cancelled&&now-started>=1200&&now-started<=6000;
        down=false;cancelled=false;started=0;return activate;
    }
}

// Lifecycle decisions are independent of Win32 so the entire transition policy
// can be exercised without opening or controlling a browser.
sealed class ImmersivePolicy {
    public bool ProtectionRequested;
    public bool CanProtect(bool ownTab,bool foreground,bool leaseAlive) {
        return ProtectionRequested&&ownTab&&foreground&&leaseAlive;
    }
    public static double ChatWidth(double width,double requested) {width=Math.Max(1,width);double minimum=Math.Min(200,width/2);return Math.Max(minimum,Math.Min(Math.Max(minimum,width-1),requested));}
    public static void RevealChat(IntPtr window,Func<IntPtr,bool> minimized,Action<IntPtr,int> show) {
        // SetWindowPos(SWP_SHOWWINDOW) alone cannot restore a minimized window.
        if(minimized(window))show(window,9);else show(window,4);
    }
}

static class Native {
    public delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    public delegate bool EnumWindow(IntPtr window, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; public int Width {get{return Right-Left;}} public int Height{get{return Bottom-Top;}} }
    [StructLayout(LayoutKind.Sequential)] public struct Mouse {public Point point;public uint data,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] public struct Monitor {public int size;public Rect bounds,work;public uint flags;}
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {public uint size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public Rect caretRect;}
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int kind, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback,IntPtr data);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window,ref Point point);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref Monitor info);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    public static string Title(IntPtr h) {var s=new StringBuilder(Math.Max(256,Math.Min(131072,GetWindowTextLength(h)+1)));GetWindowText(h,s,s.Capacity);return s.ToString();}
    public static double WindowDpi(IntPtr window){try{return GetDpiForWindow(window);}catch(EntryPointNotFoundException){using(var graphics=Graphics.FromHwnd(window))return graphics.DpiY;}}
    public static bool FocusContent(IntPtr window,IntPtr owner){
        if(window==IntPtr.Zero||GetForegroundWindow()!=owner||GetAncestor(window,2)!=owner||!IsWindowVisible(window))return false;
        SetFocus(owner);
        var info=new GuiThreadInfo{size=(uint)Marshal.SizeOf(typeof(GuiThreadInfo))};
        return GetGUIThreadInfo(0,ref info)&&(info.focus==owner||info.focus==window||IsChild(window,info.focus))&&GetForegroundWindow()==owner;
    }
    public static bool FocusWithin(IntPtr window){
        if(window==IntPtr.Zero||!IsWindow(window))return false;
        var info=new GuiThreadInfo{size=(uint)Marshal.SizeOf(typeof(GuiThreadInfo))};
        return GetGUIThreadInfo(0,ref info)&&(info.focus==window||IsChild(window,info.focus));
    }
    public static bool Chrome(IntPtr h) {var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);return s.ToString()=="Chrome_WidgetWin_1";}
    public static bool Fullscreen(IntPtr h) {if(h==IntPtr.Zero||IsIconic(h))return false;Rect r;GetWindowRect(h,out r);var m=new Monitor();m.size=Marshal.SizeOf(typeof(Monitor));if(!GetMonitorInfo(MonitorFromWindow(h,2),ref m))return false;return Math.Abs(r.Left-m.bounds.Left)<=1&&Math.Abs(r.Top-m.bounds.Top)<=1&&Math.Abs(r.Right-m.bounds.Right)<=1&&Math.Abs(r.Bottom-m.bounds.Bottom)<=1;}
    public static IntPtr Find(string marker,IntPtr except) {IntPtr found=IntPtr.Zero;bool ambiguous=false;EnumWindows(delegate(IntPtr h,IntPtr p){if(h!=except&&IsWindowVisible(h)&&Chrome(h)&&Title(h).Contains(marker)){if(found!=IntPtr.Zero){ambiguous=true;return false;}found=h;}return true;},IntPtr.Zero);return ambiguous?IntPtr.Zero:found;}
}

sealed class DeferredWork {
    readonly Func<object> run;
    public DeferredWork(Func<object> action){run=action;}
    public object Run(){return run();}
}
// Return delegate failures to the HTTP worker rather than WinForms'
// unhandled-exception UI. The existing response path keeps the original code.
sealed class UiCommandFailure {
    readonly Exception error;
    public UiCommandFailure(Exception value){error=value;}
    public static object Unwrap(object value){
        var failure=value as UiCommandFailure;
        if(failure!=null)System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure.error).Throw();
        return value;
    }
}
sealed class ShutdownReply {internal readonly long Generation;public ShutdownReply(long generation){Generation=generation;}public bool ok {get{return true;}}}

// A timed-out request must not execute later when the UI thread resumes.
// Once a command starts, its effects cannot be assumed to be cancelled.
sealed class PendingUiCommand {
    int state; // 0 queued, 1 running, 2 cancelled, 3 completed
    readonly long deadlineUtcMs;
    public PendingUiCommand(long deadline){deadlineUtcMs=deadline;}
    public static long NowUtcMs(){return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;}
    public bool Cancel(){return Interlocked.CompareExchange(ref state,2,0)==0;}
    public bool Cancelled {get{return Thread.VolatileRead(ref state)==2;}}
    public object Execute(Func<object> action){
        if(deadlineUtcMs>0&&NowUtcMs()>=deadlineUtcMs){Cancel();return null;}
        if(Interlocked.CompareExchange(ref state,1,0)!=0)return null;
        try{return action();}finally{Interlocked.Exchange(ref state,3);}
    }
}

sealed class CompanionFault : Exception {
    public readonly string Code;
    public CompanionFault(string code,string message):base(message){Code=code;}
}

sealed class StudySession {
    sealed class GeometryVersion {
        public readonly string Instance;public readonly long Epoch;
        public GeometryVersion(string instance,long epoch){Instance=instance;Epoch=epoch;}
    }
    sealed class ProtectionDoorRegion {
        public GeometryVersion Version;
        public BrowserCaptureViewport.Surface Surface;
        public double X,Y,Width,Height,VisualWidth,VisualHeight,OffsetX,OffsetY,Scale;
        public IntPtr Monitor;public double Dpi;
    }
    sealed class WorkspaceViewportProof {
        public IntPtr Owner;
        public string Session;
        public GeometryVersion Geometry;
        public long Revision;
        public BrowserCaptureViewport.Surface Surface;
        public IntPtr Monitor;public double Dpi;
    }
    sealed class FullscreenCommand {
        public IntPtr Window;public string Marker,Session;public bool Wanted;
        public readonly TaskCompletionSource<object> Completion=new TaskCompletionSource<object>();
    }
    sealed class FullscreenTransition {
        public IntPtr Window;public string Marker;public bool Wanted;public long Started;
    }
    readonly Stopwatch clock=Stopwatch.StartNew();
    readonly Native.Hook keyProc,mouseProc;
    readonly Control uiDispatcher;
    readonly EmbeddedChatPane pane;
    readonly WebViewChatWindows chatBrowser=new WebViewChatWindows();
    readonly ImmersivePolicy immersion=new ImmersivePolicy();
    readonly ReturnToStudyGesture returnGesture=new ReturnToStudyGesture();
    IntPtr owner,chat,keyHook,mouseHook;
    string marker,session,reason="沉浸体验准备中";
    bool armed,chatOpen,ownsFullscreen,workspaceProtocol;
    volatile bool disposed;
    string workspaceMode="closed";
    double cssWidth=1280,cssHeight=720,dpr=1,aside=0,desiredWidth=280,workspaceHeaderHeight,visualWidth=1280,visualHeight=720,visualScale=1;
    volatile GeometryVersion geometryVersion;
    volatile WorkspaceViewportProof workspaceViewport;
    GeometryVersion dpiGeometryPending;
    GeometryVersion doorDpiPending;
    volatile string viewportError="";
    volatile string viewportDiagnostic="";
    string viewportLookupKey="";
    int viewportLookupAttempts;
    int viewportLookupRunning;
    long viewportRetryAt;
    ProtectionDoorRegion protectionDoor;
    long pulse,deadline,rightDown,sequence,workspaceRevision,interactionRequested,chatFocusRequested,chatFocusRevision,chatFocusAt,connectionRevision;
    bool chatFocusBackward,retirementRunning,auxiliaryInput;
    long retirementRetryAt;
    long rebindChatRevision,rebindChatDeadline;
    FullscreenCommand fullscreenCommand;
    FullscreenTransition fullscreenTransition;
    long fullscreenClientRevision;
    string fullscreenClientIntent="";
    Task<object> fullscreenClientResult;
    Task<long> shutdownSave;
    public string Marker {get{return marker;}}
    public string SessionId {get{return session;}}
    public bool Protected {get{return armed;}}
    public EmbeddedChatPane Pane {get{return pane;}}
    public bool VerifyCaptureAck(Dictionary<string,object> payload){return chatBrowser.VerifyCaptureAck(payload);}
    public bool HasCaptureAttempt(string attemptId){return chatBrowser.HasCaptureAttempt(attemptId);}
    public object CaptureStatus(string attemptId){return chatBrowser.CaptureStatus(attemptId);}
    public BrowserCaptureViewport.FocusProof FocusEntryContext(){
        var geometry=geometryVersion;
        if(disposed||geometry==null||workspaceMode!="chat"||!pane.Visible||!OwnTab()||Native.GetForegroundWindow()!=owner)return null;
        return new BrowserCaptureViewport.FocusProof{Owner=owner,Marker=marker,Session=session,WorkspaceRevision=workspaceRevision,
            GeometryInstance=geometry.Instance,GeometryEpoch=geometry.Epoch,RequestedAt=Stopwatch.GetTimestamp()};
    }
    public bool Expired {get{
        if(disposed||owner==IntPtr.Zero)return true;
        if(!Native.IsWindow(owner)){
            var moved=Native.Find(marker,IntPtr.Zero);
            if(moved==IntPtr.Zero)return true;
            try{Rebind(moved);}catch{Release("课程窗口已移动，提问区域等待重新连接。",true);return false;}
        }
        // Explicit exit saves and releases immediately. A vanished tab may
        // lose that request while its browser window survives; retire only
        // after five minutes without a pulse and without the owning tab.
        // RetireAfterSave still keeps rejected writes and rechecks reconnects.
        return session==""||clock.ElapsedMilliseconds-pulse>300000&&!OwnTab();
    }}
    public object ChatDiagnostics {get{return new {paneError=pane.Error,workspaceMode=workspaceMode,layoutError=viewportError,layoutDetail=viewportDiagnostic,browser=chatBrowser.Diagnostics};}}
    public StudySession(IntPtr window,string titleMarker,Dictionary<string,object> metrics,Control dispatcher){
        uiDispatcher=dispatcher;
        owner=window;marker=titleMarker;session=Guid.NewGuid().ToString("N");
        chatBrowser.SetLessonContext(metrics);
        keyProc=OnKeyboard;mouseProc=OnMouse;pane=new EmbeddedChatPane(owner,chatBrowser);chatBrowser.FocusExitRequested=ReturnChatFocus;Metrics(metrics);
    }
    bool ReturnChatFocus(bool backward){
        var proof=workspaceViewport;
        // A queued Tab callback cannot take focus back from a newer browser or
        // system action. Consuming it does not record a focus transfer.
        if(disposed||workspaceMode!="chat"||!pane.Visible||!OwnTab()||Native.GetForegroundWindow()!=owner||!chatBrowser.HasInputFocus&&!Native.FocusWithin(pane.Handle))return true;
        if(proof==null||proof.Owner!=owner||proof.Session!=session||proof.Revision!=workspaceRevision)return false;
        var surface=BrowserCaptureViewport.RefreshNative(proof.Surface,cssWidth,cssHeight,dpr);
        if(surface==null||!Native.FocusContent(surface.Handle,owner))return false;
        chatFocusBackward=backward;chatFocusRevision=workspaceRevision;chatFocusAt=PendingUiCommand.NowUtcMs();chatFocusRequested++;return true;
    }
    public object Reconnect(Dictionary<string,object> metrics){
        if(!OwnTab())throw new CompanionFault("window_pending","课程窗口标识尚未同步，请保持课程标签页可见后重试。");
        connectionRevision++;
        bool resumePresented=lessonSwitchPresented&&workspaceMode=="chat"&&pane.Suspended;
        if(retirementRunning||lessonSwitching)chatBrowser.ResumeAfterFailedClose();lessonSwitching=false;
        object raw;var nextGeometry=metrics.TryGetValue("geometry",out raw)?raw as Dictionary<string,object>:null;
        if(geometryVersion!=null&&nextGeometry!=null&&Text(nextGeometry,"instance")!=geometryVersion.Instance){
            Release("新的观看窗口已连接。");resumePresented=false;rebindChatRevision=0;workspaceRevision++;HideChat();
        }
        if(resumePresented){pane.Open(desiredWidth,clock.ElapsedMilliseconds);rebindChatRevision=workspaceRevision;rebindChatDeadline=clock.ElapsedMilliseconds+12000;}
        lessonSwitchPresented=false;
        Metrics(metrics);session=Guid.NewGuid().ToString("N");fullscreenClientRevision=0;fullscreenClientIntent="";fullscreenClientResult=null;pulse=clock.ElapsedMilliseconds;
        var result=State();result["session"]=session;return result;
    }
    public bool SameLesson(Dictionary<string,object> metrics){return !metrics.ContainsKey("lessonKey")||StudyLibrary.NormalizeLessonKey(Text(metrics,"lessonKey"))==chatBrowser.LessonKey;}
    bool lessonSwitching,lessonSwitchPresented;
    Task<object> lessonSwitch;long lessonSwitchRevision;string lessonSwitchIdentity="";
    public Task<object> SwitchLesson(Dictionary<string,object> metrics){
        object raw;var geometry=metrics.TryGetValue("geometry",out raw)?raw as Dictionary<string,object>:null;
        string identity=StudyLibrary.NormalizeLessonKey(Text(metrics,"lessonKey"))+"|"+(geometry==null?"":Text(geometry,"instance"));
        // A page timeout queries the same accepted save. Repeating that save
        // would keep superseding its freeze before a slow disk can finish.
        if(lessonSwitch!=null&&!lessonSwitch.IsCompleted&&lessonSwitchRevision==connectionRevision&&lessonSwitchIdentity==identity)return lessonSwitch;
        lessonSwitchIdentity=identity;lessonSwitch=SwitchLessonCore(metrics);return lessonSwitch;
    }
    async Task<object> SwitchLessonCore(Dictionary<string,object> metrics){
        long revision=++connectionRevision;lessonSwitchRevision=revision;
        long freeze=0;
        lessonSwitchPresented|=pane.Presented;lessonSwitching=true;rebindChatRevision=0;
        Release("正在保存上一讲提问。");pane.Suspend();
        try{
            freeze=await chatBrowser.PrepareToClose();if(disposed||revision!=connectionRevision)throw new CompanionFault("lesson_changed","已有新的课程连接，原草稿保存已完成。");pane.Dispose();chatOpen=false;workspaceMode="closed";chatBrowser.SetWorkspaceState(workspaceMode,workspaceRevision);aside=0;
            chatBrowser.SetLessonContext(metrics);return Reconnect(metrics);
        }catch{if(freeze!=0&&revision==connectionRevision)chatBrowser.ResumeAfterFailedClose(freeze);throw;}
        finally{if(revision==connectionRevision)lessonSwitching=false;}
    }
    public void Dispose(){if(disposed)return;disposed=true;if(fullscreenCommand!=null)fullscreenCommand.Completion.TrySetException(new CompanionFault("request_cancelled","课程窗口已关闭，原全屏操作未能确认。"));fullscreenCommand=null;fullscreenTransition=null;Release("助手已退出");RestoreChat();}
    public bool TryRetire(){
        if(disposed)return true;
        if(Expired&&!retirementRunning&&clock.ElapsedMilliseconds>=retirementRetryAt){retirementRunning=true;RetireAfterSave();}
        return disposed;
    }
    async void RetireAfterSave(){
        long freeze=0;
        try{
            Release("正在保存提问。");
            freeze=await chatBrowser.PrepareToClose();
            // Reopening while a save is pending keeps this same controller and
            // its newest input. Expiration never discards a rejected save.
            if(!Expired){if(freeze!=0)chatBrowser.ResumeAfterFailedClose(freeze);return;}
            Dispose();
        }catch(Exception error){if(freeze!=0)chatBrowser.ResumeAfterFailedClose(freeze);reason=error.Message;retirementRetryAt=clock.ElapsedMilliseconds+5000;}
        finally{retirementRunning=false;}
    }
    public Task ReleaseForShutdown(){rebindChatRevision=0;Release("正在保存资料并退出。");shutdownSave=chatBrowser.PrepareToClose();return shutdownSave;}
    public async void ResumeAfterFailedShutdown(){var saving=shutdownSave;shutdownSave=null;if(saving==null)return;try{long freeze=await saving;if(freeze!=0)chatBrowser.ResumeAfterFailedClose(freeze);}catch{}}
    public void Rebind(IntPtr window){
        if(window==owner)return;
        bool restore=workspaceMode=="chat"&&pane.Presented;
        Release("课程窗口已移动，写字保护暂时暂停。",true);
        pane.Rebind(window);owner=window;
        if(!lessonSwitching&&workspaceMode=="chat"&&!pane.Attached){
            if(restore){rebindChatRevision=workspaceRevision;rebindChatDeadline=clock.ElapsedMilliseconds+12000;}
            pane.Open(desiredWidth,clock.ElapsedMilliseconds);
        }
    }
    public bool OwnTab() {return owner!=IntPtr.Zero && Native.IsWindow(owner) && Native.Title(owner).Contains(marker);}
    bool Blocking() {return GuardPolicy.Block(armed,Native.GetForegroundWindow()==owner,OwnTab(),clock.ElapsedMilliseconds-pulse<6500);}
    IntPtr OnKeyboard(int code,IntPtr message,IntPtr data) {
        if(code<0)return Native.CallNextHookEx(IntPtr.Zero,code,message,data);
        if(code>=0 && Blocking()){
            int key=Marshal.ReadInt32(data);
            bool tab=key==9&&workspaceMode!="closed"&&Native.GetAsyncKeyState(17)>=0&&Native.GetAsyncKeyState(18)>=0&&Native.GetAsyncKeyState(91)>=0&&Native.GetAsyncKeyState(92)>=0;
            if(tab||workspaceMode=="chat"&&pane.Visible&&(chatBrowser.HasInputFocus||Native.FocusWithin(pane.Handle))||workspaceMode!="closed"&&auxiliaryInput){returnGesture.Reset(Native.GetAsyncKeyState(27)<0);return Native.CallNextHookEx(IntPtr.Zero,code,message,data);}
            int kind=message.ToInt32();
            if(kind==0x100||kind==0x101||kind==0x104||kind==0x105){
                if(returnGesture.Key(Marshal.ReadInt32(data),kind==0x100||kind==0x104,clock.ElapsedMilliseconds))interactionRequested++;
            }
            // Other low-level filters must still observe key transitions.
            // Returning nonzero here continues to block delivery to apps.
            Native.CallNextHookEx(IntPtr.Zero,code,message,data);
            return new IntPtr(1);
        }
        returnGesture.Reset(Native.GetAsyncKeyState(27)<0);
        return Native.CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    IntPtr OnMouse(int code,IntPtr message,IntPtr data) {
        if(code>=0 && Blocking()){
            var m=(Native.Mouse)Marshal.PtrToStructure(data,typeof(Native.Mouse));
            int msg=message.ToInt32();
            if(msg==0x205)rightDown=0;
            bool auxiliary=InsideAuxiliaryWorkspace(m.point);
            if(msg==0x201)auxiliaryInput=auxiliary;
            if(auxiliary)return Native.CallNextHookEx(IntPtr.Zero,code,message,data);
            if(GuardPolicy.Touch(m.extra.ToUInt64())&&!InsideProtectionDoor(m.point))return new IntPtr(1);
            if(msg==0x204){rightDown=clock.ElapsedMilliseconds;return new IntPtr(1);}
            if(msg==0x205){rightDown=0;return new IntPtr(1);}
        }
        return Native.CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    void Arm(int seconds) {
        if(!OwnTab() || Native.GetForegroundWindow()!=owner)throw new Exception("请先用鼠标点击课程画面，再开启写字保护。");
        foreach(int k in new[]{16,17,18,91,92})if(Native.GetAsyncKeyState(k)<0)throw new Exception("请先松开 Ctrl、Alt、Shift 和 Windows 键。");
        bool input=auxiliaryInput;Release("");auxiliaryInput=input;
        keyHook=Native.SetWindowsHookEx(13,keyProc,Native.GetModuleHandle(null),0);
        mouseHook=Native.SetWindowsHookEx(14,mouseProc,Native.GetModuleHandle(null),0);
        if(keyHook==IntPtr.Zero||mouseHook==IntPtr.Zero){Release("系统防护未启动。");throw new Exception(reason);}
        deadline=seconds==10?clock.ElapsedMilliseconds+10000:0;
        armed=true;reason=seconds==10?"正在试用保护，10 秒后自动恢复。":"写字保护已开启。按住鼠标右键 2 秒可恢复。";
        returnGesture.Reset(Native.GetAsyncKeyState(27)<0);
        immersion.ProtectionRequested=true;
    }
    void Release(string message,bool preserveRequest=false) {
        if(!preserveRequest)immersion.ProtectionRequested=false;
        armed=false;if(!preserveRequest){deadline=0;auxiliaryInput=false;}rightDown=0;returnGesture.Reset(Native.GetAsyncKeyState(27)<0);
        if(keyHook!=IntPtr.Zero){Native.UnhookWindowsHookEx(keyHook);keyHook=IntPtr.Zero;}
        if(mouseHook!=IntPtr.Zero){Native.UnhookWindowsHookEx(mouseHook);mouseHook=IntPtr.Zero;}
        if(message!="")reason=message;
    }
    void DriveFullscreen(bool queried=false){
        var command=fullscreenCommand;
        try{
            if(fullscreenTransition!=null){
                var pending=fullscreenTransition;
                if(!Native.IsWindow(pending.Window)||!Native.Title(pending.Window).Contains(pending.Marker))throw new CompanionFault("window_pending","课程窗口已变化，原全屏操作未能确认。");
                bool expired=clock.ElapsedMilliseconds-pending.Started>=5000;
                // A posted F11 is not cancelled by an HTTP timeout. Keep its
                // identity; later status queries inspect that same transition.
                if(expired&&!queried){if(command!=null)command.Completion.TrySetException(new CompanionFault("operation_pending","原全屏切换仍未确认，请先查看当前状态。"));return;}
                if(Native.Fullscreen(pending.Window)!=pending.Wanted){if(expired&&command!=null)command.Completion.TrySetException(new CompanionFault("operation_pending","原全屏切换仍未确认，请先查看当前状态。"));return;}
                fullscreenTransition=null;
            }
            if(command==null)return;
            if(disposed||command.Window!=owner||command.Session!=session||!Native.IsWindow(command.Window)||!Native.Title(command.Window).Contains(command.Marker))throw new CompanionFault("request_cancelled","课程连接已变化，新的全屏操作未执行。");
            if(Native.Fullscreen(command.Window)==command.Wanted){ownsFullscreen=command.Wanted;fullscreenCommand=null;command.Completion.TrySetResult(new {fullscreen=command.Wanted});return;}
            if(command.Wanted&&Native.GetForegroundWindow()!=owner)throw new CompanionFault("request_cancelled","已离开课程窗口，全屏操作未执行。");
            if(!Native.PostMessage(command.Window,0x100,new IntPtr(0x7A),new IntPtr(0x00570001)))throw new Exception("全屏切换未能提交。");
            fullscreenTransition=new FullscreenTransition{Window=command.Window,Marker=command.Marker,Wanted=command.Wanted,Started=clock.ElapsedMilliseconds};
            Native.PostMessage(command.Window,0x101,new IntPtr(0x7A),new IntPtr(unchecked((int)0xC0570001)));
        }catch(Exception error){fullscreenTransition=null;if(command!=null)command.Completion.TrySetException(error);if(Object.ReferenceEquals(fullscreenCommand,command))fullscreenCommand=null;}
    }
    bool FullscreenReplay(Dictionary<string,object> p,string intent,out Task<object> result){
        result=null;if(!p.ContainsKey("fullscreenRevision"))return false;
        long revision=LayoutRevision(p,"fullscreenRevision");
        if(revision<fullscreenClientRevision)throw new CompanionFault("request_cancelled","已有更新的全屏选择，原操作未执行。");
        if(revision==fullscreenClientRevision){if(fullscreenClientIntent!=intent)throw new CompanionFault("invalid_request","同一次全屏操作的目标不能改变。");result=fullscreenClientResult;return true;}
        fullscreenClientRevision=revision;fullscreenClientIntent=intent;fullscreenClientResult=null;return false;
    }
    object RequestFullscreen(Dictionary<string,object> p){
        bool wanted=Text(p,"enabled")=="True";Task<object> replay;
        if(FullscreenReplay(p,wanted?"enter":"exit",out replay))return new DeferredWork(delegate{return replay.GetAwaiter().GetResult();});
        if(fullscreenCommand!=null)fullscreenCommand.Completion.TrySetException(new CompanionFault("request_cancelled","已有更新的全屏选择，原操作不再决定当前状态。"));
        var command=new FullscreenCommand{Window=owner,Marker=marker,Session=session,Wanted=wanted};fullscreenCommand=command;if(p.ContainsKey("fullscreenRevision"))fullscreenClientResult=command.Completion.Task;DriveFullscreen(true);
        return new DeferredWork(delegate{return command.Completion.Task.GetAwaiter().GetResult();});
    }
    object ReleaseFullscreen(Dictionary<string,object> p){
        Task<object> replay;if(FullscreenReplay(p,"release",out replay))return new DeferredWork(delegate{return replay.GetAwaiter().GetResult();});
        if(fullscreenCommand!=null)fullscreenCommand.Completion.TrySetException(new CompanionFault("request_cancelled","用户已接管全屏，原操作不再更改窗口。"));
        fullscreenCommand=null;fullscreenTransition=null;ownsFullscreen=false;
        var result=new {released=true};if(p.ContainsKey("fullscreenRevision"))fullscreenClientResult=Task.FromResult<object>(result);return result;
    }
    public void Tick() {
        if(disposed)return;
        DriveFullscreen();
        if(owner!=IntPtr.Zero && (session=="" || !OwnTab() || clock.ElapsedMilliseconds-pulse>6500)){
            // A title refresh or a throttled background heartbeat is not an
            // instruction to exit fullscreen or forget the attached chat.
            Release("课程暂未连接，写字保护已暂停。",true);
            pane.Tick(clock.ElapsedMilliseconds,visualWidth,visualHeight,dpr*visualScale,false);
            return;
        }
        if(armed){
            if(Native.GetForegroundWindow()!=owner){Release("已离开课程窗口，写字保护已暂停。",true);}
            else if(deadline>0&&clock.ElapsedMilliseconds>=deadline){Release("10 秒试用结束，键盘和触屏已恢复。");}
            else if(rightDown>0 && Native.GetAsyncKeyState(2)>=0){rightDown=0;}
            else if(rightDown>0 && clock.ElapsedMilliseconds-rightDown>=2000){Release("已用鼠标右键长按解除保护。");}
        }
        PlaceChat();
        if(!armed&&deadline>0&&clock.ElapsedMilliseconds>=deadline)Release("10 秒试用结束，键盘和触屏已恢复。");
        if(!armed&&immersion.CanProtect(OwnTab(),Native.GetForegroundWindow()==owner,clock.ElapsedMilliseconds-pulse<=6500)){
            long expires=deadline;
            try{Arm(0);deadline=expires;}catch{ /* Wait until modifiers are released. */ }
        }

    }
    void HideChat() {pane.Hide();workspaceMode="closed";chatBrowser.SetWorkspaceState(workspaceMode,workspaceRevision);chatOpen=false;aside=0;}
    void RestoreChat() {pane.Dispose();chat=IntPtr.Zero;workspaceMode="closed";chatBrowser.SetWorkspaceState(workspaceMode,workspaceRevision);chatOpen=false;aside=0;}
    void PlaceChat() {
        ResolveWorkspaceViewport();
        pane.Tick(clock.ElapsedMilliseconds,visualWidth,visualHeight,dpr*visualScale,OwnTab()&&clock.ElapsedMilliseconds-pulse<=6500);
        if(rebindChatRevision>0){
            if(lessonSwitching||workspaceMode!="chat"||workspaceRevision!=rebindChatRevision||pane.Error!=""||clock.ElapsedMilliseconds>=rebindChatDeadline)rebindChatRevision=0;
            else if(pane.Opened&&!pane.Suspended&&pane.LayoutReady){pane.Confirm();rebindChatRevision=0;pane.Tick(clock.ElapsedMilliseconds,visualWidth,visualHeight,dpr*visualScale,OwnTab()&&clock.ElapsedMilliseconds-pulse<=6500);}
        }
        chat=pane.Handle;chatOpen=workspaceMode=="chat"&&(pane.Opened||pane.Starting);
        aside=workspaceMode=="closed"?0:ImmersivePolicy.ChatWidth(visualWidth,desiredWidth);
        if(workspaceMode=="chat"&&pane.Error!="")reason=pane.Error;
    }
    static bool SameGeometry(GeometryVersion a,GeometryVersion b){return a!=null&&b!=null&&a.Instance==b.Instance&&a.Epoch==b.Epoch;}
    static Rectangle OwnerContentBounds(IntPtr window){
        Native.Rect rect;var origin=new Native.Point();if(!Native.GetClientRect(window,out rect)||!Native.ClientToScreen(window,ref origin))return Rectangle.Empty;
        return new Rectangle(origin.X,origin.Y,rect.Width,rect.Height);
    }
    void ResolveWorkspaceViewport(){
        if(!workspaceProtocol){pane.SetViewport(null,false);return;}
        if(workspaceMode=="closed"){pane.SetViewport(null,true);return;}
        var geometry=geometryVersion;var proof=workspaceViewport;
        // The measured document origin can survive a menu/header or capture
        // revision. Its live HWND, size, owner, monitor and DPI are still checked.
        if(proof!=null&&proof.Owner==owner&&proof.Session==session&&geometry!=null&&proof.Geometry.Instance==geometry.Instance){
            Rectangle rect;
            double liveDpi=Native.WindowDpi(owner);bool sameDpi=liveDpi>0&&Math.Abs(liveDpi-proof.Dpi)<.1;
            if(!sameDpi)dpiGeometryPending=geometry;
            if(sameDpi&&Native.MonitorFromWindow(owner,2)==proof.Monitor&&BrowserCaptureViewport.TryLiveClientBounds(proof.Surface,cssWidth,cssHeight,dpr,out rect)){
                var bounds=OwnerContentBounds(owner);
                if(rect.Width>0&&rect.Height>0&&rect.X>=0&&rect.Y>=0&&rect.Right<=bounds.Width+1&&rect.Bottom<=bounds.Height+1){
                    rect.Width=Math.Min(rect.Width,(int)Math.Round(visualWidth*dpr*visualScale,MidpointRounding.AwayFromZero));
                    rect.Height=Math.Min(rect.Height,(int)Math.Round(visualHeight*dpr*visualScale,MidpointRounding.AwayFromZero));
                    if(rect.Width<1||rect.Height<1){viewportError="当前可视区域过小，请调整窗口后重试。";pane.SetViewport(null,true);return;}
                    if(proof.Revision!=workspaceRevision||!SameGeometry(proof.Geometry,geometry))workspaceViewport=new WorkspaceViewportProof{Owner=owner,Session=session,Geometry=geometry,Revision=workspaceRevision,Surface=proof.Surface,Monitor=proof.Monitor,Dpi=proof.Dpi};
                    pane.SetViewport(new ChatViewport{X=rect.X,Y=rect.Y,Width=rect.Width,Height=rect.Height},true);viewportError="";return;
                }
            }
        }
        pane.SetViewport(null,true);
        if(geometry==null){viewportError="课程画面位置尚未同步，请稍后再试。";return;}
        if(SameGeometry(geometry,dpiGeometryPending)){viewportError="课程缩放正在同步，请稍后再试。";return;}
        dpiGeometryPending=null;
        IntPtr target=owner;string expectedSession=session,titleMarker=marker;long revision=workspaceRevision;
        IntPtr monitor=Native.MonitorFromWindow(target,2);double acceptedDpi=Native.WindowDpi(target);
        double width=cssWidth,height=cssHeight,ratio=dpr;var ownerBounds=OwnerContentBounds(target);
        string lookupKey=target.ToInt64()+"|"+expectedSession+"|"+geometry.Instance+"|"+geometry.Epoch+"|"+revision+"|"+width+"|"+height+"|"+ratio+"|"+monitor.ToInt64()+"|"+acceptedDpi+"|"+ownerBounds;
        if(viewportLookupKey!=lookupKey){viewportLookupKey=lookupKey;viewportLookupAttempts=0;viewportRetryAt=0;viewportError="";}
        if(disposed||clock.ElapsedMilliseconds<viewportRetryAt||Interlocked.CompareExchange(ref viewportLookupRunning,1,0)!=0)return;
        int attempt=viewportLookupAttempts=Math.Min(4,viewportLookupAttempts+1);viewportRetryAt=clock.ElapsedMilliseconds+Math.Min(2800,700*(1<<Math.Min(2,attempt-1)));
        Func<bool> current=delegate{return !disposed&&owner==target&&session==expectedSession&&workspaceMode!="closed"&&workspaceRevision==revision&&SameGeometry(geometryVersion,geometry)&&Math.Abs(cssWidth-width)<.01&&Math.Abs(cssHeight-height)<.01&&Math.Abs(dpr-ratio)<.0001&&Native.IsWindow(target)&&Native.Title(target).Contains(titleMarker)&&Native.MonitorFromWindow(target,2)==monitor&&Math.Abs(Native.WindowDpi(target)-acceptedDpi)<.1&&OwnerContentBounds(target)==ownerBounds;};
        ThreadPool.QueueUserWorkItem(delegate{
            BrowserCaptureViewport.Surface surface=null;Exception failure=null;
            try{surface=BrowserCaptureViewport.LocateLiveAnchor(target,titleMarker,width,height,ratio,geometry.Instance,300);}
            catch(Exception error){failure=error;}
            try{uiDispatcher.BeginInvoke(new Action(delegate{
                try{
                    // Validate and publish together on the UI thread. A newer
                    // workspace cannot arrive between this fence and the write.
                    if(!current())return;
                    if(failure!=null){viewportDiagnostic=failure.ToString();viewportError=attempt>=4?(String.IsNullOrWhiteSpace(failure.Message)?"暂时无法确认提问区域的位置，请稍后重试。":failure.Message):"";}
                    else if(surface!=null&&surface.Owner==target&&ownerBounds==OwnerContentBounds(target)){
                        workspaceViewport=new WorkspaceViewportProof{Owner=target,Session=expectedSession,Geometry=geometry,Revision=revision,Surface=surface,Monitor=monitor,Dpi=acceptedDpi};viewportError="";
                    }else{viewportError="暂时无法可靠定位课程内容，提问区保持隐藏。请保持课程画面可见后重试。";}
                }finally{Interlocked.Exchange(ref viewportLookupRunning,0);}
            }));}catch(InvalidOperationException){Interlocked.Exchange(ref viewportLookupRunning,0);}
        });
    }
    public void Disconnect(string why) {
        connectionRevision++;lessonSwitching=false;lessonSwitchPresented=false;rebindChatRevision=0;
        Release(why);
        // Fullscreen is changed only by an explicit /fullscreen command.
        // Retirement saves before releasing the chat. A reconnect arriving
        // during that save cancels retirement and keeps the same controller.
        ownsFullscreen=false;HideChat();session="";
    }
    object Capture(Dictionary<string,object> p) {
        if(!OwnTab()||Native.GetForegroundWindow()!=owner)throw new Exception("请回到课程画面，再截取板书。");
        double panel=aside;
        var g=BrowserCaptureViewport.ReadRequest(p,panel);
        var paint=BrowserCaptureViewport.ReadPaint(p,g);
        IntPtr target=owner,monitor=Native.MonitorFromWindow(owner,2);string titleMarker=marker,captureSession=session;
        double acceptedDpi;using(var probe=Graphics.FromHwnd(target))acceptedDpi=probe.DpiY;
        long acceptedWorkspaceRevision=workspaceRevision;
        Func<bool> stable=delegate{
            var currentGeometry=geometryVersion;
            return currentGeometry!=null&&currentGeometry.Instance==g.Instance&&currentGeometry.Epoch==g.Epoch&&workspaceRevision==acceptedWorkspaceRevision&&owner==target&&session==captureSession&&marker==titleMarker&&Native.IsWindow(target)&&!Native.IsIconic(target)&&Native.GetForegroundWindow()==target&&Native.Title(target).Contains(titleMarker)&&Native.MonitorFromWindow(target,2)==monitor&&Math.Abs(cssWidth-g.Width)<=.5&&Math.Abs(cssHeight-g.Height)<=.5&&Math.Abs(dpr-g.Dpr)<=.0001&&Math.Abs(aside-panel)<=.01;
        };
        return new DeferredWork(delegate{
            if(!stable())throw new Exception("课程画面已变化，请返回后重试截图。");
            double liveDpi;using(var probe=Graphics.FromHwnd(target))liveDpi=probe.DpiY;
            if(Math.Abs(liveDpi-acceptedDpi)>.1)throw new Exception("课程缩放已变化，请重新截图。");
            var content=BrowserCaptureViewport.Locate(target,titleMarker,g.Width,g.Height,g.Dpr,g.Instance,300,true);
            var pixels=g.Pixels(content);
            if(pixels.Width>16384||pixels.Height>16384||(long)pixels.Width*pixels.Height>32L*1024*1024||!SystemInformation.VirtualScreen.Contains(pixels))throw new Exception("截图区域超出原像素保存范围或当前不可见，已取得的材料仍保留。");
            BrowserCaptureViewport.EnsureUnobscured(target,pixels);
            BrowserCaptureViewport.WaitForPaint(target,content,g,paint,stable);
            if(!stable())throw new Exception("课程画面已变化，请返回后重试截图。");
            using(var bitmap=new Bitmap(pixels.Width,pixels.Height))using(var graphics=Graphics.FromImage(bitmap))using(var memory=new MemoryStream()){
                graphics.CopyFromScreen(pixels.Left,pixels.Top,0,0,pixels.Size,CopyPixelOperation.SourceCopy);
                // This must be a fresh UIA probe, never TryLocateKnown's layout cache.
                var after=BrowserCaptureViewport.Locate(target,titleMarker,g.Width,g.Height,g.Dpr,g.Instance,300,true);
                double afterDpi;using(var probe=Graphics.FromHwnd(target))afterDpi=probe.DpiY;
                BrowserCaptureViewport.EnsureUnobscured(target,pixels);
                if(!stable()||!BrowserCaptureViewport.Same(content,after)||Math.Abs(afterDpi-liveDpi)>.1||!BrowserCaptureViewport.PaintVisible(after,g,paint))throw new Exception("截图期间课程视区已变化，请重新截图。");
                bitmap.Save(memory,System.Drawing.Imaging.ImageFormat.Png);
                if(memory.Length>72L*1024*1024-65536)throw new Exception("这张原像素截图超过保存预算，已取得的材料仍保留，请缩小选区。");
                return new {image="data:image/png;base64,"+Convert.ToBase64String(memory.ToArray()),width=pixels.Width,height=pixels.Height,
                    viewport=new {kind=content.Kind=="msaa-document"?"chrome-render-widget":content.Kind,originSource=content.Kind,identity=content.Identity,ownerId=target.ToInt64().ToString(),x=content.Bounds.X,y=content.Bounds.Y,width=content.Bounds.Width,height=content.Bounds.Height,cssWidth=g.Width,cssHeight=g.Height,dpr=g.Dpr,visual=new {width=g.VisualWidth,height=g.VisualHeight,offsetLeft=g.OffsetX,offsetTop=g.OffsetY,scale=g.VisualScale}},
                    raster=new {x=pixels.X,y=pixels.Y,width=pixels.Width,height=pixels.Height},geometry=new {instance=g.Instance,epoch=g.Epoch},paint=paint==null?null:new {nonce=paint.Nonce,verified=true}};
            }
        });
    }

    public Dictionary<string,object> State() {
        DriveFullscreen(true);
        PlaceChat();
return new Dictionary<string,object>{{"sequence",++sequence},{"connected",owner!=IntPtr.Zero&&session!=""},{"foreground",Native.GetForegroundWindow()==owner&&OwnTab()},{"protected",armed},{"protectionRequested",immersion.ProtectionRequested},{"fullscreen",Native.Fullscreen(owner)},{"chatOpen",workspaceMode=="chat"&&pane.Opened&&pane.LayoutReady},{"chatOpening",workspaceMode=="chat"&&(pane.Starting||pane.Opened&&!pane.LayoutReady)},{"chatError",workspaceMode=="chat"?(pane.Error!=""?pane.Error:viewportError):""},{"chatLayoutPending",workspaceMode=="chat"&&!pane.LayoutReady},{"chatLayoutError",workspaceMode=="chat"?viewportError:""},{"chatLayoutDiagnostic",viewportDiagnostic},{"chatVisible",workspaceMode=="chat"&&pane.Visible},{"chatFocused",workspaceMode=="chat"&&(chatBrowser.HasInputFocus||Native.FocusWithin(pane.Handle))},{"chatAttached",pane.Attached},{"chatDraftReady",chatBrowser.CaptureReady},{"chatDraftError",chatBrowser.CaptureError},{"chatDraftTarget",chatBrowser.CaptureTarget},{"sidebarWidth",aside},{"workspaceMode",workspaceMode},{"workspaceRevision",workspaceRevision},{"workspaceWidth",aside},{"workspaceHeaderHeight",workspaceHeaderHeight},{"interactionRequested",interactionRequested},{"chatFocusRequested",chatFocusRequested},{"chatFocusBackward",chatFocusBackward},{"chatFocusRevision",chatFocusRevision},{"chatFocusAt",chatFocusAt},{"protectionDoorReady",Blocking()&&ProtectionDoorSurface()!=null},{"reason",reason},{"remaining",deadline==0?0:Math.Max(0,(deadline-clock.ElapsedMilliseconds)/1000.0)}};
    }
    static string Text(Dictionary<string,object> p,string key) {object v;return p.TryGetValue(key,out v)?Convert.ToString(v):"";}
    static double Number(Dictionary<string,object> p,string key,double fallback) {double v;return double.TryParse(Text(p,key),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out v)&&!double.IsNaN(v)&&!double.IsInfinity(v)?v:fallback;}
    void Metrics(Dictionary<string,object> p) {
        object rawGeometry;GeometryVersion incoming=null;
        if(p.TryGetValue("geometry",out rawGeometry)){
            var geometry=rawGeometry as Dictionary<string,object>;object rawInstance,rawEpoch;
            if(geometry==null||!geometry.TryGetValue("instance",out rawInstance)||!(rawInstance is string)||String.IsNullOrWhiteSpace((string)rawInstance)||((string)rawInstance).Length>128||!geometry.TryGetValue("epoch",out rawEpoch)||(!(rawEpoch is int)&&!(rawEpoch is long)))throw new CompanionFault("invalid_request","课程画面身份无效，请重新连接。");
            long epoch=Convert.ToInt64(rawEpoch);if(epoch<1||epoch>9007199254740991L)throw new CompanionFault("invalid_request","课程画面版本无效，请重新连接。");
            incoming=new GeometryVersion((string)rawInstance,epoch);var current=geometryVersion;
            if(current!=null&&current.Instance==incoming.Instance&&incoming.Epoch<current.Epoch)return;
        }
        var viewport=incoming==null?null:BrowserCaptureViewport.ReadViewportMetrics(p);
        if(p.ContainsKey("lessonKey")&&p.ContainsKey("course")&&SameLesson(p))chatBrowser.SetLessonContext(p);
        // Validate the workspace identity before changing live dimensions.
        bool currentWorkspace=!workspaceProtocol||p.ContainsKey("revision")&&LayoutRevision(p,"revision")==workspaceRevision||p.ContainsKey("workspaceRevision")&&LayoutRevision(p,"workspaceRevision")==workspaceRevision;
        cssWidth=Math.Max(320,Math.Min(10000,Number(p,"width",cssWidth)));cssHeight=Math.Max(200,Math.Min(10000,Number(p,"height",cssHeight)));dpr=Math.Max(.5,Math.Min(5,Number(p,"dpr",dpr)));
        if(viewport!=null){visualWidth=viewport.VisualWidth;visualHeight=viewport.VisualHeight;visualScale=viewport.VisualScale;}
        else if(!workspaceProtocol||geometryVersion==null){visualWidth=cssWidth;visualHeight=cssHeight;visualScale=1;}
        aside=workspaceMode=="closed"?0:ImmersivePolicy.ChatWidth(visualWidth,desiredWidth);
        // Header dimensions belong to the currently acknowledged workspace;
        // an older in-flight heartbeat must not overwrite a newer layout.
        if(currentWorkspace)workspaceHeaderHeight=workspaceProtocol?Math.Max(0,Math.Min(Math.Max(0,visualHeight-120),Number(p,"headerHeight",workspaceHeaderHeight))):0;
        if(currentWorkspace&&incoming!=null){var geometry=rawGeometry as Dictionary<string,object>;object allowed;if(geometry.TryGetValue("auxiliaryInput",out allowed)){if(!(allowed is bool))throw new CompanionFault("invalid_request","学习输入范围无效。");auxiliaryInput=workspaceMode!="closed"&&(bool)allowed;}}
        pane.SetHeader(workspaceHeaderHeight);
        if(incoming!=null){geometryVersion=incoming;chatBrowser.SetViewerInstance(incoming.Instance);PrepareProtectionDoor(rawGeometry as Dictionary<string,object>,incoming);}
    }
    void PrepareProtectionDoor(Dictionary<string,object> geometry,GeometryVersion version){
        var previous=protectionDoor;protectionDoor=null;object raw;var door=geometry.TryGetValue("protectionDoor",out raw)?raw as Dictionary<string,object>:null;
        if(door==null)return;
        double nativeDpi=Native.WindowDpi(owner);var monitor=Native.MonitorFromWindow(owner,2);
        if(previous!=null&&SameGeometry(previous.Version,version)&&Math.Abs(previous.Dpi-nativeDpi)>.1)doorDpiPending=version;
        if(nativeDpi<=0||SameGeometry(doorDpiPending,version))return;
        doorDpiPending=null;
        var visual=geometry.TryGetValue("visual",out raw)?raw as Dictionary<string,object>:null;
        double x=Number(door,"x",-1),y=Number(door,"y",-1),w=Number(door,"w",0),h=Number(door,"h",0);
        double scale=visual==null?1:Number(visual,"scale",1),offsetX=visual==null?0:Number(visual,"offsetLeft",0),offsetY=visual==null?0:Number(visual,"offsetTop",0);
        double visibleWidth=visual==null?cssWidth:Number(visual,"width",cssWidth/scale),visibleHeight=visual==null?cssHeight:Number(visual,"height",cssHeight/scale);
        if(scale<=0||offsetX<0||offsetY<0||visibleWidth<=0||visibleHeight<=0||visibleWidth*scale>cssWidth+2/dpr||visibleHeight*scale>cssHeight+2/dpr||x<offsetX||y<offsetY||w<=0||w>240||h<=0||h>64||x+w>offsetX+visibleWidth+.01||y+h>offsetY+visibleHeight+.01)return;
        var surface=BrowserCaptureViewport.TryLocateKnown(owner,marker,cssWidth,cssHeight,dpr,version.Instance);
        protectionDoor=new ProtectionDoorRegion{Version=version,Surface=surface,X=x,Y=y,Width=w,Height=h,VisualWidth=visibleWidth,VisualHeight=visibleHeight,OffsetX=offsetX,OffsetY=offsetY,Scale=scale,Monitor=monitor,Dpi=nativeDpi};
    }
    BrowserCaptureViewport.Surface ProtectionDoorSurface(){
        var door=protectionDoor;
        if(door==null||!Object.ReferenceEquals(door.Version,geometryVersion)||door.Surface==null||door.Surface.Owner!=owner||door.Monitor!=Native.MonitorFromWindow(owner,2)||Math.Abs(door.Dpi-Native.WindowDpi(owner))>.1)return null;
        return BrowserCaptureViewport.RefreshNative(door.Surface,cssWidth,cssHeight,dpr);
    }
    bool InsideProtectionDoor(Native.Point point){
        var surface=ProtectionDoorSurface();if(surface==null)return false;
        // The hook only refreshes one registered native content HWND. UIA and
        // browser-tree enumeration are excluded from the input callback.
        if(Native.GetAncestor(Native.WindowFromPoint(point),2)!=owner)return false;
        var door=protectionDoor;
        return BrowserCaptureViewport.Pixels(surface,door.VisualWidth,door.VisualHeight,dpr*door.Scale,0,door.X-door.OffsetX,door.Y-door.OffsetY,door.Width,door.Height).Contains(point.X,point.Y);
    }
    bool InsideAuxiliaryWorkspace(Native.Point point){
        var proof=workspaceViewport;
        if(workspaceMode=="closed"||aside<=0||proof==null||proof.Owner!=owner||proof.Session!=session||proof.Revision!=workspaceRevision||proof.Monitor!=Native.MonitorFromWindow(owner,2)||Math.Abs(proof.Dpi-Native.WindowDpi(owner))>.1||Native.GetAncestor(Native.WindowFromPoint(point),2)!=owner)return false;
        var surface=BrowserCaptureViewport.RefreshNative(proof.Surface,cssWidth,cssHeight,dpr);if(surface==null)return false;
        return BrowserCaptureViewport.Pixels(surface,visualWidth,visualHeight,dpr*visualScale,0,visualWidth-aside,0,aside,visualHeight).Contains(point.X,point.Y);
    }
    static long LayoutRevision(Dictionary<string,object> p,string key){
        object value;if(!p.TryGetValue(key,out value)||(!(value is int)&&!(value is long)))throw new CompanionFault("invalid_request","学习工作区版本无效。");
        long revision=Convert.ToInt64(value);if(revision<1||revision>9007199254740991L)throw new CompanionFault("invalid_request","学习工作区版本无效。");return revision;
    }
    void CheckWorkspaceRevision(Dictionary<string,object> p){
        if(!workspaceProtocol&&!p.ContainsKey("workspaceRevision"))return;
        if(LayoutRevision(p,"workspaceRevision")!=workspaceRevision)throw new CompanionFault("workspace_changed","学习工作区已切换，本次旧布局未应用。");
    }
    Func<bool> ChatCommandOwner(Dictionary<string,object> p){
        CheckWorkspaceRevision(p);
        if(workspaceMode!="chat")throw new CompanionFault("workspace_changed","提问工作区已收起或切换，原内容已保留。");
        string expectedSession=session;long revision=workspaceRevision,connection=connectionRevision;
        return delegate{return !disposed&&!lessonSwitching&&connectionRevision==connection&&session==expectedSession&&workspaceMode=="chat"&&workspaceRevision==revision;};
    }
    object Workspace(Dictionary<string,object> p,bool legacy){
        string mode=legacy?(Text(p,"enabled")=="True"?"chat":"closed"):Text(p,"mode");
        if(mode!="closed"&&mode!="materials"&&mode!="chat")throw new CompanionFault("invalid_request","学习工作区模式无效。");
        long revision=legacy?workspaceRevision+1:LayoutRevision(p,"revision");
        if(revision<workspaceRevision||(revision==workspaceRevision&&mode!=workspaceMode))throw new CompanionFault("workspace_changed","学习工作区已切换，本次旧操作未应用。");
        bool changed=revision!=workspaceRevision;
        // Hide the native child before acknowledging materials or a new chat
        // layout. DOM content can then occupy the reserved area without overlap.
        // Changing the sidebar does not move the browser document. Retain its
        // measured origin; ResolveWorkspaceViewport still validates the HWND,
        // owner, session, dimensions, monitor and DPI before each reuse.
        if(changed){rebindChatRevision=0;pane.Suspend();viewportError="";viewportLookupKey="";viewportRetryAt=0;}
        workspaceProtocol=!legacy;workspaceRevision=revision;workspaceMode=mode;chatBrowser.SetWorkspaceState(mode,revision);
        Metrics(p);desiredWidth=ImmersivePolicy.ChatWidth(visualWidth,Number(p,"panelWidth",desiredWidth));
        if(mode=="closed"){HideChat();Tick();return State();}
        if(mode=="materials")pane.Suspend();
        else if(changed||pane.Suspended||(!pane.Opened&&!pane.Starting))pane.Open(desiredWidth,clock.ElapsedMilliseconds);
        else pane.Resize(desiredWidth);
        PlaceChat();return State();
    }
    public object Command(string path,Dictionary<string,object> p) {
        if(session==""||Text(p,"session")!=session)throw new Exception("课程连接已结束，请重新连接沉浸助手。");
        if(path!="/disconnect"&&!SameLesson(p))throw new CompanionFault("lesson_changed","讲次已变化，正在保存原草稿并重新连接。");
        if(lessonSwitching&&path!="/disconnect"&&path!="/capture/draft/status"&&path!="/fullscreen/release"&&!(path=="/guard"&&Text(p,"enabled")!="True"))throw new CompanionFault("lesson_changed","讲次正在切换，原提问已保留。");
        if(!OwnTab()){
            var current=Native.Find(marker,IntPtr.Zero);if(current!=IntPtr.Zero)Rebind(current);
            bool needsWindow=path=="/fullscreen"||path=="/capture"||path=="/chat/focus"||path=="/sidebar/commit"||path=="/sidebar/resize"||(path=="/workspace"&&Text(p,"mode")!="closed")||((path=="/sidebar"||path=="/guard")&&Text(p,"enabled")=="True");
            if(needsWindow&&!OwnTab())throw new CompanionFault("window_pending","课程窗口标识尚未同步，请保持课程标签页可见后重试。");
        }
        pulse=clock.ElapsedMilliseconds;
        if(path=="/pulse"){Metrics(p);Tick();return State();}
        if(path=="/capture"){Metrics(p);return Capture(p);}
        if(path=="/capture/draft"){var current=ChatCommandOwner(p);object batch,delivery;if(!p.TryGetValue("batch",out batch))throw new Exception("缺少截图。");p.TryGetValue("delivery",out delivery);return chatBrowser.QueueCapture(batch as Dictionary<string,object>,Text(p,"captureEnvelope"),delivery as Dictionary<string,object>,current);}
        if(path=="/capture/saved"){var current=ChatCommandOwner(p);object batch,delivery;p.TryGetValue("batch",out batch);p.TryGetValue("delivery",out delivery);return chatBrowser.QueueCapture(batch as Dictionary<string,object>,Text(p,"captureEnvelope"),delivery as Dictionary<string,object>,current);}
        if(path=="/capture/draft/status")return chatBrowser.CaptureStatus(Text(p,"attemptId"));
        if(path=="/capture/plan"){var current=ChatCommandOwner(p);object plan,delivery;p.TryGetValue("plan",out plan);p.TryGetValue("delivery",out delivery);return chatBrowser.QueueCapture(plan as Dictionary<string,object>,Text(p,"captureEnvelope"),delivery as Dictionary<string,object>,current);}
        if(path=="/chat/navigate"){var current=ChatCommandOwner(p);var navigation=chatBrowser.NavigateConversation(Text(p,"target"),current,workspaceRevision);return new DeferredWork(delegate{navigation.GetAwaiter().GetResult();return new {navigating=true};});}
        if(path=="/chat/restore-draft"){var current=ChatCommandOwner(p);var restoration=chatBrowser.RestoreSavedDraft(p,current,workspaceRevision);return new DeferredWork(delegate{return restoration.GetAwaiter().GetResult();});}
        if(path=="/chat/focus"){
            CheckWorkspaceRevision(p);string direction=Text(p,"direction");
            if(direction!="forward"&&direction!="backward")throw new CompanionFault("invalid_request","提问焦点方向无效。");
            if(workspaceMode!="chat"||!pane.NavigateReady||!pane.Visible||!OwnTab()||Native.GetForegroundWindow()!=owner)throw new CompanionFault("focus_unavailable","请先回到课程窗口，再进入提问。");
            var proof=workspaceViewport;
            object rawFocus;var focus= p.TryGetValue("_zjfFocusProof",out rawFocus)?rawFocus as BrowserCaptureViewport.FocusProof:null;
            var geometry=geometryVersion;
            if(proof==null||proof.Owner!=owner||proof.Session!=session||proof.Revision!=workspaceRevision||BrowserCaptureViewport.RefreshNative(proof.Surface,cssWidth,cssHeight,dpr)==null||focus==null||focus.Consumed||!focus.Fresh||focus.Owner!=owner||focus.Marker!=marker||focus.Session!=session||focus.WorkspaceRevision!=workspaceRevision||geometry==null||focus.GeometryInstance!=geometry.Instance||focus.GeometryEpoch!=geometry.Epoch)throw new CompanionFault("focus_unavailable","课程焦点已变化，请重新进入提问。");
            focus.Consumed=true;
            if(!chatBrowser.Focus(direction=="backward"))throw new CompanionFault("focus_unavailable","提问页面尚未准备好，请稍后重试。");return State();
        }
        if(path=="/fullscreen/release")return ReleaseFullscreen(p);
        if(path=="/fullscreen"){
            var foreground=Native.GetForegroundWindow();
            if(!OwnTab()||(foreground!=owner&&foreground!=chat))throw new Exception("请先回到课程窗口");
            return RequestFullscreen(p);
        }
        if(path=="/guard"){if(Text(p,"enabled")=="True"){Metrics(p);Arm((int)Number(p,"seconds",0));}else Release("键盘和触屏已恢复。");return State();}
        if(path=="/workspace")return Workspace(p,false);
        if(path=="/sidebar")return Workspace(p,true);
        if(path=="/sidebar/resize"){
            CheckWorkspaceRevision(p);
            if(workspaceMode=="closed")throw new CompanionFault("workspace_changed","学习工作区已收起，本次旧布局未应用。");
            Metrics(p);desiredWidth=ImmersivePolicy.ChatWidth(visualWidth,Number(p,"panelWidth",desiredWidth));
            pane.Resize(desiredWidth);PlaceChat();return State();
        }
        if(path=="/sidebar/commit"){
            CheckWorkspaceRevision(p);
            if(workspaceMode!="chat")throw new CompanionFault("workspace_changed","当前工作区正在显示资料，本次旧布局未应用。");
            Metrics(p);pane.Confirm();PlaceChat();return State();
        }
        if(path=="/disconnect"){Disconnect("已退出聚焦，保护已解除。");return State();}
        throw new Exception("不支持的操作。");
    }
}

sealed class Companion : ApplicationContext {
    const int MaximumHeaderBytes=8192,MaximumMessageBytes=64*1024*1024,HeaderDeadlineMs=3000,BodyDeadlineMs=15000;
    readonly Control dispatch=new Control();
    readonly NotifyIcon tray=new NotifyIcon();
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    readonly string token=Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N");
    readonly List<StudySession> sessions=new List<StudySession>();
    TcpListener server;
    volatile bool disposed;
    volatile bool exitRequested,exitCommitted;
    long shutdownGeneration;
    public Companion(){
        var handle=dispatch.Handle;
        var menu=new ContextMenuStrip();
        menu.Items.Add("立即解除全部写字保护",null,delegate{foreach(var s in sessions)if(s.SessionId!="")s.Command("/guard",new Dictionary<string,object>{{"session",s.SessionId},{"enabled",false}});});
        menu.Items.Add("退出沉浸助手",null,delegate{ExitThread();});
        tray.Icon=SystemIcons.Information;tray.Text="智云聚焦 · 沉浸助手";tray.ContextMenuStrip=menu;tray.Visible=true;
        tray.DoubleClick+=delegate{foreach(var s in sessions)if(s.SessionId!="")s.Command("/guard",new Dictionary<string,object>{{"session",s.SessionId},{"enabled",false}});};
        server=new TcpListener(IPAddress.Loopback,8772);server.Start(8);
        ThreadPool.QueueUserWorkItem(delegate{Listen();});
        dispatch.BeginInvoke(new Action(async delegate{
            await WebViewChatWindows.Warmup();
            if(WebViewChatWindows.RuntimeStatus=="ready")try{await Task.Run(new Action(Program.SyncInstalledRegistration));}catch(Exception error){Program.LogStartup(error);}
        }));
        timer.Interval=100;timer.Tick+=delegate{lock(sessions){for(int i=sessions.Count-1;i>=0;i--){var s=sessions[i];if(s.TryRetire())sessions.RemoveAt(i);else s.Tick();}}};timer.Start();
    }
    bool AnyProtected(){lock(sessions){foreach(var s in sessions)if(s.Protected)return true;return false;}}
    object ChatState(){int loading=0,opened=0,failed=0;var diagnostics=new List<object>();lock(sessions){foreach(var s in sessions){if(s.Pane.Starting)loading++;if(s.Pane.Opened)opened++;if(s.Pane.Error!="")failed++;diagnostics.Add(s.ChatDiagnostics);}}return new {loading=loading,opened=opened,failed=failed,diagnostics=diagnostics};}
    static string Text(Dictionary<string,object> p,string key){object value;return p.TryGetValue(key,out value)?Convert.ToString(value):"";}
    object Command(string path,Dictionary<string,object> p){
        if(path=="/library/capture-ack"){
            bool verified=false;
            foreach(var s in sessions)if(s.VerifyCaptureAck(p)){verified=true;break;}
            // Live receipt identity is checked on the UI thread. Disk-backed
            // idempotency and durable completion run under the accepted lease.
            return new DeferredWork(delegate{return StudyLibrary.AcknowledgeCapture(p,verified);});
        }
        if(path.StartsWith("/library/"))return new DeferredWork(delegate{return StudyLibrary.Run(path,p);});
        if(path=="/capture/draft/status"){
            string attemptId=Text(p,"attemptId");Guid parsed;if(!Guid.TryParseExact(attemptId,"D",out parsed))throw new CompanionFault("invalid_request","附图尝试编号无效。");
            foreach(var s in sessions)if(s.HasCaptureAttempt(attemptId))return s.CaptureStatus(attemptId);
            return new {protocol=2,attemptId=attemptId,state="unknown",count=0,verified=false,evidence=""};
        }
        if(path=="/shutdown")return PrepareShutdown(true);
        if(exitRequested&&path!="/pulse"&&path!="/capture/draft/status"&&path!="/disconnect"&&path!="/fullscreen/release"&&!(path=="/guard"&&Text(p,"enabled")!="True"))throw new CompanionFault("companion_draining","助手正在保存并退出，本次操作未执行。");
        if(path=="/audio/start")return new DeferredWork(delegate{Program.StartVoice();return new {started=true};});
        if(path=="/chat/prepare-runtime"){
            var preparing=WebViewChatWindows.PrepareRuntime(dispatch.Handle);
            return new DeferredWork(delegate{preparing.GetAwaiter().GetResult();return new {ready=true};});
        }
        if(path=="/connect"){
            string marker=Text(p,"marker");if(!GuardPolicy.Marker(marker))throw new Exception("无效的课程窗口标识。");
            IntPtr owner=Native.Find(marker,IntPtr.Zero);
            if(owner==IntPtr.Zero)throw new CompanionFault("window_pending","课程窗口标识尚未同步，请保持课程标签页可见后重试。");
            foreach(var s in sessions)if(s.Marker==marker){s.Rebind(owner);if(!s.SameLesson(p)){var switching=s.SwitchLesson(p);return new DeferredWork(delegate{return switching.GetAwaiter().GetResult();});}return s.Reconnect(p);}
            var created=new StudySession(owner,marker,p,dispatch);lock(sessions)sessions.Add(created);return created.Reconnect(p);
        }
        string session=Text(p,"session");
        foreach(var s in sessions)if(session!=""&&s.SessionId==session)return s.Command(path,p);
        throw new Exception("课程连接已结束，请重新连接沉浸助手。");
    }
    bool ServeChatShell(NetworkStream stream,string path){
        EmbeddedChatPane pane=null;
        var job=dispatch.BeginInvoke(new Action(delegate{foreach(var s in sessions)if(path=="/chat/"+s.Pane.Id||path=="/chat/"+s.Pane.Id+"/ready"){pane=s.Pane;break;}}));
        if(!job.AsyncWaitHandle.WaitOne(2000)||pane==null)return false;
        string mime,body;
        if(path.EndsWith("/ready")){mime="application/json";body=new JavaScriptSerializer().Serialize(new {ready=pane.NavigateReady,cancelled=!pane.Starting&&!pane.Attached});}
        else{
            mime="text/html; charset=utf-8";
            body="<!doctype html><meta charset=utf-8><title>"+pane.Marker+"</title><style>html{background:#202020;color:#aaa;font:14px system-ui}body{margin:20px}</style>正在准备提问区域…<script>const t=setInterval(async()=>{try{const s=await fetch(location.pathname+'/ready').then(r=>r.json());if(s.ready){clearInterval(t);location.replace('https://chatgpt.com/')}else if(s.cancelled){clearInterval(t);window.close()}}catch{}},100)</script>";
        }
        byte[] bytes=Encoding.UTF8.GetBytes(body);
        string head="HTTP/1.1 200 OK\r\nContent-Type: "+mime+"\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'\r\nContent-Length: "+bytes.Length+"\r\n\r\n";
        byte[] headers=Encoding.ASCII.GetBytes(head);stream.Write(headers,0,headers.Length);stream.Write(bytes,0,bytes.Length);return true;
    }
    void Listen() {
        var slots=new Semaphore(8,8);
        while(!disposed){try{var client=server.AcceptTcpClient();if(!slots.WaitOne(0)){client.Close();continue;}ThreadPool.QueueUserWorkItem(delegate{try{Respond(client);}finally{client.Close();slots.Release();}});}catch{if(disposed)return;}}
    }
    static int ReadBudget(Stopwatch clock,int maximum){
        int remaining=maximum-(int)clock.ElapsedMilliseconds;
        if(remaining<=0)throw new CompanionFault("request_timeout","读取请求超时，操作未执行。");
        return Math.Max(1,Math.Min(3000,remaining));
    }
    static bool SocketReadTimedOut(IOException error){var socket=error.InnerException as SocketException;return socket!=null&&socket.SocketErrorCode==SocketError.TimedOut;}
    static int FaultStatus(string code){
        if(code=="window_pending"||code=="workspace_changed")return 409;
        if(code=="conversation_changed")return 409;
        if(code=="upgrade_required")return 426;
        if(code=="request_timeout"||code=="request_cancelled")return 408;
        if(code=="headers_too_large")return 431;
        if(code=="payload_too_large")return 413;
        if(code=="companion_busy"||code=="operation_pending"||code=="persistence_draining"||code=="companion_draining")return 503;
        return 400;
    }
    static string PublicMessage(string message){return message==null?"请求失败。":message.Length>1000?message.Substring(0,1000)+"…":message;}
    void FinishStartedRequest(IAsyncResult job,IDisposable lease,Func<Func<object>,object> executeLibrary){
        // Ownership of an accepted persistence lease moves to this completion.
        // An HTTP timeout must not decrement a write that has already started.
        ThreadPool.QueueUserWorkItem(delegate{
            try{
                job.AsyncWaitHandle.WaitOne();object value=UiCommandFailure.Unwrap(dispatch.EndInvoke(job));var work=value as DeferredWork;
                if(work!=null)value=executeLibrary!=null?executeLibrary(work.Run):work.Run();
                var shutdown=value as ShutdownReply;if(shutdown!=null)ResumeAfterFailedShutdown(shutdown.Generation);
            }catch{}finally{if(lease!=null)lease.Dispose();}
        });
    }
    void Respond(TcpClient client) {
        string origin="",requestPath="";bool cors=false,replyWritten=false;int status=200;object value=null;NetworkStream stream=null;
        IDisposable libraryLease=null;Func<Func<object>,object> executeLibrary=null;
        try{
            client.ReceiveTimeout=3000;client.SendTimeout=3000;stream=client.GetStream();
            try{
                var bytes=new List<byte>();var headerClock=Stopwatch.StartNew();bool complete=false;
                while(bytes.Count<MaximumHeaderBytes){
                    stream.ReadTimeout=ReadBudget(headerClock,HeaderDeadlineMs);int b;
                    try{b=stream.ReadByte();}catch(IOException e){if(SocketReadTimedOut(e)||headerClock.ElapsedMilliseconds>=HeaderDeadlineMs)throw new CompanionFault("request_timeout","读取请求头超时，操作未执行。");throw;}
                    if(b<0)break;
                    if(headerClock.ElapsedMilliseconds>=HeaderDeadlineMs)throw new CompanionFault("request_timeout","读取请求头超时，操作未执行。");
                    bytes.Add((byte)b);int n=bytes.Count;if(n>=4&&bytes[n-4]==13&&bytes[n-3]==10&&bytes[n-2]==13&&bytes[n-1]==10){complete=true;break;}
                }
                if(!complete)throw new CompanionFault(bytes.Count>=MaximumHeaderBytes?"headers_too_large":"invalid_request","请求头过大或不完整。");
                var lines=Encoding.ASCII.GetString(bytes.ToArray()).Split(new[]{"\r\n"},StringSplitOptions.None);
                var first=lines[0].Split(' ');
                if(first.Length!=3||(first[2]!="HTTP/1.1"&&first[2]!="HTTP/1.0")||!first[1].StartsWith("/")||first[1].IndexOf('#')>=0)throw new CompanionFault("invalid_request","请求行格式无效。");
                string method=first[0],path=first[1];requestPath=path;
                if(method!="GET"&&method!="POST"&&method!="OPTIONS"){status=405;throw new CompanionFault("invalid_request","请求方法不受支持。");}
                var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                for(int i=1;i<lines.Length&&lines[i]!="";i++){
                    var line=lines[i];int colon=line.IndexOf(':');if(colon<=0)throw new CompanionFault("invalid_request","请求头格式无效。");
                    string name=line.Substring(0,colon),headerValue=line.Substring(colon+1).Trim();
                    if(!Regex.IsMatch(name,@"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")||headers.ContainsKey(name))throw new CompanionFault("invalid_request","请求头重复或名称无效。");
                    foreach(char c in headerValue)if((c<32&&c!='\t')||c==127)throw new CompanionFault("invalid_request","请求头内容无效。");
                    headers.Add(name,headerValue);
                }
                string host=headers.ContainsKey("Host")?headers["Host"]:"";
                if(host!="127.0.0.1:8772"&&host!="localhost:8772"){status=403;throw new Exception("Invalid host");}
                if(method=="GET"&&path.StartsWith("/chat/")){
                    if(ServeChatShell(stream,path))return;status=404;throw new Exception("Unknown chat shell");
                }
                origin=headers.ContainsKey("Origin")?headers["Origin"]:"";cors=GuardPolicy.ValidOrigin(origin);
                if(!cors){status=403;throw new Exception("Origin denied");}
                if(method=="OPTIONS")value=new {ok=true};
                else{
                    if(!headers.ContainsKey("X-ZJF-Protocol")||headers["X-ZJF-Protocol"]!="1"){status=403;throw new Exception("Protocol required");}
                    if(method=="GET"&&path=="/hello")value=new {engine="zjf-companion",version="1.5.5",build=Program.BuildVersion,buildId=Program.BuildIdentity,features=Program.Features,token=token};
                    else if(method=="GET"&&path=="/health")value=new {engine="zjf-companion",version="1.5.5",build=Program.BuildVersion,buildId=Program.BuildIdentity,features=Program.Features,chatRuntime="WebView2",chatRuntimeStatus=WebViewChatWindows.RuntimeStatus,chatRuntimePrepared=WebViewChatWindows.RuntimePrepared,chat=ChatState(),protectedInput=AnyProtected(),installation=Program.InstallationStatus()};
                    else{
                        if(method!="POST"||!headers.ContainsKey("X-ZJF-Companion")||headers["X-ZJF-Companion"]!=token){status=403;throw new Exception("Session token required");}
                        bool large=path=="/capture/draft"||path=="/library/save"||path=="/capture/plan"||path=="/library/plan-job";
                        int maximum=path=="/library/asset"?StudyLibrary.MaxOriginalJsonBytes:path=="/capture/draft"?StudyLibrary.MaxCaptureJsonBytes:large?MaximumMessageBytes:path=="/library/compose"?256*1024:path=="/library/selection-save"?512*1024+16384:4096;
                        int length;if(!headers.ContainsKey("Content-Length")||!int.TryParse(headers["Content-Length"],out length)||length<2||headers.ContainsKey("Transfer-Encoding"))throw new CompanionFault("invalid_request","请求正文长度无效。");
                        if(length>maximum)throw new CompanionFault("payload_too_large","本次请求过大，请减少材料后重试。");
                        byte[] bodyBytes=new byte[length];int read=0;var bodyClock=Stopwatch.StartNew();
                        while(read<length){
                            stream.ReadTimeout=ReadBudget(bodyClock,BodyDeadlineMs);int got;
                            try{got=stream.Read(bodyBytes,read,length-read);}catch(IOException e){if(SocketReadTimedOut(e)||bodyClock.ElapsedMilliseconds>=BodyDeadlineMs)throw new CompanionFault("request_timeout","读取请求正文超时，操作未执行。");throw;}
                            if(got==0)throw new CompanionFault("invalid_request","请求正文不完整。");
                            if(bodyClock.ElapsedMilliseconds>=BodyDeadlineMs)throw new CompanionFault("request_timeout","读取请求正文超时，操作未执行。");read+=got;
                        }
                        Dictionary<string,object> payload;
                        try{payload=new JavaScriptSerializer{MaxJsonLength=Math.Max(maximum,StudyLibrary.MaxCaptureJsonBytes)}.Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(bodyBytes));}
                        catch(Exception e){if(e is ArgumentException||e is InvalidOperationException||e is DecoderFallbackException)throw new CompanionFault("invalid_request","请求数据格式无效。");throw;}
                        if(payload==null)throw new CompanionFault("invalid_request","请求正文必须是 JSON 对象。");
                        long deadline=0;object rawDeadline;
                        if(payload.TryGetValue("_zjfDeadlineUtcMs",out rawDeadline)){
                            if(!(rawDeadline is int)&&!(rawDeadline is long))throw new CompanionFault("invalid_request","请求截止时刻无效。");
                            deadline=Convert.ToInt64(rawDeadline);
                            if(deadline<=PendingUiCommand.NowUtcMs())throw new CompanionFault("request_timeout","操作等待期限已过，操作未执行。");
                            if(deadline>PendingUiCommand.NowUtcMs()+120000)throw new CompanionFault("invalid_request","请求等待期限超出范围。");
                        }
                        if(path=="/capture/draft"){
                            object raw;payload.TryGetValue("batch",out raw);var batch=raw as Dictionary<string,object>;WebViewChatWindows.ValidateCapture(batch);
                            payload["captureEnvelope"]=new JavaScriptSerializer{MaxJsonLength=StudyLibrary.MaxCaptureJsonBytes}.Serialize(new {kind="zjf-capture",batch=batch});
                        }
                        if(path=="/capture/saved"){
                            var result=StudyLibrary.Run("/library/capture",new Dictionary<string,object>{{"id",Text(payload,"id")},{"lightweight",true}});var batch=(Dictionary<string,object>)result.GetType().GetProperty("batch").GetValue(result,null);payload["batch"]=batch;payload["captureEnvelope"]=new JavaScriptSerializer{MaxJsonLength=StudyLibrary.MaxCaptureJsonBytes}.Serialize(new {kind="zjf-capture",batch=batch});
                        }
                        if(path=="/capture/plan"){
                            object raw;payload.TryGetValue("plan",out raw);var plan=raw as Dictionary<string,object>;WebViewChatWindows.ValidatePlan(plan);
                            payload["captureEnvelope"]=new JavaScriptSerializer{MaxJsonLength=MaximumMessageBytes}.Serialize(new {kind="zjf-study-plan",plan=plan});
                        }
                        if(path.StartsWith("/library/")){
                            // Register acceptance before the UI delegate is queued.
                            // Registering only in DeferredWork.Run leaves a shutdown gap.
                            var accepted=StudyLibrary.AcceptLibraryWork(path,payload);libraryLease=accepted;executeLibrary=accepted.Execute;
                        }
                        if(path=="/chat/focus"){
                            var contextJob=dispatch.BeginInvoke(new Func<BrowserCaptureViewport.FocusProof>(delegate{
                                foreach(var candidate in sessions)if(candidate.SessionId==Text(payload,"session"))return candidate.FocusEntryContext();
                                return null;
                            }));
                            int contextWait=deadline==0?300:(int)Math.Max(1,Math.Min(300,deadline-PendingUiCommand.NowUtcMs()));
                            if(!contextJob.AsyncWaitHandle.WaitOne(contextWait))throw new CompanionFault("focus_unavailable","提问焦点暂未就绪，请重新进入。");
                            var context=(BrowserCaptureViewport.FocusProof)dispatch.EndInvoke(contextJob);
                            var focus=BrowserCaptureViewport.LocateFocusedEntry(context);
                            if(focus==null)throw new CompanionFault("focus_unavailable","课程焦点已变化，请重新进入提问。");
                            payload["_zjfFocusProof"]=focus;
                        }
                        var gate=new PendingUiCommand(deadline);
                        var job=dispatch.BeginInvoke(new Func<object>(delegate{
                            // Momentary input controls may be cancelled before
                            // execution. Durable accepted writes still finish.
                            if(path=="/chat/focus"||path=="/fullscreen"||path=="/workspace"||path=="/sidebar"||path=="/sidebar/resize"||path=="/sidebar/commit"||path=="/chat/navigate"||path=="/chat/restore-draft"||path=="/capture/draft"||path=="/capture/saved"||path=="/capture/plan"||path=="/guard"&&Text(payload,"enabled")=="True")try{
                                var socket=client.Client;
                                if(socket==null||(socket.Poll(0,SelectMode.SelectRead)&&socket.Available==0))gate.Cancel();
                            }catch(SocketException){gate.Cancel();}catch(ObjectDisposedException){gate.Cancel();}
                            try{return gate.Execute(delegate{return Command(path,payload);});}catch(Exception error){return new UiCommandFailure(error);}
                        }));
                        int uiWait=deadline==0?2500:(int)Math.Max(1,Math.Min(2500,deadline-PendingUiCommand.NowUtcMs()));
                        if(!job.AsyncWaitHandle.WaitOne(uiWait)){
                            if(gate.Cancel())throw new CompanionFault("companion_busy","助手繁忙，操作尚未执行，请稍后重试。");
                            if(!job.AsyncWaitHandle.WaitOne(0)){
                                FinishStartedRequest(job,libraryLease,executeLibrary);libraryLease=null;executeLibrary=null;
                                throw new CompanionFault("operation_pending","操作已经开始，正在完成。请先查看当前状态后再重试。");
                            }
                        }
                        if(gate.Cancelled)throw new CompanionFault("request_cancelled","操作等待期限已过，操作未执行。");
                        value=UiCommandFailure.Unwrap(dispatch.EndInvoke(job));var work=value as DeferredWork;
                        if(work!=null)value=executeLibrary==null?work.Run():executeLibrary(work.Run);
                    }
                }
            }catch(Exception e){
                var error=e.InnerException??e;var fault=error as CompanionFault;var captureFault=error as CaptureProtocolException;
                string code=fault!=null?fault.Code:captureFault!=null?captureFault.Code:null;
                if(status==200)status=code==null?400:FaultStatus(code);
                value=new {error=PublicMessage(error.Message),code=code};
            }
            byte[] body;
            try{
                int maximum=requestPath=="/library/image"||requestPath=="/capture"?StudyLibrary.MaxOriginalJsonBytes:StudyLibrary.MaxCaptureJsonBytes;
                body=Encoding.UTF8.GetBytes(new JavaScriptSerializer{MaxJsonLength=maximum}.Serialize(value));
                if(body.Length>maximum)throw new CompanionFault("response_too_large","本次材料超过传输上限，请分组整理后重试。");
            }catch(Exception e){
                var fault=e as CompanionFault;bool oversized=fault!=null&&fault.Code=="response_too_large"||e is InvalidOperationException&&e.Message.IndexOf("maxJsonLength",StringComparison.OrdinalIgnoreCase)>=0;
                status=oversized?413:500;value=new {error=oversized?"本次材料超过传输上限，请分组整理后重试。":"助手暂时无法生成响应，请查看当前状态后重试。",code=oversized?"response_too_large":"response_serialization_failed"};
                body=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));
            }
            string header="HTTP/1.1 "+status+(status==200?" OK":" Error")+"\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "+body.Length+"\r\n";
            if(cors)header+="Access-Control-Allow-Origin: "+origin+"\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-ZJF-Protocol, X-ZJF-Companion\r\nAccess-Control-Allow-Private-Network: true\r\n";
            byte[] head=Encoding.ASCII.GetBytes(header+"\r\n");stream.Write(head,0,head.Length);stream.Write(body,0,body.Length);stream.Flush();replyWritten=true;
        }catch{}finally{if(libraryLease!=null)libraryLease.Dispose();var shutdown=value as ShutdownReply;if(shutdown!=null){if(replyWritten)CommitShutdown(shutdown.Generation);else ResumeAfterFailedShutdown(shutdown.Generation);}}
    }
    void ResumeAfterFailedShutdown(long operation){
        if(exitCommitted||disposed||operation!=Interlocked.Read(ref shutdownGeneration))return;
        try{dispatch.BeginInvoke(new Action(delegate{if(exitCommitted||disposed||operation!=shutdownGeneration)return;StudyLibrary.ResumeAccepting();foreach(var s in sessions)s.ResumeAfterFailedShutdown();exitRequested=false;}));}catch{}
    }
    void CommitShutdown(long operation){
        try{dispatch.BeginInvoke(new Action(delegate{if(exitCommitted||disposed||operation!=shutdownGeneration||!exitRequested)return;exitCommitted=true;ExitThread();}));}
        catch{ResumeAfterFailedShutdown(operation);throw;}
    }
    object PrepareShutdown(bool waitForReply=false){
        if(exitCommitted)return new {ok=true};
        if(exitRequested)throw new CompanionFault("persistence_pending","正在等待资料保存完成，请稍后再试。");
        exitRequested=true;long operation=Interlocked.Increment(ref shutdownGeneration);
        var saves=new List<Task>();
        try{foreach(var s in sessions)saves.Add(s.ReleaseForShutdown());}catch{foreach(var s in sessions)s.ResumeAfterFailedShutdown();exitRequested=false;throw;}
        return new DeferredWork(delegate{
            try{
                Task.WhenAll(saves).GetAwaiter().GetResult();
                var result=StudyLibrary.StopAcceptingAndDrain(5000);
                if(!result.Success)throw new CompanionFault("persistence_pending",result.Error);
                if(waitForReply)return new ShutdownReply(operation);
                CommitShutdown(operation);
                return new {ok=true};
            }catch{
                ResumeAfterFailedShutdown(operation);
                throw;
            }
        });
    }
    void RequestExit(){
        if(exitRequested||disposed)return;
        DeferredWork work;
        try{work=PrepareShutdown() as DeferredWork;}catch(Exception error){Program.LogStartup(error);return;}
        if(work==null)return;
        // Keep the UI dispatcher alive while accepted requests finish there.
        ThreadPool.QueueUserWorkItem(delegate{try{work.Run();}catch(Exception error){Program.LogStartup(error);}});
    }
    protected override void ExitThreadCore(){
        if(!exitCommitted){RequestExit();return;}
        if(!disposed){disposed=true;timer.Stop();lock(sessions){foreach(var s in sessions)s.Dispose();sessions.Clear();}server.Stop();WebViewChatWindows.DisposeRuntime();tray.Visible=false;tray.Dispose();timer.Dispose();dispatch.Dispose();}
        base.ExitThreadCore();
    }
}

static partial class Program {
    public const string BuildVersion="1.9.6";
    public static readonly string[] Features={"sidebar-resize","content-clip","capture-viewport-v1","capture-paint-v1","embedded-webview","workspace-v1","chat-keyboard-focus","capture-drafts","capture-delivery-v2","capture-question-v1","persistent-capture-outbox","persistent-plan-outbox","capture-target-v1","capture-retire-v1","capture-reconcile-v1","capture-assets-v1","capture-context-v1","draft-plan-projection","study-library","library-selections-v1","library-question-supplement-v1","draft-reopen-v1","chat-runtime-preparation","lesson-drafts-v1","library-course-scope-v1","protection-overlay-v1","protection-input-scope-v1","fullscreen-intent-v1"};
    const string StartupKey=@"Software\Microsoft\Windows\CurrentVersion\Run";
    const string StartupName="ZhiyunFocus";
    public static object InstallationStatus(){
        try{
            using(var registry=new SystemRegistration()){
                string protocol=registry.Read(ProtocolCommand,"").Text,startup=registry.Read(StartupKey,StartupName).Text;
                string executable="\""+Application.ExecutablePath+"\"";
                return new {available=true,protocolCurrent=String.Equals(protocol,executable+" \"%1\"",StringComparison.OrdinalIgnoreCase),startupCurrent=String.Equals(startup,executable+" --autostart",StringComparison.OrdinalIgnoreCase),startupConfigured=!String.IsNullOrWhiteSpace(startup)};
            }
        }catch{return new {available=false};}
    }
    internal static void LogStartup(Exception error){try{File.AppendAllText(Path.Combine(Application.StartupPath,"startup.log"),DateTime.UtcNow.ToString("o")+" "+error.Message+Environment.NewLine);}catch{}}
    static void StartVoiceQuietly(){try{StartVoice();}catch(Exception error){LogStartup(error);}}
    public static bool ShouldUpgrade(string engine,string build){Version version;return engine=="zjf-companion"&&Version.TryParse(build,out version)&&version<new Version(BuildVersion);}


    public static void StartVoice(){
        string root=Path.GetFullPath(Path.Combine(Application.StartupPath,@"..\.."));
        string launcher=Path.Combine(root,@"viewer\audio-helper\launcher.py");
        if(!File.Exists(launcher))throw new Exception("清晰人声组件缺失");
        string configured=Environment.GetEnvironmentVariable("ZJF_AUDIO_HOME");
        string python="python.exe";
        var homes=new List<string>();
        if(!String.IsNullOrWhiteSpace(configured)){
            configured=Environment.ExpandEnvironmentVariables(configured);
            if(configured=="~"||configured.StartsWith("~\\")||configured.StartsWith("~/"))configured=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)+configured.Substring(1);
            homes.Add(Path.GetFullPath(configured));
        }
        homes.Add(Path.Combine(root,@".runtime\audio"));
        homes.Add(Path.Combine(root,@"work\immersive_next\audio-lab"));
        foreach(string home in homes){string candidate=Path.Combine(home,@"cv-env\Scripts\python.exe");if(File.Exists(candidate)){python=candidate;break;}}
        // The stdlib launcher selects the asset environment before starting the server.
        var start=new ProcessStartInfo(python,"-X utf8 \""+launcher+"\"");start.WorkingDirectory=root;start.UseShellExecute=false;start.CreateNoWindow=true;start.WindowStyle=ProcessWindowStyle.Hidden;Process.Start(start);
    }
    [STAThread] static void Main(string[] args) {
        if(args.Length>0&&args[0]=="--component-info"){
            try{File.WriteAllText(args.Length>1?args[1]:"component-info.json",new JavaScriptSerializer().Serialize(new {build=BuildVersion,buildId=BuildIdentity,runtime=WebViewChatWindows.RuntimeVersion(),topLevelBrowserLaunch=false}),Encoding.UTF8);}
            catch(Exception e){File.WriteAllText(args.Length>1?args[1]:"component-info.json",e.ToString());Environment.ExitCode=1;}return;
        }
        if(args.Length>0&&args[0]=="--component-check"){
            try{Native.SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}
            Application.EnableVisualStyles();var context=new ApplicationContext();var owner=new Form{ShowInTaskbar=false};var handle=owner.Handle;
            owner.BeginInvoke(new Action(async delegate{
                try{var result=await WebViewChatWindows.CheckController(handle);File.WriteAllText(args[1],new JavaScriptSerializer().Serialize(result),Encoding.UTF8);}
                catch(Exception e){File.WriteAllText(args[1],e.ToString());Environment.ExitCode=1;}
                finally{owner.Dispose();context.ExitThread();}
            }));Application.Run(context);return;
        }
        if(args.Length>0&&args[0]=="--install-browser-link"){RequireHealthyCandidate();InstallBrowserLink();return;}
        if(args.Length>0&&args[0]=="--install-startup"){
            RequireHealthyCandidate();InstallRegistration(true);
            return;
        }
        if(args.Length>0&&args[0]=="--remove-startup"){
            using(var registry=new SystemRegistration())if(String.Equals(registry.Read(StartupKey,StartupName).Text,"\""+Application.ExecutablePath+"\" --autostart",StringComparison.OrdinalIgnoreCase))registry.DeleteValue(StartupKey,StartupName);
            return;
        }
        if(args.Length>0&&args[0]=="--remove-browser-link"){
            using(var registry=new SystemRegistration()){
                if(!String.Equals(registry.Read(ProtocolCommand,"").Text,"\""+Application.ExecutablePath+"\" \"%1\"",StringComparison.OrdinalIgnoreCase))return;
                registry.DeleteValue(ProtocolCommand,"");registry.DeleteValue(ProtocolKey,"URL Protocol");registry.DeleteValue(ProtocolKey,"");
                foreach(string path in new[]{ProtocolCommand,ProtocolKey+@"\shell\open",ProtocolKey+@"\shell",ProtocolKey})registry.DeleteEmptyKey(path);
            }return;
        }
        bool voice=args.Length>0&&(args[0]=="zhiyun-focus://audio"||args[0]=="zhiyun-focus://audio/");
        bool startup=args.Length>0&&args[0]=="--autostart";
        bool replacing=args.Length==2&&args[0]=="--replace-build";
        if(args.Length>0 && !voice && !startup && !replacing && args[0]!="zhiyun-focus://start" && args[0]!="zhiyun-focus://start/")return;
        bool upgrading;
        try{ValidateReleaseCandidate();upgrading=UpgradeOlderInstance(replacing?args[1]:null);}
        catch(Exception error){LogStartup(error);return;}
        using(var mutex=new Mutex(false,"Local\\ZJFStudyCompanionV15")){
            bool acquired;try{acquired=mutex.WaitOne(upgrading?5000:0);}catch(AbandonedMutexException){acquired=true;}
            if(!acquired){
                if(upgrading){var error=new Exception("原助手尚未退出，保留原服务，请稍后重试更新。");LogStartup(error);}
                else StartVoiceQuietly();
                return;
            }
            try{
                try{Native.SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{Native.SetProcessDPIAware();}
                Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
                UserDataStore.EnsureReady(); // Finish a verified legacy copy before opening the profile or library.
                var companion=new Companion(); // Bind the control endpoint before loading audio.
                ThreadPool.QueueUserWorkItem(delegate{StartVoiceQuietly();});
                Application.Run(companion);
            }
            catch(Exception e){LogStartup(e);}
            finally{mutex.ReleaseMutex();}
        }
    }


}

// Verified build identity and transactional per-user registration.
static partial class Program {
    public static string BuildIdentity {
        get {
            var attribute=(System.Reflection.AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(System.Reflection.Assembly.GetExecutingAssembly(),typeof(System.Reflection.AssemblyInformationalVersionAttribute));
            string value=attribute==null?"":attribute.InformationalVersion,prefix=BuildVersion+"+";
            return value.StartsWith(prefix,StringComparison.Ordinal)&&System.Text.RegularExpressions.Regex.IsMatch(value.Substring(prefix.Length),"^[a-f0-9]{64}$")?value.Substring(prefix.Length):"";
        }
    }
    public static bool CanReplaceInstance(string engine,string build,string currentIdentity,string expectedIdentity) {
        if(ShouldUpgrade(engine,build))return true;
        Version current;
        if(engine!="zjf-companion"||!Version.TryParse(build,out current)||current!=new Version(BuildVersion)||BuildIdentity==""||expectedIdentity==null)return false;
        string identity=string.IsNullOrEmpty(currentIdentity)?"legacy:"+build:currentIdentity;
        return (identity=="legacy:"+build||System.Text.RegularExpressions.Regex.IsMatch(identity,"^[a-f0-9]{64}$"))&&identity==expectedIdentity&&identity!=BuildIdentity;
    }
    static string ReleaseHash(string path) {
        using(var stream=File.OpenRead(path))using(var sha=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
    }
    static void ValidateReleaseCandidate() {
        string manifestPath=Application.ExecutablePath+".build.json";
        if(BuildIdentity==""||!File.Exists(manifestPath))throw new Exception("组件缺少构建身份或完整构建记录，请重新构建后更新。");
        var manifest=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(manifestPath));
        object version,identity,rawFiles,receiver;
        if(!manifest.TryGetValue("version",out version)||Convert.ToString(version)!=BuildVersion||!manifest.TryGetValue("build_id",out identity)||Convert.ToString(identity)!=BuildIdentity||!manifest.TryGetValue("files",out rawFiles)||!manifest.TryGetValue("receiver_sha256",out receiver))throw new Exception("组件构建记录与程序不一致。");
        var files=rawFiles as Dictionary<string,object>;
        string[] names={Path.GetFileName(Application.ExecutablePath),"Microsoft.Web.WebView2.Core.dll","WebView2Loader.dll","WebView2.LICENSE.txt","WebView2.NOTICE.txt"};
        if(files==null||files.Count!=names.Length)throw new Exception("组件依赖记录不完整。");
        foreach(string name in names){object hash;string path=Path.Combine(Application.StartupPath,name);if(!files.TryGetValue(name,out hash)||!File.Exists(path)||ReleaseHash(path)!=Convert.ToString(hash))throw new Exception("组件文件缺失或摘要不符："+name);}
        using(var stream=System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("ZjfChatDraft.js"))using(var sha=System.Security.Cryptography.SHA256.Create()) {
            if(stream==null||BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant()!=Convert.ToString(receiver))throw new Exception("内嵌提问脚本与构建记录不一致。");
        }
        // This query neither creates a browser/profile nor navigates a page.
        if(string.IsNullOrEmpty(WebViewChatWindows.RuntimeVersion()))throw new Exception("本机 WebView2 Runtime 不可用，保留原助手。");
    }
    static void RequireHealthyCandidate() {
        ValidateReleaseCandidate();
        var health=HelperRequest("/health");object engine,build,identity,features,runtime;
        if(!health.TryGetValue("engine",out engine)||Convert.ToString(engine)!="zjf-companion"||!health.TryGetValue("build",out build)||Convert.ToString(build)!=BuildVersion||!health.TryGetValue("buildId",out identity)||Convert.ToString(identity)!=BuildIdentity||!health.TryGetValue("chatRuntimeStatus",out runtime)||Convert.ToString(runtime)!="ready"||!health.TryGetValue("features",out features))throw new Exception("候选组件尚未完成接替，请先确认运行健康，再更新注册。");
        var available=new HashSet<string>();var values=features as System.Collections.IEnumerable;if(values!=null)foreach(object value in values)available.Add(Convert.ToString(value));
        foreach(string feature in Features)if(!available.Contains(feature))throw new Exception("运行组件缺少功能："+feature+"；保留原注册。");
    }
    static Dictionary<string,object> HelperRequest(string path,string token=null) {
        var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:8772"+path);
        // Windows can take about two seconds to report a refused loopback
        // connection. Let that result arrive so an absent helper is distinct
        // from an unresponsive live helper during a cold start.
        request.Proxy=null;request.AllowAutoRedirect=false;request.Timeout=path=="/shutdown"?20000:4000;request.ReadWriteTimeout=path=="/shutdown"?20000:4000;
        request.Headers["Origin"]="http://127.0.0.1:8769";request.Headers["X-ZJF-Protocol"]="1";
        if(token!=null){request.Method="POST";request.ContentType="application/json";request.Headers["X-ZJF-Companion"]=token;var bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new {_zjfDeadlineUtcMs=PendingUiCommand.NowUtcMs()+request.Timeout}));request.ContentLength=bytes.Length;using(var stream=request.GetRequestStream()){stream.Write(bytes,0,bytes.Length);}}
        using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
    }
    static bool UpgradeOlderInstance(string expectedIdentity=null) {
        Dictionary<string,object> hello;
        try { hello=HelperRequest("/hello"); } catch(WebException error) {
            if(error.Response==null&&(error.Status==WebExceptionStatus.ConnectFailure||error.Status==WebExceptionStatus.ConnectionClosed))return false;
            throw new Exception("无法确认当前助手状态，请稍后重试；未请求关闭原助手。",error);
        }
        object engine,build,token,identity;
        if(!hello.TryGetValue("engine",out engine)||!hello.TryGetValue("build",out build)||!hello.TryGetValue("token",out token))return false;
        hello.TryGetValue("buildId",out identity);
        if(!CanReplaceInstance(Convert.ToString(engine),Convert.ToString(build),Convert.ToString(identity),expectedIdentity)) {
            if(expectedIdentity!=null)throw new Exception("当前组件版本或构建身份与替换确认不符，保留已有对话；请重新核对健康状态。");
            return false;
        }
        // Dependencies, resource identity and runtime must be valid before asking
        // an older working process to stop. An installation failure preserves it.
        ValidateReleaseCandidate();
        try {
            var response=HelperRequest("/shutdown",Convert.ToString(token));object ok,error;
            if(response.TryGetValue("error",out error)||!response.TryGetValue("ok",out ok)||!Equals(ok,true))throw new Exception("原助手未确认退出，请稍后重试。"+(error==null?"":Convert.ToString(error)));
            return true;
        } catch(WebException error) {
            if(error.Response!=null) {
                string message="原助手拒绝退出，正在保存的资料与服务保留，请稍后重试。";
                try { using(var reader=new StreamReader(error.Response.GetResponseStream())) { var response=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());object detail;if(response.TryGetValue("error",out detail))message+=" "+Convert.ToString(detail); } } catch {}
                throw new CompanionFault("persistence_pending",message);
            }
            // A verified older helper can exit before its HTTP reply is flushed.
            // Treat this as exit only after a separate probe confirms the endpoint
            // is gone; a timeout or a still-live helper is a retryable failure.
            try { HelperRequest("/hello"); }
            catch(WebException probe) { if(probe.Response==null&&probe.Status==WebExceptionStatus.ConnectFailure)return true; }
            throw new CompanionFault("persistence_pending","原助手尚未确认退出，请稍后重试；未启动替换组件。");
        }
    }
    const string ProtocolKey=@"Software\Classes\zhiyun-focus";
    const string ProtocolCommand=ProtocolKey+@"\shell\open\command";
    static bool InstalledTarget(string command,string argument){
        var match=Regex.Match(command??"","^\"([^\"\\r\\n]+)\" "+Regex.Escape(argument)+"$");
        if(!match.Success)return false;
        string path=Path.GetFullPath(match.Groups[1].Value);
        if(!String.Equals(Path.GetDirectoryName(path),Application.StartupPath,StringComparison.OrdinalIgnoreCase))return false;
        var name=Path.GetFileName(path);
        if(String.Equals(name,"StudyCompanion.exe",StringComparison.OrdinalIgnoreCase))return true;
        var version=Regex.Match(name,@"^StudyCompanion-(\d+\.\d+\.\d+)(?:-[a-zA-Z0-9.-]+)?\.exe$",RegexOptions.IgnoreCase);
        Version installed;
        return version.Success&&Version.TryParse(version.Groups[1].Value,out installed)&&installed<=new Version(BuildVersion);
    }
    // A validated replacement takes over the existing installation itself.
    // No Codex process, maintenance chat, or extra installer is needed.
    public static void SyncInstalledRegistration(){
        RequireHealthyCandidate();InstallRegistration(false,true);
    }
    sealed class RegistrationValue {
        public readonly string Path,Name;
        readonly SystemRegistration registry;
        readonly SystemRegistration.Value previous;
        public RegistrationValue(SystemRegistration owner,string path,string name){registry=owner;Path=path;Name=name;previous=registry.Read(path,name);}
        public void Write(string next){registry.Write(Path,Name,next);}
        public void Restore(){registry.Restore(Path,Name,previous);}
    }
    static void InstallRegistration(bool includeStartup,bool automatic=false) {
        using(var mutex=new Mutex(false,"Local\\ZJFStudyRegistrationV1")){
            bool acquired;try{acquired=mutex.WaitOne(5000);}catch(AbandonedMutexException){acquired=true;}
            if(!acquired)throw new Exception("另一个启动注册操作尚未完成，保留原配置。");
            try{using(var registry=new SystemRegistration()){
                if(automatic){
                    string protocol=registry.Read(ProtocolCommand,"").Text,startup=registry.Read(StartupKey,StartupName).Text;
                    string executable="\""+Application.ExecutablePath+"\"";
                    includeStartup=!String.IsNullOrWhiteSpace(startup);
                    if(String.Equals(protocol,executable+" \"%1\"",StringComparison.OrdinalIgnoreCase)&&(!includeStartup||String.Equals(startup,executable+" --autostart",StringComparison.OrdinalIgnoreCase)))return;
                    // Do not create a first installation, take over a different
                    // folder, or downgrade a newer registered release.
                    if(!InstalledTarget(protocol,"\"%1\"")||includeStartup&&!InstalledTarget(startup,"--autostart"))return;
                }
                string[] keyPaths={ProtocolKey,ProtocolKey+@"\shell",ProtocolKey+@"\shell\open",ProtocolCommand,StartupKey};
                var absent=new List<string>();foreach(string path in keyPaths)if(!registry.KeyExists(path))absent.Add(path);
                var values=new List<RegistrationValue>{new RegistrationValue(registry,ProtocolKey,""),new RegistrationValue(registry,ProtocolKey,"URL Protocol"),new RegistrationValue(registry,ProtocolCommand,"")};
                if(includeStartup)values.Add(new RegistrationValue(registry,StartupKey,StartupName));
                int attempted=-1;
                try {
                    string[] next={"URL:智云聚焦沉浸助手","","\""+Application.ExecutablePath+"\" \"%1\"","\""+Application.ExecutablePath+"\" --autostart"};
                    for(int i=0;i<values.Count;i++){attempted=i;values[i].Write(next[i]);}
                } catch(Exception installError) {
                    var failures=new List<string>();
                    for(int i=attempted;i>=0;i--)try{values[i].Restore();}catch(Exception error){failures.Add(error.Message);}
                    for(int i=absent.Count-1;i>=0;i--)try{registry.DeleteEmptyKey(absent[i]);}catch(Exception error){failures.Add(error.Message);}
                    if(failures.Count>0)throw new Exception("安装注册失败，部分恢复也失败，原程序保留。 "+string.Join("；",failures.ToArray()),installError);
                    throw new Exception("安装注册失败，已恢复原协议与登录启动设置。",installError);
                }
            }}finally{mutex.ReleaseMutex();}
        }
    }
    static void InstallBrowserLink() { InstallRegistration(false); }
}
