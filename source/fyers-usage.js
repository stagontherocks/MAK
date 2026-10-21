/* Fyers data-call usage meter (nav bar).
   The Fyers Standard plan allows 5,000 data calls/day. Each /api/fyers/*
   route reports how many real Fyers calls it made via the X-Fyers-Calls
   response header (cache hits report 0). This script totals them per IST day
   in localStorage and shows "API used / 5,000" next to the Connect button.
   It only counts calls made from THIS browser, and starts from 0 when first
   loaded -- calls made before it existed (or from another device) aren't
   included, so treat it as a floor, not an exact figure. X-Fyers-Limit: daily
   (Fyers refused for quota) pins the meter to full. */
(function(){
  var KEY = 'fyersUsage_v1';
  var LIMIT = 5000;
  var LABELS = { 'quotes': 'Prices (F&O)', 'mcx-quotes': 'Prices (MCX)', 'option-chain': 'Option chains', 'gainers': 'Gainers/Losers scan', 'screener': 'High IV scan' };

  function istDay(){
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return p; // YYYY-MM-DD
  }
  function load(){
    var blank = { day: istDay(), total: 0, routes: {}, exhausted: false };
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank;
      var u = JSON.parse(raw);
      return u && u.day === blank.day ? u : blank;
    } catch (err) { return blank; }
  }
  function save(u){ try { localStorage.setItem(KEY, JSON.stringify(u)); } catch (err) {} }

  var pill, usage = load();

  function fmt(n){ return n.toLocaleString('en-IN'); }
  function render(){
    if (!pill) return;
    usage = load();
    var pct = usage.exhausted ? 100 : Math.min(100, usage.total / LIMIT * 100);
    pill.className = 'fyers-usage ' + (pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : 'ok');
    pill.querySelector('.fu-text').textContent = usage.exhausted ? 'API limit reached' : 'API ' + fmt(usage.total) + ' / ' + fmt(LIMIT);
    pill.querySelector('.fu-bar i').style.width = pct + '%';
    var lines = Object.keys(usage.routes).sort(function(a, b){ return usage.routes[b] - usage.routes[a]; })
      .map(function(r){ return (LABELS[r] || r) + ': ' + fmt(usage.routes[r]); });
    pill.title = 'Fyers data calls today (this browser, resets at midnight IST). Plan limit ' + fmt(LIMIT) + '/day.' +
      (lines.length ? '\n' + lines.join('\n') : '\nNo calls yet.') +
      (usage.exhausted ? '\nFyers reported the daily limit is reached.' : '');
  }

  function record(url, res){
    var m = /\/api\/fyers\/([a-z-]+)/.exec(url);
    if (!m) return;
    var calls = Number(res.headers.get('X-Fyers-Calls'));
    var limit = res.headers.get('X-Fyers-Limit') === 'daily';
    if (!(calls > 0) && !limit) return;
    var u = load();
    if (calls > 0) {
      u.total += calls;
      u.routes[m[1]] = (u.routes[m[1]] || 0) + calls;
    }
    if (limit) u.exhausted = true;
    save(u);
    render();
  }

  var realFetch = window.fetch;
  window.fetch = function(input){
    var p = realFetch.apply(this, arguments);
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/fyers/') !== -1) p.then(function(res){ record(url, res); }, function(){});
    } catch (err) {}
    return p;
  };

  function mount(){
    var style = document.createElement('style');
    style.textContent =
      '.fyers-usage{display:inline-flex;flex-direction:column;gap:4px;margin-right:12px;padding:6px 10px;border-radius:8px;background:#1c1c1c;border:1px solid #262626;font-size:12px;font-weight:600;color:#cfcfcf;cursor:help;white-space:nowrap}' +
      '.fyers-usage .fu-bar{display:block;height:3px;border-radius:2px;background:#2c2c2c;overflow:hidden}' +
      '.fyers-usage .fu-bar i{display:block;height:100%;width:0;background:#2ecc71;transition:width .3s ease}' +
      '.fyers-usage.warm .fu-bar i{background:#f5a623}.fyers-usage.warm{color:#f5a623}' +
      '.fyers-usage.hot .fu-bar i{background:#ff4d4f}.fyers-usage.hot{color:#ff4d4f}' +
      '@media (max-width:720px){.fyers-usage{display:none}}';
    document.head.appendChild(style);
    pill = document.createElement('span');
    var text = document.createElement('span'); text.className = 'fu-text';
    var bar = document.createElement('span'); bar.className = 'fu-bar';
    bar.appendChild(document.createElement('i'));
    pill.appendChild(text); pill.appendChild(bar);
    var btn = document.getElementById('connectBtn');
    if (btn && btn.parentNode) {
      // the nav bar is a flex row; put the meter and button together on the right
      var holder = document.createElement('div');
      holder.style.cssText = 'display:flex;align-items:center';
      btn.parentNode.insertBefore(holder, btn);
      holder.appendChild(pill);
      holder.appendChild(btn);
    } else {
      var wrap = document.querySelector('.navbar .wrap');
      if (wrap) wrap.appendChild(pill);
    }
    render();
  }
  window.addEventListener('storage', function(e){ if (e.key === KEY) render(); }); // other tabs' calls
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
