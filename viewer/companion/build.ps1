param([string]$OutputPath)
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$builder=Join-Path $PSScriptRoot '..\build.py'
$python=(Get-Command python -ErrorAction Stop).Source
$node=(Get-Command node -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath $compiler)) { throw '缺少 Windows x64 .NET Framework 编译器。' }
$output=if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $PSScriptRoot 'StudyCompanion.exe' }
$outputDirectory=[IO.Path]::GetDirectoryName($output)
$outputName=[IO.Path]::GetFileName($output)
if ([IO.Path]::GetExtension($outputName) -ne '.exe') { throw 'OutputPath 必须是 .exe 文件。' }
$sourceNames=@('StudyCompanion.cs','SystemRegistration.cs','EmbeddedChat.cs','WebViewChat.cs','ChatDraftBridge.cs','StudyLibrary.cs','UserDataStore.cs','BrowserCaptureViewport.cs','ViewportResolverCache.cs')
$wpfDirectory=Join-Path ([IO.Path]::GetDirectoryName($compiler)) 'WPF'
$automationReferences=@('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll') | ForEach-Object {
    $reference=Join-Path $wpfDirectory $_
    if (!(Test-Path -LiteralPath $reference)) { throw "缺少 Windows 视区定位依赖：$_" }
    "/reference:$reference"
}
$libraries=@('Microsoft.Web.WebView2.Core.dll','WebView2Loader.dll')
$notices=@('WebView2.LICENSE.txt','WebView2.NOTICE.txt')
$licenseDirectory=Join-Path $PSScriptRoot '..\..\LICENSES'
foreach ($name in $sourceNames) { if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) { throw "缺少源码：$name" } }
foreach ($name in $libraries) { if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot ('webview2-sdk\'+$name)))) { throw "缺少 WebView2 SDK：$name" } }
foreach ($name in $notices) { if (!(Test-Path -LiteralPath (Join-Path $licenseDirectory $name))) { throw "缺少第三方许可：$name" } }
& $python -X utf8 (Join-Path $PSScriptRoot 'fetch_sdk.py') --check
if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK 与锁定版本不符；未修改安装文件。' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$stage=[IO.Path]::GetFullPath((Join-Path $outputDirectory ('.zjf-build-'+[guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $stage | Out-Null
$completed=$false
try {
    $generated=Join-Path $stage 'viewer'
    & $python -X utf8 $builder --output-dir $generated | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '网页源码构建失败；未修改安装文件。' }
    foreach ($name in @('capture-receiver.js','focus-entry.js')) {
        & $node --check (Join-Path $generated $name)
        if ($LASTEXITCODE -ne 0) { throw "网页脚本语法检查失败：$name" }
    }
    $viewerManifest=Get-Content -LiteralPath (Join-Path $generated 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $inputs=[ordered]@{}
    $sources=@()
    foreach ($name in $sourceNames) {
        $from=Join-Path $PSScriptRoot $name;$to=Join-Path $stage $name
        Copy-Item -LiteralPath $from -Destination $to
        $inputs[$name]=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant()
        $sources+=$to
    }
    foreach ($name in $libraries) {
        $to=Join-Path $stage $name
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('webview2-sdk\'+$name)) -Destination $to
        $inputs[$name]=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    foreach ($name in $notices) {
        $to=Join-Path $stage $name
        Copy-Item -LiteralPath (Join-Path $licenseDirectory $name) -Destination $to
        $inputs[$name]=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $inputs['build.ps1']=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $inputs['receiver']=$viewerManifest.receiver_sha256
    $inputs['viewerSources']=$viewerManifest.sources
    $buildBytes=[Text.Encoding]::UTF8.GetBytes(($inputs | ConvertTo-Json -Depth 5 -Compress))
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { $buildId=[BitConverter]::ToString($hasher.ComputeHash($buildBytes)).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    $metadata=Join-Path $stage 'ReleaseMetadata.cs'
    '[assembly: System.Reflection.AssemblyInformationalVersion("'+$viewerManifest.version+'+'+$buildId+'")]' | Set-Content -LiteralPath $metadata -Encoding UTF8
    $sources+=$metadata
    $stagedExe=Join-Path $stage $outputName
    $draftScript=Join-Path $generated 'capture-receiver.js'
    $webLibrary=Join-Path $stage 'Microsoft.Web.WebView2.Core.dll'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:Accessibility.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Core.dll /reference:System.Management.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll @automationReferences "/reference:$webLibrary" "/resource:$draftScript,ZjfChatDraft.js" "/out:$stagedExe" @sources
    if ($LASTEXITCODE -ne 0) { throw '沉浸助手编译失败；未修改安装文件。' }
    $checkSource=Join-Path $stage 'CheckRelease.cs'
    @'
using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
static class CheckRelease {
    static int Main(string[] args) {
        var assembly=Assembly.LoadFrom(args[0]);
        var version=Convert.ToString(assembly.GetType("Program").GetField("BuildVersion").GetRawConstantValue());
        if(version!=args[1])throw new Exception("Native and viewer versions differ.");
        var info=(AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(assembly,typeof(AssemblyInformationalVersionAttribute));
        if(info==null||info.InformationalVersion!=args[1]+"+"+args[2])throw new Exception("Build identity differs.");
        using(var stream=assembly.GetManifestResourceStream("ZjfChatDraft.js"))using(var sha=SHA256.Create()) {
            if(stream==null||BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant()!=args[3])throw new Exception("Embedded receiver differs from source.");
        }
        return 0;
    }
}
'@ | Set-Content -LiteralPath $checkSource -Encoding UTF8
    $checkExe=Join-Path $stage 'CheckRelease.exe'
    & $compiler /nologo /target:exe /platform:x64 "/out:$checkExe" $checkSource
    if ($LASTEXITCODE -ne 0) { throw '构建资源检查器编译失败。' }
    & $checkExe $stagedExe $viewerManifest.version $buildId $viewerManifest.receiver_sha256
    if ($LASTEXITCODE -ne 0) { throw '沉浸助手版本或内嵌资源验证失败。' }
    $runtimeInfo=Join-Path $stage 'component-info.json'
    $runtimeProcess=Start-Process -FilePath $stagedExe -ArgumentList @('--component-info',('"'+$runtimeInfo+'"')) -WorkingDirectory $stage -Wait -PassThru -WindowStyle Hidden
    if ($runtimeProcess.ExitCode -ne 0 -or !(Test-Path -LiteralPath $runtimeInfo)) { throw 'WebView2 依赖或本机运行时不可用；未修改安装文件。' }
    $runtimeResult=Get-Content -LiteralPath $runtimeInfo -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$runtimeResult.runtime -or $runtimeResult.build -ne $viewerManifest.version) { throw 'WebView2 组件检查结果无效。' }
    $manifestName=$outputName+'.build.json'
    $files=[ordered]@{}
    foreach ($name in @($outputName)+$libraries+$notices) { $files[$name]=(Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
    [ordered]@{version=$viewerManifest.version;build_id=$buildId;receiver_sha256=$viewerManifest.receiver_sha256;files=$files;inputs=$inputs;verified_runtime=$runtimeResult.runtime} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage $manifestName) -Encoding UTF8
    # Do not change a destination before all checks pass. Restore files already
    # replaced if any subsequent replacement in this commit fails.
    $changed=@()
    foreach ($name in @($outputName)+$libraries+$notices+@($manifestName)) {
        $target=Join-Path $outputDirectory $name;$candidate=Join-Path $stage $name
        if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $candidate).Hash) { continue }
        if (Test-Path -LiteralPath $target) { $probe=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$probe.Dispose() }
        $changed+=[pscustomobject]@{Target=$target;Candidate=$candidate;Backup=(Join-Path $stage ($name+'.previous'));Existed=(Test-Path -LiteralPath $target)}
    }
    $applied=@()
    try {
        foreach ($item in $changed) {
            if ($item.Existed) { [IO.File]::Replace($item.Candidate,$item.Target,$item.Backup,$true) } else { [IO.File]::Move($item.Candidate,$item.Target) }
            $applied+=$item
        }
    } catch {
        $commitError=$_
        $rollbackErrors=@()
        for ($index=$applied.Count-1;$index -ge 0;$index--) {
            $item=$applied[$index]
            try { if ($item.Existed) { [IO.File]::Replace($item.Backup,$item.Target,($item.Candidate+'.rejected'),$true) } else { [IO.File]::Delete($item.Target) } }
            catch { $rollbackErrors+=$_.Exception.Message }
        }
        if ($rollbackErrors.Count) { throw "构建提交失败；部分恢复也失败，保留恢复文件于 $stage。$($rollbackErrors -join '；')" }
        throw $commitError
    }
    $completed=$true
    Write-Output $output
} catch {
    throw "构建未完成，暂存及诊断文件保留于 $stage。$($_.Exception.Message)"
} finally {
    if ($completed) {
        # Resolve and check the exact generated directory before recursive removal.
        $resolvedStage=[IO.Path]::GetFullPath($stage)
        if ([IO.Path]::GetDirectoryName($resolvedStage) -eq [IO.Path]::GetFullPath($outputDirectory) -and [IO.Path]::GetFileName($resolvedStage).StartsWith('.zjf-build-')) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
