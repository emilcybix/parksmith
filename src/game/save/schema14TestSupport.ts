import { SAVE_MIGRATIONS, type MigrateOptions } from './migrate';

/**
 * Phase 29 (schema 15) gave every saved guest four fields, so the older fixture proofs that a migration keeps a park
 * "byte for byte" now run the chain up to schema 14 — the last schema that leaves guests as they were — and the 14 -> 15
 * step has its own test (migration.test.ts).
 */
export const TO_SCHEMA_14: MigrateOptions = Object.freeze({
  latestVersion: 14,
  migrations: SAVE_MIGRATIONS.filter((migration) => migration.to <= 14),
});

/**
 * A state without what Phase 29 added to it: the four guest fields, a litter pile's `sick` flag and the souvenir sales
 * total. Older pins that hash a state "at load" keep proving the migration added nothing else. Phase 30: the optional
 * `thoughtObjectId` a complaining guest carries is dropped too (it changes no behaviour; the pins predate it).
 */
export const stripGuestLife = <T>(state: T): T => {
  const copy = JSON.parse(JSON.stringify(state)) as Record<string, any>;
  for (const guest of copy.guests?.guests ?? []) {
    delete guest.nausea;
    delete guest.warmth;
    delete guest.souvenirs;
    delete guest.activity;
    delete guest.thoughtObjectId;
  }
  for (const pile of copy.operations?.litter ?? []) delete pile.sick;
  if (copy.management?.categoryTotals) delete copy.management.categoryTotals.souvenirSales;
  return copy as T;
};
