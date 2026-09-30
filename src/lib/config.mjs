import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadAcademicCatalogs } from './academic-quality.mjs';
import { readProjectEnv } from './env.mjs';

const DEFAULT_SOURCES = ['scopus', 'ieee', 'acm', 'google_scholar', 'scielo', 'web_of_science'];
const API_KEY_ENV = {
  scopus: 'SCOPUS_API_KEY',
  ieee: 'IEEE_API_KEY',
  web_of_science: 'WEB_OF_SCIENCE_API_KEY',
};

function parseApiKeysText(rawText) {
  return {
    scopus: rawText.match(/Scopus(?:-API-Key|_API_KEY| API Key)\s*:\s*([A-Za-z0-9-]+)/i)?.[1] ?? '',
    ieee: rawText.match(/IEEE(?:\s+Xplore)?[\s\S]*?Key\s*:\s*([A-Za-z0-9-]+)/i)?.[1] ?? '',
    web_of_science: rawText.match(/(?:Web\s+of\s+Science|WOS)(?:-API-Key|_API_KEY| API Key)?\s*:\s*([A-Za-z0-9-]+)/i)?.[1] ?? '',
  };
}

export function readLocalApiKeys(projectRoot, env = process.env) {
  const keysPath = join(projectRoot, 'config', 'keys.txt');
  const fileKeys = existsSync(keysPath) ? parseApiKeysText(readFileSync(keysPath, 'utf8')) : {};
  const resolved = {};

  for (const sourceName of Object.keys(API_KEY_ENV)) {
    const envName = API_KEY_ENV[sourceName];
    resolved[sourceName] = env?.[envName] || (sourceName === 'web_of_science' ? env?.WOS_API_KEY : '') || fileKeys[sourceName] || '';
  }

  return resolved;
}

export function loadSourcesConfig(rawConfig = {}, options = {}) {
  const defaults = {
    per_source_limit: 10,
    fixture_mode: false,
    pdf_parser: 'auto',
    ...(rawConfig.defaults ?? {}),
  };

  const sources = {};
  const apiKeys = options.apiKeys ?? {};
  const quality = {
    enabled: false,
    mode: 'prioritize',
    allowed_publication_types: ['journal_article', 'review', 'conference_paper'],
    allow_unknown_types: false,
    minimum_score: 40,
    catalogs: {},
    capes_production_cache: 'data/catalogs/capes/productions.jsonl',
    ...(rawConfig.quality ?? {}),
    ...(options.qualityCatalogs ?? {}),
  };

  for (const sourceName of DEFAULT_SOURCES) {
    const sourceConfig = rawConfig.sources?.[sourceName] ?? {};
    sources[sourceName] = {
      enabled: false,
      mode: defaults.fixture_mode ? 'fixture' : 'live',
      experimental: false,
      ...sourceConfig,
      api_key: sourceConfig.api_key ?? apiKeys[sourceName] ?? '',
    };
  }

  return { defaults, sources, quality };
}

export function readSourcesConfig(projectRoot, env = process.env) {
  const configPath = join(projectRoot, 'config', 'sources.yml');
  const rawText = readFileSync(configPath, 'utf8');
  const resolvedEnv = readProjectEnv(projectRoot, env);
  const config = loadSourcesConfig(JSON.parse(rawText), {
    apiKeys: readLocalApiKeys(projectRoot, resolvedEnv),
  });
  const qualityCatalogs = loadAcademicCatalogs(projectRoot, config.quality);
  config.quality = { ...config.quality, ...qualityCatalogs };
  return config;
}
