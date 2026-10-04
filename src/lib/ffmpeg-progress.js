/**
 * FFmpeg -progress 输出解析。
 *
 * 调用方在 ffmpeg 参数中加入 `-progress pipe:1 -nostats`，然后在 stdout 上
 * 使用本模块把 out_time/speed 等键值转换成页面可用的进度事件。
 */

function attachFfmpegProgress(ffmpeg, options = {}) {
  const onProgress = options.onProgress;
  const totalSeconds = Number(options.totalSeconds) || 0;
  if (typeof onProgress !== 'function' || !ffmpeg || !ffmpeg.stdout) return;

  let buffer = '';
  let progress = {};

  function emit() {
    const processedSeconds = progress.out_time_us !== undefined
      ? Number(progress.out_time_us) / 1000000
      : (progress.out_time_ms !== undefined ? Number(progress.out_time_ms) / 1000000 : 0);
    const speedText = String(progress.speed || '').replace(/[^0-9.]/g, '');
    const speed = Number(speedText) || 0;
    const fps = Number(progress.fps) || 0;
    const percent = totalSeconds > 0 ? Math.min(100, Math.max(0, processedSeconds / totalSeconds * 100)) : 0;
    const etaSeconds = totalSeconds > 0 && speed > 0
      ? Math.max(0, (totalSeconds - processedSeconds) / speed)
      : null;

    onProgress({
      processedSeconds: Math.max(0, Number.isFinite(processedSeconds) ? processedSeconds : 0),
      totalSeconds,
      percent,
      speed,
      fps,
      etaSeconds
    });
  }

  ffmpeg.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();

    for (const line of lines) {
      const index = line.indexOf('=');
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      progress[key] = value;
      if (key === 'progress') {
        emit();
        progress = {};
      }
    }
  });
}

module.exports = { attachFfmpegProgress };
