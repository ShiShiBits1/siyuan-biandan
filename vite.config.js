import {defineConfig} from 'vite';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(resolve(root,'scripts/package-files.json'),'utf8'));
const required=[...manifest.generated,...manifest.copied];
if(manifest.version!==1||required.length!==9||new Set(required).size!==9||required.some(name=>typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)))throw new Error('Invalid exact package file manifest');
const dist=resolve(root,'dist');
if(existsSync(dist)&&lstatSync(dist).isSymbolicLink())throw new Error('Package output must not be a link');
export default defineConfig({
  plugins:[{name:'marketplace-metadata',closeBundle(){
    mkdirSync(dist,{recursive:true});
    if(lstatSync(dist).isSymbolicLink())throw new Error('Package output must not be a link');
    for(const name of manifest.copied){
      const source=resolve(root,name),stat=lstatSync(source);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Metadata must be a regular file: '+name);
      copyFileSync(source,resolve(dist,name));
    }
    const actual=readdirSync(dist);
    if(actual.length!==required.length||actual.some(name=>!required.includes(name)))throw new Error('Build output differs from the exact package allowlist');
    for(const name of actual){const stat=lstatSync(resolve(dist,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Package entry must be a regular file: '+name);}
  }}],
  build:{outDir:dist,emptyOutDir:true,target:'es2020',lib:{entry:resolve(root,'src/index.js'),formats:['cjs'],fileName:()=> 'index.js'},rollupOptions:{external:['siyuan'],output:{assetFileNames:asset=>asset.name?.endsWith('.css')?'index.css':asset.name}}}
});
