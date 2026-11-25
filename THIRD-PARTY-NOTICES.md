# Third-party notices

## Independent client

Biandan Companion is independently developed by ShiShiBits. It is not published,
operated or endorsed by the Biandan team or Huawei. It implements the public
Biandan data model and cloud-access contract; it does not distribute the Biandan
native client, its source code, or the MCP server implementation.

The independently authored plugin source and documentation are licensed under
the MIT License in LICENSE. This license does not grant rights to third-party
trademarks, service names or artwork.

## HarmonyOS SiYuan plugin authorization

The public Biandan permission document excludes HarmonyOS clients and
HarmonyOS-targeted packages. On 2026-11-25, the publisher explicitly confirmed
obtaining additional permission from the Biandan team to adapt and publish this
plugin for the HarmonyOS edition of SiYuan. HarmonyOS support relies on that
publisher-confirmed additional authorization, not an expansion of the general
public permission. It covers this SiYuan plugin; it does not grant rights to
the Biandan native application, its source code, or unrelated assets. The
plugin remains an independent third-party product.

## Supplied Biandan artwork

The supplied artwork used by icon.png and the corresponding application header
remains the property of its respective rights holder. The publisher has confirmed
authorization for public redistribution of this artwork. The marketplace icon is
only resized and encoded to meet the marketplace file requirements; it is not a
new artistic interpretation or a claim of official affiliation. This artwork is
not relicensed under MIT.

## Development dependencies

- SiYuan plugin SDK (`siyuan` 1.2.9): MIT; the runtime API is provided by SiYuan.
- Vite 6.4.5: MIT; development and bundling tool.
- fflate 0.8.2, Arjun Barrett: MIT; used only by development package validation.

Dependency packages retain their own license files when installed. The plugin
runtime bundle does not include the fflate validator or a third-party font.

## Sources

- [Biandan developer documentation and third-party permission](https://gitcode.com/biandangroup/biandan_MCP/tree/main/docs/developers)
- [SiYuan plugin SDK](https://github.com/siyuan-note/petal)
- [Vite](https://github.com/vitejs/vite)
- [fflate](https://github.com/101arrowz/fflate)
