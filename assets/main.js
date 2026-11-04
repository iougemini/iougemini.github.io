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

  /* ---------- 站点留言弹窗（悬浮信封 → Worker/Resend 转发） ---------- */
  var CONTACT_API = 'https://submit.ikms.eu.org/api/contact';
  var CONTACT_EMAIL = 'admin@ikms.eu.org';

  function bindContact() {
    var fab = doc.createElement('button');
    fab.className = 'contact-fab';
    fab.setAttribute('aria-label', '联系站长');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="m3 7 8.2 5.6a1.5 1.5 0 0 0 1.6 0L21 7"/></svg>';
    doc.body.appendChild(fab);

    var overlay = doc.createElement('div');
    overlay.className = 'contact-overlay';
    overlay.innerHTML =
      '<div class="contact-modal" role="dialog" aria-modal="true" aria-label="联系站长">' +
      '<button class="cm-close" aria-label="关闭">&times;</button>' +
      '<div class="cm-state cm-form">' +
      '<h3>有话直说，一封邮件就到</h3>' +
      '<p class="cm-sub">留言会通过邮件直接送达站长（admin@ikms.eu.org），回信到你填写的邮箱。</p>' +
      '<div class="cm-chips">' +
      '<button type="button" data-topic="投稿咨询：我的服务器地址是（仅管理员可见），希望能加入备用线路候选池。">投稿咨询</button>' +
      '<button type="button" data-topic="线路反馈：失效线路 sXX，时间是，错误码是。">线路失效</button>' +
      '<button type="button" data-topic="Bug 反馈：页面是，操作步骤是，期望结果是。">Bug 反馈</button>' +
      '<button type="button" data-topic="私密投稿：服务器地址（不会公开），备注：">私密投稿</button>' +
      '<button type="button" data-topic="">随便聊聊</button>' +
      '</div>' +
      '<div class="cm-row">' +
      '<div class="cm-field"><label>称呼 <span>选填</span></label><input id="cm-name" maxlength="80" autocomplete="name"></div>' +
      '<div class="cm-field"><label>邮箱 <span>必填</span></label><input id="cm-email" type="email" maxlength="200" autocomplete="email" placeholder="用于接收回信"></div>' +
      '</div>' +
      '<div class="cm-field"><label>留言 <span>必填</span></label><textarea id="cm-msg" maxlength="5000" placeholder="写点什么…"></textarea><span class="cm-count">0 / 5000</span></div>' +
      '<input id="cm-website" class="cm-hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<button type="button" class="cm-send" id="cm-send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>发送留言</button>' +
      '<p class="cm-note">提交即表示同意我们仅为回复此留言而使用你填写的邮箱，内容不会公开展示。</p>' +
      '</div>' +
      '<div class="cm-state cm-success" hidden>' +
      '<div class="cm-ok-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>' +
      '<h3>已经送到了</h3>' +
      '<p class="cm-sub">谢谢你的留言，站长会直接回信到你填的邮箱——记得查收，也顺手看一眼垃圾箱。</p>' +
      '<button type="button" class="cm-again">再写一封</button>' +
      '</div>' +
      '<div class="cm-state cm-fallback" hidden>' +
      '<h3>弹窗发信暂时不可用</h3>' +
      '<p class="cm-sub">直接写信到 <a href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + '</a>，我看到的时间一样。</p>' +
      '<a class="cm-send cm-mailto" href="mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent('[iKMS 留言]') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="m3 7 8.2 5.6a1.5 1.5 0 0 0 1.6 0L21 7"/></svg>打开邮件应用</a>' +
      '</div>' +
      '</div>';
    doc.body.appendChild(overlay);

    function open() {
      overlay.classList.add('open');
      doc.body.style.overflow = 'hidden';
      setTimeout(function () { var el = overlay.querySelector('#cm-name'); if (el) el.focus(); }, 80);
    }
    function close() {
      overlay.classList.remove('open');
      doc.body.style.overflow = '';
    }
    function show(state) {
      ['cm-form', 'cm-success', 'cm-fallback'].forEach(function (s) {
        var el = overlay.querySelector('.' + s);
        if (el) el.hidden = (s !== state);
      });
    }

    fab.addEventListener('click', open);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    var closeBtn = overlay.querySelector('.cm-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });

    /* 页脚「反馈邮箱」也改为打开弹窗（mailto 保留在兜底页） */
    doc.querySelectorAll('a[href^="mailto:' + CONTACT_EMAIL + '"]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });

    /* 快捷主题起头 */
    overlay.querySelectorAll('.cm-chips button').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var t = overlay.querySelector('#cm-msg');
        if (t && chip.getAttribute('data-topic')) t.value = chip.getAttribute('data-topic');
        if (t) { t.dispatchEvent(new Event('input')); t.focus(); }
      });
    });

    /* 字数统计 */
    var ta = overlay.querySelector('#cm-msg');
    var counter = overlay.querySelector('.cm-count');
    if (ta && counter) ta.addEventListener('input', function () { counter.textContent = ta.value.length + ' / 5000'; });

    var again = overlay.querySelector('.cm-again');
    if (again) again.addEventListener('click', function () { show('cm-form'); });

    /* 发送 */
    var sendBtn = overlay.querySelector('#cm-send');
    if (sendBtn) sendBtn.addEventListener('click', function () {
      var emailEl = overlay.querySelector('#cm-email');
      var nameEl = overlay.querySelector('#cm-name');
      var hpEl = overlay.querySelector('#cm-website');
      var email = emailEl ? emailEl.value : '';
      var name = nameEl ? nameEl.value : '';
      var hp = hpEl ? hpEl.value : '';
      var message = ta ? ta.value : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { alert('请填写有效的邮箱地址'); return; }
      if (!message.trim()) { alert('请填写留言内容'); return; }
      sendBtn.disabled = true;
      sendBtn.classList.add('sending');
      fetch(CONTACT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), message: message, website: hp }),
      }).then(function (r) { return r.json().catch(function () { throw 0; }); }).then(function (j) {
        if (j && j.ok) { show('cm-success'); }
        else { show('cm-fallback'); }
      }).catch(function () {
        show('cm-fallback');
      }).finally(function () {
        sendBtn.disabled = false;
        sendBtn.classList.remove('sending');
      });
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
    bindContact();
    markActiveNav();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
