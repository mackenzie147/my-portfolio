const AIRLINE_NAMES = {
  UA: 'United', DL: 'Delta', AA: 'American', AS: 'Alaska',
  WN: 'Southwest', B6: 'JetBlue', F9: 'Frontier', AC: 'Air Canada',
  WS: 'WestJet', NK: 'Spirit', G4: 'Allegiant', HA: 'Hawaiian',
};

function inferDelayProb(flight) {
  // Build a delay probability from available status signals
  const status = (flight.departure?.actualTimeStatus || '').toLowerCase();
  const delay = flight.departure?.delay || 0; // minutes
  if (status === 'canceled') return 0.97;
  if (delay > 60) return 0.92;
  if (delay > 30) return 0.80;
  if (delay > 15) return 0.68;
  if (delay > 0)  return 0.55;
  if (status === 'diverted') return 0.85;
  // No delay info yet — use historical base rate + some noise
  const base = 0.22;
  return Math.min(0.94, Math.max(0.06, base + (Math.random() - 0.5) * 0.18));
}

function mapStatus(flight) {
  const s = (flight.departure?.actualTimeStatus || '').toLowerCase();
  const delay = flight.departure?.delay || 0;
  if (s === 'canceled') return 'Cancelled';
  if (s === 'departed' || s === 'left gate') return 'Departed';
  if (delay > 0) return 'Delayed';
  const sched = flight.departure?.scheduledTimeLocal;
  if (sched) {
    const diff = (new Date(sched) - Date.now()) / 60000;
    if (diff < 20 && diff > 0) return 'Boarding';
  }
  return 'On Time';
}

function mapFlight(f) {
  const iata = f.number || f.iataNumber || '';
  const airlineCode = iata.slice(0, 2);
  const dest = f.arrival?.airport?.iata || '???';
  const destName = f.arrival?.airport?.name || dest;
  const rawTime = f.departure?.scheduledTimeLocal || '';
  const time = rawTime ? rawTime.slice(11, 16) : '--:--';
  const gate = f.departure?.gate || f.departure?.terminal || 'TBD';
  const aircraft = f.aircraft?.model || f.aircraft?.reg || '—';

  return {
    id: iata,
    dest,
    destName: destName.replace(' International', '').replace(' Airport', '').trim(),
    time,
    gate,
    status: mapStatus(f),
    airline: AIRLINE_NAMES[airlineCode] || f.airline?.name || airlineCode,
    aircraft,
    delayProb: inferDelayProb(f),
    vol: Math.round(5000 + Math.random() * 18000), // simulated market volume
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const iata = (req.query.airport || 'SFO').toUpperCase();
  const apiKey = process.env.FLIGHT_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'FLIGHT_API_KEY not set', mock: true });
  }

  // AeroDataBox: departures for next 12 hours
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fromTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  const later = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const toTime = `${later.getFullYear()}-${pad(later.getMonth()+1)}-${pad(later.getDate())}T${pad(later.getHours())}:00`;

  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${iata}/${fromTime}/${toTime}?withLeg=false&direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false`;

  try {
    const r = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
      },
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('AeroDataBox error:', r.status, text);
      return res.status(200).json({
        flights: [],
        iata,
        error: `API returned ${r.status}`,
        fallback: true,
        fetchedAt: new Date().toISOString(),
      });
    }

    const data = await r.json();
    const raw = data.departures || data.flights || [];
    const flights = raw.map(mapFlight).filter(f => f.id && f.dest !== '???');

    return res.status(200).json({
      flights,
      iata,
      fetchedAt: new Date().toISOString(),
      mock: false,
    });

  } catch (err) {
    console.error('Flight fetch error:', err);
    return res.status(200).json({
      flights: [],
      iata,
      error: err.message,
      fallback: true,
      fetchedAt: new Date().toISOString(),
    });
  }
}