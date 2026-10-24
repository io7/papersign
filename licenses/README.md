# Signing dependency notices

Keep this directory and installed dependency licence/notice files in release
archives. The versioned directories contain unchanged files from the dependency
versions resolved for `@libpdf/core`, `pkijs`, and `asn1js` in `package-lock.json`.
`SOURCES.json` records each source path or URL and the SHA-256 of its copied bytes.

LibPDF 0.5.3 declares its main code MIT but identifies `src/fontbox/` as an
Apache-2.0 port of Apache PDFBox FontBox. Its published archive contains 32
FontBox source-map modules but only the top-level MIT licence, not the FontBox
licence or PDFBox NOTICE. These missing notices are supplied here:

- `libpdf-fontbox-0.5.3-LICENSE.md` is unchanged from the exact LibPDF source
  revision recorded as `gitHead` for the published npm version:
  https://raw.githubusercontent.com/LibPDF-js/core/6bb53b8c7574c1a91992812bcfca8121a11eace8/src/fontbox/LICENSE.md
- `Apache-2.0.txt` is the complete standard licence, including its appendix:
  https://www.apache.org/licenses/LICENSE-2.0.txt
- `apache-pdfbox-NOTICE.txt` is the unchanged upstream NOTICE from the PDFBox
  submodule commit referenced by that LibPDF source revision:
  https://raw.githubusercontent.com/apache/pdfbox/b6c88b8a4252f10a23593907e3439d168877de0e/NOTICE.txt

The upstream FontBox licence also retains the original FontBox project's BSD
notice and upstream font notices. Its content and the complete PDFBox NOTICE
are preserved without selecting or rewriting copyright statements; inclusion
of these upstream notices does not assert that every named upstream font or
component is present in PaperSign.

No dependency source was modified. Refresh these copies when the resolved
dependency versions change. This directory covers the signing dependency tree;
it does not replace the licences for PaperSign's other components or assets.
