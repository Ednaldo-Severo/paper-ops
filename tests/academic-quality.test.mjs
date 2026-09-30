import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyAcademicQualityPolicy,
  inferPublicationType,
  loadAcademicCatalogs,
} from '../src/lib/academic-quality.mjs';

test('inferPublicationType recognizes journals, reviews, conferences, and preprints', () => {
  assert.equal(inferPublicationType({ source: 'ieee', title: 'A method', venue: 'IEEE Access' }), 'journal_article');
  assert.equal(inferPublicationType({ source: 'acm', title: 'A method', venue: 'Proceedings of ICSE' }), 'conference_paper');
  assert.equal(inferPublicationType({ source: 'scopus', title: 'A systematic review', venue: 'Evidence Synthesis' }), 'review');
  assert.equal(inferPublicationType({ source: 'google_scholar', title: 'A method', venue: 'arXiv' }), 'preprint');
});

test('loadAcademicCatalogs reads title-based SciELO catalogs and ignores placeholder titles', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'paper-ops-quality-'));
  const catalogPath = join(projectRoot, 'journals.csv');
  writeFileSync(
    catalogPath,
    'Areas,Title,Is active?\n,title-placeholder,False\nComputer Science,Journal of Evidence Automation,True\n',
    'utf8',
  );

  const loaded = loadAcademicCatalogs(projectRoot, { catalogs: { scielo_journals: 'journals.csv' } });

  assert.equal(loaded.catalog_entries.length, 1);
  assert.equal(loaded.catalog_entries[0].title, 'Journal of Evidence Automation');
  assert.equal(loaded.catalog_entries[0].active, true);
  assert.equal(loaded.catalog_status.scielo_journals.records, 1);
});

test('applyAcademicQualityPolicy filters non-article types and ranks curated journals first', () => {
  const records = [
    {
      source: 'scopus', title: 'Strong article', venue: 'Journal of Evidence Automation', year: 2024,
      doi: '10.1000/strong', abstract: 'Evidence.',
    },
    {
      source: 'acm', title: 'Conference article', venue: 'Proceedings of ICSE', year: 2025,
      doi: '10.1000/conference', abstract: 'Evidence.',
    },
    {
      source: 'google_scholar', title: 'Unreviewed manuscript', venue: 'arXiv', year: 2026,
      doi: '', abstract: '',
    },
  ];
  const result = applyAcademicQualityPolicy(records, {
    enabled: true,
    mode: 'strict',
    minimum_score: 40,
    allowed_publication_types: ['journal_article', 'review', 'conference_paper'],
    catalog_entries: [{
      catalog: 'scielo_journals',
      title: 'Journal of Evidence Automation',
      normalized_title: 'journal of evidence automation',
      normalized_acronym: '',
      issns: [],
      vehicle_type: 'journal',
      area: 'Computer Science',
      active: true,
      qualis: '',
      rank: '',
    }],
    capes_productions: [{
      id: 'CAPES-1',
      title: 'Strong article',
      year: 2024,
      institution: 'USP',
      program: 'COMPUTAÇÃO',
      production_subtype: 'ARTIGO EM PERIÓDICO',
    }],
  });

  assert.equal(result.records.length, 2);
  assert.equal(result.summary.filteredByType, 1);
  assert.equal(result.records[0].title, 'Strong article');
  assert.equal(result.records[0].academic_quality.scielo_indexed, true);
  assert.equal(result.records[0].academic_quality.capes_production_registered, true);
  assert.equal(result.summary.capesProductionMatches, 1);
  assert.ok(result.records[0].academic_quality.score > result.records[1].academic_quality.score);
});
