using System;
using System.Management;
using System.Security.Principal;

// StdRegProv runs outside an MSIX caller's registry virtualization. Always use
// the caller's explicit SID under HKEY_USERS, never the provider's HKCU.
sealed class SystemRegistration : IDisposable {
    public sealed class Value {
        public bool Exists;
        public string Text="";
    }
    readonly ManagementClass provider;
    readonly string user;
    public SystemRegistration(){
        user=WindowsIdentity.GetCurrent().User.Value+"\\";
        var scope=new ManagementScope(@"\\.\root\default");
        scope.Connect();
        provider=new ManagementClass(scope,new ManagementPath("StdRegProv"),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(5)});
    }
    ManagementBaseObject Call(string method,string path,string name=null,string value=null){
        using(var input=provider.GetMethodParameters(method)){
            input["hDefKey"]=0x80000003u;input["sSubKeyName"]=user+path;
            if(name!=null)input["sValueName"]=name;
            if(value!=null)input["sValue"]=value;
            return provider.InvokeMethod(method,input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(5)});
        }
    }
    static uint Result(ManagementBaseObject output){return Convert.ToUInt32(output["ReturnValue"]);}
    static void Require(ManagementBaseObject output){if(Result(output)!=0)throw new InvalidOperationException("Windows 启动注册操作失败："+Result(output));}
    public bool KeyExists(string path){using(var output=Call("EnumValues",path)){if(Result(output)==2)return false;Require(output);return true;}}
    public Value Read(string path,string name){
        using(var output=Call("EnumValues",path)){
            if(Result(output)==2)return new Value();Require(output);
            var names=output["sNames"] as string[];var types=output["Types"] as Array;
            int index=names==null?-1:Array.FindIndex(names,item=>(item??"")==name);
            // StdRegProv can omit the unnamed value from EnumValues even when
            // GetStringValue with an empty name succeeds. Named values retain
            // their type proof from the enumeration.
            if(index<0&&name!="")return new Value();
            // These application-owned values are REG_SZ. Reject an unexpected
            // type before writing, so its exact original representation is kept.
            if(index>=0&&(types==null||Convert.ToUInt32(types.GetValue(index))!=1))throw new InvalidOperationException("启动注册值类型异常，已保留原配置。");
        }
        using(var output=Call("GetStringValue",path,name)){
            if(name==""&&(Result(output)==1||Result(output)==2))return new Value();
            Require(output);return new Value{Exists=true,Text=Convert.ToString(output["sValue"])};
        }
    }
    public void Write(string path,string name,string value){
        using(var output=Call("CreateKey",path))Require(output);
        using(var output=Call("SetStringValue",path,name,value))Require(output);
        var actual=Read(path,name);
        if(!actual.Exists||actual.Text!=value)throw new InvalidOperationException("Windows 实际启动入口写入后核对失败。");
    }
    public void Restore(string path,string name,Value value){
        var actual=Read(path,name);
        if(actual.Exists==value.Exists&&actual.Text==value.Text)return;
        if(value.Exists)Write(path,name,value.Text);else DeleteValue(path,name);
    }
    public void DeleteValue(string path,string name){
        if(!Read(path,name).Exists)return;
        using(var output=Call("DeleteValue",path,name))Require(output);
        if(Read(path,name).Exists)throw new InvalidOperationException("Windows 实际启动入口未能移除。");
    }
    public void DeleteEmptyKey(string path){
        if(Read(path,"").Exists)return;
        using(var values=Call("EnumValues",path)){
            if(Result(values)==2)return;Require(values);
            var names=values["sNames"] as Array;if(names!=null&&names.Length>0)return;
        }
        using(var children=Call("EnumKey",path)){
            Require(children);var names=children["sNames"] as Array;if(names!=null&&names.Length>0)return;
        }
        using(var output=Call("DeleteKey",path))Require(output);
    }
    public void Dispose(){provider.Dispose();}
}
