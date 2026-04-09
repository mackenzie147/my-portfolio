function inferDelayProb(flight) {
  const status = (flight.flight_status || '').toLowerCase();
  const delay = flight.departure?.delay || 0;
  if (status === 'cancelled') return 0.97;
  if (status === 'diverted') return 0.85;
  if (delay > 60) return 0.92;
  if (delay > 30) return 0.80;
  if (delay > 15) return 0.68;
  if (delay > 0)  return 0.55;
  const base = 0.22;
  return Math.min(0.94, Math.max(0.06, base + (Math.random() - 0.5) * 0.18));
}

function mapStatus(flight) {
  const s = (flight.flight_status || '').toLowerCase();
  const delay = flight.departure?.delay || 0;
  if (s === 'cancelled') return 'Cancelled';
  if (s === 'landed') return 'Departed';
  if (s === 'active') return 'Departed';
  if (delay > 0) return 'Delayed';
  if (s === 'scheduled') {
    const sched = flight.departure?.scheduled;
    if (sched) {
      const diff = (new Date(sched) - Date.now()) / 60000;
      if (diff < 20 && diff > 0) return 'Boarding';
    }
  }
  return 'On Time';
}

function mapFlight(f) {
  const iata = f.flight?.iata || '';
  const dest = f.arrival?.iata || '???';
  const destName = f.arrival?.airport || dest;
  const rawTime = f.departure?.scheduled || '';
  const time = rawTime ? rawTime.slice(11, 16) : '--:--';
  const gate = f.departure?.gate || f.departure?.terminal || 'TBD';
  const aircraft = f.aircraft?.iata || f.aircraft?.icao || '—';

  return {
    id: iata,
    dest,
    destName: destName.replace(' International', '').replace(' Airport', '').trim(),
    time,
    gate,
    status: mapStatus(f),
    airline: f.airline?.name || '',
    aircraft,
    delayProb: inferDelayProb(f),
    vol: Math.round(5000 + Math.random() * 18000),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const iata = (req.query.airport || 'SFO').toUpperCase();
  const apiKey = process.env.FLIGHT_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'FLIGHT_API_KEY not set', mock: true });
  }

  // AviationStack: live departures for this airport
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${iata}&flight_status=active&limit=50`;

  try {
    const r = await fetch(url);

    if (!r.ok) {
      const text = await r.text();
      console.error('AviationStack error:', r.status, text);
      return res.status(200).json({
        flights: [],
        iata,
        error: `API returned ${r.status}`,
        fallback: true,
        fetchedAt: new Date().toISOString(),
      });
    }

    const data = await r.json();

    if (data.error) {
      console.error('AviationStack error:', data.error);
      return res.status(200).json({
        flights: [],
        iata,
        error: data.error.message || 'API error',
        fallback: true,
        fetchedAt: new Date().toISOString(),
      });
    }

    const raw = data.data || [];
    const flights = raw
      .map(mapFlight)
      .filter(f => f.id && f.dest !== '???');

    // If live returns nothing, also fetch scheduled
    if (flights.length === 0) {
      const url2 = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${iata}&flight_status=scheduled&limit=50`;
      const r2 = await fetch(url2);
      const data2 = await r2.json();
      const raw2 = data2.data || [];
      const flights2 = raw2.map(mapFlight).filter(f => f.id && f.dest !== '???');
      return res.status(200).json({
        flights: flights2,
        iata,
        fetchedAt: new Date().toISOString(),
        mock: false,
      });
    }

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