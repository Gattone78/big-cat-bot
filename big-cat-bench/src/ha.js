// Home Assistant REST client + the tool surface we expose to Gemini.
// Phase 1 deliberately exposes ONE tool. Add more here in Phase 4.
import 'dotenv/config';
import { Type } from '@google/genai';

const HA_URL = (process.env.HA_URL ?? '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN;

if (!HA_URL || !HA_TOKEN) {
  throw new Error('HA_URL and HA_TOKEN must be set in .env');
}

async function ha(path, method = 'GET', body) {
  const res = await fetch(`${HA_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`HA ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** All light.* entities with friendly names and current state. */
export async function listLights() {
  const states = await ha('/api/states');
  return states
    .filter((s) => s.entity_id.startsWith('light.'))
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name ?? s.entity_id,
      state: s.state,
    }));
}

/** Toggle a light and return its new state. */
export async function toggleLight(entity_id) {
  if (!entity_id?.startsWith('light.')) {
    return { error: `Refusing to toggle non-light entity: ${entity_id}` };
  }
  await ha('/api/services/light/toggle', 'POST', { entity_id });
  // HA applies the service async; a short wait makes the read-back accurate.
  await new Promise((r) => setTimeout(r, 300));
  const after = await ha(`/api/states/${entity_id}`);
  return { entity_id, state: after.state };
}

// ---- Gemini tool surface ---------------------------------------------------

export const toolDeclarations = [
  {
    name: 'toggle_light',
    description:
      'Toggle a Home Assistant light on or off. Use the exact entity_id from the ' +
      'list of known lights in the system instruction. Returns the new state.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        entity_id: {
          type: Type.STRING,
          description: 'Home Assistant light entity id, e.g. light.kitchen',
        },
      },
      required: ['entity_id'],
    },
  },
];

export const toolHandlers = {
  toggle_light: ({ entity_id }) => toggleLight(entity_id),
};

// `npm run lights` — quick sanity check that the token works and prints entity ids.
if (process.argv[1] && process.argv[1].endsWith('ha.js')) {
  const lights = await listLights();
  console.table(lights);
}
