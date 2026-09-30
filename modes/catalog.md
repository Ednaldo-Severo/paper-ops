# Mode: catalog

Synchronize external academic catalog evidence into local, auditable snapshots.

## CAPES/Sucupira

```text
paper-ops catalog sync capes
paper-ops catalog sync capes --year 2024 --page-size 100 --max-pages 25
```

Workflow:

1. Read the public CAPES/Sucupira production facets.
2. Select the requested year, or the newest year exposed by the API.
3. Request bibliographic journal articles and proceedings papers.
4. Apply a client-side publication-type guard even when API facets are unavailable.
5. Write `data/catalogs/capes/productions.jsonl` atomically.
6. Write a provenance manifest with query, pagination, truncation, warnings, and synchronization time.
7. Use exact normalized title plus year matches as a small ranking signal in future searches.

A production match means the work is registered in CAPES/Sucupira data. It does not mean that its venue has a CAPES/Qualis classification.
