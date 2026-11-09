# Vaults for Roam Research

See notes from your Obsidian-style vaults in your Roam graph.

Vaults is a Roam Research extension. An Obsidian-style vault is a local folder of linked Markdown notes,
such as an Obsidian vault or an Open Knowledge Format (OKF) bundle. On any Roam page, Vaults shows which
vault notes match the page or link to it, in an **External Vault References** section kept separate from
Roam's own references. You can read any note in Roam.

**Status:** version 0.1.0 is in [`extension/`](extension/): one or more vaults in a single External Vault
References section, live updates and a read-only note viewer.

- [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md): findings, risks, proposed architecture and roadmap.
- [`extension/`](extension/): the extension. Its [README](extension/README.md) is the user guide shown in
  Roam Depot; [DEVELOPING.md](extension/DEVELOPING.md) covers building and loading it in developer mode.
- [`docs/DEPOT-SUBMISSION.md`](docs/DEPOT-SUBMISSION.md): how to submit to Roam Depot, and the checklist.
- [`spike/`](spike/): a throwaway prototype of the vault parser, link resolver and Roam-title matcher,
  with benchmarks.
