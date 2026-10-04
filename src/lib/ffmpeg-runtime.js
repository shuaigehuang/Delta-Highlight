/**
 * ffmpeg 运行环境探测
 *
 * 优先使用当前电脑上可正常初始化 NVENC 的 ffmpeg。
 * 例如三角洲行动自带的录制组件就包含较新的 ffmpeg；
 * 找不到时可继续使用 config.json 中配置的版本。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../config');

let cachedRuntime = null;

function deriveFfprobePath(ffmpegPath) {
  return path.isAbsolute(ffmpegPath)
    ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
    : 'ffprobe';
}

function addCandidate(list, candidate) {
  if (!candidate) return;
  const resolved = path.isAbsolute(candidate) ? candidate : candidate;
  if (!list.includes(resolved)) list.push(resolved);
}

function addGameFfmpegCandidates(list) {
  const drives = ['C:', 'D:', 'E:', 'F:'];
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

function nvencWorks(ffmpegPath) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=256x256:r=30:d=0.2',
    '-frames:v', '2',
    '-an',
    '-c:v', 'h264_nvenc',
    '-preset', 'p4',
    '-tune', 'hq',
    '-rc', 'vbr',
    '-cq', '28',
    '-b:v', '0',
    '-f', 'null',
    '-'
  ];

  try {
    const result = spawnSync(ffmpegPath, args, {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8'
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function getFfmpegRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const configured = getFfmpegPath();
  const candidates = [];

  addCandidate(candidates, process.env.DF_FFMPEG_PATH);
  addCandidate(candidates, configured);
  addGameFfmpegCandidates(candidates);

  let ffmpegPath = configured;
  let hardware = 'none';

  for (const candidate of candidates) {
    const isCommand = !path.isAbsolute(candidate);
    if (!isCommand && !fs.existsSync(candidate)) continue;
    if (nvencWorks(candidate)) {
      ffmpegPath = candidate;
      hardware = 'nvenc';
      break;
    }
  }

  cachedRuntime = {
    ffmpegPath,
    ffprobePath: deriveFfprobePath(ffmpegPath),
    hardware,
    videoCodec: hardware === 'nvenc' ? 'h264_nvenc' : 'libx264'
  };

  return cachedRuntime;
}

function buildVideoEncoderArgs(options = {}) {
  const requestedCodec = String(options.videoCodec || '').toLowerCase();
  const codec = ['h264_nvenc', 'h264_qsv', 'libx264'].includes(requestedCodec)
    ? requestedCodec
    : 'libx264';
  const args = ['-c:v', codec];

  if (codec === 'h264_nvenc') {
    args.push(
      '-preset', String(options.nvencPreset || 'p4'),
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', String(options.cq !== undefined ? options.cq : 23),
      '-b:v', '0'
    );
    return args;
  }

  if (codec === 'h264_qsv') {
    args.push(
      '-preset', options.preset || 'veryfast',
      '-global_quality', String(options.cq !== undefined ? options.cq : options.crf || 23)
    );
    return args;
  }

  args.push(
    '-crf', String(options.crf !== undefined ? options.crf : 18),
    '-preset', options.preset || 'veryfast'
  );
  return args;
}

module.exports = {
  getFfmpegRuntime,
  buildVideoEncoderArgs,
  deriveFfprobePath
};
