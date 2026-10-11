"""
视频专用高光UI扫描器 (Four Highlight Template Detection)
================================================
跳过音频检测，直接在视频全片中搜索四种高光UI模板。
使用 OpenCV 模板匹配 + NMS 去重。

用法:
  python scan_video_only.py                          # 扫描 03-素材/ 下所有视频
  python scan_video_only.py <video.mp4>              # 扫描单个视频
  python scan_video_only.py --interval 0.15           # 自定义采样间隔(秒)
  python scan_video_only.py --threshold 0.84          # 自定义匹配阈值
"""

import cv2
import numpy as np
import json
import sys
import os
import glob
import argparse
import time
import subprocess
import hashlib
import io
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows 控制台/管道默认可能是 GBK，含 emoji 的日志会直接抛异常。
for _stream_name in ('stdout', 'stderr'):
    _stream = getattr(sys, _stream_name, None)
    try:
        if _stream is not None and hasattr(_stream, 'reconfigure'):
            _stream.reconfigure(encoding='utf-8', errors='replace')
        elif _stream is not None:
            setattr(sys, _stream_name, io.TextIOWrapper(
                _stream.buffer, encoding='utf-8', errors='replace'))
    except Exception:
        pass


# ============================================================
# 配置
# ============================================================
# 三类击杀提示位于中央偏下；救援标志通常在画面中央，使用单独搜索区域。
ROI = 'auto'
AUTO_KILL_SEARCH_REGION_RATIOS = (
    (0.18, 0.56, 0.64, 0.26),
)
AUTO_RESCUE_SEARCH_REGION_RATIOS = (
    (0.12, 0.28, 0.76, 0.56),
)
AUTO_SEARCH_REGION_RATIOS = AUTO_KILL_SEARCH_REGION_RATIOS
TEMPLATE_SEARCH_REGION_RATIOS = {
    '01-kill-white.png': AUTO_KILL_SEARCH_REGION_RATIOS,
    '02-vehicle-orange.png': AUTO_KILL_SEARCH_REGION_RATIOS,
    '03-precise-kill-orange.png': AUTO_KILL_SEARCH_REGION_RATIOS,
    '04-rescue-white.png': AUTO_RESCUE_SEARCH_REGION_RATIOS,
}
AUTO_ROI_RATIO = AUTO_KILL_SEARCH_REGION_RATIOS[0]
AUTO_ROI_EXPAND = (0.0, 0.0, 0.0, 0.0)
SCAN_OUTPUT_WIDTH = 1280
AUTO_TEMPLATE_SCALES = (0.24, 0.28, 0.32, 0.36, 0.42)
TEMPLATE_SCALE_OVERRIDES = {
    '04-rescue-white.png': (0.24, 0.38, 0.58, 0.82, 1.10, 1.18),
}
TEMPLATE_THRESHOLD_DELTAS = {
    '04-rescue-white.png': -0.04,
}
SCAN_ALGORITHM_VERSION = 11
DEFAULT_THRESHOLD = 0.84       # 中央击杀提示更清晰，使用较高阈值避免误判
DEFAULT_INTERVAL = 0.2         # 采样间隔 (秒) = 5fps
NMS_DIST_X = 30                # NMS 水平去重距离 (像素)
NMS_DIST_Y = 20                # NMS 垂直去重距离 (像素)
MERGE_TIME_GAP = 5.0           # 同一中央击杀UI持续约3秒，留出完整合并窗口
RESCUE_STATUS_MIN_TEXT_SCORE = 0.50  # 救援文字前缀匹配阈值
RESCUE_CONFIRM_WINDOW = 1.0    # 救援图标需在连续采样中得到多次确认
RESCUE_CONFIRM_MIN_HITS = 2
RESCUE_CONFIRM_DISTANCE = 260   # 画面缩放后的最大横向偏移
RESCUE_ICON_FALLBACK_CONFIDENCE = 0.85  # 无状态框时接受单帧强图标命中
SINGLE_VIDEO_CHUNK_MIN_SECONDS = 180.0
SINGLE_VIDEO_CHUNK_TARGET_SECONDS = 600.0
SINGLE_VIDEO_CHUNK_OVERLAP_SECONDS = 2.0

# 模板路径 (相对于脚本: src/ → ../templates/)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(SCRIPT_DIR, '..', 'templates')
TEMPLATES = [
    os.path.join(TEMPLATE_DIR, '01-kill-white.png'),
    os.path.join(TEMPLATE_DIR, '02-vehicle-orange.png'),
    os.path.join(TEMPLATE_DIR, '03-precise-kill-orange.png'),
    os.path.join(TEMPLATE_DIR, '04-rescue-white.png'),
]
RESCUE_STATUS_TEMPLATE_PATHS = (
    os.path.join(TEMPLATE_DIR, 'internal', 'rescue-status-a.png'),
    os.path.join(TEMPLATE_DIR, 'internal', 'rescue-status-b.png'),
)
_RESCUE_STATUS_TEMPLATES = None

# 素材目录 (相对于脚本: src/ → 项目根目录)
MATERIAL_DIR = os.path.join(SCRIPT_DIR, '..', 'material')

# 输出目录
OUTPUT_DIR = os.path.join(SCRIPT_DIR, '..', 'output')


def emit_event(enabled, payload):
    """输出机器可读事件，供 Web 服务并行扫描时解析。"""
    if enabled:
        print('@@DF_EVENT@@' + json.dumps(payload, ensure_ascii=False), flush=True)


def file_signature(path):
    try:
        stat = os.stat(path)
        return f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return "missing"


def scan_cache_key(video_path, roi, threshold, interval, template_paths):
    roi_signature = roi if isinstance(roi, str) else repr(tuple(roi))
    parts = [
        f'algorithm:{SCAN_ALGORITHM_VERSION}',
        os.path.abspath(video_path),
        file_signature(video_path),
        roi_signature,
        str(threshold),
        str(interval),
    ]
    for path in template_paths:
        parts.append(os.path.abspath(path))
        parts.append(file_signature(path))
    return hashlib.sha1('|'.join(parts).encode('utf-8')).hexdigest()


def load_scan_cache(cache_dir, key):
    if not cache_dir:
        return None
    cache_path = os.path.join(cache_dir, key + '.json')
    try:
        with open(cache_path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def save_scan_cache(cache_dir, key, result):
    if not cache_dir:
        return
    try:
        os.makedirs(cache_dir, exist_ok=True)
        cache_path = os.path.join(cache_dir, key + '.json')
        temp_path = cache_path + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as handle:
            json.dump(result, handle, ensure_ascii=False)
        os.replace(temp_path, cache_path)
    except OSError:
        pass


# ============================================================
# 检测核心
# ============================================================

def load_templates(paths):
    """加载灰度模板，使用 imdecode 绕过 OpenCV 的中文路径问题。"""
    templates = []
    names = []
    for p in paths:
        try:
            with open(p, 'rb') as f:
                data = np.frombuffer(f.read(), dtype=np.uint8)
            tpl = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
            if tpl is None:
                print(f"   ⚠️  无法解码模板: {p}")
                continue
            templates.append(tpl)
            names.append(os.path.basename(p))
        except FileNotFoundError:
            print(f"   ⚠️  模板文件不存在: {p}")
    return templates, names


def event_type_for_template(name):
    """根据模板名称区分击杀与救援高光。"""
    return 'rescue' if 'rescue' in str(name).lower() else 'kill'


def resolve_roi(roi_spec, frame_width, frame_height):
    """将 auto ROI 转换为当前视频尺寸对应的中央击杀提示区域。"""
    if isinstance(roi_spec, str) and roi_spec == 'auto':
        rx, ry, rw, rh = AUTO_ROI_RATIO
        left, top, right, bottom = AUTO_ROI_EXPAND
        x = max(0, int(round(frame_width * (rx - left))))
        y = max(0, int(round(frame_height * (ry - top))))
        w = min(
            frame_width - x,
            int(round(frame_width * (rw + left + right)))
        )
        h = min(
            frame_height - y,
            int(round(frame_height * (rh + top + bottom)))
        )
        return x, y, max(1, w), max(1, h)
    x, y, w, h = [int(value) for value in roi_spec]
    return x, y, w, h


def resolve_scan_size(frame_width, frame_height):
    """固定扫描宽度，避免 4K 长录像逐帧处理巨额像素。"""
    width = max(320, min(SCAN_OUTPUT_WIDTH, int(frame_width or SCAN_OUTPUT_WIDTH)))
    if frame_width > 0:
        height = int(round(frame_height * width / frame_width))
    else:
        height = int(frame_height or 720)
    return width, max(180, height // 2 * 2)


def resolve_search_regions(roi_spec, scan_width, scan_height,
                           source_width, source_height, ratio_sets=None):
    """在缩放画面上生成搜索区域，支持 auto 和显式源视频 ROI。"""
    if isinstance(roi_spec, str) and roi_spec == 'auto':
        ratios = ratio_sets or AUTO_SEARCH_REGION_RATIOS
    else:
        x, y, w, h = [float(value) for value in roi_spec]
        if source_width <= 0 or source_height <= 0:
            return []
        ratios = ((
            x / source_width,
            y / source_height,
            w / source_width,
            h / source_height,
        ),)

    regions = []
    for ratio_x, ratio_y, ratio_w, ratio_h in ratios:
        left = max(0, int(round(scan_width * ratio_x)))
        top = max(0, int(round(scan_height * ratio_y)))
        right = min(scan_width, int(round(scan_width * (ratio_x + ratio_w))))
        bottom = min(scan_height, int(round(scan_height * (ratio_y + ratio_h))))
        if right > left and bottom > top:
            regions.append((left, top, right, bottom))
    return regions


def resolve_template_scales(scale_spec, scan_width, template_name=''):
    """auto 模式使用在 1280 宽画面上验证过的多档模板尺寸。"""
    factor = max(0.1, float(scan_width) / SCAN_OUTPUT_WIDTH)
    if isinstance(scale_spec, (int, float)):
        return (max(0.08, min(2.0, float(scale_spec) * factor)),)
    scales = TEMPLATE_SCALE_OVERRIDES.get(template_name, AUTO_TEMPLATE_SCALES)
    return tuple(max(0.08, min(1.5, scale * factor)) for scale in scales)


def resize_templates_multiscale(templates, template_names, scale_spec, scan_width):
    """预先缩放模板，避免每帧重复缩放。"""
    resized = []
    for template, name in zip(templates, template_names):
        for scale in resolve_template_scales(scale_spec, scan_width, name):
            width = max(1, int(round(template.shape[1] * scale)))
            height = max(1, int(round(template.shape[0] * scale)))
            interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
            resized.append({
                'name': name,
                'scale': float(scale),
                'event_type': event_type_for_template(name),
                'image': cv2.resize(template, (width, height), interpolation=interpolation),
            })
    return resized


def detect_in_regions(frame, scaled_templates, regions_by_name, threshold,
                      source_width, source_height):
    """在中央区域内按多档尺寸匹配，并转换为源视频坐标。"""
    frame_height, frame_width = frame.shape[:2]
    matches = []
    x_ratio = source_width / max(1, frame_width)
    y_ratio = source_height / max(1, frame_height)

    for item in scaled_templates:
        name = item['name']
        template = item['image']
        scale = item['scale']
        event_type = item['event_type']
        effective_threshold = threshold + TEMPLATE_THRESHOLD_DELTAS.get(name, 0.0)

        for left, top, right, bottom in regions_by_name.get(name, ()):
            search = frame[top:bottom, left:right]
            if search.size == 0:
                continue

            template_height, template_width = template.shape[:2]
            if template_width >= search.shape[1] or template_height >= search.shape[0]:
                continue

            result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
            _, confidence, _, location = cv2.minMaxLoc(result)
            if confidence < effective_threshold:
                continue

            center_x = left + location[0] + template_width / 2.0
            center_y = top + location[1] + template_height / 2.0
            matches.append({
                'x': int(round(center_x * x_ratio)),
                'y': int(round(center_y * y_ratio)),
                'confidence': round(float(confidence), 4),
                'scale': float(scale),
                'template': name,
                'event_type': event_type,
            })

    if not matches:
        return []

    matches.sort(key=lambda match: match['confidence'], reverse=True)
    nms = []
    for match in matches:
        if not any(match['event_type'] == kept['event_type'] and
                   abs(match['x'] - kept['x']) < NMS_DIST_X and
                   abs(match['y'] - kept['y']) < NMS_DIST_Y
                   for kept in nms):
            nms.append(match)
    return nms


def load_rescue_status_templates():
    """加载救援状态文字前缀模板，结果只读取一次。"""
    global _RESCUE_STATUS_TEMPLATES
    if _RESCUE_STATUS_TEMPLATES is None:
        loaded = []
        for path in RESCUE_STATUS_TEMPLATE_PATHS:
            try:
                with open(path, 'rb') as handle:
                    data = np.frombuffer(handle.read(), dtype=np.uint8)
                template = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
                if template is not None:
                    loaded.append(template)
            except OSError:
                pass
        _RESCUE_STATUS_TEMPLATES = loaded
    return _RESCUE_STATUS_TEMPLATES


def detect_rescue_status(frame, source_width, source_height):
    """识别救援状态框的进度条和固定文字前缀，避免误报。"""
    if frame is None or frame.size == 0:
        return None
    status_templates = load_rescue_status_templates()
    if not status_templates:
        return None

    frame_height, frame_width = frame.shape[:2]
    region_left = int(round(frame_width * 0.22))
    region_right = int(round(frame_width * 0.78))
    region_top = int(round(frame_height * 0.53))
    region_bottom = int(round(frame_height * 0.70))
    region = frame[region_top:region_bottom, region_left:region_right]
    if region.size == 0:
        return None

    bright = (region >= 170).astype(np.uint8) * 255
    connected = cv2.morphologyEx(
        bright, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1)))
    count, _, stats, _ = cv2.connectedComponentsWithStats(connected, 8)

    best = None
    min_bar_width = frame_width * 0.040
    max_bar_height = frame_height * 0.022
    base_template_scale = frame_width / 1920.0
    for index in range(1, count):
        x, y, bar_width, bar_height, area = stats[index]
        if bar_width < min_bar_width or bar_height > max_bar_height:
            continue

        aspect_ratio = bar_width / max(1, bar_height)
        fill_ratio = area / max(1, bar_width * bar_height)
        if aspect_ratio < 9.0 or fill_ratio < 0.45:
            continue

        center_x = region_left + x + bar_width / 2.0
        center_y = region_top + y + bar_height / 2.0
        if not (frame_width * 0.42 <= center_x <= frame_width * 0.56):
            continue
        if not (frame_height * 0.62 <= center_y <= frame_height * 0.69):
            continue

        text_left = max(0, region_left + x - int(round(bar_width * 0.15)))
        text_right = min(frame_width, region_left + x + int(round(bar_width * 1.15)))
        text_top = max(0, region_top + y - int(round(frame_height * 0.045)))
        text_bottom = max(text_top + 1, region_top + y - 1)
        text = frame[text_top:text_bottom, text_left:text_right]
        if text.size == 0:
            continue

        text_score = 0.0
        for template in status_templates:
            for multiplier in (0.80, 1.00, 1.20, 1.40):
                template_width = max(1, int(round(template.shape[1] * base_template_scale * multiplier)))
                template_height = max(1, int(round(template.shape[0] * base_template_scale * multiplier)))
                if template_width >= text.shape[1] or template_height >= text.shape[0]:
                    continue
                scaled = cv2.resize(
                    template, (template_width, template_height),
                    interpolation=cv2.INTER_AREA)
                result = cv2.matchTemplate(text, scaled, cv2.TM_CCOEFF_NORMED)
                _, score, _, _ = cv2.minMaxLoc(result)
                if score > text_score:
                    text_score = float(score)
        if text_score < RESCUE_STATUS_MIN_TEXT_SCORE:
            continue

        bar_score = (
            0.45 * min(1.0, aspect_ratio / 14.0) +
            0.25 * min(1.0, fill_ratio) +
            0.30 * min(1.0, bar_width / max(1.0, frame_width * 0.08))
        )
        confidence = min(0.995, 0.70 + 0.15 * bar_score + 0.15 * text_score)
        candidate = {
            'x': int(round(center_x * source_width / max(1, frame_width))),
            'y': int(round(center_y * source_height / max(1, frame_height))),
            'confidence': round(confidence, 4),
            'scale': 0.0,
            'template': '04-rescue-white.png',
            'event_type': 'rescue',
            'source': 'status-overlay',
        }
        if best is None or candidate['confidence'] > best['confidence']:
            best = candidate

    return best


def confirm_rescue_detections(detections):
    """过滤单帧救援误报；强图标可单帧确认，其余需要连续帧支持。"""
    rescue_hits = [item for item in detections
                   if item.get('event_type', 'kill') == 'rescue']
    status_hits = [item for item in rescue_hits
                   if item.get('source') == 'status-overlay']

    confirmed = set()
    for index, item in enumerate(rescue_hits):
        if item.get('source') == 'status-overlay':
            confirmed.add(index)
            continue
        status_supported = False
        for status in status_hits:
            if abs(status['timestamp'] - item['timestamp']) > RESCUE_CONFIRM_WINDOW:
                continue
            if abs(status.get('x', 0) - item.get('x', 0)) > RESCUE_CONFIRM_DISTANCE:
                continue
            if abs(status.get('y', 0) - item.get('y', 0)) > RESCUE_CONFIRM_DISTANCE:
                continue
            status_supported = True
            break
        if status_supported:
            confirmed.add(index)
            continue

        support = 0
        strong_icon = item.get('confidence', 0.0) >= RESCUE_ICON_FALLBACK_CONFIDENCE
        for other in rescue_hits:
            if other.get('source') == 'status-overlay':
                continue
            if abs(other['timestamp'] - item['timestamp']) > RESCUE_CONFIRM_WINDOW:
                continue
            if abs(other.get('x', 0) - item.get('x', 0)) > RESCUE_CONFIRM_DISTANCE:
                continue
            if abs(other.get('y', 0) - item.get('y', 0)) > RESCUE_CONFIRM_DISTANCE:
                continue
            support += 1
            strong_icon = (
                strong_icon or
                other.get('confidence', 0.0) >= RESCUE_ICON_FALLBACK_CONFIDENCE
            )
        if strong_icon or support >= RESCUE_CONFIRM_MIN_HITS:
            confirmed.add(index)

    filtered = []
    rescue_index = 0
    for item in detections:
        if item.get('event_type', 'kill') != 'rescue':
            filtered.append(item)
            continue
        if rescue_index in confirmed:
            filtered.append(item)
        rescue_index += 1
    return filtered


def read_exact(stream, size):
    """从管道读取固定长度的数据"""
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def scan_video_ffmpeg(video_path, scaled_templates, regions_by_name, threshold,
                      interval, ffmpeg_path, fps, total_frames, duration,
                      source_width, source_height, scan_width, scan_height,
                      threads=0, progress_callback=None, range_start=0.0,
                      range_duration=None):
    """使用 ffmpeg 扫描指定时间段，输出采样帧并搜索高光区域。"""
    sample_fps = 1.0 / interval
    vf = (f"fps={sample_fps:.6f},scale={scan_width}:{scan_height},"
          "format=gray")
    cmd = [
        ffmpeg_path,
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
    ]

    if threads > 0:
        cmd.extend(['-threads', str(int(threads)), '-filter_threads', str(max(1, int(threads)))])

    range_start = max(0.0, float(range_start or 0.0))
    if range_duration is None or float(range_duration) <= 0:
        range_duration = max(0.0, float(duration or 0.0)) - range_start
    else:
        range_duration = min(
            max(0.0, float(range_duration)),
            max(0.0, float(duration or 0.0) - range_start)
        )

    seek_args = []
    if range_start > 0:
        seek_args.extend(['-ss', f'{range_start:.6f}'])
    duration_args = []
    if range_duration > 0:
        duration_args.extend(['-t', f'{range_duration:.6f}'])

    cmd.extend(seek_args)
    cmd.extend(['-i', video_path])
    cmd.extend(duration_args)
    cmd.extend([
        '-an',
        '-sn',
        '-vf', vf,
        '-pix_fmt', 'gray',
        '-f', 'rawvideo',
        'pipe:1'
    ])

    creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creationflags
    )

    frame_bytes = scan_width * scan_height
    total_samples = (
        max(1, int(range_duration / interval)) if range_duration > 0 else 0
    )
    detections = []
    processed = 0
    last_progress_at = time.monotonic()

    try:
        while True:
            raw = read_exact(proc.stdout, frame_bytes)
            if raw is None:
                break

            frame = np.frombuffer(raw, dtype=np.uint8).reshape((scan_height, scan_width))
            timestamp = range_start + processed * interval
            matches = detect_in_regions(
                frame, scaled_templates, regions_by_name, threshold,
                source_width, source_height)
            status_match = detect_rescue_status(
                frame, source_width, source_height)
            if status_match is not None:
                matches.append(status_match)
            best_by_type = {}
            for match in matches:
                event_type = match.get('event_type', 'kill')
                if event_type not in best_by_type:
                    best_by_type[event_type] = match

            for event_type, best in best_by_type.items():
                detections.append({
                    'timestamp': round(timestamp, 3),
                    'frame': int(round(timestamp * fps)),
                    'x': best['x'],
                    'y': best['y'],
                    'confidence': best['confidence'],
                    'template': best.get('template', 'template'),
                    'event_type': event_type,
                    'source': best.get('source', 'template'),
                    'all_matches': matches
                })

            processed += 1
            if processed % 50 == 0:
                pct = (timestamp / duration * 100) if duration > 0 else 0
                print(f"     [{processed}/{total_samples}] {pct:.0f}% ...")
            now = time.monotonic()
            if progress_callback and (processed % 25 == 0 or now - last_progress_at >= 1.0):
                try:
                    progress_callback(min(timestamp, duration) if duration > 0 else timestamp,
                                      duration, processed, total_samples)
                except Exception:
                    pass
                last_progress_at = now
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    stderr = proc.stderr.read().decode('utf-8', errors='replace').strip()
    if proc.returncode != 0:
        raise RuntimeError(stderr or f'ffmpeg退出码 {proc.returncode}')
    if processed == 0:
        raise RuntimeError('ffmpeg未输出扫描帧')

    return detections, processed


def scan_video_ffmpeg_chunked(video_path, scaled_templates, regions_by_name,
                              threshold, interval, ffmpeg_path, fps,
                              total_frames, duration, source_width,
                              source_height, scan_width, scan_height,
                              threads=0, parallel_chunks=1,
                              progress_callback=None):
    """将长视频切成带重叠的时间段并行扫描，再合并检测结果。"""
    requested = max(1, int(parallel_chunks or 1))
    if requested <= 1 or duration < SINGLE_VIDEO_CHUNK_MIN_SECONDS:
        detections, processed = scan_video_ffmpeg(
            video_path, scaled_templates, regions_by_name, threshold,
            interval, ffmpeg_path, fps, total_frames, duration,
            source_width, source_height, scan_width, scan_height,
            threads=threads, progress_callback=progress_callback
        )
        return detections, processed, 1

    chunk_count = min(
        requested,
        max(1, int((duration + SINGLE_VIDEO_CHUNK_TARGET_SECONDS - 1)
                   // SINGLE_VIDEO_CHUNK_TARGET_SECONDS))
    )
    if chunk_count <= 1:
        detections, processed = scan_video_ffmpeg(
            video_path, scaled_templates, regions_by_name, threshold,
            interval, ffmpeg_path, fps, total_frames, duration,
            source_width, source_height, scan_width, scan_height,
            threads=threads, progress_callback=progress_callback
        )
        return detections, processed, 1

    base_duration = duration / chunk_count
    chunk_ranges = []
    for index in range(chunk_count):
        nominal_start = index * base_duration
        nominal_end = min(duration, (index + 1) * base_duration)
        start = max(
            0.0,
            nominal_start - (SINGLE_VIDEO_CHUNK_OVERLAP_SECONDS if index > 0 else 0.0)
        )
        end = min(
            duration,
            nominal_end + (
                SINGLE_VIDEO_CHUNK_OVERLAP_SECONDS
                if index < chunk_count - 1 else 0.0
            )
        )
        chunk_ranges.append((start, max(0.0, end - start)))

    progress_lock = threading.Lock()
    progress_values = [0.0] * chunk_count
    progress_samples = [0] * chunk_count
    full_total_samples = max(1, int(duration / interval)) if duration > 0 else 0

    def report_chunk_progress(index, local_seconds, local_duration,
                             local_samples, local_total_samples):
        if not progress_callback:
            return
        with progress_lock:
            progress_values[index] = max(
                progress_values[index],
                min(float(local_seconds or 0.0), float(local_duration or 0.0))
            )
            progress_samples[index] = max(
                progress_samples[index], int(local_samples or 0)
            )
            fractions = []
            for value, (_, length) in zip(progress_values, chunk_ranges):
                fractions.append(min(1.0, value / length) if length > 0 else 0.0)
            overall_fraction = sum(fractions) / max(1, len(fractions))
            processed_seconds = min(duration, overall_fraction * duration)
            processed_samples = min(
                full_total_samples,
                int(round(full_total_samples * overall_fraction))
            )
        try:
            progress_callback(processed_seconds, duration, processed_samples,
                              full_total_samples)
        except Exception:
            pass

    per_chunk_threads = int(threads or 0)
    if per_chunk_threads <= 0:
        per_chunk_threads = 2

    def run_chunk(index, start, length):
        def on_chunk_progress(seconds, total, samples, total_samples,
                              chunk_index=index, chunk_start=start,
                              chunk_length=length):
            local_seconds = max(
                0.0, float(seconds or 0.0) - float(chunk_start or 0.0))
            report_chunk_progress(
                chunk_index, local_seconds, chunk_length,
                samples, total_samples)

        return index, scan_video_ffmpeg(
            video_path, scaled_templates, regions_by_name, threshold,
            interval, ffmpeg_path, fps, total_frames, duration,
            source_width, source_height, scan_width, scan_height,
            threads=per_chunk_threads,
            progress_callback=on_chunk_progress,
            range_start=start,
            range_duration=length
        )

    combined = []
    total_processed = 0
    with ThreadPoolExecutor(max_workers=chunk_count) as pool:
        futures = [
            pool.submit(run_chunk, index, start, length)
            for index, (start, length) in enumerate(chunk_ranges)
        ]
        for future in as_completed(futures):
            _, (chunk_detections, processed) = future.result()
            combined.extend(chunk_detections)
            total_processed += processed

    combined.sort(key=lambda item: item.get('timestamp', 0.0))
    return combined, total_processed, chunk_count


def select_detection_templates(templates, template_names):
    """加载四种原始模板，全部命中事件均生成高光片段。"""
    targets = {
        '01-kill-white.png',
        '02-vehicle-orange.png',
        '03-precise-kill-orange.png',
        '04-rescue-white.png',
    }
    selected = [(template, name) for template, name in zip(templates, template_names)
                if name.lower() in targets]
    if selected:
        return ([item[0] for item in selected], [item[1] for item in selected])
    return templates, template_names


def scan_video(video_path, templates, template_names, roi, threshold, interval,
               ffmpeg_path='ffmpeg', threads=0, template_scale='auto',
               progress_callback=None, meta_callback=None,
               parallel_chunks=1):
    """扫描整个视频，查找四种模板对应的高光事件。"""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    if meta_callback:
        try:
            meta_callback(duration, fps, fw, fh, total_frames)
        except Exception:
            pass

    active_roi = resolve_roi(roi, fw, fh)
    scan_width, scan_height = resolve_scan_size(fw, fh)
    selected_templates, selected_names = select_detection_templates(
        templates, template_names)
    regions_by_name = {}
    for name in selected_names:
        ratio_sets = TEMPLATE_SEARCH_REGION_RATIOS.get(name, AUTO_SEARCH_REGION_RATIOS)
        regions_by_name[name] = resolve_search_regions(
            roi, scan_width, scan_height, fw, fh, ratio_sets=ratio_sets)
    active_templates = resize_templates_multiscale(
        selected_templates, selected_names, template_scale, scan_width)
    active_regions = regions_by_name.get(selected_names[0], ()) if selected_names else ()
    active_scales = sorted({item['scale'] for item in active_templates})
    if not regions_by_name or not active_templates:
        raise RuntimeError('中央击杀搜索区域或模板为空')

    detections = []
    processed = 0
    chunk_count = 1
    decode_mode = 'opencv'

    if ffmpeg_path:
        try:
            detections, processed, chunk_count = scan_video_ffmpeg_chunked(
                video_path, active_templates, regions_by_name, threshold,
                interval, ffmpeg_path, fps, total_frames, duration,
                fw, fh, scan_width, scan_height, threads,
                parallel_chunks=parallel_chunks,
                progress_callback=progress_callback,
            )
            decode_mode = (
                f'ffmpeg-chunked-{chunk_count}'
                if chunk_count > 1 else 'ffmpeg-fullframe'
            )
        except Exception as exc:
            print(f"     分段扫描不可用，尝试单进程解码: {exc}")
            try:
                detections, processed = scan_video_ffmpeg(
                    video_path, active_templates, regions_by_name, threshold,
                    interval, ffmpeg_path, fps, total_frames, duration,
                    fw, fh, scan_width, scan_height, threads,
                    progress_callback=progress_callback,
                )
                decode_mode = 'ffmpeg-fullframe'
                chunk_count = 1
            except Exception as fallback_exc:
                print(f"     ffmpeg 解码不可用，回退 OpenCV: {fallback_exc}")

    if decode_mode == 'opencv':
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {video_path}")

        frame_interval = max(1, int(fps * interval))
        total_samples = total_frames // frame_interval
        frame_num = 0
        last_progress_at = time.monotonic()

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_num % frame_interval == 0:
                timestamp = frame_num / fps
                if frame.ndim == 3:
                    scan_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                else:
                    scan_frame = frame
                if scan_frame.shape[1] != scan_width or scan_frame.shape[0] != scan_height:
                    scan_frame = cv2.resize(
                        scan_frame, (scan_width, scan_height), interpolation=cv2.INTER_AREA)
                matches = detect_in_regions(
                    scan_frame, active_templates, regions_by_name, threshold, fw, fh)
                status_match = detect_rescue_status(scan_frame, fw, fh)
                if status_match is not None:
                    matches.append(status_match)

                best_by_type = {}
                for match in matches:
                    event_type = match.get('event_type', 'kill')
                    if event_type not in best_by_type:
                        best_by_type[event_type] = match

                for event_type, best in best_by_type.items():
                    detections.append({
                        'timestamp': round(timestamp, 3),
                        'frame': frame_num,
                        'x': best['x'],
                        'y': best['y'],
                        'confidence': best['confidence'],
                        'template': best.get('template', 'template'),
                        'event_type': event_type,
                        'source': best.get('source', 'template'),
                        'all_matches': matches
                    })

                processed += 1
                if processed % 50 == 0:
                    pct = (frame_num / total_frames * 100) if total_frames > 0 else 0
                    print(f"     [{processed}/{total_samples}] {pct:.0f}% ...")
                now = time.monotonic()
                if progress_callback and (processed % 25 == 0 or now - last_progress_at >= 1.0):
                    try:
                        progress_callback(min(timestamp, duration) if duration > 0 else timestamp,
                                          duration, processed, total_samples)
                    except Exception:
                        pass
                    last_progress_at = now

            frame_num += 1

        cap.release()

    detections = confirm_rescue_detections(detections)

    # 合并相近检测: 时间窗口内 AND 位置相近的合并为一个击杀
    if detections:
        merged = []
        for d in detections:
            is_dup = False
            for m in merged:
                time_gap = d['timestamp'] - m['timestamp']
                if time_gap < MERGE_TIME_GAP:
                    if d.get('event_type', 'kill') != m.get('event_type', 'kill'):
                        continue
                    dx = abs(d.get('x', d['all_matches'][0]['x']) - m.get('x', m['all_matches'][0]['x']))
                    dy = abs(d.get('y', d['all_matches'][0]['y']) - m.get('y', m['all_matches'][0]['y']))
                    event_type = d.get('event_type', 'kill')
                    if event_type == 'rescue':
                        same_location = (
                            dx < RESCUE_CONFIRM_DISTANCE and
                            dy < RESCUE_CONFIRM_DISTANCE
                        )
                    else:
                        same_location = (
                            dx < NMS_DIST_X * 2 and dy < NMS_DIST_Y * 2
                        )
                    if same_location:
                        if d['confidence'] > m['confidence']:
                            m['confidence'] = d['confidence']
                            m['all_matches'] = d['all_matches']
                        is_dup = True
                        break
            if not is_dup:
                merged.append(d)
        detections = merged

    kill_count = sum(1 for d in detections if d.get('event_type', 'kill') == 'kill')
    rescue_count = sum(1 for d in detections if d.get('event_type', 'kill') == 'rescue')

    return {
        'video': video_path,
        'duration': round(duration, 1),
        'fps': round(fps, 2),
        'resolution': f"{fw}x{fh}",
        'roi': list(active_roi),
        'search_regions': [list(region) for region in active_regions],
        'scan_size': [scan_width, scan_height],
        'template_scale': round(active_scales[0], 4),
        'template_scales': [round(scale, 4) for scale in active_scales],
        'total_frames': total_frames,
        'sample_interval': interval,
        'samples_checked': processed,
        'decode_mode': decode_mode,
        'chunks_used': chunk_count,
        'detections': detections,
        'kill_count': kill_count,
        'rescue_count': rescue_count,
        'highlight_count': len(detections)
    }


# ============================================================
# 输出格式化
# ============================================================

def format_timestamp(seconds):
    """秒 → MM:SS.ms"""
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m:02d}:{s:06.3f}"


def print_result(result, idx, total):
    """打印单个视频的检测结果"""
    name = os.path.basename(result['video'])
    print(f"\n{'─'*60}")
    print(f"  [{idx}/{total}] {name}")
    print(f"  时长: {result['duration']}s | 分辨率: {result['resolution']} | "
          f"采样: {result['samples_checked']}帧 (每{result['sample_interval']}s) | "
          f"解码: {result.get('decode_mode', 'opencv')}")
    print(f"  检测到高光: {result['highlight_count']} 次 "
          f"(击杀 {result['kill_count']} / 救援 {result['rescue_count']})")

    # 按时间排序后显示
    sorted_detections = sorted(result['detections'], key=lambda d: d['timestamp'])
    if sorted_detections:
        for i, d in enumerate(sorted_detections):
            template_name = str(d.get('template', '')).lower()
            if d.get('event_type') == 'rescue':
                tpl_short = '救援'
            elif 'vehicle' in template_name:
                tpl_short = '载具击杀'
            elif 'precise' in template_name:
                tpl_short = '精准击杀'
            else:
                tpl_short = '白色击杀'
            print(f"    {i+1}. {format_timestamp(d['timestamp'])}  "
                  f"置信度={d['confidence']:.3f}  [{tpl_short}]")
    else:
        print(f"    ⚠️  未检测到高光事件")


def print_summary(all_results, elapsed):
    """打印汇总"""
    total_kills = sum(r.get('kill_count', 0) for r in all_results)
    total_rescues = sum(r.get('rescue_count', 0) for r in all_results)
    total_highlights = total_kills + total_rescues
    videos_with_highlights = sum(1 for r in all_results if r.get('highlight_count', 0) > 0)

    print(f"\n{'═'*60}")
    print(f"  扫描完成")
    print(f"  {'─'*60}")
    print(f"  总视频数:      {len(all_results)}")
    print(f"  检测到高光:    {videos_with_highlights} 个视频")
    print(f"  总击杀数:      {total_kills}")
    print(f"  总救援数:      {total_rescues}")
    print(f"  总高光事件:    {total_highlights}")
    print(f"  总耗时:        {elapsed:.1f}s")
    print(f"{'═'*60}")
    if total_highlights == 0:
        print(f"\n  💡 提示: 如果未检测到高光事件，可尝试:")
        print(f"     - 适当降低阈值: --threshold 0.82")
        print(f"     - 确认击杀提示位于画面中央偏下、救援标志位于画面中央")
        print(f"     - 确认击杀UI图标与模板匹配")


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='视频专用击杀UI扫描器 — 跳过音频，直接扫描全片',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python scan_video_only.py                          # 扫描 03-素材/ 下所有视频
  python scan_video_only.py video.mp4                # 扫描单个视频
  python scan_video_only.py --interval 0.15           # 更密集采样
  python scan_video_only.py --threshold 0.82          # 降低阈值
  python scan_video_only.py --save results.json       # 保存详细结果
        """
    )
    parser.add_argument('video', nargs='?', default=None,
                        help='单个视频路径 (默认: 扫描 --dir 目录下所有)')
    parser.add_argument('--dir', default=None,
                        help=f'素材目录 (默认: {MATERIAL_DIR})')
    parser.add_argument('--interval', type=float, default=DEFAULT_INTERVAL,
                        help=f'采样间隔秒数 (默认: {DEFAULT_INTERVAL}s = 5fps)')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                        help=f'模板匹配阈值 (默认: {DEFAULT_THRESHOLD})')
    parser.add_argument('--roi', nargs='+', default=['auto'],
                        help='搜索区域: auto 或 X Y W H (默认: auto)')
    parser.add_argument('--template-scale', default='auto',
                        help='模板缩放: auto 或数字 (默认: auto)')
    parser.add_argument('--templates', nargs='+', default=None,
                        help='自定义模板路径 (默认: 白色击杀 + 载具击杀 + 精准击杀 + 救援)')
    parser.add_argument('--ffmpeg', default='ffmpeg',
                        help='ffmpeg 可执行文件路径 (默认: ffmpeg)')
    parser.add_argument('--workers', type=int, default=1,
                        help='并行扫描视频数 (默认: 1)')
    parser.add_argument('--threads', type=int, default=0,
                        help='每个 ffmpeg 扫描进程可用的解码/滤镜线程数 (默认: 自动)')
    parser.add_argument('--cache-dir', default=None,
                        help='扫描结果缓存目录')
    parser.add_argument('--json-events', action='store_true',
                        help='输出 @@DF_EVENT@@ 机器可读事件')
    parser.add_argument('--save', '-s', default=None,
                        help='保存详细JSON结果到指定路径')

    args = parser.parse_args()

    if len(args.roi) == 1 and str(args.roi[0]).lower() == 'auto':
        roi = 'auto'
    elif len(args.roi) == 4:
        try:
            roi = tuple(int(value) for value in args.roi)
        except ValueError:
            parser.error('--roi 必须是 auto 或四个整数')
    else:
        parser.error('--roi 必须是 auto 或四个整数')

    if str(args.template_scale).lower() == 'auto':
        template_scale = 'auto'
    else:
        try:
            template_scale = float(args.template_scale)
        except ValueError:
            parser.error('--template-scale 必须是 auto 或数字')

    # 确定视频列表
    if args.video:
        if not os.path.exists(args.video):
            print(f"❌ 视频不存在: {args.video}")
            sys.exit(1)
        videos = [args.video]
    else:
        material_dir = args.dir if args.dir else MATERIAL_DIR
        if not os.path.isdir(material_dir):
            print(f"❌ 素材目录不存在: {material_dir}")
            sys.exit(1)
        videos = sorted(glob.glob(os.path.join(material_dir, '*.mp4')))
        if not videos:
            print(f"❌ 素材目录中没有 .mp4 文件: {material_dir}")
            sys.exit(1)

    # 加载模板
    template_paths = args.templates if args.templates else TEMPLATES
    for tp in template_paths:
        if not os.path.exists(tp):
            print(f"❌ 模板不存在: {tp}")
            sys.exit(1)

    print(f"📁 加载 {len(template_paths)} 个模板...")
    templates, template_names = load_templates(template_paths)
    detection_templates, detection_names = select_detection_templates(
        templates, template_names)
    print(f"   实际识别: {', '.join(detection_names)}\n")

    print(f"⚙️  配置:")
    if isinstance(roi, str):
        print("   ROI: 自动（本人击杀中央偏下，救援标志画面中央）")
    else:
        print(f"   ROI: ({roi[0]}, {roi[1]}) {roi[2]}×{roi[3]}")
    print(f"   模板缩放: {'自动' if template_scale == 'auto' else template_scale}")
    print(f"   采样间隔: {args.interval}s")
    print(f"   匹配阈值: {args.threshold}")
    print(f"   视频数量: {len(videos)}\n")

    # 扫描
    workers = max(1, min(int(args.workers or 1), len(videos)))
    requested_workers = max(1, int(args.workers or 1))
    parallel_chunks_per_video = max(1, requested_workers // max(1, len(videos)))
    events_enabled = bool(args.json_events)
    t0 = time.time()

    def run_one(index, vpath):
        name = os.path.basename(vpath)
        cache_key = scan_cache_key(vpath, roi, args.threshold, args.interval, template_paths)
        emit_event(events_enabled, {
            'type': 'video_start',
            'index': index,
            'total': len(videos),
            'video': vpath,
            'name': name,
        })

        cached = load_scan_cache(args.cache_dir, cache_key)
        if cached is not None:
            cached = dict(cached)
            cached_kills = int(cached.get('kill_count') or 0)
            cached_rescues = cached.get('rescue_count')
            if cached_rescues is None:
                cached_rescues = sum(
                    1 for item in cached.get('detections', [])
                    if item.get('event_type') == 'rescue')
            cached['kill_count'] = cached_kills
            cached['rescue_count'] = int(cached_rescues)
            cached['highlight_count'] = int(
                cached.get('highlight_count')
                or cached['kill_count'] + cached['rescue_count'])
            cached['cached'] = True
            cached_duration = float(cached.get('duration') or 0)
            emit_event(events_enabled, {
                'type': 'video_meta',
                'index': index,
                'total': len(videos),
                'duration': cached_duration,
            })
            emit_event(events_enabled, {
                'type': 'video_progress',
                'index': index,
                'duration': cached_duration,
                'processed_seconds': cached_duration,
                'percent': 100,
                'cached': True,
            })
            print(f"🎬 [{index}/{len(videos)}] 缓存命中: {name}")
            print_result(cached, index, len(videos))
            emit_event(events_enabled, {
                'type': 'video_done',
                'index': index,
                'total': len(videos),
                'video': vpath,
                'name': name,
                'cached': True,
                'duration': cached.get('duration', 0),
                'kill_count': cached.get('kill_count', 0),
                'rescue_count': cached.get('rescue_count', 0),
                'highlight_count': cached.get('highlight_count', cached.get('kill_count', 0)),
                'detections': cached.get('detections', []),
                'result': cached,
            })
            return index, cached

        print(f"🎬 [{index}/{len(videos)}] 扫描: {name}")
        try:
            def on_meta(duration, fps_value, frame_width, frame_height, total_frames):
                emit_event(events_enabled, {
                    'type': 'video_meta',
                    'index': index,
                    'total': len(videos),
                    'duration': float(duration or 0),
                    'fps': float(fps_value or 0),
                    'resolution': f"{int(frame_width)}x{int(frame_height)}",
                    'total_frames': int(total_frames or 0),
                })

            def on_progress(processed_seconds, duration, processed_samples, total_samples):
                percent = (processed_seconds / duration * 100) if duration > 0 else 0
                emit_event(events_enabled, {
                    'type': 'video_progress',
                    'index': index,
                    'duration': float(duration or 0),
                    'processed_seconds': float(processed_seconds or 0),
                    'percent': round(min(100.0, max(0.0, percent)), 2),
                    'processed_samples': int(processed_samples or 0),
                    'total_samples': int(total_samples or 0),
                })

            result = scan_video(vpath, templates, template_names, roi,
                               args.threshold, args.interval, args.ffmpeg, args.threads,
                               template_scale=template_scale,
                               progress_callback=on_progress,
                               meta_callback=on_meta,
                               parallel_chunks=parallel_chunks_per_video)
            result['cached'] = False
            save_scan_cache(args.cache_dir, cache_key, result)
            print_result(result, index, len(videos))
            emit_event(events_enabled, {
                'type': 'video_done',
                'index': index,
                'total': len(videos),
                'video': vpath,
                'name': name,
                'cached': False,
                'duration': result.get('duration', 0),
                'kill_count': result.get('kill_count', 0),
                'rescue_count': result.get('rescue_count', 0),
                'highlight_count': result.get('highlight_count', result.get('kill_count', 0)),
                'detections': result.get('detections', []),
                'result': result,
            })
            return index, result
        except Exception as e:
            print(f"   ❌ 错误: {e}")
            failure = {
                'video': vpath,
                'error': str(e),
                'kill_count': 0,
                'rescue_count': 0,
                'highlight_count': 0,
                'detections': []
            }
            emit_event(events_enabled, {
                'type': 'video_error',
                'index': index,
                'total': len(videos),
                'video': vpath,
                'name': name,
                'error': str(e),
                'result': failure,
            })
            return index, failure

    results_by_index = {}
    print(
        f"并行扫描: {workers} 个视频并发，单视频最多 "
        f"{parallel_chunks_per_video} 段并发\n"
    )
    if workers == 1:
        for i, vpath in enumerate(videos, 1):
            idx, result = run_one(i, vpath)
            results_by_index[idx] = result
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(run_one, i, vpath)
                       for i, vpath in enumerate(videos, 1)]
            for future in as_completed(futures):
                idx, result = future.result()
                results_by_index[idx] = result

    all_results = [results_by_index[i] for i in sorted(results_by_index)]
    elapsed = time.time() - t0
    print_summary(all_results, elapsed)

    # 保存结果
    output = {
        'config': {
            'roi': list(roi),
            'threshold': args.threshold,
            'interval': args.interval,
            'templates': template_names
        },
        'scanned_at': time.strftime('%Y-%m-%d %H:%M:%S'),
        'elapsed_seconds': round(elapsed, 1),
        'total_videos': len(all_results),
        'total_kills': sum(r.get('kill_count', 0) for r in all_results),
        'total_rescues': sum(r.get('rescue_count', 0) for r in all_results),
        'total_highlights': sum(r.get('highlight_count', 0) for r in all_results),
        'results': all_results
    }

    save_path = args.save
    if not save_path:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        save_path = os.path.join(OUTPUT_DIR,
                                 f"video-scan-{time.strftime('%Y%m%d-%H%M%S')}.json")

    with open(save_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n💾 详细结果已保存: {save_path}")


if __name__ == '__main__':
    main()
