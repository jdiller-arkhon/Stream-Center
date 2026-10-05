(function () {
  var api = window.drift;
  var caps = document.getElementById('caps');
  var obs = document.getElementById('obs');
  if (!api) { caps.textContent = 'Desktop bridge unavailable.'; return; }
  function show(s) { caps.textContent = JSON.stringify(s.capabilities, null, 2); obs.textContent = JSON.stringify(s.obs, null, 2); }
  api.onState(show);
  api.readState().then(show, function (e) { caps.textContent = String(e); });
  document.getElementById('connect').addEventListener('click', function () {
    api.readState().then(function (s) { return api.request('connect', { host: s.settings.obsHost, port: s.settings.obsPort }, String(Date.now())); }).catch(function (e) { obs.textContent = String(e); });
  });
})();
