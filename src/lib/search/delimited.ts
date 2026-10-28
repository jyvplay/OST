/** Original bounded CSV/TSV reader for metadata queries. Never executes spreadsheet formula text. */
export function delimitedMetadata(text:string,separator:','|'\t',limit=4096){
 const records:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false,cells=0,truncated=false;
 const pushCell=()=>{row.push(cell);cell='';closed=false;cells++;};
 const pushRow=()=>{pushCell();records.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(closed&&c!==separator&&c!=='\r'&&c!=='\n')throw new Error('unexpected text after closing CSV quote');
  if(c==='"'){if(cell)throw new Error('quote inside unquoted CSV cell');quoted=true;}
  else if(c===separator)pushCell();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();}
  else cell+=c;
  if(cells>=limit){truncated=true;break;}
 }
 if(!truncated){if(quoted)throw new Error('unterminated CSV quote');if(cell||row.length||closed)pushRow();}
 const header=records.shift()??[];
 const rows=records.map(values=>{const record:Record<string,string[]>=Object.create(null);for(let i=0;i<values.length;i++){const key=header[i]||`column${i+1}`;(record[key]??=[]).push(values[i]);}return record;});
 return {rows,truncated};
}
