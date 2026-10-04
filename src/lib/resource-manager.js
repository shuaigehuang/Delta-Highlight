/**
 * 资源上限与设备自适应分配
 *
 * 自动模式根据 CPU、内存、磁盘和可用编码器选择资源档位。
 * 用户可以在 Web UI 中覆盖档位，或自定义 CPU / GPU 占用上限。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('../config');

const SETTINGS_FILE = path.join(ROOT, 'work', 'resource-settings.json');

const PRESETS = {
  eco: {
    id: 'eco',
    label: '省资源',
    cpuPercent: 35,
    gpuPercent: 50,
    description: '电脑仍可流畅办公和游戏'
  },
  balanced: {
    id: 'balanced',
    label: '平衡',
    cpuPercent: 65,
    gpuPercent: 80,
    description: '速度与前台体验兼顾'
  },
  performance: {
    id: 'performance',
    label: '满性能',
    cpuPercent: 95,
    gpuPercent: 100,
    description: '优先使用全部可用硬件能力'
  }
};

const MODE_ORDER = ['auto', 'eco', 'balanced', 'performance'];
const CUSTOM_MODE = 'custom';

let cachedSettings = null;

function clamp(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function getLogicalProcessors() {
  return Math.max(1, os.cpus().length || 1);
}

function getTotalMemoryGB() {
  return os.totalmem() / 1024 / 1024 / 1024;
}

function getSystemInfo(profile, performance) {
  const system = profile && profile.system ? profile.system : {};
  return {
    logicalProcessors: Number(system.cpu && system.cpu.logicalProcessors) || getLogicalProcessors(),
    memoryGB: Number(system.memory && system.memory.totalGB) || Number(getTotalMemoryGB().toFixed(1)),
    diskReadMBps: Number(system.disk && system.disk.readMBps) || 0
  };
}

function getEncoderKind(profile, performance) {
  if (profile && profile.recommended && profile.recommended.encoderKind) {
    return profile.recommended.encoderKind;
  }
  if (performance && performance.encoderKind) return performance.encoderKind;
  return 'x264';
}

function getBaseScanWorkers(profile, performance) {
  if (profile && profile.recommended && profile.recommended.scanWorkers) {
    return Number(profile.recommended.scanWorkers) || 1;
  }
  if (performance && performance.scanWorkers) {
    return Number(performance.scanWorkers) || 1;
  }
  return 1;
}

/**
 * 根据设备能力给出默认档位。低配机器偏保守，高配机器优先速度。
 */
function detectAutoMode(profile, performance) {
  const system = getSystemInfo(profile, performance);
  const encoderKind = getEncoderKind(profile, performance);
  let score = 0;

  if (system.logicalProcessors >= 16) score += 3;
  else if (system.logicalProcessors >= 12) score += 2;
  else if (system.logicalProcessors >= 8) score += 1;

  if (system.memoryGB >= 32) score += 2;
  else if (system.memoryGB >= 16) score += 1;

  if (system.diskReadMBps >= 1200) score += 2;
  else if (system.diskReadMBps >= 400) score += 1;

  if (encoderKind !== 'x264') score += 2;

  if (score >= 7) return 'performance';
  if (score >= 2) return 'balanced';
  return 'eco';
}

function getPresetValues(mode, autoMode) {
  const effectiveMode = mode === 'auto' ? autoMode : mode;
  return PRESETS[effectiveMode] || PRESETS.balanced;
}

function normalizeSettings(input, profile, performance) {
  const autoMode = detectAutoMode(profile, performance);
  const requestedMode = input && MODE_ORDER.concat(CUSTOM_MODE).includes(input.mode)
    ? input.mode
    : 'auto';
  const preset = getPresetValues(requestedMode, autoMode);

  let cpuPercent = clamp(input && input.cpuPercent, 20, 100, preset.cpuPercent);
  let gpuPercent = clamp(input && input.gpuPercent, 20, 100, preset.gpuPercent);
  let mode = requestedMode;

  if (mode !== CUSTOM_MODE && input && (input.cpuPercent !== undefined || input.gpuPercent !== undefined)) {
    const cpuChanged = cpuPercent !== preset.cpuPercent;
    const gpuChanged = gpuPercent !== preset.gpuPercent;
    if (cpuChanged || gpuChanged) mode = CUSTOM_MODE;
  }

  if (mode === CUSTOM_MODE && !input) {
    mode = 'auto';
    cpuPercent = PRESETS[autoMode].cpuPercent;
    gpuPercent = PRESETS[autoMode].gpuPercent;
  }

  return {
    version: 1,
    mode,
    autoMode,
    cpuPercent,
    gpuPercent
  };
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const temp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(temp, SETTINGS_FILE);
  } catch (_) {
    // 资源设置写入失败不应影响剪辑。
  }
}

function computeEffective(settings, profile, performance) {
  const system = getSystemInfo(profile, performance);
  const encoderKind = getEncoderKind(profile, performance);
  const baseScanWorkers = Math.max(1, getBaseScanWorkers(profile, performance));
  const cpuRatio = settings.cpuPercent / 100;
  const gpuRatio = settings.gpuPercent / 100;

  const scanWorkers = Math.max(
    1,
    Math.min(baseScanWorkers, Math.round(baseScanWorkers * cpuRatio))
  );

  const cpuThreadBudget = Math.max(1, Math.floor(system.logicalProcessors * cpuRatio));
  const unlimitedThreads = settings.cpuPercent >= 90;
  const scanThreadsPerProcess = unlimitedThreads
    ? 0
    : Math.max(1, Math.floor(cpuThreadBudget / scanWorkers));
  const encoderThreads = unlimitedThreads
    ? 0
    : Math.max(1, Math.min(system.logicalProcessors, cpuThreadBudget));

  let encodeConcurrency = 1;
  if (encoderKind === 'x264') {
    encodeConcurrency = Math.max(1, Math.min(2, Math.floor(cpuThreadBudget / 6)));
  } else if (settings.gpuPercent >= 95) {
    // 单个 NVENC/QSV/AMF 会话本身会自动跑满；只有满性能档才尝试多会话并行。
    encodeConcurrency = 2;
  }

  return {
    scanWorkers,
    scanThreadsPerProcess,
    encoderThreads,
    encodeConcurrency,
    cpuThreadBudget,
    gpuRatio
  };
}

function buildResourceSummary(profile, performance, input) {
  const loaded = input || cachedSettings || readSettings();
  const settings = normalizeSettings(loaded, profile, performance);
  cachedSettings = settings;
  const effective = computeEffective(settings, profile, performance);

  return {
    mode: settings.mode,
    autoMode: settings.autoMode,
    autoModeLabel: settings.autoMode === 'performance'
      ? '满性能'
      : (settings.autoMode === 'balanced' ? '平衡' : '省资源'),
    cpuPercent: settings.cpuPercent,
    gpuPercent: settings.gpuPercent,
    effective,
    presets: PRESETS,
    modes: [
      { id: 'auto', label: '自动', description: '按本机硬件自动分配' },
      { id: 'eco', ...PRESETS.eco },
      { id: 'balanced', ...PRESETS.balanced },
      { id: 'performance', ...PRESETS.performance }
    ]
  };
}

function getResourceSummary(profile, performance) {
  return buildResourceSummary(profile, performance);
}

function updateResourceSummary(profile, performance, input) {
  const settings = normalizeSettings(input, profile, performance);
  cachedSettings = settings;
  saveSettings(settings);
  return buildResourceSummary(profile, performance, settings);
}

module.exports = {
  SETTINGS_FILE,
  getResourceSummary,
  updateResourceSummary,
  computeEffective
};
