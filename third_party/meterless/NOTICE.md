# Notice

This directory redistributes material from the Meterless repository (https://github.com/Meterless/Meterless), which is licensed under the Apache License, Version 2.0 (see `LICENSE`). Copyright 2026 Meterless.

The files here are included unmodified. The upstream repository carries no NOTICE file at the pinned commit, so there are no upstream attribution notices to reproduce beyond the licence itself. The record of what was copied, from which commit, and how it was verified is in `PROVENANCE.md`.

Meterless, H-MEM, World Model, Markovian and Scout Intent are names used by their authors. Their use here describes the specifications that Sakaime's own engines follow and are tested against; it does not imply endorsement by Meterless.

Sakaime's own implementations in `src/engines/` are written from the specifications and the conformance behaviour, not copied from the reference sources. They are licensed with the rest of Sakaime. Where Sakaime's implementations follow a published formula, constant or threshold from the specification (for example the H-MEM retrieval weights and the feedback deltas), that is use of the specification, not of the reference code; the places where Sakaime deliberately differs from the reference are described in the header comments of the modules in `src/engines/` and exercised by the tests under `tests/engines/`.
