import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_ALLOWED_TYPES = ['journal_article', 'review', 'conference_paper'];
const ACADEMIC_SOURCES = new Set(['scopus', 'ieee', 'acm', 'scielo', 'web_of_science']);

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLookup(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeIssn(value) {
  const compact = normalizeText(value).toUpperCase().replace(/[^0-9X]/g, '');
  return compact.length === 8 ? compact : '';
}

function parseBoolean(value) {
  const normalized = normalizeLookup(value);
  if (['true', 'yes', 'sim', '1', 'active', 'ativo'].includes(normalized)) {
    return true;
  }
  if (['false', 'no', 'nao', '0', 'inactive', 'inativo'].includes(normalized)) {
    return false;
  }
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') {
        index += 1;
      }
      row.push(field);
      if (row.some((value) => normalizeText(value))) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }

    field += character;
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function findColumn(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeLookup);
  return headers.findIndex((header) => normalizedCandidates.includes(normalizeLookup(header)));
}

function inferCatalogVehicleType(catalogName, rawType) {
  const normalized = normalizeLookup(rawType);
  if (normalized.includes('conference') || normalized.includes('conferencia') || normalized.includes('evento')) {
    return 'conference';
  }
  if (normalized.includes('journal') || normalized.includes('periodico') || normalized.includes('revista')) {
    return 'journal';
  }
  return normalizeLookup(catalogName).includes('conference') || normalizeLookup(catalogName).includes('core')
    ? 'conference'
    : 'journal';
}

function readCatalog(path, catalogName) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0];
  const titleIndex = findColumn(headers, ['title', 'journal title', 'titulo', 'titulo do periodico', 'name', 'nome']);
  const acronymIndex = findColumn(headers, ['acronym', 'acronimo', 'sigla']);
  const issnIndex = findColumn(headers, ['issn', 'print issn', 'p issn', 'journal issn print version']);
  const eissnIndex = findColumn(headers, ['eissn', 'e issn', 'electronic issn', 'online issn', 'journal eissn online version']);
  const typeIndex = findColumn(headers, ['type', 'tipo', 'vehicle type', 'tipo de veiculo']);
  const areaIndex = findColumn(headers, ['areas', 'area', 'area de avaliacao', 'primary for']);
  const activeIndex = findColumn(headers, [
    'is active?', 'is active', 'active', 'ativo',
    'does the journal comply to doaj s definition of open access?',
  ]);
  const peerReviewIndex = findColumn(headers, ['review process', 'peer review', 'revisao por pares']);
  const qualisIndex = findColumn(headers, ['qualis', 'estrato', 'classification']);
  const rankIndex = findColumn(headers, ['rank', 'core rank', 'quartile', 'quartil']);

  if (titleIndex < 0) {
    return [];
  }

  return rows.slice(1).map((row) => {
    const title = normalizeText(row[titleIndex]);
    const issn = issnIndex >= 0 ? normalizeIssn(row[issnIndex]) : '';
    const eissn = eissnIndex >= 0 ? normalizeIssn(row[eissnIndex]) : '';
    return {
      catalog: catalogName,
      title,
      normalized_title: normalizeLookup(title),
      acronym: acronymIndex >= 0 ? normalizeText(row[acronymIndex]) : '',
      normalized_acronym: acronymIndex >= 0 ? normalizeLookup(row[acronymIndex]) : '',
      issns: [issn, eissn].filter(Boolean),
      vehicle_type: inferCatalogVehicleType(catalogName, typeIndex >= 0 ? row[typeIndex] : ''),
      area: areaIndex >= 0 ? normalizeText(row[areaIndex]) : '',
      active: activeIndex >= 0 ? parseBoolean(row[activeIndex]) : null,
      peer_reviewed: peerReviewIndex >= 0 ? Boolean(normalizeText(row[peerReviewIndex])) : null,
      qualis: qualisIndex >= 0 ? normalizeText(row[qualisIndex]).toUpperCase() : '',
      rank: rankIndex >= 0 ? normalizeText(row[rankIndex]).toUpperCase() : '',
    };
  }).filter((entry) => entry.title && !entry.title.startsWith('title-'));
}

export function loadAcademicCatalogs(projectRoot, qualityConfig = {}) {
  const configured = qualityConfig.catalogs ?? {};
  const entries = [];
  const status = {};

  for (const [catalogName, configuredPath] of Object.entries(configured)) {
    const pathText = normalizeText(configuredPath);
    if (!pathText) {
      continue;
    }

    const catalogPath = isAbsolute(pathText) ? pathText : resolve(projectRoot, pathText);
    if (!existsSync(catalogPath)) {
      status[catalogName] = { path: catalogPath, loaded: false, records: 0, reason: 'file not found' };
      continue;
    }

    try {
      const catalogEntries = readCatalog(catalogPath, catalogName);
      entries.push(...catalogEntries);
      status[catalogName] = { path: catalogPath, loaded: true, records: catalogEntries.length, reason: '' };
    } catch (error) {
      status[catalogName] = {
        path: catalogPath,
        loaded: false,
        records: 0,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const capesProductions = [];
  const productionCachePathText = normalizeText(qualityConfig.capes_production_cache);
  if (productionCachePathText) {
    const productionCachePath = isAbsolute(productionCachePathText)
      ? productionCachePathText
      : resolve(projectRoot, productionCachePathText);
    if (!existsSync(productionCachePath)) {
      status.capes_productions = {
        path: productionCachePath,
        loaded: false,
        records: 0,
        reason: 'run paper-ops catalog sync capes',
      };
    } else {
      for (const line of readFileSync(productionCachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const record = JSON.parse(line);
          if (normalizeText(record?.title)) {
            capesProductions.push(record);
          }
        } catch {
          // Ignore malformed cache rows while retaining all valid records.
        }
      }
      status.capes_productions = {
        path: productionCachePath,
        loaded: true,
        records: capesProductions.length,
        reason: '',
      };
    }
  }

  return { catalog_entries: entries, catalog_status: status, capes_productions: capesProductions };
}

function normalizePublicationType(value) {
  const normalized = normalizeLookup(value).replace(/ /g, '_');
  const mappings = new Map([
    ['article', 'journal_article'],
    ['journal', 'journal_article'],
    ['journal_article', 'journal_article'],
    ['research_article', 'journal_article'],
    ['review', 'review'],
    ['review_article', 'review'],
    ['conference', 'conference_paper'],
    ['conference_paper', 'conference_paper'],
    ['conference_proceeding', 'conference_paper'],
    ['proceedings_article', 'conference_paper'],
    ['book_chapter', 'book_chapter'],
    ['book', 'book'],
    ['preprint', 'preprint'],
    ['editorial', 'editorial'],
    ['thesis', 'thesis'],
    ['dissertation', 'thesis'],
    ['dataset', 'dataset'],
  ]);
  return mappings.get(normalized) ?? '';
}

export function inferPublicationType(record) {
  const explicit = normalizePublicationType(record.publication_type ?? record.document_type ?? record.content_type);
  if (explicit) {
    return explicit;
  }

  const title = normalizeLookup(record.title);
  const venue = normalizeLookup(record.venue);
  const combined = `${title} ${venue}`;

  if (/\b(systematic review|literature review|scoping review|survey)\b/.test(title)) {
    return 'review';
  }
  if (/\b(proceedings|conference|symposium|workshop|congresso|simposio|encontro)\b/.test(venue)) {
    return 'conference_paper';
  }
  if (/\b(preprint|arxiv|biorxiv|medrxiv|ssrn)\b/.test(combined)) {
    return 'preprint';
  }
  if (/\b(thesis|dissertation|tese|dissertacao)\b/.test(combined)) {
    return 'thesis';
  }
  if (record.source === 'scielo' || /\b(journal|revista|transactions|letters|archives|annals|review|access)\b/.test(venue)) {
    return 'journal_article';
  }
  return 'unknown';
}

function collectRecordIssns(record) {
  const values = [record.issn, record.eissn, ...(Array.isArray(record.issns) ? record.issns : [])];
  return [...new Set(values.map(normalizeIssn).filter(Boolean))];
}

function addToIndex(index, key, entry) {
  if (!key) {
    return;
  }
  const existing = index.get(key) ?? [];
  existing.push(entry);
  index.set(key, existing);
}

function buildCatalogIndex(catalogEntries) {
  const byTitle = new Map();
  const byIssn = new Map();
  for (const entry of catalogEntries) {
    addToIndex(byTitle, entry.normalized_title, entry);
    addToIndex(byTitle, entry.normalized_acronym, entry);
    for (const issn of entry.issns) {
      addToIndex(byIssn, issn, entry);
    }
  }
  return { byTitle, byIssn };
}

function catalogMatches(record, catalogIndex) {
  const venue = normalizeLookup(record.venue);
  const matches = new Set(venue ? (catalogIndex.byTitle.get(venue) ?? []) : []);
  for (const issn of collectRecordIssns(record)) {
    for (const entry of catalogIndex.byIssn.get(issn) ?? []) {
      matches.add(entry);
    }
  }
  return [...matches];
}

function qualisPoints(qualis) {
  return ({ A1: 35, A2: 31, A3: 27, A4: 23, B1: 19, B2: 15, B3: 11, B4: 7, C: 1 })[qualis] ?? 0;
}

function rankPoints(rank) {
  return ({ 'A*': 35, A: 30, B: 20, C: 10, Q1: 30, Q2: 22, Q3: 14, Q4: 6 })[rank] ?? 0;
}

function buildCapesProductionIndex(records) {
  const index = new Map();
  for (const record of records) {
    const title = normalizeLookup(record?.title);
    if (!title) {
      continue;
    }
    const key = `${title}::${record?.year ?? ''}`;
    const existing = index.get(key) ?? [];
    existing.push(record);
    index.set(key, existing);
  }
  return index;
}

function findCapesProductions(record, index) {
  return index.get(`${normalizeLookup(record.title)}::${record.year ?? ''}`) ?? [];
}

function scoreRecord(record, publicationType, matches, capesProductionMatches) {
  const reasons = [];
  let score = ({ review: 48, journal_article: 45, conference_paper: 42, unknown: 12 })[publicationType] ?? 5;

  if (ACADEMIC_SOURCES.has(record.source)) {
    score += 18;
    reasons.push(`indexed by ${record.source}`);
  } else if (record.source === 'google_scholar') {
    score += 6;
    reasons.push('discovered by Google Scholar');
  }

  if (record.doi) {
    score += 7;
    reasons.push('DOI present');
  }
  if (record.abstract) {
    score += 4;
  }

  let capesValidated = false;
  let scieloIndexed = record.source === 'scielo';
  let doajIndexed = false;
  let qualis = '';
  let internationalRank = '';

  if (record.source === 'scielo') {
    score += 10;
    reasons.push('published in the SciELO collection');
  }

  if (capesProductionMatches.length > 0) {
    score += 8;
    reasons.push('registered in CAPES/Sucupira production data');
  }

  for (const match of matches) {
    const catalogName = normalizeLookup(match.catalog);
    if (catalogName.includes('capes') || catalogName.includes('qualis')) {
      capesValidated = true;
      qualis = match.qualis || qualis;
      score += 15 + qualisPoints(match.qualis);
      reasons.push(match.qualis ? `CAPES/Qualis ${match.qualis}` : 'matched CAPES catalog');
    }
    if (catalogName.includes('scielo')) {
      scieloIndexed = true;
      score += match.active === false ? 6 : 14;
      reasons.push(match.active === false ? 'matched inactive SciELO title' : 'matched active SciELO title');
    }
    if (catalogName.includes('doaj')) {
      doajIndexed = true;
      score += 12;
      reasons.push('matched DOAJ peer-reviewed journal');
    }
    if (catalogName.includes('core') || catalogName.includes('scimago') || catalogName.includes('sjr')) {
      internationalRank = match.rank || internationalRank;
      score += 10 + rankPoints(match.rank);
      reasons.push(match.rank ? `${match.catalog} ${match.rank}` : `matched ${match.catalog}`);
    }
  }

  const boundedScore = Math.min(100, score);
  const tier = boundedScore >= 85 ? 'high' : boundedScore >= 65 ? 'strong' : boundedScore >= 45 ? 'academic' : 'limited';

  return {
    score: boundedScore,
    tier,
    reasons,
    capes_validated: capesValidated,
    capes_production_registered: capesProductionMatches.length > 0,
    qualis,
    scielo_indexed: scieloIndexed,
    doaj_indexed: doajIndexed,
    international_rank: internationalRank,
    catalog_matches: matches.map((match) => ({
      catalog: match.catalog,
      title: match.title,
      area: match.area,
      active: match.active,
      qualis: match.qualis,
      rank: match.rank,
      peer_reviewed: match.peer_reviewed,
    })),
    capes_production_matches: capesProductionMatches.slice(0, 5).map((match) => ({
      id: match.id,
      year: match.year,
      institution: match.institution,
      program: match.program,
      production_subtype: match.production_subtype,
    })),
  };
}

export function applyAcademicQualityPolicy(records, qualityConfig = {}) {
  if (qualityConfig.enabled !== true || qualityConfig.mode === 'off') {
    return {
      records,
      summary: {
        enabled: false,
        mode: 'off',
        recordsBeforeQualityFilter: records.length,
        recordsAfterQualityFilter: records.length,
        filteredByType: 0,
        filteredByScore: 0,
        capesMatches: 0,
        capesProductionMatches: 0,
        scieloMatches: 0,
        doajMatches: 0,
        catalogStatus: qualityConfig.catalog_status ?? {},
      },
    };
  }

  const mode = qualityConfig.mode === 'strict' ? 'strict' : 'prioritize';
  const allowedTypes = new Set(
    (qualityConfig.allowed_publication_types ?? DEFAULT_ALLOWED_TYPES)
      .map(normalizePublicationType)
      .filter(Boolean),
  );
  const allowUnknown = qualityConfig.allow_unknown_types === true;
  const minimumScore = Number.isFinite(Number(qualityConfig.minimum_score)) ? Number(qualityConfig.minimum_score) : 0;
  const catalogEntries = Array.isArray(qualityConfig.catalog_entries) ? qualityConfig.catalog_entries : [];
  const catalogIndex = buildCatalogIndex(catalogEntries);
  const capesProductionIndex = buildCapesProductionIndex(
    Array.isArray(qualityConfig.capes_productions) ? qualityConfig.capes_productions : [],
  );
  let filteredByType = 0;
  let filteredByScore = 0;

  const enriched = records.map((record) => {
    const publicationType = inferPublicationType(record);
    const matches = catalogMatches(record, catalogIndex);
    const capesProductionMatches = findCapesProductions(record, capesProductionIndex);
    return {
      ...record,
      publication_type: publicationType,
      peer_reviewed: record.peer_reviewed ?? (publicationType === 'journal_article' || publicationType === 'review' || publicationType === 'conference_paper' ? true : null),
      academic_quality: scoreRecord(record, publicationType, matches, capesProductionMatches),
    };
  });

  const filtered = enriched.filter((record) => {
    const typeAllowed = allowedTypes.has(record.publication_type) || (allowUnknown && record.publication_type === 'unknown');
    if (mode === 'strict' && !typeAllowed) {
      filteredByType += 1;
      return false;
    }
    if (mode === 'strict' && record.academic_quality.score < minimumScore) {
      filteredByScore += 1;
      return false;
    }
    return true;
  });

  filtered.sort((left, right) => {
    const scoreDifference = right.academic_quality.score - left.academic_quality.score;
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    return (right.year ?? 0) - (left.year ?? 0);
  });

  return {
    records: filtered,
    summary: {
      enabled: true,
      mode,
      recordsBeforeQualityFilter: records.length,
      recordsAfterQualityFilter: filtered.length,
      filteredByType,
      filteredByScore,
      capesMatches: filtered.filter((record) => record.academic_quality.capes_validated).length,
      capesProductionMatches: filtered.filter((record) => record.academic_quality.capes_production_registered).length,
      scieloMatches: filtered.filter((record) => record.academic_quality.scielo_indexed).length,
      doajMatches: filtered.filter((record) => record.academic_quality.doaj_indexed).length,
      catalogStatus: qualityConfig.catalog_status ?? {},
    },
  };
}
