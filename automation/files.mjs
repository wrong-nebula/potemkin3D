// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { relativePath } from './schema.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export class AutomationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const key of [process.env.FAL_KEY, process.env.GITHUB_TOKEN, process.env.GH_TOKEN, ROOT, os.homedir()]) {
    if (key) text = text.split(key).join(key === ROOT ? '[project]' : key === os.homedir() ? '[home]' : '[redacted]');
  }
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,'[redacted]');
}
export function errorInfo(error) {
  if (error.name === 'ZodError') return { code:'INVALID_INPUT', message:'Input does not match the command schema',
    issues:error.issues.map(i => ({ path:i.path.join('.'), message:redact(i.message) })) };
  return { code:error.code ?? 'FAILED', message:redact(error.message ?? String(error)) };
}
export function inside(root, relative, { exists = true } = {}) {
  relativePath.parse(relative);
  const base = fs.realpathSync(root), dest = path.resolve(base, relative);
  let check = dest;
  while (!fs.existsSync(check)) {
    try { if(fs.lstatSync(check).isSymbolicLink())throw new AutomationError('INVALID_PATH','Dangling symlink in project path'); }
    catch(e) { if(e.code!=='ENOENT')throw e; }
    if (exists) throw new AutomationError('NOT_FOUND', `Missing project file: ${relative}`);
    check = path.dirname(check);
  }
  const resolved = fs.realpathSync(check);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new AutomationError('INVALID_PATH','Path escapes the project through a symlink');
  return dest;
}
export function readJSON(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value,null,2)+'\n', { mode:0o600 });
  fs.renameSync(temp,file);
}
export function inspectGlb(file) {
  const fd = fs.openSync(file,'r');
  try {
    const header=Buffer.alloc(20); if (fs.readSync(fd,header,0,20,0)!==20 || header.toString('ascii',0,4)!=='glTF' || header.readUInt32LE(4)!==2)
      throw new AutomationError('INVALID_GLB','Expected a binary glTF 2.0 file');
    const bytes=fs.fstatSync(fd).size, length=header.readUInt32LE(12);
    if (header.readUInt32LE(8)!==bytes || header.readUInt32LE(16)!==0x4e4f534a || length>32*1024*1024 || length+20>bytes)
      throw new AutomationError('INVALID_GLB','Invalid GLB length or JSON chunk');
    const data=Buffer.alloc(length); fs.readSync(fd,data,0,length,20);
    const gltf=JSON.parse(data.toString('utf8'));
    const primitives=(gltf.meshes??[]).flatMap(m=>m.primitives??[]);
    return { bytes, version:gltf.asset.version, meshes:gltf.meshes?.length??0, nodes:gltf.nodes?.length??0,
      materials:(gltf.materials??[]).map((m,i)=>({index:i,name:m.name??`material-${i}`})),
      primitives:primitives.length, primitivesWithUVs:primitives.filter(p=>p.attributes?.TEXCOORD_0!==undefined).length,
      images:gltf.images?.length??0, extensions:gltf.extensionsUsed??[] };
  } finally { fs.closeSync(fd); }
}
