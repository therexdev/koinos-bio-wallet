import fs from "fs";
import path from "path";

/**
 * Function to read the wasm file from the build folder
 */
export function getBytecode() {
  const asconfigFile = path.join(__dirname, "../src/asconfig.json");
  const asconfigData = fs.readFileSync(asconfigFile, "utf8");
  const asconfig = JSON.parse(asconfigData) as {
    targets: { release: { outFile: string } };
  };
  const wasmFile = path.join(
    __dirname,
    "../src",
    asconfig.targets.release.outFile,
  );
  const bytecode = fs.readFileSync(wasmFile);
  return bytecode;
}
