# Delta Highlight v2.0.9 构建说明

## 1. 源码职责

```text
./
  src/server.js                 Web API、任务调度、扫描与剪辑流程
  src/scan_video_only.py        四种高光模板扫描与匹配
  src/lib/ffmpeg-engine.js      自动选择 NVENC/QSV/AMF/x264
  src/lib/native-folder-dialog.js Windows 原生置顶文件夹选择窗口
  src/lib/performance-profiler.js 设备性能探测与资源分配
  src/lib/resource-manager.js   自动/省资源/平衡/满性能策略
  src/lib/clipper.js            ffmpeg 裁剪
  src/lib/concat.js             片段拼接与最终导出
  src/lib/shotlog.js            击杀时间合并为镜头日志
  web/                          离线 Vue 网页界面
  templates/                    击杀、载具、精准击杀和救援模板

windows/
  src/DeltaHighlight.cs         托盘启动器
  src/DeltaHighlight.Setup.cs   单文件安装器
  src/Uninstall.cs              卸载程序
  manifests/                    Windows 兼容性和权限清单
  assets/app.ico                应用图标
```

## 2. 处理流程

1. 扫描素材目录中的视频。
2. 每隔 0.2 秒取一帧，只检查画面中央偏下区域。
3. 使用四种原始模板匹配白色击杀、载具击杀、精准击杀和救援标志。
4. 四种模板命中的事件全部记录为高光时间点。
5. 合并短时间内位置相近的重复检测，得到击杀时间点。
6. 击杀前后分别保留约 5 秒和 2 秒。
7. 间隔不超过 15 秒的击杀合并为同一片段。
8. 使用设备实测后选择的最佳 H.264 编码器裁剪和拼接。
9. 最终输出 MP4、H.264 High、AAC-LC、yuv420p、BT.709、faststart。
10. 使用 ffprobe 检查最终视频流，确认编码为 H.264。

## 3. 开发环境运行

要求：

- Node.js 22 或更高版本
- Python 3.12
- OpenCV Python
- NumPy
- ffmpeg 和 ffprobe

安装 Node 依赖：

```powershell
# 在仓库根目录执行
npm ci
```

配置：

```json
{
  "ffmpegPath": "ffmpeg",
  "pythonPath": "python",
  "outputDir": "./output",
  "materialDir": "",
  "port": 3456
}
```

启动：

```powershell
node src/server.js
```

浏览器访问 `http://localhost:3456`。

## 4. 编译 Windows 程序

使用 .NET Framework 4.x 自带的 `csc.exe`：

```powershell
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
```

编译托盘启动器：

```powershell
& $csc /nologo /target:winexe /optimize+ /platform:x64 `
  /out:DeltaHighlight.exe `
  /win32manifest:windows\manifests\DeltaHighlight.exe.manifest `
  /win32icon:windows\assets\app.ico `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  windows\src\DeltaHighlight.cs
```

编译卸载程序：

```powershell
& $csc /nologo /target:winexe /optimize+ /platform:x64 `
  /out:Uninstall.exe `
  /win32icon:windows\assets\app.ico `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  windows\src\Uninstall.cs
```

编译安装器 Stub：

```powershell
& $csc /nologo /target:winexe /optimize+ /platform:x64 `
  /out:DeltaHighlight.Setup.stub.exe `
  /win32manifest:windows\manifests\DeltaHighlight.Setup.exe.manifest `
  /win32icon:windows\assets\app.ico `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  /reference:System.IO.Compression.dll `
  /reference:System.IO.Compression.FileSystem.dll `
  windows\src\DeltaHighlight.Setup.cs
```

## 5. 组装 Windows 便携目录

目标目录结构：

```text
DeltaHighlight-Windows-Package-v2.0.9-Portable/
  DeltaHighlight.exe
  Uninstall.exe
  README-Windows.txt
  app/
    src/
    web/
    templates/
    node_modules/
    package.json
    config.json
  runtime/
    node/node.exe
    python/python.exe
    ffmpeg/ffmpeg.exe
    ffmpeg/ffprobe.exe
    ffmpeg/nvenc-manifest.json
    ffmpeg-nvenc-13.1/ffmpeg.exe
    ffmpeg-nvenc-13.1/ffprobe.exe
    ffmpeg-nvenc-13.1/nvenc-manifest.json
  material/
  output/
```

每个 `runtime/ffmpeg*` 目录可附带 `nvenc-manifest.json`。程序会扫描所有 ffmpeg 包，分别进行真实 NVENC 初始化测试；驱动低于 610 时优先 13.0，驱动 610 及以上时优先 13.1，首选包失败会自动尝试下一个包。

```json
{
  "label": "NVENC API 13.1",
  "nvencApiVersion": "13.1",
  "minimumDriverVersion": "610.0"
}
```

打包前确认：

- `app/package.json` 版本为 `2.0.9`。
- 公开版同时包含 NVENC API 13.0 和 13.1 两套 ffmpeg，实际启动时会逐包验证；两块都不可用时继续回退 QSV、AMF 或 x264。
- `app/web/vue.global.prod.js` 存在，网页不能依赖外部 CDN。
- `runtime` 中包含 Node、Python、OpenCV、NumPy、ffmpeg 和 ffprobe。
- 不包含 `app/work`、扫描缓存、测试视频和成品视频。

## 6. 生成 Payload

Payload 是便携目录根内容的 ZIP。ZIP 内部不能多一层目录，第一个条目应当类似：

```text
DeltaHighlight.exe
app/package.json
runtime/node/node.exe
material/
output/
```

必须保留 `material/` 和 `output/` 目录条目。

## 7. 生成单文件安装器

安装器由三部分组成：

```text
Setup Stub 原始字节
+ Payload ZIP 原始字节
+ 16 字节尾部
```

尾部格式：

```text
8 字节 ASCII: DFPAY001
8 字节 Int64: Payload 长度
```

最终大小：

```text
Stub 大小 + Payload 大小 + 16
```

安装器运行时从自身尾部读取 Payload 长度，再把 ZIP 解压到用户选择的安装目录。

## 8. 公开发布包

推荐同时生成：

- `DeltaHighlight-Windows-Installer-v2.0.9.exe`
- `DeltaHighlight-Payload.zip`
- `DeltaHighlight-Windows-Package-v2.0.9-Portable.zip`
- `DeltaHighlight-Setup-v2.0.9-OneClick.zip`
- `SHA256.txt`

公开前验证：

1. 对安装器、Payload、便携包和 OneClick 包计算 SHA256。
2. 检查安装器尾部 magic 和 Payload 长度。
3. 比较安装器内嵌 Payload 与外部 Payload 的 SHA256。
4. 解压便携包，确认 `app/package.json` 版本为 `2.0.9`。
5. 启动服务并确认 `/api/config` 返回 `videoCodecFamily=h264`。
6. 在浏览器打开资源窗口，确认四个档位和滑块可用。
7. 点击素材目录“浏览...”，确认 Windows 原生文件夹选择窗口弹出并保持置顶。
8. 使用 ffprobe 检查测试成片确实是 H.264 High、avc1、yuv420p、BT.709。
