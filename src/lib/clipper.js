/**
 * 视频裁剪工具 (Clipper)
 *
 * 根据镜头日志，使用 ffmpeg 从原视频中裁剪片段。
 * 支持 GPU 硬件加速 (NVIDIA NVENC)。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getFfmpegRuntime, buildVideoEncoderArgs, probeMediaInfo, verifyH264Output } = require('./ffmpeg-engine');
const { attachFfmpegProgress } = require('./ffmpeg-progress');

const FFMPEG_RUNTIME = getFfmpegRuntime();
const FFMPEG_PATH = FFMPEG_RUNTIME.ffmpegPath;

const FFPROBE_PATH = FFMPEG_RUNTIME.ffprobePath;

const DEFAULT_CLIP_OPTIONS = {
  videoCodec: 'libx264',     // 或 'h264_nvenc' 用于 GPU 加速
  audioCodec: 'aac',
  crf: 18,                    // 质量 (0-51, 越小越好, 18=视觉无损)
  preset: 'medium',           // 'fast' 更快, 'slow' 更小
  pixelFormat: 'yuv420p',    // 兼容性
  outputFormat: 'mp4'
};

/**
 * 获取视频时长 (秒)
 */
function getDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      videoPath
    ];

    const ffprobe = spawn(FFPROBE_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    ffprobe.stdout.on('data', d => { stdout += d.toString(); });

    ffprobe.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed`));
        return;
      }
      resolve(parseFloat(stdout.trim()));
    });

    ffprobe.on('error', reject);
  });
}

/**
 * 裁剪单个视频片段
 *
 * @param {string} sourcePath - 原视频路径
 * @param {number} start - 开始秒数
 * @param {number} end - 结束秒数
 * @param {string} outputPath - 输出路径
 * @param {object} options - ffmpeg 编码选项
 * @returns {Promise<string>} 输出文件路径
 */
async function clipSegment(sourcePath, start, end, outputPath, options = {}) {
  const opts = { ...DEFAULT_CLIP_OPTIONS, ...options };
  const duration = end - start;
  const mediaInfo = await probeMediaInfo(sourcePath);
  const sourceVideo = mediaInfo.video;

  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const args = [
      '-ss', String(start),
      '-i', sourcePath,
      '-t', String(duration),
      '-map', '0:v:0',
      '-map', '0:a?',
      ...buildVideoEncoderArgs({
        ...opts,
        sourceWidth: sourceVideo.width,
        sourceHeight: sourceVideo.height,
        sourceFps: sourceVideo.fps
      }),
      '-c:a', opts.audioCodec,
      '-b:a', '192k',
      '-pix_fmt', opts.pixelFormat,
    ];

    // 缩放 (如 360P 预览模式)
    const scaleFilter = opts.scale
      ? `scale=-2:${Number(opts.scale)}:flags=bicubic:in_range=auto:out_range=tv`
      : 'scale=iw:ih:flags=bicubic:in_range=auto:out_range=tv';
    args.push('-vf', scaleFilter + ',setsar=1,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709');
    if (mediaInfo.hasAudio) args.push('-af', 'aresample=48000:async=1:first_pts=0');

    args.push(
      '-r', sourceVideo.fpsString,
      '-fps_mode', 'cfr',
      '-avoid_negative_ts', 'make_zero',
      '-tag:v', 'avc1',
      ...(typeof opts.onProgress === 'function' ? ['-progress', 'pipe:1', '-nostats'] : []),
      '-y',                        // 覆盖已存在的文件
      outputPath
    );

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    attachFfmpegProgress(ffmpeg, {
      totalSeconds: duration,
      onProgress: opts.onProgress
    });

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', async code => {
      if (code !== 0) {
        if (opts.videoCodec !== 'libx264' && !opts._fallback) {
          console.log('   ⚠️ 硬件裁剪失败，自动回退 CPU 编码...');
          clipSegment(sourcePath, start, end, outputPath, {
            ...opts,
            videoCodec: 'libx264',
            crf: opts.crf !== undefined ? opts.crf : 18,
            preset: opts.preset || 'fast',
            _fallback: true
          }).then(resolve, reject);
          return;
        }
        reject(new Error(`ffmpeg clip failed (code ${code}): ${stderr.slice(-300)}`));
        return;
      }
      await verifyH264Output(outputPath);
      resolve(outputPath);
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * 根据 shotlog 批量裁剪
 *
 * @param {object} shotlog - 镜头日志
 * @param {string} sourceDir - 原视频所在目录
 * @param {string} outputDir - 输出目录
 * @param {object} options - ffmpeg 编码选项
 * @returns {Promise<object[]>} 裁剪结果列表
 */
async function clipAll(shotlog, sourceDir, outputDir, options = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const results = [];
  const total = shotlog.clips.length;

  for (let i = 0; i < shotlog.clips.length; i++) {
    const clip = shotlog.clips[i];
    const sourcePath = path.join(sourceDir, clip.sourceFile);

    // 检查源文件是否存在
    if (!fs.existsSync(sourcePath)) {
      console.log(`   ⚠️  [${i + 1}/${total}] 源文件不存在: ${clip.sourceFile}`);
      results.push({ ...clip, status: 'skipped', reason: 'source not found' });
      continue;
    }

    const ext = options.outputFormat || DEFAULT_CLIP_OPTIONS.outputFormat;
    const outputName = `${path.parse(clip.sourceFile).name}_clip_${fmtTimeFile(clip.clipStart)}-${fmtTimeFile(clip.clipEnd)}.${ext}`;
    const outputPath = path.join(outputDir, outputName);

    console.log(`   🎬 [${i + 1}/${total}] ${formatTimestamp(clip.clipStart)} → ${formatTimestamp(clip.clipEnd)}  (${clip.duration.toFixed(1)}s)  ← ${clip.sourceFile}`);

    try {
      await clipSegment(sourcePath, clip.clipStart, clip.clipEnd, outputPath, options);
      const stat = fs.statSync(outputPath);
      console.log(`      ✅ 完成  ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
      results.push({ ...clip, outputFile: outputPath, status: 'ok', sizeBytes: stat.size });
    } catch (err) {
      console.log(`      ❌ 失败: ${err.message}`);
      results.push({ ...clip, status: 'error', error: err.message });
    }
  }

  return results;
}

/**
 * 格式化时间戳为文件名友好的格式
 */
function fmtTimeFile(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s${String(ms).padStart(2, '0')}`;
}

/**
 * 格式化时间戳为 MM:SS.ms
 */
function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(4, '0')}`;
}

module.exports = { clipSegment, clipAll, getDuration, FFMPEG_PATH, DEFAULT_CLIP_OPTIONS };
