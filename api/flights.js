function inferDelayProb(flight, baseRate = 0.22) {
  const status = (flight.flight_status || '').toLowerCase();
  const delay = flight.departure?.delay || 0;
  if (status === 'cancelled') return 0.97;
  if (status === 'diverted') return 0.85;
  if (delay > 60) return 0.92;
  if (delay > 30) return 0.80;
  if (delay > 15) return 0.68;
  if (delay > 0)  return 0.55;
  return Math.min(0.94, Math.max(0.06, baseRate + (Math.random() - 0.5) * 0.12));
}

// Airport base delay rates (used to calibrate delayProb on scheduled flights)
const BASE_RATES = {
  YYZ: 0.65, EWR: 0.45, JFK: 0.38, ORD: 0.35, SFO: 0.30,
  BOS: 0.28, MIA: 0.27, DFW: 0.25, DEN: 0.24, LAX: 0.21,
  ATL: 0.20, SEA: 0.18,
};

function mapStatus(flight) {
  const s = (flight.flight_status || '').toLowerCase();
  const delay = flight.departure?.delay || 0;
  if (s === 'cancelled') return 'Cancelled';
  // landed/active = already in air or landed = skip these (filtered below)
  if (s === 'landed') return 'Landed';
  if (s === 'active') return 'Active';
  if (delay > 0) return 'Delayed';
  if (s === 'scheduled') {
    const sched = flight.departure?.scheduled;
    if (sched) {
      const diff = (new Date(sched) - Date.now()) / 60000;
      if (diff <= 30 && diff > -5) return 'Boarding';
    }
    return 'On Time';
  }
  return 'On Time';
}

function mapFlight(f, depIata) {
  const iata = f.flight?.iata || '';
  const dest = f.arrival?.iata || '???';
  const destName = f.arrival?.airport || dest;
  const rawTime = f.departure?.scheduled || '';
  const time = rawTime ? rawTime.slice(11, 16) : '--:--';
  const gate = f.departure?.gate || f.departure?.terminal || 'TBD';
  const aircraft = f.aircraft?.iata || f.aircraft?.icao || '—';
  const baseRate = BASE_RATES[depIata] || 0.22;

  return {
    id: iata,
    dest,
    destName: destName.replace(' International', '').replace(' Airport', '').trim(),
    time,
    gate,
    status: mapStatus(f),
    airline: f.airline?.name || '',
    aircraft,
    delayProb: inferDelayProb(f, baseRate),
    delayMinutes: f.departure?.delay || null,
    scheduledAt: rawTime,
    vol: Math.round(5000 + Math.random() * 18000),
  };
}

async function fetchStatus(apiKey, iata, status, limit = 100) {
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${iata}&flight_status=${status}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`AviationStack ${status} returned ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'API error');
  return data.data || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const iata = (req.query.airport || 'SFO').toUpperCase();
  const apiKey = process.env.FLIGHT_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'FLIGHT_API_KEY not set' });
  }

  try {
    // Fetch scheduled (upcoming) AND active (in air but not yet "departed" for our purposes)
    // in parallel to save time
    const [scheduledRaw, activeRaw] = await Promise.allSettled([
      fetchStatus(apiKey, iata, 'scheduled', 100),
      fetchStatus(apiKey, iata, 'active', 50),
    ]);

    const scheduled = scheduledRaw.status === 'fulfilled' ? scheduledRaw.value : [];
    const active    = activeRaw.status    === 'fulfilled' ? activeRaw.value    : [];

    // Combine, deduplicate by flight iata id
    const seen = new Set();
    const combined = [...scheduled, ...active].filter(f => {
      const id = f.flight?.iata;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const flights = combined
      .map(f => mapFlight(f, iata))
      .filter(f => {
        if (!f.id || f.dest === '???') return false;
        // Drop landed/active-in-air that are truly gone
        if (f.status === 'Landed') return false;
        // Keep Active (in air) so bets can resolve, Boarding, On Time, Delayed, Cancelled
        return true;
      })
      // Sort by scheduled departure time
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    console.log(`[FlightBet] ${iata}: ${scheduled.length} scheduled, ${active.length} active → ${flights.length} shown`);

    return res.status(200).json({
      flights,
      iata,
      fetchedAt: new Date().toISOString(),
      mock: false,
      counts: { scheduled: scheduled.length, active: active.length, shown: flights.length },
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