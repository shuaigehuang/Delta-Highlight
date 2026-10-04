/**
 * 配置加载模块
 *
 * 从项目根目录的 config.json 读取配置。
 * 首次启动时若不存在则自动生成模板并提示用户编辑。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  ffmpegPath: 'ffmpeg',
  pythonPath: 'python',
  outputDir: './output',
  materialDir: '',
  port: 3456
};

let config = null;

/**
 * 加载配置（单例）
 */
function loadConfig() {
  if (config) return config;

  if (!fs.existsSync(CONFIG_PATH)) {
    // 自动生成模板
    const example = { ...DEFAULT_CONFIG };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(example, null, 2), 'utf-8');
    console.log('');
    console.log('⚠️  未找到 config.json，已自动生成模板。');
    console.log('   请编辑 config.json 配置 ffmpeg 和 Python 路径后重新启动。');
    console.log('   如果 ffmpeg / python 已在系统 PATH 中，无需修改即可使用。');
    console.log('');
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    console.error('❌ config.json 解析失败，使用默认配置:', err.message);
    config = { ...DEFAULT_CONFIG };
  }

  // 将相对路径解析为绝对路径
  if (config.outputDir && !path.isAbsolute(config.outputDir)) {
    config.outputDir = path.resolve(ROOT, config.outputDir);
  }

  return config;
}

/**
 * 将安装根目录下的相对路径解析为绝对路径
 */
function resolveInstallPath(value) {
  if (!value || value === 'ffmpeg' || value === 'ffprobe' || value === 'python' || value === 'python3') return value;
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(ROOT), value);
}

/**
 * 获取 ffmpeg 路径
 */
function getFfmpegPath() {
  return resolveInstallPath(loadConfig().ffmpegPath);
}

/**
 * 获取 Python 路径
 */
function getPythonPath() {
  return resolveInstallPath(loadConfig().pythonPath);
}

/**
 * 获取素材目录
 */
function getMaterialDir() {
  return resolveInstallPath(loadConfig().materialDir);
}

/**
 * 获取输出目录
 */
function getOutputDir() {
  return resolveInstallPath(loadConfig().outputDir);
}

/**
 * 获取端口
 */
function getPort() {
  return loadConfig().port;
}

module.exports = { loadConfig, getFfmpegPath, getPythonPath, getMaterialDir, getOutputDir, getPort, CONFIG_PATH, ROOT };
