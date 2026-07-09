import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Standalone weather MCP server for local testing of the Connectors feature
 * (Settings → Connectors, or the composer's "+" → Connectors). Talks to
 * Open-Meteo (free, no API key) for geocoding + current conditions.
 *
 * Run: npm run mcp:weather   (defaults to :5055, override with PORT)
 * Add in the app: Settings → Connectors → name "weather", url
 * http://localhost:5055/mcp, no auth token.
 */

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

interface GeoResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
}

async function geocode(location: string): Promise<GeoResult> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', location);
  url.searchParams.set('count', '1');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoding failed: ${res.status}`);
  const data = (await res.json()) as { results?: GeoResult[] };
  const hit = data.results?.[0];
  if (!hit) throw new Error(`no location found for "${location}"`);
  return hit;
}

async function currentWeather(lat: number, lon: number) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
  );
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`forecast failed: ${res.status}`);
  const data = (await res.json()) as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
      time: string;
    };
  };
  return data.current;
}

/**
 * A fresh McpServer per request: `connect()` takes ownership of a transport,
 * so one long-lived server instance can't safely serve two concurrent
 * stateless requests (their transports would clobber each other's callbacks).
 */
function createServer(): McpServer {
  const server = new McpServer({ name: 'weather', version: '1.0.0' });

  server.registerTool(
    'get_weather',
    {
      title: 'Get current weather',
      description:
        'Look up the current weather (temperature, conditions, humidity, wind) for a city or place name.',
      inputSchema: {
        location: z.string().min(1).describe('City name, optionally with country, e.g. "London" or "Austin, TX"'),
      },
    },
    async ({ location }) => {
      try {
        const place = await geocode(location);
        const c = await currentWeather(place.latitude, place.longitude);
        const label = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
        const conditions = WMO_CODES[c.weather_code] ?? `code ${c.weather_code}`;
        const text =
          `Weather for ${label} (as of ${c.time}):\n` +
          `${conditions}, ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C)\n` +
          `Humidity: ${c.relative_humidity_2m}% · Wind: ${c.wind_speed_10m} km/h`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'weather lookup failed';
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless per the client's own connect→call→close lifecycle (backend/src/mcp/client.ts) - no session to keep.
app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 5055);
app.listen(port, () => {
  console.log(`[mcp-weather] listening on http://localhost:${port}/mcp`);
});
