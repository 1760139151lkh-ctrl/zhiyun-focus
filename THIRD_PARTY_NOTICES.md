# 第三方来源与许可

根目录 MIT 许可适用于本项目原创代码和文档，不替换以下第三方许可。课堂图像、音频和账号资料不随源码分发。

| 组件 | 固定来源 | 许可及分发方式 |
| --- | --- | --- |
| MossFormer2 生产适配 `viewer/audio-helper/mossformer.py` | 从本项目已采用的 ClearerVoice-Studio 集成提取；特征变换遵循下列固定作者代码。文件头标明修改来源。 | Apache-2.0；随仓库提供 [完整许可](LICENSES/Apache-2.0.txt)。 |
| ClearerVoice-Studio 模型实现 | [modelscope/ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio/tree/6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61)，commit `6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61` | Apache-2.0；下载器仅获取 MossFormer2 所需的七个 Python 文件和上游 LICENSE，保留头部声明。源码文件不内嵌到本 Git 仓库。 |
| MossFormer2_SE_48K 权重 | [alibabasglab/MossFormer2_SE_48K](https://huggingface.co/alibabasglab/MossFormer2_SE_48K/tree/eff8c97925c8bec812af707814b3e5d777fd4503)，revision `eff8c97925c8bec812af707814b3e5d777fd4503` | 模型仓库声明 Apache-2.0；下载原始权重和模型卡，不提交大文件。 |
| Microsoft.Web.WebView2 SDK | [NuGet 1.0.4258.31](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31) | 上游 BSD-3-Clause；原文在 [WebView2.LICENSE.txt](LICENSES/WebView2.LICENSE.txt)，相关 ANTLR/StringTemplate 声明在 [WebView2.NOTICE.txt](LICENSES/WebView2.NOTICE.txt)。构建会将两份文件复制到 DLL 同目录。 |

[音频资产锁](viewer/audio-helper/assets.lock.json) 记录每个源文件及权重的 URL、版本、字节数和 SHA-256。[SDK 锁](viewer/companion/webview2.lock.json) 记录 NuGet 包与所用 DLL 的 SHA-256。更新时应重新核对上游许可、来源和实际功能，不只替换版本字符串。

Python、Node.js、.NET Framework、WebView2 Evergreen Runtime、FFmpeg、PyTorch、torchaudio、NumPy、SciPy、einops、rotary-embedding-torch 和 torchinfo 由使用者从各自官方渠道安装，本仓库不分发它们的二进制。它们及其传递依赖保留各自许可。特别是 FFmpeg 的具体构建可能包含不同授权组件，重新分发运行环境时须检查所选发行包；本项目没有把系统安装包改为 MIT。

相关官方来源：[ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio)、[WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)、[PyTorch](https://pytorch.org/)、[FFmpeg 法律说明](https://ffmpeg.org/legal.html)。
