const BASE_RATES = {
  YYZ: 0.65, EWR: 0.45, JFK: 0.38, ORD: 0.35, SFO: 0.30,
  BOS: 0.28, MIA: 0.27, DFW: 0.25, DEN: 0.24, LAX: 0.21,
  ATL: 0.20, SEA: 0.18,
};

function inferDelayProb(flight, baseRate) {
  const delay = flight.departure?.delay?.minutes
    || flight.departure?.delay
    || 0;
  const status = (flight.status || '').toLowerCase();
  if (status === 'cancelled') return 0.97;
  if (delay > 60) return 0.92;
  if (delay > 30) return 0.80;
  if (delay > 15) return 0.68;
  if (delay > 0)  return 0.55;
  return Math.min(0.94, Math.max(0.06, baseRate + (Math.random() - 0.5) * 0.12));
}

function mapStatus(flight) {
  const s = (flight.status || '').toLowerCase();
  const delay = flight.departure?.delay?.minutes || flight.departure?.delay || 0;
  if (s === 'cancelled') return 'Cancelled';
  if (s === 'departed' || s === 'landed' || s === 'arrived') return 'Departed';
  if (s === 'en-route' || s === 'airborne' || s === 'active') return 'Active';
  if (delay > 0) return 'Delayed';
  // Boarding if within 30 mins of scheduled departure
  const sched = flight.departure?.scheduledTime?.local
    || flight.departure?.scheduledTime?.utc
    || flight.departure?.scheduled;
  if (sched) {
    const diff = (new Date(sched) - Date.now()) / 60000;
    if (diff <= 30 && diff > -5) return 'Boarding';
  }
  return 'On Time';
}

function mapFlight(f, baseRate) {
  // AeroDataBox field names
  const flightNumber = f.number || f.iataNumber || f.flight?.iata || '';
  const dest = f.arrival?.airport?.iata || f.arrival?.iata || '???';
  const destName = f.arrival?.airport?.name || f.arrival?.airport || dest;
  const sched = f.departure?.scheduledTime?.local
    || f.departure?.scheduledTime?.utc
    || f.departure?.scheduled
    || '';
  const time = sched ? sched.slice(11, 16) : '--:--';
  const gate = f.departure?.gate || f.departure?.terminal?.name || f.departure?.terminal || 'TBD';
  const aircraft = f.aircraft?.model || f.aircraft?.reg || f.aircraft?.iata || '—';
  const airline = f.airline?.name || f.airline || '';
  const delayMins = f.departure?.delay?.minutes || f.departure?.delay || null;

  return {
    id: flightNumber,
    dest,
    destName: (typeof destName === 'string' ? destName : dest)
      .replace(' International', '')
      .replace(' Airport', '')
      .trim(),
    time,
    gate,
    status: mapStatus(f),
    airline,
    aircraft,
    delayProb: inferDelayProb(f, baseRate),
    delayMinutes: delayMins,
    scheduledAt: sched,
    vol: Math.round(5000 + Math.random() * 18000),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const iata = (req.query.airport || 'SFO').toUpperCase();
  const apiKey = process.env.RAPIDAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY not set' });
  }

  const baseRate = BASE_RATES[iata] || 0.25;

  // Fetch next 12 hours of departures
  const now = new Date();
  const later = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 16); // "2026-04-09T17:00"

  const host = 'aerodatabox-cheaper-version.p.rapidapi.com';
  const url = `https://${host}/flights/airports/iata/${iata}/${fmt(now)}/${fmt(later)}?withLeg=true&direction=Departure&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false`;

  try {
    const r = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': host,
      },
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('AeroDataBox error:', r.status, text);
      return res.status(200).json({
        flights: [],
        iata,
        error: `API returned ${r.status}: ${text}`,
        fallback: true,
        fetchedAt: new Date().toISOString(),
      });
    }

    const data = await r.json();

    // AeroDataBox returns { departures: [...] }
    const raw = data.departures || data.arrivals || (Array.isArray(data) ? data : []);

    console.log(`[FlightBet] ${iata}: raw response keys: ${Object.keys(data)}, ${raw.length} flights`);

    const flights = raw
      .map(f => mapFlight(f, baseRate))
      .filter(f => {
        if (!f.id || f.dest === '???') return false;
        // Drop fully landed/departed — keep Active (in air, for resolution) and everything upcoming
        return f.status !== 'Departed';
      })
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    return res.status(200).json({
      flights,
      iata,
      fetchedAt: new Date().toISOString(),
      mock: false,
      count: flights.length,
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