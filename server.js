const express=require("express"),http=require("http"),path=require("path");
const {Server}=require("socket.io");
const app=express(),server=http.createServer(app),io=new Server(server);
const PORT=process.env.PORT||3000,rooms=new Map(),DURATION=120;
app.use(express.static(path.join(__dirname,"public")));
function question(){const op=["+","-","×"][Math.floor(Math.random()*3)];let a=Math.floor(Math.random()*40)+10,b=Math.floor(Math.random()*20)+2;if(op==="-"&&b>a)[a,b]=[b,a];return{text:`${a} ${op} ${b}`,answer:op==="+"?a+b:op==="-"?a-b:a*b};}
function snapshot(r){return{code:r.code,state:r.state,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,ready:p.ready,score:p.score}))};}
function update(r){io.to(r.code).emit("room:update",snapshot(r));}
function next(r){r.q=question();r.qno++;r.answered=new Set();io.to(r.code).emit("game:question",{no:r.qno,text:r.q.text});}
function finish(r){if(r.state!=="playing")return;r.state="finished";clearTimeout(r.timer);const ps=[...r.players.values()];io.to(r.code).emit("game:finished",{players:ps.map(p=>({id:p.id,name:p.name,score:p.score})),winner:ps.length<2||ps[0].score===ps[1].score?null:ps.reduce((a,b)=>a.score>b.score?a:b).id});update(r);}
function start(r){r.state="playing";r.endsAt=Date.now()+DURATION*1000;for(const p of r.players.values()){p.score=0;p.ready=false;}io.to(r.code).emit("game:start",{seconds:DURATION,startsAt:Date.now()});next(r);r.timer=setTimeout(()=>finish(r),DURATION*1000);update(r);}
function join(s,r,name,cb){const p={id:s.id,name:String(name||"Player").trim().slice(0,12)||"Player",ready:false,score:0};r.players.set(s.id,p);s.join(r.code);s.data.code=r.code;cb?.({ok:true,code:r.code,playerId:s.id});update(r);}
io.on("connection",s=>{
 s.on("room:create",({name},cb)=>{let code;do{code=Math.random().toString(36).slice(2,7).toUpperCase();}while(rooms.has(code));const r={code,players:new Map(),state:"waiting"};rooms.set(code,r);join(s,r,name,cb);});
 s.on("room:join",({name,code},cb)=>{const r=rooms.get(String(code||"").trim().toUpperCase());if(!r)return cb?.({error:"방을 찾을 수 없습니다."});if(r.players.size>=2)return cb?.({error:"방이 가득 찼습니다."});if(r.state!=="waiting")return cb?.({error:"이미 시작된 경기입니다."});join(s,r,name,cb);});
 s.on("player:ready",()=>{const r=rooms.get(s.data.code),p=r?.players.get(s.id);if(!r||!p||r.state!=="waiting"||r.players.size!==2)return;p.ready=true;update(r);if([...r.players.values()].every(x=>x.ready))start(r);});
 s.on("answer:submit",({value},cb)=>{const r=rooms.get(s.data.code),p=r?.players.get(s.id);if(!r||!p||r.state!=="playing")return cb?.({status:"inactive"});if(Date.now()>=r.endsAt){finish(r);return cb?.({status:"finished"});}if(r.answered.has(s.id))return cb?.({status:"wait"});if(Number(value)!==r.q.answer)return cb?.({status:"wrong"});r.answered.add(s.id);p.score++;io.to(r.code).emit("game:point",{playerId:s.id,name:p.name,score:p.score});next(r);cb?.({status:"correct"});update(r);});
 s.on("disconnect",()=>{const r=rooms.get(s.data.code);if(!r)return;r.players.delete(s.id);if(r.state==="playing")finish(r);if(!r.players.size){clearTimeout(r.timer);rooms.delete(r.code);}else update(r);});
});
server.listen(PORT,()=>console.log(`Mental Arena listening on ${PORT}`));
