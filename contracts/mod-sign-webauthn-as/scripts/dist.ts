import fs from 'fs';
import path from 'path';

const config = require('../src/koinos.config.js');

const buildDir = path.relative('../', path.resolve(config.buildDir));
const className: string = config.class;
const protoFiles: string[] = config.proto.map((protoPath: string) => path.join('proto', path.basename(protoPath)));
const protoTs = protoFiles.map(item => item.replace('.proto','.ts'));
const wasm = path.join('release',`${className}.wasm`);
const abi = `${className.toLocaleLowerCase()}-abi.json`;

const filesToCopy: string[] = [
  `I${className}.ts`,
  ...protoFiles,
  ...protoTs,
  abi,
  wasm
];

const distDir = 'dist';
const protoDir = path.join(distDir, 'proto', path.basename(protoFiles[0], '.proto'));

fs.mkdirSync(protoDir, { recursive: true });
fs.mkdirSync(path.join(distDir,'release'), {recursive: true});

filesToCopy.forEach(file => {
  const sourcePath = path.join(buildDir, file);
  const destPath = path.join(distDir, file);
  fs.copyFileSync(sourcePath, destPath);
});

protoFiles.forEach(file => {
  const sourcePath = path.join(buildDir, file);
  const destPath = path.join(distDir, 'proto', path.basename(protoFiles[0], '.proto'), path.basename(file));
  fs.copyFileSync(sourcePath, destPath);
});

protoTs.forEach(file => {
  const sourcePath = path.join(buildDir, file);
  const destPath = path.join(distDir, 'proto', path.basename(protoTs[0], '.ts'), path.basename(file));
  fs.copyFileSync(sourcePath, destPath);
});

const indexContent = `
export { ${className} } from "./${className}"
export { ${className} as I${className} } from "./I${className}"
export { ${path.basename(protoFiles[0], '.proto')} } from "./proto/${path.basename(protoFiles[0], '.proto')}"
`;

fs.writeFileSync(path.join(distDir, 'index.ts'), indexContent.trim());