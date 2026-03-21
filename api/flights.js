// api/flights.js — Vercel serverless function
// Set RAPIDAPI_KEY in Vercel environment variables for live data.
// Without it, returns mock data automatically — app never breaks.

const cache = new Map();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

function getMockFlights(iata) {
  const now = new Date();
  const airlines = [
    { code: 'AC', name: 'Air Canada' }, { code: 'WS', name: 'WestJet' },
    { code: 'UA', name: 'United' },     { code: 'AA', name: 'American' },
    { code: 'DL', name: 'Delta' },      { code: 'B6', name: 'JetBlue' },
    { code: 'WN', name: 'Southwest' },  { code: 'AS', name: 'Alaska' },
  ];
  const dests = [
    { iata:'ORD', name:"Chicago O'Hare",   city:'Chicago' },
    { iata:'JFK', name:'John F. Kennedy',   city:'New York' },
    { iata:'LAX', name:'Los Angeles Intl',  city:'Los Angeles' },
    { iata:'ATL', name:'Hartsfield-Jackson',city:'Atlanta' },
    { iata:'DFW', name:'Dallas/Fort Worth', city:'Dallas' },
    { iata:'DEN', name:'Denver Intl',       city:'Denver' },
    { iata:'SEA', name:'Sea-Tac Intl',      city:'Seattle' },
    { iata:'MIA', name:'Miami Intl',        city:'Miami' },
    { iata:'BOS', name:'Logan Intl',        city:'Boston' },
    { iata:'LHR', name:'Heathrow',          city:'London' },
    { iata:'NRT', name:'Narita',            city:'Tokyo' },
    { iata:'YYZ', name:'Toronto Pearson',   city:'Toronto' },
    { iata:'LAS', name:'Harry Reid Intl',   city:'Las Vegas' },
    { iata:'PHX', name:'Sky Harbor',        city:'Phoenix' },
    { iata:'SLC', name:'Salt Lake City',    city:'Salt Lake City' },
  ];
  const statuses = ['On Time','On Time','On Time','Delayed','Delayed','Boarding','Departed','Cancelled'];
  const aircraft = ['B737','B739','A320','A321','B757','B777','B787','A220','A319'];
  const gates = ['A','B','C','D','E','F'];

  const flights = Array.from({ length: 20 }, (_, i) => {
    const al  = airlines[Math.floor(Math.random() * airlines.length)];
    const dst = dests[Math.floor(Math.random() * dests.length)];
    const st  = statuses[Math.floor(Math.random() * statuses.length)];
    const delayMin = st === 'Delayed' ? (Math.floor(Math.random() * 6) + 1) * 15 : 0;
    const depMins  = (i * 20) - 30 + Math.floor(Math.random() * 10);
    const sched    = new Date(now.getTime() + depMins * 60000);
    const hh = String(sched.getHours()).padStart(2,'0');
    const mm = String(sched.getMinutes()).padStart(2,'0');

    return {
      id:          `${al.code}${Math.floor(Math.random() * 900) + 100}`,
      airline:     al.name,
      airlineCode: al.code,
      dest:        dst.iata,
      destName:    dst.city,
      time:        `${hh}:${mm}`,
      gate:        `${gates[Math.floor(Math.random()*gates.length)]}${Math.floor(Math.random()*30)+1}`,
      status:      st,
      aircraft:    aircraft[Math.floor(Math.random() * aircraft.length)],
      delayMin,
      delayProb:   st === 'Delayed'   ? 0.6  + Math.random() * 0.35 :
                   st === 'Cancelled' ? 0.99 :
                   st === 'Boarding'  ? 0.05 + Math.random() * 0.15 :
                                        0.08 + Math.random() * 0.50,
      vol: Math.floor(Math.random() * 18000) + 2000,
    };
  });

  return flights.sort((a, b) => a.time.localeCompare(b.time));
}

function transformFlight(f) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const al  = f.airline   || {};
  const num = f.number    || '';

  const schedLocal   = dep.scheduledTime?.local || dep.scheduledTime?.utc || null;
  const revisedLocal = dep.revisedTime?.local   || dep.revisedTime?.utc   || schedLocal;

  let delayMin = 0;
  if (schedLocal && revisedLocal) {
    delayMin = Math.max(0, Math.round((new Date(revisedLocal) - new Date(schedLocal)) / 60000));
  }

  const statusMap = {
    Scheduled:'On Time', Active:'On Time', Delayed:'Delayed',
    Landed:'Departed',   Departed:'Departed', Cancelled:'Cancelled',
    Boarding:'Boarding', GateClosed:'Boarding', Unknown:'On Time',
  };
  let status = statusMap[f.status] || 'On Time';
  if (delayMin >= 15 && status === 'On Time') status = 'Delayed';

  const schedDate = schedLocal ? new Date(schedLocal) : new Date();
  const hh = String(schedDate.getHours()).padStart(2,'0');
  const mm = String(schedDate.getMinutes()).padStart(2,'0');

  return {
    id:          num,
    airline:     al.name || 'Unknown',
    airlineCode: al.iata || num.slice(0,2),
    dest:        arr.airport?.iata || '???',
    destName:    arr.airport?.municipalityName || arr.airport?.name || 'Unknown',
    time:        `${hh}:${mm}`,
    gate:        dep.gate     || null,
    status,
    aircraft:    f.aircraft?.model || '—',
    delayMin,
    delayProb:   status === 'Delayed'   ? 0.6  + Math.random() * 0.35 :
                 status === 'Cancelled' ? 0.99 :
                 status === 'Boarding'  ? 0.05 + Math.random() * 0.15 :
                                          0.08 + Math.random() * 0.50,
    vol: Math.floor(Math.random() * 18000) + 2000,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // Accept either ICAO (KSFO) or IATA (SFO) — AeroDataBox uses IATA
  let code = (req.query.airport || 'SFO').toUpperCase();
  // Strip leading K for common US airports if someone passes ICAO
  const iata = code.length === 4 && code.startsWith('K') ? code.slice(1) : code;

  const cached = cache.get(iata);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    const flights = getMockFlights(iata);
    return res.json({ flights, iata, fetchedAt: new Date().toISOString(), mock: true, cached: false });
  }

  try {
    const url = `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${iata}`
              + `?offsetMinutes=-60&durationMinutes=480&withLeg=true`
              + `&direction=Departure&withCancelled=true&withCodeshared=false`
              + `&withCargo=false&withPrivate=false&withLocation=false`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
        'x-rapidapi-key':  apiKey,
      },
    });

    if (!response.ok) throw new Error(`AeroDataBox ${response.status}`);

    const data    = await response.json();
    const flights = (data.departures || [])
      .map(transformFlight)
      .sort((a, b) => a.time.localeCompare(b.time));

    const payload = { flights, iata, fetchedAt: new Date().toISOString(), mock: false, cached: false };
    cache.set(iata, { payload, ts: Date.now() });
    return res.json(payload);

  } catch (err) {
    console.error('AeroDataBox error:', err.message);
    const flights = getMockFlights(iata);
    return res.json({ flights, iata, fetchedAt: new Date().toISOString(), mock: true, fallback: true, cached: false });
  }
}