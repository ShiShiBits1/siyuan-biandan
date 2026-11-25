import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateSync,unzlibSync} from 'fflate';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const EXPECTED=['index.js','index.css','plugin.json','README.md','README.zh-CN.md','icon.png','preview.png','LICENSE','THIRD-PARTY-NOTICES.md'];
const MAX_FILE_BYTES=8*1024*1024,MAX_TOTAL_BYTES=16*1024*1024,MAX_ARCHIVE_BYTES=20*1024*1024;
const fail=message=>{throw new Error(message);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const sameNames=(actual,expected)=>actual.length===expected.length&&new Set(actual.map(name=>name.toLowerCase())).size===actual.length&&[...actual].sort().join('\n')===[...expected].sort().join('\n');
const json=(bytes,name)=>{try{return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('Invalid JSON: '+name);}};
const safeName=name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)&&name!=='.'&&name!=='..';
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const crc32=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;};
function adler32(bytes){let a=1,b=0;for(let offset=0;offset<bytes.length;offset+=5552){for(const byte of bytes.subarray(offset,offset+5552)){a+=byte;b+=a;}a%=65521;b%=65521;}return ((b<<16)|a)>>>0;}
function regularFile(path,label,maxBytes=MAX_FILE_BYTES){
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!stat.isFile())fail(label+' must be a regular file, not a link');
  if(stat.size===0||stat.size>maxBytes)fail(label+' has an invalid file size');
  return readFileSync(path);
}
function packageManifest(){
  const manifest=json(regularFile(resolve(projectRoot,'scripts/package-files.json'),'Package manifest'),'Package manifest');
  if(manifest.version!==1||!Array.isArray(manifest.generated)||!Array.isArray(manifest.copied)||!sameNames(manifest.generated,['index.js','index.css'])||!sameNames([...manifest.generated,...manifest.copied],EXPECTED))fail('Package manifest differs from the nine-file allowlist');
  return [...manifest.generated,...manifest.copied];
}
function checkedDirectory(directory,required){
  const stat=lstatSync(directory);
  if(stat.isSymbolicLink()||!stat.isDirectory())fail('Package directory must be a real directory, not a link');
  const names=readdirSync(directory);
  if(names.some(name=>!safeName(name))||!sameNames(names,required))fail('Package directory differs from the exact allowlist');
  const files=new Map(names.map(name=>[name,regularFile(resolve(directory,name),name)]));
  if([...files.values()].reduce((total,bytes)=>total+bytes.length,0)>MAX_TOTAL_BYTES)fail('Package exceeds the total size limit');
  return files;
}
function png(bytes,name,width,height,maxBytes){
  if(bytes.length>maxBytes)fail(name+' exceeds '+maxBytes+' bytes');
  if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail(name+' must be a valid PNG');
  let offset=8,header=null,ended=false,palette=false,idatEnded=false;
  const compressed=[];
  while(offset<bytes.length){
    if(offset+12>bytes.length)fail('Truncated PNG chunk: '+name);
    const size=bytes.readUInt32BE(offset),end=offset+12+size;
    if(size>0x7fffffff||end>bytes.length)fail('Invalid PNG chunk length: '+name);
    const kind=bytes.toString('ascii',offset+4,offset+8),payload=bytes.subarray(offset+8,offset+8+size);
    if(!/^[A-Za-z]{4}$/.test(kind)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))fail('Invalid PNG chunk or checksum: '+name);
    if(!header&&kind!=='IHDR')fail('PNG must begin with IHDR: '+name);
    if(kind==='IHDR'){
      if(header||size!==13)fail('Invalid PNG IHDR: '+name);
      header={width:payload.readUInt32BE(0),height:payload.readUInt32BE(4),depth:payload[8],color:payload[9],interlace:payload[12]};
      if(header.width!==width||header.height!==height)fail(name+' must be '+width+'x'+height);
      if(!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[header.color]?.includes(header.depth)||payload[10]!==0||payload[11]!==0||header.interlace>1)fail('Unsupported PNG encoding: '+name);
    }else if(kind==='PLTE'){
      if(palette||compressed.length||!size||size%3||size>768||header.color===3&&size/3>2**header.depth||[0,4].includes(header.color))fail('Invalid PNG palette: '+name);
      palette=true;
    }else if(kind==='IDAT'){
      if(idatEnded||header.color===3&&!palette)fail('Invalid PNG image data ordering: '+name);
      compressed.push(payload);
    }else if(kind==='IEND'){
      if(size!==0||!compressed.length||end!==bytes.length)fail('Invalid PNG ending: '+name);
      ended=true;offset=end;break;
    }else{
      if(kind[0]===kind[0].toUpperCase())fail('Unsupported critical PNG chunk: '+name);
      if(compressed.length)idatEnded=true;
    }
    offset=end;
  }
  if(!ended||offset!==bytes.length)fail('PNG has no valid IEND: '+name);
  const channels={0:1,2:3,3:1,4:2,6:4}[header.color],bits=channels*header.depth;
  const passes=header.interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const rows=passes.flatMap(([x,y,dx,dy])=>{const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));return w&&h?Array(h).fill(1+Math.ceil(w*bits/8)):[];});
  const expected=rows.reduce((total,size)=>total+size,0),zlib=Buffer.concat(compressed);
  if(zlib.length<6||zlib[1]&32)fail('Invalid PNG zlib stream: '+name);
  let decoded;
  try{decoded=Buffer.from(unzlibSync(zlib,{out:new Uint8Array(expected+1)}));}catch{fail('Invalid PNG image compression: '+name);}
  if(decoded.length!==expected||adler32(decoded)!==zlib.readUInt32BE(zlib.length-4))fail('Invalid PNG image length or checksum: '+name);
  let cursor=0;for(const length of rows){if(decoded[cursor]>4)fail('Invalid PNG scanline filter: '+name);cursor+=length;}
}
function extraFields(bytes,label){
  let offset=0;
  while(offset<bytes.length){
    if(offset+4>bytes.length)fail('Truncated ZIP extra field: '+label);
    const type=bytes.readUInt16LE(offset),length=bytes.readUInt16LE(offset+2);offset+=4;
    if(offset+length>bytes.length)fail('Truncated ZIP extra value: '+label);
    // Unicode aliases, ZIP64 and Unix link extensions can change extraction
    // semantics. These nine ASCII root files need none of those extensions.
    if(![0x000a,0x5455,0x7875].includes(type))fail('Unsupported ZIP extra field: '+label);
    offset+=length;
  }
}
function checkedArchive(bytes,files,required){
  if(bytes.length<22)fail('Truncated ZIP archive');
  let eocd=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50&&offset+22+bytes.readUInt16LE(offset+20)===bytes.length){eocd=offset;break;}
  if(eocd<0)fail('ZIP end record is missing or has trailing bytes');
  const count=bytes.readUInt16LE(eocd+10),centralSize=bytes.readUInt32LE(eocd+12),centralOffset=bytes.readUInt32LE(eocd+16);
  if(bytes.readUInt16LE(eocd+4)!==0||bytes.readUInt16LE(eocd+6)!==0||bytes.readUInt16LE(eocd+8)!==count||count!==required.length||count===0xffff||centralOffset===0xffffffff||centralSize===0xffffffff||centralOffset+centralSize!==eocd)fail('ZIP must be a single-disk, non-ZIP64 archive of exactly nine entries');
  const entries=[],seen=new Set();let offset=centralOffset,total=0;
  for(let index=0;index<count;index++){
    if(offset+46>eocd||bytes.readUInt32LE(offset)!==0x02014b50)fail('Invalid ZIP central directory');
    const needed=bytes.readUInt16LE(offset+6),flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressedSize=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),disk=bytes.readUInt16LE(offset+34),attributes=bytes.readUInt32LE(offset+38),localOffset=bytes.readUInt32LE(offset+42);
    const next=offset+46+nameLength+extraLength+commentLength;
    if(next>eocd||!nameLength)fail('Truncated ZIP central entry');
    const rawName=bytes.subarray(offset+46,offset+46+nameLength),name=rawName.toString('utf8');
    if(!safeName(name)||!Buffer.from(name,'utf8').equals(rawName)||!required.includes(name)||seen.has(name.toLowerCase()))fail('Unsafe, unknown or duplicate ZIP entry: '+name);
    seen.add(name.toLowerCase());
    const mode=(attributes>>>16)&0xf000;
    if(attributes&0x410||mode&&mode!==0x8000)fail('ZIP entries must be regular files, not directories or links: '+name);
    if(needed>20||flags&~0x080e||![0,8].includes(method)||disk!==0||localOffset===0xffffffff||compressedSize===0xffffffff||size===0xffffffff||size!==files.get(name).length||size>MAX_FILE_BYTES||compressedSize>MAX_ARCHIVE_BYTES||crc!==crc32(files.get(name)))fail('Unsupported ZIP entry encoding, size or checksum: '+name);
    total+=size;if(total>MAX_TOTAL_BYTES)fail('ZIP exceeds the total expanded size limit');
    extraFields(bytes.subarray(offset+46+nameLength,offset+46+nameLength+extraLength),name);
    entries.push({name,rawName,flags,method,crc,compressedSize,size,localOffset});offset=next;
  }
  if(offset!==eocd||!sameNames(entries.map(entry=>entry.name),required))fail('ZIP central directory differs from the exact allowlist');
  const ranges=[];
  for(const entry of entries){
    const start=entry.localOffset;
    if(start+30>centralOffset||bytes.readUInt32LE(start)!==0x04034b50)fail('Invalid ZIP local header: '+entry.name);
    const nameLength=bytes.readUInt16LE(start+26),extraLength=bytes.readUInt16LE(start+28),dataStart=start+30+nameLength+extraLength,dataEnd=dataStart+entry.compressedSize;
    if(dataStart>centralOffset||dataEnd>centralOffset||bytes.readUInt16LE(start+4)>20||bytes.readUInt16LE(start+6)!==entry.flags||bytes.readUInt16LE(start+8)!==entry.method||!bytes.subarray(start+30,start+30+nameLength).equals(entry.rawName))fail('ZIP local/central headers disagree: '+entry.name);
    extraFields(bytes.subarray(start+30+nameLength,dataStart),entry.name);
    const localValues=[bytes.readUInt32LE(start+14),bytes.readUInt32LE(start+18),bytes.readUInt32LE(start+22)],expected=[entry.crc,entry.compressedSize,entry.size];
    if(localValues.some((value,index)=>value!==expected[index]&&(!(entry.flags&8)||value!==0)))fail('ZIP local sizes/checksum disagree: '+entry.name);
    let end=dataEnd;
    if(entry.flags&8){
      const signature=end+4<=centralOffset&&bytes.readUInt32LE(end)===0x08074b50;
      if(signature)end+=4;
      if(end+12>centralOffset||[0,4,8].some((position,index)=>bytes.readUInt32LE(end+position)!==expected[index]))fail('Invalid ZIP data descriptor: '+entry.name);
      end+=12;
    }
    const compressed=bytes.subarray(dataStart,dataEnd);let decoded;
    try{decoded=entry.method===0?compressed:Buffer.from(inflateSync(compressed,{out:new Uint8Array(entry.size+1)}));}catch{fail('Invalid ZIP compressed data: '+entry.name);}
    if(decoded.length!==entry.size||crc32(decoded)!==entry.crc||!files.get(entry.name).equals(decoded))fail('Archive differs from verified package file: '+entry.name);
    ranges.push([start,end]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);let end=0;
  for(const range of ranges){if(range[0]!==end||range[1]<=range[0])fail('ZIP contains overlapping, hidden or unlisted data');end=range[1];}
  if(end!==centralOffset)fail('ZIP contains unlisted local entries or padding');
}

/** Local checks deliberately do not claim GitHub publication or marketplace
 * approval. Those are separate live checks performed by the publisher. */
export function validateMarketplace({directory=resolve(projectRoot,'dist'),archivePath,requirePackageName=false}={}){
  const required=packageManifest(),files=checkedDirectory(resolve(directory),required);
  const plugin=json(files.get('plugin.json'),'plugin.json'),sourcePlugin=json(regularFile(resolve(projectRoot,'plugin.json'),'Source plugin.json'),'Source plugin.json'),sourcePackage=json(regularFile(resolve(projectRoot,'package.json'),'Source package.json'),'Source package.json');
  if(plugin.name!=='siyuan-biandan'||sourcePackage.name!==plugin.name||plugin.version!==sourcePackage.version||canonical(plugin)!==canonical(sourcePlugin))fail('Package metadata identity/version differs from source');
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plugin.version))fail('Invalid semantic version');
  if(plugin.url!=='https://github.com/ShiShiBits1/siyuan-biandan')fail('Marketplace requires the configured same-name public GitHub repository URL');
  if(plugin.icon!=='icon.png'||plugin.preview!=='preview.png')fail('Marketplace icon/preview must reference the packaged root PNG files');
  if(plugin.readme?.default!=='README.md'||plugin.readme?.['zh-CN']!=='README.zh-CN.md')fail('Marketplace requires separate default English and zh-CN readmes');
  for(const field of ['displayName','description'])for(const locale of ['default','zh-CN'])if(typeof plugin[field]?.[locale]!=='string'||!plugin[field][locale].trim())fail('Missing '+locale+' '+field);
  for(const field of ['backends','frontends'])if(!Array.isArray(plugin[field])||!plugin[field].length||plugin[field].some(value=>typeof value!=='string'||!value))fail('Missing supported '+field);
  if(typeof plugin.minAppVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(plugin.minAppVersion))fail('Missing minimum SiYuan version');
  for(const name of ['README.md','README.zh-CN.md']){
    const text=files.get(name).toString('utf8');
    if(!text.trim()||!text.includes(plugin.version))fail('Readme must identify the current version: '+name);
  }
  const license=files.get('LICENSE').toString('utf8').replace(/\s+/g,' ');
  if(!license.includes('MIT License')||!license.includes('Permission is hereby granted')||!license.includes('use, copy, modify, merge, publish, distribute, sublicense, and/or sell'))fail('The package must contain the selected MIT redistribution license');
  if(!files.get('THIRD-PARTY-NOTICES.md').toString('utf8').trim())fail('Missing third-party license notices');
  png(files.get('icon.png'),'icon.png',160,160,64*1024);
  png(files.get('preview.png'),'preview.png',1024,768,512*1024);
  for(const name of required.filter(name=>!['index.js','index.css'].includes(name)))if(!files.get(name).equals(regularFile(resolve(projectRoot,name),'Source '+name)))fail('Packaged metadata/resource differs from source: '+name);
  let archiveBytes;
  if(archivePath){
    if(requirePackageName&&basename(archivePath)!=='package.zip')fail('Marketplace Release asset must be named package.zip');
    archiveBytes=regularFile(resolve(archivePath),'Release archive',MAX_ARCHIVE_BYTES);
    checkedArchive(archiveBytes,files,required);
  }
  return {status:'local-marketplace-package-valid',version:plugin.version,repository:plugin.url,fileCount:required.length,files:required.map(name=>({name,bytes:files.get(name).length,sha256:sha256(files.get(name))})),...(archiveBytes?{archive:resolve(archivePath),sha256:sha256(archiveBytes)}:{}),pendingExternalChecks:['public same-name GitHub repository with main default branch','latest Release package.zip asset','marketplace listing review']};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);let directory,archivePath,requirePackageName=false;
    for(let index=0;index<args.length;index++){
      const argument=args[index];
      if(argument==='--require-package-name'){requirePackageName=true;continue;}
      if(!['--directory','--archive'].includes(argument)||!args[index+1]||args[index+1].startsWith('--'))fail('Usage: Validate-Marketplace.mjs [--directory path] [--archive path] [--require-package-name]');
      if(argument==='--directory')directory=resolve(args[++index]);else archivePath=resolve(args[++index]);
    }
    process.stdout.write(JSON.stringify(validateMarketplace({directory,archivePath,requirePackageName}),null,2)+'\n');
  }catch(error){process.stderr.write((error?.message||String(error))+'\n');process.exitCode=1;}
}
