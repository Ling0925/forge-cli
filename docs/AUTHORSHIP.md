# CLI authorship and provenance

Forge CLI was extracted with its path history from the original Forge application. The runtime and provider implementation now belong to [Forge Core](https://github.com/Ling0925/forge-core); this repository owns the command line and terminal interface.

## Workstream credits

- Initial CLI schema, argument and bootstrap corrections: the main agent's authorized runtime-bootstrap work.
- Terminal reader: Gemini 3.8 Flash, continued by DeepSeek V4.1 Flash.
- Later CLI interaction, resource wrapping and private QA: DeepSeek V4.1 Flash.
- Native model-access commands (2026-10-20): a DeepSeek V4.1 Flash workstream began the integration; the main agent inspected and completed its partial implementation and focused validation.

The detailed chronology remains in this file's Git history. Runtime and third-party model-access provenance are maintained in [Core's authorship record](https://github.com/Ling0925/forge-core/blob/master/docs/AUTHORSHIP.md) and [license notices](https://github.com/Ling0925/forge-core/blob/master/THIRD_PARTY_NOTICES.md).

Historical workstream assignments and checks do not describe current task ownership or current-build acceptance. Use [AGENTS.md](../AGENTS.md) for development rules and the [documentation index](README.md) for current commands.
