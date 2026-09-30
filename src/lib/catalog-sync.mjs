import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_API_ROOT = 'https://apigw-proxy.capes.gov.br/observatorio';
const RELEVANT_SUBTYPES = [
  'ARTIGO EM PERIODICO',
  'ARTIGO EM PERIÓDICO',
  'TRABALHO EM ANAIS',
  'ARTIGO EM ANAIS',
];

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLookup(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(fetchImpl, url, { attempts = 3, sourceLabel = 'CAPES API' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'paper-ops/0.1 academic-catalog-sync',
        },
      });
      if (!response.ok) {
        const body = typeof response.text === 'function' ? await response.text() : '';
        throw new Error(`${sourceLabel} request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(200 * (2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

function facetUrl(apiRoot, key) {
  return `${apiRoot}/facetas/data/observatorio/producao/${encodeURIComponent(key)}`;
}

function productionUrl(apiRoot, { query, page, pageSize }) {
  const url = new URL(`${apiRoot}/data/observatorio/producao`);
  if (query) {
    url.searchParams.set('query', query);
  }
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(pageSize));
  return url.toString();
}

function facetKey(entry) {
  return normalizeText(entry?.key ?? entry?.value);
}

function findFacetKeys(entries, acceptedValues) {
  const accepted = acceptedValues.map(normalizeLookup);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => accepted.some((value) => normalizeLookup(entry?.value ?? entry?.key).includes(value)))
    .map(facetKey)
    .filter(Boolean);
}

function extractContent(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.content ?? payload?.items ?? payload?.records ?? [];
}

function extractTotalPages(payload) {
  const value = payload?.totalPages ?? payload?.page?.totalPages ?? payload?.pagination?.totalPages;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRelevantProduction(record) {
  const type = normalizeLookup(record?.nomeTipoProducao ?? record?.tipoProducao ?? record?.type);
  const subtype = normalizeLookup(record?.nomeSubTipoProducao ?? record?.subtipoProducao ?? record?.subtype);
  return type.includes('BIBLIOGRAFICA') && RELEVANT_SUBTYPES.map(normalizeLookup).some((value) => subtype.includes(value));
}

function normalizeProduction(record, retrievedAt) {
  const authors = Array.isArray(record?.autores)
    ? record.autores
      .slice()
      .sort((left, right) => (left?.ordem ?? 0) - (right?.ordem ?? 0))
      .map((author) => normalizeText(author?.nomePessoa ?? author?.nome ?? author))
      .filter(Boolean)
    : [];

  return {
    id: normalizeText(record?.id ?? record?.idProducao),
    title: normalizeText(record?.nomeProducao ?? record?.titulo ?? record?.title),
    year: Number.parseInt(record?.anoBase ?? record?.ano ?? record?.year, 10) || null,
    publication_date: normalizeText(record?.dataPublicacao),
    production_type: normalizeText(record?.nomeTipoProducao ?? record?.tipoProducao),
    production_subtype: normalizeText(record?.nomeSubTipoProducao ?? record?.subtipoProducao),
    authors,
    institution: normalizeText(record?.siglaIes ?? record?.nomeIes),
    program: normalizeText(record?.nomePrograma),
    retrieved_at: retrievedAt,
  };
}

function productionIdentity(record) {
  if (record.id) {
    return `id:${record.id}`;
  }
  return `${normalizeLookup(record.title)}::${record.year ?? ''}::${normalizeLookup(record.institution)}`;
}

function readJsonLines(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  renameSync(temporaryPath, path);
}

function mergeSnapshot(existing, incoming, year) {
  const merged = new Map();
  for (const record of existing) {
    if (record.year !== year) {
      merged.set(productionIdentity(record), record);
    }
  }
  for (const record of incoming) {
    merged.set(productionIdentity(record), record);
  }
  return [...merged.values()].sort((left, right) =>
    (right.year ?? 0) - (left.year ?? 0) || left.title.localeCompare(right.title));
}

export async function syncCapesCatalog({
  projectRoot,
  fetchImpl = fetch,
  apiRoot = DEFAULT_API_ROOT,
  year,
  pageSize = 100,
  maxPages = 25,
  now = new Date(),
} = {}) {
  const normalizedPageSize = clampInteger(pageSize, 100, 1, 500);
  const normalizedMaxPages = clampInteger(maxPages, 25, 1, 10000);
  const retrievedAt = now.toISOString();

  const yearFacets = await fetchJsonWithRetry(fetchImpl, facetUrl(apiRoot, 'ano-base'), { sourceLabel: 'CAPES year facets' });
  const availableYears = (Array.isArray(yearFacets) ? yearFacets : [])
    .map((entry) => Number.parseInt(entry?.key ?? entry?.value, 10))
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  const selectedYear = Number.parseInt(year, 10) || availableYears[0];
  if (!selectedYear || !availableYears.includes(selectedYear)) {
    throw new Error(`CAPES year is unavailable. Available years: ${availableYears.join(', ') || 'none'}`);
  }

  let typeFacets = [];
  let subtypeFacets = [];
  const facetWarnings = [];
  try {
    typeFacets = await fetchJsonWithRetry(fetchImpl, facetUrl(apiRoot, 'tipo-producao'), { sourceLabel: 'CAPES production type facets' });
  } catch (error) {
    facetWarnings.push(error instanceof Error ? error.message : String(error));
  }
  try {
    subtypeFacets = await fetchJsonWithRetry(fetchImpl, facetUrl(apiRoot, 'subtipo-producao'), { sourceLabel: 'CAPES production subtype facets' });
  } catch (error) {
    facetWarnings.push(error instanceof Error ? error.message : String(error));
  }

  const typeKeys = findFacetKeys(typeFacets, ['BIBLIOGRAFICA']);
  const subtypeKeys = findFacetKeys(subtypeFacets, RELEVANT_SUBTYPES);
  const queryParts = [`ano-base:(${selectedYear})`];
  if (typeKeys.length > 0) {
    queryParts.push(`tipo-producao:(${typeKeys.join('*')})`);
  }
  if (subtypeKeys.length > 0) {
    queryParts.push(`subtipo-producao:(${subtypeKeys.join('*')})`);
  }
  const query = queryParts.join(';');

  const productions = [];
  let pagesFetched = 0;
  let rawRecordsFetched = 0;
  let totalPages = null;
  let exhausted = false;

  for (let page = 0; page < normalizedMaxPages; page += 1) {
    const payload = await fetchJsonWithRetry(
      fetchImpl,
      productionUrl(apiRoot, { query, page, pageSize: normalizedPageSize }),
      { sourceLabel: `CAPES production page ${page}` },
    );
    const content = extractContent(payload);
    totalPages = extractTotalPages(payload) ?? totalPages;
    pagesFetched += 1;
    rawRecordsFetched += content.length;
    productions.push(...content.filter(isRelevantProduction).map((record) => normalizeProduction(record, retrievedAt)));

    if (content.length === 0 || content.length < normalizedPageSize || (totalPages !== null && page + 1 >= totalPages)) {
      exhausted = true;
      break;
    }
  }

  const catalogDir = join(projectRoot, 'data', 'catalogs', 'capes');
  const snapshotPath = join(catalogDir, 'productions.jsonl');
  const manifestPath = join(catalogDir, 'manifest.json');
  const existing = readJsonLines(snapshotPath);
  const snapshot = mergeSnapshot(existing, productions, selectedYear);
  const truncated = !exhausted && (totalPages === null || pagesFetched < totalPages);
  const manifest = {
    source: 'CAPES Plataforma Sucupira public API',
    api_root: apiRoot,
    synced_at: retrievedAt,
    year: selectedYear,
    available_years: availableYears,
    query,
    page_size: normalizedPageSize,
    max_pages: normalizedMaxPages,
    pages_fetched: pagesFetched,
    total_pages_reported: totalPages,
    raw_records_fetched: rawRecordsFetched,
    relevant_records: productions.length,
    snapshot_records: snapshot.length,
    truncated,
    facet_warnings: facetWarnings,
    semantics: {
      purpose: 'production registry enrichment',
      capes_validated: false,
      note: 'A production match does not imply a CAPES/Qualis venue classification.',
    },
  };

  writeAtomic(snapshotPath, `${snapshot.map((record) => JSON.stringify(record)).join('\n')}${snapshot.length ? '\n' : ''}`);
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    ...manifest,
    artifacts: { snapshotPath, manifestPath },
  };
}
