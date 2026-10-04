/**
 * Delta Force 精彩镜头自动剪辑 — Web UI
 * Vue 3 应用逻辑 (V1.1)
 */

const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    // ============================================================
    // 标签
    // ============================================================
    const tabs = [
      { id: 'scan', label: '🔍 扫描剪辑' },
      { id: 'edit', label: '✏️ 镜头编辑' },
      { id: 'audio', label: '🎵 音频' },
      { id: 'preview', label: '🎬 预览' }
    ];
    const activeTab = ref('scan');

    // ============================================================
    // 扫描页
    // ============================================================
    const materialDir = ref(localStorage.getItem('df_materialDir') || '');
    const state = reactive({
      running: false, done: false, error: false,
      timer: 0, stepMsg: '',
      videos: [],
      progress: {
        phase: '', label: '', detail: '', percent: 0,
        etaSeconds: null, estimatedFinishAt: null
      }
    });
    const output = reactive({ exists: false, path: '', name: '', sizeMB: '' });

    let eventSource = null;
    let timerInterval = null;

    // ============================================================
    // 加载对话框
    // ============================================================
    const showLoadDialog = ref(false);
    const dragOver = ref(false);
    const fileInput = ref(null);
    const loadState = reactive({
      shotlogPath: '',
      shotlogContent: null,  // JSON 内容 (来自拖拽/文件选择)
      materialDir: '',
      needDir: false,
      missingDir: false,
      missingDirMsg: '',
      statusMsg: '',
      statusType: ''
    });

    const canLoad = computed(() => {
      return !!(loadState.shotlogContent || loadState.shotlogPath);
    });

    // ============================================================
    // 编辑页
    // ============================================================
    const shotlog = ref(null);
    const loadingShotlog = ref(false);

    // 目录浏览器
    const showDirBrowser = ref(false);
    const dirBrowser = reactive({ path: '', pathInput: '', dirs: [], files: [], parent: '', hasMp4: false, mp4Count: 0, loading: false });
    const dirPickerBusy = ref(false);
    const dirPickerTarget = ref('');
    let dirBrowserTarget = ''; // 'material' | 'output' | 'loadMaterial'
    const dirBrowserTitle = computed(() => {
      if (dirBrowserTarget === 'output') return '选择输出目录';
      return '选择素材目录';
    });
    const materialDirError = ref('');

    // 输出设置
    const showOutputDialog = ref(false);
const outputSettings = reactive({ name: '', dir: '', compat: false, quality: 'original' });
    const defaultOutputDir = ref('');
    let pendingOutputAction = null; // 'scan' | 'reclip'

    // 音频设置
    const audioSettings = reactive({ enabled: false, fileName: '', musicPath: '', originalDb: 0, musicDb: -10 });
    const musicInput = ref(null);

    // 环境自检
    const env = ref(null);
    const performanceInfo = ref(null);
    const envChecking = ref(false);

    // 资源上限
    const resourceInfo = ref(null);
    const showResourceDialog = ref(false);
    const resourceSaveMsg = ref('');
    const resourceSaveType = ref('');
    const resourceDraft = reactive({ mode: 'auto', cpuPercent: 65, gpuPercent: 80 });
    const fallbackResourceModes = [
      { id: 'auto', label: '自动', description: '按本机硬件自动分配' },
      { id: 'eco', label: '省资源', description: '电脑仍可流畅办公和游戏' },
      { id: 'balanced', label: '平衡', description: '速度与前台体验兼顾' },
      { id: 'performance', label: '满性能', description: '优先使用全部可用硬件能力' }
    ];
    const resourceModes = computed(() => resourceInfo.value && resourceInfo.value.modes ? resourceInfo.value.modes : fallbackResourceModes);
    const resourceButtonLabel = computed(() => {
      if (!resourceInfo.value) return '检测中';
      const mode = resourceInfo.value.mode;
      if (mode === 'auto') return '自动（' + resourceInfo.value.autoModeLabel + '）';
      if (mode === 'custom') return '自定义 ' + resourceInfo.value.cpuPercent + '% / ' + resourceInfo.value.gpuPercent + '%';
      const item = resourceModes.value.find(m => m.id === mode);
      return item ? item.label : mode;
    });

    async function loadResourceSettings() {
      try {
        const res = await fetch('/api/resources');
        if (!res.ok) return;
        resourceInfo.value = await res.json();
      } catch (_) {}
    }

    function openResourceDialog() {
      if (state.running) return;
      resourceSaveMsg.value = '';
      resourceSaveType.value = '';
      if (resourceInfo.value) {
        resourceDraft.mode = resourceInfo.value.mode;
        resourceDraft.cpuPercent = resourceInfo.value.cpuPercent;
        resourceDraft.gpuPercent = resourceInfo.value.gpuPercent;
      }
      showResourceDialog.value = true;
    }

    function selectResourceMode(mode) {
      resourceDraft.mode = mode;
      if (!resourceInfo.value) return;
      if (mode === 'auto') {
        const autoPreset = resourceInfo.value.presets[resourceInfo.value.autoMode];
        if (autoPreset) {
          resourceDraft.cpuPercent = autoPreset.cpuPercent;
          resourceDraft.gpuPercent = autoPreset.gpuPercent;
        }
      } else {
        const preset = resourceInfo.value.presets[mode];
        if (preset) {
          resourceDraft.cpuPercent = preset.cpuPercent;
          resourceDraft.gpuPercent = preset.gpuPercent;
        }
      }
    }

    function markResourceCustom() {
      resourceDraft.mode = 'custom';
    }

    async function saveResourceSettings() {
      resourceSaveMsg.value = '正在保存...';
      resourceSaveType.value = '';
      try {
        const res = await fetch('/api/resources', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resourceDraft)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
        resourceInfo.value = data.resource;
        if (data.performance) performanceInfo.value = data.performance;
        resourceSaveMsg.value = '已保存，下一次任务生效';
        resourceSaveType.value = 'ok';
      } catch (err) {
        resourceSaveMsg.value = '保存失败: ' + err.message;
        resourceSaveType.value = 'error';
      }
    }

    const envBarClass = computed(() => {
      if (envChecking.value) return 'env-checking';
      if (!env.value) return '';
      return env.value.allOk ? 'env-pass' : 'env-error';
    });

    const ENV_LABELS = {
      ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', python: 'Python',
      opencv: 'OpenCV', numpy: 'NumPy', templates: '模板图片'
    };

    const envFailures = computed(() => {
      if (!env.value) return {};
      const fails = {};
      for (const [key, val] of Object.entries(env.value)) {
        if (key === 'allOk') continue;
        if (val && val.ok === false) {
          fails[key] = { label: ENV_LABELS[key] || key, error: val.error || '异常' };
        }
      }
      return fails;
    });

    async function checkEnv(force) {
      envChecking.value = true;
      try {
        const url = force ? '/api/check-env?force=1' : '/api/check-env';
        const res = await fetch(url);
        if (res.ok) env.value = await res.json();
      } catch (_) {}
      finally { envChecking.value = false; }
    }

    // 编辑页进度
    const reclipVideos = ref([]);

    // ============================================================
    // 计算
    // ============================================================
    const overallPct = computed(() => {
      if (state.running && Number.isFinite(state.progress.percent)) {
        return Math.max(0, Math.min(100, Math.floor(state.progress.percent)));
      }
      const v = state.videos;
      if (!v.length) return 0;
      let done = 0, total = v.length * 2;
      for (const x of v) {
        if (x.scanStatus === 'scanned' || x.scanStatus === 'skipped') done++;
        if (x.clipStatus === 'done' || x.clipStatus === 'skipped') done++;
      }
      return Math.floor(done / Math.max(1, total) * 100);
    });

    const reclipPct = computed(() => {
      if (state.running && Number.isFinite(state.progress.percent)) {
        return Math.max(0, Math.min(100, Math.floor(state.progress.percent)));
      }
      if (!shotlog.value) return 0;
      if (state.stepMsg && state.stepMsg.includes('拼接')) return 80;
      if (state.stepMsg && state.stepMsg.includes('裁剪')) return 40;
      return 10;
    });

    const statusText = computed(() => {
      if (state.error) return '出错';
      if (state.done) return '完成';
      if (state.running) return `运行中 · ${overallPct.value}%`;
      return '就绪';
    });

    // ============================================================
    // 工具
    // ============================================================
    function fmtEtaDuration(seconds) {
      const total = Math.max(0, Math.ceil(Number(seconds) || 0));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      if (hours > 0) return `${hours}小时${minutes}分`;
      if (minutes > 0) return `${minutes}分${secs}秒`;
      return `${secs}秒`;
    }

    const etaText = computed(() => {
      if (!state.running) return state.done ? '已按预计时间完成' : '';
      const eta = state.progress.etaSeconds;
      if (eta === null || eta === undefined || !Number.isFinite(Number(eta))) return '正在估算完工时间...';
      if (eta <= 2) return '即将完成';
      const remain = `预计还需 ${fmtEtaDuration(eta)}`;
      if (!state.progress.estimatedFinishAt) return remain;
      const finish = new Date(state.progress.estimatedFinishAt);
      if (Number.isNaN(finish.getTime())) return remain;
      const pad = n => String(n).padStart(2, '0');
      const clock = `约 ${pad(finish.getHours())}:${pad(finish.getMinutes())} 完成`;
      return `${remain} · ${clock}`;
    });

    function fmtTimer(s) {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }


    function openWebDirBrowser(target) {
      dirBrowserTarget = target;
      showDirBrowser.value = true;
      let startPath = materialDir.value || '';
      if (target === 'output') startPath = outputSettings.dir || defaultOutputDir.value || '';
      if (target === 'loadMaterial') startPath = loadState.materialDir || materialDir.value || '';
      browseDir(startPath);
    }

    function applySelectedDirectory(target, selectedPath) {
      if (!selectedPath) return;
      if (target === 'material') {
        materialDir.value = selectedPath;
        materialDirError.value = '';
        localStorage.setItem('df_materialDir', selectedPath);
        validateMaterialDir();
      } else if (target === 'output') {
        outputSettings.dir = selectedPath;
      } else if (target === 'loadMaterial') {
        loadState.materialDir = selectedPath;
      }
    }

    async function openDirBrowser(target) {
      if (dirPickerBusy.value) return;
      dirPickerBusy.value = true;
      dirPickerTarget.value = target;
      let startPath = materialDir.value || '';
      if (target === 'output') startPath = outputSettings.dir || defaultOutputDir.value || '';
      if (target === 'loadMaterial') startPath = loadState.materialDir || materialDir.value || '';

      try {
        const res = await fetch('/api/select-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initialPath: startPath })
        });
        if (res.status === 404 || res.status === 501) {
          openWebDirBrowser(target);
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '无法打开系统文件夹选择窗口');
        if (!data.cancelled) applySelectedDirectory(target, data.path);
      } catch (err) {
        alert('无法打开系统文件夹选择窗口：' + err.message);
      } finally {
        dirPickerBusy.value = false;
        dirPickerTarget.value = '';
      }
    }

    function gotoDir() {
      if (dirBrowser.pathInput.trim()) {
        browseDir(dirBrowser.pathInput.trim());
      }
    }

    function confirmDirBrowser() {
      const selectedPath = dirBrowser.path;
      applySelectedDirectory(dirBrowserTarget, selectedPath);
      showDirBrowser.value = false;
    }

    async function browseDir(targetPath) {
      dirBrowser.loading = true;
      try {
        const params = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
        const res = await fetch(`/api/dirs${params}`);
        if (!res.ok) throw new Error('请求失败');
        const data = await res.json();
        Object.assign(dirBrowser, data);
        dirBrowser.pathInput = data.path || '';
        if (!dirBrowser.files) dirBrowser.files = [];
      } catch (err) {
        alert('浏览目录失败: ' + err.message);
        showDirBrowser.value = false;
      } finally {
        dirBrowser.loading = false;
      }
    }

    function validateMaterialDir() {
      materialDirError.value = '';
      if (!materialDir.value) return;
      fetch(`/api/dirs?path=${encodeURIComponent(materialDir.value)}`)
        .then(r => r.json())
        .then(data => {
          if (data.error) materialDirError.value = '路径不存在: ' + materialDir.value;
        })
        .catch(() => { materialDirError.value = '无法验证路径'; });
    }

    function fmtSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    // 时间戳命名: YYYYMMDD-HHmmss
    function timestamp() {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    // ============================================================
    // 音频 — 音乐文件选择与上传
    // ============================================================
    function triggerMusicInput() {
      if (musicInput.value) musicInput.value.click();
    }

    function onMusicSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async function(ev) {
        const base64 = ev.target.result.split(',')[1];
        try {
          const res = await fetch('/api/upload-music', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, data: base64 })
          });
          const data = await res.json();
          if (data.ok) {
            audioSettings.fileName = data.name;
            audioSettings.musicPath = data.path;
          } else {
            alert('上传失败: ' + (data.error || '未知错误'));
          }
        } catch (err) {
          alert('上传音乐失败: ' + err.message);
        }
      };
      reader.readAsDataURL(file);
      e.target.value = ''; // 允许重复选择同一文件
    }

    // 构建音乐参数 (用于发送给后端)
    function buildMusicParam() {
      if (!audioSettings.enabled || !audioSettings.musicPath) return null;
      return {
        path: audioSettings.musicPath,
        originalDb: audioSettings.originalDb,
        musicDb: audioSettings.musicDb
      };
    }

    // ============================================================
    // 加载对话框 — 打开/关闭
    // ============================================================
    function openLoadDialog() {
      // 重置状态
      loadState.shotlogPath = '';
      loadState.shotlogContent = null;
      loadState.materialDir = '';
      loadState.needDir = false;
      loadState.missingDir = false;
      loadState.missingDirMsg = '';
      loadState.statusMsg = '';
      loadState.statusType = '';
      dragOver.value = false;
      showLoadDialog.value = true;
    }

    // ============================================================
    // 加载对话框 — 文件拖拽
    // ============================================================
    function triggerFileInput() {
      if (fileInput.value) fileInput.value.click();
    }

    function onFileDrop(e) {
      dragOver.value = false;
      const files = e.dataTransfer.files;
      if (files.length > 0) readFileContent(files[0]);
    }

    function onFileSelect(e) {
      const files = e.target.files;
      if (files.length > 0) readFileContent(files[0]);
    }

    function readFileContent(file) {
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const json = JSON.parse(ev.target.result);
          loadState.shotlogContent = json;
          loadState.shotlogPath = file.name;
          loadState.statusMsg = `✅ 已读取: ${file.name} (${json.clips?.length || 0} 个片段)`;
          loadState.statusType = 'ok';
        } catch (e) {
          loadState.shotlogContent = null;
          loadState.statusMsg = '❌ 文件格式无效，无法解析 JSON';
          loadState.statusType = 'error';
        }
      };
      reader.readAsText(file, 'UTF-8');
    }

    // ============================================================
    // 加载对话框 — 提交加载
    // ============================================================
    async function doLoadShotlog() {
      loadState.statusMsg = '';
      loadState.statusType = '';

      const body = {};
      if (loadState.shotlogContent) {
        body.shotlogContent = loadState.shotlogContent;
      } else if (loadState.shotlogPath) {
        body.shotlogPath = loadState.shotlogPath;
      } else {
        return;
      }
      if (loadState.materialDir) body.materialDir = loadState.materialDir;

      try {
        const res = await fetch('/api/load-shotlog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();

        if (data.needDir) {
          loadState.needDir = true;
          loadState.statusMsg = '此脚本未记录素材目录，请在下方输入';
          loadState.statusType = 'warn';
          return;
        }

        if (data.missingDir) {
          loadState.missingDir = true;
          loadState.missingDirMsg = data.error;
          loadState.statusMsg = '记录的素材目录已不存在，请重新指定';
          loadState.statusType = 'error';
          return;
        }

        if (data.error) {
          loadState.statusMsg = data.error;
          loadState.statusType = 'error';
          return;
        }

        if (data.ok) {
          const sl = data.shotlog;
          const missingSet = new Set(data.missingVideos || []);
          for (const clip of sl.clips) {
            clip.framesrc = null;
            clip._errors = '';
            clip._missing = missingSet.has(clip.sourceFile);
          }
          shotlog.value = sl;
          showLoadDialog.value = false;

          const hasMissing = data.missingVideos.length > 0;
          loadState.statusMsg = hasMissing
            ? `已加载，${data.missingVideos.length} 个素材缺失`
            : '已加载';
          loadState.statusType = hasMissing ? 'warn' : 'ok';

          activeTab.value = 'edit';
          loadFrames();
        }
      } catch (err) {
        loadState.statusMsg = '加载失败: ' + err.message;
        loadState.statusType = 'error';
      }
    }

    // ============================================================
    // SSE
    // ============================================================
    function connectSSE() {
      if (eventSource) eventSource.close();
      if (timerInterval) clearInterval(timerInterval);
      eventSource = new EventSource('/api/events');

      eventSource.addEventListener('init', e => {
        const d = JSON.parse(e.data);
        state.videos = d.videos.map(v => ({ ...v }));
      });

      eventSource.addEventListener('performance', e => {
        try {
          const data = JSON.parse(e.data);
          performanceInfo.value = data;
          if (data.resource) resourceInfo.value = data.resource;
        } catch (_) {}
      });

      eventSource.addEventListener('task-progress', e => {
        try {
          const data = JSON.parse(e.data);
          Object.assign(state.progress, data);
          if (data.detail) state.stepMsg = data.detail;
        } catch (_) {}
      });

      eventSource.addEventListener('timer', e => {
        state.timer = JSON.parse(e.data).elapsed;
      });

      eventSource.addEventListener('step', e => {
        state.stepMsg = `Step ${JSON.parse(e.data).step}/${JSON.parse(e.data).total}: ${JSON.parse(e.data).message}`;
      });

      eventSource.addEventListener('progress', e => {
        const d = JSON.parse(e.data);
        if (d.detail) state.stepMsg = d.detail;
      });

      eventSource.addEventListener('video-scan-start', e => {
        const d = JSON.parse(e.data);
        const v = state.videos[d.index];
        if (v) v.scanStatus = 'scanning';
      });

      eventSource.addEventListener('video-scan-done', e => {
        const d = JSON.parse(e.data);
        const v = state.videos[d.index];
        if (v) { v.scanStatus = d.kills > 0 ? 'scanned' : 'skipped'; v.kills = d.kills || 0; }
      });

      eventSource.addEventListener('video-skip', e => {
        const d = JSON.parse(e.data);
        const v = state.videos[d.index];
        if (v) v.scanStatus = 'skipped';
      });

      eventSource.addEventListener('video-clip-start', e => {
        const d = JSON.parse(e.data);
        const v = state.videos[d.index];
        if (v && v.clipStatus !== 'done') v.clipStatus = 'clipping';
        // 同步更新 reclipVideos
        const rv = reclipVideos.value[d.index];
        if (rv) rv.status = 'clipping';
      });

      eventSource.addEventListener('video-clip-done', e => {
        const d = JSON.parse(e.data);
        const v = state.videos[d.index];
        if (v) {
          v.clipStatus = d.status === 'done' ? 'done' : (d.status === 'skipped' ? 'skipped' : 'error');
          if (d.sizeMB) v.clipSize = d.sizeMB;
        }
        const rv = reclipVideos.value[d.index];
        if (rv) rv.status = d.status === 'done' ? 'done' : (d.status === 'skipped' ? 'skipped' : 'error');
      });

      eventSource.addEventListener('done', e => {
        const d = JSON.parse(e.data);
        state.running = false;
        state.done = d.success;
        state.error = !d.success;
        state.stepMsg = d.success ? '完成' : (d.error || '失败');
        state.progress.percent = d.success ? 100 : state.progress.percent;
        state.progress.etaSeconds = 0;
        if (d.highlightPath) {
          output.exists = true;
          output.path = d.highlightPath;
          output.name = d.highlightPath.split(/[\\/]/).pop();
          output.sizeMB = d.sizeMB;
        }
        cleanupSSE();
      });

      eventSource.addEventListener('error', e => {
        try { const d = JSON.parse(e.data); state.stepMsg = d.message; } catch (_) {}
        state.running = false; state.error = true;
        cleanupSSE();
      });

      eventSource.onerror = () => {
        if (state.running) state.stepMsg = '连接断开';
      };
    }

    function cleanupSSE() {
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    // ============================================================
    // 扫描
    // ============================================================
    async function startScan() {
      if (!materialDir.value || state.running) return;
      // 弹出输出设置对话框
      outputSettings.name = 'highlight-' + timestamp() + '_preview.mp4';
      outputSettings.dir = defaultOutputDir.value;
      outputSettings.compat = false;
      outputSettings.quality = 'original';
      pendingOutputAction = 'scan';
      showOutputDialog.value = true;
    }

    async function confirmOutput() {
      // 根据清晰度调整文件名后缀
      const baseName = outputSettings.name.replace(/(_preview)?\.mp4$/, '');
      if (outputSettings.quality === '360p') {
        outputSettings.name = baseName + '_preview.mp4';
      } else {
        outputSettings.name = baseName + '.mp4';
      }
      showOutputDialog.value = false;
      if (pendingOutputAction === 'scan') await doStartScan();
      else if (pendingOutputAction === 'reclip') await doReclip();
    }

    async function doStartScan() {
      if (!materialDir.value || state.running) return;
      localStorage.setItem('df_materialDir', materialDir.value);
      Object.assign(state, { running: true, done: false, error: false, timer: 0, stepMsg: '准备中...', videos: [] });
      Object.assign(state.progress, { phase: '', label: '', detail: '', percent: 0, etaSeconds: null, estimatedFinishAt: null });
      output.exists = false;
      connectSSE();

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            materialDir: materialDir.value,
            outputName: outputSettings.name,
            outputDir: outputSettings.dir,
            compatibilityMode: outputSettings.compat,
            quality: outputSettings.quality,
            music: buildMusicParam()
          })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '请求失败');
        }
      } catch (err) {
        state.running = false; state.error = true; state.stepMsg = err.message;
        cleanupSSE();
      }
    }

    async function stopScan() {
      try {
        await fetch('/api/stop', { method: 'POST' });
        state.running = false; state.stepMsg = '已停止';
        cleanupSSE();
      } catch (_) {}
    }

    // ============================================================
    // 帧加载
    // ============================================================
    async function loadFrames() {
      if (!shotlog.value) return;
      for (const clip of shotlog.value.clips) {
        if (clip._missing) continue;
        if (clip.noKill && clip.clipEnd === 0) continue; // 无击杀且未设置范围，无帧可提取
        if (clip.killTimes && clip.killTimes.length > 0) {
          clip.framesrc = `/api/frame?video=${encodeURIComponent(clip.sourceFile)}&time=${clip.killTimes[0]}`;
        } else if (clip.clipStart > 0 || clip.clipEnd > 0) {
          // 无击杀但手动设置了范围，取中间帧
          const midTime = (clip.clipStart + clip.clipEnd) / 2;
          clip.framesrc = `/api/frame?video=${encodeURIComponent(clip.sourceFile)}&time=${midTime}`;
        }
      }
    }

    // ============================================================
    // 镜头日志编辑
    // ============================================================
    function sanitizeShotlog() {
      // 深拷贝并移除前端专用字段
      const clean = JSON.parse(JSON.stringify(shotlog.value));
      for (const clip of clean.clips) {
        delete clip._errors;
        delete clip._missing;
        delete clip.framesrc;
      }
      return clean;
    }

    async function saveShotlog() {
      if (!shotlog.value) return;
      try {
        const clean = sanitizeShotlog();
        const res = await fetch('/api/shotlog', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clean)
        });
        if (!res.ok) {
          let msg = '未知错误';
          try { const err = await res.json(); msg = err.error || msg; } catch (_) {}
          throw new Error(msg);
        }
        alert('✅ 镜头日志已保存');
      } catch (err) {
        alert('保存失败: ' + err.message);
      }
    }

    function addKillTime(ci) {
      const clip = shotlog.value.clips[ci];
      const last = clip.killTimes.length > 0 ? clip.killTimes[clip.killTimes.length - 1] : clip.clipStart;
      clip.killTimes.push(Math.round((last + 1) * 100) / 100);
    }

    function validateClip(ci) {
      const clip = shotlog.value.clips[ci];
      // 无击杀且未设置范围的片段不校验（生成时跳过）
      if (clip.noKill && clip.clipStart === 0 && clip.clipEnd === 0) {
        clip._errors = '';
        return;
      }
      const errors = [];
      if (clip.clipStart >= clip.clipEnd) errors.push('开始 < 结束');
      if (clip.clipStart < 0) errors.push('不能为负');
      for (const kt of clip.killTimes) {
        if (kt < clip.clipStart || kt > clip.clipEnd) { errors.push(`击杀 ${kt}s 超出范围`); break; }
      }
      clip.killTimes.sort((a, b) => a - b);
      clip._errors = errors.join('; ');
    }

    function deleteClip(ci) {
      if (!confirm(`确定删除片段 "${shotlog.value.clips[ci].sourceFile}"？`)) return;
      shotlog.value.clips.splice(ci, 1);
    }

    function moveClip(ci, dir) {
      const clips = shotlog.value.clips;
      const target = ci + dir;
      if (target < 0 || target >= clips.length) return;
      [clips[ci], clips[target]] = [clips[target], clips[ci]];
    }

    // ============================================================
    // 重新裁剪
    // ============================================================
    async function reclip() {
      if (!shotlog.value || state.running) return;
      for (let ci = 0; ci < shotlog.value.clips.length; ci++) {
        validateClip(ci);
        if (shotlog.value.clips[ci]._errors) {
          alert(`片段 ${ci + 1} 有错误:\n${shotlog.value.clips[ci]._errors}`);
          return;
        }
      }
      await saveShotlog();
      outputSettings.name = 'highlight-' + timestamp() + '_preview.mp4';
      outputSettings.dir = defaultOutputDir.value;
      outputSettings.compat = false;
      outputSettings.quality = 'original';
      pendingOutputAction = 'reclip';
      showOutputDialog.value = true;
    }

    async function doReclip() {
      reclipVideos.value = shotlog.value ? shotlog.value.clips.map((c, i) => ({ index: i, name: c.sourceFile, status: 'pending' })) : [];

      Object.assign(state, { running: true, done: false, error: false, timer: 0, stepMsg: '准备中...', videos: [] });
      Object.assign(state.progress, { phase: '', label: '', detail: '', percent: 0, etaSeconds: null, estimatedFinishAt: null });
      connectSSE();

      try {
        const res = await fetch('/api/reclip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            outputName: outputSettings.name,
            outputDir: outputSettings.dir,
            compatibilityMode: outputSettings.compat,
            quality: outputSettings.quality,
            music: buildMusicParam()
          })
        });
        if (!res.ok) throw new Error((await res.json()).error || '请求失败');
      } catch (err) {
        state.running = false; state.error = true; state.stepMsg = err.message;
        cleanupSSE();
      }
    }

    async function openFolder() {
      if (!output.path) return;
      try {
        await fetch('/api/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: output.path })
        });
      } catch (_) {}
    }
    onMounted(async () => {
      // 环境自检
      checkEnv(false);
      loadResourceSettings();

      // 加载服务端配置（默认输出目录等）
      try {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok) {
          const cfgData = await cfgRes.json();
          if (cfgData.outputDir) defaultOutputDir.value = cfgData.outputDir;
          if (cfgData.materialDir && !materialDir.value) {
            materialDir.value = cfgData.materialDir;
          }
          if (cfgData.performance) performanceInfo.value = cfgData.performance;
          if (cfgData.resources) resourceInfo.value = cfgData.resources;
          if (cfgData.defaultQuality) outputSettings.quality = cfgData.defaultQuality;
          if (!performanceInfo.value || !performanceInfo.value.ready) {
            fetch('/api/performance').then(r => r.ok ? r.json() : null).then(d => {
              if (d) performanceInfo.value = d;
            }).catch(() => {});
          }
        }
      } catch (_) {}

      try {
        const res = await fetch('/api/output');
        const data = await res.json();
        if (data.exists) Object.assign(output, data);
      } catch (_) {}
    });

    watch(activeTab, async (tab) => {
      if (tab === 'edit' && !shotlog.value) {
        try {
          const res = await fetch('/api/shotlog');
          if (res.ok) {
            shotlog.value = await res.json();
            for (const c of shotlog.value.clips) { c.framesrc = null; c._errors = ''; c._missing = false; }
            loadFrames();
          }
        } catch (_) {}
      }
    });

    return {
      tabs, activeTab,
      materialDir, state, output, overallPct, reclipPct, statusText,
      etaText,
      showLoadDialog, dragOver, fileInput, loadState, canLoad,
      shotlog, loadingShotlog,
      showDirBrowser, dirBrowser, dirBrowserTitle, showOutputDialog, outputSettings,
      dirPickerBusy, dirPickerTarget,
      materialDirError,
      audioSettings, musicInput,
      env, envChecking, envBarClass, envFailures, checkEnv,
      performanceInfo,
      resourceInfo, resourceDraft, resourceModes, resourceButtonLabel,
      showResourceDialog, resourceSaveMsg, resourceSaveType,
      openResourceDialog, selectResourceMode, markResourceCustom, saveResourceSettings,
      reclipVideos,
      fmtTimer, openDirBrowser, gotoDir, confirmDirBrowser, browseDir, validateMaterialDir, fmtSize,
      triggerMusicInput, onMusicSelect,
      startScan, confirmOutput, stopScan, openFolder,
      openLoadDialog, triggerFileInput, onFileDrop, onFileSelect, doLoadShotlog,
      saveShotlog, reclip, addKillTime, validateClip, deleteClip, moveClip
    };
  }
}).mount('#app');
