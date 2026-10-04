"""
视频专用击杀UI扫描器 (Video-Only Kill Detection)
================================================
跳过音频检测，直接在视频全片中搜索击杀UI图标。
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
# 只扫描画面中央偏下、表示玩家本人击杀的提示，不扫描右上角全局击杀栏。
# 以原项目 3840×2160 (1423,1432,1000,100) 为中心，并扩大横向范围应对提示左右平移。
ROI = 'auto'
AUTO_SEARCH_REGION_RATIOS = (
    (0.18, 0.56, 0.64, 0.26),
)
AUTO_ROI_RATIO = AUTO_SEARCH_REGION_RATIOS[0]
AUTO_ROI_EXPAND = (0.0, 0.0, 0.0, 0.0)
SCAN_OUTPUT_WIDTH = 1280
AUTO_TEMPLATE_SCALES = (0.24, 0.28, 0.32, 0.36, 0.42)
SCAN_ALGORITHM_VERSION = 5
DEFAULT_THRESHOLD = 0.84       # 中央击杀提示更清晰，使用较高阈值避免误判
DEFAULT_INTERVAL = 0.2         # 采样间隔 (秒) = 5fps
NMS_DIST_X = 30                # NMS 水平去重距离 (像素)
NMS_DIST_Y = 20                # NMS 垂直去重距离 (像素)
MERGE_TIME_GAP = 5.0           # 同一中央击杀UI持续约3秒，留出完整合并窗口

# 模板路径 (相对于脚本: src/ → ../templates/)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(SCRIPT_DIR, '..', 'templates')
TEMPLATES = [
    os.path.join(TEMPLATE_DIR, '01-kill-white.png'),
    os.path.join(TEMPLATE_DIR, '02-vehicle-orange.png'),
    os.path.join(TEMPLATE_DIR, '03-precise-kill-orange.png'),
]

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
                           source_width, source_height):
    """在缩放画面上生成搜索区域，支持 auto 和显式源视频 ROI。"""
    if isinstance(roi_spec, str) and roi_spec == 'auto':
        ratios = AUTO_SEARCH_REGION_RATIOS
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


def resolve_template_scales(scale_spec, scan_width):
    """auto 模式使用在 1280 宽画面上验证过的多档模板尺寸。"""
    factor = max(0.1, float(scan_width) / SCAN_OUTPUT_WIDTH)
    if isinstance(scale_spec, (int, float)):
        return (max(0.08, min(2.0, float(scale_spec) * factor)),)
    return tuple(max(0.08, min(1.0, scale * factor))
                 for scale in AUTO_TEMPLATE_SCALES)


def resize_templates_multiscale(templates, scales):
    """预先缩放模板，避免每帧重复缩放。"""
    resized = []
    for scale in scales:
        for template in templates:
            width = max(1, int(round(template.shape[1] * scale)))
            height = max(1, int(round(template.shape[0] * scale)))
            interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
            resized.append((
                scale,
                cv2.resize(template, (width, height), interpolation=interpolation),
            ))
    return resized


def detect_in_regions(frame, scaled_templates, regions, threshold,
                      source_width, source_height):
    """在中央区域内按多档尺寸匹配，并转换为源视频坐标。"""
    frame_height, frame_width = frame.shape[:2]
    matches = []
    x_ratio = source_width / max(1, frame_width)
    y_ratio = source_height / max(1, frame_height)

    for left, top, right, bottom in regions:
        search = frame[top:bottom, left:right]
        if search.size == 0:
            continue

        for scale, template in scaled_templates:
            template_height, template_width = template.shape[:2]
            if template_width >= search.shape[1] or template_height >= search.shape[0]:
                continue

            result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
            _, confidence, _, location = cv2.minMaxLoc(result)
            if confidence < threshold:
                continue

            center_x = left + location[0] + template_width / 2.0
            center_y = top + location[1] + template_height / 2.0
            matches.append({
                'x': int(round(center_x * x_ratio)),
                'y': int(round(center_y * y_ratio)),
                'confidence': round(float(confidence), 4),
                'scale': float(scale),
            })

    if not matches:
        return []

    matches.sort(key=lambda match: match['confidence'], reverse=True)
    nms = []
    for match in matches:
        if not any(abs(match['x'] - kept['x']) < NMS_DIST_X and
                   abs(match['y'] - kept['y']) < NMS_DIST_Y
                   for kept in nms):
            nms.append(match)
    return nms


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


def scan_video_ffmpeg(video_path, scaled_templates, template_names, regions, threshold,
                      interval, ffmpeg_path, fps, total_frames, duration,
                      source_width, source_height, scan_width, scan_height,
                      threads=0, progress_callback=None):
    """使用 ffmpeg 缩放并灰度输出采样帧，再只搜索中央击杀区域。"""
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

    cmd.extend([
        '-i', video_path,
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
    total_samples = max(1, int(duration / interval)) if duration > 0 else 0
    detections = []
    processed = 0
    last_progress_at = time.monotonic()

    try:
        while True:
            raw = read_exact(proc.stdout, frame_bytes)
            if raw is None:
                break

            frame = np.frombuffer(raw, dtype=np.uint8).reshape((scan_height, scan_width))
            timestamp = processed * interval
            matches = detect_in_regions(
                frame, scaled_templates, regions, threshold, source_width, source_height)

            if matches:
                best = matches[0]
                detections.append({
                    'timestamp': round(timestamp, 3),
                    'frame': int(round(timestamp * fps)),
                    'confidence': best['confidence'],
                    'template': template_names[0] if template_names else 'template',
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


def select_detection_templates(templates, template_names):
    """只保留原始白色骷髅模板，避免右上角全局击杀或载具提示误入。"""
    target = '01-kill-white.png'
    selected = [(template, name) for template, name in zip(templates, template_names)
                if name.lower() == target]
    if selected:
        return ([item[0] for item in selected], [item[1] for item in selected])
    return templates, template_names


def scan_video(video_path, templates, template_names, roi, threshold, interval,
               ffmpeg_path='ffmpeg', threads=0, template_scale='auto',
               progress_callback=None, meta_callback=None):
    """扫描整个视频，只查找玩家本人中央偏下的白色击杀提示。"""
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
    active_regions = resolve_search_regions(
        roi, scan_width, scan_height, fw, fh)
    active_scales = resolve_template_scales(template_scale, scan_width)
    selected_templates, selected_names = select_detection_templates(
        templates, template_names)
    active_templates = resize_templates_multiscale(
        selected_templates, active_scales)
    if not active_regions or not active_templates:
        raise RuntimeError('中央击杀搜索区域或模板为空')

    detections = []
    processed = 0
    decode_mode = 'opencv'

    if ffmpeg_path:
        try:
            detections, processed = scan_video_ffmpeg(
                video_path, active_templates, selected_names, active_regions, threshold,
                interval, ffmpeg_path, fps, total_frames, duration,
                fw, fh, scan_width, scan_height, threads,
                progress_callback=progress_callback,
            )
            decode_mode = 'ffmpeg-fullframe'
        except Exception as exc:
            print(f"     ffmpeg 全画面解码不可用，回退 OpenCV: {exc}")

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
                    scan_frame, active_templates, active_regions, threshold, fw, fh)

                if matches:
                    best = matches[0]
                    detections.append({
                        'timestamp': round(timestamp, 3),
                        'frame': frame_num,
                        'confidence': best['confidence'],
                        'template': selected_names[0] if selected_names else 'template',
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

    # 合并相近检测: 时间窗口内 AND 位置相近的合并为一个击杀
    if detections:
        merged = []
        for d in detections:
            is_dup = False
            for m in merged:
                time_gap = d['timestamp'] - m['timestamp']
                if time_gap < MERGE_TIME_GAP:
                    dx = abs(d['all_matches'][0]['x'] - m['all_matches'][0]['x'])
                    dy = abs(d['all_matches'][0]['y'] - m['all_matches'][0]['y'])
                    if dx < NMS_DIST_X * 2 and dy < NMS_DIST_Y * 2:
                        if d['confidence'] > m['confidence']:
                            m['confidence'] = d['confidence']
                            m['all_matches'] = d['all_matches']
                        is_dup = True
                        break
            if not is_dup:
                merged.append(d)
        detections = merged

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
        'detections': detections,
        'kill_count': len(detections)
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
    print(f"  检测到击杀: {result['kill_count']} 次")

    # 按时间排序后显示
    sorted_detections = sorted(result['detections'], key=lambda d: d['timestamp'])
    if sorted_detections:
        for i, d in enumerate(sorted_detections):
            tpl_short = d['template'].replace('.png', '').replace('01-击杀图标（白色部分）', '白色击杀')
            tpl_short = tpl_short.replace('02-摧毁载具图标（橙色部分）', '橙色载具')
            tpl_short = tpl_short.replace('03-精准击杀图标（橙色部分）', '橙色精准击杀')
            print(f"    {i+1}. {format_timestamp(d['timestamp'])}  "
                  f"置信度={d['confidence']:.3f}  [{tpl_short}]")
    else:
        print(f"    ⚠️  未检测到击杀UI")


def print_summary(all_results, elapsed):
    """打印汇总"""
    total_kills = sum(r['kill_count'] for r in all_results)
    videos_with_kills = sum(1 for r in all_results if r['kill_count'] > 0)

    print(f"\n{'═'*60}")
    print(f"  扫描完成")
    print(f"  {'─'*60}")
    print(f"  总视频数:      {len(all_results)}")
    print(f"  检测到击杀:    {videos_with_kills} 个视频")
    print(f"  总击杀数:      {total_kills}")
    print(f"  总耗时:        {elapsed:.1f}s")
    print(f"{'═'*60}")

    if total_kills == 0:
        print(f"\n  💡 提示: 如果未检测到击杀，可尝试:")
        print(f"     - 适当降低阈值: --threshold 0.82")
        print(f"     - 确认击杀提示位于画面中央偏下")
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
                        help='自定义模板路径 (默认: 白色击杀 + 橙色载具)')
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
        print("   ROI: 自动（中央偏下本人击杀，不扫描右上角全局击杀栏）")
    else:
        print(f"   ROI: ({roi[0]}, {roi[1]}) {roi[2]}×{roi[3]}")
    print(f"   模板缩放: {'自动' if template_scale == 'auto' else template_scale}")
    print(f"   采样间隔: {args.interval}s")
    print(f"   匹配阈值: {args.threshold}")
    print(f"   视频数量: {len(videos)}\n")

    # 扫描
    workers = max(1, min(int(args.workers or 1), len(videos)))
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
                               meta_callback=on_meta)
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
    print(f"并行扫描线程: {workers}\n")
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
        'total_kills': sum(r['kill_count'] for r in all_results),
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
