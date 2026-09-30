import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncCapesCatalog } from '../src/lib/catalog-sync.mjs';
import { main } from '../paper-ops.mjs';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

test('syncCapesCatalog discovers facets, filters scholarly productions, and writes an auditable snapshot', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'paper-ops-capes-sync-'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/ano-base')) {
      return jsonResponse([{ key: '2024', value: '2024' }, { key: '2023', value: '2023' }]);
    }
    if (String(url).endsWith('/tipo-producao')) {
      return jsonResponse([{ key: '1', value: 'BIBLIOGRÁFICA' }]);
    }
    if (String(url).endsWith('/subtipo-producao')) {
      return jsonResponse([
        { key: '10', value: 'ARTIGO EM PERIÓDICO' },
        { key: '11', value: 'TRABALHO EM ANAIS' },
      ]);
    }
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 0) {
      return jsonResponse({
        content: [
          {
            id: 1,
            nomeProducao: 'A Journal Article',
            anoBase: 2024,
            nomeTipoProducao: 'BIBLIOGRÁFICA',
            nomeSubTipoProducao: 'ARTIGO EM PERIÓDICO',
            autores: [{ ordem: 1, nomePessoa: 'Ada Lovelace' }],
            siglaIes: 'USP',
            nomePrograma: 'COMPUTAÇÃO',
          },
          {
            id: 2,
            nomeProducao: 'An Unrelated Book',
            anoBase: 2024,
            nomeTipoProducao: 'BIBLIOGRÁFICA',
            nomeSubTipoProducao: 'LIVRO',
          },
        ],
        totalPages: 1,
      });
    }
    return jsonResponse({ content: [], totalPages: 1 });
  };

  const result = await syncCapesCatalog({
    projectRoot,
    fetchImpl,
    apiRoot: 'https://example.test/observatorio',
    pageSize: 2,
    maxPages: 5,
    now: new Date('2026-09-30T15:00:00.000Z'),
  });

  assert.equal(result.year, 2024);
  assert.equal(result.raw_records_fetched, 2);
  assert.equal(result.relevant_records, 1);
  assert.equal(result.truncated, false);
  assert.ok(existsSync(result.artifacts.snapshotPath));
  assert.ok(existsSync(result.artifacts.manifestPath));
  const snapshot = readFileSync(result.artifacts.snapshotPath, 'utf8');
  assert.match(snapshot, /A Journal Article/);
  assert.doesNotMatch(snapshot, /Unrelated Book/);
  assert.ok(calls.some((url) => decodeURIComponent(url).includes('subtipo-producao:(10*11)')));
});

test('syncCapesCatalog refuses unavailable years before writing artifacts', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'paper-ops-capes-year-'));
  await assert.rejects(
    syncCapesCatalog({
      projectRoot,
      year: 2020,
      fetchImpl: async () => jsonResponse([{ key: '2024', value: '2024' }]),
      apiRoot: 'https://example.test/observatorio',
    }),
    /Available years: 2024/,
  );
  assert.equal(existsSync(join(projectRoot, 'data', 'catalogs', 'capes', 'productions.jsonl')), false);
});

test('paper-ops catalog sync capes routes CLI flags and renders a summary', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'paper-ops-capes-cli-'));
  const lines = [];
  const result = await main(
    ['catalog', 'sync', 'capes', '--year', '2024', '--page-size', '10', '--max-pages', '1', '--project-root', projectRoot],
    {
      stdout(line) { lines.push(line); },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/ano-base')) {
          return jsonResponse([{ key: '2024', value: '2024' }]);
        }
        if (String(url).includes('/facetas/')) {
          return jsonResponse([]);
        }
        return jsonResponse({ content: [], totalPages: 0 });
      },
    },
  );

  assert.equal(result.year, 2024);
  assert.match(lines.join('\n'), /catalog sync capes complete/i);
  assert.match(lines.join('\n'), /Truncated by safety limit: no/i);
});

test('syncCapesCatalog refreshes one year while preserving previously synchronized years', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'paper-ops-capes-merge-'));
  const createFetch = (articleTitle) => async (url) => {
    if (String(url).endsWith('/ano-base')) {
      return jsonResponse([{ key: '2024', value: '2024' }, { key: '2023', value: '2023' }]);
    }
    if (String(url).includes('/facetas/')) {
      return jsonResponse([]);
    }
    const decoded = decodeURIComponent(String(url));
    const selectedYear = decoded.includes('ano-base:(2023)') ? 2023 : 2024;
    return jsonResponse({
      content: [{
        id: selectedYear,
        nomeProducao: articleTitle,
        anoBase: selectedYear,
        nomeTipoProducao: 'BIBLIOGRÁFICA',
        nomeSubTipoProducao: 'ARTIGO EM PERIÓDICO',
      }],
      totalPages: 1,
    });
  };

  await syncCapesCatalog({ projectRoot, year: 2023, fetchImpl: createFetch('Article 2023') });
  await syncCapesCatalog({ projectRoot, year: 2024, fetchImpl: createFetch('Article 2024') });
  const refreshed = await syncCapesCatalog({ projectRoot, year: 2024, fetchImpl: createFetch('Article 2024 revised') });
  const snapshot = readFileSync(refreshed.artifacts.snapshotPath, 'utf8');

  assert.match(snapshot, /Article 2023/);
  assert.match(snapshot, /Article 2024 revised/);
  assert.doesNotMatch(snapshot, /"title":"Article 2024"/);
  assert.equal(refreshed.snapshot_records, 2);
});
