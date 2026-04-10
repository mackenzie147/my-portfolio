// api/flights.js — FlightAware AeroAPI v4
// Set FLIGHTAWARE_KEY in Vercel environment variables

const BASE_RATES = {
  YYZ:0.65,EWR:0.45,JFK:0.38,ORD:0.35,SFO:0.30,
  BOS:0.28,MIA:0.27,DFW:0.25,DEN:0.24,LAX:0.21,ATL:0.20,SEA:0.18,
};
const AIRLINE_RATES = {
  'Air Canada':0.58,'WestJet':0.42,'Spirit':0.45,'Frontier':0.43,
  'United':0.32,'American':0.31,'Delta':0.22,'Southwest':0.28,
  'JetBlue':0.35,'Alaska':0.20,'Hawaiian':0.18,'Lufthansa':0.28,
};
const IATA_TO_ICAO = {
  SFO:'KSFO',LAX:'KLAX',JFK:'KJFK',EWR:'KEWR',ORD:'KORD',ATL:'KATL',
  DEN:'KDEN',SEA:'KSEA',MIA:'KMIA',BOS:'KBOS',DFW:'KDFW',
  YYZ:'CYYZ',YVR:'CYVR',YUL:'CYUL',YYC:'CYYC',YEG:'CYEG',
  LHR:'EGLL',CDG:'LFPG',FRA:'EDDF',AMS:'EHAM',MAD:'LEMD',MAN:'EGCC',
  NRT:'RJAA',HND:'RJTT',ICN:'RKSI',HKG:'VHHH',SIN:'WSSS',
  DXB:'OMDB',SYD:'YSSY',MEL:'YMML',GRU:'SBGR',GIG:'SBGL',
  ORD:'KORD',MDW:'KMDW',LGA:'KLGA',IAD:'KIAD',DCA:'KDCA',
};
const ICAO_TO_IATA = Object.fromEntries(Object.entries(IATA_TO_ICAO).map(([k,v])=>[v,k]));

function toICAO(iata) {
  return IATA_TO_ICAO[iata.toUpperCase()] || ('K'+iata.toUpperCase());
}
function toIATA(icao='') {
  return ICAO_TO_IATA[icao] || icao.replace(/^[KC]/,'') || icao;
}

function inferDelayProb(f, airportIata) {
  const base = BASE_RATES[airportIata] || 0.25;
  const op = f.operator || '';
  const airlineRate = Object.entries(AIRLINE_RATES).find(([k])=>op.toLowerCase().includes(k.toLowerCase()))?.[1];
  const blended = airlineRate ? (base*0.5 + airlineRate*0.5) : base;
  const delay = f.departure_delay || 0;
  if (f.cancelled) return 0.97;
  if (delay > 60) return 0.92;
  if (delay > 30) return 0.80;
  if (delay > 15) return 0.68;
  if (delay > 0)  return 0.55;
  return Math.min(0.94, Math.max(0.06, blended + (Math.random()-0.5)*0.08));
}

function mapStatus(f) {
  if (f.cancelled) return 'Cancelled';
  const s = (f.status||'').toLowerCase();
  if (s.includes('arrived') || s.includes('landed')) return 'Departed';
  if (s.includes('en route') || s.includes('departed')) return 'Active';
  const delay = f.departure_delay || 0;
  if (delay > 0) return 'Delayed';
  const sched = f.scheduled_out || f.scheduled_off;
  if (sched) {
    const diff = (new Date(sched) - Date.now()) / 60000;
    if (diff <= 30 && diff > -5) return 'Boarding';
  }
  return 'On Time';
}

function mapFlight(f, airportIata) {
  const sched = f.scheduled_out || f.scheduled_off || '';
  const actual = f.actual_out || f.actual_off || null;
  const time = sched ? new Date(sched).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false}) : '--:--';
  const dest = toIATA(f.destination?.code_icao || f.destination?.code || '');
  const destName = (f.destination?.name||dest).replace(' International Airport','').replace(' International','').replace(' Airport','').trim();
  const delayMins = f.departure_delay || null;

  return {
    id: f.ident_iata || f.ident_icao || f.ident || '',
    dest,
    destName,
    time,
    gate: f.gate_origin || f.terminal_origin || 'TBD',
    status: mapStatus(f),
    airline: f.operator || '',
    aircraft: f.aircraft_type || '—',
    delayProb: inferDelayProb(f, airportIata),
    delayMinutes: delayMins,
    scheduledAt: sched,
    actualOut: actual,
    vol: Math.round(5000 + Math.random()*18000),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET');

  const iata = (req.query.airport||'SFO').toUpperCase();
  const flightId = req.query.flight;   // single flight lookup for position resolution
  const date = req.query.date;         // YYYY-MM-DD for historical lookup
  const apiKey = process.env.FLIGHTAWARE_KEY;

  if (!apiKey) return res.status(500).json({error:'FLIGHTAWARE_KEY not set'});

  const headers = {'x-apikey': apiKey};
  const BASE = 'https://aeroapi.flightaware.com/aeroapi';

  // ── Single flight lookup (resolve positions on login) ──────────────────
  if (flightId) {
    try {
      let url, data, flights;

      if (date) {
        // Historical — use /history/flights/{ident}?start=DATE&end=DATE+1
        const start = date + 'T00:00:00Z';
        const d = new Date(date); d.setDate(d.getDate()+1);
        const end = d.toISOString().slice(0,10) + 'T00:00:00Z';
        url = `${BASE}/history/flights/${encodeURIComponent(flightId)}?start=${start}&end=${end}&ident_type=designator`;
      } else {
        // Recent (within ~14 days)
        url = `${BASE}/flights/${encodeURIComponent(flightId)}?ident_type=designator&max_pages=1`;
      }

      const r = await fetch(url, {headers});
      if (!r.ok) return res.status(200).json({flight:null, error:`API ${r.status}`});
      data = await r.json();
      flights = data.flights || [];

      if (!flights.length) return res.status(200).json({flight:null});

      // Pick the flight that actually departed (has actual_off) — or most recent
      const f = flights.find(x=>x.actual_off||x.actual_out) || flights[0];
      const depIata = toIATA(f.origin?.code_icao||f.origin?.code||iata);

      return res.status(200).json({
        flight: mapFlight(f, depIata),
        fetchedAt: new Date().toISOString(),
      });
    } catch(err) {
      return res.status(200).json({flight:null, error:err.message});
    }
  }

  // ── Airport departures board ───────────────────────────────────────────
  try {
    const icao = toICAO(iata);
    // scheduled_departures: upcoming flights (default: now to +24hrs)
    const url = `${BASE}/airports/${icao}/flights/scheduled_departures?type=Airline&max_pages=2`;
    const r = await fetch(url, {headers});

    if (!r.ok) {
      const txt = await r.text();
      console.error('FlightAware error:', r.status, txt);
      return res.status(200).json({flights:[],iata,error:`API ${r.status}`,fallback:true,fetchedAt:new Date().toISOString()});
    }

    const data = await r.json();
    const raw = data.scheduled_departures || [];

    const now = Date.now();
    const flights = raw
      .map(f => mapFlight(f, iata))
      .filter(f => {
        if (!f.id) return false;
        if (f.status === 'Departed') return false;
        if (f.scheduledAt) {
          const dep = new Date(f.scheduledAt).getTime();
          const diffMins = (dep - now) / 60000;
          if (diffMins < -5) return false;   // departed more than 5 min ago
          if (diffMins > 720) return false;  // more than 12 hrs away
        }
        return true;
      })
      .sort((a,b) => (a.time||'').localeCompare(b.time||''));

    console.log(`[FlightBet] ${iata}(${icao}): ${raw.length} raw → ${flights.length} upcoming`);

    return res.status(200).json({
      flights, iata,
      fetchedAt: new Date().toISOString(),
      mock: false,
      count: flights.length,
    });

  } catch(err) {
    console.error('FlightAware error:', err);
    return res.status(200).json({flights:[],iata,error:err.message,fallback:true,fetchedAt:new Date().toISOString()});
  }
}