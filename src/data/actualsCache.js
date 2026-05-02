const key = city => `woty_actuals:${city}`;

export function saveActualsCache(city, actualsData, todayDOYVal) {
  try {
    localStorage.setItem(key(city), JSON.stringify({ ts: Date.now(), todayDOY: todayDOYVal, data: actualsData }));
  } catch { /* quota exceeded or private browsing */ }
}

export function loadActualsCache(city) {
  try {
    const raw = localStorage.getItem(key(city));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
