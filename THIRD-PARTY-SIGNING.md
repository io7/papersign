# Signing dependencies and licence notices

PaperSign signs with an MIT-licensed primary library and other permissive
dependencies. No commercial or copyleft signing SDK is used. Versions and
integrity hashes are pinned in `package-lock.json`; preserve installed licence
and notice files and the `licenses/` directory in every release.

| Component                                        | Licence                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `@libpdf/core`                                   | MIT; bundled FontBox implementation is Apache-2.0 |
| `pkijs`, `asn1js`, `bytestreamjs`                | BSD-3-Clause                                      |
| `@noble/ciphers`, `@noble/hashes`, `@scure/base` | MIT                                               |
| `pvtsutils`, `pvutils`                           | MIT                                               |
| `pako`                                           | MIT AND Zlib                                      |
| `lru-cache`                                      | BlueOak-1.0.0                                     |
| `tslib`                                          | 0BSD                                              |

LibPDF's published README identifies the FontBox exception. Its MIT licence does
not relicense bundled code or dependencies. PKI.js supplies ASN.1/certificate
structures and path validation; Node crypto performs signature verification.
PaperSign adds explicit trust/evidence policy and final-output checks.

The published `@libpdf/core@0.5.3` archive omits the FontBox licence file, although
its compiled bundle includes that code. `licenses/` therefore includes the exact
upstream FontBox licence and attribution, the full Apache-2.0 text, and the
original PDFBox NOTICE. It also contains unchanged installed licence/notice
copies for the signing dependency tree. See `licenses/README.md` for the pinned
source revisions and `licenses/SOURCES.json` for file hashes.

This list covers added signing dependencies. It does not declare all existing
PaperSign components or bundled font/image data MIT.

Primary sources:

- https://github.com/LibPDF-js/core
- https://github.com/PeculiarVentures/PKI.js/blob/master/LICENSE
- https://github.com/PeculiarVentures/ASN1.js/blob/master/LICENSE
- https://github.com/nodeca/pako/blob/master/LICENSE
- https://github.com/isaacs/node-lru-cache/blob/main/LICENSE.md
