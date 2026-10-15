# common

Interfaces shared by every part of the plugin. One definition per concept, written three ways and kept in step by tests.

| Concept | Schema | TypeScript | Python |
|---------|--------|------------|--------|
| Settings (email, model, engine, run mode, analysis mode) | `schema/settings.schema.json` | `ts/src/settings.ts` | `python/stunfisk_plugin_common/settings.py` |
| Helper wire format | `schema/helper.schema.json` | `ts/src/types.ts` | `python/stunfisk_plugin_common/helper_protocol.py` |
| Model and engine adapters | | `ts/src/types.ts` (descriptions) | `python/stunfisk_plugin_common/adapters.py` |
