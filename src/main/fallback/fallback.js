(function () {
  var api = window.driftDesktop;
  var caps = document.getElementById('caps');
  var obs = document.getElementById('obs');
  if (!api) { caps.textContent = 'Desktop bridge unavailable.'; return; }
  function show(el, r) { el.textContent = JSON.stringify(r.ok ? r.data : r.error, null, 2); }
  api.invoke('system.getCapabilities', {}).then(function (r) { show(caps, r); });
  api.invoke('obs.getState', {}).then(function (r) { show(obs, r); });
  api.on('obs.state', function (s) { obs.textContent = JSON.stringify(s, null, 2); });
  document.getElementById('connect').addEventListener('click', function () { api.invoke('obs.connect', {}); });
})();
