'use strict';

(function () {
  const DATA_BASE = './data';
  const AUDIO_BASE = 'https://api.tatoeba.org/v1/audios';
  const SEARCH_LIMIT = 20;
  const FETCH_TIMEOUT_MS = 90000;
  const AUDIO_RETRY_DELAY_MS = 400;
  const AUDIO_MAX_RETRIES = 2;
  const RECORD_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const GTX_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=';
  const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get?q=';
  const HARPER_INDEX_URL = './vendor/harper/index.js';
  const HARPER_BINARY_URL = './vendor/harper/binary.js';

  const $ = (id) => document.getElementById(id);

  const el = {
    panelWord: $('panel-word'),
    panelExercise: $('panel-exercise'),
    panelAudio: $('panel-audio'),
    panelNav: $('panel-nav'),
    panelError: $('panel-error'),
    spinner: $('spinner'),
    inputWord: $('input-word'),
    queryWord: $('query-word'),
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
    lintDialog: $('lint-dialog'),
    lintList: $('lint-list'),
    btnLintClose: $('btnLintClose'),
    checkingHint: $('checking-hint'),
  };

  const state = {
    step: 'word',           // 'word' | 'loading' | 'exercise' | 'revealed'
    query: '',
    pool: [],               // [{ enId, enText, ruText, audios: string[] }]
    cursor: -1,
    seenIds: new Set(),
    candQueue: [],          // id предложений-кандидатов (тир 1 → тир 3)
    candIdx: 0,
    revealed: false,
    userAnswer: '',
    audioIndex: 0,
    audioRetries: 0,
    audioUnavailable: false,
    preloadFailed: false,
    loadingMore: false,
    recording: null,        // { blobUrl, mime }
    recordingActive: false,
    error: null,            // { message, retry }
    grammar: null,          // { status: 'checking'|'ok'|'errors'|'unavailable', lints: [...] }
  };

  // Хэндлы MediaRecorder — вне state, т.к. это не UI-состояние.
  let recorder = null;
  let mediaStream = null;
  let chunks = [];
  let recorderToken = 0;
  let preloadMode = false;
  let harperLinter = null;
  let harperLoadPromise = null;
  let grammarToken = 0;

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
    state.candQueue = [];
    state.candIdx = 0;
    state.cursor = -1;
  }

  // ---------- локальные данные Tatoeba ----------

  let localData = null;
  let localDataPromise = null;

  async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('http_' + res.status);
    return await res.text();
  }

  function parseJsonl(text) {
    const map = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const o = JSON.parse(line);
      if (o && o.id != null) map.set(o.id, o.t);
    }
    return map;
  }

  async function loadData() {
    const [engRaw, ruRaw, links, audio, wordidx] = await Promise.all([
      fetchText(DATA_BASE + '/eng.jsonl'),
      fetchText(DATA_BASE + '/ru.jsonl'),
      fetchText(DATA_BASE + '/links.json'),
      fetchText(DATA_BASE + '/audio.json'),
      fetchText(DATA_BASE + '/wordidx.json'),
    ]);
    localData = {
      engMap: parseJsonl(engRaw),
      ruMap: parseJsonl(ruRaw),
      linksMap: new Map(Object.entries(JSON.parse(links))),
      audioMap: new Map(Object.entries(JSON.parse(audio))),
      wordidx: JSON.parse(wordidx),
    };
    return localData;
  }

  function ensureData() {
    if (localData) return Promise.resolve(localData);
    if (localDataPromise) return localDataPromise;
    localDataPromise = loadData().catch((err) => { localDataPromise = null; throw err; });
    return localDataPromise;
  }

  function tokenizeQuery(q) {
    const norm = q.normalize('NFKC').toLowerCase();
    const toks = (norm.match(/[0-9a-z']+/g) || [])
      .map((t) => t.replace(/^'+|'+$/g, ''))
      .filter(Boolean);
    return [...new Set(toks)];
  }

  function intersectArrays(a, b) {
    const small = a.length <= b.length ? a : b;
    const large = a.length <= b.length ? b : a;
    const set = new Set(small);
    return large.filter((x) => set.has(x));
  }

  function shuffle(a) {
    const arr = a.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildLocalItem(id) {
    const d = localData;
    const text = d.engMap.get(id);
    if (!text) return null;
    let ruText = null;
    const ruIds = d.linksMap.get(String(id));
    if (ruIds && ruIds.length) {
      for (const rid of ruIds) {
        const t = d.ruMap.get(rid) || d.ruMap.get(String(rid));
        if (t) { ruText = t; break; }
      }
    }
    const audioIds = d.audioMap.get(String(id));
    const audios = (audioIds || []).map((a) => AUDIO_BASE + '/' + a + '/file');
    if (!audios.length) return null;
    return { enId: id, enText: text, ruText, auto: !ruText, audios };
  }

  function fillPool(target) {
    while (state.pool.length < target && state.candIdx < state.candQueue.length) {
      const id = state.candQueue[state.candIdx++];
      if (state.seenIds.has(id)) continue;
      const item = buildLocalItem(id);
      if (!item) continue;
      state.seenIds.add(id);
      state.pool.push(item);
    }
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

  // ---------- локальный поиск ----------

  async function performSearch(q) {
    resetPool();
    const d = await ensureData();
    const tokens = tokenizeQuery(q);
    let cands = null;
    for (const tok of tokens) {
      const list = d.wordidx[tok];
      if (!list) return false;
      const set = new Set(list);
      cands = cands === null ? list : cands.filter((id) => set.has(id));
    }
    if (!cands || !cands.length) return false;
    const withRu = cands.filter((id) => d.linksMap.has(String(id)));
    const withoutRu = cands.filter((id) => !d.linksMap.has(String(id)));
    state.candQueue = shuffle(withRu).concat(shuffle(withoutRu));
    state.candIdx = 0;
    fillPool(SEARCH_LIMIT);
    return state.pool.length > 0;
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
      setError('Не удалось загрузить данные. Проверьте соединение.', true);
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

  // ---------- проверка грамматики (harper.js) ----------

  async function loadHarper() {
    if (harperLoadPromise) return harperLoadPromise;
    harperLoadPromise = Promise.all([
      import(HARPER_INDEX_URL),
      import(HARPER_BINARY_URL),
    ]).then(async ([idx, bin]) => {
      const linter = new idx.WorkerLinter({ binary: bin.binary });
      await linter.setup();
      harperLinter = linter;
      return linter;
    }).catch((err) => {
      harperLoadPromise = null;
      throw err;
    });
    return harperLoadPromise;
  }

  function freeGrammar() {
    const g = state.grammar;
    if (g && Array.isArray(g.lints)) {
      for (const l of g.lints) { try { l.free(); } catch (e) { /* ignore */ } }
    }
  }

  async function runGrammarCheck() {
    const item = currentItem();
    const text = state.userAnswer;
    const token = ++grammarToken;
    if (!item || !text) {
      freeGrammar();
      state.grammar = { status: 'idle', lints: [] };
      renderState();
      return;
    }
    const your = normalize(text);
    const correct = normalize(item.enText);
    if (your === correct) return;
    freeGrammar();
    state.grammar = { status: 'checking', lints: [] };
    renderState();
    try {
      const linter = await loadHarper();
      if (token !== grammarToken) return;
      const lints = await linter.lint(text, { language: 'plaintext' });
      if (token !== grammarToken) return;
      freeGrammar();
      state.grammar = { status: lints.length ? 'errors' : 'ok', lints };
    } catch (err) {
      if (token !== grammarToken) return;
      freeGrammar();
      state.grammar = { status: 'unavailable', lints: [] };
    }
    renderState();
  }

  function openLintDialog() {
    const g = state.grammar;
    if (!g) return;
    if (g.status === 'unavailable') {
      el.lintList.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'lint-unavailable';
      msg.textContent = 'Проверка грамматики недоступна: не удалось загрузить сервис проверки (нет соединения?). Ваш вариант отличается от эталона.';
      el.lintList.appendChild(msg);
      el.lintDialog.showModal();
      return;
    }
    if (g.status !== 'errors' || !g.lints.length) return;
    el.lintList.textContent = '';
    g.lints.forEach((lint, i) => {
      const item = document.createElement('div');
      item.className = 'lint-item';
      const h = document.createElement('p');
      h.className = 'lint-message';
      h.textContent = lint.message();
      const scope = document.createElement('p');
      scope.className = 'lint-scope';
      scope.textContent = 'Фрагмент: «' + lint.get_problem_text() + '»';
      item.appendChild(h);
      item.appendChild(scope);
      el.lintList.appendChild(item);
    });
    el.lintDialog.showModal();
  }

  // ---------- упражнение ----------

function resetExercise() {
  el.inputAnswer.value = '';
  state.userAnswer = '';
  state.revealed = false;
  state.step = 'exercise';
  state.audioIndex = 0;
  state.audioRetries = 0;
  state.audioUnavailable = false;
  state.preloadFailed = false;
  freeGrammar();
  state.grammar = null;
  try { el.lintDialog.close(); } catch (e) { /* ignore */ }
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
    freeGrammar();
    state.grammar = { status: 'checking', lints: [] };
    renderState();
    playApiAudio();
    runGrammarCheck();
  }

  function onNext() {
    if (state.loadingMore || state.pool.length === 0) return;
    clearError();
    if (state.cursor + 1 < state.pool.length) {
      state.cursor++;
      resetExercise();
      renderState();
      return;
    }
    const before = state.pool.length;
    fillPool(state.pool.length + SEARCH_LIMIT);
    if (state.pool.length > before) {
      state.cursor = before;
      resetExercise();
      renderState();
      return;
    }
    setError('Предложения по этому слову закончились. Нажмите «Повторить» для нового поиска или выберите новое слово.', true);
    renderState();
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
    preloadMode = false;
    loadApiAudio(item.audios[state.audioIndex]);
    playWhenReady();
  }

  function loadApiAudio(url) {
    if (el.apiAudio.getAttribute('src') === url && state.audioRetries === 0) return;
    try {
      el.apiAudio.preload = 'auto';
      el.apiAudio.src = url;
      el.apiAudio.load();
    } catch (e) { /* ignore */ }
  }

  function playWhenReady() {
    if (el.apiAudio.readyState >= 2) {
      doPlayApiAudio();
      return;
    }
    let done = false;
    const onCanPlay = () => finish();
    const timer = setTimeout(finish, 8000);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.apiAudio.removeEventListener('canplay', onCanPlay);
      doPlayApiAudio();
    }
    el.apiAudio.addEventListener('canplay', onCanPlay);
    function doPlayApiAudio() {
      el.apiAudio.play()
        .then(() => hideHint())
        .catch(() => showHint('Нажмите «Произношение (носитель)», чтобы прослушать произношение.'));
    }
  }

function preloadApiAudio() {
  const item = currentItem();
  if (!item || state.audioUnavailable || state.preloadFailed) return;
  const url = item.audios[state.audioIndex];
  if (!url) return;
  if (el.apiAudio.getAttribute('src') === url && state.audioRetries === 0) return;
  preloadMode = true;
  loadApiAudio(url);
}

  function onApiAudioError() {
    const item = currentItem();
    const currentSrc = el.apiAudio.getAttribute('src');
    if (!item || state.audioUnavailable || !currentSrc) return;
    state.audioRetries++;
    if (state.audioRetries <= AUDIO_MAX_RETRIES) {
      setTimeout(() => {
        if (currentItem() !== item || state.audioUnavailable) return;
        if (el.apiAudio.getAttribute('src') !== currentSrc) return;
        if (preloadMode && state.step === 'exercise') {
          preloadApiAudio();
        } else {
          playApiAudio();
        }
      }, AUDIO_RETRY_DELAY_MS);
      return;
    }
    state.audioRetries = 0;
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

    el.queryWord.textContent = state.step === 'word' ? '' : state.query;

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
      const g = state.grammar || { status: 'checking' };
      const near = !matched && g.status === 'ok';
      const bad = !matched && (g.status === 'errors' || g.status === 'unavailable' || g.status === 'idle');
      el.yourCell.classList.toggle('match', matched);
      el.yourCell.classList.toggle('near', near);
      el.yourCell.classList.toggle('mismatch', bad);
      el.yourCell.classList.toggle('clickable', bad);
      el.yourCell.title = bad ? 'Нажмите, чтобы увидеть подробности' : '';
      const checking = !matched && !bad && !near;
      el.checkingHint.classList.toggle('hidden', !checking);
    } else {
      el.yourCell.classList.remove('match', 'near', 'mismatch', 'clickable');
      if (el.checkingHint) el.checkingHint.classList.add('hidden');
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
  el.apiAudio.addEventListener('canplay', () => { state.audioRetries = 0; });
  el.yourCell.addEventListener('click', onYourCellClick);
  el.btnLintClose.addEventListener('click', () => { try { el.lintDialog.close(); } catch (e) { /* ignore */ } });

  function onYourCellClick() {
    const g = state.grammar;
    if (!g) return;
    if (g.status === 'errors' || g.status === 'unavailable') openLintDialog();
  }

  renderState();
})();