export async function fetchModisNDVI(lat, lon, onProgress) {
  onProgress(0);
  const url = `https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?`
    + `latitude=${lat}&longitude=${lon}&startDate=A2019001&endDate=A2022353`
    + `&kmAboveBelow=2&kmLeftRight=2`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`MODIS request failed: ${r.status}`);
  const d = await r.json();
  onProgress(100);
  const results = (d.subset || [])
    .filter(s => s.band === '250m_16_days_NDVI')
    .map(row => {
      const vals = row.data.map(v => v * row.scale).filter(v => v > -0.2 && v <= 1.0);
      if (!vals.length) return null;
      return { date: row.calendar_date, value: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean);

  // Accumulate NDVI per DOY across years
  const doySum = new Array(365).fill(0), doyCnt = new Array(365).fill(0);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  results.forEach(({ date, value }) => {
    const [, mo, dy] = date.split('-').map(Number);
    let doy = 0;
    for (let m = 0; m < mo - 1; m++) doy += dim[m];
    doy = Math.min(doy + dy - 1, 364);
    for (let dd = 0; dd < 16; dd++) { const d2 = (doy + dd) % 365; doySum[d2] += value; doyCnt[d2]++; }
  });

  let raw = doySum.map((s, i) => doyCnt[i] > 0 ? s / doyCnt[i] : null);

  // Fill nulls by interpolation
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 365; i++) {
      if (raw[i] === null) {
        const prev = raw[(i + 364) % 365], next = raw[(i + 1) % 365];
        raw[i] = prev !== null && next !== null ? (prev + next) / 2
               : prev !== null ? prev : next;
      }
    }
  }

  // Gaussian smoothing to remove 16-day staircase artifacts
  const sigma = 7, kernelR = 14;
  const gauss = x => Math.exp(-0.5 * (x / sigma) ** 2);
  const ndvi = raw.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + 365) % 365;
      if (raw[j] !== null) { const w = gauss(k); sum += raw[j] * w; wt += w; }
    }
    return Math.round((wt > 0 ? sum / wt : 0) * 1000) / 1000;
  });
  const sampMapUrl = `https://www.google.com/maps?q=${sampLat.toFixed(5)},${sampLon.toFixed(5)}`;
  return { ndvi, sampLat, sampLon, sampMapUrl };
}

export function ndviProxyFallback(tempArr, rainArr) {
  return tempArr.map((t, i) => {
    const r = rainArr[i]; let v = .08;
    if (r > .05)        v += .32 * (Math.min(r * 30, 5) / 5);
    if (t > 40 && t < 90) v += .28 * ((t - 40) / 50);
    if (t > 80)         v *= .78;
    if (r < .003 && t > 65) v *= .55;
    return Math.round(Math.max(.05, Math.min(.80, v)) * 1000) / 1000;
  });
}
