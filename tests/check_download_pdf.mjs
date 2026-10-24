import { textLength, withPdfs } from "./helpers/pdf-inspection.mjs";

const proof = await withPdfs([process.argv[2]], async (document) => ({
  pages: document.numPages,
  textLength: await textLength(document),
}));
console.log(JSON.stringify(proof));
