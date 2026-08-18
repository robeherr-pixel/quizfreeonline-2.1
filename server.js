import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import pg from "pg";
import { parse } from "csv-parse/sync";
import XLSX from "xlsx";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function db(sql, params = []) { return pool.query(sql, params); }

async function initDb() {
  await db(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active_question INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'single',
      options_json JSONB NOT NULL,
      correct_answer TEXT
    );
    CREATE TABLE IF NOT EXISTS responses (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      participant TEXT,
      participant_id TEXT,
      answer TEXT NOT NULL,
      is_correct BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, position);
    CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id);
    CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS correct_answer TEXT;
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS participant_id TEXT;
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS is_correct BOOLEAN;
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS uq_response_participant_question ON responses(session_id, question_id, participant_id) WHERE participant_id IS NOT NULL;
  `);
}

async function getSession(id) {
  const s = (await db("SELECT * FROM sessions WHERE id=$1", [id])).rows[0];
  if (!s) return null;
  const questions = (await db(
    "SELECT id, position, text, type, options_json AS options, correct_answer FROM questions WHERE session_id=$1 ORDER BY position",
    [id]
  )).rows;
  return { ...s, questions };
}

function publicQuestion(q, includeAnswer=false) {
  if (!q) return null;
  const out={ id:q.id, position:q.position, text:q.text, type:q.type, options:q.options };
  if(includeAnswer) out.correctAnswer=q.correct_answer;
  return out;
}

function normalizeAnswerValue(q, answer){
  if(Array.isArray(answer)) return answer.map(x=>String(x).trim()).filter(Boolean).sort().join(' | ');
  return String(answer??'').trim();
}
function isCorrectAnswer(q, answer){
  if(!q.correct_answer) return null;
  const expected=String(q.correct_answer).split('|').map(x=>x.trim()).filter(Boolean).sort().join(' | ');
  return normalizeAnswerValue(q,answer)===expected;
}

function participantCount(sessionId) {
  const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
  if (!room) return 0;
  let count = 0;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s?.data?.role === "audience") count++;
  }
  return count;
}

function broadcastParticipants(sessionId) {
  io.to(`session:${sessionId}`).emit("participants", { count: participantCount(sessionId) });
}

async function broadcastState(sessionId) {
  const s = await getSession(sessionId);
  if (!s) return;
  io.to(`session:${sessionId}`).emit("state", {
    title:s.title,
    activeQuestion:s.active_question,
    question:s.active_question >= 0 ? publicQuestion(s.questions[s.active_question]) : null,
    totalQuestions:s.questions.length
  });
}

async function resultsFor(sessionId) {
  const s = await getSession(sessionId);
  if (!s) return [];
  const output=[];
  for (const q of s.questions) {
    const rows=(await db(`SELECT answer, COUNT(*)::int AS count FROM responses WHERE session_id=$1 AND question_id=$2 GROUP BY answer ORDER BY count DESC`,[sessionId,q.id])).rows;
    const score=(await db(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_correct IS TRUE)::int AS correct FROM responses WHERE session_id=$1 AND question_id=$2`,[sessionId,q.id])).rows[0];
    output.push({questionId:q.id,total:rows.reduce((a,b)=>a+b.count,0),counts:rows,correct:Number(score.correct||0),correctAnswer:q.correct_answer});
  }
  return output;
}

app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

app.get("/health", async (_req,res)=>{
  try { await db("SELECT 1"); res.json({ok:true,app:"QuizFreeOnline",version:"2.1.0"}); }
  catch { res.status(503).json({ok:false}); }
});

app.post("/api/sessions", async (req,res)=>{
  try {
    const title=String(req.body.title||"Mi presentación").trim().slice(0,200);
    const id=Math.random().toString(36).slice(2,8).toUpperCase();
    await db("INSERT INTO sessions(id,title) VALUES($1,$2)",[id,title]);
    res.json({id,title,presenterUrl:`/presenter.html?session=${id}`,audienceUrl:`/audience.html?session=${id}`});
  } catch(e){ console.error(e); res.status(500).json({error:"No se pudo crear la sesión."}); }
});

app.get("/api/sessions/:id", async (req,res)=>{
  const s=await getSession(req.params.id);
  if(!s) return res.status(404).json({error:"Sesión no encontrada"});
  res.json({id:s.id,title:s.title,activeQuestion:s.active_question,questions:s.questions.map(q=>publicQuestion(q,true))});
});

app.get("/api/qr", async (req,res)=>{
  const text=String(req.query.text||"").slice(0,2000);
  if(!text) return res.status(400).send("Falta text");
  try {
    const svg=await QRCode.toString(text,{type:"svg",margin:1,width:260,errorCorrectionLevel:"M"});
    res.type("image/svg+xml").send(svg);
  } catch { res.status(500).send("No se pudo generar QR"); }
});

app.post("/api/sessions/:id/questions/import", upload.single("file"), async (req,res)=>{
  const s=await getSession(req.params.id);
  if(!s) return res.status(404).json({error:"Sesión no encontrada"});
  if(!req.file) return res.status(400).json({error:"Falta el archivo."});
  let rows; const name=req.file.originalname.toLowerCase();
  try {
    if(name.endsWith(".xlsx")||name.endsWith(".xls")){
      const wb=XLSX.read(req.file.buffer,{type:"buffer"});
      rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
    } else if(name.endsWith(".csv")){
      rows=parse(req.file.buffer.toString("utf8"),{columns:true,skip_empty_lines:true,bom:true,relax_column_count:true});
    } else return res.status(400).json({error:"Usa un archivo CSV o XLSX."});
  } catch { return res.status(400).json({error:"No se pudo leer el archivo."}); }

  const normalize=r=>{
    const text=r.question??r.pregunta??r.text??r.Question??"";
    const rawType=String(r.type??r.tipo??"single").toLowerCase().trim();
    const type=rawType==="multiple"?"multiple":"single";
    let rawOptions=r.options??r.opciones??r.answers??"";
    let options=String(rawOptions).split("|").map(x=>x.trim()).filter(Boolean);
    if(options.length<2){ options=[]; for(let i=1;i<=10;i++){ const v=r[`option${i}`]??r[`opcion${i}`]??r[`Option ${i}`]??r[`Opción ${i}`]; if(v!==undefined&&String(v).trim()) options.push(String(v).trim()); }}
    const uniqueOptions=[...new Set(options)];
    let rawCorrect=String(r.correct_answer??r.correct??r.respuesta_correcta??r.correcta??'').trim();
    let correct='';
    if(rawCorrect){
      const tokens=rawCorrect.split('|').map(x=>x.trim()).filter(Boolean);
      const resolved=tokens.map(token=>{
        if(/^[A-J]$/i.test(token)){ const idx=token.toUpperCase().charCodeAt(0)-65; return uniqueOptions[idx]||''; }
        const exact=uniqueOptions.find(o=>o.toLowerCase()===token.toLowerCase()); return exact||'';
      });
      if(resolved.some(x=>!x)) return {error:`Respuesta correcta inválida en: ${String(text).trim()}`};
      correct=[...new Set(resolved)].sort().join(' | ');
    }
    return {text:String(text).trim(),type,options:uniqueOptions,correct};
  };
  const normalized=rows.map(normalize);
  const bad=normalized.find(q=>q.error); if(bad) return res.status(400).json({error:bad.error});
  const imported=normalized.filter(q=>q.text&&q.options.length>=2);
  if(!imported.length) return res.status(400).json({error:"No encontré preguntas válidas. Revisa question/type/options/correct_answer."});

  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM questions WHERE session_id=$1",[s.id]);
    for(let i=0;i<imported.length;i++){
      const q=imported[i];
      await client.query("INSERT INTO questions(session_id,position,text,type,options_json,correct_answer) VALUES($1,$2,$3,$4,$5,$6)",[s.id,i,q.text,q.type,JSON.stringify(q.options),q.correct||null]);
    }
    await client.query("UPDATE sessions SET active_question=-1 WHERE id=$1",[s.id]);
    await client.query("COMMIT");
  } catch(e){ await client.query("ROLLBACK"); console.error(e); return res.status(500).json({error:"No se pudieron guardar las preguntas."}); }
  finally { client.release(); }
  await broadcastState(s.id); res.json({imported:imported.length});
});

app.post("/api/sessions/:id/activate", async (req,res)=>{
  const s=await getSession(req.params.id);
  if(!s) return res.status(404).json({error:"Sesión no encontrada"});
  const index=Number(req.body.index);
  if(!Number.isInteger(index)||index<-1||index>=s.questions.length) return res.status(400).json({error:"Pregunta inválida"});
  await db("UPDATE sessions SET active_question=$1 WHERE id=$2",[index,s.id]);
  await broadcastState(s.id); res.json({ok:true});
});

async function responseRows(sessionId){
  return (await db(`SELECT q.position+1 AS question_number,q.text AS question,q.correct_answer,r.participant,r.participant_id,r.answer,r.is_correct,r.created_at,r.updated_at FROM responses r JOIN questions q ON q.id=r.question_id WHERE r.session_id=$1 ORDER BY q.position,r.id`,[sessionId])).rows;
}

app.get("/api/sessions/:id/results.csv", async (req,res)=>{
  const s=await getSession(req.params.id); if(!s) return res.status(404).send("Sesión no encontrada");
  const rows=await responseRows(s.id); const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const csv=["question_number,question,correct_answer,participant,participant_id,answer,is_correct,created_at,updated_at",...rows.map(r=>[r.question_number,r.question,r.correct_answer,r.participant,r.participant_id,r.answer,r.is_correct,r.created_at,r.updated_at].map(esc).join(","))].join("\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8"); res.setHeader("Content-Disposition",`attachment; filename="${s.id}-resultados.csv"`); res.send("\ufeff"+csv);
});

app.get("/api/sessions/:id/results.xlsx", async (req,res)=>{
  const s=await getSession(req.params.id); if(!s) return res.status(404).send("Sesión no encontrada");
  const rows=await responseRows(s.id);
  const ws=XLSX.utils.json_to_sheet(rows.map(r=>({Pregunta_N:r.question_number,Pregunta:r.question,Respuesta_Correcta:r.correct_answer,Participante:r.participant,Participante_ID:r.participant_id,Respuesta:r.answer,Es_Correcta:r.is_correct,Fecha:r.created_at,Actualizada:r.updated_at})));
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Respuestas");
  const buffer=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="${s.id}-resultados.xlsx"`); res.send(buffer);
});

io.on("connection",socket=>{
  socket.on("join", async ({sessionId,role})=>{
    const s=await getSession(sessionId); if(!s) return socket.emit("errorMessage","Sesión no encontrada.");
    socket.join(`session:${sessionId}`); socket.data.sessionId=sessionId; socket.data.role=role;
    await broadcastState(sessionId); broadcastParticipants(sessionId);
  });
  socket.on("answer", async ({sessionId,questionId,participant,participantId,answer})=>{
    const s=await getSession(sessionId); if(!s||!questionId||answer==null||!participantId) return;
    const q=s.questions.find(x=>x.id===Number(questionId)); if(!q) return;
    const normalized=normalizeAnswerValue(q,answer).slice(0,1000);
    const correct=isCorrectAnswer(q,answer);
    await db(`INSERT INTO responses(session_id,question_id,participant,participant_id,answer,is_correct) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (session_id,question_id,participant_id) WHERE participant_id IS NOT NULL
      DO UPDATE SET participant=EXCLUDED.participant,answer=EXCLUDED.answer,is_correct=EXCLUDED.is_correct,updated_at=NOW()`,
      [sessionId,q.id,String(participant||"Anónimo").slice(0,80),String(participantId).slice(0,100),normalized,correct]);
    socket.emit("answerSaved",{questionId:q.id,answer:normalized,isCorrect:correct});
    io.to(`session:${sessionId}`).emit("results",await resultsFor(sessionId));
  });
  socket.on("requestResults",async({sessionId})=>{ if(await getSession(sessionId)) socket.emit("results",await resultsFor(sessionId)); });
  socket.on("disconnect",()=>{ if(socket.data.sessionId) broadcastParticipants(socket.data.sessionId); });
});

const port=process.env.PORT||3000;
initDb().then(()=>server.listen(port,()=>console.log(`QuizFreeOnline 2.1 escuchando en el puerto ${port}`))).catch(error=>{console.error("No se pudo iniciar la base de datos:",error);process.exit(1);});
