# Curator V2 project work areas

- `inbox/status.json` is a generated count-only view. Any payload retained for retry stays in SQLite under its retry and retention rules.
- `sde-proposals/pending.json` is a generated queue view. Inspect the full proposal and approve or reject it in the CuratorMD V2 dashboard.
- `side-buffer/` is the configured temporary file area. Curator inventories it and only removes exact files after an approved cleanup receipt.
- The SQLite ledger is authoritative. JSON files here are refreshable views, never approval receipts or canonical facts.
