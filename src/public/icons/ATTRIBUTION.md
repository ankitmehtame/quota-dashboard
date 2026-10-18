# Provider and tool icons

These icons identify their respective providers and tools. Their inclusion does not imply endorsement. Brand names and trademarks remain the property of their owners.

## selfh.st/icons

Source collection: https://selfh.st/icons/

Collection license: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), as published in the [selfh.st/icons license](https://github.com/selfhst/icons/blob/main/LICENSE). Individual marks remain the property of their respective owners. See https://selfh.st/icons-about/ for the collection's usage notice.

| Local file | Owner / mark | Download source |
| --- | --- | --- |
| `claude.svg` | Anthropic / Claude | https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/claude.svg |
| `openai.svg` | OpenAI | https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/openai-light.svg |
| `openrouter.svg` | OpenRouter | https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/openrouter-light.svg |
| `ollama.svg` | Ollama | https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/ollama.svg |

## theSVG

Source collection: https://thesvg.org/

The collection advertises free personal and commercial use without required attribution. Brand ownership and trademark restrictions still apply. See the collection's [legal notice](https://thesvg.org/legal) and individual asset pages. This does not assert that third-party trademarks are licensed under the collection website's software license.

| Local file | Owner / mark | Asset page | Download source |
| --- | --- | --- | --- |
| `hermes.svg` | Nous Research / Hermes | https://thesvg.org/icon/nousresearch-hermes | https://thesvg.org/icons/nousresearch-hermes/default.svg |
| `antigravity.svg` | Google / Antigravity | https://thesvg.org/icon/google-antigravity | https://thesvg.org/icons/google-antigravity/default.svg |
| `gemini.svg` | Google / Gemini | https://thesvg.org/icon/google-gemini | https://thesvg.org/icons/google-gemini/default.svg |
| `opencode.svg` | OpenCode | https://thesvg.org/icon/opencode | https://thesvg.org/icons/opencode/default.svg |

## Modifications and updates

All bundled and runtime-downloaded SVGs pass through the same static-SVG validation and serialization. Comments and unnecessary namespace declarations are removed. Internal XLink references become SVG `href` attributes. `currentColor` becomes the dashboard's light icon color, `#f0f5f1`. Explicit colors, including multicolor artwork, and implicit SVG black fills are preserved. The OpenAI and OpenRouter light variants are used for contrast on the dark dashboard.

The Gemini asset's root `role="img"` attribute is omitted to match the static-SVG allowlist. The enclosing dashboard markup already handles accessibility.

The server refreshes only these listed sources, at most daily when the dashboard opens. The same modifications apply to accepted updates. Browser clients never contact the source collections directly.
