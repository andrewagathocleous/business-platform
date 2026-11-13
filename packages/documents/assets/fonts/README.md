# Fonts

Gift cards are drawn with pdfkit, which subsets each font to the glyphs on that card. pdfmake is given only Noto Sans, for packing slips and invoices. The fallback fonts are not registered with pdfmake.

## Noto Sans

- Files: `NotoSans-Regular.ttf` (569,208 bytes), `NotoSans-Bold.ttf`, `NotoSans-Italic.ttf`
- Version: 2.008 (from the font name table)
- Licence: `OFL.txt` (SIL Open Font License, copyright 2018 The Noto Project Authors)
- These three files were already in the repository. This note does not invent a download URL for them.

## Noto Sans Symbols 2

- File: `NotoSansSymbols2-Regular.ttf` (1,233,128 bytes)
- Version: 2.008 (`Version 2.008; ttfautohint (v1.8.4.7-5d5b)`)
- Licence: `OFL-NotoSansSymbols2.txt` (SIL Open Font License, copyright 2022 The Noto Project Authors, https://github.com/notofonts/symbols)
- Downloaded from Google Fonts, pinned commit `7b6724ac7ececc713e9ba93af309f7520c9a80a3` (2023-10-13):
  https://github.com/google/fonts/raw/7b6724ac7ececc713e9ba93af309f7520c9a80a3/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf
- That commit packages the notofonts release `NotoSansSymbols2-v2.008` (upstream commit `25b00f0d3f40873a005287514ba2a48558655314`):
  https://github.com/notofonts/symbols/releases/tag/NotoSansSymbols2-v2.008

## Noto Emoji (monochrome)

- File: `NotoEmoji[wght].ttf` (1,982,596 bytes). This is the variable monochrome font, not Noto Color Emoji.
- Version: 3.002 (`Noto Emoji Regular`, axis `wght`)
- Licence: `OFL-NotoEmoji.txt` (SIL Open Font License, copyright 2013 Google LLC)
- Downloaded unchanged from Google Fonts, pinned commit `b979dba422e445492b0eb9951ac52ee0b4d648c3` (2024-06-05, "Update Noto Emoji to the 3.002 release"):
  https://github.com/google/fonts/raw/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf
