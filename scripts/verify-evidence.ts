import { verifyEvidenceDirectory } from "../server/evidence-verifier.js";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
try {
  const result = await verifyEvidenceDirectory(
    args[0] ?? ".",
    option("--receipt"),
    option("--acceptance"),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.independentlyMatched)
    console.log(
      "Internal consistency passed. No independently retained fingerprint was supplied; this does not prove origin or trusted time.",
    );
} catch (error) {
  console.error(`Verification FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
}
