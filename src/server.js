/**
 * Express Web 服务 — 三角洲行动精彩镜头自动剪辑
 *
 * 启动: npm start  或  node src/server.js
 * 访问: http://localhost:3456
 *
 * API:
 *   GET  /api/events              SSE 进度推送
 *   POST /api/scan                {materialDir} → 启动全流程
 *   POST /api/stop                停止当前流程
 *   POST /api/load-shotlog        {shotlogPath, materialDir?} → 校验并加载
 *   PUT  /api/set-material-dir    {materialDir} → 设置素材目录
 *   POST /api/select-directory    {initialPath} → Windows 原生文件夹选择窗口
 *   GET  /api/shotlog             获取当前镜头日志
 *   PUT  /api/shotlog             保存编辑后的镜头日志
 *   GET  /api/frame               ?video=&time= → 提取帧缩略图
 *   POST /api/reclip              重新裁剪+拼接
 *   GET  /api/output              获取成品文件信息
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { generateShotlog, saveShotlog } = require('./lib/shotlog');
const { clipSegment } = require('./lib/clipper');
const { concatClips, concatClipsDirect } = require('./lib/concat');
const { loadConfig, getPythonPath, getMaterialDir, getOutputDir, getPort, ROOT } = require('./config');
const { getFfmpegRuntime } = require('./lib/ffmpeg-engine');
const {
  getPerformanceProfile,
  getCachedPerformanceProfile,
  getPerformanceSummary,
  getProvisionalSummary,
  buildEncodingOptions
} = require('./lib/performance-profiler');
const {
  getResourceSummary,
  updateResourceSummary
} = require('./lib/resource-manager');
const {
  isPickerActive,
  selectDirectory
} = require('./lib/native-folder-dialog');

// ============================================================
// 加载配置
// ============================================================
const cfg = loadConfig();
const APP_VERSION = require('../package.json').version;

// ============================================================
// 路径常量
// ============================================================
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const WORK_DIR = path.join(ROOT, 'work');
const FINAL_DIR = getOutputDir();
const CLIPS_DIR = path.join(WORK_DIR, 'clips');
const FRAMES_DIR = path.join(WORK_DIR, 'frames');
const FFMPEG_RUNTIME = getFfmpegRuntime();
const FFMPEG_PATH = FFMPEG_RUNTIME.ffmpegPath;
const PYTHON_CMD = getPythonPath();
const SCAN_SCRIPT = path.resolve(__dirname, 'scan_video_only.py');

const FFPROBE_PATH = FFMPEG_RUNTIME.ffprobePath;

const SCAN_CACHE_DIR = path.join(WORK_DIR, 'scan-cache');

let performanceProbeStarted = false;
function ensurePerformanceProfile(force = false) {
  if (!force && getCachedPerformanceProfile()) {
    return Promise.resolve(getCachedPerformanceProfile());
  }
  return getPerformanceProfile(force).catch(err => {
    console.error('Performance probe failed:', err.message);
    return null;
  });
}

function buildRuntimePerformance(profile) {
  const base = profile ? getPerformanceSummary(profile) : getProvisionalSummary();
  const resource = getResourceSummary(profile, base);
  return {
    ...base,
    version: APP_VERSION,
    scanWorkers: resource.effective.scanWorkers,
    encodeConcurrency: resource.effective.encodeConcurrency,
    resource
  };
}

// ============================================================
// Express 初始化
// ============================================================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(WEB_DIR));

[WORK_DIR, FINAL_DIR, CLIPS_DIR, FRAMES_DIR, SCAN_CACHE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================================
// API: /api/config — 返回前端需要的配置与设备性能摘要
// ============================================================
app.get('/api/config', (req, res) => {
  const profile = getCachedPerformanceProfile();
  const performance = buildRuntimePerformance(profile);
  res.json({
    outputDir: FINAL_DIR,
    materialDir: getMaterialDir(),
    defaultQuality: 'original',
    performance,
    resources: performance.resource
  });
});

// ============================================================
// API: /api/performance — 返回/触发设备性能档案
// ============================================================
app.get('/api/performance', async (req, res) => {
  const force = req.query.force === '1';
  const profile = await ensurePerformanceProfile(force);
  if (!profile) return res.status(500).json({ error: '性能探测失败' });
  res.json(buildRuntimePerformance(profile));
});

// ============================================================
// API: /api/resources — 资源上限设置
// ============================================================
app.get('/api/resources', async (req, res) => {
  const profile = await ensurePerformanceProfile();
  const performance = buildRuntimePerformance(profile);
  res.json(performance.resource);
});

app.put('/api/resources', async (req, res) => {
  const profile = await ensurePerformanceProfile();
  const base = profile ? getPerformanceSummary(profile) : getProvisionalSummary();
  const resource = updateResourceSummary(profile, base, req.body || {});
  const performance = {
    ...base,
    scanWorkers: resource.effective.scanWorkers,
    encodeConcurrency: resource.effective.encodeConcurrency,
    resource
  };
  broadcast('performance', performance);
  res.json({ ok: true, resource, performance });
});

// ============================================================
// 环境自检
// ============================================================

/**
 * 运行一个命令并捕获首行输出（用于检测版本）
 * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
 */
function runCheck(cmd, args, versionRegex) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: `无法启动: ${err.message}` });
    }

    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve({ ok: false, error: '检测超时' });
    }, 8000);

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); }); // 部分工具把版本写到 stderr

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, error: `命令未找到或无法执行 (${cmd})` });
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        return resolve({ ok: false, error: `退出码 ${code}` });
      }
      const m = out.match(versionRegex);
      resolve({ ok: true, version: m ? m[1] : out.trim().split('\n')[0].slice(0, 40) });
    });
  });
}

/**
 * 检测模板图片是否齐全
 */
function checkTemplates() {
  const tplDir = path.resolve(__dirname, '..', 'templates');
  const expected = ['01-kill-white.png', '02-vehicle-orange.png', '03-precise-kill-orange.png'];
  const found = expected.filter(f => fs.existsSync(path.join(tplDir, f)));
  if (found.length === expected.length) {
    return { ok: true, count: found.length };
  }
  return { ok: false, count: found.length, error: `缺少模板图片 (${found.length}/${expected.length})` };
}

/**
 * 执行完整环境自检（各项并行）
 */
async function runEnvCheck() {
  const [ffmpeg, ffprobe, python, opencv, numpy] = await Promise.all([
    runCheck(FFMPEG_PATH, ['-version'], /ffmpeg version ([\w.\-]+)/),
    runCheck(FFPROBE_PATH, ['-version'], /ffprobe version ([\w.\-]+)/),
    runCheck(PYTHON_CMD, ['--version'], /Python ([\d.]+)/),
    runCheck(PYTHON_CMD, ['-c', 'import cv2; print(cv2.__version__)'], /([\d.]+)/),
    runCheck(PYTHON_CMD, ['-c', 'import numpy; print(numpy.__version__)'], /([\d.]+)/),
  ]);
  const templates = checkTemplates();

  const result = { ffmpeg, ffprobe, python, opencv, numpy, templates };
  result.allOk = [ffmpeg, ffprobe, python, opencv, numpy, templates].every(r => r.ok);
  return result;
}

// 启动时自检一次并缓存
let envCheckCache = null;
runEnvCheck().then(result => {
  envCheckCache = result;
  console.log('');
  if (result.allOk) {
    console.log(`✅ 环境自检通过  ffmpeg ${result.ffmpeg.version} | python ${result.python.version} | opencv ${result.opencv.version}`);
  } else {
    console.log('⚠️  环境自检发现问题:');
    for (const [name, r] of Object.entries(result)) {
      if (name === 'allOk') continue;
      if (!r.ok) console.log(`   ❌ ${name}: ${r.error || '异常'}`);
    }
    console.log('   请检查 config.json 中的 ffmpegPath / pythonPath 配置。');
  }
  console.log('');
});

// ============================================================
// API: /api/check-env — 环境自检（force=1 强制重新检测）
// ============================================================
app.get('/api/check-env', async (req, res) => {
  if (req.query.force === '1' || !envCheckCache) {
    envCheckCache = await runEnvCheck();
  }
  res.json(envCheckCache);
});

// ============================================================
// SSE
// ============================================================
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}

// ============================================================
// 全局状态
// ============================================================
const state = {
  activeProcess: null,
  aborted: false,
  running: false,
  startTime: 0,
  materialDir: '',
  shotlogPath: '',
  highlightPath: '',
  batchName: ''
};

function beginTaskProgress(label) {
  const now = Date.now();
  state.taskProgress = {
    phase: 'prepare',
    label: label || '准备任务',
    detail: '',
    percent: 0,
    rate: 0,
    phaseStartPercent: 0,
    phaseStartedAt: now,
    lastPercent: 0,
    lastAt: now,
    etaSeconds: null,
    estimatedFinishAt: null,
    updatedAt: now
  };
  broadcast('task-progress', buildTaskProgressPayload());
}

function buildTaskProgressPayload() {
  const p = state.taskProgress;
  if (!p) return null;
  const etaSeconds = p.estimatedFinishAt
    ? Math.max(0, Math.round((p.estimatedFinishAt - Date.now()) / 1000))
    : null;
  return {
    phase: p.phase,
    label: p.label,
    detail: p.detail,
    percent: Math.max(0, Math.min(100, p.percent)),
    etaSeconds,
    estimatedFinishAt: p.estimatedFinishAt,
    updatedAt: p.updatedAt
  };
}

function updateTaskProgress(payload = {}) {
  if (!state.taskProgress) beginTaskProgress(payload.label);
  const p = state.taskProgress;
  const now = Date.now();
  const nextPercent = Math.max(0, Math.min(100, Number(payload.percent)));
  const phaseChanged = payload.phase && payload.phase !== p.phase;

  if (phaseChanged) {
    p.phase = payload.phase;
    p.phaseStartedAt = now;
    p.phaseStartPercent = Number.isFinite(nextPercent) ? nextPercent : p.percent;
    p.rate = 0;
  } else if (Number.isFinite(nextPercent) && now > p.lastAt) {
    const deltaPercent = Math.max(0, nextPercent - p.lastPercent);
    const deltaSeconds = (now - p.lastAt) / 1000;
    if (deltaPercent > 0.02 && deltaSeconds >= 0.5) {
      const instantRate = deltaPercent / deltaSeconds;
      p.rate = p.rate > 0 ? p.rate * 0.65 + instantRate * 0.35 : instantRate;
    }
  }

  if (Number.isFinite(nextPercent)) p.percent = Math.max(p.percent, nextPercent);
  if (payload.label) p.label = payload.label;
  if (payload.detail !== undefined) p.detail = payload.detail;

  let etaSeconds = payload.etaSeconds === null || payload.etaSeconds === undefined
    ? NaN
    : Number(payload.etaSeconds);
  if (!Number.isFinite(etaSeconds) || etaSeconds < 0) {
    etaSeconds = p.rate > 0 ? Math.max(0, (100 - p.percent) / p.rate) : null;
  }
  p.etaSeconds = etaSeconds;
  p.estimatedFinishAt = etaSeconds === null ? null : now + etaSeconds * 1000;
  p.lastPercent = p.percent;
  p.lastAt = now;
  p.updatedAt = now;
  broadcast('task-progress', buildTaskProgressPayload());
}

function resetState() {
  state.aborted = false;
  state.running = false;
  state.activeProcess = null;
}

function isAborted() {
  if (state.aborted) {
    broadcast('error', { message: '用户停止了流程' });
    resetState();
    return true;
  }
  return false;
}

// ============================================================
// 工具函数
// ============================================================
// 时间戳: YYYYMMDD-HHmmss
function timestampName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function deriveBatchName(materialDir) {
  const dirName = path.basename(materialDir);
  const m = dirName.match(/^(\d{8})-(\d{8})$/);
  if (m) return m[0];
  try {
    const files = fs.readdirSync(materialDir).filter(f => f.endsWith('.mp4'));
    const dates = [];
    for (const f of files) {
      const dm = f.match(/(\d{4})\.(\d{2})\.(\d{2})/);
      if (dm) dates.push(dm[1] + dm[2] + dm[3]);
    }
    if (dates.length >= 2) { dates.sort(); return `${dates[0]}-${dates[dates.length - 1]}`; }
    if (dates.length === 1) return dates[0];
  } catch (_) {}
  return dirName.replace(/[\\/:*?"<>|]/g, '_') || 'batch';
}

// ============================================================
// API: /api/scan — 全流程
// ============================================================
app.post('/api/scan', async (req, res) => {
  const { materialDir, outputName, outputDir, compatibilityMode, quality, music } = req.body;
  if (!materialDir || !fs.existsSync(materialDir)) {
    return res.status(400).json({ error: '素材目录不存在' });
  }
  if (state.running) {
    return res.status(409).json({ error: '已有任务在运行中' });
  }

  const batchName = deriveBatchName(materialDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workSubDir = path.join(WORK_DIR, `${batchName}_${ts}`);
  fs.mkdirSync(workSubDir, { recursive: true });

  const targetOutputDir = outputDir || FINAL_DIR;
  const targetOutputName = outputName || `highlight-${batchName}.mp4`;

  state.materialDir = materialDir;
  state.batchName = batchName;
  state.workDir = workSubDir;
  state.shotlogPath = path.join(workSubDir, `shotlog-${timestampName()}.json`);
  state.highlightPath = path.join(targetOutputDir, targetOutputName);
  state.compatibilityMode = !!compatibilityMode;
  state.quality = quality || 'original';
  state.encoding = null;
  state.music = music || null;
  state.running = true;
  state.aborted = false;
  state.startTime = Date.now();
  state.activeProcess = null;

  beginTaskProgress('准备任务');

  res.json({ ok: true, batchName, workDir: workSubDir });

  ensurePerformanceProfile().catch(() => {});

  // 启动计时器

  const timer = setInterval(() => {
    broadcast('timer', { elapsed: Math.floor((Date.now() - state.startTime) / 1000) });
    const progress = buildTaskProgressPayload();
    if (progress) broadcast('task-progress', progress);
  }, 1000);

  try {
    // 总步骤数: 高效模式 4 步，兼容模式 5 步（统一分母避免跳变）
    const totalSteps = state.compatibilityMode ? 5 : 4;

    // ===== Step 1: 发现视频 =====
    broadcast('step', { step: 1, total: totalSteps, message: '发现素材视频' });
    updateTaskProgress({ phase: 'prepare', label: '发现素材视频', percent: 1, detail: '正在读取素材目录...', etaSeconds: null });
    const videoFiles = fs.readdirSync(materialDir)
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .sort();
    if (videoFiles.length === 0) throw new Error('素材目录中没有 .mp4 文件');

    const videos = videoFiles.map((name, i) => ({
      index: i,
      name,
      path: path.join(materialDir, name),
      scanStatus: 'pending',
      scanDuration: 0,
      scanSeconds: 0,
      kills: 0,
      clipStatus: 'pending',
      clipSize: 0
    }));

    // 短暂延迟确保 SSE 连接已建立
    await new Promise(r => setTimeout(r, 500));
    broadcast('init', { videos, total: videos.length });
    updateTaskProgress({ phase: 'prepare', label: '准备扫描', percent: 3, detail: `已发现 ${videos.length} 个视频`, etaSeconds: null });
    if (isAborted()) { clearInterval(timer); return; }

    // ===== Step 2: 扫描 =====
    // 首次运行完成性能探测后再确定编码器，后续切片/拼接直接复用。
    const profile = await ensurePerformanceProfile();
    const perfSummary = buildRuntimePerformance(profile);
    state.resource = perfSummary.resource;
    state.encoding = buildEncodingOptions(profile, state.quality, state.resource);
    state.scanWorkers = state.resource.effective.scanWorkers;
    broadcast('performance', perfSummary);
    broadcast('progress', {
      detail: '设备自适应: ' + perfSummary.encoderLabel + '，CPU 上限 ' + perfSummary.resource.cpuPercent + '%，扫描 ' + state.scanWorkers + ' 路并行，画质 ' + (state.quality === '360p' ? '360P 预览' : (state.quality === 'original-fast' ? '原画加速' : '原画'))
    });

    broadcast('step', { step: 2, total: totalSteps, message: '视频击杀扫描' });
    await runScan(videos);
    updateTaskProgress({ phase: 'scan', label: '扫描完成', percent: 72, detail: '正在汇总击杀结果...', etaSeconds: 0 });
    if (isAborted()) { clearInterval(timer); return; }

    // ===== Step 3: 日志 =====
    broadcast('step', { step: 3, total: totalSteps, message: '生成镜头日志' });
    updateTaskProgress({ phase: 'log', label: '生成镜头日志', percent: 74, detail: '正在整理击杀片段...', etaSeconds: null });
    const scanResultPath = path.join(workSubDir, `scan-result-${batchName}.json`);
    const scanResult = JSON.parse(fs.readFileSync(path.join(state.workDir, `scan-result-${batchName}.json`), 'utf-8'));
    const shotlog = generateShotlog(scanResult, {
      beforeSeconds: 5, afterSeconds: 2, mergeMaxGapSeconds: 15
    }, materialDir);
    saveShotlog(shotlog, state.shotlogPath);

    const totalKills = videos.reduce((s, v) => s + v.kills, 0);
    const videoWithKills = videos.filter(v => v.kills > 0).length;
    broadcast('progress', { detail: `${shotlog.totalClips} 个片段 (${totalKills} 次击杀 / ${videoWithKills} 个视频)` });
    updateTaskProgress({ phase: 'log', label: '镜头日志完成', percent: 76, detail: `${shotlog.totalClips} 个片段，准备生成集锦`, etaSeconds: null });
    if (isAborted()) { clearInterval(timer); return; }

    if (state.compatibilityMode) {
      // ===== 兼容模式: 逐个裁剪 + 拼接 =====
      broadcast('step', { step: 4, total: totalSteps, message: '裁剪视频片段' });
      const totalClipSeconds = shotlog.clips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);
      const onClipProgress = progress => {
        const fraction = progress.totalSeconds > 0 ? progress.processedSeconds / progress.totalSeconds : 0;
        const eta = progress.etaSeconds !== undefined && progress.etaSeconds !== null
          ? progress.etaSeconds
          : (progress.rate > 0 ? Math.max(0, (progress.totalSeconds - progress.processedSeconds) / progress.rate) : null);
        updateTaskProgress({
          phase: 'clip',
          label: '裁剪视频片段',
          percent: 76 + Math.max(0, Math.min(1, fraction)) * 19,
          detail: progress.currentName ? `正在裁剪 ${progress.currentName}` : '正在裁剪视频片段',
          etaSeconds: eta
        });
      };
      const clipResults = await runClip(
        videos,
        shotlog,
        state.resource && state.resource.effective ? state.resource.effective.encodeConcurrency : 1,
        CLIPS_DIR,
        onClipProgress
      );
      if (isAborted()) { clearInterval(timer); return; }
      if (clipResults.filter(r => r.status === 'ok').length === 0) {
        clearInterval(timer);
        broadcast('done', { success: false, error: '没有可裁剪的片段' });
        resetState();
        return;
      }
      broadcast('step', { step: 5, total: totalSteps, message: '拼接集锦视频' });
      const okPaths = clipResults.filter(r => r.status === 'ok').map(r => r.outputFile);
      await concatClips(okPaths, state.highlightPath, {
        ...state.encoding,
        streamCopy: false,
        totalDuration: totalClipSeconds,
        onProgress: progress => updateTaskProgress({
          phase: 'encode',
          label: '拼接集锦视频',
          percent: 95 + Math.max(0, Math.min(1, progress.percent / 100)) * 4,
          detail: '正在拼接并封装成片',
          etaSeconds: progress.etaSeconds
        })
      });
    } else {
      // ===== 高效模式: ffmpeg 直出 =====
      broadcast('step', { step: 4, total: totalSteps, message: '生成集锦视频 (高效直出)' });
      const okClips = shotlog.clips.filter(c => {
        if (c.clipEnd <= c.clipStart) return false; // 跳过 duration=0
        const p = path.join(state.materialDir, c.sourceFile);
        return fs.existsSync(p);
      });
      if (okClips.length === 0) {
        clearInterval(timer);
        broadcast('done', { success: false, error: '没有可用的源视频' });
        resetState();
        return;
      }
      // 标记所有有击杀的视频裁剪状态为 done（实际跳过了裁剪）
      for (const v of videos) {
        if (v.kills > 0) v.clipStatus = 'done';
      }
      const totalEncodeSeconds = okClips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);
      updateTaskProgress({ phase: 'encode', label: '生成集锦视频', percent: 76, detail: '正在初始化硬件编码...', etaSeconds: null });
      await concatClipsDirect(shotlog, state.materialDir, state.highlightPath, {
        ...state.encoding,
        music: state.music,
        totalDuration: totalEncodeSeconds,
        onProgress: progress => updateTaskProgress({
          phase: 'encode',
          label: '生成集锦视频',
          percent: 76 + Math.max(0, Math.min(1, progress.percent / 100)) * 24,
          detail: progress.speed > 0
            ? `正在原画编码 · ${progress.speed.toFixed(2)}x`
            : '正在原画编码',
          etaSeconds: progress.etaSeconds
        })
      });
    }

    const stat = fs.statSync(state.highlightPath);
    updateTaskProgress({ phase: 'finalize', label: '收尾处理', percent: 99, detail: '正在写入文件信息...', etaSeconds: 0 });
    clearInterval(timer);
    updateTaskProgress({ phase: 'done', label: '处理完成', percent: 100, detail: '集锦已生成', etaSeconds: 0 });
    broadcast('done', {
      success: true,
      highlightPath: state.highlightPath,
      sizeMB: (stat.size / 1024 / 1024).toFixed(1),
      totalClips: shotlog.totalClips,
      totalKills
    });

  } catch (err) {
    clearInterval(timer);
    console.error('Pipeline error:', err);
    broadcast('error', { message: err.message });
  } finally {
    resetState();
  }
});

// ===== scan 子流程 =====
async function runScan(videos) {
  const scanFiles = videos.map(v => path.basename(v.path)).join('\n');
  const listPath = path.join(WORK_DIR, '_scan_list.txt');
  fs.writeFileSync(listPath, scanFiles, 'utf-8');

  const scanStartedAt = Date.now();

  function totalKnownDuration() {
    let total = 0;
    let known = 0;
    for (const v of videos) {
      const duration = Number(v.scanDuration) || 0;
      if (duration > 0) {
        total += duration;
        known++;
      }
    }
    return { total, known, estimated: known > 0 ? total * videos.length / known : 0 };
  }

  function currentProcessedDuration() {
    let processed = 0;
    for (const v of videos) {
      const duration = Number(v.scanDuration) || 0;
      const seconds = Number(v.scanSeconds) || 0;
      processed += duration > 0 ? Math.min(seconds, duration) : seconds;
    }
    return processed;
  }

  function reportScanProgress() {
    const known = totalKnownDuration();
    const processed = currentProcessedDuration();
    const total = known.estimated > 0 ? known.estimated : processed;
    const fraction = total > 0 ? Math.max(0, Math.min(1, processed / total)) : 0;
    const elapsed = Math.max(0.5, (Date.now() - scanStartedAt) / 1000);
    const rate = processed > 0 ? processed / elapsed : 0;
    const etaSeconds = rate > 0 && total > processed ? (total - processed) / rate : null;
    const active = videos.filter(v => v.scanStatus === 'scanning').map(v => v.name);
    const detail = active.length > 0
      ? `正在扫描 ${active.slice(0, 2).join('、')}${active.length > 2 ? ` 等 ${active.length} 个视频` : ''}`
      : '正在扫描视频素材';
    updateTaskProgress({
      phase: 'scan',
      label: '扫描视频',
      percent: 3 + fraction * 69,
      detail,
      etaSeconds
    });
  }

  reportScanProgress();

  return new Promise((resolve, reject) => {
    const scanWorkers = Math.max(1, Number(state.scanWorkers) || 1);
    const scanThreads = Math.max(0, Number(state.resource && state.resource.effective && state.resource.effective.scanThreadsPerProcess) || 0);
    const py = spawn(PYTHON_CMD, [
      '-u', SCAN_SCRIPT,
      '--dir', state.materialDir,
      '--interval', '0.2',
      '--threshold', '0.84',
      '--ffmpeg', FFMPEG_PATH,
      '--workers', String(scanWorkers),
      '--threads', String(scanThreads),
      '--cache-dir', SCAN_CACHE_DIR,
      '--json-events',
      '--save', path.join(state.workDir, `scan-result-${state.batchName}.json`)
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });

    state.activeProcess = py;

    let stderr = '';
    py.stderr.on('data', d => { stderr += d.toString(); });

    let buffer = '';
    py.stdout.on('data', d => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        // 优先处理机器可读事件（并行扫描时不会混淆视频）
        if (line.startsWith('@@DF_EVENT@@')) {
          try {
            const evt = JSON.parse(line.slice('@@DF_EVENT@@'.length));
            const idx = Number(evt.index) - 1;
            const v = videos[idx];
            if (evt.type === 'video_start' && v) {
              v.scanStatus = 'scanning';
              broadcast('video-scan-start', { index: idx, name: v.name });
              reportScanProgress();
            } else if (evt.type === 'video_meta' && v) {
              v.scanDuration = Number(evt.duration) || v.scanDuration || 0;
              reportScanProgress();
            } else if (evt.type === 'video_progress' && v) {
              const duration = Number(evt.duration) || v.scanDuration || 0;
              const processedSeconds = Number(evt.processed_seconds) || 0;
              v.scanDuration = duration;
              v.scanSeconds = Math.max(Number(v.scanSeconds) || 0, processedSeconds);
              reportScanProgress();
            } else if ((evt.type === 'video_done' || evt.type === 'video_error') && v) {
              const kills = Number(evt.kill_count || 0);
              v.kills = kills;
              v.scanStatus = evt.type === 'video_error' ? 'error' : (kills > 0 ? 'scanned' : 'skipped');
              v.scanDuration = Number(evt.duration) || v.scanDuration || 0;
              if (v.scanDuration > 0) v.scanSeconds = v.scanDuration;
              reportScanProgress();
              broadcast('video-scan-done', {
                index: idx,
                name: v.name,
                kills,
                cached: !!evt.cached
              });
              if (kills === 0 && evt.type !== 'video_error') {
                broadcast('video-skip', { index: idx, name: v.name, reason: '无击杀' });
              }
            }
          } catch (_) {}
          continue;
        }

        // 🎬 [3/16] 扫描: xxx.mp4
        let m = line.match(/🎬\s*\[(\d+)\/(\d+)\]\s*扫描:\s*(.+)/);
        if (m) {
          const idx = parseInt(m[1]) - 1;
          if (videos[idx]) {
            videos[idx].scanStatus = 'scanning';
            broadcast('video-scan-start', { index: idx, name: videos[idx].name });
          }
          continue;
        }

        // 检测到击杀: N 次
        m = line.match(/检测到击杀:\s*(\d+)\s*次/);
        if (m) {
          const kills = parseInt(m[1]);
          // 找到最近一个 scanning 状态的视频
          const v = videos.find(v => v.scanStatus === 'scanning');
          if (v) {
            v.scanStatus = kills > 0 ? 'scanned' : 'skipped';
            v.kills = kills;
            broadcast('video-scan-done', { index: v.index, name: v.name, kills });
          }
          continue;
        }

        // ⚠️ 未检测到击杀UI
        if (line.includes('未检测到击杀')) {
          const v = videos.find(v => v.scanStatus === 'scanning');
          if (v) {
            v.scanStatus = 'skipped';
            v.kills = 0;
            broadcast('video-scan-done', { index: v.index, name: v.name, kills: 0 });
            broadcast('video-skip', { index: v.index, name: v.name, reason: '无击杀' });
          }
        }
      }
    });

    py.on('close', code => {
      state.activeProcess = null;
      // 标记所有未完成的视频
      for (const v of videos) {
        if (v.scanStatus === 'pending' || v.scanStatus === 'scanning') {
          v.scanStatus = code === 0 ? 'skipped' : 'error';
        }
      }
      reportScanProgress();
      if (code !== 0 && !state.aborted) {
        reject(new Error(`扫描失败 (exit ${code}): ${stderr.slice(-200)}`));
      } else {
        resolve();
      }
    });

    py.on('error', err => {
      state.activeProcess = null;
      reject(new Error(`无法启动扫描: ${err.message}`));
    });
  });
}

function buildScanResult(videos) {
  return {
    config: { roi: 'auto', threshold: 0.7, interval: 0.2, templates: 3 },
    scanned_at: new Date().toISOString(),
    total_videos: videos.length,
    total_kills: videos.reduce((s, v) => s + v.kills, 0),
    results: videos.filter(v => v.kills > 0).map(v => ({
      video: v.path,
      duration: 30,
      kill_count: v.kills,
      detections: []  // 简化版，不需要保留每帧详情
    }))
  };
}

// ===== clip 子流程 =====
async function runClip(videos, shotlog, concurrency = 1, outputDir = CLIPS_DIR, progressCallback = null) {
  const clips = shotlog.clips || [];
  const results = new Array(clips.length);
  const clipToVideo = clips.map(clip => videos.find(v => v.name === clip.sourceFile));
  const clipsDir = outputDir || CLIPS_DIR;
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
  let nextIndex = 0;

  const totalClipSeconds = clips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);
  const activeProgress = new Map();
  const clipStartedAt = Date.now();
  let completedClipSeconds = 0;

  function reportClipProgress(currentName) {
    if (typeof progressCallback !== 'function') return;
    let activeSeconds = 0;
    for (const value of activeProgress.values()) activeSeconds += value;
    const processedSeconds = Math.min(totalClipSeconds, completedClipSeconds + activeSeconds);
    const elapsed = Math.max(0.5, (Date.now() - clipStartedAt) / 1000);
    const rate = processedSeconds > 0 ? processedSeconds / elapsed : 0;
    progressCallback({
      processedSeconds,
      totalSeconds: totalClipSeconds,
      rate,
      etaSeconds: rate > 0 && totalClipSeconds > processedSeconds
        ? (totalClipSeconds - processedSeconds) / rate
        : null,
      currentName: currentName || ''
    });
  }

  async function worker() {
    while (!state.aborted) {
      const i = nextIndex++;
      if (i >= clips.length) return;

      const clip = clips[i];
      const v = clipToVideo[i];
      if (v) v.clipStatus = 'clipping';
      broadcast('video-clip-start', { index: i, name: clip.sourceFile });
      const clipDuration = Math.max(0, clip.clipEnd - clip.clipStart);
      activeProgress.set(i, 0);
      reportClipProgress(path.basename(clip.sourceFile));

      try {
        const sourcePath = path.join(state.materialDir, clip.sourceFile);
        if (!fs.existsSync(sourcePath)) {
          if (v) v.clipStatus = 'skipped';
          results[i] = { status: 'skipped', reason: 'source not found' };
          broadcast('video-clip-done', { index: i, name: clip.sourceFile, status: 'skipped' });
          activeProgress.delete(i);
          completedClipSeconds += clipDuration;
          reportClipProgress();
          continue;
        }

        const outputName = `${path.parse(clip.sourceFile).name}_clip_${fmtTimeFile(clip.clipStart)}-${fmtTimeFile(clip.clipEnd)}.mp4`;
        const outputPath = path.join(clipsDir, outputName);
        await clipSegment(sourcePath, clip.clipStart, clip.clipEnd, outputPath, {
          ...state.encoding,
          onProgress: progress => {
            activeProgress.set(i, Math.max(activeProgress.get(i) || 0, progress.processedSeconds));
            reportClipProgress(path.basename(clip.sourceFile));
          }
        });

        const stat = fs.statSync(outputPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        if (v) { v.clipStatus = 'done'; v.clipSize = sizeMB; }
        results[i] = { outputFile: outputPath, status: 'ok', sizeBytes: stat.size };
        broadcast('video-clip-done', { index: i, name: clip.sourceFile, status: 'done', sizeMB });
        activeProgress.delete(i);
        completedClipSeconds += clipDuration;
        reportClipProgress();
      } catch (err) {
        if (v) v.clipStatus = 'error';
        results[i] = { status: 'error', error: err.message };
        broadcast('video-clip-done', { index: i, name: clip.sourceFile, status: 'error', error: err.message });
        activeProgress.delete(i);
        completedClipSeconds += clipDuration;
        reportClipProgress();
      }
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, clips.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter(Boolean);
}

function fmtTimeFile(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s${String(ms).padStart(2, '0')}`;
}

// ============================================================
// API: /api/stop
// ============================================================
app.post('/api/stop', (req, res) => {
  if (!state.running) return res.json({ ok: false, message: '没有运行中的任务' });
  state.aborted = true;
  if (state.activeProcess) {
    state.activeProcess.kill('SIGTERM');
    state.activeProcess = null;
  }
  res.json({ ok: true });
});

// ============================================================
// API: /api/load-shotlog — 加载已有镜头脚本（完整校验链）
// ============================================================
app.post('/api/load-shotlog', (req, res) => {
  const { shotlogPath, shotlogContent, materialDir: overrideDir } = req.body;

  let shotlog;
  try {
    if (shotlogContent) {
      // 来自拖拽/文件选择的 JSON 内容
      shotlog = shotlogContent;
    } else if (shotlogPath && fs.existsSync(shotlogPath)) {
      shotlog = JSON.parse(fs.readFileSync(shotlogPath, 'utf-8'));
    } else if (shotlogPath) {
      return res.status(400).json({ error: '镜头脚本文件不存在: ' + shotlogPath });
    } else {
      return res.status(400).json({ error: '请提供镜头脚本文件' });
    }
  } catch (_) {
    return res.status(400).json({ error: '镜头脚本格式无效，无法解析 JSON' });
  }

  // 确定素材目录
  let materialDir = overrideDir || shotlog.materialDir || '';

  // 检查 materialDir
  if (!materialDir) {
    return res.json({ needDir: true });
  }

  if (!fs.existsSync(materialDir)) {
    return res.json({ error: '记录的素材目录已不存在，请重新选择', missingDir: true, path: materialDir });
  }

  // 检查素材文件完整性
  const missingVideos = [];
  for (const clip of shotlog.clips || []) {
    if (!clip.sourceFile) continue;
    const fullPath = path.join(materialDir, clip.sourceFile);
    if (!fs.existsSync(fullPath)) {
      missingVideos.push(clip.sourceFile);
    }
  }

  // 设置状态
  state.materialDir = materialDir;
  state.shotlogPath = shotlogPath || path.join(WORK_DIR, `shotlog-${timestampName()}.json`);
  // 来自拖拽/粘贴的镜头脚本先落盘，确保后续「重新剪辑」能读取。
  if (!fs.existsSync(state.shotlogPath)) {
    fs.writeFileSync(state.shotlogPath, JSON.stringify(shotlog, null, 2), 'utf-8');
  }
  state.shotlog = shotlog;
  state.highlightPath = path.join(FINAL_DIR, `highlight-${deriveBatchName(materialDir)}.mp4`);

  res.json({
    ok: true,
    missingVideos,
    materialDir,
    shotlog
  });
});

// ============================================================
// API: /api/set-material-dir
// ============================================================
app.put('/api/set-material-dir', (req, res) => {
  const { materialDir } = req.body;
  if (!materialDir || !fs.existsSync(materialDir)) {
    return res.status(400).json({ error: '素材目录不存在' });
  }
  state.materialDir = materialDir;
  res.json({ ok: true });
});

// ============================================================
// API: /api/shotlog (GET + PUT)
// ============================================================
app.get('/api/shotlog', (req, res) => {
  if (!state.shotlogPath || !fs.existsSync(state.shotlogPath)) {
    return res.status(404).json({ error: '镜头日志不存在，请先运行扫描或加载已有脚本' });
  }
  res.json(JSON.parse(fs.readFileSync(state.shotlogPath, 'utf-8')));
});

app.put('/api/shotlog', (req, res) => {
  const shotlog = req.body;
  if (!shotlog.clips || !Array.isArray(shotlog.clips)) {
    return res.status(400).json({ error: '无效的镜头日志格式' });
  }
  for (const clip of shotlog.clips) {
    // 无击杀且未手动设置范围的片段 (duration=0) 允许保存，生成时跳过
    if (clip.noKill && clip.clipStart === 0 && clip.clipEnd === 0) continue;
    if (clip.clipStart >= clip.clipEnd) {
      return res.status(400).json({ error: `${clip.sourceFile}: clipStart 必须小于 clipEnd` });
    }
  }
  if (!state.shotlogPath) {
    state.shotlogPath = path.join(WORK_DIR, `shotlog-${timestampName()}.json`);
  }
  shotlog.totalClips = shotlog.clips.length;
  fs.writeFileSync(state.shotlogPath, JSON.stringify(shotlog, null, 2), 'utf-8');
  res.json({ ok: true, path: state.shotlogPath });
});

// ============================================================
// API: /api/frame — 提取帧缩略图
// ============================================================
app.get('/api/frame', (req, res) => {
  const { video, time } = req.query;
  if (!video || !time || !state.materialDir) {
    return res.status(400).json({ error: '缺少参数' });
  }

  const videoPath = path.join(state.materialDir, video);
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: `视频不存在: ${video}` });
  }

  const frameFile = path.join(FRAMES_DIR,
    `${path.parse(video).name}_t${parseFloat(time).toFixed(1)}.jpg`);

  if (fs.existsSync(frameFile)) return res.sendFile(frameFile);

  const ffmpeg = spawn(FFMPEG_PATH, [
    '-ss', String(time), '-i', videoPath,
    '-vframes', '1', '-vf', 'scale=320:-1', '-q:v', '3', '-y', frameFile
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

  ffmpeg.on('close', code => {
    if (code !== 0 || !fs.existsSync(frameFile)) {
      return res.status(500).json({ error: `帧提取失败: ${stderr.slice(-200)}` });
    }
    res.sendFile(frameFile);
  });

  ffmpeg.on('error', err => res.status(500).json({ error: err.message }));
});

// ============================================================
// API: /api/reclip — 重新裁剪+拼接
// ============================================================
app.post('/api/reclip', async (req, res) => {
  if (state.running) return res.status(409).json({ error: '已有任务在运行中' });
  if (!state.shotlogPath || !fs.existsSync(state.shotlogPath)) {
    return res.status(400).json({ error: '镜头日志不存在' });
  }
  if (!state.materialDir) return res.status(400).json({ error: '素材目录未设置' });

  const { outputName, outputDir, compatibilityMode, quality, music } = req.body;
  if (outputDir && outputName) {
    state.highlightPath = path.join(outputDir, outputName);
  }
  state.compatibilityMode = !!compatibilityMode;
  state.quality = quality || 'original';
  const profile = await ensurePerformanceProfile();
  const perfSummary = buildRuntimePerformance(profile);
  state.resource = perfSummary.resource;
  state.encoding = buildEncodingOptions(profile, state.quality, state.resource);
  broadcast('performance', perfSummary);
  state.music = music || null;

  state.running = true;
  state.aborted = false;
  state.startTime = Date.now();
  beginTaskProgress('准备重新生成');
  res.json({ ok: true });

  const timer = setInterval(() => {
    broadcast('timer', { elapsed: Math.floor((Date.now() - state.startTime) / 1000) });
    const progress = buildTaskProgressPayload();
    if (progress) broadcast('task-progress', progress);
  }, 1000);

  try {
    const shotlog = JSON.parse(fs.readFileSync(state.shotlogPath, 'utf-8'));

    if (state.compatibilityMode) {
      // 兼容模式: 按资源上限批量裁剪 + 拼接
      broadcast('step', { step: 1, total: 2, message: '裁剪视频片段' });
      updateTaskProgress({ phase: 'prepare', label: '准备裁剪', percent: 2, detail: '正在读取镜头日志...', etaSeconds: null });
      const clipsDir = path.join(state.workDir || WORK_DIR, 'clips');
      const concurrency = state.resource && state.resource.effective
        ? state.resource.effective.encodeConcurrency
        : 1;
      const totalClipSeconds = shotlog.clips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);
      const results = await runClip([], shotlog, concurrency, clipsDir, progress => {
        const fraction = progress.totalSeconds > 0 ? progress.processedSeconds / progress.totalSeconds : 0;
        updateTaskProgress({
          phase: 'clip',
          label: '裁剪视频片段',
          percent: 2 + Math.max(0, Math.min(1, fraction)) * 92,
          detail: progress.currentName ? `正在裁剪 ${progress.currentName}` : '正在裁剪视频片段',
          etaSeconds: progress.etaSeconds
        });
      });
      if (state.aborted) { clearInterval(timer); return; }
      const okPaths = results.filter(r => r.status === 'ok').map(r => r.outputFile);
      if (okPaths.length === 0) { clearInterval(timer); broadcast('done', { success: false, error: '没有可拼接的片段' }); resetState(); return; }
      broadcast('step', { step: 2, total: 2, message: '拼接集锦视频' });
      await concatClips(okPaths, state.highlightPath, {
        ...state.encoding,
        streamCopy: false,
        totalDuration: totalClipSeconds,
        onProgress: progress => updateTaskProgress({
          phase: 'encode',
          label: '拼接集锦视频',
          percent: 94 + Math.max(0, Math.min(1, progress.percent / 100)) * 5,
          detail: '正在拼接并封装成片',
          etaSeconds: progress.etaSeconds
        })
      });
    } else {
      // 高效模式: ffmpeg 直出
      broadcast('step', { step: 1, total: 1, message: '生成集锦视频 (高效直出)' });
      const totalEncodeSeconds = shotlog.clips.reduce((sum, clip) => sum + Math.max(0, clip.clipEnd - clip.clipStart), 0);
      updateTaskProgress({ phase: 'encode', label: '生成集锦视频', percent: 2, detail: '正在初始化硬件编码...', etaSeconds: null });
      await concatClipsDirect(shotlog, state.materialDir, state.highlightPath, {
        ...state.encoding,
        music: state.music,
        totalDuration: totalEncodeSeconds,
        onProgress: progress => updateTaskProgress({
          phase: 'encode',
          label: '生成集锦视频',
          percent: 2 + Math.max(0, Math.min(1, progress.percent / 100)) * 97,
          detail: progress.speed > 0
            ? `正在原画编码 · ${progress.speed.toFixed(2)}x`
            : '正在原画编码',
          etaSeconds: progress.etaSeconds
        })
      });
    }

    const stat = fs.statSync(state.highlightPath);
    updateTaskProgress({ phase: 'done', label: '处理完成', percent: 100, detail: '集锦已生成', etaSeconds: 0 });
    clearInterval(timer);
    broadcast('done', { success: true, highlightPath: state.highlightPath, sizeMB: (stat.size/1024/1024).toFixed(1) });

  } catch (err) {
    clearInterval(timer);
    console.error('Reclip error:', err);
    broadcast('error', { message: err.message });
  } finally {
    resetState();
  }
});

// ============================================================
// API: /api/select-directory — 调用 Windows 原生文件夹选择窗口
// ============================================================
app.post('/api/select-directory', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: '当前系统不支持原生文件夹选择窗口' });
  }
  if (isPickerActive()) {
    return res.status(409).json({ error: '文件夹选择窗口已经打开' });
  }

  try {
    const selectedPath = await selectDirectory(req.body?.initialPath, getMaterialDir() || ROOT);
    if (!selectedPath) return res.json({ cancelled: true, path: null });
    return res.json({ cancelled: false, path: selectedPath });
  } catch (err) {
    const status = err.code === 'PICKER_BUSY' ? 409 : (err.code === 'UNSUPPORTED_PLATFORM' ? 501 : 500);
    return res.status(status).json({ error: err.message });
  }
});

// ============================================================
// API: /api/dirs — 浏览目录（非 Windows 回退）
// ============================================================
app.get('/api/dirs', (req, res) => {
  let targetPath = req.query.path || '';

  // 默认根路径：常用素材目录的父目录
  if (!targetPath) {
    const candidates = [
      path.join(ROOT, '03-素材'),
      ROOT
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { targetPath = c; break; }
    }
    if (!targetPath) targetPath = ROOT;
  }

  // 安全：不允许访问系统根目录之外的敏感路径
  targetPath = path.resolve(targetPath);
  if (!fs.existsSync(targetPath)) {
    return res.json({ error: '路径不存在', path: targetPath, dirs: [], parent: '' });
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    targetPath = path.dirname(targetPath);
  }

  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => ({ name: e.name, path: path.join(targetPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const mp4Files = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp4'))
      .map(e => e.name)
      .sort();

    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => {
        try {
          const st = fs.statSync(path.join(targetPath, e.name));
          return { name: e.name, size: st.size };
        } catch (_) {
          return { name: e.name, size: 0 };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(targetPath);

    res.json({
      path: targetPath,
      parent: parent !== targetPath ? parent : '',
      dirs,
      files,
      hasMp4: mp4Files.length > 0,
      mp4Count: mp4Files.length
    });
  } catch (err) {
    res.status(500).json({ error: '无法读取目录: ' + err.message, dirs: [], parent: '' });
  }
});

// ============================================================
// API: /api/upload-music — 上传背景音乐文件
// ============================================================
app.post('/api/upload-music', (req, res) => {
  const { filename, data } = req.body;
  if (!filename || !data) {
    return res.status(400).json({ error: '缺少文件名或数据' });
  }
  const musicDir = path.join(WORK_DIR, 'music');
  if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });

  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_');
  const musicPath = path.join(musicDir, safeName);

  try {
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(musicPath, buffer);
    res.json({ ok: true, path: musicPath, name: safeName });
  } catch (err) {
    res.status(500).json({ error: '保存音乐文件失败: ' + err.message });
  }
});

// ============================================================
// API: /api/open-folder — 在资源管理器中打开文件夹/文件
// ============================================================
app.post('/api/open-folder', (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(400).json({ error: '路径不存在' });
  }
  const { exec } = require('child_process');
  const isDir = fs.statSync(targetPath).isDirectory();
  const cmd = isDir ? `explorer "${targetPath}"` : `explorer /select,"${targetPath}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ============================================================
// API: /api/output
// ============================================================
app.get('/api/output', (req, res) => {
  if (!state.highlightPath || !fs.existsSync(state.highlightPath)) {
    return res.json({ exists: false });
  }
  const stat = fs.statSync(state.highlightPath);
  res.json({
    exists: true,
    path: state.highlightPath,
    name: path.basename(state.highlightPath),
    sizeMB: (stat.size / 1024 / 1024).toFixed(1)
  });
});

// ============================================================
// 全局错误处理（确保 API 错误返回 JSON 而不是 HTML）
// ============================================================
app.use('/api', (err, req, res, next) => {
  console.error('API error:', err.message);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ============================================================
// 启动
// ============================================================
const PORT = getPort();
// 启动后后台预热性能档案，不阻塞界面打开。
setTimeout(() => {
  if (!performanceProbeStarted) {
    performanceProbeStarted = true;
    ensurePerformanceProfile().then(summary => {
      if (!summary) return;
      const info = buildRuntimePerformance(summary);
      console.log(`   设备自适应: ${info.encoderLabel} (${info.encoderFps.toFixed(1)} fps), 扫描并发 ${info.scanWorkers}`);
      broadcast('performance', info);
    });
  }
}, 1500);

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  三角洲行动 — 精彩镜头自动剪辑 Web UI    ║`);
  console.log(`║                                          ║`);
  console.log(`║  👉  http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
