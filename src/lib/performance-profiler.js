/**
 * 设备性能探测与自动调优
 *
 * 首次运行会对当前 ffmpeg 支持的编码器做短视频基准测试，然后根据
 * CPU、内存和磁盘结果生成推荐参数。档案缓存在 work/ 下，硬件或
 * ffmpeg 变化后会自动重新探测。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, loadConfig } = require('../config');
const {
  getFfmpegRuntime,
  buildVideoEncoderArgs,
  deriveFfprobePath,
  isH264VideoCodec
} = require('./ffmpeg-engine');

const PROFILE_VERSION = 6;
const PROFILE_CACHE = path.join(ROOT, 'work', 'performance-profile.json');
const BENCHMARK_SECONDS = 2;
const BENCHMARK_FPS = 30;
const BENCHMARK_FRAMES = BENCHMARK_SECONDS * BENCHMARK_FPS;

let cachedProfile = null;
let activeProbe = null;

const ENCODER_CANDIDATES = [
  {
    kind: 'nvenc',
    label: 'NVIDIA NVENC',
    codec: 'h264_nvenc',
    options: {
      videoCodec: 'h264_nvenc',
      cq: 24,
      nvencPreset: 'p4',
      multipass: 'disabled',
      spatialAq: 0,
      temporalAq: 0
    }
  },
  {
    kind: 'qsv',
    label: 'Intel Quick Sync',
    codec: 'h264_qsv',
    options: {
      videoCodec: 'h264_qsv',
      cq: 24,
      preset: 'veryfast'
    }
  },
  {
    kind: 'amf',
    label: 'AMD AMF',
    codec: 'h264_amf',
    options: {
      videoCodec: 'h264_amf',
      cq: 24,
      amfQuality: 'speed'
    }
  },
  {
    kind: 'x264',
    label: 'CPU x264',
    codec: 'libx264',
    options: {
      videoCodec: 'libx264',
      crf: 24,
      preset: 'veryfast'
    }
  }
];

function ensureParent(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function findCommand(command) {
  const result = spawnSync('where.exe', [command], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 3000
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
}

function runCapture(file, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        elapsedMs: Date.now() - started,
        stdout,
        stderr
      });
    };

    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return finish({ ok: false, code: -1, error: err.message });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, code: -1, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => finish({ ok: false, code: -1, error: err.message }));
    child.on('close', code => finish({ ok: code === 0, code }));
  });
}

function fileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) {
    return 'missing';
  }
}

function getCpuInfo() {
  const cpus = os.cpus();
  const model = cpus.length ? cpus[0].model.trim() : 'Unknown CPU';
  return {
    model,
    logicalProcessors: cpus.length,
    speedMHz: cpus.length ? cpus[0].speed : 0
  };
}

function getMemoryInfo() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    totalGB: Number((totalBytes / 1024 / 1024 / 1024).toFixed(1)),
    freeGB: Number((freeBytes / 1024 / 1024 / 1024).toFixed(1))
  };
}

async function getGpuInfo() {
  const nvidiaSmi = findCommand('nvidia-smi');
  if (nvidiaSmi) {
    const result = await runCapture(nvidiaSmi, [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ], 5000);
    if (result.ok && result.stdout.trim()) {
      return result.stdout.trim().split(/\r?\n/).map(line => {
        const parts = line.split(',').map(s => s.trim());
        return {
          vendor: 'NVIDIA',
          name: parts[0] || 'NVIDIA GPU',
          memoryMB: Number(parts[1] || 0),
          driver: parts[2] || ''
        };
      });
    }
  }

  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "`n"'
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000
    });
    if (result.status === 0 && String(result.stdout || '').trim()) {
      return String(result.stdout)
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(name => ({ vendor: '', name, memoryMB: 0, driver: '' }));
    }
  }

  return [];
}

function listSupportedEncoders(ffmpegPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const found = {};
  for (const candidate of ENCODER_CANDIDATES) {
    const pattern = new RegExp(`\\s${candidate.codec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`);
    found[candidate.codec] = pattern.test(text);
  }
  return found;
}

function getFfmpegVersion(ffmpegPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000
  });
  const match = `${result.stdout || ''}`.match(/ffmpeg version\s+([^\s]+)/i);
  return match ? match[1] : 'unknown';
}

function benchmarkOptions(candidate) {
  const options = { ...candidate.options };
  if (options.videoCodec === 'h264_nvenc') {
    const gpuIndex = getFfmpegRuntime().gpuIndex;
    if (gpuIndex !== null && gpuIndex !== undefined) options.gpu = gpuIndex;
  }
  return options;
}

async function benchmarkEncoder(ffmpegPath, candidate) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${BENCHMARK_SIZE}:rate=${BENCHMARK_FPS}:duration=${BENCHMARK_SECONDS}`,
    '-an',
    ...buildVideoEncoderArgs(benchmarkOptions(candidate)),
    '-f', 'null',
    '-'
  ];

  const result = await runCapture(ffmpegPath, args, 20000);
  const elapsedSeconds = Math.max(0.001, result.elapsedMs / 1000);
  const fps = result.ok ? Number((BENCHMARK_FRAMES / elapsedSeconds).toFixed(2)) : 0;
  return {
    codec: candidate.codec,
    kind: candidate.kind,
    label: candidate.label,
    ok: result.ok,
    fps,
    elapsedMs: result.elapsedMs,
    error: result.ok ? '' : String(result.stderr || result.error || '').slice(-300)
  };
}

async function benchmarkDisk() {
  const workDir = path.join(ROOT, 'work');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const testFile = path.join(workDir, `.df-disk-${process.pid}-${Date.now()}.bin`);
  const size = 12 * 1024 * 1024;
  const buffer = Buffer.alloc(size, 0x5a);

  try {
    let started = Date.now();
    await fs.promises.writeFile(testFile, buffer);
    const writeMBps = size / 1024 / 1024 / Math.max(0.001, (Date.now() - started) / 1000);

    started = Date.now();
    await fs.promises.readFile(testFile);
    const readMBps = size / 1024 / 1024 / Math.max(0.001, (Date.now() - started) / 1000);

    return {
      writeMBps: Number(writeMBps.toFixed(1)),
      readMBps: Number(readMBps.toFixed(1))
    };
  } catch (err) {
    return { writeMBps: 0, readMBps: 0, error: err.message };
  } finally {
    try { await fs.promises.unlink(testFile); } catch (_) {}
  }
}

function recommendedScanWorkers(system) {
  const logical = system.cpu.logicalProcessors;
  const memory = system.memory.totalGB;
  const readSpeed = system.disk.readMBps;

  let workers = 1;
  if (logical >= 6) workers = 2;
  if (logical >= 10) workers = 3;
  if (logical >= 14) workers = 4;
  if (memory < 8) workers = Math.min(workers, 2);
  if (memory < 4) workers = 1;
  if (readSpeed > 0 && readSpeed < 120) workers = 1;
  else if (readSpeed > 0 && readSpeed < 250) workers = Math.min(workers, 2);

  return Math.max(1, Math.min(4, workers));
}

function recommendProfile(system, ffmpeg, benchmarkResults) {
  const working = benchmarkResults.filter(item => item.ok && item.fps > 0);
  if (!working.length) {
    const fallback = benchmarkResults.find(item => item.kind === 'x264') || ENCODER_CANDIDATES[3];
    return {
      encoder: fallback.codec,
      encoderKind: fallback.kind,
      encoderLabel: fallback.label,
      videoCodecFamily: 'h264',
      videoCodecLabel: 'H.264 / AVC',
      encoderFps: 0,
      scanWorkers: recommendedScanWorkers(system),
      encodeConcurrency: 1,
      originalTier: 'balanced',
      reason: '未找到可用硬件编码，使用 CPU 回退'
    };
  }

  const hardware = working.filter(item => item.kind !== 'x264' && item.fps >= HARDWARE_MIN_FPS);
  // 硬件编码可用且达到最低速度时优先硬件：4K 原画下能显著降低 CPU 占用，
  // 再由实测帧率决定原画质量档位。
  const pool = hardware.length ? hardware : working;
  pool.sort((a, b) => b.fps - a.fps);
  const best = pool[0];
  const tier = best.fps >= 100 ? 'high' : (best.fps >= 40 ? 'balanced' : 'safe');
  const encodeConcurrency = best.kind === 'x264' && system.cpu.logicalProcessors >= 12 ? 2 : 1;

  return {
    encoder: best.codec,
    encoderKind: best.kind,
    encoderLabel: best.label,
    videoCodecFamily: 'h264',
    videoCodecLabel: 'H.264 / AVC',
    encoderFps: best.fps,
    scanWorkers: recommendedScanWorkers(system),
    encodeConcurrency,
    originalTier: tier,
    reason: `实测 ${best.label} 约 ${best.fps.toFixed(1)} fps`
  };
}

function buildPerformanceProfile(system, ffmpeg, benchmarkResults) {
  const recommended = recommendProfile(system, ffmpeg, benchmarkResults);
  return {
    profileVersion: PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    signature: {
      cpu: system.cpu.model,
      logicalProcessors: system.cpu.logicalProcessors,
      totalMemoryGB: system.memory.totalGB,
      ffmpegPath: ffmpeg.path,
      ffmpegFingerprint: fileFingerprint(ffmpeg.path)
    },
    system,
    ffmpeg: {
      path: ffmpeg.path,
      version: ffmpeg.version,
      encoders: benchmarkResults.map(item => ({
        codec: item.codec,
        kind: item.kind,
        ok: item.ok,
        fps: item.fps
      }))
    },
    benchmark: benchmarkResults,
    recommended
  };
}

function profileSignature(ffmpegPath) {
  const cpu = getCpuInfo();
  const memory = getMemoryInfo();
  return {
    cpu: cpu.model,
    logicalProcessors: cpu.logicalProcessors,
    totalMemoryGB: memory.totalGB,
    ffmpegPath,
    ffmpegFingerprint: fileFingerprint(ffmpegPath)
  };
}

function signatureMatches(profile, expected) {
  if (!profile || profile.profileVersion !== PROFILE_VERSION || !profile.signature) return false;
  return Object.keys(expected).every(key => profile.signature[key] === expected[key]);
}

function readProfileCache() {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_CACHE, 'utf-8'));
    const runtime = getFfmpegRuntime();
    const expected = profileSignature(runtime.ffmpegPath);
    if (!signatureMatches(profile, expected)) return null;

    const ageDays = (Date.now() - new Date(profile.createdAt).getTime()) / 86400000;
    if (!Number.isFinite(ageDays) || ageDays > 30) return null;

    cachedProfile = profile;
    return profile;
  } catch (_) {
    return null;
  }
}

function writeProfileCache(profile) {
  try {
    ensureParent(PROFILE_CACHE);
    const temp = PROFILE_CACHE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(profile, null, 2), 'utf-8');
    fs.renameSync(temp, PROFILE_CACHE);
  } catch (_) {
    // 性能档案写入失败不应影响剪辑。
  }
}

async function runPerformanceProbe() {
  const runtime = getFfmpegRuntime();
  const ffmpegPath = runtime.ffmpegPath;
  const cpu = getCpuInfo();
  const memory = getMemoryInfo();
  const supported = listSupportedEncoders(ffmpegPath);

  const [gpu, disk] = await Promise.all([
    getGpuInfo(),
    benchmarkDisk()
  ]);

  const system = { cpu, memory, gpu, disk };
  const candidates = ENCODER_CANDIDATES.filter(item =>
    isH264VideoCodec(item.codec) && supported[item.codec]
  );
  if (!candidates.some(item => item.kind === 'x264')) {
    candidates.push(ENCODER_CANDIDATES[3]);
  }

  const benchmark = [];
  for (const candidate of candidates) {
    benchmark.push(await benchmarkEncoder(ffmpegPath, candidate));
  }

  const profile = buildPerformanceProfile(system, {
    path: ffmpegPath,
    version: getFfmpegVersion(ffmpegPath)
  }, benchmark);

  writeProfileCache(profile);
  cachedProfile = profile;
  return profile;
}

async function getPerformanceProfile(force = false) {
  if (!force && cachedProfile) return cachedProfile;
  if (!force) {
    const stored = readProfileCache();
    if (stored) return stored;
  }

  if (!activeProbe) {
    activeProbe = runPerformanceProbe().finally(() => {
      activeProbe = null;
    });
  }
  return activeProbe;
}

function getCachedPerformanceProfile() {
  if (cachedProfile) return cachedProfile;
  return readProfileCache();
}

function getPerformanceSummary(profile) {
  if (!profile) return null;
  return {
    ready: true,
    encoder: profile.recommended.encoder,
    encoderKind: profile.recommended.encoderKind,
    encoderLabel: profile.recommended.encoderLabel,
    videoCodecFamily: 'h264',
    videoCodecLabel: 'H.264 / AVC',
    outputProfile: 'MP4 · H.264 High · AAC · yuv420p · faststart',
    encoderFps: profile.recommended.encoderFps,
    scanWorkers: profile.recommended.scanWorkers,
    encodeConcurrency: profile.recommended.encodeConcurrency,
    originalTier: profile.recommended.originalTier,
    estimated4kFps: Number((profile.recommended.encoderFps / 3.4).toFixed(1)),
    estimated4kFastFps: Number((profile.recommended.encoderFps / 2.6).toFixed(1)),
    encoderSaturated: profile.recommended.encoderKind !== 'x264',
    reason: profile.recommended.reason,
    ffmpegPath: profile.ffmpeg.path,
    ffmpegVersion: profile.ffmpeg.version,
    gpuIndex: (function () { try { return getFfmpegRuntime().gpuIndex; } catch (_) { return null; } })(),
    gpuName: (function () { try { return getFfmpegRuntime().gpuName || ''; } catch (_) { return ''; } })(),
    cpu: profile.system.cpu.model,
    logicalProcessors: profile.system.cpu.logicalProcessors,
    memoryGB: profile.system.memory.totalGB,
    diskReadMBps: profile.system.disk.readMBps,
    diskWriteMBps: profile.system.disk.writeMBps,
    gpu: profile.system.gpu,
    benchmark: profile.benchmark
  };
}

function getProvisionalSummary() {
  const runtime = getFfmpegRuntime();
  const cpu = getCpuInfo();
  const memory = getMemoryInfo();
  return {
    ready: false,
    encoder: runtime.videoCodec,
    encoderKind: runtime.hardware,
    encoderLabel: runtime.hardware === 'nvenc' ? 'NVIDIA NVENC' : 'CPU x264',
    videoCodecFamily: 'h264',
    videoCodecLabel: 'H.264 / AVC',
    outputProfile: 'MP4 · H.264 High · AAC · yuv420p · faststart',
    scanWorkers: recommendedScanWorkers({ cpu, memory, disk: { readMBps: 0 } }),
    encodeConcurrency: 1,
    ffmpegPath: runtime.ffmpegPath,
    cpu: cpu.model,
    logicalProcessors: cpu.logicalProcessors,
    memoryGB: memory.totalGB,
    gpu: []
  };
}

function buildEncodingOptions(profile, quality = 'original', resources = null) {
  const recommended = profile && profile.recommended
    ? profile.recommended
    : { encoderKind: 'x264', originalTier: 'balanced' };
  const kind = recommended.encoderKind;
  const isPreview = quality === '360p';
  const isFast = quality === 'original-fast';
  const tier = recommended.originalTier || 'balanced';
  const encoderThreads = resources && resources.effective && resources.effective.encoderThreads
    ? resources.effective.encoderThreads
    : 0;
  let gpuIndex = null;
  try {
    gpuIndex = getFfmpegRuntime().gpuIndex;
  } catch (_) {}

  if (kind === 'nvenc') {
    // 4K 实测: p6 2.63x / p4 5.29x / p3 6.89x。
    // 默认原画用 p4 单通道，速度约为 p6 的两倍；快速档用 p3。
    return {
      videoCodec: 'h264_nvenc',
      videoCodecFamily: 'h264',
      gpu: gpuIndex,
      cq: isPreview ? 31 : (isFast ? 18 : 17),
      nvencPreset: isPreview ? 'p1' : (isFast ? 'p3' : 'p4'),
      nvencTune: 'hq',
      multipass: 'disabled',
      spatialAq: isPreview ? 0 : 1,
      temporalAq: isPreview ? 0 : 1,
      qualityTier: isPreview ? 'preview' : (isFast ? 'fast' : 'original'),
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      scale: isPreview ? '360' : null
    };
  }

  if (kind === 'qsv') {
    return {
      videoCodec: 'h264_qsv',
      videoCodecFamily: 'h264',
      cq: isPreview ? 30 : (isFast ? 20 : 18),
      preset: isPreview ? 'veryfast' : (isFast ? 'faster' : 'medium'),
      lookAhead: isPreview ? 0 : 1,
      qualityTier: isPreview ? 'preview' : (isFast ? 'fast' : 'original'),
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      scale: isPreview ? '360' : null
    };
  }

  if (kind === 'amf') {
    return {
      videoCodec: 'h264_amf',
      videoCodecFamily: 'h264',
      cq: isPreview ? 31 : (isFast ? 21 : 19),
      amfQuality: isPreview ? 'speed' : (isFast ? 'balanced' : 'quality'),
      qualityTier: isPreview ? 'preview' : (isFast ? 'fast' : 'original'),
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      scale: isPreview ? '360' : null
    };
  }

  const cpuPreset = tier === 'high' ? 'medium' : (tier === 'balanced' ? 'fast' : 'veryfast');
  return {
    videoCodec: 'libx264',
    videoCodecFamily: 'h264',
    crf: isPreview ? 29 : (isFast ? 19 : 17),
    preset: isPreview ? 'ultrafast' : (isFast ? 'veryfast' : cpuPreset),
    threads: encoderThreads || undefined,
    qualityTier: isPreview ? 'preview' : (isFast ? 'fast' : 'original'),
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    scale: isPreview ? '360' : null
  };
}
function softwareFallbackOptions(options) {
  return {
    ...options,
    videoCodec: 'libx264',
    crf: options.crf !== undefined ? options.crf : 18,
    preset: options.preset || 'fast',
    cq: undefined,
    nvencPreset: undefined,
    multipass: undefined,
    spatialAq: undefined,
    temporalAq: undefined,
    lookAhead: undefined,
    amfQuality: undefined
  };
}

module.exports = {
  PROFILE_CACHE,
  getPerformanceProfile,
  getCachedPerformanceProfile,
  getPerformanceSummary,
  getProvisionalSummary,
  buildEncodingOptions,
  softwareFallbackOptions,
  deriveFfprobePath
};
// 1080p 基准更接近 4K 原画编码的真实差异，避免低分辨率下 CPU 虚高。
const BENCHMARK_SIZE = '1920x1080';
const HARDWARE_MIN_FPS = 20;
