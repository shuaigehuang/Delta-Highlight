/**
 * 视频拼接工具 (Concat)
 *
 * 使用 ffmpeg concat demuxer 将裁剪后的片段拼接为最终集锦视频。
 * 所有片段必须使用相同的编码格式和分辨率。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  getFfmpegRuntime,
  buildVideoEncoderArgs,
  probeMediaInfo,
  verifyH264Output
} = require('./ffmpeg-engine');
const { attachFfmpegProgress } = require('./ffmpeg-progress');

const FFMPEG_RUNTIME = getFfmpegRuntime();
const FFMPEG_PATH = FFMPEG_RUNTIME.ffmpegPath;

const DEFAULT_CONCAT_OPTIONS = {
  videoCodec: 'libx264',
  audioCodec: 'aac',
  crf: 18,
  preset: 'medium',
  pixelFormat: 'yuv420p',
  outputFormat: 'mp4',
  // 转场: 0=无转场, >0=交叉淡入淡出帧数
  transitionFrames: 0
};

function formatFilterNumber(value) {
  return (Math.round(Number(value) * 1000) / 1000).toFixed(3);
}

function buildCompatibilityVideoFilter(height) {
  const scale = height
    ? `scale=-2:${Number(height)}:flags=bicubic:in_range=auto:out_range=tv`
    : 'scale=iw:ih:flags=bicubic:in_range=auto:out_range=tv';
  return `${scale},setsar=1,format=yuv420p,` +
    'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
}

/**
 * 拼接视频片段
 *
 * @param {string[]} clipPaths - 裁剪后的片段路径列表 (按顺序)
 * @param {string} outputPath - 输出集锦视频路径
 * @param {object} options - 编码选项
 * @returns {Promise<string>} 输出路径
 */
async function concatClips(clipPaths, outputPath, options = {}) {
  const opts = { ...DEFAULT_CONCAT_OPTIONS, ...options };

  // 过滤掉不存在的文件
  const validPaths = clipPaths.filter(p => fs.existsSync(p));
  if (validPaths.length === 0) {
    throw new Error('没有有效的视频文件可拼接');
  }

  if (validPaths.length === 1) {
    await verifyH264Output(validPaths[0]);
    // 只有一个文件，直接复制
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(validPaths[0], outputPath);
    console.log(`   📋 只有一个片段，直接复制到 ${outputPath}`);
    return outputPath;
  }

  const mediaInfo = opts.streamCopy ? null : await probeMediaInfo(validPaths[0]);
  const sourceVideo = mediaInfo ? mediaInfo.video : null;

  // 创建 concat 文件列表
  const listPath = outputPath + '.concat.txt';
  const listContent = validPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent, 'utf-8');

  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-fflags', '+genpts',
      '-thread_queue_size', '1024',
      '-i', listPath,
    ];

    if (opts.streamCopy) {
      args.push(
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero'
      );
    } else {
      args.push(
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
        '-pix_fmt', opts.pixelFormat
      );
    }

    // 缩放 (如 360P 预览模式)
    if (!opts.streamCopy) {
      args.push('-vf', buildCompatibilityVideoFilter(opts.scale));
    }

    if (!opts.streamCopy) {
      if (mediaInfo.hasAudio) args.push('-af', 'aresample=48000:async=1:first_pts=0');
      args.push(
        '-r', sourceVideo.fpsString,
        '-fps_mode', 'cfr',
        '-avoid_negative_ts', 'make_zero'
      );
    }

    args.push(
      ...(typeof opts.onProgress === 'function' ? ['-progress', 'pipe:1', '-nostats'] : []),
      '-max_muxing_queue_size', '4096',
      '-tag:v', 'avc1',
      '-movflags', '+faststart',
      '-y',
      outputPath
    );

    console.log(`   🧩 拼接 ${validPaths.length} 个片段...`);

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    attachFfmpegProgress(ffmpeg, {
      totalSeconds: Number(opts.totalDuration) || 0,
      onProgress: opts.onProgress
    });

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', async code => {
      // 清理临时列表文件
      try { fs.unlinkSync(listPath); } catch (_) {}

      if (code !== 0) {
        if (opts.streamCopy) {
          console.log('   ⚠️ 无损拼接失败，自动回退到重新编码...');
          concatClips(validPaths, outputPath, { ...opts, streamCopy: false })
            .then(resolve, reject);
          return;
        }
        if (opts.videoCodec !== 'libx264' && !opts._fallback) {
          console.log('   ⚠️ 硬件编码拼接失败，自动回退 CPU 编码...');
          concatClips(validPaths, outputPath, {
            ...opts,
            videoCodec: 'libx264',
            crf: opts.crf !== undefined ? opts.crf : 18,
            preset: opts.preset || 'fast',
            _fallback: true
          }).then(resolve, reject);
          return;
        }
        reject(new Error(`ffmpeg concat failed (code ${code}): ${stderr.slice(-300)}`));
        return;
      }

      const stat = fs.statSync(outputPath);
      const info = await verifyH264Output(outputPath);
      console.log(`   ✅ 集锦完成! ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${outputPath}`);
      console.log(`   ✅ 公开发布兼容格式: H.264/${info.video.profile || 'High'} + AAC`);
      resolve(outputPath);
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * 使用 ffmpeg concat demuxer 直接从源视频生成集锦（跳过中间裁剪步骤）。
 *
 * 利用 inpoint/outpoint 指定每个源视频的裁剪范围，
 * ffmpeg 一次性读取所有源视频，单次编码直出成品。
 *
 * @param {object} shotlog - 镜头日志
 * @param {string} sourceDir - 源视频所在目录
 * @param {string} outputPath - 输出集锦视频路径
 * @param {object} options - 编码选项
 * @returns {Promise<string>} 输出路径
 */
async function concatClipsDirectLegacy(shotlog, sourceDir, outputPath, options = {}) {
  const opts = { ...DEFAULT_CONCAT_OPTIONS, ...options };
  // 过滤掉 duration=0 的片段（无击杀且未手动设置范围的）
  const clips = (shotlog.clips || []).filter(c => c.clipEnd > c.clipStart);

  if (clips.length === 0) {
    throw new Error('镜头日志中没有有效片段（所有片段时长为 0）');
  }

  const totalDuration = clips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // 构建 ffconcat 格式的列表
  let listContent = 'ffconcat version 1.0\n';
  for (const clip of clips) {
    const sourcePath = path.join(sourceDir, clip.sourceFile);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`源视频不存在: ${clip.sourceFile}`);
    }
    // 使用正斜杠避免 ffmpeg 路径转义问题
    const safePath = sourcePath.replace(/\\/g, '/');
    listContent += `file '${safePath}'\n`;
    listContent += `inpoint ${clip.clipStart}\n`;
    listContent += `outpoint ${clip.clipEnd}\n`;
  }

  const listPath = outputPath + '.ffconcat';
  fs.writeFileSync(listPath, listContent, 'utf-8');

  return new Promise((resolve, reject) => {

    const hasMusic = opts.music && opts.music.path && fs.existsSync(opts.music.path);

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-fflags', '+genpts',
      '-thread_queue_size', '1024',
      '-i', listPath,
    ];

    // 背景音乐输入 (无限循环)
    if (hasMusic) {
      args.push('-stream_loop', '-1', '-i', opts.music.path);
    }

    args.push(...buildVideoEncoderArgs(opts));

    // 缩放 (如 360P 预览模式)
    if (opts.scale) {
      args.push('-vf', `scale=-2:${opts.scale}`);
    }

    if (hasMusic) {
      // 音频混合: 原视频音量 + 音乐音量 → amix
      const origDb = opts.music.originalDb || 0;
      const musicDb = opts.music.musicDb !== undefined ? opts.music.musicDb : -10;
      const fadeSeconds = Math.min(2, totalDuration);
      const fadeStart = Math.max(0, totalDuration - fadeSeconds);
      args.push(
        '-filter_complex',
        `[0:a]volume=${origDb}dB[va];[1:a]volume=${musicDb}dB,afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeSeconds.toFixed(3)}[ma];[va][ma]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
        '-c:a', opts.audioCodec,
        '-b:a', '192k'
      );
    } else {
      args.push('-map', '0:v:0', '-map', '0:a?', '-c:a', opts.audioCodec, '-b:a', '192k');
    }

    args.push(
      ...(typeof opts.onProgress === 'function' ? ['-progress', 'pipe:1', '-nostats'] : []),
      '-pix_fmt', opts.pixelFormat,
      '-fps_mode', 'passthrough',
      '-max_muxing_queue_size', '4096',
      '-movflags', '+faststart',
      '-y',
      outputPath
    );

    console.log(`   ⚡ 直出模式: ${clips.length} 个片段 → 单次编码${hasMusic ? ' + 背景音乐' : ''}`);

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    attachFfmpegProgress(ffmpeg, {
      totalSeconds: totalDuration,
      onProgress: opts.onProgress
    });

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', code => {
      try { fs.unlinkSync(listPath); } catch (_) {}

      if (code !== 0) {
        if (opts.videoCodec !== 'libx264' && !opts._fallback) {
          console.log('   ⚠️ 硬件编码直出失败，自动回退 CPU 编码...');
          concatClipsDirect(shotlog, sourceDir, outputPath, {
            ...opts,
            videoCodec: 'libx264',
            crf: opts.crf !== undefined ? opts.crf : 18,
            preset: opts.preset || 'medium',
            _fallback: true
          }).then(resolve, reject);
          return;
        }
        reject(new Error(`ffmpeg direct concat failed (code ${code}): ${stderr.slice(-300)}`));
        return;
      }

      const stat = fs.statSync(outputPath);
      console.log(`   ✅ 集锦完成! ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${outputPath}`);
      resolve(outputPath);
    });

    ffmpeg.on('error', reject);
  });
}


/**
 * 精确定位每个片段后重建连续时间轴。
 * 不再使用 ffconcat inpoint/outpoint，避免每段多出接近一个 GOP 的画面。
 */
async function concatClipsDirect(shotlog, sourceDir, outputPath, options = {}) {
  const opts = { ...DEFAULT_CONCAT_OPTIONS, ...options };
  const clips = (shotlog.clips || [])
    .filter(c => c.clipEnd > c.clipStart)
    .map(clip => ({
      ...clip,
      sourcePath: path.join(sourceDir, clip.sourceFile),
      duration: Math.max(0, Number(clip.clipEnd) - Number(clip.clipStart))
    }));

  if (clips.length === 0) {
    throw new Error('镜头日志中没有有效片段（所有片段时长为 0）');
  }

  for (const clip of clips) {
    if (!fs.existsSync(clip.sourcePath)) {
      throw new Error(`源视频不存在: ${clip.sourceFile}`);
    }
  }

  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const mediaInfos = await Promise.all(clips.map(clip => probeMediaInfo(clip.sourcePath)));
  const primaryVideo = mediaInfos[0].video;
  const outputFps = primaryVideo.fpsString || '60/1';
  const hasMusic = opts.music && opts.music.path && fs.existsSync(opts.music.path);

  const inputArgs = [];
  const filterParts = [];
  const concatInputs = [];
  let nextInputIndex = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const mediaInfo = mediaInfos[i];
    const duration = formatFilterNumber(clip.duration);
    const start = formatFilterNumber(clip.clipStart);

    inputArgs.push(
      '-thread_queue_size', '1024',
      '-ss', start,
      '-t', duration,
      '-i', clip.sourcePath
    );
    const videoIndex = nextInputIndex++;

    let audioIndex;
    if (mediaInfo.hasAudio) {
      audioIndex = videoIndex;
    } else {
      inputArgs.push(
        '-thread_queue_size', '1024',
        '-f', 'lavfi',
        '-t', duration,
        '-i', 'anullsrc=r=48000:cl=stereo'
      );
      audioIndex = nextInputIndex++;
    }

    const videoLabel = `v${i}`;
    const audioLabel = `a${i}`;
    const scaleFilter = opts.scale
      ? `,scale=-2:${Number(opts.scale)}:flags=bicubic,setsar=1`
      : ',setsar=1';

    filterParts.push(
      `[${videoIndex}:v]trim=start=0:duration=${duration},` +
      `setpts=PTS-STARTPTS${scaleFilter},fps=${outputFps}[${videoLabel}]`
    );

    filterParts.push(
      `[${audioIndex}:a]atrim=start=0:duration=${duration},` +
      'asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,' +
      `aformat=sample_fmts=fltp:channel_layouts=stereo[${audioLabel}]`
    );

    concatInputs.push(`[${videoLabel}][${audioLabel}]`);
  }

  filterParts.push(
    `${concatInputs.join('')}concat=n=${clips.length}:v=1:a=1[vcat][acat]`
  );

  filterParts.push(
    '[vcat]' + buildCompatibilityVideoFilter(null) + '[vout]'
  );

  let mapVideo = '[vout]';
  let mapAudio = '[acat]';

  if (hasMusic) {
    inputArgs.push('-stream_loop', '-1', '-i', opts.music.path);
    const musicIndex = nextInputIndex++;
    const originalDb = Number(opts.music.originalDb || 0);
    const musicDb = opts.music.musicDb !== undefined ? Number(opts.music.musicDb) : -10;
    const fadeSeconds = Math.min(2, totalDuration);
    const fadeStart = Math.max(0, totalDuration - fadeSeconds);

    filterParts.push(
      `[${musicIndex}:a]volume=${originalDb}dB,` +
      `atrim=start=0:duration=${formatFilterNumber(totalDuration)},` +
      'asetpts=PTS-STARTPTS,' +
      `afade=t=out:st=${formatFilterNumber(fadeStart)}:d=${formatFilterNumber(fadeSeconds)},` +
      'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[music]'
    );
    filterParts.push(
      `[acat][music]volume=${musicDb}dB,` +
      'amix=inputs=2:duration=first:dropout_transition=2,' +
      'aresample=48000:async=1:first_pts=0[aout]'
    );
    mapAudio = '[aout]';
  }

  const args = [
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    ...buildVideoEncoderArgs({
      ...opts,
      sourceWidth: primaryVideo.width,
      sourceHeight: primaryVideo.height,
      sourceFps: primaryVideo.fps
    }),
    '-map', mapVideo,
    '-map', mapAudio,
    '-c:a', opts.audioCodec,
    '-b:a', '192k',
    '-pix_fmt', opts.pixelFormat,
    '-r', outputFps,
    '-fps_mode', 'cfr',
    '-max_muxing_queue_size', '4096',
    '-avoid_negative_ts', 'make_zero',
    '-tag:v', 'avc1',
    '-movflags', '+faststart',
    ...(typeof opts.onProgress === 'function' ? ['-progress', 'pipe:1', '-nostats'] : []),
    '-y',
    outputPath
  ];

  return new Promise((resolve, reject) => {
    console.log(`   ⚡ 直出模式: ${clips.length} 个片段 → 单次编码${hasMusic ? ' + 背景音乐' : ''}`);

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    attachFfmpegProgress(ffmpeg, {
      totalSeconds: totalDuration,
      onProgress: opts.onProgress
    });

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', async code => {
      if (code !== 0) {
        if (opts.videoCodec !== 'libx264' && !opts._fallback) {
          console.log('   ⚠️ 硬件编码直出失败，自动回退 CPU 编码...');
          concatClipsDirect(shotlog, sourceDir, outputPath, {
            ...opts,
            videoCodec: 'libx264',
            crf: opts.crf !== undefined ? opts.crf : 18,
            preset: opts.preset || 'medium',
            _fallback: true
          }).then(resolve, reject);
          return;
        }
        reject(new Error(`ffmpeg direct concat failed (code ${code}): ${stderr.slice(-500)}`));
        return;
      }

      const stat = fs.statSync(outputPath);
      const info = await verifyH264Output(outputPath);
      console.log(`   ✅ 集锦完成! ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${outputPath}`);
      console.log(`   ✅ 公开发布兼容格式: H.264/${info.video.profile || 'High'} + AAC`);
      resolve(outputPath);
    });

    ffmpeg.on('error', reject);
  });
}
module.exports = { concatClips, concatClipsDirect, DEFAULT_CONCAT_OPTIONS };
