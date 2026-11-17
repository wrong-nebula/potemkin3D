# Source provenance

Potemkin extends [Patch Trompe](https://github.com/Patch-gg/trompe), licensed under Apache-2.0. The public repository retains upstream history, with subsequent local development consolidated under `wrong-nebula` to avoid exposing private local Git identities. The README comparison uses upstream `ba9ef76687f57eef157057c7592d26e59c805992`, checked on 2026-11-17.

The working project was copied into a dedicated Potemkin directory. Its full generation runs were already absent, while the baked website and scene assets remained. During publication preparation, these source directories were recovered from retained Git tree objects:

| Directory | Tree object |
| --- | --- |
| `experiments/luxor-view` | `b129b8b6154126eb7fce05fe45cd0d47cf48ed1e` |
| `experiments/material-lab` | `3790543cb65de9cda909dea486c252bcb3798eae` |
| `experiments/benchmark` | `62f5594652ee71d4e0f9ccf6efa74ff350ba9c6d` |

These trees coexisted under retained parent tree `073ddae41bb8260ae4b54bd9f4a8e44d87963fd1`. Recovery restores editable code; it does not recreate the original generation runs or establish exact byte-for-byte equivalence with every historical browser bundle. The new `build:scenes` command rebuilds both viewers from the included source and baked scene assets without image-generation calls.

Publication preparation adds the README and screenshot, notices and asset credits, a scene build command, and public package metadata. It excludes credentials, machine settings, private deployment linkage and unlicensed reference inputs. Modified upstream source files carry a Potemkin change notice. The public Luxor look file omits the historical reference photograph of unknown origin and uses four attributed CC BY-SA photographs.

The automation extension adds a shared schema-driven CLI and MCP server, detached local job workers, artifact resources, free examples and a tutorial. It adds binary export and local cost-estimate methods to the browser API and records atlas resolution in new run metadata for reproducible restoration.
