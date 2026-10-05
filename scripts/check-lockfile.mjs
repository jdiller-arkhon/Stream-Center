import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
const failures=[];
if(lock.lockfileVersion!==3||!lock.packages?.[''])failures.push('Expected a v3 lockfile with root package metadata.');
for(const [path,pkg] of Object.entries(lock.packages??{})){
 if(!path||pkg.link)continue;
 if(typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version))failures.push(`${path}: missing or invalid package version`);
}
for(const group of ['dependencies','devDependencies','optionalDependencies']){
 const expected=manifest[group]??{},actual=lock.packages?.['']?.[group]??{};
 for(const name of new Set([...Object.keys(expected),...Object.keys(actual)]))if(expected[name]!==actual[name])failures.push(`${group}.${name}: package.json and package-lock.json differ`);
}
if(failures.length){console.error('Invalid dependency lockfile:\n'+failures.map(s=>'  '+s).join('\n'));process.exit(1);}
console.log(`Dependency lockfile valid: ${Object.keys(lock.packages).length-1} package records.`);
