import http from 'node:http';
let assetRequests=0;
http.createServer((req,res)=>{
 if(req.url==='/count'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({assetRequests}));return;}
 if(req.url==='/asset'){assetRequests++;res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>');return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Loaded memory publisher</title><h1>Already viewed visual</h1><canvas width="160" height="90" style="width:320px;height:180px"></canvas><button onclick="paint('lime')">Change viewed pixels</button><button onclick="taint()">Load opaque image</button><script>
 const c=document.querySelector('canvas'),ctx=c.getContext('2d');function paint(color){ctx.fillStyle=color;ctx.fillRect(0,0,160,90);}paint('red');
 function taint(){const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,160,90);img.src='/asset';}
 </script>`);
}).listen(4002,'0.0.0.0',()=>console.log('Real loaded-media publisher 4002'));
