using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

// The browser is created as a child of our own HWND from the beginning.
// No Chrome process/window is launched, searched for, hidden or reparented.
sealed partial class WebViewChatWindows : IChatWindows {
    static Task<CoreWebView2Environment> environment;
    static string environmentError="";
    static Task runtimePreparing;
    static CoreWebView2Controller runtimeController;
    static IntPtr runtimeHost;
    static HostLeaseHook runtimeHook;
    static readonly string runtimeLease="ZhiyunFocus.RuntimeHost."+Guid.NewGuid().ToString("N");
    static int runtimeGeneration;
    public static bool RuntimePrepared {get{return runtimeController!=null&&OwnsWindow(runtimeHost,runtimeLease);}}
    IntPtr host;
    readonly string hostLease="ZhiyunFocus.ChatHost."+Guid.NewGuid().ToString("N");
    HostLeaseHook hostLeaseHook;
    string marker="",error="",diagnosticPhase="idle",diagnosticDetail="";
    public object Diagnostics {get{return new {phase=diagnosticPhase,detail=diagnosticDetail,ready=ready,visible=visible};}}
    static string Diagnostic(Exception e){var value=e.GetType().Name+" (0x"+e.HResult.ToString("X8")+"): "+e.Message;return value.Length>1200?value.Substring(0,1200):value;}
    CoreWebView2Controller main,focusedController;
    readonly List<CoreWebView2Controller> popups=new List<CoreWebView2Controller>();
    public Func<bool,bool> FocusExitRequested;
    bool ready,disposed,visible,shutdownFrozen,shutdownDisabledWindow;long shutdownFreezeRevision;
    int generation,pendingPopups,popupRequestRevision;
    public const int HostStyle=0x46000004;
    int width=600,height=800;
    Native.Rect lastScreen;
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(int extended,string className,string title,int style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr window,bool enabled);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetParent(IntPtr window,IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetProp(IntPtr window,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr window,string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr window,string name);
    sealed class HostLeaseHook : NativeWindow {
        readonly string lease;
        public HostLeaseHook(IntPtr window,string value){lease=value;AssignHandle(window);}
        protected override void WndProc(ref Message message){
            // Parent-window destruction can bypass Forget. Remove our property
            // before this HWND is destroyed or available for system reuse.
            if(message.Msg==0x82&&GetProp(message.HWnd,lease)==new IntPtr(1))RemoveProp(message.HWnd,lease);
            base.WndProc(ref message);
        }
    }
    static bool OwnsWindow(IntPtr window,string lease){return window!=IntPtr.Zero&&Native.IsWindow(window)&&GetProp(window,lease)==new IntPtr(1);}
    static IntPtr CreateOwnedWindow(IntPtr owner,string title,int width,int height,string lease,out HostLeaseHook hook){
        hook=null;
        var window=CreateWindowEx(0,"STATIC",title,HostStyle,0,0,width,height,owner,IntPtr.Zero,Native.GetModuleHandle(null),IntPtr.Zero);
        if(window==IntPtr.Zero)throw new Exception("提问区域未能创建，请重试。");
        if(!SetProp(window,lease,new IntPtr(1))){DestroyWindow(window);throw new Exception("提问区域归属未能确认，请重试。");}
        try{hook=new HostLeaseHook(window,lease);}catch{RemoveProp(window,lease);DestroyWindow(window);throw;}
        return window;
    }
    static void DestroyOwnedWindow(IntPtr window,string lease){
        if(!OwnsWindow(window,lease))return;
        RemoveProp(window,lease);DestroyWindow(window);
    }
    public static string RuntimeVersion(){return CoreWebView2Environment.GetAvailableBrowserVersionString(null);}
    public static string RuntimeStatus {get{return environmentError!=""?"error":environment==null?"idle":environment.Status==TaskStatus.RanToCompletion?"ready":"loading";}}
    static Task<CoreWebView2Environment> Environment(){
        if(environment==null||environment.IsFaulted||environment.IsCanceled){
            string profile=System.Environment.GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER");
            if(String.IsNullOrWhiteSpace(profile))profile=Path.Combine(UserDataStore.Root,"ChatGPT");
            environmentError="";environment=CoreWebView2Environment.CreateAsync(null,profile,null);
        }
        return environment;
    }
    public static async Task Warmup(){
        Task<CoreWebView2Environment> pending=null;
        try{pending=Environment();await pending;if(environment==pending)environmentError="";}
        catch(Exception e){if(pending==null||environment==pending)environmentError=e.GetType().Name;}
    }
    // An authenticated caller may warm the browser process without opening
    // a question pane. The hidden controller stays on about:blank and never
    // navigates, changes the user's workspace, or holds a conversation.
    public static Task PrepareRuntime(IntPtr owner){
        if(RuntimePrepared)return Task.FromResult(true);
        if(runtimePreparing==null||runtimePreparing.IsFaulted||runtimePreparing.IsCanceled)runtimePreparing=PrepareRuntimeCore(owner);
        return runtimePreparing;
    }
    static async Task PrepareRuntimeCore(IntPtr owner){
        int ticket=++runtimeGeneration;
        IntPtr target=CreateOwnedWindow(owner,"",320,240,runtimeLease,out runtimeHook);runtimeHost=target;
        CoreWebView2Controller created=null;
        try{
            var env=await Environment();
            if(ticket!=runtimeGeneration||!OwnsWindow(target,runtimeLease))throw new OperationCanceledException("提问运行环境准备已取消。");
            created=await env.CreateCoreWebView2ControllerAsync(target);
            if(ticket!=runtimeGeneration||!OwnsWindow(target,runtimeLease))throw new OperationCanceledException("提问运行环境准备已取消。");
            created.IsVisible=false;created.Bounds=new Rectangle(0,0,320,240);runtimeController=created;
        }catch{
            if(created!=null)try{created.Close();}catch{}
            DestroyOwnedWindow(target,runtimeLease);
            if(runtimeHost==target)runtimeHost=IntPtr.Zero;
            throw;
        }
    }
    public static void DisposeRuntime(){
        runtimeGeneration++;
        if(runtimeController!=null){try{runtimeController.Close();}catch{}runtimeController=null;}
        DestroyOwnedWindow(runtimeHost,runtimeLease);runtimeHost=IntPtr.Zero;
        GC.KeepAlive(runtimeHook);runtimeHook=null;runtimePreparing=null;
    }
    public static async Task<object> CheckController(IntPtr owner){
        string lease="ZhiyunFocus.ChatCheck."+Guid.NewGuid().ToString("N");
        HostLeaseHook hook;IntPtr child=CreateOwnedWindow(owner,"",320,640,lease,out hook);
        CoreWebView2Controller controller=null;
        try{
            var env=await Environment();if(!OwnsWindow(child,lease))throw new Exception("提问区域已关闭，请重试。");
            controller=await env.CreateCoreWebView2ControllerAsync(child);
            if(!OwnsWindow(child,lease))throw new Exception("提问区域已关闭，请重试。");
            controller.IsVisible=false;controller.Bounds=new Rectangle(0,0,320,640);
            return new {runtime=RuntimeVersion(),controllerCreated=true,childOfOwner=GetParent(child)==owner,visible=Native.IsWindowVisible(child),navigationRequested=false};
        }finally{if(controller!=null)controller.Close();DestroyOwnedWindow(child,lease);GC.KeepAlive(hook);}
    }
    public void Launch(IntPtr owner,string url){
        if(host!=IntPtr.Zero)Forget(host);
        disposed=false;ready=false;visible=false;pendingPopups=0;error="";int ticket=++generation;
        string id=new Uri(url).AbsolutePath.Substring("/chat/".Length);marker="[ZJFCHAT:"+id+"]";
        diagnosticPhase="creating-host";diagnosticDetail="";
        try{host=CreateOwnedWindow(owner,marker,width,height,hostLease,out hostLeaseHook);}catch(Exception e){diagnosticDetail=Diagnostic(e);throw;}
        Initialize(host,ticket);
    }
    bool CurrentHost(IntPtr target,int ticket){return !disposed&&ticket==generation&&host==target&&OwnsWindow(target,hostLease);}
    bool CurrentMain(CoreWebView2Controller controller,IntPtr target,int ticket){return CurrentHost(target,ticket)&&main==controller;}
    bool CurrentController(CoreWebView2Controller controller,IntPtr target,int ticket){return CurrentHost(target,ticket)&&(main==controller||popups.Contains(controller));}
    bool CurrentPopupRequest(CoreWebView2Controller opener,IntPtr target,int ticket,int revision,long workspace,long document,string source){
        return CurrentController(opener,target,ticket)&&visible&&ActiveController()==opener&&popupRequestRevision==revision&&captureWorkspaceMode=="chat"&&captureWorkspaceRevision==workspace&&captureDocumentEpoch==document&&opener.CoreWebView2.Source==source;
    }
    async void Initialize(IntPtr target,int ticket){
        CoreWebView2Controller created=null;
        Task<CoreWebView2Environment> pending=null;
        try{
            diagnosticPhase="environment";pending=Environment();var env=await pending;
            if(!CurrentHost(target,ticket))return;
            diagnosticPhase="creating-controller";created=await env.CreateCoreWebView2ControllerAsync(target);
            if(!CurrentHost(target,ticket)){created.Close();return;}
            main=created;Configure(created,target,ticket);created.IsVisible=false;created.Bounds=new Rectangle(0,0,width,height);
            var browser=created.CoreWebView2;diagnosticPhase="initializing-bridge";await InitializeCaptureBridge(browser);
            if(!CurrentMain(created,target,ticket)){created.Close();return;}
            ulong navigation=0;
            browser.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e){
                if(!CurrentMain(created,target,ticket))return;
                popupRequestRevision++;navigation=e.NavigationId;ready=false;error="";diagnosticPhase="navigating";diagnosticDetail="";
            };
            browser.NavigationCompleted+=delegate(object sender,CoreWebView2NavigationCompletedEventArgs e){
                if(!CurrentMain(created,target,ticket)||e.NavigationId!=navigation)return;
                // HTTP login/challenge pages are real documents that the user
                // must be able to see. Transport errors are not readiness.
                if(e.IsSuccess||e.HttpStatusCode>0){ready=true;error="";diagnosticPhase="ready";diagnosticDetail="";}
                else{ready=false;error="ChatGPT 网页连接失败，请重试。";diagnosticPhase="navigation-failed";diagnosticDetail=e.WebErrorStatus+"; HTTP "+e.HttpStatusCode;}
            };
            browser.ProcessFailed+=delegate(object sender,CoreWebView2ProcessFailedEventArgs e){
                if(CurrentMain(created,target,ticket)&&(e.ProcessFailedKind==CoreWebView2ProcessFailedKind.BrowserProcessExited||e.ProcessFailedKind==CoreWebView2ProcessFailedKind.RenderProcessExited)){ready=false;error="提问网页运行中断，请重新打开。";diagnosticPhase="process-failed";diagnosticDetail=e.ProcessFailedKind.ToString();}
            };
            string startUrl=await Task.Run(delegate{return StudyLibrary.LessonConversationUrl(viewerLessonKey);});
            if(!CurrentMain(created,target,ticket)){created.Close();return;}
            diagnosticPhase="navigating";browser.Navigate(startUrl);
        }catch(Exception e){
            if(created!=null){if(main==created)main=null;try{created.Close();}catch{}}
            if(CurrentHost(target,ticket)){diagnosticDetail=Diagnostic(e);ready=false;error="提问网页未能初始化，请重试。";if(pending!=null&&environment==pending&&pending.IsFaulted)environmentError=e.GetType().Name;}
        }
    }
    void Configure(CoreWebView2Controller controller,IntPtr target,int ticket){
        controller.DefaultBackgroundColor=Color.FromArgb(17,17,17);
        controller.CoreWebView2.Settings.IsStatusBarEnabled=false;
        controller.CoreWebView2.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e){PopupRequested(controller,target,ticket,e);};
        controller.GotFocus+=delegate{if(CurrentController(controller,target,ticket))focusedController=controller;};
        controller.LostFocus+=delegate{if(focusedController==controller)focusedController=null;};
        controller.MoveFocusRequested+=delegate(object sender,CoreWebView2MoveFocusRequestedEventArgs e){
            if(!CurrentController(controller,target,ticket)||ActiveController()!=controller||shutdownFrozen)return;
            if(e.Reason!=CoreWebView2MoveFocusReason.Next&&e.Reason!=CoreWebView2MoveFocusReason.Previous)return;
            var move=FocusExitRequested;if(move!=null&&move(e.Reason==CoreWebView2MoveFocusReason.Previous))e.Handled=true;
        };
    }
    async void PopupRequested(CoreWebView2Controller opener,IntPtr target,int ticket,CoreWebView2NewWindowRequestedEventArgs e){
        e.Handled=true;
        if(!CurrentController(opener,target,ticket)||!visible||ActiveController()!=opener||captureWorkspaceMode!="chat"||popups.Count+pendingPopups>=3)return;
        int revision=popupRequestRevision;long workspace=captureWorkspaceRevision,document=captureDocumentEpoch;string source=opener.CoreWebView2.Source;
        // Reservations belong to this host generation, including work that has
        // not returned a controller yet. Old completions cannot debit a new host.
        pendingPopups++;
        CoreWebView2Deferral deferral=null;CoreWebView2Controller popup=null;
        try{
            deferral=e.GetDeferral();var env=await Environment();if(!CurrentPopupRequest(opener,target,ticket,revision,workspace,document,source))return;
            popup=await env.CreateCoreWebView2ControllerAsync(target);
            if(!CurrentPopupRequest(opener,target,ticket,revision,workspace,document,source)){popup.Close();return;}
            Configure(popup,target,ticket);popup.IsVisible=false;popup.Bounds=new Rectangle(0,0,width,height);
            var closing=popup;
            popup.CoreWebView2.WindowCloseRequested+=delegate{ClosePopup(closing);};
            e.NewWindow=popup.CoreWebView2;popups.Add(popup);ApplyVisibility();
        }catch{if(popup!=null){popups.Remove(popup);try{popup.Close();}catch{}}}
        finally{if(ticket==generation)pendingPopups--;if(deferral!=null)try{deferral.Complete();}catch{}}
    }
    void ClosePopup(CoreWebView2Controller popup){if(!popups.Remove(popup))return;if(focusedController==popup)focusedController=null;try{popup.Close();}catch{}ApplyVisibility();}
    void ApplyVisibility(){
        if(main==null||!Exists(host))return;
        main.IsVisible=visible&&popups.Count==0;
        for(int i=0;i<popups.Count;i++)popups[i].IsVisible=visible&&i==popups.Count-1;
    }
    CoreWebView2Controller ActiveController(){return visible&&Exists(host)?popups.Count>0?popups[popups.Count-1]:main:null;}
    public bool HasInputFocus {get{return focusedController!=null&&focusedController==ActiveController();}}
    public bool Focus(bool backwards){
        var controller=ActiveController();if(controller==null||!Ready(host)||shutdownFrozen||pendingPopups>0)return false;
        controller.MoveFocus(backwards?CoreWebView2MoveFocusReason.Previous:CoreWebView2MoveFocusReason.Next);return true;
    }
    public IntPtr Find(string value){return value==marker&&Exists(host)?host:IntPtr.Zero;}
    public bool Exists(IntPtr handle){return !disposed&&handle==host&&OwnsWindow(handle,hostLease);}
    public bool Ready(IntPtr handle){return Exists(handle)&&ready&&error=="";}
    public string Failure(IntPtr handle){return handle==host?error:"";}
    public void Embed(IntPtr handle,IntPtr owner){
        if(!Exists(handle))throw new Exception("提问区域已关闭。");
        if(GetParent(handle)!=owner){SetParent(handle,owner);if(GetParent(handle)!=owner)throw new Exception("提问区域未能连接到课程窗口。");}
    }
    public void Place(IntPtr handle,ChatBounds bounds){
        if(!Exists(handle))return;
        width=bounds.Width;height=bounds.Height;
        Native.Rect rect;Native.GetWindowRect(host,out rect);var origin=new Native.Point();Native.ClientToScreen(GetParent(host),ref origin);
        if(rect.Left-origin.X!=bounds.X||rect.Top-origin.Y!=bounds.Y||rect.Width!=width||rect.Height!=height||visible&&GetWindow(host,3)!=IntPtr.Zero)
            Native.SetWindowPos(host,IntPtr.Zero,bounds.X,bounds.Y,width,height,0x10);
        var content=new Rectangle(0,0,width,height);
        if(main!=null&&main.Bounds!=content)main.Bounds=content;
        foreach(var popup in popups)if(popup.Bounds!=content)popup.Bounds=content;
        Native.GetWindowRect(host,out rect);
        if(rect.Left!=lastScreen.Left||rect.Top!=lastScreen.Top){if(main!=null)main.NotifyParentWindowPositionChanged();foreach(var popup in popups)popup.NotifyParentWindowPositionChanged();lastScreen=rect;}
    }
    public void Show(IntPtr handle,bool show){
        if(!Exists(handle))return;bool entering=show&&!visible;if(!show)popupRequestRevision++;visible=show;
        // The parent must be visible before its browser becomes visible.
        if(show)Native.SetWindowPos(host,IntPtr.Zero,0,0,0,0,0x53);ApplyVisibility();if(!show)Native.ShowWindow(host,0);
        if(entering&&main!=null)try{main.CoreWebView2.PostWebMessageAsJson("{\"kind\":\"zjf-pane-visible\"}");}catch{}
    }
    public void ClosePlaceholder(IntPtr handle){Forget(handle);}
    public void Detach(IntPtr handle,IntPtr owner){Forget(handle);}
    public void ResumeAfterFailedClose(long freeze=0){
        if(freeze!=0&&freeze!=shutdownFreezeRevision)return;
        shutdownFreezeRevision++;bool restore=shutdownDisabledWindow;shutdownFrozen=false;shutdownDisabledWindow=false;
        if(Exists(host)){if(restore)EnableWindow(host,true);if(captureBrowser!=null&&captureTarget!=null)CaptureReply(captureBrowser,captureHostTicket,new {kind="zjf-close-state",protocol=2,closeRevision=shutdownFreezeRevision,frozen=false,target=captureTarget.Snapshot()});}
    }
    public void Forget(IntPtr handle){
        if(handle!=host)return;RetireCaptureBridge();disposed=true;visible=false;ready=false;shutdownFrozen=false;shutdownDisabledWindow=false;focusedController=null;pendingPopups=0;generation++;
        while(popups.Count>0){var popup=popups[popups.Count-1];popups.RemoveAt(popups.Count-1);try{popup.Close();}catch{}}
        if(main!=null){try{main.Close();}catch{}main=null;}
        if(host!=IntPtr.Zero){DestroyOwnedWindow(host,hostLease);host=IntPtr.Zero;}GC.KeepAlive(hostLeaseHook);hostLeaseHook=null;
    }
    public void ClientSize(IntPtr owner,out int w,out int h){Native.Rect rect;Native.GetClientRect(owner,out rect);w=rect.Width;h=rect.Height;}
}
