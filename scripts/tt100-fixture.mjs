// Real local HTTP publisher for exclusive tests, not a request-intercepted/mock API.
import http from 'node:http';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=','base64');
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1:4001');
 if(u.pathname==='/image.png'){res.writeHead(200,{'content-type':'image/png'});return res.end(png);}
 if(u.pathname==='/large'){res.writeHead(200,{'content-type':'image/png','content-length':9*1024*1024});return res.end(Buffer.alloc(9*1024*1024));}
 if(u.pathname==='/partial'){res.writeHead(206,{'content-type':'image/png'});return res.end(png);}
 if(u.pathname==='/redirect'){res.writeHead(302,{location:'/image.png'});return res.end();}
 if(u.pathname==='/playlist'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});return res.end('#EXTM3U\nsegment.ts');}
 if(u.pathname==='/slow'){res.writeHead(200,{'content-type':'image/png'});res.write(png.subarray(0,10));const t=setTimeout(()=>res.end(png.subarray(10)),15000);res.on('close',()=>clearTimeout(t));return;}
 res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Recall live publisher</title><h1>Recall fixture</h1><img alt="one pixel fixture" width="240" height="135" src="/image.png?token=secret"><video></video><button onclick="let i=document.createElement(\'img\');i.src=\'/image.png?second=1\';document.body.append(i)">Add real media</button><button onclick="let s=document.createElement(\'img\');s.src=\'/slow?recall=1\';document.body.append(s)">Add slow media</button>');
}).listen(4001,'0.0.0.0',()=>console.log('Recall fixture publisher on 4001'));
