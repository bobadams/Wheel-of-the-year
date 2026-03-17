const url = 'https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset'
  + '?latitude=37.8&longitude=-122.2'
  + '&startDate=A2019001&endDate=A2019017'
  + '&kmAboveBelow=0&kmLeftRight=0';

const r = await fetch(url, { headers: { Accept: 'application/json' } });
console.log('HTTP status:', r.status);
const d = await r.json();
const allBands = [...new Set((d.subset || []).map(s => s.band))];
console.log('bands available:', allBands);
const row = (d.subset || []).find(s => s.band === '250m_16_days_NDVI');
if (!row) { console.log('NDVI band NOT found'); process.exit(1); }
console.log('scale:', row.scale);
console.log('calendar_date:', row.calendar_date);
console.log('data (first 5 raw):', row.data.slice(0, 5));
console.log('data * scale (first 5):', row.data.slice(0, 5).map(v => v * row.scale));
