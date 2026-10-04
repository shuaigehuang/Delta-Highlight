/**
 * 镜头日志生成器 (Shotlog)
 *
 * 读取视频扫描结果 JSON，根据剪辑配置生成镜头日志。
 *
 * 合并规则:
 *   - 同一视频中，多个击杀间隔 ≤ mergeMaxGapSeconds → 合并为一个片段
 *   - 片段范围: [最早击杀 - beforeSeconds, 最晚击杀 + afterSeconds]
 *   - 片段内标记所有击杀时间点，便于人工微调
 *
 * 输出格式 (shotlog):
 * {
 *   version, materialDir, config, generatedAt,
 *   clips: [{ sourceFile, killTimes, maxConfidence, clipStart, clipEnd, mergedFrom }]
 * }
 */

const path = require('path');

// 默认剪辑配置 (对齐策划方案)
const DEFAULT_CONFIG = {
  beforeSeconds: 5,
  afterSeconds: 2,
  mergeMaxGapSeconds: Infinity,  // 默认不拆分，同一视频的所有击杀合并为一个片段
  minClipDuration: 3    // 最短视频片段 (秒)
};

/**
 * 从扫描结果生成镜头日志
 *
 * @param {object} scanResult - scan_video_only.py 输出的 JSON
 * @param {object} config - 剪辑配置 (可选)
 * @param {string} materialDir - 素材目录路径 (可选，写入 shotlog 便于后续加载)
 * @returns {object} shotlog
 */
function generateShotlog(scanResult, config = {}, materialDir = '') {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const clips = [];

  for (const videoResult of scanResult.results) {
    const sourceFile = path.basename(videoResult.video);
    const duration = videoResult.duration || 999;

    // 无击杀的视频也生成记录 (duration=0, 生成时跳过, 供用户手动编辑)
    if (!videoResult.detections || videoResult.detections.length === 0) {
      clips.push({
        sourceFile,
        killTimes: [],
        maxConfidence: 0,
        clipStart: 0,
        clipEnd: 0,
        duration: 0,
        mergedFrom: 0,
        videoDuration: round(duration, 1),
        noKill: true
      });
      continue;
    }

    // 按时间排序
    const kills = [...videoResult.detections].sort((a, b) => a.timestamp - b.timestamp);

    // 将击杀按间隔分组 (间隔 ≤ mergeMaxGapSeconds 的归为一组)
    const groups = [];
    let currentGroup = [kills[0]];

    for (let i = 1; i < kills.length; i++) {
      const gap = kills[i].timestamp - kills[i - 1].timestamp;
      if (gap <= cfg.mergeMaxGapSeconds) {
        currentGroup.push(kills[i]);
      } else {
        groups.push(currentGroup);
        currentGroup = [kills[i]];
      }
    }
    groups.push(currentGroup);

    // 每组生成一个 clip
    for (const group of groups) {
      const timestamps = group.map(k => k.timestamp);
      const confidences = group.map(k => k.confidence);

      const firstKill = Math.min(...timestamps);
      const lastKill = Math.max(...timestamps);

      let clipStart = Math.max(0, firstKill - cfg.beforeSeconds);
      let clipEnd = Math.min(duration, lastKill + cfg.afterSeconds);

      // 确保最小时长
      if (clipEnd - clipStart < cfg.minClipDuration) {
        const center = (clipStart + clipEnd) / 2;
        clipStart = Math.max(0, center - cfg.minClipDuration / 2);
        clipEnd = Math.min(duration, center + cfg.minClipDuration / 2);
      }

      clips.push({
        sourceFile,
        killTimes: timestamps.map(t => round(t, 3)),
        maxConfidence: round(Math.max(...confidences), 4),
        clipStart: round(clipStart, 3),
        clipEnd: round(clipEnd, 3),
        duration: round(clipEnd - clipStart, 3),
        mergedFrom: group.length
      });
    }
  }

  // 按源文件排序
  clips.sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
    return a.clipStart - b.clipStart;
  });

  return {
    version: '1.3',
    materialDir: materialDir || '',
    config: cfg,
    generatedAt: new Date().toISOString(),
    totalClips: clips.length,
    clips
  };
}

/**
 * 将 shotlog 保存为 JSON 文件
 */
function saveShotlog(shotlog, outputPath) {
  const fs = require('fs');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(shotlog, null, 2), 'utf-8');
  return outputPath;
}

/**
 * 打印 shotlog 摘要
 */
function printSummary(shotlog) {
  console.log(`\n📋 镜头日志摘要`);
  console.log(`   ────────────────`);
  console.log(`   总片段数:    ${shotlog.totalClips}`);
  console.log(`   剪辑参数:    前${shotlog.config.beforeSeconds}s / 后${shotlog.config.afterSeconds}s`);
  console.log(`   合并间隔:    ≤${shotlog.config.mergeMaxGapSeconds}s`);
  console.log();

  for (let i = 0; i < shotlog.clips.length; i++) {
    const c = shotlog.clips[i];
    const killInfo = c.killTimes.length === 1
      ? `击杀@${c.killTimes[0]}s`
      : `${c.killTimes.length}次击杀@${c.killTimes.join('s, ')}s`;
    console.log(`   [${String(i + 1).padStart(2, '0')}] ${c.sourceFile}`);
    console.log(`       ${fmtTime(c.clipStart)} → ${fmtTime(c.clipEnd)}  (${c.duration.toFixed(1)}s)  ${killInfo}`);
  }
}

function round(v, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(v * m) / m;
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(4, '0')}`;
}

module.exports = { generateShotlog, saveShotlog, printSummary, DEFAULT_CONFIG };
