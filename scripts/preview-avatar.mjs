import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
const dest=path.resolve('../整理记录/avatar-control-20261115');
const server=await createServer({optimizeDeps:{entries:['work/avatar-preview.html']},server:{host:'127.0.0.1',port:43128,strictPort:true},plugins:[{
 name:'avatar-preview-capture',configureServer(s){s.middlewares.use('/__avatar-capture',(req,res)=>{
  if(req.method!=='POST'){res.statusCode=405;res.end();return;}let body='';
  req.on('data',c=>{body+=c;if(body.length>1500000)req.destroy();});
  req.on('end',()=>{try{const p=JSON.parse(body);if(!/^data:image\/jpeg;base64,/.test(p.image))throw Error('format');
   fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'avatar-self-capture.jpg'),Buffer.from(p.image.split(',')[1],'base64'));
   fs.writeFileSync(path.join(dest,'capture-state.json'),JSON.stringify(p.state,null,2));res.end('ok');
  }catch{res.statusCode=400;res.end('invalid');}});
 });}
}]});await server.listen();console.log('Avatar preview: http://127.0.0.1:43128/work/avatar-preview.html');
