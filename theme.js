'use strict';

// Переключение темы оформления (авто/тёмная/светлая).
// Общий модуль: подключается на всех страницах (index.html, guide.html,
// settings.html). Выбор хранится в localStorage, ключ 'tatoeba-theme'.

(function () {
  const KEY = 'tatoeba-theme';
  const MODES = ['system', 'dark', 'light'];
  const LABELS = { system: 'Тема: авто', dark: 'Тема: тёмная', light: 'Тема: светлая' };
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(mode) {
    document.documentElement.removeAttribute('data-theme');
    if (mode === 'dark' || mode === 'light') document.documentElement.setAttribute('data-theme', mode);
    const dark = mode === 'dark' || (mode === 'system' && mq.matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f141d' : '#2f6fed');
  }

  function refresh() {
    let mode = 'system';
    try { mode = localStorage.getItem(KEY) || 'system'; } catch (e) {}
    apply(mode);
    const buttons = document.querySelectorAll('#btnTheme, #btnThemeFooterPreview');
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].textContent = LABELS[mode] || LABELS.system;
      buttons[i].title = 'Переключить тему';
    }
  }

  function onClick() {
    let mode = 'system';
    try { mode = localStorage.getItem(KEY) || 'system'; } catch (e) {}
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem(KEY, next); } catch (e) {}
    refresh();
  }

  const buttons = document.querySelectorAll('#btnTheme, #btnThemeFooterPreview');
  for (let i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', onClick);
  if (mq.addEventListener) mq.addEventListener('change', refresh);
  else if (mq.addListener) mq.addListener(refresh);
  refresh();
})();