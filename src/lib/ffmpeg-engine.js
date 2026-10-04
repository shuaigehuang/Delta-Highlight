/**
 * ffmpeg 运行环境与编码器引擎
 *
 * 探测内置 ffmpeg、配置路径和游戏自带 ffmpeg，并实际验证
 * NVENC / Quick Sync / AMF。硬件编码不可用时回退 libx264。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../config');

let cachedRuntime = null;
const mediaInfoCache = new Map();

const HARDWARE_ENCODERS = [
  { kind: 'nvenc', codec: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { kind: 'qsv', codec: 'h264_qsv', label: 'Intel Quick Sync' },
  { kind: 'amf', codec: 'h264_amf', label: 'AMD AMF' }
];

// 公开版只允许 H.264/AVC。即使外部调用误传 HEVC，也会安全归一化。
const H264_VIDEO_CODECS = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
const CODEC_ALIASES = new Map([
  ['hevc_nvenc', 'h264_nvenc'],
  ['hevc_qsv', 'h264_qsv'],
  ['hevc_amf', 'h264_amf'],
  ['libx265', 'libx264'],
  ['hevc', 'libx264'],
  ['h265', 'libx264']
]);

function normalizeVideoCodec(codec) {
  const value = String(codec || '').trim().toLowerCase();
  const mapped = CODEC_ALIASES.get(value) || value;
  return H264_VIDEO_CODECS.has(mapped) ? mapped : 'libx264';
}

function isH264VideoCodec(codec) {
  return H264_VIDEO_CODECS.has(String(codec || '').trim().toLowerCase());
}

function deriveFfprobePath(ffmpegPath) {
  return path.isAbsolute(ffmpegPath)
    ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
    : 'ffprobe';
}

function parseFrameRate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (!match || Number(match[2]) === 0) return 0;
  const fps = Number(match[1]) / Number(match[2]);
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function roundEven(value) {
  const integer = Math.max(2, Math.round(Number(value) || 0));
  return integer % 2 === 0 ? integer : integer + 1;
}

function resolveRateControl(options) {
  let sourceWidth = Number(options.sourceWidth || options.encodeWidth || 0);
  let sourceHeight = Number(options.sourceHeight || options.encodeHeight || 0);
  const fps = Number(options.sourceFps || options.fps || 0);

  if (options.scale && sourceWidth > 0 && sourceHeight > 0) {
    const outputHeight = Number(options.scale);
    if (outputHeight > 0) {
      const outputWidth = roundEven(sourceWidth * outputHeight / sourceHeight);
      sourceWidth = outputWidth;
      sourceHeight = roundEven(outputHeight);
    }
  }

  const explicit = Number(options.maxBitrateMbps || 0);
  if (explicit > 0) {
    const maxRateMbps = Math.round(explicit);
    return {
      maxRateMbps,
      bufferMbps: Math.max(maxRateMbps + 4, Math.round(Number(options.bufferSizeMbps) || maxRateMbps * 2))
    };
  }

  if (!sourceWidth || !sourceHeight || !fps) return null;

  const tier = options.qualityTier || 'original';
  const bitsPerPixel = tier === 'preview' ? 0.10 : (tier === 'fast' ? 0.10 : 0.14);
  const minRate = tier === 'preview' ? 2 : 6;
  const maxRateCap = tier === 'preview' ? 6 : (tier === 'fast' ? 60 : 100);
  const calculated = sourceWidth * sourceHeight * fps * bitsPerPixel / 1000000;
  const maxRateMbps = Math.round(Math.max(minRate, Math.min(maxRateCap, calculated)));

  return {
    maxRateMbps,
    bufferMbps: Math.round(maxRateMbps * 2)
  };
}

function appendRateControlArgs(args, rateControl) {
  args.push(
    '-maxrate', `${rateControl.maxRateMbps}M`,
    '-bufsize', `${rateControl.bufferMbps}M`
  );
}

function addCandidate(list, candidate) {
  if (!candidate) return;
  const resolved = path.isAbsolute(candidate) ? path.normalize(candidate) : candidate;
  if (!list.includes(resolved)) list.push(resolved);
}

function addGameFfmpegCandidates(list) {
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
  for (const drive of drives) {
    const railApps = path.join(drive + path.sep, 'WeGameApps', 'rail_apps');
    if (!fs.existsSync(railApps)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(railApps, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^DeltaForce/i.test(entry.name)) continue;
      addCandidate(list, path.join(
        railApps,
        entry.name,
        'icreate',
        'recorder-release',
        'ffmpeg.exe'
      ));
    }
  }
}

function buildVideoEncoderArgs(options = {}) {
  const codec = normalizeVideoCodec(options.videoCodec);
  const args = ['-c:v', codec];
  const rateControl = resolveRateControl(options);

  if (codec === 'h264_nvenc') {
    // 明确指定独显，避免双显卡机器被核显拖慢；同时默认单通道以吃满 NVENC。
    if (options.gpu !== undefined && options.gpu !== null) {
      args.push('-gpu', String(options.gpu));
    }
    args.push(
      '-preset', String(options.nvencPreset || options.preset || 'p4'),
      '-tune', String(options.nvencTune || 'hq'),
      '-rc', 'vbr',
      '-cq', String(options.cq !== undefined ? options.cq : 20),
      '-b:v', '0'
    );
    if (rateControl) appendRateControlArgs(args, rateControl);
    if (options.multipass && options.multipass !== 'disabled') {
      args.push('-multipass', String(options.multipass));
    }
    if (options.zerolatency) args.push('-zerolatency', '1');
    if (options.spatialAq) args.push('-spatial-aq', '1');
    if (options.temporalAq) args.push('-temporal-aq', '1');
    return args;
  }

  if (codec === 'h264_qsv') {
    args.push(
      '-preset', options.preset || 'fast',
      '-global_quality', String(options.cq !== undefined ? options.cq : options.crf || 23)
    );
    args.push('-b:v', '0');
    if (rateControl) appendRateControlArgs(args, rateControl);
    if (options.lookAhead) args.push('-look_ahead', '1');
    return args;
  }

  if (codec === 'h264_amf') {
    const quality = options.amfQuality || 'quality';
    const qp = options.cq !== undefined ? options.cq : (options.crf !== undefined ? options.crf : 20);
    args.push(
      '-quality', quality,
      '-rc', 'cqp',
      '-qp_i', String(qp),
      '-qp_p', String(qp + 2),
      '-qp_b', String(qp + 3)
    );
    if (rateControl) appendRateControlArgs(args, rateControl);
    return args;
  }

  args.push(
    '-crf', String(options.crf !== undefined ? options.crf : 18),
    '-preset', options.preset || 'fast',
    '-threads', String(options.threads !== undefined && options.threads !== null ? options.threads : 0)
  );
  if (rateControl) appendRateControlArgs(args, rateControl);
  return args;
}

function encoderWorks(ffmpegPath, codec) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=256x256:r=30:d=0.2',
    '-frames:v', '2',
    '-an',
    ...buildVideoEncoderArgs({ videoCodec: codec, cq: 28, crf: 28, nvencPreset: 'p4' }),
    '-f', 'null',
    '-'
  ];

  try {
    const result = spawnSync(ffmpegPath, args, {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8'
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function candidateExists(candidate) {
  return !path.isAbsolute(candidate) || fs.existsSync(candidate);
}

function detectNvidiaGpu() {
  try {
    const result = spawnSync('nvidia-smi', ['--query-gpu=index,name', '--format=csv,noheader,nounits'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 4000
    });
    if (result.status !== 0) return null;
    const first = String(result.stdout || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0];
    if (!first) return null;
    const parts = first.split(',');
    return { index: Number(parts[0] || 0), name: (parts[1] || 'NVIDIA GPU').trim() };
  } catch (_) {
    return null;
  }
}

function getFfmpegRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const configured = getFfmpegPath();
  const candidates = [];

  // 随包 ffmpeg 永远优先：避免旧 config.json 或系统里的旧安装把新版拖回老编码器。
  const bundled = path.resolve(__dirname, '..', '..', 'runtime', 'ffmpeg', 'ffmpeg.exe');
  addCandidate(candidates, bundled);
  addCandidate(candidates, process.env.DF_FFMPEG_PATH);
  addCandidate(candidates, configured);
  addGameFfmpegCandidates(candidates);

  const nvidiaGpu = detectNvidiaGpu();
  let ffmpegPath = candidates.find(candidateExists) || configured;
  let hardware = 'none';
  let videoCodec = 'libx264';
  let encoderLabel = 'CPU x264';

  for (const candidate of candidates) {
    if (!candidateExists(candidate)) continue;
    for (const encoder of HARDWARE_ENCODERS) {
      if (encoderWorks(candidate, encoder.codec)) {
        ffmpegPath = candidate;
        hardware = encoder.kind;
        videoCodec = encoder.codec;
        encoderLabel = encoder.label;
        break;
      }
    }
    if (hardware !== 'none') break;
  }

  cachedRuntime = {
    ffmpegPath,
    ffprobePath: deriveFfprobePath(ffmpegPath),
    hardware,
    encoderLabel,
    videoCodec,
    gpuIndex: nvidiaGpu ? nvidiaGpu.index : null,
    gpuName: nvidiaGpu ? nvidiaGpu.name : ''
  };

  return cachedRuntime;
}

function probeMediaInfo(filePath, options = {}) {
  const cacheKey = path.resolve(filePath);
  if (!options.refresh && mediaInfoCache.has(cacheKey)) return mediaInfoCache.get(cacheKey);

  const pending = new Promise((resolve, reject) => {
    const runtime = getFfmpegRuntime();
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,channel_layout',
      '-of', 'json',
      cacheKey
    ];
    const child = spawnSync(runtime.ffprobePath, args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024
    });

    if (child.error) return reject(child.error);
    if (child.status !== 0) {
      return reject(new Error(`ffprobe failed: ${String(child.stderr || '').slice(-300)}`));
    }

    try {
      const parsed = JSON.parse(child.stdout || '{}');
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const video = streams.find(stream => stream.codec_type === 'video');
      if (!video || !Number(video.width) || !Number(video.height)) {
        throw new Error(`未找到可用的视频流: ${cacheKey}`);
      }

      const rFrameRate = String(video.r_frame_rate || '');
      const avgFrameRate = String(video.avg_frame_rate || '');
      const rFps = parseFrameRate(rFrameRate);
      const avgFps = parseFrameRate(avgFrameRate);
      const fps = rFps || avgFps || 60;
      const fpsString = rFps ? rFrameRate : (avgFps ? avgFrameRate : '60/1');
      const audio = streams.find(stream => stream.codec_type === 'audio') || null;

      resolve({
        video: {
          codecName: String(video.codec_name || '').toLowerCase(),
          profile: String(video.profile || ''),
          level: Number(video.level || 0),
          pixFmt: String(video.pix_fmt || '').toLowerCase(),
          colorRange: String(video.color_range || '').toLowerCase(),
          colorSpace: String(video.color_space || '').toLowerCase(),
          colorTransfer: String(video.color_transfer || '').toLowerCase(),
          colorPrimaries: String(video.color_primaries || '').toLowerCase(),
          width: Number(video.width),
          height: Number(video.height),
          fps,
          fpsString,
          rFrameRate,
          avgFrameRate
        },
        audio: audio ? {
          codecName: String(audio.codec_name || '').toLowerCase(),
          profile: String(audio.profile || ''),
          sampleRate: Number(audio.sample_rate || 0),
          channels: Number(audio.channels || 0),
          channelLayout: String(audio.channel_layout || '').toLowerCase()
        } : null,
        hasAudio: !!audio
      });
    } catch (err) {
      reject(err);
    }
  });

  mediaInfoCache.set(cacheKey, pending);
  pending.catch(() => mediaInfoCache.delete(cacheKey));
  return pending;
}

async function verifyH264Output(filePath) {
  const info = await probeMediaInfo(filePath, { refresh: true });
  if (info.video.codecName !== 'h264') {
    throw new Error(`输出编码不符合公开发布要求: ${info.video.codecName || 'unknown'}，应为 h264`);
  }
  return info;
}

module.exports = {
  getFfmpegRuntime,
  buildVideoEncoderArgs,
  probeMediaInfo,
  verifyH264Output,
  normalizeVideoCodec,
  isH264VideoCodec,
  H264_VIDEO_CODECS,
  deriveFfprobePath
};
