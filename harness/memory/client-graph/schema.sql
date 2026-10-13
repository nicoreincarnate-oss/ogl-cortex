-- OGL Cortex client memory graph. Three tables from Glitch Cat Club's graph memory starter,
-- plus a date and a verbatim quote on each relation, plus a small meta table.
CREATE TABLE entities  (id TEXT PRIMARY KEY,   -- uuid5(type + normalised name)
                        name TEXT, type TEXT, description TEXT, source TEXT);
CREATE TABLE relations (source_id TEXT, target_id TEXT, predicate TEXT, source TEXT, date TEXT, quote TEXT);
CREATE TABLE aliases   (entity_id TEXT, alias TEXT);
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT);   -- JSON values: no_seed, own_names, built_at
CREATE INDEX rel_src ON relations(source_id);
CREATE INDEX rel_tgt ON relations(target_id);
