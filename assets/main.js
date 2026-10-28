/* iKMS shared UI scripts — no dependencies */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  /* ---------- theme ---------- */
  var THEME_KEY = 'ikms-theme';
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    try { document.cookie = THEME_KEY + '=' + t + ';path=/;max-age=31536000;samesite=lax'; } catch (e) {}
    try { document.cookie = THEME_KEY + "=" + t + ";path=/;max-age=31536000;samesite=lax"; } catch (e) {}
  }
  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved !== 'dark' && saved !== 'light') { try { var m = document.cookie.match(/(?:^|; )ikms-theme=(dark|light)(?:;|$)/); if (m) saved = m[1]; } catch (e) {} }
    if (saved !== "dark" && saved !== "light") { try { var m = document.cookie.match(/(?:^|; )ikms-theme=(dark|light)/); if (m) saved = m[1]; } catch (e) {} }
  applyTheme(saved || 'dark');

  function bindThemeBtns() {
    doc.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
      });
    });
  }

  /* ---------- mobile nav ---------- */
  function bindNav() {
    var burger = doc.querySelector('.nav-burger');
    var links = doc.querySelector('.nav-links');
    if (!burger || !links) return;
    burger.addEventListener('click', function () {
      links.classList.toggle('open');
      burger.setAttribute('aria-expanded', links.classList.contains('open'));
    });
    doc.addEventListener('click', function (e) {
      if (links.classList.contains('open') && !links.contains(e.target) && !burger.contains(e.target)) {
        links.classList.remove('open');
      }
    });
  }

  /* ---------- announcement bar ---------- */
  function bindNotice() {
    var bar = doc.querySelector('.notice');
    if (!bar) return;
    var key = 'ikms-notice-dismissed';
    var stamp = bar.getAttribute('data-stamp') || '';
    try {
      if (localStorage.getItem(key) === stamp && stamp) bar.style.display = 'none';
    } catch (e) {}
    var close = bar.querySelector('.notice-close');
    if (close) close.addEventListener('click', function () {
      bar.style.display = 'none';
      try { localStorage.setItem(key, stamp); } catch (e) {}
    });
  }

  /* ---------- copy to clipboard ---------- */
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) {}
      doc.body.removeChild(ta);
      done(ok);
    }
  }

  function bindCopy() {
    /* 事件委托：动态渲染的线路卡片（more.html）无需重新绑定 */
    doc.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-copy]') : null;
      if (!btn) return;
      var source = btn.getAttribute('data-copy');
      var text = source !== null && source !== ''
        ? source
        : (btn.closest('.cmd, .term-body, .key-row, .mini-cmd, .line-actions') || doc).querySelector('code')?.textContent || '';
      copyText(text.trim(), function (ok) {
        var label = btn.querySelector('.copy-label');
        var old = label ? label.textContent : '';
        btn.classList.add('copied');
        if (label) label.textContent = ok ? '已复制' : '复制失败';
        var t = doc.querySelector('.toast');
        if (t) {
          t.classList.add('show');
          clearTimeout(t._timer);
          t._timer = setTimeout(function () { t.classList.remove('show'); }, 1600);
        }
        setTimeout(function () {
          btn.classList.remove('copied');
          if (label) label.textContent = old || '复制';
        }, 1600);
      });
    });
  }

  /* ---------- reveal on scroll ---------- */
  function bindReveal() {
    var els = doc.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- TOC scrollspy ---------- */
  function bindSpy() {
    var links = Array.prototype.slice.call(doc.querySelectorAll('.toc a[href^="#"]'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    var map = {};
    links.forEach(function (a) {
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      var sec = doc.getElementById(id);
      if (sec) map[id] = a;
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.classList.remove('active'); });
          var a = map[en.target.id];
          if (a) {
            a.classList.add('active');
            a.scrollIntoView({ block: 'nearest' });
          }
        }
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    Object.keys(map).forEach(function (id) { io.observe(doc.getElementById(id)); });
  }

  /* ---------- back to top ---------- */
  function bindTop() {
    var btn = doc.querySelector('.to-top');
    if (!btn) return;
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        btn.classList.toggle('show', window.scrollY > 480);
        ticking = false;
      });
    }, { passive: true });
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ---------- current page highlight ---------- */
  function markActiveNav() {
    var path = location.pathname.split('/').pop() || 'index.html';
    doc.querySelectorAll('.nav-links a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (href === './' + path || href === path || (path === 'index.html' && href === './')) {
        a.classList.add('active');
      }
    });
  }

  function init() {
    bindThemeBtns();
    bindNav();
    bindNotice();
    bindCopy();
    bindReveal();
    bindSpy();
    bindTop();
    markActiveNav();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
