# Sequence row source review

The two supplied Library references show the official shadcn/ui `dashboard-01`
table. Only its sortable table-row/drag-handle/sensor/context pattern is adapted
in `src/components/production-sequence-queue.tsx`; no sample dashboard, fake
records, navigation, table library, schema package, or CLI installer is imported.

Reviewed before adoption on 2026-10-14:

- Repository: <https://github.com/shadcn-ui/ui>, commit
  `30a58d4498f270af1c1e981a7d78a15cf5740841`.
- Actual pinned source: `apps/v4/registry/new-york-v4/blocks/dashboard-01/components/data-table.tsx`.
  Source SHA256 `d05b74af48e3585521b916bae116b32c575688b2c87bf555ec5933ff3a26ee88`.
- Live official `radix-nova/dashboard-01` registry SHA256
  `89d5cafce82f3e63678e19673a80e4e9562e25ff53629ecb1d1f68644f00c733`.
  Its pattern matches the pinned source; icon and unrelated table APIs differ.
- Full MIT license, copyright 2023 shadcn, retained in `shadcn-ui-MIT.txt`.
- Reviewed actual npm archives, package metadata/peer ranges, declarations, and
  MIT licenses for `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`,
  `@dnd-kit/utilities@3.2.2`, and `@dnd-kit/modifiers@9.0.0`.
  Copyright 2021 Claudéric Demers retained in `dnd-kit-MIT.txt`.
  Exact versions/integrity are in the lockfile. React peer range is `>=16.8.0`.
- Installed with `--ignore-scripts --no-audit --no-fund` in the task's isolated
  `/tmp` dependency directory. Five packages added (including accessibility);
  no pre-existing package version changed and no original project dependency
  directory was modified.

Adaptations use one `useSortable` instance per row and a separate activator ref,
keyboard coordinate navigation and Uzbek announcements, handle-only touch
capture, restrained native theme colors, reduced-motion transitions, an explicit
save dialog, native versioned POST, frozen-row exclusions, running/paused and
preflight locks, per-apparatus serialization, and retained exact-key recovery.
