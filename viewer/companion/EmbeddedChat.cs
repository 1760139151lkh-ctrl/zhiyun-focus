using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

struct ChatViewport {public int X,Y,Width,Height;}

struct ChatBounds {
    public int X,Y,Width,Height;
    public double Aside;
    public static ChatBounds Fit(int clientWidth,int clientHeight,double width,double height,double dpr,double requested,double headerHeight=0) {
        int pageWidth=Math.Min(clientWidth,(int)Math.Round(width*dpr));
        int pageHeight=Math.Min(clientHeight,(int)Math.Round(height*dpr));
        return FitViewport(new ChatViewport{X=clientWidth-pageWidth,Y=clientHeight-pageHeight,Width=pageWidth,Height=pageHeight},dpr,requested,headerHeight,width);
    }
    public static ChatBounds FitViewport(ChatViewport viewport,double dpr,double requested,double headerHeight=0,double cssWidth=0){
        if(cssWidth<=0)cssWidth=viewport.Width/dpr;
        double aside=ImmersivePolicy.ChatWidth(cssWidth,requested),rail=Math.Max(0,Math.Min(20,aside-1/dpr));
        int right=Math.Max(1,Math.Min(viewport.Width,(int)Math.Round(cssWidth*dpr,MidpointRounding.AwayFromZero)));
        // Round the CSS edge once, like the browser. Subtracting separately
        // rounded panel and rail widths can overlap the board by a device pixel.
        int left=Math.Max(0,Math.Min(right-1,(int)Math.Round((cssWidth-aside+rail)*dpr,MidpointRounding.AwayFromZero)));
        int header=Math.Max(0,Math.Min(viewport.Height-1,(int)Math.Round(headerHeight*dpr,MidpointRounding.AwayFromZero)));
        return new ChatBounds{X=viewport.X+left,Y=viewport.Y+header,Width=Math.Max(1,right-left),
            Height=Math.Max(1,viewport.Height-header),Aside=aside};
    }
}

interface IChatWindows {
    void Launch(IntPtr owner,string url);
    IntPtr Find(string marker);
    bool Exists(IntPtr handle);
    bool Ready(IntPtr handle);
    string Failure(IntPtr handle);
    void Embed(IntPtr handle,IntPtr owner);
    void Place(IntPtr handle,ChatBounds bounds);
    void Show(IntPtr handle,bool visible);
    void ClosePlaceholder(IntPtr handle);
    void Detach(IntPtr handle,IntPtr owner);
    void Forget(IntPtr handle);
    void ClientSize(IntPtr owner,out int width,out int height);
}

// Every pane belongs to one course HWND. No desktop coordinates or topmost
// floating windows are involved after attaching the initial blank app shell.
sealed class EmbeddedChatPane {
    readonly IChatWindows windows;
    IntPtr owner;
    public readonly string Id=Guid.NewGuid().ToString("N");
    public string Marker {get{return "[ZJFCHAT:"+Id+"]";}}
    public IntPtr Handle {get;private set;}
    public bool Opened {get;private set;}
    public bool Starting {get;private set;}
    public bool Visible {get{return visible&&Attached;}}
    public bool Attached {get{return Handle!=IntPtr.Zero&&windows.Exists(Handle);}}
    public string Error {get;private set;}
    public double Aside {get;private set;}
    public bool Suspended {get;private set;}
    public bool LayoutReady {get{return !requireViewport||viewport.HasValue;}}
    public bool NavigateReady {get{return Attached&&Opened&&confirmed&&!Suspended&&LayoutReady;}}
    public bool Presented {get{return confirmed;}}
    double requested=280,headerHeight;
    ChatViewport? viewport;
    bool requireViewport;
    long started;
    bool visible,confirmed;
    public EmbeddedChatPane(IntPtr parent,IChatWindows platform){owner=parent;windows=platform;Error="";}
    public void Rebind(IntPtr parent){
        if(parent==owner)return;
        if(Attached){windows.Show(Handle,false);visible=false;windows.Embed(Handle,parent);}
        else{
            if(Handle!=IntPtr.Zero)windows.Forget(Handle);
            Handle=IntPtr.Zero;Opened=false;Starting=false;visible=false;confirmed=false;Aside=0;
        }
        owner=parent;
    }
    public void Open(double width,long now) {
        requested=width;Error="";confirmed=false;Suspended=false;
        if(visible&&Attached){windows.Show(Handle,false);visible=false;}
        if(Attached){
            if(windows.Failure(Handle)!=""){windows.Forget(Handle);Handle=IntPtr.Zero;Opened=false;Starting=false;}
            else{Opened=windows.Ready(Handle);Starting=!Opened;started=now;return;}
        }
        Handle=IntPtr.Zero;Opened=false;
        if(Starting)return;
        Starting=true;started=now;
        try{windows.Launch(owner,"http://127.0.0.1:8772/chat/"+Id);}
        catch{Starting=false;Error="提问组件未能启动，请重试。";throw;}
    }
    public void Resize(double width){requested=width;}
    public void SetHeader(double height){headerHeight=height;}
    public void SetViewport(ChatViewport? value,bool required){viewport=value;requireViewport=required;if(!LayoutReady&&visible&&Attached){windows.Show(Handle,false);visible=false;}}
    public void Tick(long now,double width,double height,double dpr,bool courseVisible) {
        if(Handle!=IntPtr.Zero&&!windows.Exists(Handle)){windows.Forget(Handle);Handle=IntPtr.Zero;Opened=false;Starting=false;visible=false;Aside=0;Error="提问区域已关闭，请重新打开。";}
        if(Starting&&Handle==IntPtr.Zero){
            var found=windows.Find(Marker);
            if(found!=IntPtr.Zero){
                try{windows.Embed(found,owner);Handle=found;}
                catch{windows.ClosePlaceholder(found);Starting=false;Opened=false;Error="提问区域嵌入失败，请重试。";}
            }else if(now-started>=10000){Starting=false;Error="提问组件启动超时，请重试。";}
        }
        if(!Starting&&!Attached&&started>0){var late=windows.Find(Marker);if(late!=IntPtr.Zero)windows.ClosePlaceholder(late);}
        if(!Attached){Aside=0;return;}
        int clientWidth,clientHeight;windows.ClientSize(owner,out clientWidth,out clientHeight);
        var bounds=viewport.HasValue?ChatBounds.FitViewport(viewport.Value,dpr,requested,headerHeight,width):ChatBounds.Fit(clientWidth,clientHeight,width,height,dpr,requested,headerHeight);
        if(LayoutReady)windows.Place(Handle,bounds);
        string failure=windows.Failure(Handle);
        if(failure!=""){Starting=false;Opened=false;Error=failure;Aside=0;if(visible)windows.Show(Handle,false);visible=false;return;}
        if(Starting){
            if(windows.Ready(Handle)){Starting=false;Opened=true;}
            else if(now-started>=10000){Starting=false;Error="ChatGPT 网页准备超时，请重试。";windows.Forget(Handle);Handle=IntPtr.Zero;Aside=0;return;}
        }
        if(!Opened||!courseVisible||Suspended||!LayoutReady){if(visible)windows.Show(Handle,false);visible=false;Aside=Opened&&!Suspended&&LayoutReady?bounds.Aside:0;return;}
        Aside=bounds.Aside;
        if(confirmed&&!visible){windows.Show(Handle,true);visible=true;}
    }
    public void Confirm(){if(!Attached||!Opened||Suspended||!LayoutReady)throw new Exception("提问区域尚未准备好");confirmed=true;}
    // Materials temporarily use the same reserved area. Keep the controller and
    // its draft alive, but require a fresh layout acknowledgement when returning.
    public void Suspend(){Suspended=true;confirmed=false;Aside=0;if(Attached)windows.Show(Handle,false);visible=false;}
    public void Hide(){Opened=false;Starting=false;confirmed=false;Suspended=false;Aside=0;if(Attached)windows.Show(Handle,false);visible=false;}
    public void Dispose(){
        Hide();var target=Handle!=IntPtr.Zero?Handle:windows.Find(Marker);
        if(target!=IntPtr.Zero){if(windows.Exists(target))windows.Detach(target,owner);else windows.Forget(target);}
        Handle=IntPtr.Zero;
    }
}
