# roam-vaults

A planned Roam Research extension for the Roam desktop app. It will show local markdown vaults
(Obsidian vaults, Open Knowledge Format bundles, and similar) inside Roam:

- browse vault notes;
- on any Roam page, show which vault notes correspond to it or link to it, kept separate from
  Roam's own references.

**Status:** first working version (Phase 1 MVP) in [`extension/`](extension/): one or more Obsidian vaults, an
"External Vault References" section on every page (one per vault), live updates and a read-only note viewer.

- [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md): findings, risks, proposed architecture and roadmap.
- [`extension/`](extension/): the extension. Its [README](extension/README.md) is the user guide shown in
  Roam Depot; [DEVELOPING.md](extension/DEVELOPING.md) covers building and loading it in developer mode.
- [`docs/DEPOT-SUBMISSION.md`](docs/DEPOT-SUBMISSION.md): how to submit to Roam Depot, and the checklist.
- [`spike/`](spike/): a throwaway prototype of the vault parser, link resolver and Roam-title matcher,
  with benchmarks.
