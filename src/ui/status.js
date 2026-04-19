export function setStatus(type, msg) {
  const el = document.getElementById('status');
  el.className = 'status ' + type;
  el.textContent = msg;
}

export function setLoading(on) {
  document.getElementById('spinner').className = 'spinner' + (on ? ' on' : '');
  document.getElementById('fetchBtn').disabled = on;
}

export function setEviProgress(visible, pct = 0, msg = '') {
  document.getElementById('eviProgress').className = 'evi-progress' + (visible ? ' visible' : '');
  document.getElementById('eviBar').style.width = pct + '%';
  document.getElementById('eviMsg').textContent = msg;
}
