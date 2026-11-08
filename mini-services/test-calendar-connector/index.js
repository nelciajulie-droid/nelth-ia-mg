// Test connector: a minimal OpenAPI tool server simulating a Calendar
// connector (the shape a real Gmail/Calendar/MCP-to-OpenAPI gateway exposes).
// Port 3010, no auth. Used to verify the v12-flow connectors phase end-to-end.
import http from 'node:http';

const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Calendar (test)',
    version: '1.0.0',
    description: 'Test calendar connector',
  },
  paths: {
    '/events': {
      get: {
        operationId: 'list_events',
        summary: "List today's calendar events",
        description: "Returns the user's calendar events for a given date.",
        parameters: [
          {
            name: 'date',
            in: 'query',
            required: false,
            schema: { type: 'string', description: 'ISO date, e.g. 2027-01-05' },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/events/{id}': {
      get: {
        operationId: 'get_event',
        summary: 'Get one event by id',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const EVENTS = [
  { id: 'evt-1', title: 'Réunion produit', start: '2027-01-05T10:00', location: 'Salle A', attendees: ['ana', 'karim'] },
  { id: 'evt-2', title: 'Déjeuner équipe', start: '2027-01-05T12:30', location: 'Le Bistrot' },
  { id: 'evt-3', title: 'Point client Nelth', start: '2027-01-05T16:00', location: 'Visio' },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SPEC));
    return;
  }
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ date: url.searchParams.get('date') ?? 'today', events: EVENTS }));
    return;
  }
  const m = url.pathname.match(/^\/events\/(.+)$/);
  if (m && req.method === 'GET') {
    const evt = EVENTS.find((e) => e.id === m[1]);
    res.writeHead(evt ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(evt ?? { error: 'not found' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'no route' }));
});

server.listen(3010, () => console.log('test-calendar-connector listening on 3010'));
