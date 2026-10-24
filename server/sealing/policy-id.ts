import { readSealPolicy } from "./configuration.js";
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: node dist-server/server/sealing/policy-id.js POLICY_JSON",
  );
const { id } = await readSealPolicy(path);
console.log(id);
