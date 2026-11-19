'use strict';

// Офлайн-предзагрузка всех данных (панель «Скачать все данные»).
// Подключается на главной странице (index.html) и на странице настроек
// (settings.html). Модуль самодостаточен: сам читает манифест и сканирует
// кеш данных, поэтому работает даже там, где app.js не загружается.

(function () {
  const DATA_BASE = './data';
  const MANIFEST_URL = DATA_BASE + '/manifest.json';
  const DATA_CACHE = 'tatoeba-data-v1';
  const DL_CONCURRENCY = 4;
  const DL_FETCH_TIMEOUT_MS = 90000;

  function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DL_FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  const $ = (id) => document.getElementById(id);

  const el = {
    dlPanel: $('panel-dl'),
    dlProgress: $('dl-progress'),
    btnDl: $('btnDl'),
    dlStatus: $('dl-status'),
  };

  const hasUi = !!(el.dlPanel && el.dlProgress && el.btnDl && el.dlStatus);
  // data-always: на странице настроек панель видна и после завершения загрузки.
  const alwaysVisible = hasUi && el.dlPanel.hasAttribute('data-always');

  let manifest = null;
  let manifestPromise = null;

  function ensureManifest() {
    if (manifest) return Promise.resolve(manifest);
    if (manifestPromise) return manifestPromise;
    manifestPromise = fetchWithTimeout(MANIFEST_URL + '?check=' + Date.now())
      .then((res) => {
        if (!res.ok) throw new Error('http_' + res.status);
        return res.text();
      })
      .then((text) => {
        manifest = JSON.parse(text);
        return manifest;
      })
      .catch((err) => {
        manifestPromise = null;
        throw err;
      });
    return manifestPromise;
  }

  const dl = {
    running: false,
    total: 0,
    done: 0,
    files: [],
  };

  function isInstalledStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      !!navigator.standalone;
  }

  function dlFileList() {
    if (!manifest) return [];
    const files = [{ kind: 'manifest' }];
    for (const c of manifest.widx) files.push({ kind: 'widx', key: c });
    for (const b of manifest.packs) files.push({ kind: 'pack', key: b });
    for (const b of manifest.ru) files.push({ kind: 'ru', key: b });
    return files;
  }

  function dlChunkUrl(f) {
    if (f.kind === 'manifest') return MANIFEST_URL;
    if (f.kind === 'widx') return DATA_BASE + '/widx/widx_' + f.key + '.json';
    if (f.kind === 'pack') return DATA_BASE + '/packs/pack_' + f.key + '.json';
    return DATA_BASE + '/ru/ru_' + f.key + '.jsonl';
  }

  async function dlScan(files) {
    let done = 0;
    const missing = [];
    if (!('caches' in window)) return { done: 0, missing: files.map(dlChunkUrl) };
    try {
      const cache = await caches.open(DATA_CACHE);
      for (const f of files) {
        const url = dlChunkUrl(f);
        const hit = await cache.match(url);
        if (hit) done++;
        else missing.push(url);
      }
    } catch (e) {
      return { done: 0, missing: files.map(dlChunkUrl) };
    }
    return { done, missing };
  }

  function renderDl() {
    if (!hasUi) return;
    const hasFiles = dl.total > 0;
    const complete = hasFiles && dl.done >= dl.total;
    const pct = dl.total ? Math.round((dl.done / dl.total) * 100) : 0;
    el.dlProgress.value = pct;
    el.dlStatus.textContent = dl.done < dl.total
      ? 'Офлайн-данные: ' + dl.done + ' из ' + dl.total + ' (' + pct + '%)'
      : 'Все данные скачаны (' + dl.total + ' файлов) — приложение работает офлайн.';
    el.btnDl.disabled = dl.running || dl.done >= dl.total;
    el.btnDl.textContent = dl.running ? 'Скачивание…' : 'Скачать все данные';
    el.dlPanel.classList.toggle('hidden', !hasFiles || (!alwaysVisible && complete));
  }

  async function startPredownload(auto) {
    if (dl.running) return;
    dl.running = true;
    try {
      if (!manifest) await ensureManifest();
      const files = dlFileList();
      if (!files.length) return;
      dl.files = files;
      dl.total = files.length;
      const scan = await dlScan(files);
      dl.done = scan.done;
      const missing = scan.missing;
      renderDl();
      if (!missing.length) return;
      if (hasUi) el.dlPanel.classList.remove('hidden');
      renderDl();
      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const url = missing[cursor++];
          try {
            const res = await fetchWithTimeout(url);
            if (res.ok) {
              dl.done++;
              renderDl();
            }
          } catch (e) { /* таймаут/сеть: останется в missing, докачается при следующем запуске */ }
        }
      };
      await Promise.all(Array.from({ length: DL_CONCURRENCY }, worker));
    } catch (err) {
      // Манифест или скан не удались — статус остаётся прежним.
    } finally {
      dl.running = false;
      renderDl();
    }
  }

  if (hasUi) {
    el.btnDl.addEventListener('click', () => {
      if (dl.running) return;
      el.dlPanel.classList.remove('hidden');
      startPredownload(false);
    });
  }

  // Автозапуск: после установки PWA и при запуске установленного приложения.
  window.addEventListener('appinstalled', () => { startPredownload(true); });
  ensureManifest()
    .then(async () => {
      const files = dlFileList();
      dl.total = files.length;
      if (files.length) {
        const scan = await dlScan(files);
        dl.done = scan.done;
      }
      if (isInstalledStandalone()) {
        startPredownload(true);
      } else if (hasUi) {
        renderDl();
      }
    })
    .catch(() => {});
})();