export function setStatus(type, msg) {
  const el = document.getElementById('status');
  el.className = 'status ' + type;
  el.textContent = msg;
}

export function setLoading(on) {
  document.getElementById('spinner').className = 'spinner' + (on ? ' on' : '');
  document.getElementById('fetchBtn').disabled = on;
}

export function setNdviProgress(visible, pct = 0, msg = '') {
  document.getElementById('ndviProgress').className = 'ndvi-progress' + (visible ? ' visible' : '');
  document.getElementById('ndviBar').style.width = pct + '%';
  document.getElementById('ndviMsg').textContent = msg;
}
