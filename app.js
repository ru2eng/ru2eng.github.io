'use strict';

(function () {
  const API_BASE = 'https://api.tatoeba.org/v1';
  const API_ORIGIN = 'https://api.tatoeba.org';
  const SEARCH_LIMIT = 20;
  const FETCH_TIMEOUT_MS = 90000;
  const MAX_FOLLOW_PAGES = 4;
  const RECORD_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const GTX_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=';
  const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get?q=';

  const $ = (id) => document.getElementById(id);

  const el = {
    panelWord: $('panel-word'),
    panelExercise: $('panel-exercise'),
    panelAudio: $('panel-audio'),
    panelNav: $('panel-nav'),
    panelError: $('panel-error'),
    spinner: $('spinner'),
    inputWord: $('input-word'),
    btnSearch: $('btnSearch'),
    ruSentence: $('ru-sentence'),
    answerRow: $('answer-row'),
    inputAnswer: $('input-answer'),
    btnCheck: $('btnCheck'),
    compare: $('compare'),
    yourCell: $('your-cell'),
    yourAnswer: $('your-answer'),
    correctAnswer: $('correct-answer'),
    btnRetryAnswer: $('btnRetryAnswer'),
    apiAudio: $('apiAudio'),
    myAudio: $('myAudio'),
    btnReplayApi: $('btnReplayApi'),
    autoBadge: $('auto-badge'),
    btnRecord: $('btnRecord'),
    btnPlayMine: $('btnPlayMine'),
    btnNext: $('btnNext'),
    btnNewWord: $('btnNewWord'),
    errorText: $('error-text'),
    btnRetry: $('btnRetry'),
    hint: $('hint'),
  };

  const state = {
    step: 'word',           // 'word' | 'loading' | 'exercise' | 'revealed'
    query: '',
    pool: [],               // [{ enId, enText, ruText, audios: string[] }]
    cursor: -1,
    seenIds: new Set(),
    srcNext: null,          // сохранённый paging.next для догрузки
    revealed: false,
    userAnswer: '',
    audioIndex: 0,
    audioUnavailable: false,
    preloadFailed: false,
    loadingMore: false,
    recording: null,        // { blobUrl, mime }
    recordingActive: false,
    error: null,            // { message, retry }
  };

  // Хэндлы MediaRecorder — вне state, т.к. это не UI-состояние.
  let recorder = null;
  let mediaStream = null;
  let chunks = [];
  let recorderToken = 0;
  let preloadMode = false;

  // ---------- утилиты ----------

  function currentItem() {
    if (!state.pool.length || state.cursor < 0) return null;
    return state.pool[state.cursor];
  }

  function normalize(s) {
    return s
      .normalize('NFKC')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/g, '')
      .replace(/[«»“”‘’]/g, (c) => (c === '«' || c === '”' || c === '“') ? '"' : "'")
      .replace(/\s*[-–—]\s*/g, ' ');
  }

  function clearError() {
    state.error = null;
  }

  function setError(message, retry) {
    state.error = { message, retry: !!retry };
  }

  function showHint(text) {
    el.hint.textContent = text;
    el.hint.classList.remove('hidden');
  }

  function hideHint() {
    el.hint.classList.add('hidden');
  }

  function resetPool() {
    state.pool = [];
    state.seenIds.clear();
    state.srcNext = null;
    state.cursor = -1;
  }

  function findRuTranslation(translations) {
    if (!Array.isArray(translations)) return null;
    const direct = translations.find((t) => t.lang === 'rus' && t.is_direct && t.text);
    if (direct) return direct.text;
    const any = translations.find((t) => t.lang === 'rus' && t.text);
    return any ? any.text : null;
  }

  function buildPoolItem(raw) {
    const ruText = findRuTranslation(raw.translations);
    const audios = (raw.audios || [])
      .filter((a) => a && (a.id || a.download_url))
      .map((a) => (a.id ? API_BASE + '/audios/' + a.id + '/file' : a.download_url));
    if (!audios.length) return null;
    return { enId: raw.id, enText: raw.text, ruText, auto: !ruText, audios };
  }

  function appendPool(data) {
    let addedCount = 0;
    for (const raw of (data && data.data) || []) {
      const item = buildPoolItem(raw);
      if (!item || state.seenIds.has(item.enId)) continue;
      state.seenIds.add(item.enId);
      state.pool.push(item);
      addedCount++;
    }
    const paging = data && data.paging;
    state.srcNext = paging && paging.has_next && paging.next ? paging.next : null;
    return addedCount;
  }

  function resolveNext(next) {
    if (/^https?:\/\//i.test(next)) {
      if (API_BASE === API_ORIGIN + '/v1') return next;
      return next.replace(API_ORIGIN, new URL(API_BASE).origin);
    }
    return API_BASE + (next.startsWith('/') ? next : '/' + next);
  }

  async function fetchTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (e) {
        throw new Error(e && e.name === 'AbortError' ? 'timeout' : 'network');
      }
      if (!res.ok) throw new Error('http_' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- поиск в Tatoeba ----------

  async function performSearch(q) {
    resetPool();
    const tiers = [
      { params: [['trans:lang', 'rus'], ['trans:is_direct', 'yes']] },
      { params: [['trans:lang', 'rus']] },
      { params: [['!trans:lang', 'rus']] },
    ];
    let found = false;
    for (const tier of tiers) {
      if (state.pool.length >= SEARCH_LIMIT) break;
      const params = new URLSearchParams({
        q,
        lang: 'eng',
        has_audio: 'yes',
        showtrans: 'matching',
        include: 'audios',
        sort: 'random',
        word_count: '-20',
        limit: String(SEARCH_LIMIT),
      });
      for (const [k, v] of tier.params) params.set(k, v);

      let data = await fetchTimeout(API_BASE + '/sentences?' + params.toString());
      let added = appendPool(data);
      let pages = 0;
      while (added === 0 && state.srcNext && pages < MAX_FOLLOW_PAGES && state.pool.length < SEARCH_LIMIT) {
        const next = state.srcNext;
        state.srcNext = null;
        data = await fetchTimeout(resolveNext(next));
        added = appendPool(data);
        pages++;
      }
      if (added > 0) found = true;
    }
    return found;
  }

  async function onSearch() {
    if (state.step === 'loading') return;
    const q = el.inputWord.value.trim();
    if (!q) return;
    state.query = q;
    clearError();
    state.step = 'loading';
    renderState();
    try {
      const found = await performSearch(q);
      if (!found) {
        state.step = 'word';
        setError('Ничего не найдено. Проверьте слово или попробуйте другое.', false);
        renderState();
        return;
      }
      state.cursor = 0;
      resetExercise();
      state.step = 'exercise';
      renderState();
    } catch (err) {
      state.step = 'word';
      const msg = err.message === 'timeout'
        ? 'Сервер Tatoeba не ответил вовремя. Проверьте соединение.'
        : 'Не удалось получить данные от Tatoeba. Проверьте соединение.';
      setError(msg, true);
      renderState();
    }
  }

  function onRetry() {
    if (!el.inputWord.value.trim() && state.query) el.inputWord.value = state.query;
    onSearch();
  }

  // ---------- машинный перевод ----------

  function cachedRu(en) {
    try { return window.localStorage.getItem('enru:' + en) || null; } catch (e) { return null; }
  }

  function storeRu(en, ru) {
    try { window.localStorage.setItem('enru:' + en, ru); } catch (e) { /* ignore */ }
  }

  function parseGtx(data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const parts = data[0].filter((p) => Array.isArray(p) && typeof p[0] === 'string');
    if (!parts.length) return null;
    return parts.map((p) => p[0]).join('').trim();
  }

  function parseMyMemory(data) {
    const t = data && data.responseData && data.responseData.translatedText;
    return typeof t === 'string' && t ? t.trim() : null;
  }

  async function translateRu(en) {
    const cached = cachedRu(en);
    if (cached) return cached;
    try {
      const data = await fetchTimeout(GTX_TRANSLATE_URL + encodeURIComponent(en));
      const ru = parseGtx(data);
      if (ru) { storeRu(en, ru); return ru; }
    } catch (e) { /* fallthrough */ }
    try {
      const data = await fetchTimeout(MYMEMORY_TRANSLATE_URL + encodeURIComponent(en) + '&langpair=en|ru');
      const ru = parseMyMemory(data);
      if (ru) { storeRu(en, ru); return ru; }
    } catch (e) { /* fallthrough */ }
    return null;
  }

  function prefetchTranslation(item) {
    if (!item || item.ruText || item.pending || item.failed) return;
    item.pending = true;
    translateRu(item.enText).then(
      (text) => {
        item.pending = false;
        item.ruText = text;
        item.failed = !text;
        if (currentItem() === item) renderState();
      },
      () => { item.pending = false; item.failed = true; if (currentItem() === item) renderState(); }
    );
  }

  // ---------- упражнение ----------

function resetExercise() {
  el.inputAnswer.value = '';
  state.userAnswer = '';
  state.revealed = false;
  state.step = 'exercise';
  state.audioIndex = 0;
  state.audioUnavailable = false;
  state.preloadFailed = false;
  stopApiAudio();
  discardRecording();
  hideHint();
  clearError();
}

  function stopApiAudio() {
    try { el.apiAudio.pause(); } catch (e) { /* ignore */ }
    el.apiAudio.removeAttribute('src');
    try { el.apiAudio.load(); } catch (e) { /* ignore */ }
  }

  function onCheck() {
    state.userAnswer = el.inputAnswer.value.trim();
    state.revealed = true;
    state.step = 'revealed';
    renderState();
    playApiAudio();
  }

  async function onNext() {
    if (state.loadingMore || state.pool.length === 0) return;
    clearError();
    if (state.cursor + 1 < state.pool.length) {
      state.cursor++;
      resetExercise();
      renderState();
      return;
    }
    if (!state.srcNext) {
      setError('Предложения по этому слову закончились. Нажмите «Повторить» для нового поиска или выберите новое слово.', true);
      renderState();
      return;
    }
    state.loadingMore = true;
    renderState();
    try {
      let pages = 0;
      while (state.srcNext && pages <= MAX_FOLLOW_PAGES) {
        const next = state.srcNext;
        state.srcNext = null;
        const data = await fetchTimeout(resolveNext(next));
        const before = state.pool.length;
        appendPool(data);
        if (state.pool.length > before) {
          state.cursor = before;
          state.loadingMore = false;
          resetExercise();
          renderState();
          return;
        }
        pages++;
      }
      state.loadingMore = false;
      setError('Предложения по этому слову закончились. Нажмите «Повторить» для нового поиска или выберите новое слово.', true);
      renderState();
    } catch (err) {
      state.loadingMore = false;
      const msg = err.message === 'timeout'
        ? 'Сервер Tatoeba не ответил вовремя. Проверьте соединение.'
        : 'Не удалось загрузить следующие предложения. Проверьте соединение.';
      setError(msg, true);
      renderState();
    }
  }

  function onNewWord() {
    resetExercise();
    resetPool();
    state.query = '';
    state.step = 'word';
    el.inputWord.value = '';
    renderState();
    el.inputWord.focus();
  }

  // ---------- аудио API ----------

  function playApiAudio() {
    const item = currentItem();
    if (!item || state.audioUnavailable) return;
    if (!item.audios.length || state.preloadFailed) {
      state.audioUnavailable = true;
      setError('Аудио недоступно для этого предложения.', false);
      renderState();
      return;
    }
    if (state.audioIndex >= item.audios.length) state.audioIndex = 0;
    const url = item.audios[state.audioIndex];
    preloadMode = false;
    if (el.apiAudio.getAttribute('src') !== url) {
      try {
        el.apiAudio.preload = 'auto';
        el.apiAudio.src = url;
        el.apiAudio.load();
      } catch (e) { /* ignore */ }
    }
    el.apiAudio.play()
      .then(() => hideHint())
      .catch(() => showHint('Нажмите «Произношение (носитель)», чтобы прослушать произношение.'));
  }

function preloadApiAudio() {
  const item = currentItem();
  if (!item || state.audioUnavailable || state.preloadFailed) return;
  const url = item.audios[state.audioIndex];
  if (!url || el.apiAudio.getAttribute('src') === url) return;
  preloadMode = true;
  try {
    el.apiAudio.preload = 'auto';
    el.apiAudio.src = url;
    el.apiAudio.load();
  } catch (e) { /* ignore */ }
}

function onApiAudioError() {
  const item = currentItem();
  const currentSrc = el.apiAudio.getAttribute('src');
  if (!item || state.audioUnavailable || !currentSrc) return;
  state.audioIndex++;
  if (state.audioIndex < item.audios.length) {
    if (preloadMode && state.step === 'exercise') {
      preloadApiAudio();
    } else {
      playApiAudio();
    }
    return;
  }
  state.preloadFailed = true;
  if (preloadMode && state.step === 'exercise') {
    renderState();
    return;
  }
  state.audioUnavailable = true;
  setError('Аудио недоступно для этого предложения.', false);
  renderState();
}

  function onRetryAnswer() {
    resetExercise();
    renderState();
  }

  function onReplayApi() {
    hideHint();
    playApiAudio();
  }

  // ---------- запись с микрофона ----------

  function stopRecorderSilently() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    recorder = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    state.recordingActive = false;
    chunks = [];
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setError('Ваш браузер не поддерживает запись с микрофона.', false);
      renderState();
      return;
    }
    stopRecorderSilently();
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'audioinput')) {
        console.error('enumerateDevices: no audioinput devices');
        setError('Микрофон не найден. Подключите устройство и проверьте, что доступ к нему разрешён в Параметрах Windows: Конфиденциальность → Микрофон.', false);
        renderState();
        return;
      }
    } catch (e) { /* ignore */ }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('getUserMedia:', err);
      const name = err && err.name;
      let msg;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        msg = 'Доступ к микрофону запрещён. Разрешите доступ в настройках браузера и попробуйте снова.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        msg = 'Микрофон не найден. Подключите устройство и проверьте, что доступ к нему разрешён в Параметрах Windows: Конфиденциальность → Микрофон.';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        msg = 'Микрофон занят другим приложением или заблокирован системой. Закройте программы, использующие микрофон, и проверьте доступ в Параметрах Windows: Конфиденциальность → Микрофон.';
      } else if (name === 'SecurityError') {
        msg = 'Запись доступна только с защищённого соединения (https) или localhost.';
      } else if (name === 'AbortError') {
        msg = 'Запрос на доступ к микрофону прерван. Попробуйте ещё раз.';
      } else {
        msg = 'Не удалось получить доступ к микрофону (' + (name || 'unknown') + '). Проверьте микрофон и настройки операционной системы.';
      }
      setError(msg, false);
      renderState();
      return;
    }
    const mimeType = RECORD_MIME_CANDIDATES.find((m) => window.MediaRecorder.isTypeSupported(m)) || '';
    const token = ++recorderToken;
    mediaStream = stream;
    chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (state.recorderToken !== token) return;
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      stopRecorderSilently();
      if (state.recording) URL.revokeObjectURL(state.recording.blobUrl);
      state.recording = { blobUrl: URL.createObjectURL(blob), mime: mimeType };
      el.myAudio.src = state.recording.blobUrl;
      hideHint();
      renderState();
    };
    recorder.onerror = () => {
      setError('Ошибка записи. Попробуйте ещё раз.', false);
      discardRecording();
      renderState();
    };
    state.recorderToken = token;
    recorder.start();
    state.recordingActive = true;
    renderState();
  }

  function finishRecording() {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    recorder = null;
    state.recordingActive = false;
    renderState();
  }

  function discardRecording() {
    recorderToken++;
    state.recorderToken = recorderToken;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    recorder = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    chunks = [];
    state.recordingActive = false;
    if (state.recording) {
      URL.revokeObjectURL(state.recording.blobUrl);
      state.recording = null;
    }
    el.myAudio.removeAttribute('src');
    try { el.myAudio.load(); } catch (e) { /* ignore */ }
  }

  function onRecordToggle() {
    if (state.recordingActive) {
      finishRecording();
    } else {
      startRecording();
    }
  }

  function onPlayMine() {
    if (!state.recording) return;
    hideHint();
    el.myAudio.play().catch(() => showHint('Не удалось воспроизвести запись.'));
  }

  // ---------- рендер ----------

  function renderState() {
    const step = state.step;
    const inExercise = step === 'exercise' || step === 'revealed';

    el.panelWord.classList.toggle('hidden', step !== 'word' && step !== 'loading');
    el.spinner.classList.toggle('hidden', step !== 'loading');
    el.inputWord.disabled = step === 'loading';
    el.panelExercise.classList.toggle('hidden', !inExercise);
    el.panelNav.classList.toggle('hidden', !inExercise);
    el.panelAudio.classList.toggle('hidden', step !== 'revealed');
    el.panelError.classList.toggle('hidden', !state.error);

    el.btnSearch.disabled = !el.inputWord.value.trim() || step === 'loading';
    el.btnNext.disabled = state.loadingMore;

    if (inExercise) {
      const item = currentItem();
      if (item) {
        if (item.ruText) {
          el.ruSentence.textContent = item.ruText;
        } else if (item.failed) {
          el.ruSentence.textContent = 'Перевод недоступен. Попробуйте другое предложение.';
        } else {
          el.ruSentence.textContent = 'Переводим…';
        }
        el.autoBadge.classList.toggle('hidden', !item.auto);
      }
    }

    if (step === 'exercise') {
      preloadApiAudio();
      const item = currentItem();
      prefetchTranslation(item);
      const nxt = state.pool[state.cursor + 1];
      if (nxt) prefetchTranslation(nxt);
    }

    const revealed = step === 'revealed';
    el.answerRow.classList.toggle('hidden', revealed);
    el.compare.classList.toggle('hidden', !revealed);
    if (revealed) {
      const item = currentItem();
      el.yourAnswer.textContent = state.userAnswer || '(вы не ввели вариант)';
      el.correctAnswer.textContent = item ? item.enText : '';
      const your = normalize(state.userAnswer);
      const correct = item ? normalize(item.enText) : '';
      const matched = your === correct && your !== '';
      el.yourCell.classList.toggle('match', matched);
      el.yourCell.classList.toggle('mismatch', !matched);
    } else {
      el.yourCell.classList.remove('match', 'mismatch');
    }

    el.btnReplayApi.disabled = state.audioUnavailable;
    el.btnRecord.textContent = state.recordingActive ? '■ Остановить запись' : 'Записать моё';
    el.btnPlayMine.disabled = !state.recording;

    if (state.error) {
      el.errorText.textContent = state.error.message;
      el.btnRetry.classList.toggle('hidden', !state.error.retry);
    }
  }

  // ---------- события ----------

  el.inputWord.addEventListener('input', renderState);
  el.inputWord.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearch(); });
  el.btnSearch.addEventListener('click', onSearch);
  el.inputAnswer.addEventListener('keydown', (e) => { if (e.key === 'Enter') onCheck(); });
  el.btnCheck.addEventListener('click', onCheck);
  el.btnRetryAnswer.addEventListener('click', onRetryAnswer);
  el.btnNext.addEventListener('click', onNext);
  el.btnNewWord.addEventListener('click', onNewWord);
  el.btnReplayApi.addEventListener('click', onReplayApi);
  el.btnRecord.addEventListener('click', onRecordToggle);
  el.btnPlayMine.addEventListener('click', onPlayMine);
  el.btnRetry.addEventListener('click', onRetry);
  el.apiAudio.addEventListener('error', onApiAudioError);

  renderState();
})();