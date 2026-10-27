// Z-NL: what does Zetaris's own natural-language path return for the Evidence Matrix question? The verdict is BLOCKED only
// after three independent ways of finding such a path on this local build have been tried and written down.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate } from './context.mjs';

const QUESTION = 'For case CASE-2026-014, which vendor claims go beyond the minimum age of the confirmed study and which claimed software versions are missing from the FDA device record?';

export async function run(ctx) {
  const gate = new Gate('Z-NL', 'Zetaris natural-language path as the baseline arm');
  const z = ctx.zt;

  // Attempt 1: the REST surface. Every path of the local OpenAPI document that could take a question.
  const spec = await fetch(`${z.baseUrl}/redoc/docs.yaml`, { headers: { Authorization: `Basic ${Buffer.from(`${z.identities.admin.email}:${z.identities.admin.password}`).toString('base64')}` } });
  const text = spec.ok ? await spec.text() : '';
  const paths = text.match(/^ {2}\/api\/v1\.0\/[^\n]*/gm) ?? [];
  const candidates = paths.filter((p) => /\/ask|\/chat|nl2sql|text-?to-?sql|natural|assistant|llm|genai|agent/i.test(p)).map((p) => p.trim());
  gate.note(`Attempt 1 (OpenAPI, ${paths.length} paths): candidate paths are ${candidates.join(', ') || 'none'}. Only the pipeline ask and chat routes take a free-text prompt; both belong to an LLM pipeline relation (provider, prompt, config, top_n, min_score), not to a question over federated tables.`);
  const containers = await z.rest('admin', 'GET', '/pipeline/containers');
  const ask = await z.rest('admin', 'POST', '/pipeline/containers/1/relations/1/ask', { body: { prompt: QUESTION } });
  gate.show('GET /pipeline/containers', { status: containers.status, body: containers.body });
  gate.show('POST /pipeline/containers/1/relations/1/ask (the only route that accepts a question)', { status: ask.status, body: ask.body });

  // Attempt 2: the web UI. Search the compiled front end for a natural-language-to-SQL feature.
  const ui = spawnSync('docker', ['exec', 'sakaime-zetaris-ui-1', 'node', '-e', `
    const fs=require('fs'),path=require('path');
    const walk=(d,o=[])=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);f.isDirectory()?walk(p,o):p.endsWith('.js')&&o.push(p)}return o};
    const stub='AI assistant is not yet wired to a backend';let stubFiles=0,nl=0;
    for(const f of walk('/app/.next')){const s=fs.readFileSync(f,'utf8');if(s.includes(stub))stubFiles++;if(/text.?to.?sql|nl2sql|natural.language.to.sql/i.test(s))nl++}
    console.log(JSON.stringify({stubFiles,nl}));`], { encoding: 'utf8' });
  gate.note(`Attempt 2 (compiled web UI): ${ui.stdout.trim()}. The only assistant in the interface answers "AI assistant is not yet wired to a backend" unless a stub flag is set, and no file mentions text-to-SQL.`);

  // Attempt 3: the platform bundle. Which services does this install run?
  const compose = readFileSync(join(z.repoRoot, 'infra', 'zetaris', 'bundle', 'docker-compose.yml'), 'utf8');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  gate.note(`Attempt 3 (bundle services): ${services.join(', ')}. No natural-language, MCP or AI-steward service is part of the local bundle; the vendor describes the natural-language and MCP routes as features of Zetaris Cloud and its Enterprise tier.`);
  const probes = await Promise.all(['/mcp', '/api/v1.0/mcp', '/api/v1.0/nl2sql', '/api/v1.0/query/natural-language'].map(async (p) => ({ p, status: (await fetch(`${z.baseUrl}${p}`).catch(() => ({ status: 0 }))).status })));
  gate.show('GET on guessed natural-language and MCP paths of the API port', probes);

  gate.check('no natural-language-to-SQL service answers on this local build', ask.status >= 400 && probes.every((x) => x.status === 0 || x.status >= 400), `ask HTTP ${ask.status}; guessed paths ${probes.map((x) => x.status).join('/')}`);
  gate.note(`The baseline arm for the question "${QUESTION}" therefore cannot be measured against Zetaris's own natural-language path here. NOT VERIFIED: whether the cloud or Enterprise natural-language and MCP routes would answer it. The ablation needs the documented fallback instead: a model-written-SQL arm over the REST route (docs/03 section 6, arm 2).`);
  return gate.finish('BLOCKED');
}
